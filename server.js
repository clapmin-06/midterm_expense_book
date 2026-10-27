require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const { DATABASE_URL, APP_PASSWORD, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
// 세션 쿠키 서명 키. 구글 로그인 사용 시에는 SESSION_SECRET 을 따로 지정해야 함
const SESSION_SECRET = process.env.SESSION_SECRET || APP_PASSWORD || '';
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
// 비밀번호 로그인은 구글 설정이 없을 때만 켜지는 개발용(로컬 테스트용) 로그인
const PASSWORD_LOGIN = !GOOGLE_ENABLED && !!APP_PASSWORD;
// 실서비스(구글 로그인)에서는 추측하기 어려운 32자 이상의 키만 허용. 개발용 비밀번호 로그인은 제한 없음
const SECRET_OK = GOOGLE_ENABLED ? SESSION_SECRET.length >= 32 : !!SESSION_SECRET;
const AUTH_READY = SECRET_OK && (GOOGLE_ENABLED || PASSWORD_LOGIN);

if (!DATABASE_URL) console.error('DATABASE_URL 환경변수가 필요합니다.');
if (GOOGLE_ENABLED && !SECRET_OK) {
  console.error('SESSION_SECRET 은 32자 이상의 임의 문자열이어야 합니다. (예: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
} else if (!AUTH_READY) {
  console.error('로그인 설정이 없습니다. GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/SESSION_SECRET (또는 개발용 APP_PASSWORD)를 설정하세요.');
} else if (PASSWORD_LOGIN) {
  console.warn('구글 로그인이 설정되지 않아 개발용 비밀번호 로그인을 사용합니다. (모든 사람이 같은 계정을 공유)');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  keepAlive: true, // 요청 사이에 연결을 유지해 TLS 연결을 매번 새로 맺지 않도록
  idleTimeoutMillis: 60000,
});

// ---- DB 구조: 모든 데이터는 user_id 로 사용자별 분리 ----
// 구조를 바꾸면 SCHEMA_VERSION 을 올린다. 이미 같은 버전이면 인스턴스가 시작할 때 DDL 을 건너뜀(쿼리 1번으로 확인)
const SCHEMA_VERSION = '4';
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT,
    name TEXT,
    picture TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS categories (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, name)
  );
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '기타',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL CHECK (end_date >= start_date),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS recurring (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    interval_months INTEGER NOT NULL CHECK (interval_months BETWEEN 1 AND 120),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    next_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    item TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    kind TEXT NOT NULL DEFAULT 'expense',
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS expenses_user_date_idx ON expenses (user_id, date);
  CREATE INDEX IF NOT EXISTS expenses_event_idx ON expenses (event_id);
  CREATE INDEX IF NOT EXISTS events_user_idx ON events (user_id);
  CREATE INDEX IF NOT EXISTS recurring_user_next_idx ON recurring (user_id, next_date);
  ALTER TABLE events ADD COLUMN IF NOT EXISTS emoji TEXT;
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO app_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;

const DEFAULT_CATEGORIES = {
  expense: ['식비', '교통', '쇼핑', '주거/통신', '문화/여가', '의료', '교육', '기타'],
  income: ['월급', '용돈', '부수입', '이자/투자', '기타'],
};

async function schemaCurrent() {
  try {
    const r = await pool.query("SELECT value FROM app_meta WHERE key = 'schema_version'");
    return r.rows[0]?.value === SCHEMA_VERSION;
  } catch { return false; } // app_meta 가 아직 없으면(처음/예전 구조) 전체 초기화 진행
}

let initPromise;
function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      if (await schemaCurrent()) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(727301)'); // 동시에 시작한 인스턴스끼리 순서대로 실행
        // 사용자 구분이 없던 예전 구조(테스트 데이터뿐)는 비우고 새 구조로 다시 만듦
        const old = await client.query(
          `SELECT to_regclass('public.expenses') AS t,
                  EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'user_id') AS has_user`);
        if (old.rows[0].t && !old.rows[0].has_user) {
          await client.query('DROP TABLE IF EXISTS expenses, events, recurring, categories CASCADE');
        }
        await client.query(SCHEMA);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    })().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

// 사용자 생성/갱신. 처음 만들 때만 기본 카테고리를 넣음 (삭제한 기본 카테고리가 되살아나지 않도록)
async function upsertUser({ sub, email, name, picture }) {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO users (google_sub, email, name, picture, last_login) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, last_login = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [sub, email || null, name || null, picture || null]);
    const { id, inserted } = r.rows[0];
    if (inserted) {
      for (const [kind, names] of Object.entries(DEFAULT_CATEGORIES)) {
        for (const n of names) {
          await client.query('INSERT INTO categories (user_id, kind, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, kind, n]);
        }
      }
    }
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- 세션: 서버리스에서도 동작하도록 서명된 무상태 쿠키 (사용자 id + 만료 시각) ----
const COOKIE = 'auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30일 (사용할 때마다 연장되므로, 마지막 사용 후 30일간 로그인 유지)
const RENEW_AFTER = 60 * 60 * 24; // 발급 후 1일이 지난 세션만 다시 발급 (요청마다 쿠키를 바꾸지 않도록)
const IS_PROD = !!(process.env.VERCEL || process.env.NODE_ENV === 'production');
const SECURE = IS_PROD ? '; Secure' : '';

const sign = (value) => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
function makeToken(userId) {
  const body = `${userId}.${Date.now() + MAX_AGE * 1000}`;
  return `${body}.${sign(body)}`;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
// 세션 쿠키 검증: 올바르게 서명되고 만료되지 않았으면 { uid, exp }, 아니면 null (위조/만료)
function readSession(req) {
  if (!AUTH_READY) return null;
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  const [uid, exp, sig] = token.split('.');
  if (!uid || !exp || !sig || !/^\d+$/.test(uid) || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  return safeEqual(sig, sign(`${uid}.${exp}`)) ? { uid: Number(uid), exp: Number(exp) } : null;
}
function setSession(res, userId) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken(userId))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${SECURE}`);
}
const clearSession = (res) => res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
// 사용 중이면 만료일을 30일 뒤로 연장
function renewSession(res, s) {
  if (s.exp - Date.now() < (MAX_AGE - RENEW_AFTER) * 1000) setSession(res, s.uid);
}
// 로그인 확인 + 사용자가 아직 존재하는지 확인 (계정이 삭제되면 남아 있는 세션도 즉시 무효)
async function requireAuth(req, res, next) {
  try {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: '인증이 필요합니다.' });
    await initDb();
    // 사용자 존재 여부와 "오늘까지 생성해야 할 정기 항목이 있는지"를 한 번의 왕복으로 확인
    const u = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM recurring WHERE user_id = u.id AND next_date <= $2) AS due FROM users u WHERE u.id = $1`,
      [s.uid, todayKST()]);
    if (!u.rowCount) { clearSession(res); return res.status(401).json({ error: '인증이 필요합니다.' }); }
    req.userId = s.uid;
    renewSession(res, s);
    if (u.rows[0].due) await materialize(s.uid);
    next();
  } catch (e) { next(e); }
}

const app = express();
app.disable('x-powered-by');
// 기본 보안 헤더 (Vercel 정적 파일에는 vercel.json 의 headers 가 같은 값을 적용)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});
// 개인 데이터가 담긴 API 응답은 브라우저/중간 서버에 저장하지 않음
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json());
// 화면 파일은 매번 최신본인지 확인하게 해서, 수정 후 예전 코드가 캐시로 남지 않도록 함
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---- 로그인 ----
// 개발용 비밀번호 로그인 (구글 설정이 없을 때만). 시도 횟수 제한(인스턴스 단위의 간단한 방어)
const attempts = new Map();
app.post('/api/login', async (req, res, next) => {
  try {
    if (!PASSWORD_LOGIN) return res.status(404).json({ error: '사용할 수 없는 로그인 방식입니다.' });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const rec = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = Date.now(); }
    if (rec.n >= 10) return res.status(429).json({ error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.' });
    const { password } = req.body || {};
    if (typeof password !== 'string' || !safeEqual(password, APP_PASSWORD)) {
      rec.n++; attempts.set(ip, rec);
      return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    }
    attempts.delete(ip);
    const uid = await upsertUser({ sub: 'local:dev', name: '로컬 사용자' });
    setSession(res, uid);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 구글 로그인 (OAuth 2.0 인가 코드 방식)
function redirectUri(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '') + '/api/auth/google/callback';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  return `${proto}://${host}/api/auth/google/callback`;
}
const STATE_COOKIE = 'oauth_state';
const loginFail = (res, code) => res.redirect('/?login_error=' + code);

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_ENABLED || !AUTH_READY) return loginFail(res, 'config');
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600${SECURE}`);
  const qs = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + qs);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!GOOGLE_ENABLED || !AUTH_READY) return loginFail(res, 'config');
    const { code, state, error } = req.query;
    const saved = getCookie(req, STATE_COOKIE);
    res.append('Set-Cookie', `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0${SECURE}`);
    if (error) return loginFail(res, 'denied');
    if (typeof code !== 'string' || typeof state !== 'string' || !saved || !safeEqual(state, saved)) return loginFail(res, 'state');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req), grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || typeof tok.id_token !== 'string') { console.error('구글 토큰 교환 실패', tok.error); return loginFail(res, 'failed'); }

    // 구글에서 TLS 로 직접 받은 id_token 이므로 서명 검증은 생략하고, 발급 대상/발급자/만료/이메일 인증을 확인
    const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
    const okIssuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!okIssuer || claims.aud !== GOOGLE_CLIENT_ID || !(claims.exp * 1000 > Date.now()) || !claims.sub) return loginFail(res, 'failed');
    if (claims.email && claims.email_verified === false) return loginFail(res, 'failed');

    const uid = await upsertUser({ sub: `google:${claims.sub}`, email: claims.email, name: claims.name || claims.email, picture: claims.picture });
    setSession(res, uid);
    res.redirect('/');
  } catch (e) {
    console.error('구글 로그인 오류', e.message);
    loginFail(res, 'failed');
  }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res, next) => {
  try {
    const info = { authed: false, googleEnabled: GOOGLE_ENABLED && AUTH_READY, passwordLogin: PASSWORD_LOGIN && AUTH_READY };
    const s = readSession(req);
    if (s) {
      await initDb();
      const r = await pool.query('SELECT name, email, picture FROM users WHERE id = $1', [s.uid]);
      if (r.rowCount) { info.authed = true; info.user = r.rows[0]; renewSession(res, s); }
      else clearSession(res);
    }
    res.json(info);
  } catch (e) { next(e); }
});

const api = express.Router();
api.use(requireAuth);

// ---- 정기 지출/수입: 도래한 반복 항목을 실제 내역으로 만들어 둠 ----
const pad = (n) => String(n).padStart(2, '0');
const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
// ymd 의 달에서 months 개월 뒤, 매월 day 일 (그 달에 없으면 말일)
function nextOccurrence(ymd, months, day) {
  let [y, m] = ymd.split('-').map(Number);
  m += months;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(day, last))}`;
}
async function materialize(uid) { // 도래한 정기 항목이 있을 때만 호출됨 (requireAuth 에서 확인)
  const today = todayKST();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, kind, item, category, amount, interval_months, day_of_month, to_char(next_date,'YYYY-MM-DD') AS next_date
       FROM recurring WHERE user_id = $1 AND next_date <= $2 FOR UPDATE`, [uid, today]);
    for (const r of rows) {
      let d = r.next_date;
      for (let i = 0; d <= today && i < 600; i++) {
        await client.query(
          'INSERT INTO expenses (user_id, date, item, category, amount, kind, recurring_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [uid, d, r.item, r.category, r.amount, r.kind, r.id]);
        d = nextOccurrence(d, r.interval_months, r.day_of_month);
      }
      await client.query('UPDATE recurring SET next_date = $1 WHERE id = $2', [d, r.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function validate(body) {
  const { date, item, category, amount, kind } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || isNaN(Date.parse(date))) return '날짜 형식이 올바르지 않습니다.';
  if (kind !== undefined && kind !== 'expense' && kind !== 'income') return '구분은 지출 또는 수입이어야 합니다.';
  if (typeof item !== 'string' || !item.trim()) return '항목을 입력하세요.';
  if (typeof category !== 'string' || !category.trim()) return '카테고리를 입력하세요.';
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 0 || n > 2000000000) return '금액은 0 이상의 정수여야 합니다.';
  return null;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 }); // 잘못된 요청 -> 400 으로 응답
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 지출 날짜가 (내) 이벤트 기간 안인지 확인 (이벤트가 없거나 남의 것이면 오류 문구 반환)
async function checkEventDate(uid, eventId, date) {
  const r = await pool.query(
    `SELECT to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e FROM events WHERE id = $1 AND user_id = $2`, [eventId, uid]);
  if (!r.rowCount) return '이벤트를 찾을 수 없습니다.';
  const { s, e } = r.rows[0];
  if (date < s || date > e) return `날짜는 이벤트 기간(${s} ~ ${e}) 안이어야 합니다.`;
  return null;
}

// 이름 검색어 -> ILIKE 패턴 (%, _, \\ 는 문자 그대로 검색)
const likePattern = (q) => '%' + String(q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';

// 목록 조회 (?date=YYYY-MM-DD | ?from=&to= | ?month=YYYY-MM | ?q=항목명)
// 기본은 이벤트에 속하지 않은 지출만, ?event=ID 는 해당 이벤트의 지출, ?q= 검색 시에는 이벤트 안 내역도 포함
async function expensesQuery(uid, query) {
  const { date, from, to, month, event } = query;
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  for (const d of [date, from, to]) {
    if (d !== undefined && !DATE_RE.test(d)) throw bad('날짜 형식이 올바르지 않습니다.');
  }
  if (month !== undefined && !MONTH_RE.test(month)) throw bad('월 형식이 올바르지 않습니다.');
  if (event !== undefined && !/^\d+$/.test(event)) throw bad('잘못된 ID입니다.');
  const params = [uid];
  const where = ['x.user_id = $1'];
  if (event) { params.push(Number(event)); where.push(`event_id = $${params.length}`); }
  else if (!q) where.push('event_id IS NULL');
  if (date) { params.push(date); where.push(`date = $${params.length}`); }
  if (from) { params.push(from); where.push(`date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`date <= $${params.length}`); }
  if (month) { params.push(month + '-01'); where.push(`date_trunc('month', date) = $${params.length}::date`); }
  if (q) { params.push(likePattern(q)); where.push(`x.item ILIKE $${params.length} ESCAPE '\\'`); }
  const sql = `SELECT x.id, to_char(x.date,'YYYY-MM-DD') AS date, x.item, x.category, x.amount, x.kind, x.event_id, ev.name AS event_name, ev.emoji AS event_emoji,
                      x.recurring_id, rc.interval_months, rc.day_of_month
               FROM expenses x LEFT JOIN recurring rc ON rc.id = x.recurring_id
               LEFT JOIN events ev ON ev.id = x.event_id
               WHERE ${where.join(' AND ')}
               ORDER BY x.date DESC, x.id DESC LIMIT 1000`;
  return (await pool.query(sql, params)).rows;
}
api.get('/expenses', async (req, res, next) => {
  try { res.json(await expensesQuery(req.userId, req.query)); } catch (e) { next(e); }
});

api.post('/expenses', async (req, res, next) => {
  try {
    const uid = req.userId;
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const { date, item, category, amount } = req.body;
    const kind = req.body.kind || 'expense';
    const eventId = req.body.event_id ? Number(req.body.event_id) : null;
    const rec = req.body.recurring || null;
    if (rec) {
      const months = Number(rec.interval_months);
      const day = Number(rec.day_of_month);
      if (eventId !== null) return res.status(400).json({ error: '이벤트 안의 내역은 정기 항목으로 만들 수 없습니다.' });
      if (!Number.isInteger(months) || months < 1 || months > 120) return res.status(400).json({ error: '반복 주기는 1~120개월로 입력하세요.' });
      if (!Number.isInteger(day) || day < 1 || day > 31) return res.status(400).json({ error: '반복 날짜는 1~31일로 입력하세요.' });
      rec.interval_months = months;
      rec.day_of_month = day;
    }
    if (eventId !== null) {
      if (!Number.isInteger(eventId)) return res.status(400).json({ error: '잘못된 ID입니다.' });
      const eerr = await checkEventDate(uid, eventId, date);
      if (eerr) return res.status(400).json({ error: eerr });
    }
    // 정기 항목이면 규칙을 먼저 만들고, 입력한 내역이 첫 회차. 다음 회차는 주기 뒤 지정한 날짜
    let recurringId = null;
    if (rec) {
      const ins = await pool.query(
        `INSERT INTO recurring (user_id, kind, item, category, amount, interval_months, day_of_month, next_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [uid, kind, item.trim(), category.trim(), Number(amount), rec.interval_months, rec.day_of_month,
         nextOccurrence(date, rec.interval_months, rec.day_of_month)]);
      recurringId = ins.rows[0].id;
    }
    try {
      const r = await pool.query(
        `INSERT INTO expenses (user_id, date, item, category, amount, kind, event_id, recurring_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, to_char(date,'YYYY-MM-DD') AS date, item, category, amount, kind, event_id, recurring_id`,
        [uid, date, item.trim(), category.trim(), Number(amount), kind, eventId, recurringId]);
      res.status(201).json(r.rows[0]);
    } catch (e) {
      if (recurringId) await pool.query('DELETE FROM recurring WHERE id = $1 AND user_id = $2', [recurringId, uid]).catch(() => {});
      throw e;
    }
  } catch (e) { next(e); }
});

api.put('/expenses/:id', async (req, res, next) => {
  try {
    const uid = req.userId;
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const { date, item, category, amount } = req.body;
    // 이벤트 소속은 바꾸지 않되, 소속된 이벤트의 기간은 지켜야 함
    const cur = await pool.query('SELECT event_id FROM expenses WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!cur.rowCount) return res.status(404).json({ error: '내역을 찾을 수 없습니다.' });
    if (cur.rows[0].event_id) {
      const eerr = await checkEventDate(uid, cur.rows[0].event_id, date);
      if (eerr) return res.status(400).json({ error: eerr });
    }
    const r = await pool.query(
      `UPDATE expenses SET date=$1, item=$2, category=$3, amount=$4, kind=$5 WHERE id=$6 AND user_id=$7
       RETURNING id, to_char(date,'YYYY-MM-DD') AS date, item, category, amount, kind, event_id, recurring_id`,
      [date, item.trim(), category.trim(), Number(amount), req.body.kind || 'expense', id, uid]);
    if (!r.rowCount) return res.status(404).json({ error: '내역을 찾을 수 없습니다.' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

api.delete('/expenses/:id', async (req, res, next) => {
  try {
    const uid = req.userId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query('DELETE FROM expenses WHERE id=$1 AND user_id=$2 RETURNING recurring_id', [id, uid]);
    if (!r.rowCount) return res.status(404).json({ error: '내역을 찾을 수 없습니다.' });
    // ?stop_recurring=1 이면 정기 설정도 함께 삭제 (이미 기록된 다른 회차는 남음)
    const rid = r.rows[0].recurring_id;
    if (rid && req.query.stop_recurring === '1') await pool.query('DELETE FROM recurring WHERE id=$1 AND user_id=$2', [rid, uid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 정기 항목 중단 (이미 만들어진 내역은 그대로 남고, 이후 회차만 생성되지 않음)
api.delete('/recurring/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query('DELETE FROM recurring WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (!r.rowCount) return res.status(404).json({ error: '정기 항목을 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 이벤트 (여행 등 따로 묶어 기록할 지출 모음) ----
function validateEvent(body) {
  const { name, category, start_date, end_date } = body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) return '이벤트 이름은 1~50자로 입력하세요.';
  if (typeof category !== 'string' || !category.trim()) return '카테고리를 입력하세요.';
  for (const d of [start_date, end_date]) {
    if (!DATE_RE.test(d || '') || isNaN(Date.parse(d))) return '날짜 형식이 올바르지 않습니다.';
  }
  if (end_date < start_date) return '종료일은 시작일 이후여야 합니다.';
  const emoji = body.emoji;
  if (emoji !== undefined && emoji !== null && emoji !== '' &&
      (typeof emoji !== 'string' || emoji.length > 16 || !/^\p{Extended_Pictographic}/u.test(emoji))) return '이모티콘 형식이 올바르지 않습니다.';
  return null;
}
// 이벤트 이모티콘 (비어 있으면 null = 화면에서 이름/카테고리로 자동 추천)
const emojiOf = (body) => (typeof body.emoji === 'string' && body.emoji.trim() ? body.emoji.trim() : null);

// 이벤트 + 순합계(수입-지출, 부호 포함)/건수 ($1: 날짜(없으면 null) -> 그 날짜의 합계 day_total, $2: 사용자 id)
const EVENT_SELECT = `
  SELECT e.id, e.name, e.category, e.emoji, to_char(e.start_date,'YYYY-MM-DD') AS start_date, to_char(e.end_date,'YYYY-MM-DD') AS end_date,
         COALESCE(SUM(CASE WHEN x.kind = 'income' THEN x.amount ELSE -x.amount END),0)::bigint AS total, COUNT(x.id)::int AS count,
         COALESCE(SUM(CASE WHEN x.kind = 'income' THEN x.amount ELSE -x.amount END) FILTER (WHERE x.date = $1::date),0)::bigint AS day_total
  FROM events e LEFT JOIN expenses x ON x.event_id = e.id AND x.user_id = e.user_id`;
const toEvent = (r) => ({ ...r, total: Number(r.total), day_total: Number(r.day_total) });

async function eventsQuery(uid, query) {
  const { date } = query;
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (date !== undefined && !DATE_RE.test(date)) throw bad('날짜 형식이 올바르지 않습니다.');
  const where = ['e.user_id = $2', date ? 'e.start_date <= $1::date AND e.end_date >= $1::date' : '$1::date IS NULL'];
  const params = [date || null, uid];
  if (q) { params.push(likePattern(q)); where.push(`e.name ILIKE $3 ESCAPE '\\'`); }
  const r = await pool.query(
    `${EVENT_SELECT} WHERE ${where.join(' AND ')}
     GROUP BY e.id ORDER BY e.start_date DESC, e.id DESC`, params);
  return r.rows.map(toEvent);
}
api.get('/events', async (req, res, next) => {
  try { res.json(await eventsQuery(req.userId, req.query)); } catch (e) { next(e); }
});

// 내역 화면에 필요한 것(일반 내역 + 이벤트)을 한 번의 요청으로 (두 쿼리는 서버에서 동시에 실행)
api.get('/home', async (req, res, next) => {
  try {
    const [expenses, events] = await Promise.all([expensesQuery(req.userId, req.query), eventsQuery(req.userId, req.query)]);
    res.json({ expenses, events });
  } catch (e) { next(e); }
});

api.get('/events/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query(`${EVENT_SELECT} WHERE e.user_id = $2 AND e.id = $3 GROUP BY e.id`, [null, req.userId, id]);
    if (!r.rowCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(toEvent(r.rows[0]));
  } catch (e) { next(e); }
});

api.post('/events', async (req, res, next) => {
  try {
    const err = validateEvent(req.body);
    if (err) return res.status(400).json({ error: err });
    const { name, category, start_date, end_date } = req.body;
    const r = await pool.query(
      `INSERT INTO events (user_id, name, category, start_date, end_date, emoji) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, category, emoji, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date`,
      [req.userId, name.trim(), category.trim(), start_date, end_date, emojiOf(req.body)]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

api.put('/events/:id', async (req, res, next) => {
  try {
    const uid = req.userId;
    const err = validateEvent(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const { name, category, start_date, end_date } = req.body;
    // 기간을 줄일 때 기간 밖으로 나가는 지출이 있으면 거부
    const out = await pool.query(
      'SELECT COUNT(*)::int AS n FROM expenses WHERE event_id = $1 AND user_id = $4 AND (date < $2 OR date > $3)', [id, start_date, end_date, uid]);
    if (out.rows[0].n > 0) {
      return res.status(409).json({ error: `새 기간 밖의 지출/수입이 ${out.rows[0].n}건 있습니다. 해당 내역의 날짜를 먼저 수정하세요.` });
    }
    const r = await pool.query(
      `UPDATE events SET name=$1, category=$2, start_date=$3, end_date=$4, emoji=$7 WHERE id=$5 AND user_id=$6
       RETURNING id, name, category, emoji, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date`,
      [name.trim(), category.trim(), start_date, end_date, id, uid, emojiOf(req.body)]);
    if (!r.rowCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 이벤트 삭제 (속한 지출도 함께 삭제됨)
api.delete('/events/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query('DELETE FROM events WHERE id=$1 AND user_id=$2', [id, req.userId]);
    if (!r.rowCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 카테고리는 지출(expense)/수입(income)별로, 사용자별로 따로 관리: ?kind=expense|income (기본 expense)
const kindOf = (v) => (v === 'income' ? 'income' : 'expense');

// 카테고리 목록 (기본 + 사용자 추가 + 기존 내역에 쓰인 것)
async function categoriesQuery(uid, kind) {
  const r = await pool.query(
    `SELECT name FROM (
       SELECT name, created_at FROM categories WHERE user_id = $2 AND kind = $1
       UNION
       SELECT category, now() FROM expenses WHERE user_id = $2 AND kind = $1
         AND category NOT IN (SELECT name FROM categories WHERE user_id = $2 AND kind = $1)
       UNION
       SELECT category, now() FROM events WHERE user_id = $2 AND $1 = 'expense'
         AND category NOT IN (SELECT name FROM categories WHERE user_id = $2 AND kind = 'expense')
     ) c ORDER BY created_at, name`, [kind, uid]);
  return r.rows.map((x) => x.name);
}
api.get('/categories', async (req, res, next) => {
  try { res.json(await categoriesQuery(req.userId, kindOf(req.query.kind))); } catch (e) { next(e); }
});
// 지출/수입 카테고리를 한 번에
api.get('/categories/all', async (req, res, next) => {
  try {
    const [expense, income] = await Promise.all([categoriesQuery(req.userId, 'expense'), categoriesQuery(req.userId, 'income')]);
    res.json({ expense, income });
  } catch (e) { next(e); }
});

api.post('/categories', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 50) return res.status(400).json({ error: '카테고리 이름은 1~50자로 입력하세요.' });
    await pool.query('INSERT INTO categories (user_id, kind, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.userId, kindOf(req.body?.kind), name]);
    res.status(201).json({ name });
  } catch (e) { next(e); }
});

// 카테고리 이름 변경 (이미 있는 이름으로 바꾸면 합쳐짐)
api.put('/categories/:name', async (req, res, next) => {
  const uid = req.userId;
  const oldName = req.params.name;
  const kind = kindOf(req.body?.kind);
  const newName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!newName || newName.length > 50) return res.status(400).json({ error: '카테고리 이름은 1~50자로 입력하세요.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (newName !== oldName) {
      await client.query(
        `INSERT INTO categories (user_id, kind, name, created_at)
         SELECT $4, $3, $1, COALESCE((SELECT created_at FROM categories WHERE user_id = $4 AND name = $2 AND kind = $3), now())
         ON CONFLICT DO NOTHING`, [newName, oldName, kind, uid]);
      await client.query('UPDATE expenses SET category = $1 WHERE category = $2 AND kind = $3 AND user_id = $4', [newName, oldName, kind, uid]);
      await client.query('UPDATE recurring SET category = $1 WHERE category = $2 AND kind = $3 AND user_id = $4', [newName, oldName, kind, uid]);
      if (kind === 'expense') await client.query('UPDATE events SET category = $1 WHERE category = $2 AND user_id = $3', [newName, oldName, uid]);
      await client.query('DELETE FROM categories WHERE name = $1 AND kind = $2 AND user_id = $3', [oldName, kind, uid]);
    }
    await client.query('COMMIT');
    res.json({ name: newName });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// 카테고리 삭제 (내역에 사용 중이면 거부)
api.delete('/categories/:name', async (req, res, next) => {
  try {
    const uid = req.userId;
    const name = req.params.name;
    const kind = kindOf(req.query.kind);
    const used = await pool.query(
      `SELECT (SELECT COUNT(*) FROM expenses WHERE category = $1 AND kind = $2 AND user_id = $3)::int AS n,
              (SELECT COUNT(*) FROM recurring WHERE category = $1 AND kind = $2 AND user_id = $3)::int AS rc,
              (SELECT COUNT(*) FROM events WHERE category = $1 AND $2 = 'expense' AND user_id = $3)::int AS ev`, [name, kind, uid]);
    const { n, rc, ev } = used.rows[0];
    if (n > 0 || rc > 0 || ev > 0) {
      const parts = [n > 0 && `${kind === 'income' ? '수입' : '지출'} ${n}건`, rc > 0 && `정기 항목 ${rc}건`, ev > 0 && `이벤트 ${ev}건`].filter(Boolean).join('과 ');
      return res.status(409).json({ error: `이 카테고리를 사용하는 ${parts}이 있어 삭제할 수 없습니다. 이름 변경으로 다른 카테고리와 합치거나, 해당 항목을 먼저 수정하세요.` });
    }
    await pool.query('DELETE FROM categories WHERE name = $1 AND kind = $2 AND user_id = $3', [name, kind, uid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 월별 합계
async function monthlyQuery(uid) {
  const r = await pool.query(
    `SELECT to_char(date,'YYYY-MM') AS month,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'),0)::bigint AS total,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'income'),0)::bigint AS income,
            COUNT(*)::int AS count
     FROM expenses WHERE user_id = $1 GROUP BY 1 ORDER BY 1 DESC`, [uid]);
  return r.rows.map((x) => ({ ...x, total: Number(x.total), income: Number(x.income) }));
}
api.get('/summary/monthly', async (req, res, next) => {
  try { res.json(await monthlyQuery(req.userId)); } catch (e) { next(e); }
});

// 카테고리별 지출 합계 (month=YYYY-MM | year=YYYY 선택, 수입 제외)
async function categorySumQuery(uid, { month, year } = {}) {
  if (month !== undefined && !MONTH_RE.test(month)) throw bad('월 형식이 올바르지 않습니다.');
  if (year !== undefined && !/^\d{4}$/.test(year)) throw bad('연도 형식이 올바르지 않습니다.');
  const params = [uid];
  let where = `WHERE user_id = $1 AND kind = 'expense'`;
  if (month) { params.push(month + '-01'); where += ` AND date_trunc('month', date) = $${params.length}::date`; }
  if (year) { params.push(year + '-01-01'); where += ` AND date_trunc('year', date) = $${params.length}::date`; }
  const r = await pool.query(
    `SELECT category, SUM(amount)::bigint AS total, COUNT(*)::int AS count
     FROM expenses ${where} GROUP BY category ORDER BY total DESC`, params);
  return r.rows.map((x) => ({ ...x, total: Number(x.total) }));
}
api.get('/summary/category', async (req, res, next) => {
  try { res.json(await categorySumQuery(req.userId, req.query)); } catch (e) { next(e); }
});

// 통계 화면에 필요한 것을 한 번의 요청으로: 월별 합계 + 지출 카테고리 순서 + (전체/선택한 달/선택한 해)의 카테고리별 합계
// month/year 를 주지 않으면 이번 달/올해(내역이 있을 때), 없으면 가장 최근 달/해를 고름
api.get('/stats', async (req, res, next) => {
  try {
    const { month, year } = req.query;
    if (month !== undefined && !MONTH_RE.test(month)) throw bad('월 형식이 올바르지 않습니다.');
    if (year !== undefined && !/^\d{4}$/.test(year)) throw bad('연도 형식이 올바르지 않습니다.');
    const uid = req.userId;
    const monthly = await monthlyQuery(uid);
    const months = monthly.map((m) => m.month);
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const nowMonth = todayKST().slice(0, 7);
    const m = months.includes(month) ? month : months.includes(nowMonth) ? nowMonth : months[0] || null;
    const y = years.includes(year) ? year : years.includes(nowMonth.slice(0, 4)) ? nowMonth.slice(0, 4) : years[0] || null;
    const [order, all, byMonth, byYear] = await Promise.all([
      categoriesQuery(uid, 'expense'),
      categorySumQuery(uid, {}),
      m ? categorySumQuery(uid, { month: m }) : [],
      y ? categorySumQuery(uid, { year: y }) : [],
    ]);
    res.json({ monthly, order, month: m, year: y, cat: { all, month: byMonth, year: byYear } });
  } catch (e) { next(e); }
});

app.use('/api', api);

// 오류 처리: DB 접속 정보 등 내부 정보를 응답에 노출하지 않음
app.use((err, req, res, next) => {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err.message);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`http://localhost:${port}`));
}
