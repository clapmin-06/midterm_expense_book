require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const { DATABASE_URL, APP_PASSWORD } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL 환경변수가 필요합니다.');
}
if (!APP_PASSWORD) {
  console.warn('APP_PASSWORD 가 설정되지 않아 비밀번호 없이 접속할 수 있습니다.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

let initPromise;
function initDb() {
  if (!initPromise) {
    initPromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS expenses (
           id SERIAL PRIMARY KEY,
           date DATE NOT NULL,
           item TEXT NOT NULL,
           category TEXT NOT NULL,
           amount INTEGER NOT NULL CHECK (amount >= 0),
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (date);
         CREATE TABLE IF NOT EXISTS events (
           id SERIAL PRIMARY KEY,
           name TEXT NOT NULL,
           start_date DATE NOT NULL,
           end_date DATE NOT NULL CHECK (end_date >= start_date),
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE TABLE IF NOT EXISTS recurring (
           id SERIAL PRIMARY KEY,
           kind TEXT NOT NULL,
           item TEXT NOT NULL,
           category TEXT NOT NULL,
           amount INTEGER NOT NULL CHECK (amount >= 0),
           interval_months INTEGER NOT NULL CHECK (interval_months BETWEEN 1 AND 120),
           day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
           next_date DATE NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         ALTER TABLE expenses ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'expense';
         ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL;
         ALTER TABLE events ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '기타';
         ALTER TABLE expenses ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE;
         CREATE INDEX IF NOT EXISTS expenses_event_idx ON expenses (event_id);
         DO $$ BEGIN
           -- 테이블을 처음 만들 때만 기본값을 넣어, 삭제한 기본 카테고리가 되살아나지 않게 함
           IF to_regclass('public.categories') IS NULL THEN
             CREATE TABLE categories (
               name TEXT PRIMARY KEY,
               created_at TIMESTAMPTZ NOT NULL DEFAULT now()
             );
             INSERT INTO categories (name) VALUES
               ('식비'), ('교통'), ('쇼핑'), ('주거/통신'), ('문화/여가'), ('의료'), ('교육'), ('기타');
           END IF;
         END $$;
         DO $$ BEGIN
           -- 수입 카테고리를 지출과 분리: kind 컬럼을 처음 추가할 때만 기본키 변경 + 수입 기본값 삽입
           IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'kind') THEN
             ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense';
             ALTER TABLE categories DROP CONSTRAINT categories_pkey;
             ALTER TABLE categories ADD PRIMARY KEY (kind, name);
             INSERT INTO categories (kind, name) VALUES
               ('income', '월급'), ('income', '용돈'), ('income', '부수입'), ('income', '이자/투자'), ('income', '기타');
           END IF;
         END $$;`
      )
      .catch((e) => {
        initPromise = null;
        throw e;
      });
  }
  return initPromise;
}

// ---- 인증: 서버리스에서도 동작하도록 서명된 무상태 쿠키 사용 ----
const COOKIE = 'auth';
const MAX_AGE = 60 * 60 * 24 * 7; // 7일

function sign(value) {
  return crypto.createHmac('sha256', APP_PASSWORD || '').update(value).digest('hex');
}
function makeToken() {
  const exp = String(Date.now() + MAX_AGE * 1000);
  return `${exp}.${sign(exp)}`;
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
function isAuthed(req) {
  if (!APP_PASSWORD) return true; // APP_PASSWORD 미설정 시 인증 없이 접속 허용
  const token = getCookie(req, COOKIE);
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: '인증이 필요합니다.' });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
// 화면 파일은 매번 최신본인지 확인하게 해서, 수정 후 예전 코드가 캐시로 남지 않도록 함
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// 로그인 시도 제한 (인스턴스 단위의 간단한 방어)
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const rec = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 10) return res.status(429).json({ error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.' });
  const { password } = req.body || {};
  if (!APP_PASSWORD || typeof password !== 'string' || !safeEqual(password, APP_PASSWORD)) {
    rec.n++; attempts.set(ip, rec);
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  attempts.delete(ip);
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req) }));

const api = express.Router();
api.use(requireAuth);
api.use(async (req, res, next) => {
  try { await initDb(); await materialize(); next(); } catch (e) { next(e); }
});

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
async function materialize() {
  const today = todayKST();
  const due = await pool.query('SELECT 1 FROM recurring WHERE next_date <= $1 LIMIT 1', [today]);
  if (!due.rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, kind, item, category, amount, interval_months, day_of_month, to_char(next_date,'YYYY-MM-DD') AS next_date
       FROM recurring WHERE next_date <= $1 FOR UPDATE`, [today]);
    for (const r of rows) {
      let d = r.next_date;
      for (let i = 0; d <= today && i < 600; i++) {
        await client.query(
          'INSERT INTO expenses (date, item, category, amount, kind, recurring_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [d, r.item, r.category, r.amount, r.kind, r.id]);
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

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 지출 날짜가 이벤트 기간 안인지 확인 (이벤트가 없으면 오류 문구 반환)
async function checkEventDate(eventId, date) {
  const r = await pool.query(
    `SELECT to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e FROM events WHERE id = $1`, [eventId]);
  if (!r.rowCount) return '이벤트를 찾을 수 없습니다.';
  const { s, e } = r.rows[0];
  if (date < s || date > e) return `날짜는 이벤트 기간(${s} ~ ${e}) 안이어야 합니다.`;
  return null;
}

// 이름 검색어 -> ILIKE 패턴 (%, _, \\ 는 문자 그대로 검색)
const likePattern = (q) => '%' + String(q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';

// 목록 조회 (?date=YYYY-MM-DD | ?from=&to= | ?month=YYYY-MM | ?q=항목명)
// 기본은 이벤트에 속하지 않은 지출만, ?event=ID 는 해당 이벤트의 지출, ?q= 검색 시에는 이벤트 안 내역도 포함
api.get('/expenses', async (req, res, next) => {
  try {
    const { date, from, to, month, event } = req.query;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    for (const d of [date, from, to]) {
      if (d !== undefined && !DATE_RE.test(d)) return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다.' });
    }
    if (month !== undefined && !MONTH_RE.test(month)) return res.status(400).json({ error: '월 형식이 올바르지 않습니다.' });
    if (event !== undefined && !/^\d+$/.test(event)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const where = [];
    const params = [];
    if (event) { params.push(Number(event)); where.push(`event_id = $${params.length}`); }
    else if (!q) where.push('event_id IS NULL');
    if (date) { params.push(date); where.push(`date = $${params.length}`); }
    if (from) { params.push(from); where.push(`date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`date <= $${params.length}`); }
    if (month) { params.push(month + '-01'); where.push(`date_trunc('month', date) = $${params.length}::date`); }
    if (q) { params.push(likePattern(q)); where.push(`x.item ILIKE $${params.length} ESCAPE '\\'`); }
    const sql = `SELECT x.id, to_char(x.date,'YYYY-MM-DD') AS date, x.item, x.category, x.amount, x.kind, x.event_id, ev.name AS event_name,
                        x.recurring_id, rc.interval_months, rc.day_of_month
                 FROM expenses x LEFT JOIN recurring rc ON rc.id = x.recurring_id
                 LEFT JOIN events ev ON ev.id = x.event_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY x.date DESC, x.id DESC LIMIT 1000`;
    res.json((await pool.query(sql, params)).rows);
  } catch (e) { next(e); }
});

api.post('/expenses', async (req, res, next) => {
  try {
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
      const eerr = await checkEventDate(eventId, date);
      if (eerr) return res.status(400).json({ error: eerr });
    }
    // 정기 항목이면 규칙을 먼저 만들고, 입력한 내역이 첫 회차. 다음 회차는 주기 뒤 지정한 날짜
    let recurringId = null;
    if (rec) {
      const ins = await pool.query(
        `INSERT INTO recurring (kind, item, category, amount, interval_months, day_of_month, next_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [kind, item.trim(), category.trim(), Number(amount), rec.interval_months, rec.day_of_month,
         nextOccurrence(date, rec.interval_months, rec.day_of_month)]);
      recurringId = ins.rows[0].id;
    }
    try {
      const r = await pool.query(
        `INSERT INTO expenses (date, item, category, amount, kind, event_id, recurring_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, to_char(date,'YYYY-MM-DD') AS date, item, category, amount, kind, event_id, recurring_id`,
        [date, item.trim(), category.trim(), Number(amount), kind, eventId, recurringId]);
      res.status(201).json(r.rows[0]);
    } catch (e) {
      if (recurringId) await pool.query('DELETE FROM recurring WHERE id = $1', [recurringId]).catch(() => {});
      throw e;
    }
  } catch (e) { next(e); }
});

api.put('/expenses/:id', async (req, res, next) => {
  try {
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const { date, item, category, amount } = req.body;
    // 이벤트 소속은 바꾸지 않되, 소속된 이벤트의 기간은 지켜야 함
    const cur = await pool.query('SELECT event_id FROM expenses WHERE id = $1', [id]);
    if (!cur.rowCount) return res.status(404).json({ error: '내역을 찾을 수 없습니다.' });
    if (cur.rows[0].event_id) {
      const eerr = await checkEventDate(cur.rows[0].event_id, date);
      if (eerr) return res.status(400).json({ error: eerr });
    }
    const r = await pool.query(
      `UPDATE expenses SET date=$1, item=$2, category=$3, amount=$4, kind=$5 WHERE id=$6
       RETURNING id, to_char(date,'YYYY-MM-DD') AS date, item, category, amount, kind, event_id, recurring_id`,
      [date, item.trim(), category.trim(), Number(amount), req.body.kind || 'expense', id]);
    if (!r.rowCount) return res.status(404).json({ error: '내역을 찾을 수 없습니다.' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

api.delete('/expenses/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING recurring_id', [id]);
    if (!r.rowCount) return res.status(404).json({ error: '내역을 찾을 수 없습니다.' });
    // ?stop_recurring=1 이면 정기 설정도 함께 삭제 (이미 기록된 다른 회차는 남음)
    const rid = r.rows[0].recurring_id;
    if (rid && req.query.stop_recurring === '1') await pool.query('DELETE FROM recurring WHERE id=$1', [rid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 정기 항목 중단 (이미 만들어진 내역은 그대로 남고, 이후 회차만 생성되지 않음)
api.delete('/recurring/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query('DELETE FROM recurring WHERE id = $1', [id]);
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
  return null;
}

// 이벤트 + 순합계(수입-지출, 부호 포함)/건수 (date 를 주면 그 날짜의 합계 day_total 도 포함)
const EVENT_SELECT = `
  SELECT e.id, e.name, e.category, to_char(e.start_date,'YYYY-MM-DD') AS start_date, to_char(e.end_date,'YYYY-MM-DD') AS end_date,
         COALESCE(SUM(CASE WHEN x.kind = 'income' THEN x.amount ELSE -x.amount END),0)::bigint AS total, COUNT(x.id)::int AS count,
         COALESCE(SUM(CASE WHEN x.kind = 'income' THEN x.amount ELSE -x.amount END) FILTER (WHERE x.date = $1::date),0)::bigint AS day_total
  FROM events e LEFT JOIN expenses x ON x.event_id = e.id`;
const toEvent = (r) => ({ ...r, total: Number(r.total), day_total: Number(r.day_total) });

api.get('/events', async (req, res, next) => {
  try {
    const { date } = req.query;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (date !== undefined && !DATE_RE.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다.' });
    const where = [date ? 'e.start_date <= $1::date AND e.end_date >= $1::date' : '$1::date IS NULL'];
    const params = [date || null];
    if (q) { params.push(likePattern(q)); where.push(`e.name ILIKE $2 ESCAPE '\\'`); }
    const r = await pool.query(
      `${EVENT_SELECT} WHERE ${where.join(' AND ')}
       GROUP BY e.id ORDER BY e.start_date DESC, e.id DESC`, params);
    res.json(r.rows.map(toEvent));
  } catch (e) { next(e); }
});

api.get('/events/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query(`${EVENT_SELECT} WHERE e.id = $2 GROUP BY e.id`, [null, id]);
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
      `INSERT INTO events (name, category, start_date, end_date) VALUES ($1,$2,$3,$4)
       RETURNING id, name, category, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date`,
      [name.trim(), category.trim(), start_date, end_date]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

api.put('/events/:id', async (req, res, next) => {
  try {
    const err = validateEvent(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const { name, category, start_date, end_date } = req.body;
    // 기간을 줄일 때 기간 밖으로 나가는 지출이 있으면 거부
    const out = await pool.query(
      'SELECT COUNT(*)::int AS n FROM expenses WHERE event_id = $1 AND (date < $2 OR date > $3)', [id, start_date, end_date]);
    if (out.rows[0].n > 0) {
      return res.status(409).json({ error: `새 기간 밖의 지출/수입이 ${out.rows[0].n}건 있습니다. 해당 내역의 날짜를 먼저 수정하세요.` });
    }
    const r = await pool.query(
      `UPDATE events SET name=$1, category=$2, start_date=$3, end_date=$4 WHERE id=$5
       RETURNING id, name, category, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date`,
      [name.trim(), category.trim(), start_date, end_date, id]);
    if (!r.rowCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 이벤트 삭제 (속한 지출도 함께 삭제됨)
api.delete('/events/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID입니다.' });
    const r = await pool.query('DELETE FROM events WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 카테고리는 지출(expense)/수입(income)별로 따로 관리: ?kind=expense|income (기본 expense)
const kindOf = (v) => (v === 'income' ? 'income' : 'expense');

// 카테고리 목록 (기본 + 사용자 추가 + 기존 내역에 쓰인 것)
api.get('/categories', async (req, res, next) => {
  try {
    const kind = kindOf(req.query.kind);
    const r = await pool.query(
      `SELECT name FROM (
         SELECT name, created_at FROM categories WHERE kind = $1
         UNION
         SELECT category, now() FROM expenses WHERE kind = $1 AND category NOT IN (SELECT name FROM categories WHERE kind = $1)
         UNION
         SELECT category, now() FROM events WHERE $1 = 'expense' AND category NOT IN (SELECT name FROM categories WHERE kind = 'expense')
       ) c ORDER BY created_at, name`, [kind]);
    res.json(r.rows.map((x) => x.name));
  } catch (e) { next(e); }
});

api.post('/categories', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 50) return res.status(400).json({ error: '카테고리 이름은 1~50자로 입력하세요.' });
    await pool.query('INSERT INTO categories (kind, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [kindOf(req.body?.kind), name]);
    res.status(201).json({ name });
  } catch (e) { next(e); }
});

// 카테고리 이름 변경 (이미 있는 이름으로 바꾸면 합쳐짐)
api.put('/categories/:name', async (req, res, next) => {
  const oldName = req.params.name;
  const kind = kindOf(req.body?.kind);
  const newName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!newName || newName.length > 50) return res.status(400).json({ error: '카테고리 이름은 1~50자로 입력하세요.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (newName !== oldName) {
      await client.query(
        `INSERT INTO categories (kind, name, created_at)
         SELECT $3, $1, COALESCE((SELECT created_at FROM categories WHERE name = $2 AND kind = $3), now())
         ON CONFLICT DO NOTHING`, [newName, oldName, kind]);
      await client.query('UPDATE expenses SET category = $1 WHERE category = $2 AND kind = $3', [newName, oldName, kind]);
      await client.query('UPDATE recurring SET category = $1 WHERE category = $2 AND kind = $3', [newName, oldName, kind]);
      if (kind === 'expense') await client.query('UPDATE events SET category = $1 WHERE category = $2', [newName, oldName]);
      await client.query('DELETE FROM categories WHERE name = $1 AND kind = $2', [oldName, kind]);
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
    const name = req.params.name;
    const kind = kindOf(req.query.kind);
    const used = await pool.query(
      `SELECT (SELECT COUNT(*) FROM expenses WHERE category = $1 AND kind = $2)::int AS n,
              (SELECT COUNT(*) FROM recurring WHERE category = $1 AND kind = $2)::int AS rc,
              (SELECT COUNT(*) FROM events WHERE category = $1 AND $2 = 'expense')::int AS ev`, [name, kind]);
    const { n, rc, ev } = used.rows[0];
    if (n > 0 || rc > 0 || ev > 0) {
      const parts = [n > 0 && `${kind === 'income' ? '수입' : '지출'} ${n}건`, rc > 0 && `정기 항목 ${rc}건`, ev > 0 && `이벤트 ${ev}건`].filter(Boolean).join('과 ');
      return res.status(409).json({ error: `이 카테고리를 사용하는 ${parts}이 있어 삭제할 수 없습니다. 이름 변경으로 다른 카테고리와 합치거나, 해당 항목을 먼저 수정하세요.` });
    }
    await pool.query('DELETE FROM categories WHERE name = $1 AND kind = $2', [name, kind]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 월별 합계
api.get('/summary/monthly', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT to_char(date,'YYYY-MM') AS month,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'),0)::bigint AS total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'income'),0)::bigint AS income,
              COUNT(*)::int AS count
       FROM expenses GROUP BY 1 ORDER BY 1 DESC`);
    res.json(r.rows.map((x) => ({ ...x, total: Number(x.total), income: Number(x.income) })));
  } catch (e) { next(e); }
});

// 카테고리별 지출 합계 (?month=YYYY-MM | ?year=YYYY 선택, 수입 제외)
api.get('/summary/category', async (req, res, next) => {
  try {
    const { month, year } = req.query;
    if (month !== undefined && !MONTH_RE.test(month)) return res.status(400).json({ error: '월 형식이 올바르지 않습니다.' });
    if (year !== undefined && !/^\d{4}$/.test(year)) return res.status(400).json({ error: '연도 형식이 올바르지 않습니다.' });
    const params = [];
    let where = `WHERE kind = 'expense'`;
    if (month) { params.push(month + '-01'); where += ` AND date_trunc('month', date) = $${params.length}::date`; }
    if (year) { params.push(year + '-01-01'); where += ` AND date_trunc('year', date) = $${params.length}::date`; }
    const r = await pool.query(
      `SELECT category, SUM(amount)::bigint AS total, COUNT(*)::int AS count
       FROM expenses ${where} GROUP BY category ORDER BY total DESC`, params);
    res.json(r.rows.map((x) => ({ ...x, total: Number(x.total) })));
  } catch (e) { next(e); }
});

app.use('/api', api);

// 오류 처리: DB 접속 정보 등 내부 정보를 응답에 노출하지 않음
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`http://localhost:${port}`));
}
