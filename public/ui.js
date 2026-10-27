// ---- 공통 UI: 브라우저 기본 confirm/alert/select 를 대체하는 앱 전용 컴포넌트 ----
// app.js, stats.js 보다 먼저 로드된다. ($ 는 app.js 에도 정의되어 있어 여기서는 따로 사용)
const byId = (id) => document.getElementById(id);

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

enhanceSelect(byId('f-category'), '카테고리');
enhanceSelect(byId('en-category'), '카테고리');
enhanceSelect(byId('ev-category'), '카테고리');
