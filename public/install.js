// ---- 홈 화면에 추가(앱 설치) 안내 + 앱 안 브라우저(카카오톡 등) 대응 ----
// 브라우저는 바로가기를 자동으로 만들어 주지 않으므로: 안드로이드는 설치 버튼(한 번 터치), 아이폰은 단계별 안내를 보여준다.
(function () {
  const $ = (id) => document.getElementById(id);
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; // 이미 홈 화면 앱으로 연 경우
  // 카카오톡/인스타그램/페이스북/라인/네이버/다음 앱 안 브라우저: 구글이 로그인을 막고(disallowed_useragent), 홈 화면 추가도 안 됨
  const inApp = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|FB_IAB|Line\/|DaumApps/i.test(ua);
  const isKakao = /KAKAOTALK/i.test(ua);

  // 1) 앱 안 브라우저: 로그인 화면에서 구글 버튼 대신 "기본 브라우저로 열기" 안내 (스타일은 html.inapp 으로 전환)
  if (inApp) {
    document.documentElement.classList.add('inapp');
    const btn = $('inapp-open');
    btn.textContent = isKakao ? '기본 브라우저로 열기' : '주소 복사하기';
    btn.onclick = async () => {
      if (isKakao) { location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href); return; }
      try { await navigator.clipboard.writeText(location.href); uiAlert('주소를 복사했어요. 크롬이나 사파리를 열어 붙여넣어 주세요.', '복사 완료'); }
      catch { uiAlert('주소창의 주소를 복사해서 크롬이나 사파리에서 열어 주세요.', '안내'); }
    };
  }

  // 2) 홈 화면에 추가 배너 (로그인 후 화면 안에 있어서 로그인 뒤에만 보임)
  const banner = $('install-banner');
  const KEY = 'install-banner-dismissed';
  const HIDE_MS = 30 * 24 * 3600 * 1000; // 닫으면 30일 동안 다시 안 보임
  let deferred = null; // 안드로이드 Chrome 등에서 브라우저가 알려주는 "설치 가능" 이벤트
  const dismissed = () => { try { const t = Number(localStorage.getItem(KEY)); return !!t && Date.now() - t < HIDE_MS; } catch { return false; } };

  function update() {
    const show = (isIOS || isAndroid) && !standalone && !inApp && !dismissed();
    banner.classList.toggle('hidden', !show);
    $('ib-action').textContent = deferred ? '설치' : '추가 방법';
  }
  // 아이폰에는 설치 버튼 기능이 없으므로(안내 창으로 대체) 이 이벤트는 안드로이드/데스크톱 Chrome 계열에서만 사용
  window.addEventListener('beforeinstallprompt', (e) => { if (isIOS) return; e.preventDefault(); deferred = e; update(); });
  window.addEventListener('appinstalled', () => { deferred = null; banner.classList.add('hidden'); });

  function openGuide() {
    $('ins-ios').classList.toggle('hidden', !isIOS && isAndroid);
    $('ins-android').classList.toggle('hidden', isIOS);
    $('install-dialog').showModal();
  }
  $('ib-action').onclick = async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null;
      update();
    } else {
      openGuide();
    }
  };
  $('ib-close').onclick = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch {} update(); };
  $('ins-close').onclick = $('ins-ok').onclick = () => $('install-dialog').close();
  $('install-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  update();
})();
