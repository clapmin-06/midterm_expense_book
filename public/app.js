const $ = (id) => document.getElementById(id);
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';
// 부호 포함 순합계(수입 +, 지출 -)
const signed = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + won(Math.abs(n));
const delta = (r) => (r.kind === 'income' ? r.amount : -r.amount);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') showLogin();
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
// 데이터가 바뀌면 true. 통계는 화면에 보일 때(탭을 열 때)만 다시 불러와 불필요한 요청을 줄임
let statsDirty = true;
const statsVisible = () => !$('tab-stats').classList.contains('hidden');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// 서버가 알려준 로그인 방식(/api/me): 구글 로그인 / 개발용 비밀번호 로그인
let auth = { googleEnabled: false, passwordLogin: false, user: null };
const LOGIN_ERRORS = {
  denied: '구글 로그인이 취소되었어요.',
  state: '로그인 요청이 만료되었어요. 다시 시도해 주세요.',
  failed: '구글 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.',
  config: '구글 로그인이 아직 설정되지 않았어요.',
};
function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('google-login').classList.toggle('hidden', !auth.googleEnabled);
  $('login-form').classList.toggle('hidden', !auth.passwordLogin);
  $('login-note').classList.toggle('hidden', auth.googleEnabled || auth.passwordLogin);
}
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  // 상단 프로필: 구글 프로필 사진(없으면 이름 첫 글자)
  const me = $('me');
  const u = auth.user;
  me.replaceChildren();
  me.classList.toggle('hidden', !u);
  if (u) {
    me.title = u.email || u.name || '';
    if (u.picture && /^https:\/\//.test(u.picture)) {
      const img = el('img');
      img.src = u.picture;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); me.append([...(u.name || '?')][0]); };
      me.append(img);
    } else {
      me.append([...(u.name || '?')][0]);
    }
  }
  loadCategories().catch(() => {}); // 카테고리와 내역 목록을 동시에 불러옴
  refresh();
}

// ---- 탭 ----
document.querySelectorAll('.tabbar button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
    $('tab-list').classList.toggle('hidden', b.dataset.tab !== 'list');
    $('tab-stats').classList.toggle('hidden', b.dataset.tab !== 'stats');
    window.scrollTo(0, 0);
    if (b.dataset.tab === 'stats' && statsDirty) loadSummaries().catch((e) => uiAlert(e.message));
  };
});

// ---- 내역 ----
let listSeq = 0;
async function loadList() {
  const date = $('s-date').value;
  const q = $('s-q').value.trim();
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (q) qs.set('q', q);
  const qstr = qs.toString() ? '?' + qs : '';
  const seq = ++listSeq;
  const { expenses: rows, events } = await api('/home' + qstr); // 일반 내역 + 이벤트를 한 번에
  if (seq !== listSeq) return; // 더 최근에 요청한 검색이 있으면 이 결과는 버림
  $('s-cal').classList.toggle('active', !!date);
  $('s-date-tag').classList.toggle('hidden', !date);
  $('s-date-text').textContent = date;
  const box = $('list');
  box.replaceChildren();
  $('empty').classList.toggle('hidden', rows.length > 0 || events.length > 0);
  $('empty').textContent = date || q ? '검색 결과가 없습니다.' : '내역이 없습니다.';
  $('list-label').textContent = date || q ? `${[date, q && `'${q}'`].filter(Boolean).join(' ')} 합계` : '표시된 내역 합계';
  // 날짜를 고르면 이벤트는 그날 쓴 금액만 합계에 반영.
  // 검색 시 이벤트 안 내역이 rows 에도 들어오므로, 이름이 일치한 이벤트 합계에서 그만큼은 빼서 중복을 막음
  const eventRowSum = {};
  for (const r of rows) if (r.event_id) eventRowSum[r.event_id] = (eventRowSum[r.event_id] || 0) + delta(r);
  const eventSum = events.reduce((s, ev) => s + (date ? ev.day_total : ev.total) - (eventRowSum[ev.id] || 0), 0);
  const net = rows.reduce((s, r) => s + delta(r), 0) + eventSum;
  $('list-total').textContent = signed(net);
  $('list-total').classList.toggle('pos', net > 0);

  $('events').classList.toggle('hidden', events.length === 0);
  const evBox = $('event-list');
  evBox.replaceChildren();
  for (const ev of events) {
    const left = el('div', 'left');
    left.append(el('div', 'name', ev.name), el('div', 'cat', `${ev.category} · ${ev.start_date} ~ ${ev.end_date} · ${ev.count}건`));
    evBox.append(itemRow('event', left, el('div', 'amt' + (ev.total > 0 ? ' pos' : ''), signed(ev.total)),
      () => openEvent(ev.id), (row) => deleteEvent(ev, row), ev.name, eventAvatarEl(ev)));
  }

  let group = null;
  let wrap = null;
  let dayTotal = 0;
  let dayTotalEl = null;
  for (const r of rows) {
    if (r.date !== group) {
      group = r.date;
      dayTotal = 0;
      const head = el('div', 'day-head');
      head.append(el('span', '', r.date));
      dayTotalEl = el('span');
      head.append(dayTotalEl);
      wrap = el('div');
      box.append(head, wrap);
    }
    dayTotal += delta(r);
    dayTotalEl.textContent = signed(dayTotal);
    dayTotalEl.classList.toggle('pos', dayTotal > 0);

    const left = el('div', 'left');
    const sub = el('div', 'cat');
    // 이벤트 안의 내역(검색 결과)은 이벤트 이름을 파란 배지로 표시해 일반 내역과 구분
    if (r.event_id) sub.append(el('span', 'ev-tag', `${eventEmoji({ emoji: r.event_emoji, name: r.event_name })} ${r.event_name}`));
    sub.append(r.category + (r.recurring_id ? ' · 정기' : ''));
    left.append(el('div', 'name', r.item), sub);
    wrap.append(itemRow('', left, amountEl(r), () => (r.event_id ? openEventExpense(r) : openForm(r)), (row) => deleteExpense(r, row), r.item, logoAvatarEl()));
  }
}

// 목록의 한 줄: 누르면 열리는 본문 + 바로 삭제 버튼
function itemRow(extraCls, left, amt, onOpen, onDelete, name, avatar) {
  const row = el('div', extraCls ? `item ${extraCls}` : 'item');
  const main = el('button', 'item-main');
  main.type = 'button';
  if (avatar) main.append(avatar);
  main.append(left, amt);
  main.onclick = onOpen;
  const del = el('button', 'item-del', '삭제');
  del.type = 'button';
  del.setAttribute('aria-label', `${name} 삭제`);
  del.onclick = () => onDelete(row);
  row.append(main, del);
  return row;
}

// 정기 내역이면 정기 설정도 함께 사라진다는 것을 먼저 알리고 확인받음
async function confirmDelete(r) {
  if (!r.recurring_id) {
    return uiConfirm({ title: `'${r.item}' 내역을 삭제할까요?`, message: '삭제한 내역은 되돌릴 수 없어요.', okText: '삭제', danger: true });
  }
  return uiConfirm({
    title: '정기 항목을 삭제할까요?',
    message:
      `'${r.item}' 은(는) ${r.interval_months}개월마다 ${r.day_of_month}일에 반복되는 정기 항목이에요.\n` +
      '삭제하면 정기 설정도 함께 사라져서 앞으로 자동으로 추가되지 않아요.\n' +
      '이미 기록된 다른 회차 내역은 그대로 남아요.',
    okText: '삭제', danger: true,
  });
}
const deleteUrl = (r) => '/expenses/' + r.id + (r.recurring_id ? '?stop_recurring=1' : '');

async function deleteExpense(r, row) {
  if (!(await confirmDelete(r))) return;
  if (row) row.classList.add('removing'); // 바로 사라지게 보이고, 실패하면 되돌림
  try {
    await api(deleteUrl(r), { method: 'DELETE' });
    if (currentEvent) loadEvent(currentEvent.id).catch(() => {}); // 이벤트 상세가 열려 있으면 함께 갱신
    refresh();
  } catch (err) {
    if (row) row.classList.remove('removing');
    uiAlert(err.message);
  }
}
async function deleteEvent(ev, row) {
  if (!(await uiConfirm({ title: `'${ev.name}' 이벤트를 삭제할까요?`, message: ev.count ? `이벤트에 속한 지출/수입 ${ev.count}건도 함께 삭제돼요.` : '삭제한 이벤트는 되돌릴 수 없어요.', okText: '삭제', danger: true }))) return;
  if (row) row.classList.add('removing');
  try {
    await api('/events/' + ev.id, { method: 'DELETE' });
    refresh();
  } catch (err) {
    if (row) row.classList.remove('removing');
    uiAlert(err.message);
  }
}

// 목록의 그림 자리: 글자 대신 돈비 로고 마크를 연한 파랑 원 안에 표시 (시안의 "목록" 규격).
// 이벤트는 이름/카테고리에 어울리는 이모티콘 그림으로 구분 (직접 고른 게 있으면 그것을 사용)
function logoAvatarEl() {
  const a = el('span', 'avatar');
  const m = el('span', 'mk');
  m.innerHTML = MARK_SVG;
  a.append(m);
  return a;
}
const EMOJI_RULES = [
  [/제주|감귤|한라/, '🍊'], [/비행기|항공|공항|출국|해외/, '✈️'], [/기차|ktx|열차/, '🚆'], [/렌트|드라이브|자동차|차박/, '🚗'],
  [/바다|해변|해수욕|휴가|워터|리조트|섬/, '🏖️'], [/캠핑|글램핑/, '⛺'], [/등산|산행|트레킹|설악|한라산/, '🏔️'], [/스키|스노보드/, '⛷️'],
  [/일본|도쿄|오사카|교토|후쿠오카|유럽|파리|런던|에펠/, '🗼'], [/미국|뉴욕|하와이/, '🗽'],
  [/졸업|입학|개강|종강|학기|시험/, '🎓'], [/생일|파티/, '🎂'], [/결혼|웨딩|청첩|신혼/, '💒'], [/이사|입주|집들이/, '📦'],
  [/크리스마스|성탄/, '🎄'], [/설날|추석|명절|한가위|귀향/, '🌕'], [/연말|송년|새해|신년|불꽃/, '🎉'],
  [/회식|술자리|소주|맥주|치맥|한잔|모임|뒤풀이/, '🍻'], [/맛집|식사|저녁|점심|브런치|뷔페|먹/, '🍽️'], [/카페|커피/, '☕'],
  [/쇼핑|세일|블프|구매|장보기/, '🛍️'], [/병원|수술|건강|치료|검진/, '🏥'], [/운동|헬스|러닝|마라톤|요가/, '🏋️'],
  [/콘서트|공연|페스티벌|축제|뮤지컬|연극/, '🎤'], [/영화|시사회/, '🎬'], [/게임|오락/, '🎮'], [/데이트|기념일|연애|커플/, '💕'],
  [/반려|강아지|고양이|펫/, '🐶'], [/출산|육아|아기|돌잔치/, '👶'], [/여행|trip|투어|관광/, '🧳'],
];
const EMOJI_BY_CATEGORY = { 식비: '🍽️', 교통: '🚗', 쇼핑: '🛍️', '주거/통신': '🏠', '문화/여가': '🎭', 의료: '🏥', 교육: '📚' };
// 이름 -> 카테고리 순으로 어울리는 이모티콘을 고르고, 없으면 여행 가방
function autoEmoji(name, category) {
  const text = String(name || '').toLowerCase();
  for (const [re, emoji] of EMOJI_RULES) if (re.test(text)) return emoji;
  return EMOJI_BY_CATEGORY[category] || '🧳';
}
const eventEmoji = (ev) => ev.emoji || autoEmoji(ev.name, ev.category);
function eventAvatarEl(ev) {
  return el('span', 'avatar ev', eventEmoji(ev));
}

function amountEl(r) {
  return r.kind === 'income' ? el('div', 'amt pos', '+' + won(r.amount)) : el('div', 'amt', won(r.amount));
}

// 검색 결과의 이벤트 내역: 이벤트 기간 정보를 받아 이벤트 안에서 여는 것과 같은 폼으로 수정
async function openEventExpense(r) {
  try {
    openForm(r, await api('/events/' + r.event_id));
  } catch (err) {
    uiAlert(err.message);
  }
}

// ---- 카테고리 ----
// 카테고리는 지출/수입이 따로: catCache[kind] = [이름...], 이벤트는 지출 카테고리를 씀
const catCache = { expense: [], income: [] };
let catKind = 'expense'; // 카테고리 관리 시트가 다루는 종류
const KIND_LABEL = { expense: '지출', income: '수입' };

function fillSelect(sel, names, keep) {
  sel.replaceChildren(...names.map((n) => new Option(n, n)));
  if (names.includes(keep)) sel.value = keep;
}
function fillFormCategories(keep) {
  fillSelect($('f-category'), catCache[$('kind-seg').dataset.kind] || [], keep ?? $('f-category').value);
}

async function loadCategories(selected) {
  const all = await api('/categories/all'); // 지출/수입을 한 번에
  catCache.expense = all.expense;
  catCache.income = all.income;
  const names = catCache[catKind];
  const formKind = $('kind-seg').dataset.kind;
  fillFormCategories(formKind === catKind ? selected : undefined);
  for (const id of ['en-category', 'ev-category']) {
    fillSelect($(id), catCache.expense, catKind === 'expense' ? selected ?? $(id).value : $(id).value);
  }
  $('cat-title').textContent = `${KIND_LABEL[catKind]} 카테고리 관리`;

  const box = $('cat-list');
  box.replaceChildren();
  for (const n of names) {
    const row = el('div');
    row.append(el('span', '', n));
    const btns = el('div', 'btns');

    const ren = el('button', '', '이름 변경');
    ren.type = 'button';
    ren.onclick = () => {
      // 행을 입력칸 + 저장/취소로 바꿔 그 자리에서 이름을 고침
      const input = el('input');
      input.type = 'text';
      input.value = n;
      input.maxLength = 50;
      input.setAttribute('aria-label', '새 카테고리 이름');
      const save = el('button', 'primary', '저장');
      save.type = 'button';
      const cancel = el('button', '', '취소');
      cancel.type = 'button';
      const editBtns = el('div', 'btns');
      editBtns.append(save, cancel);
      row.classList.add('editing');
      row.replaceChildren(input, editBtns);
      input.focus();
      input.select();

      const submit = async () => {
        const next = input.value.trim();
        if (!next || next === n) { loadCategories(); return; }
        try {
          const selIds = ['f-category', 'en-category', 'ev-category'].filter(
            (id) => $(id).value === n && (id === 'f-category' ? $('kind-seg').dataset.kind === catKind : catKind === 'expense'));
          await api('/categories/' + encodeURIComponent(n), { method: 'PUT', body: { name: next, kind: catKind } });
          $('cat-error').textContent = '';
          await loadCategories();
          for (const id of selIds) $(id).value = next;
          refreshEmojiField('en');
          refreshEmojiField('ev');
          refresh();
        } catch (err) {
          $('cat-error').textContent = err.message;
        }
      };
      save.onclick = submit;
      cancel.onclick = () => { $('cat-error').textContent = ''; loadCategories(); };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') { e.stopPropagation(); cancel.onclick(); }
      });
    };

    const del = el('button', 'danger', '삭제');
    del.type = 'button';
    del.onclick = async () => {
      if (!(await uiConfirm({ title: `'${n}' 카테고리를 삭제할까요?`, message: '사용 중인 카테고리는 삭제할 수 없어요.', okText: '삭제', danger: true }))) return;
      try {
        await api('/categories/' + encodeURIComponent(n) + '?kind=' + catKind, { method: 'DELETE' });
        $('cat-error').textContent = '';
        await loadCategories();
      } catch (err) {
        $('cat-error').textContent = err.message;
      }
    };
    btns.append(ren, del);
    row.append(btns);
    box.append(row);
  }
}

async function refresh() {
  statsDirty = true;
  try {
    await Promise.all([loadList(), statsVisible() ? loadSummaries() : null]);
  } catch (e) {
    uiAlert(e.message);
  }
}

// 버튼을 누른 동안 "저장 중…"으로 바꾸고 중복 제출을 막음 (누른 즉시 반응이 보이도록)
async function withBusy(btn, label, fn) {
  if (!btn || btn.disabled) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
}

// ---- 지출/수입 추가/수정 시트 ----
// r: 수정할 내역(없으면 추가), ev: 이벤트 안에서 여는 경우의 이벤트 {id, start_date, end_date}
let formRow = null; // 지금 수정창에 열린 내역
function openForm(r, ev) {
  formRow = r || null;
  $('expense-form').reset();
  $('form-error').textContent = '';
  $('f-id').value = r ? r.id : '';
  $('f-event').value = ev ? ev.id : '';
  $('f-date').min = ev ? ev.start_date : '';
  $('f-date').max = ev ? ev.end_date : '';
  // 지출/수입 <-> 이벤트 전환은 일반 내역을 새로 추가할 때만 노출
  $('mode-seg').classList.toggle('hidden', !!r || !!ev);
  const t = today();
  $('f-date').value = r ? r.date : ev && (t < ev.start_date || t > ev.end_date) ? ev.start_date : t;
  $('f-item').value = r ? r.item : '';
  $('f-amount').value = r ? r.amount : '';
  setKind(r ? r.kind : 'expense');
  if (r) $('f-category').value = r.category;
  setRec(false);
  $('f-rec-months').value = 1;
  $('f-rec-day').value = '';
  // 정기 설정은 새 일반 내역에서만, 정기로 만들어진 내역에는 안내와 중단 버튼
  $('rec-block').classList.toggle('hidden', !!ev || (!!r && !r.recurring_id));
  $('rec-info').classList.toggle('hidden', !(r && r.recurring_id));
  $('f-rec').parentElement.classList.toggle('hidden', !!r);
  if (r && r.recurring_id) {
    $('rec-info-text').textContent = `정기 항목 · ${r.interval_months}개월마다 ${r.day_of_month}일`;
  }
  $('expense-form').dataset.recId = r && r.recurring_id ? r.recurring_id : '';
  $('form-title').textContent = r ? '지출/수입 수정' : '지출/수입 추가';
  $('f-submit').textContent = r ? '저장' : '추가';
  $('f-delete').classList.toggle('hidden', !r);
  $('expense-dialog').showModal();
  if (!r) $('f-item').focus();
}
function closeOnBackdrop(dlg) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
// 지출 <-> 수입 전환
function setKind(k) {
  const keep = $('f-category').value;
  $('kind-seg').dataset.kind = k;
  fillFormCategories(keep);
  document.querySelectorAll('#kind-seg button').forEach((b) => b.classList.toggle('active', b.dataset.kind === k));
}
document.querySelectorAll('#kind-seg button').forEach((b) => { b.onclick = () => setKind(b.dataset.kind); });

// 정기 지출/수입 스위치
function setRec(on) {
  $('f-rec').setAttribute('aria-checked', String(on));
  $('rec-fields').classList.toggle('hidden', !on);
  if (on && !$('f-rec-day').value && $('f-date').value) $('f-rec-day').value = Number($('f-date').value.slice(8, 10));
  updateRecHint();
}
function updateRecHint() {
  const m = Number($('f-rec-months').value);
  const d = Number($('f-rec-day').value);
  $('rec-hint').textContent = m >= 1 && d >= 1 ? `${m}개월마다 ${d}일에 자동으로 기록됩니다. (그 달에 ${d}일이 없으면 말일)` : '';
}
$('f-rec').onclick = () => setRec($('f-rec').getAttribute('aria-checked') !== 'true');
$('f-rec-months').oninput = $('f-rec-day').oninput = updateRecHint;
$('rec-stop').onclick = async () => {
  if (!(await uiConfirm({ title: '반복을 중단할까요?', message: '이미 기록된 내역은 그대로 남아요.', okText: '중단', danger: true }))) return;
  const cur = $('expense-form').dataset.recId;
  try {
    await api('/recurring/' + cur, { method: 'DELETE' });
    await afterExpenseChange();
  } catch (err) {
    $('form-error').textContent = err.message;
  }
};

closeOnBackdrop($('expense-dialog'));
closeOnBackdrop($('cat-dialog'));
closeOnBackdrop($('event-new-dialog'));
closeOnBackdrop($('event-dialog'));

$('fab').onclick = () => openForm(null);
$('f-cancel').onclick = () => $('expense-dialog').close();

// 지출 <-> 이벤트 추가 전환
function openEventNew() {
  $('event-new-form').reset();
  $('en-error').textContent = '';
  $('en-start').value = $('en-end').value = today();
  $('en-emoji').value = '';
  refreshEmojiField('en');
  $('event-new-dialog').showModal();
  $('en-name').focus();
}
document.querySelectorAll('#mode-seg button, #event-new-dialog .seg button').forEach((b) => {
  b.onclick = () => {
    if (b.classList.contains('active')) return;
    if (b.dataset.mode === 'event') { $('expense-dialog').close(); openEventNew(); }
    else { $('event-new-dialog').close(); openForm(null); }
  };
});
$('en-cancel').onclick = () => $('event-new-dialog').close();
$('en-start').onchange = () => { if ($('en-end').value < $('en-start').value) $('en-end').value = $('en-start').value; };

$('event-new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withBusy($('event-new-form').querySelector('button[type=submit]'), '만드는 중…', async () => {
    try {
      await api('/events', {
        method: 'POST',
        body: { name: $('en-name').value, category: $('en-category').value, emoji: $('en-emoji').value || null, start_date: $('en-start').value, end_date: $('en-end').value },
      });
      $('event-new-dialog').close();
      refresh();
    } catch (err) {
      $('en-error').textContent = err.message;
    }
  });
});

// 이벤트 이모티콘 입력칸: 값이 비어 있으면 이름/카테고리로 자동 추천한 이모티콘을 미리 보여줌
function refreshEmojiField(p) { // p: 'en'(추가) | 'ev'(수정)
  const v = $(p + '-emoji').value;
  $(p + '-emoji-show').textContent = v || autoEmoji($(p + '-name').value, $(p + '-category').value);
  $(p + '-emoji-hint').textContent = v ? '직접 선택' : '자동 추천';
}
for (const p of ['en', 'ev']) {
  $(p + '-name').addEventListener('input', () => refreshEmojiField(p));
  $(p + '-category').addEventListener('change', () => refreshEmojiField(p));
  $(p + '-emoji-btn').onclick = () => openEmojiPicker($(p + '-emoji').value, (v) => { $(p + '-emoji').value = v; refreshEmojiField(p); });
}

// 이벤트 상세/수정: 이름·기간 수정 + 이벤트의 지출 추가/수정
let currentEvent = null;
async function loadEvent(id) {
  const [ev, rows] = await Promise.all([api('/events/' + id), api('/expenses?event=' + id)]);
  currentEvent = ev;
  $('ev-id').value = ev.id;
  $('ev-name').value = ev.name;
  $('ev-category').value = ev.category;
  $('ev-emoji').value = ev.emoji || '';
  refreshEmojiField('ev');
  $('ev-start').value = ev.start_date;
  $('ev-end').value = ev.end_date;
  $('ev-count').textContent = `${ev.count}건`;
  $('ev-total').textContent = signed(ev.total);
  $('ev-total').classList.toggle('pos', ev.total > 0);
  $('ev-empty').classList.toggle('hidden', rows.length > 0);
  const box = $('ev-expenses');
  box.replaceChildren();
  let group = null;
  let wrap = null;
  for (const r of rows) {
    if (r.date !== group) {
      group = r.date;
      const head = el('div', 'day-head');
      head.append(el('span', '', r.date));
      wrap = el('div');
      box.append(head, wrap);
    }
    const left = el('div', 'left');
    left.append(el('div', 'name', r.item), el('div', 'cat', r.category));
    wrap.append(itemRow('', left, amountEl(r), () => openForm(r, ev), (row) => deleteExpense(r, row), r.item, logoAvatarEl()));
  }
}
async function openEvent(id) {
  try {
    await loadEvent(id);
    $('ev-error').textContent = '';
    $('event-dialog').showModal();
  } catch (err) {
    uiAlert(err.message);
  }
}
$('ev-close').onclick = () => $('event-dialog').close();
$('event-dialog').addEventListener('close', () => { currentEvent = null; });
$('ev-add').onclick = () => openForm(null, currentEvent);

$('event-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withBusy($('event-edit-form').querySelector('button[type=submit]'), '저장 중…', async () => {
    try {
      await api('/events/' + $('ev-id').value, {
        method: 'PUT',
        body: { name: $('ev-name').value, category: $('ev-category').value, emoji: $('ev-emoji').value || null, start_date: $('ev-start').value, end_date: $('ev-end').value },
      });
      $('ev-error').textContent = '';
      refresh(); // 목록 갱신과 이벤트 상세 갱신을 동시에
      await loadEvent($('ev-id').value);
    } catch (err) {
      $('ev-error').textContent = err.message;
    }
  });
});
$('ev-start').onchange = () => { if ($('ev-end').value < $('ev-start').value) $('ev-end').value = $('ev-start').value; };

$('ev-delete').onclick = async () => {
  const n = currentEvent ? currentEvent.count : 0;
  if (!(await uiConfirm({ title: '이 이벤트를 삭제할까요?', message: n ? `이벤트에 속한 지출/수입 ${n}건도 함께 삭제돼요.` : '삭제한 이벤트는 되돌릴 수 없어요.', okText: '삭제', danger: true }))) return;
  try {
    await api('/events/' + $('ev-id').value, { method: 'DELETE' });
    $('event-dialog').close();
    refresh();
  } catch (err) {
    $('ev-error').textContent = err.message;
  }
};

// 지출 저장/삭제 후: 이벤트 상세가 열려 있으면 함께 갱신
function afterExpenseChange() {
  $('expense-dialog').close();
  if (currentEvent) loadEvent(currentEvent.id).catch(() => {}); // 이벤트 상세가 열려 있으면 함께 갱신 (기다리지 않음)
  refresh();
}

$('expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('f-id').value;
  const body = {
    date: $('f-date').value,
    item: $('f-item').value,
    category: $('f-category').value,
    amount: $('f-amount').value,
    kind: $('kind-seg').dataset.kind,
    event_id: $('f-event').value || undefined,
  };
  if (!id && $('f-rec').getAttribute('aria-checked') === 'true') {
    const months = Number($('f-rec-months').value);
    const day = Number($('f-rec-day').value);
    if (!Number.isInteger(months) || months < 1 || months > 120) { $('form-error').textContent = '반복 주기는 1~120개월로 입력하세요.'; return; }
    if (!Number.isInteger(day) || day < 1 || day > 31) { $('form-error').textContent = '반복 날짜는 1~31일로 입력하세요.'; return; }
    body.recurring = { interval_months: months, day_of_month: day };
  }
  await withBusy($('f-submit'), '저장 중…', async () => {
    try {
      await api(id ? '/expenses/' + id : '/expenses', { method: id ? 'PUT' : 'POST', body });
      afterExpenseChange();
    } catch (err) {
      $('form-error').textContent = err.message;
    }
  });
});

$('f-delete').onclick = async () => {
  if (!(await confirmDelete(formRow))) return;
  await withBusy($('f-delete'), '삭제 중…', async () => {
    try {
      await api(deleteUrl(formRow), { method: 'DELETE' });
      afterExpenseChange();
    } catch (err) {
      $('form-error').textContent = err.message;
    }
  });
};

// ---- 카테고리 관리 시트 ----
async function openCatManage(kind) {
  catKind = kind;
  $('cat-error').textContent = '';
  await loadCategories().catch(() => {});
  $('cat-dialog').showModal();
}
// 지출/수입 폼: 지금 보고 있는 종류의 카테고리를 관리. 이벤트 폼: 이벤트는 지출 카테고리를 그대로 쓰므로 지출 카테고리를 관리
$('cat-manage-toggle').onclick = () => openCatManage($('kind-seg').dataset.kind);
$('en-cat-manage').onclick = $('ev-cat-manage').onclick = () => openCatManage('expense');
$('cat-close').onclick = () => $('cat-dialog').close();
$('cat-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('cat-new').value.trim();
  if (!name) return;
  try {
    await api('/categories', { method: 'POST', body: { name, kind: catKind } });
    await loadCategories(name);
    $('cat-new').value = '';
    $('cat-error').textContent = '';
  } catch (err) {
    $('cat-error').textContent = err.message;
  }
});

// ---- 검색/필터 ----
let searchTimer;
const syncQClear = () => $('s-q-x').classList.toggle('hidden', !$('s-q').value);
$('s-q').oninput = () => { syncQClear(); clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); };
$('s-q-x').onclick = () => { clearTimeout(searchTimer); $('s-q').value = ''; syncQClear(); $('s-q').focus(); loadList(); };
$('s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); loadList(); } });
$('s-date').onchange = () => loadList();
$('s-date-x').onclick = () => { $('s-date').value = ''; loadList(); };
$('s-clear').onclick = () => { $('s-date').value = ''; $('s-q').value = ''; syncQClear(); loadList(); };

// ---- 로그인 ----
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/login', { method: 'POST', body: { password: $('password').value } });
    auth = await api('/me'); // 로그인한 사용자 정보(프로필) 갱신
    $('password').value = '';
    $('login-error').textContent = '';
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});
$('logout').onclick = async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
};

api('/me').then((d) => {
  auth = d;
  // 구글 로그인에서 돌아왔을 때 실패 사유가 주소에 붙어 있으면 보여주고 주소를 깨끗이 정리
  const code = new URLSearchParams(location.search).get('login_error');
  if (code) {
    history.replaceState(null, '', location.pathname);
    if (!d.authed) $('login-error').textContent = LOGIN_ERRORS[code] || LOGIN_ERRORS.failed;
  }
  d.authed ? showApp() : showLogin();
});
