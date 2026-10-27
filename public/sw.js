// 돈비 서비스 워커: 화면 파일만 캐시 (stale-while-revalidate). 개인 데이터가 담긴 /api/* 는 절대 저장하지 않는다.
const CACHE = 'donb-static-v1';
const SHELL = ['/', '/style.css', '/ui.js', '/app.js', '/stats.js', '/install.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/favicon-32.png', '/icons/donb-icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))) // 하나가 실패해도 설치는 진행
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 다른 사이트(글꼴 등), API, 서비스 워커 파일 자체는 건드리지 않고 브라우저가 그대로 처리
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  const key = url.pathname === '/' ? '/' : req; // 주소 뒤에 ?... 가 붙어도 같은 첫 화면으로 취급
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    // 캐시가 있으면 즉시 보여주고, 뒤에서 새 버전을 받아 다음 실행부터 반영
    const fresh = fetch(req)
      .then((res) => { if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()); return res; })
      .catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || Response.error();
  })());
});
