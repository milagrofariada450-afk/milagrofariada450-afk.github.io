// 研读 Service Worker：离线缓存应用外壳与 pdf.js 资源。
// 部署前运行 `node tools/build-sw.mjs`，会按文件内容自动更新 VERSION 与 PRECACHE。
const VERSION = '38ebaac4db';
const PRECACHE = ["./","css/app.css","css/base.css","icons/apple-touch-icon.png","icons/favicon-32.png","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png","index.html","js/ai.js","js/app.js","js/db.js","js/pdfview.js","js/reader.js","js/reflow.js","js/util.js","manifest.webmanifest","vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc","vendor/pdfjs/pdf.compat.mjs","vendor/pdfjs/pdf.worker.compat.mjs","vendor/pdfjs/standard_fonts/FoxitDingbats.pfb","vendor/pdfjs/standard_fonts/FoxitFixed.pfb","vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb","vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb","vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb","vendor/pdfjs/standard_fonts/FoxitSerif.pfb","vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb","vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb","vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb","vendor/pdfjs/standard_fonts/FoxitSymbol.pfb","vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf","vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf","vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf","vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf","vendor/pdfjs/wasm/jbig2.wasm","vendor/pdfjs/wasm/jbig2_nowasm_fallback.js","vendor/pdfjs/wasm/openjpeg.wasm","vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js","vendor/pdfjs/wasm/qcms_bg.wasm"];
const SHELL = 'yandu-shell-' + VERSION;
const RUNTIME = 'yandu-runtime-v1'; // cmaps 等按需缓存的资源

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('yandu-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨域请求（arXiv、AI 接口）不经过缓存
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      return (await c.match('index.html')) || fetch(req).catch(() => new Response('离线且未缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && url.pathname.includes('/vendor/pdfjs/')) { const c = await caches.open(RUNTIME); c.put(req, res.clone()); }
    return res;
  })());
});
