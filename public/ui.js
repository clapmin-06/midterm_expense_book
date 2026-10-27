// ---- 공통 UI: 브라우저 기본 confirm/alert/select 를 대체하는 앱 전용 컴포넌트 ----
// app.js, stats.js 보다 먼저 로드된다. ($ 는 app.js 에도 정의되어 있어 여기서는 따로 사용)
const byId = (id) => document.getElementById(id);

// 돈비 로고 마크 (디자인 시안 "H · 빗방울 → 원화"의 도형 그대로). 색은 currentColor, ₩ 글자는 흰색
const MARK_SVG =
  '<svg viewBox="0 0 64 64" width="100%" height="100%" role="img" aria-label="돈비 로고" style="display:block">' +
  '<circle cx="9.2" cy="41.8" r="6.2" fill="currentColor" fill-opacity="0.5"/>' +
  '<path d="M6.3 39.2L7.75 44.4L9.2 40.6L10.65 44.4L12.1 39.2" fill="none" stroke="#fff" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M5.9 41.8H12.5" fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round"/>' +
  '<path d="M26.6 27.45C22.55 29.84 18 34.4 18 39.4C18 44.15 21.85 48 26.6 48C31.35 48 35.2 44.15 35.2 39.4C35.2 34.4 30.65 29.84 26.6 27.45Z" fill="currentColor" fill-opacity="0.75"/>' +
  '<path d="M49.4 15.75C44.89 22.2 37.8 29.31 37.8 36.4C37.8 42.8 43 48 49.4 48C55.8 48 61 42.8 61 36.4C61 29.31 53.91 22.2 49.4 15.75Z" fill="currentColor"/>' +
  '</svg>';
document.querySelectorAll('.brand-mark').forEach((e) => { e.innerHTML = MARK_SVG; });

// 확인창: 취소/확인 두 버튼. true(확인) / false(취소·바깥 클릭·Esc) 로 resolve
function openConfirm({ title, message = '', okText = '확인', cancelText = '취소', danger = false, single = false }) {
  return new Promise((resolve) => {
    const dlg = byId('confirm-dialog');
    byId('cf-title').textContent = title;
    byId('cf-msg').textContent = message;
    byId('cf-msg').classList.toggle('hidden', !message);
    const ok = byId('cf-ok');
    const cancel = byId('cf-cancel');
    ok.textContent = okText;
    ok.className = danger ? 'btn-danger' : 'btn-primary';
    cancel.textContent = cancelText;
    cancel.classList.toggle('hidden', single);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('click', onBackdrop);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onCancel = (e) => { e.preventDefault(); finish(false); }; // Esc
    const onBackdrop = (e) => { if (e.target === dlg) finish(false); };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('click', onBackdrop);
    dlg.showModal();
    (single ? ok : cancel).focus();
  });
}
const uiConfirm = (opts) => openConfirm(opts);
const uiAlert = (message, title = '알림') => openConfirm({ title, message, okText: '확인', single: true });

// 선택 목록: <select> 를 숨기고, 누르면 아래에서 올라오는 시트에서 고르는 방식으로 교체
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

function openPicker(sel, title) {
  const dlg = byId('pick-dialog');
  byId('pick-title').textContent = title;
  const list = byId('pick-list');
  list.replaceChildren();
  for (const o of sel.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-item' + (o.value === sel.value ? ' on' : '');
    const t = document.createElement('span');
    t.textContent = o.text;
    const c = document.createElement('i');
    c.innerHTML = CHECK_SVG;
    b.append(t, c);
    b.onclick = () => {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      dlg.close();
    };
    list.append(b);
  }
  dlg.showModal();
  list.querySelector('.on')?.scrollIntoView({ block: 'center' });
}
byId('pick-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function enhanceSelect(sel, title) {
  if (sel._enhanced) return;
  sel._enhanced = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  const txt = document.createElement('span');
  btn.append(txt);
  sel.classList.add('sel-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  sel.after(btn);

  const sync = () => { txt.textContent = sel.options[sel.selectedIndex]?.text ?? ''; };
  // 코드에서 sel.value = ... 로 바꿔도 버튼 글자가 따라가도록
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return nativeValue.get.call(this); },
    set(v) { nativeValue.set.call(this, v); sync(); },
  });
  new MutationObserver(sync).observe(sel, { childList: true });
  sel.form?.addEventListener('reset', () => setTimeout(sync));
  btn.onclick = () => openPicker(sel, title);
  sync();
}

// 이모티콘 선택 시트: 격자에서 고르거나 "자동 추천"(빈 값)으로 되돌림
const EMOJI_CHOICES = ['✈️', '🧳', '🏖️', '🏝️', '⛺', '🏔️', '⛷️', '🚗', '🚆', '🚢', '🗼', '🗽', '🍊', '🍽️', '🍻', '☕',
  '🎂', '🎉', '🎁', '💒', '💕', '🎓', '📚', '🏠', '📦', '🏥', '💊', '🏋️', '⚽', '🎤', '🎬', '🎮',
  '🎭', '🛍️', '🎄', '🌸', '🌕', '🎡', '🐶', '👶', '🔧', '💼', '💻', '🌏'];
function openEmojiPicker(current, onPick) {
  const dlg = byId('emoji-dialog');
  const grid = byId('emoji-grid');
  grid.replaceChildren();
  const done = (v) => { onPick(v); dlg.close(); };
  for (const e of EMOJI_CHOICES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-cell' + (e === current ? ' on' : '');
    b.textContent = e;
    b.setAttribute('aria-label', e);
    b.onclick = () => done(e);
    grid.append(b);
  }
  byId('emoji-auto').onclick = () => done('');
  dlg.showModal();
}
byId('emoji-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

enhanceSelect(byId('f-category'), '카테고리');
enhanceSelect(byId('en-category'), '카테고리');
enhanceSelect(byId('ev-category'), '카테고리');
