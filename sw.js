// 研读 Service Worker：离线缓存应用外壳与 pdf.js 资源。
// 部署前运行 `node tools/build-sw.mjs`，会按文件内容自动更新 VERSION 与 PRECACHE。
const VERSION = '93963c6202';
const PRECACHE = ["./","css/app.css","css/base.css","icons/apple-touch-icon.png","icons/favicon-32.png","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png","index.html","js/ai.js","js/app.js","js/db.js","js/pdfview.js","js/reader.js","js/reflow.js","js/tts.js","js/util.js","manifest.webmanifest","vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc","vendor/pdfjs/pdf.compat.mjs","vendor/pdfjs/pdf.worker.compat.mjs","vendor/pdfjs/standard_fonts/FoxitDingbats.pfb","vendor/pdfjs/standard_fonts/FoxitFixed.pfb","vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb","vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb","vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb","vendor/pdfjs/standard_fonts/FoxitSerif.pfb","vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb","vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb","vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb","vendor/pdfjs/standard_fonts/FoxitSymbol.pfb","vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf","vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf","vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf","vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf","vendor/pdfjs/wasm/jbig2.wasm","vendor/pdfjs/wasm/jbig2_nowasm_fallback.js","vendor/pdfjs/wasm/openjpeg.wasm","vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js","vendor/pdfjs/wasm/qcms_bg.wasm"];
const SHELL = 'yandu-shell-' + VERSION;
const RUNTIME = 'yandu-runtime-v1'; // cmaps 等按需缓存的资源

const isAppShell = u => {
  const p = String(u).replace(/^\.\//, '');
  return p === '' || p === 'index.html' || p === 'manifest.webmanifest' || /^(css|js|icons)\//.test(p);
};

// 单个文件失败或超时都不影响安装：一个慢的字体/wasm 不能让整次更新作废
async function cacheOne(cache, url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(new Request(url, { cache: 'reload' }), { signal: ctrl.signal });
    if (res && res.ok) await cache.put(url, res);
  } catch (e) {}
  finally { clearTimeout(t); }
}

self.addEventListener('install', e => {
  // 不等待页面发消息：iOS 主屏应用里更新条经常不出现，旧 worker 会一直占着
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const cache = await caches.open(SHELL);
      const shell = PRECACHE.filter(isAppShell);
      const vendor = PRECACHE.filter(u => !isAppShell(u));
      for (const u of shell) await cacheOne(cache, u, 12000);
      await Promise.all(vendor.map(u => cacheOne(cache, u, 20000)));
    } catch (e) {}
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('yandu-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

async function fromCache(req) {
  const shell = await caches.open(SHELL);
  const hit = await shell.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const runtime = await caches.open(RUNTIME);
  return runtime.match(req, { ignoreSearch: true });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨域请求（arXiv、AI 接口）不经过缓存
  // 导航必须先走网络，否则旧的 index.html 会一直挡住新版本
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(url.pathname + url.search, { cache: 'reload', credentials: 'same-origin' });
        if (res && res.ok) {
          const cache = await caches.open(SHELL);
          cache.put('index.html', res.clone());
          cache.put('./', res.clone());
          return res;
        }
      } catch (err) {}
      const cache = await caches.open(SHELL);
      return (await cache.match('index.html')) || (await cache.match('./')) || new Response('离线且未缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }
  // 本版本 worker 接管之后，外壳文件用缓存优先（缓存是这一版安装时拉的）；没有才走网络
  e.respondWith((async () => {
    const hit = await fromCache(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok && url.pathname.includes('/vendor/pdfjs/')) {
      const box = await caches.open(RUNTIME);
      box.put(req, res.clone());
    }
    return res;
  })());
});
