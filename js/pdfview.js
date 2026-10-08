// pdf.js 封装：加载、缩略图、局部裁剪渲染（重排中的公式/图表）、原版连续页视图（文本层 + 划线层 + 双指缩放）。
import * as pdfjsLib from '../vendor/pdfjs/pdf.compat.mjs';
const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.compat.mjs';
export { pdfjsLib };

export function loadPdf(buf) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(buf.slice(0)), cMapUrl: BASE + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/', wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
    isEvalSupported: false, enableXfa: false, verbosity: 0
  }).promise;
}

export function closePdf(pdf) { try { const t = pdf && (pdf.destroy ? pdf : pdf.loadingTask); t && t.destroy(); } catch (e) {} }

// 渲染队列：同一时间只渲染 2 个任务，避免 iOS 内存峰值
let running = 0; const waiting = [];
export function queued(fn) {
  return new Promise((res, rej) => {
    const go = async () => { running++; try { res(await fn()); } catch (e) { rej(e); } finally { running--; const n = waiting.shift(); n && n(); } };
    running < 2 ? go() : waiting.push(go);
  });
}
const DPR = () => Math.min(window.devicePixelRatio || 1, 2.5);

export async function renderThumb(pdf, w = 150) {
  const page = await pdf.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: w / vp1.width });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = c.toDataURL('image/jpeg', 0.72);
  c.width = c.height = 0;
  return url;
}

export function renderCrop(pdf, pageNo, bbox, cssW, canvas) {
  return queued(async () => {
    const page = await pdf.getPage(pageNo);
    const bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
    const scale = Math.min(4, (cssW / bw) * DPR());
    const vp = page.getViewport({ scale, offsetX: -bbox[0] * scale, offsetY: -bbox[1] * scale });
    canvas.width = Math.max(1, Math.round(bw * scale)); canvas.height = Math.max(1, Math.round(bh * scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    canvas.style.aspectRatio = `${bw} / ${bh}`;
  });
}

/* ---------- 原版视图 ---------- */
export class PdfView {
  constructor(scroller, pdf, opts) {
    this.scroller = scroller; this.pdf = pdf; this.opts = opts; this.zoom = 1;
    this.el = document.createElement('div'); this.el.className = 'pdf-view';
    this.inner = document.createElement('div'); this.inner.className = 'pdf-pages';
    this.el.appendChild(this.inner);
    this.pages = []; this.rendered = new Map(); this.destroyed = false;
  }
  async mount(sizes) {
    this.scroller.innerHTML = ''; this.scroller.appendChild(this.el);
    if (!sizes || sizes.length !== this.pdf.numPages) {
      sizes = [];
      for (let i = 1; i <= this.pdf.numPages; i++) { const p = await this.pdf.getPage(i); const v = p.getViewport({ scale: 1 }); sizes.push([v.width, v.height]); }
    }
    this.sizes = sizes;
    for (let i = 0; i < sizes.length; i++) {
      const d = document.createElement('div'); d.className = 'pdf-page'; d.dataset.page = i + 1;
      const hl = document.createElement('div'); hl.className = 'hl-layer'; d.appendChild(hl);
      this.inner.appendChild(d); this.pages.push(d);
    }
    this.layout();
    this.io = new IntersectionObserver(es => es.forEach(e => { const n = +e.target.dataset.page; if (e.isIntersecting) this.render(n); }), { root: this.scroller, rootMargin: '800px 0px' });
    this.pages.forEach(p => this.io.observe(p));
    this._ro = () => { clearTimeout(this._rt); this._rt = setTimeout(() => this.relayout(), 200); };
    window.addEventListener('resize', this._ro);
    this.bindPinch();
  }
  fitW() { return Math.max(200, this.scroller.clientWidth - 16); }
  scaleOf(i) { return this.fitW() / this.sizes[i][0] * this.zoom; }
  layout() {
    let maxW = 0;
    this.pages.forEach((d, i) => { const s = this.scaleOf(i); const w = this.sizes[i][0] * s, h = this.sizes[i][1] * s; d.style.width = w + 'px'; d.style.height = h + 'px'; maxW = Math.max(maxW, w); });
    this.inner.style.width = (maxW + 16) + 'px';
    this.inner.style.minWidth = '100%';
  }
  relayout() {
    const cur = this.position();
    this.layout();
    for (const [n] of this.rendered) this.rendered.set(n, 'stale');
    this.scrollTo(cur.page, cur.frac);
    this.pages.forEach((d, i) => { const r = d.getBoundingClientRect(), sr = this.scroller.getBoundingClientRect(); if (r.bottom > sr.top - 800 && r.top < sr.bottom + 800) this.render(i + 1); });
  }
  async render(n) {
    if (this.destroyed) return;
    const st = this.rendered.get(n);
    if (st === 'busy' || st === true) return;
    this.rendered.set(n, 'busy');
    const d = this.pages[n - 1];
    try {
      await queued(async () => {
        if (this.destroyed) return;
        const page = await this.pdf.getPage(n);
        const s = this.scaleOf(n - 1);
        const vp = page.getViewport({ scale: s });
        let ratio = DPR();
        const maxPx = 16e6; if (vp.width * vp.height * ratio * ratio > maxPx) ratio = Math.sqrt(maxPx / (vp.width * vp.height));
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width * ratio); c.height = Math.floor(vp.height * ratio);
        const ctx = c.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
        const old = d.querySelector('canvas'); if (old) { old.width = old.height = 0; old.remove(); }
        d.insertBefore(c, d.firstChild);
        const oldTl = d.querySelector('.textLayer'); if (oldTl) oldTl.remove();
        const tl = document.createElement('div'); tl.className = 'textLayer';
        tl.style.setProperty('--total-scale-factor', s); tl.style.setProperty('--scale-round-x', '1px'); tl.style.setProperty('--scale-round-y', '1px');
        d.insertBefore(tl, d.querySelector('.hl-layer'));
        const tlr = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
        await tlr.render();
        const end = document.createElement('div'); end.className = 'endOfContent'; tl.appendChild(end);
        tl.addEventListener('mousedown', () => tl.classList.add('selecting'));
        document.addEventListener('mouseup', () => tl.classList.remove('selecting'));
        this.drawHighlights(n);
      });
      this.rendered.set(n, true);
      this.evict(n);
    } catch (e) { this.rendered.delete(n); if (!this.destroyed) console.warn('render page failed', n, e); }
  }
  evict(center) {
    if (this.rendered.size <= 10) return;
    const far = [...this.rendered.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const n of far.slice(0, this.rendered.size - 10)) {
      if (this.rendered.get(n) === 'busy') continue;
      const d = this.pages[n - 1]; const c = d.querySelector('canvas'); if (c) { c.width = c.height = 0; c.remove(); }
      const tl = d.querySelector('.textLayer'); if (tl) tl.remove();
      this.rendered.delete(n);
    }
  }
  drawHighlights(n) {
    const layer = this.pages[n - 1]?.querySelector('.hl-layer'); if (!layer) return;
    const hs = this.opts.getHighlights().filter(h => h.mode === 'pdf' && h.page === n);
    layer.innerHTML = hs.map(h => h.rects.map((r, k) => `<div class="hl-${h.color}${h.note && k === 0 ? ' has-note' : ''}" data-hid="${h.id}" style="left:${r[0] * 100}%;top:${r[1] * 100}%;width:${r[2] * 100}%;height:${r[3] * 100}%"></div>`).join('')).join('');
  }
  redrawAll() { this.pages.forEach((_, i) => this.drawHighlights(i + 1)); }
  position() {
    const st = this.scroller.scrollTop; const top0 = this.el.offsetTop;
    for (let i = 0; i < this.pages.length; i++) {
      const d = this.pages[i]; const y = top0 + d.offsetTop, h = d.offsetHeight + 10;
      if (y + h > st) return { page: i + 1, frac: Math.max(0, Math.min(1, (st - y) / h)) };
    }
    return { page: this.pages.length, frac: 0 };
  }
  // 以页面坐标（scale=1 视口坐标，左上为原点）定位：offsetPx 为视口顶端向下的偏移
  positionPt(offsetPx = 0) {
    const st = this.scroller.scrollTop + offsetPx; const top0 = this.el.offsetTop;
    for (let i = 0; i < this.pages.length; i++) {
      const d = this.pages[i]; const y0 = top0 + d.offsetTop;
      if (y0 + d.offsetHeight + 10 > st) return { page: i + 1, y: Math.max(0, Math.min(this.sizes[i][1], (st - y0) / this.scaleOf(i))) };
    }
    return { page: this.pages.length, y: 0 };
  }
  scrollToPt(page, y, marginPx = 12, x = null, mark = false) {
    const i = Math.max(0, Math.min(this.pages.length - 1, page - 1)); const d = this.pages[i]; if (!d) return;
    const s = this.scaleOf(i);
    const target = Math.max(0, this.el.offsetTop + d.offsetTop + (y || 0) * s - marginPx);
    this.scroller.scrollTop = target;
    if (this.zoom > 1.01 && x != null) this.el.scrollLeft = Math.max(0, x * s - 16);
    if (mark) {
      d.querySelectorAll('.pdf-mark').forEach(m => m.remove());
      const m = document.createElement('div'); m.className = 'pdf-mark'; m.style.top = ((y || 0) * s) + 'px'; d.appendChild(m);
      setTimeout(() => m.remove(), 1800);
    }
    return target;
  }
  scrollTo(page, frac = 0) {
    const d = this.pages[Math.max(0, Math.min(this.pages.length - 1, page - 1))]; if (!d) return;
    this.scroller.scrollTop = this.el.offsetTop + d.offsetTop + frac * (d.offsetHeight + 10) - (frac ? 0 : 6);
  }
  setZoom(z, anchorClient) {
    z = Math.max(1, Math.min(4, z));
    if (Math.abs(z - this.zoom) < 0.01) return;
    const sr = this.scroller.getBoundingClientRect();
    const ax = anchorClient ? anchorClient.x - sr.left : sr.width / 2, ay = anchorClient ? anchorClient.y - sr.top : sr.height / 2;
    const cx = (this.el.scrollLeft + ax) / this.zoom, cy = (this.scroller.scrollTop - this.el.offsetTop + ay) / this.zoom;
    this.zoom = z; this.layout();
    for (const [n] of this.rendered) this.rendered.set(n, 'stale');
    this.el.scrollLeft = cx * z - ax; this.scroller.scrollTop = this.el.offsetTop + cy * z - ay;
    this.pages.forEach((d, i) => { const r = d.getBoundingClientRect(); if (r.bottom > sr.top - 600 && r.top < sr.bottom + 600) this.render(i + 1); });
    this.opts.onZoom && this.opts.onZoom(z);
  }
  bindPinch() {
    let d0 = 0, mid = null, f = 1;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.el.addEventListener('touchstart', e => {
      if (e.touches.length === 2) { d0 = dist(e.touches); f = 1; mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
        const r = this.inner.getBoundingClientRect(); this.inner.style.transformOrigin = `${mid.x - r.left}px ${mid.y - r.top}px`; }
    }, { passive: true });
    this.el.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && d0) { e.preventDefault(); f = dist(e.touches) / d0; const nz = Math.max(1, Math.min(4, this.zoom * f)); f = nz / this.zoom; this.inner.style.transform = `scale(${f})`; }
    }, { passive: false });
    const end = () => { if (!d0) return; this.inner.style.transform = ''; const z = this.zoom * f; d0 = 0; if (Math.abs(f - 1) > 0.03) this.setZoom(z, mid); };
    this.el.addEventListener('touchend', e => { if (e.touches.length < 2) end(); });
    this.el.addEventListener('touchcancel', end);
    // 双击：在 1x 与 2x 之间切换
    let lastTap = 0;
    this.el.addEventListener('touchend', e => {
      if (e.changedTouches.length !== 1 || e.touches.length) return;
      const now = Date.now(); const t = e.changedTouches[0];
      if (now - lastTap < 280 && getSelection().isCollapsed) { this.setZoom(this.zoom > 1.2 ? 1 : 2, { x: t.clientX, y: t.clientY }); lastTap = 0; } else lastTap = now;
    });
  }
  destroy() {
    this.destroyed = true; this.io && this.io.disconnect(); window.removeEventListener('resize', this._ro);
    this.pages.forEach(d => { const c = d.querySelector('canvas'); if (c) { c.width = c.height = 0; } });
    this.el.remove();
  }
}

/* 选区 → 页面归一化矩形 */
export function selectionToPdf(range) {
  const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
  const endEl = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement);
  const pa = startEl?.closest('.pdf-page'), pb = endEl?.closest('.pdf-page');
  if (!pa || pa !== pb || !startEl.closest('.textLayer')) return null;
  const pr = pa.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 2 && r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top)
    .map(r => [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]);
  if (!rects.length) return null;
  // 合并同一行的矩形
  rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const merged = [];
  for (const r of rects) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m[1] - r[1]) < m[3] * 0.5 && r[0] <= m[0] + m[2] + 0.02) { const x1 = Math.max(m[0] + m[2], r[0] + r[2]); const y1 = Math.max(m[1] + m[3], r[1] + r[3]); m[1] = Math.min(m[1], r[1]); m[2] = x1 - m[0]; m[3] = y1 - m[1]; }
    else merged.push([...r]);
  }
  return { page: +pa.dataset.page, rects: merged.map(r => r.map(v => Math.round(v * 10000) / 10000)), text: range.toString().replace(/\s+/g, ' ').trim() };
}
