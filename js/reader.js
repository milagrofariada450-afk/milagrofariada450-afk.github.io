// 阅读器：重排 / 原版、翻译、AI 速读、划线笔记、阅读位置
import * as db from './db.js';
import * as ai from './ai.js';
import { extractReflow, REFLOW_VERSION } from './reflow.js';
import { loadPdf, renderCrop, PdfView, selectionToPdf, closePdf } from './pdfview.js';
import { ic, $, esc, phone, CN, COLORS, toast, ago, uid, ST, saveST, applyTheme, effTheme, openSheet, redrawSheet, closeSheet, sheetOpen, download, copyText, safeName } from './util.js';
import { LIB, savePaper, renderTab, switchTab, openPaperSheet } from './app.js';

let R = null; // 当前阅读会话
const body = $('#r-body');
export const isReading = id => !!(R && (!id || R.p.id === id));

function fresh(p) {
  return { p, token: Symbol(), pdf: null, rf: null, blocks: [], bmap: {}, secOf: {}, hls: [], mode: 'reflow', tapOpen: new Set(), tcache: {}, terr: {}, tpending: new Set(), tq: [], tactive: 0,
    aiTab: 'sum', aiLoading: false, aiErr: '', pv: null, ios: [], abort: new AbortController(), saveT: 0, words: 0, ready: false };
}

/* ---------- 打开 / 关闭 ---------- */
export async function openReader(id, opts = {}) {
  if (R) await closeReader(true);
  const p = LIB.papers.find(x => x.id === id); if (!p) return;
  R = fresh(p); const tok = R.token;
  R.mode = p.lastMode || ST.defMode;
  $('#r-t').textContent = p.title; $('#r-s').textContent = '正在打开…'; $('#r-bar').style.width = '0';
  $('#v-reader').classList.add('open'); applyTheme();
  syncHeader(); renderToolbar();
  body.innerHTML = loadingHTML('正在打开 PDF…');
  try {
    const f = await db.get('files', id);
    if (!f) throw new Error('本机找不到这篇论文的 PDF 文件');
    R.pdf = await loadPdf(f.data);
    if (tok !== R?.token) return;
    R.hls = await db.byPaper(id);
    let rf = await db.get('reflow', id);
    if (!rf || rf.version !== REFLOW_VERSION || !rf.blocks) {
      body.innerHTML = loadingHTML('正在生成重排版本…', true);
      rf = { id, ...(await extractReflow(R.pdf, f => { const b = body.querySelector('.loading-block .bar i'); if (b) b.style.width = Math.round(f * 100) + '%'; })) };
      if (tok !== R?.token) return;
      await db.put('reflow', rf).catch(() => {});
    }
    R.rf = rf; indexBlocks(); await reanchor();
    R.ready = true;
    if (!p.numPages) p.numPages = R.pdf.numPages;
    p.openedAt = Date.now(); savePaper(p);
    await renderMode(true);
    loadOutline().catch(() => {});
    if (opts.jump) setTimeout(() => jumpTo(opts.jump), 120);
  } catch (e) {
    console.error(e);
    if (tok === R?.token) body.innerHTML = `<div class="loading-block">${ic('info')}<div>打开失败：${esc(e.message || e)}</div><button class="btn ghost" data-close>返回书架</button></div>`;
  }
}
export async function closeReader(silent) {
  if (!R) return;
  const r = R;
  if (r.ready) savePos(true);
  r.abort.abort(); r.tq = [];
  r.ios.forEach(o => o.disconnect());
  r.pv && r.pv.destroy();
  R = null;
  hideSel();
  if (!silent) { closeSheet(); $('#v-reader').classList.remove('open'); applyTheme(); $('#pdf-float') && ($('#pdf-float').style.display = 'none'); }
  setTimeout(() => { if (!R) body.innerHTML = ''; closePdf(r.pdf); }, silent ? 0 : 350);
  if (!silent) renderTab();
}
$('#r-back').innerHTML = ic('back'); $('#r-more').innerHTML = ic('more');
$('#r-back').onclick = () => closeReader();
function loadingHTML(msg, bar) { return `<div class="loading-block"><span class="spinner"></span><div>${esc(msg)}</div>${bar ? '<div class="bar"><i></i></div>' : ''}</div>`; }

function indexBlocks() {
  R.blocks = R.rf.blocks; R.bmap = {}; R.secOf = {}; let sec = ''; let w = 0;
  R.blocks.forEach((b, i) => {
    b.idx = i; R.bmap[b.id] = b;
    if (b.type === 'h2' || b.type === 'h3') sec = b.text;
    R.secOf[b.id] = sec;
    if (b.type === 'p') w += b.text.split(/\s+/).length;
  });
  R.words = w;
}
async function reanchor() {
  for (const h of R.hls) {
    if (h.mode !== 'reflow') continue;
    const b = R.bmap[h.bid];
    if (b && b.text.slice(h.start, h.end) === h.text) continue;
    let nb = null, s = -1;
    if (b) { s = b.text.indexOf(h.text); if (s >= 0) nb = b; }
    if (!nb) for (const x of R.blocks) { if (x.text && (s = x.text.indexOf(h.text)) >= 0) { nb = x; break; } }
    if (nb) { h.bid = nb.id; h.start = s; h.end = s + h.text.length; h.page = nb.page; await db.put('highlights', h); }
    else h.orphan = true;
  }
}

/* ---------- 头部 / 工具栏 ---------- */
function syncHeader() {
  document.querySelectorAll('#r-mode button').forEach(b => b.classList.toggle('on', b.dataset.m === R.mode));
  const t = ST.trans;
  $('#r-trans').classList.toggle('show', R.mode === 'reflow' && (R.transOpen || t !== 'off'));
  document.querySelectorAll('#trans-seg button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  body.dataset.trans = R.mode === 'reflow' ? t : 'off';
  let fl = $('#pdf-float');
  if (!fl) { fl = document.createElement('div'); fl.id = 'pdf-float'; fl.className = 'pdf-float'; $('#v-reader').appendChild(fl); }
  fl.style.display = R.mode === 'pdf' ? 'flex' : 'none';
  if (R.mode === 'pdf') fl.innerHTML = `<button data-z="-" aria-label="缩小">−</button><span id="pgno">第 1 / ${R.pdf ? R.pdf.numPages : '?'} 页 · ${Math.round((R.pv?.zoom || 1) * 100)}%</span><button data-z="+" aria-label="放大">+</button>`;
}
function renderToolbar() {
  const n = R ? R.hls.length : 0; const dark = effTheme() === 'dark';
  $('#r-toolbar').innerHTML = `
   <button data-tb="toc">${ic('toc')}<span>目录</span></button>
   <button data-tb="trans" class="${R && (R.transOpen || ST.trans !== 'off') ? 'on' : ''}">${ic('trans')}<span>翻译</span></button>
   <button data-tb="notes">${ic('note')}<span>笔记${n ? ' ' + n : ''}</span></button>
   <button data-tb="aa"><span class="aa">Aa</span><span>显示</span></button>
   <button data-tb="night">${ic(dark ? 'sun' : 'moon')}<span>${dark ? '日间' : '夜间'}</span></button>`;
}
export function onReaderThemeChange() { if (R) renderToolbar(); }
$('#r-toolbar').onclick = e => {
  const b = e.target.closest('[data-tb]'); if (!b || !R || !R.ready) return; const k = b.dataset.tb;
  if (k === 'toc') openToc();
  if (k === 'trans') { R.transOpen = !(R.transOpen || ST.trans !== 'off'); if (!R.transOpen && ST.trans !== 'off') setTrans('off'); if (R.transOpen && R.mode === 'pdf') setMode('reflow'); else syncHeader(); renderToolbar(); }
  if (k === 'notes') openNotesPanel();
  if (k === 'aa') openAa();
  if (k === 'night') { ST.theme = effTheme() === 'dark' ? 'light' : 'dark'; saveST(); applyTheme(); renderToolbar(); }
};
$('#r-mode').onclick = e => { const b = e.target.closest('[data-m]'); if (b && R && R.ready && b.dataset.m !== R.mode) setMode(b.dataset.m); };
$('#trans-seg').onclick = e => { const b = e.target.closest('[data-t]'); if (b && R) setTrans(b.dataset.t); };

/* ---------- 模式切换与位置 ---------- */
// 当前阅读位置对应的重排块（视口顶部向下 offset 像素处）
function blockAtView(offset = 60) {
  if (!R) return null;
  if (R.mode === 'pdf' && R.pv) {
    const loc = R.pv.positionPt(offset);
    const onPage = R.blocks.filter(b => b.page === loc.page && b.y != null && b.type !== 'title');
    return onPage.find(b => b.y >= loc.y - 4) || R.blocks.find(b => b.page > loc.page) || onPage[onPage.length - 1] || null;
  }
  const els = R.els && R.els.length && R.els[0].isConnected ? R.els : (R.els = [...body.querySelectorAll('.blk[data-bid]')]);
  const st = body.scrollTop + offset;
  let lo = 0, hi = els.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (els[mid].offsetTop + els[mid].offsetHeight > st) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  const el = els[ans]; return el ? R.bmap[el.dataset.bid] || null : null;
}
async function setMode(m, target) {
  // 切换模式时保持当前章节：记下当前目录项，切换后在新模式中"钉住"同名条目
  const auto = !target;
  let prevCur = null; try { prevCur = auto && R.ready ? currentTocItem(tocItems(R.mode)) : null; } catch (e) {}
  if (!target) {
    const b = blockAtView(16);
    if (R.mode === 'reflow' && m === 'pdf' && b) target = b.y != null ? { page: b.page, y: b.y } : { page: b.page, frac: 0 };
    if (R.mode === 'pdf' && m === 'reflow' && b) target = { bid: b.id };
  }
  savePos(true);
  R.mode = m; R.p.lastMode = m; hideSel();
  const r = R;
  await renderMode(false, target);
  if (prevCur && R === r && R.mode === m) {
    const list = tocItems(m);
    const it = list.find(x => x.title === prevCur.title && x.page === prevCur.page) || list.find(x => x.title === prevCur.title);
    if (it) { R.pin = { it, mode: m, st: body.scrollTop }; updateProgress(); }
  }
}
async function renderMode(restore, target) {
  R.ios.forEach(o => o.disconnect()); R.ios = [];
  if (R.pv) { R.pv.destroy(); R.pv = null; }
  syncHeader(); renderToolbar();
  const pos = target || (restore ? (R.p.pos || {})[R.mode] : null);
  if (R.mode === 'reflow') {
    body.innerHTML = reflowHTML(); R.els = null;
    setupReflowObservers();
    if (pos && pos.bid) { const el = body.querySelector(`.blk[data-bid="${pos.bid}"]`); if (el) body.scrollTop = el.offsetTop - 12 + (pos.off || 0); else body.scrollTop = 0; }
    else body.scrollTop = 0;
  } else {
    const pv = new PdfView(body, R.pdf, { getHighlights: () => R.hls, onZoom: () => updateProgress() });
    R.pv = pv;
    await pv.mount(R.rf && R.rf.pages);
    if (R.pv !== pv) return;
    if (pos && pos.page && pos.y != null) pv.scrollToPt(pos.page, pos.y, 12, pos.x ?? null, !!pos.mark);
    else if (pos && pos.page) pv.scrollTo(pos.page, pos.frac || 0); else body.scrollTop = 0;
  }
  updateProgress();
}
function currentPos() {
  if (!R) return {};
  if (R.mode === 'pdf' && R.pv) return R.pv.position();
  const b = blockAtView(4); if (!b) return {};
  const el = body.querySelector(`.blk[data-bid="${b.id}"]`);
  return { bid: b.id, off: el ? Math.max(0, body.scrollTop - el.offsetTop + 12) : 0 };
}
function pct() {
  if (R.mode === 'pdf' && R.pv) { const p = R.pv.position(); return Math.min(100, ((p.page - 1 + p.frac) / R.pdf.numPages) * 100); }
  const max = body.scrollHeight - body.clientHeight; return max > 0 ? Math.min(100, body.scrollTop / max * 100) : 0;
}
function updateProgress() {
  if (!R || !R.ready) return;
  const v = pct(); $('#r-bar').style.width = v + '%';
  const sec = currentTocItem(tocItems(R.mode));
  const secTxt = sec ? `${sec.num ? sec.num + ' ' : ''}${sec.title}` : '';
  let txt;
  if (R.mode === 'pdf' && R.pv) {
    const pg = R.pv.position().page;
    txt = `原版 · 第 ${pg}/${R.pdf.numPages} 页${secTxt ? ' · ' + secTxt : ''}`;
    const pn = $('#pgno'); if (pn) pn.textContent = `第 ${pg} / ${R.pdf.numPages} 页 · ${Math.round(R.pv.zoom * 100)}%`;
  } else {
    const left = Math.max(1, Math.round(R.words / 200 * (1 - v / 100)));
    txt = `已读 ${Math.round(v)}% · ${secTxt || '剩约 ' + left + ' 分钟'}`;
  }
  const s = $('#r-s');
  if (s._t !== txt) { s._t = txt; s.innerHTML = `<span class="s-txt">${esc(txt)}</span>${ic('down', 'xs')}`; }
}
function savePos(now) {
  if (!R || !R.ready) return;
  clearTimeout(R.saveT);
  const go = () => {
    if (!R) return;
    const p = R.p; const pos = currentPos();
    p.pos = { ...(p.pos || {}), [R.mode]: pos }; p.lastMode = R.mode;
    const v = pct(); p.progress = Math.round(Math.max(p.progress || 0, v >= 97 ? 100 : v));
    const bid = R.mode === 'reflow' ? pos.bid : (R.blocks.find(b => b.page >= pos.page) || {}).id;
    p.posLabel = (R.secOf[bid] || '').slice(0, 40); p.openedAt = Date.now();
    savePaper(p);
  };
  if (now) go(); else R.saveT = setTimeout(go, 700);
}
let rafP = 0;
body.addEventListener('scroll', () => {
  if (!R) return;
  if (!rafP) rafP = requestAnimationFrame(() => { rafP = 0; updateProgress(); });
  if (selbar.classList.contains('show') && getSelection().isCollapsed) hideSel();
  savePos();
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePos(true); });
addEventListener('pagehide', () => savePos(true));
document.addEventListener('click', e => {
  const z = e.target.closest('#pdf-float [data-z]');
  if (z && R && R.pv) { const steps = [1, 1.25, 1.5, 2, 2.5, 3, 4]; const zz = R.pv.zoom; const n = z.dataset.z === '+' ? steps.find(s => s > zz + 0.01) || 4 : [...steps].reverse().find(s => s < zz - 0.01) || 1; R.pv.setZoom(n); updateProgress(); }
});

/* ---------- 重排渲染 ---------- */
const TRANS_TYPES = new Set(['p', 'caption']);
function hlHTML(b) {
  const text = b.text; const hs = R.hls.filter(h => h.mode === 'reflow' && h.bid === b.id && !h.orphan).sort((a, c) => a.start - c.start);
  let out = '', pos = 0;
  for (const h of hs) { if (h.start < pos) continue; out += esc(text.slice(pos, h.start)); out += `<mark class="hl hl-${h.color}${h.note ? ' has-note' : ''}" data-hid="${h.id}">${esc(text.slice(h.start, h.end))}</mark>`; pos = h.end; }
  return out + esc(text.slice(pos));
}
const wantsZh = bid => ST.trans === 'bi' || ST.trans === 'zh' || (ST.trans === 'tap' && R.tapOpen.has(bid));
function zhHTML(bid) {
  if (!wantsZh(bid)) return '';
  if (R.tcache[bid] != null) return `<p class="zh">${esc(R.tcache[bid])}</p>`;
  if (R.terr[bid]) return `<p class="zh err">翻译失败：${esc(R.terr[bid])} <button data-retry="${bid}">重试</button></p>`;
  return `<p class="zh loading"><span class="spinner"></span>翻译中…</p>`;
}
function paraHTML(b) {
  if (!TRANS_TYPES.has(b.type)) return `<div class="blk blk-${b.type}" data-bid="${b.id}"><p class="en" data-bid="${b.id}">${hlHTML(b)}</p></div>`;
  return `<div class="para blk${b.type === 'p' ? '' : ' blk-' + b.type}" data-bid="${b.id}"><p class="en" data-bid="${b.id}">${hlHTML(b)}</p>${zhHTML(b.id)}</div>`;
}
function headHTML(b) {
  const zh = (ST.trans === 'bi' || ST.trans === 'zh') ? `<small class="hzh" data-hz="${b.id}">${esc(R.tcache[b.id] || '')}</small>` : '';
  const cjk = /[\u4e00-\u9fff]/.test(b.text) ? ' cjk' : '';
  return `<${b.type} class="blk${cjk}" id="${b.id}" data-bid="${b.id}" data-head="1">${esc(b.text)}${zh}</${b.type}>`;
}
function cropHTML(b) {
  const isEq = b.type === 'eq';
  const bw = Math.max(1, b.bbox[2] - b.bbox[0]), bh = Math.max(1, b.bbox[3] - b.bbox[1]);
  // 预先按裁剪区域比例占位，懒加载图片时版面不跳动，目录跳转才准确
  const sz = isEq ? `width:min(100%,${Math.round(bw * ST.fs * 0.95 / (R.rf.body || 10))}px);aspect-ratio:${bw}/${bh};min-height:0` : `aspect-ratio:${bw}/${bh};min-height:0`;
  return `<div class="crop ${isEq ? 'eq' : 'fig'} blk" data-bid="${b.id}" data-crop="${b.id}"><div class="cbox" style="${sz}"><div class="ph">${isEq ? '' : `${b.table ? '表格' : '图'} · 第 ${b.page} 页`}</div></div>${isEq ? '' : `<span class="pg" data-page="${b.page}" data-y="${b.bbox[1]}">查看原页 ›</span>`}</div>`;
}
function blockHTML(b) {
  switch (b.type) {
    case 'title': return '';
    case 'front': return `<div class="blk-front blk" data-bid="${b.id}" data-front>${esc(b.text)}</div>`;
    case 'h2': case 'h3': return headHTML(b);
    case 'figure': case 'eq': return b.bbox ? cropHTML(b) : '';
    default: return b.text ? paraHTML(b) : '';
  }
}
function reflowHTML() {
  const p = R.p; const bi = ST.trans === 'bi' || ST.trans === 'zh';
  const tb = R.blocks.find(b => b.type === 'title');
  return `<article class="article ${ST.font === 'sans' ? 'sans' : ''}" id="article" style="--rfs:${ST.fs}px;--rlh:${ST.lh}">
   <h1 class="a-title blk" data-bid="${tb ? tb.id : '_top'}">${esc(p.title)}</h1>
   ${bi ? `<div class="a-title-zh" data-hz="_title">${esc(R.tcache._title || '')}</div>` : ''}
   ${p.authors ? `<div class="a-auth">${esc(p.authors)}</div>` : ''}
   <div class="a-meta">${[p.venue, p.year, R.pdf.numPages + ' 页', p.arxivId ? 'arXiv:' + p.arxivId : ''].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
   ${aiHTML()}
   ${ST.hideReflowNote ? '' : `<div class="reflow-note">${ic('info', 'xs')}<span style="flex:1">重排由算法从 PDF 自动生成，公式与图表以原图显示。遇到错乱可切换「原版」。</span><button data-hidenote>知道了</button></div>`}
   <div class="tap-hint">${ic('trans', 'xs')} 点按任意段落查看译文；长按选中文字可划线</div>
   ${R.blocks.map(blockHTML).join('')}
   <div class="foot" style="padding-top:30px">— 全文完 · 共 ${R.pdf.numPages} 页 —</div>
  </article>`;
}
function setupReflowObservers() {
  const cropIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { cropIO.unobserve(e.target); drawCrop(e.target); } }), { root: body, rootMargin: '700px 0px' });
  body.querySelectorAll('[data-crop]').forEach(el => cropIO.observe(el));
  R.ios.push(cropIO);
  if (ST.trans === 'bi' || ST.trans === 'zh') {
    if (!ai.hasAI()) return;
    const tIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { tIO.unobserve(e.target); requestTrans(e.target.dataset.bid); } }), { root: body, rootMargin: '400px 0px' });
    body.querySelectorAll('.para[data-bid], [data-head]').forEach(el => tIO.observe(el));
    R.ios.push(tIO);
    requestTrans('_title');
  }
}
async function drawCrop(el) {
  const b = R.bmap[el.dataset.crop]; if (!b) return;
  const box = el.querySelector('.cbox'); const tok = R.token;
  const c = document.createElement('canvas');
  const bw = b.bbox[2] - b.bbox[0];
  let cssW = box.clientWidth || body.clientWidth - 30;
  try {
    await renderCrop(R.pdf, b.page, b.bbox, cssW, c);
    if (!R || R.token !== tok) return;
    box.innerHTML = ''; box.appendChild(c);
  } catch (e) { if (R && R.token === tok) box.querySelector('.ph') && (box.querySelector('.ph').textContent = '无法渲染该区域'); }
}

/* ---------- 翻译 ---------- */
function setTrans(t) {
  if (t !== 'off' && !ai.hasAI()) { needAI('段落翻译'); return; }
  ST.trans = t; saveST(); R.tapOpen.clear();
  if (R.mode !== 'reflow') { syncHeader(); return; }
  const pos = currentPos();
  syncHeader(); renderToolbar();
  R.ios.forEach(o => o.disconnect()); R.ios = [];
  body.innerHTML = reflowHTML(); setupReflowObservers();
  const el = pos.bid && body.querySelector(`.blk[data-bid="${pos.bid}"]`); if (el) body.scrollTop = el.offsetTop - 8;
  updateProgress();
}
function needAI(what) {
  openSheet(`<h3>需要先配置 AI 接口</h3><div class="help" style="font-size:14px;color:var(--text2);line-height:1.8;margin-top:0">${esc(what)}使用你自己的 OpenAI 兼容接口（如 DeepSeek、OpenAI、硅基流动、本地 Ollama 等）。<br>在「我的 → AI 翻译与速读」中填写接口地址、API Key 和模型名即可，密钥只保存在本机。</div>
    <div class="sheet-actions"><span class="grow"></span><button class="btn ghost" data-no>以后再说</button><button class="btn" data-go>去设置</button></div>`, sh => {
    sh.onclick = async e => { if (e.target.closest('[data-no]')) closeSheet(); if (e.target.closest('[data-go]')) { closeSheet(); await closeReader(); switchTab('me'); setTimeout(() => { const f = $('#aiForm'); f && f.scrollIntoView({ block: 'start' }); }, 120); } };
  });
}
function textOf(bid) { return bid === '_title' ? R.p.title : (R.bmap[bid] || {}).text || ''; }
function requestTrans(bid) {
  if (!R || !bid || R.tcache[bid] != null || R.tpending.has(bid)) return;
  R.tpending.add(bid); delete R.terr[bid]; R.tq.push(bid); pumpTrans();
}
function pumpTrans() {
  const r = R;
  while (r && r.tactive < 2 && r.tq.length) {
    const bid = r.tq.shift(); r.tactive++;
    ai.translate(textOf(bid), { signal: r.abort.signal })
      .then(t => { r.tcache[bid] = t; })
      .catch(e => { if (e.name !== 'AbortError') r.terr[bid] = e.message === 'NO_CONFIG' ? '未配置 AI 接口' : (e.message || String(e)); })
      .finally(() => { r.tactive--; r.tpending.delete(bid); if (R === r) { updateZh(bid); pumpTrans(); } });
  }
}
function updateZh(bid) {
  const hz = body.querySelector(`[data-hz="${bid}"]`);
  if (hz) { hz.textContent = R.tcache[bid] || ''; return; }
  const para = body.querySelector(`.para[data-bid="${bid}"]`); if (!para) return;
  const old = para.querySelector('.zh'); const html = zhHTML(bid);
  if (old) old.outerHTML = html || ''; else if (html) para.insertAdjacentHTML('beforeend', html);
  if (R.terr[bid] && ST.trans !== 'tap' && Object.keys(R.terr).length === 1) toast('翻译失败：' + R.terr[bid], 3500);
}

/* ---------- AI 速读 ---------- */
function aiHTML() {
  const s = R.p.summary; const col = ST.aiCollapsed;
  let inner;
  if (!ai.hasAI()) inner = `<div class="ai-empty">配置 AI 接口后，可一键生成本文的摘要、方法与结论要点。<br><button class="btn" data-ai="config">去配置</button></div>`;
  else if (R.aiLoading) inner = `<div class="ai-loading"><span class="spinner"></span>正在阅读论文并生成速读…</div>`;
  else if (R.aiErr) inner = `<div class="ai-empty"><span class="status-err">生成失败：${esc(R.aiErr)}</span><br><button class="btn" data-ai="gen">重试</button></div>`;
  else if (!s) inner = `<div class="ai-empty">使用 ${esc(ai.getCfg().model)} 根据摘要、引言与结论生成要点（会消耗少量 tokens）。<br><button class="btn" data-ai="gen">${ic('spark', 'xs')} 生成速读</button></div>`;
  else {
    const li = a => `<ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    const c = R.aiTab === 'method' ? li(s.method) : R.aiTab === 'concl' ? li(s.conclusion) : `${esc(s.summary)}${s.keywords.length ? `<div class="kw">${s.keywords.map(k => `<span>${esc(k)}</span>`).join('')}</div>` : ''}`;
    inner = `<div class="ai-tabs">${[['sum', '摘要'], ['method', '方法'], ['concl', '结论']].map(([k, l]) => `<button data-ai="${k}" class="${R.aiTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="ai-content">${c}<div style="font-size:11px;color:var(--rtext2);margin-top:8px">${esc(s.model)} · ${ago(s.ts)} · <button data-ai="gen" style="color:var(--accent);font-size:11px">重新生成</button></div></div>`;
  }
  return `<div class="ai-card ${col ? 'collapsed' : ''}" id="ai"><div class="ai-head" data-ai="toggle"><span class="ai-badge">${ic('spark', 'xs')} AI 速读</span><span class="ai-note">AI 生成，仅供参考，请以原文为准</span><span class="chev">${ic('down', 'sm')}</span></div>${col ? '' : inner}</div>`;
}
const redrawAI = () => { const el = $('#ai'); if (el) el.outerHTML = aiHTML(); };
async function genSummary() {
  const r = R; r.aiLoading = true; r.aiErr = ''; redrawAI();
  try { const s = await ai.summarize(r.p, r.blocks); r.p.summary = s; await savePaper(r.p); }
  catch (e) { r.aiErr = e.message === 'NO_CONFIG' ? '未配置 AI 接口' : (e.message || String(e)); }
  r.aiLoading = false; if (R === r) redrawAI();
}

/* ---------- 正文点击 ---------- */
body.addEventListener('click', e => {
  if (!R) return;
  if (e.target.closest('[data-close]')) return closeReader();
  const a = e.target.closest('[data-ai]');
  if (a) { const k = a.dataset.ai;
    if (k === 'toggle') { ST.aiCollapsed = !ST.aiCollapsed; saveST(); redrawAI(); }
    else if (k === 'config') needAI('AI 速读');
    else if (k === 'gen') genSummary();
    else { R.aiTab = k; redrawAI(); }
    return; }
  if (e.target.closest('[data-hidenote]')) { ST.hideReflowNote = true; saveST(); e.target.closest('.reflow-note').remove(); return; }
  const pg = e.target.closest('.pg[data-page]'); if (pg) { setMode('pdf', { page: +pg.dataset.page, y: +pg.dataset.y || 0, mark: true }); return; }
  const rt = e.target.closest('[data-retry]'); if (rt) { requestTrans(rt.dataset.retry); updateZh(rt.dataset.retry); return; }
  const fr = e.target.closest('[data-front]'); if (fr) { fr.classList.toggle('open'); return; }
  const m = e.target.closest('mark.hl'); if (m && getSelection().isCollapsed) { openHlSheet(m.dataset.hid); return; }
  const hd = e.target.closest('.hl-layer [data-hid]'); if (hd) { openHlSheet(hd.dataset.hid); return; }
  const en = e.target.closest('.para p.en');
  if (en && ST.trans === 'tap' && getSelection().isCollapsed) {
    const bid = en.dataset.bid; if (R.tapOpen.has(bid)) R.tapOpen.delete(bid); else { R.tapOpen.add(bid); requestTrans(bid); }
    updateZh(bid);
  }
});

/* ---------- 目录 / 显示 / 更多 ---------- */
/* ---------- 目录 ---------- */
const CJK_SP = /([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g;
const NUM_RE = /^(第\s*[0-9一二三四五六七八九十百]{1,4}\s*[章节篇部]|(?:\d{1,2}(?:\.\d{1,2}){0,3})\.?|[A-H](?:\.\d{1,2}){1,3}|[IVX]{1,6}\.|[A-H]\.|[一二三四五六七八九十]{1,3}[、.．]|(?:Appendix|附录)\s*[A-Z0-9]{1,2}[.:：]?)(?:\s+|(?=[\u4e00-\u9fff]))(\S.*)$/;
function splitNum(t) {
  t = t.replace(/\s+/g, ' ').trim().replace(CJK_SP, '$1');
  const m = t.match(NUM_RE);
  if (!m) return ['', t];
  let n = m[1].replace(/[.、．:：]$/, '');
  n = /^Appendix/i.test(n) ? n.replace(/\s+/g, ' ') : n.replace(/\s+/g, '').replace(/^附录(?=[A-Z0-9])/, '附录 ');
  return [n, m[2]];
}
function levelOf(num, type) {
  if (/^第.*[章篇部]$/.test(num)) return 1;
  if (/^第.*节$/.test(num)) return 2;
  if (/^\d/.test(num)) return Math.min(3, num.split('.').length);
  if (/^[A-H]\.\d/.test(num)) return Math.min(3, num.split('.').length);
  if (/^[IVX]+$/.test(num) || /^[一二三四五六七八九十]+$/.test(num) || /^(Appendix|附录)/.test(num)) return 1;
  if (/^[A-H]$/.test(num)) return 2;
  return type === 'h3' ? 2 : 1;
}
// 重排识别的章节标题（带页码与页内 y 坐标）
function headingItems() {
  if (R._heads) return R._heads;
  const out = [];
  for (const b of R.blocks) {
    if ((b.type !== 'h2' && b.type !== 'h3') || !b.text || b.text.length > 140) continue;
    const [num, title] = splitNum(b.text);
    out.push({ num, title, level: levelOf(num, b.type), page: b.page, y: b.y, bid: b.id, src: 'auto' });
  }
  return (R._heads = out);
}
// PDF 自带书签（outline）
async function loadOutline() {
  if (R.outline !== undefined) return R.outline;
  const r = R; let ol = null;
  try { ol = await r.pdf.getOutline(); } catch (e) {}
  if (ol && ol.length === 1 && ol[0].items && ol[0].items.length >= 2) ol = ol[0].items; // 去掉以论文标题为根的一层
  const out = [];
  const walk = async (items, lvl) => {
    for (const o of items) {
      if (out.length > 400) return;
      const d = await resolveDest(r.pdf, o.dest);
      let [num, title] = splitNum(o.title || '');
      if (!num) { const m = (o.title || '').trim().match(/^([IVX]{1,6}|[A-H])\s+([A-Z\u4e00-\u9fff].*)$/); if (m) { num = m[1]; title = m[2]; } }
      if (d && title) out.push({ num, title, level: lvl, page: d.page, y: d.y, x: d.x, src: 'outline' });
      if (o.items && o.items.length) await walk(o.items, Math.min(3, lvl + 1));
    }
  };
  if (ol && ol.length) await walk(ol, 1);
  r.outline = out.length >= 2 ? out : null;
  if (R === r) { R._toc = null; updateProgress(); }
  return r.outline;
}
async function resolveDest(pdf, dest) {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    const idx = ref && typeof ref === 'object' ? await pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
    if (idx == null) return null;
    const page = await pdf.getPage(idx + 1); const vp = page.getViewport({ scale: 1 });
    const kind = d[1] && d[1].name; let left = null, top = null;
    if (kind === 'XYZ') { left = d[2]; top = d[3]; } else if (kind === 'FitH' || kind === 'FitBH') top = d[2]; else if (kind === 'FitR') { left = d[2]; top = d[5]; }
    let x = null, y = null;
    if (top != null) { const pt = vp.convertToViewportPoint(left || 0, top); y = Math.max(0, Math.min(vp.height, pt[1])); if (left != null) x = Math.max(0, pt[0]); }
    return { page: idx + 1, y, x };
  } catch (e) { return null; }
}
// 把（页, y）映射到重排块
function blockAt(page, y) {
  const onPage = R.blocks.filter(b => b.page === page && b.y != null && b.type !== 'title');
  if (y != null) { const b = onPage.find(b => b.y >= y - 6 && /^(h2|h3|p|caption|figure|eq|ref|small)$/.test(b.type)); if (b) return b; }
  return onPage[0] || R.blocks.find(b => b.page >= page) || null;
}
// 书签条目 → 重排块：优先匹配同页（或相邻页）标题文字相同的标题块，否则按坐标取块
const normT = t => (t || '').toLowerCase().replace(/[\s.．、:：·]/g, '');
function outlineBid(o) {
  const key = normT(o.title).slice(0, 10);
  if (key.length >= 2) {
    const hs = R.blocks.filter(b => (b.type === 'h2' || b.type === 'h3') && Math.abs(b.page - o.page) <= 1 && b.text);
    const hit = hs.find(b => b.page === o.page && normT(splitNum(b.text)[1]).startsWith(key)) || hs.find(b => normT(splitNum(b.text)[1]).startsWith(key));
    if (hit) return hit.id;
    // 标题未被识别为标题块时，找同页以该标题开头的短段落
    const pb = R.blocks.find(b => b.page === o.page && b.text && b.text.length < 160 && (normT(b.text).startsWith(key) || normT(splitNum(b.text)[1]).startsWith(key)));
    if (pb) return pb.id;
  }
  return (blockAt(o.page, o.y) || {}).id;
}
// 每种模式使用的目录项
function tocItems(mode) {
  R._toc = R._toc || {};
  if (R._toc[mode]) return R._toc[mode];
  const heads = headingItems(); const ol = R.outline;
  let items;
  if (!ol) items = heads;
  else {
    // 书签：映射到重排块；书签标题没有编号时，借用正文标题里的编号（如"绪论" → "1 绪论"）
    items = ol.map(o => {
      const bid = outlineBid(o), it = { ...o, bid };
      const hb = !o.num && bid && R.bmap[bid];
      if (hb && /^h[23]$/.test(hb.type)) { const [n, t] = splitNum(hb.text); if (n && normT(t).startsWith(normT(o.title).slice(0, 6))) it.num = n; }
      return it;
    });
  }
  return (R._toc[mode] = items);
}
function currentTocItem(items) {
  if (!items || !items.length) return null;
  // 刚从目录跳转过来、尚未滚动时，以所选条目为当前章节（避免紧随其后的小节抢占）
  const pin = R.pin; if (pin && pin.mode === R.mode && Math.abs(body.scrollTop - pin.st) < 8 && items.includes(pin.it)) return pin.it;
  let cur = null;
  // 两种模式都按阅读顺序判断（双栏 PDF 也准确，且切换模式时章节一致）
  if (items.some(it => it.bid)) {
    const b = blockAtView(24); if (!b) return null;
    for (const it of items) { const hb = it.bid && R.bmap[it.bid]; if (hb && hb.idx <= b.idx) cur = it; }
    return cur;
  }
  if (R.mode === 'reflow') {
    const b = blockAtView(24); if (!b) return null;
    for (const it of items) { const hb = it.bid && R.bmap[it.bid]; if (hb && hb.idx <= b.idx) cur = it; }
  } else if (R.pv) {
    const p = R.pv.positionPt(24);
    for (const it of items) { if (it.page < p.page || (it.page === p.page && (it.y == null ? 0 : it.y) <= p.y + 2)) cur = it; }
  }
  return cur;
}
function refsItem() {
  const RX = /^(references|bibliography|literature cited|参考文献|主要参考文献)$/i;
  const pick = list => { const c = list.filter(x => RX.test((x.title || '').trim())); return c.find(x => !x.num && x.level === 1) || c.find(x => !x.num) || c.find(x => x.level === 1) || null; };
  const it = pick(tocItems(R.mode)) || pick(headingItems());
  if (it) return it.bid || R.mode === 'pdf' ? it : { ...it, bid: (blockAt(it.page, it.y) || {}).id };
  const rb = R.blocks.find(b => b.type === 'ref');
  return rb ? { title: '参考文献', page: rb.page, y: rb.y, bid: rb.id } : null;
}
async function openToc() {
  if (!R || !R.ready) return;
  if (R.outline === undefined) await loadOutline();
  const r = R;
  const items = tocItems(R.mode); const cur = currentTocItem(items);
  const refs = refsItem();
  const src = items.length && items[0].src === 'outline' ? 'PDF 书签' : '自动识别';
  const html = `<div class="toc-head"><h3>目录 <small>${items.length ? `${src} · ${items.length} 项` : ''}${R.mode === 'pdf' ? ' · 原版' : ' · 重排'}</small></h3>
     <div class="toc-tools"><span class="grow"></span><button class="chip" data-go="top">↑ 开头</button>${refs ? '<button class="chip" data-go="refs">参考文献</button>' : ''}</div></div>
     ${items.length ? `<div class="list toc">${items.map((it, i) => `<div class="li lv${it.level} ${it === cur ? 'on' : ''}" data-i="${i}">${it.num ? `<span class="num">${esc(it.num)}</span>` : ''}<span class="lt">${esc(it.title)}</span><span class="lv">${it.page}</span></div>`).join('')}</div>`
        : '<div class="empty">没有找到章节标题<br><span style="font-size:12px">这篇 PDF 既没有书签，也没能自动识别出标题</span></div>'}`;
  openSheet(html, sh => {
    const center = () => { const on = sh.querySelector('.li.on'); if (on) sh.scrollTop = Math.max(0, on.offsetTop - sh.clientHeight / 2 + on.offsetHeight); };
    requestAnimationFrame(center);
    sh.onclick = e => {
      if (R !== r) return;
      const g = e.target.closest('[data-go]');
      if (g) { closeSheet(); if (g.dataset.go === 'top') { body.scrollTop = 0; updateProgress(); } else gotoItem(refs); return; }
      const li = e.target.closest('[data-i]'); if (li) { closeSheet(); gotoItem(items[+li.dataset.i]); }
    };
  });
}
function gotoItem(it) {
  if (!it || !R) return;
  R.pin = null;
  if (R.mode === 'reflow') {
    const bid = it.bid || (blockAt(it.page, it.y) || {}).id;
    R.pin = { it, mode: 'reflow', st: -99 };
    scrollToBid(bid);
  } else if (R.pv) {
    if (it.y != null) R.pv.scrollToPt(it.page, it.y, 12, it.x ?? null, true);
    else R.pv.scrollTo(it.page, 0);
    R.pin = { it, mode: 'pdf', st: body.scrollTop };
    updateProgress(); savePos();
  }
}
function scrollToBid(bid) {
  const el = bid && body.querySelector(`.blk[data-bid="${bid}"]`); if (!el) return;
  let target = el.offsetTop - 12;
  body.scrollTop = target; if (R.pin) R.pin.st = body.scrollTop;
  // 版面若因图片加载稍有变化，再对齐一次（用户已手动滚动则不干预）
  const realign = () => { if (Math.abs(body.scrollTop - target) < 3) { target = el.offsetTop - 12; body.scrollTop = target; if (R && R.pin) R.pin.st = body.scrollTop; } };
  requestAnimationFrame(realign); setTimeout(realign, 300);
  el.classList.remove('toc-flash'); void el.offsetWidth; el.classList.add('toc-flash');
  updateProgress(); savePos();
}
$('#r-t').parentElement.addEventListener('click', () => { if (R && R.ready) openToc(); });

function openAa() {
  const th = effTheme();
  const draw = () => `<h3>显示设置</h3>
   <div class="set-row"><span>字号 <small style="color:var(--text3)" id="fsV">${ST.fs}</small></span><div class="ctl"><span style="font-size:13px">A</span><input type="range" id="fsR" min="14" max="24" step="1" value="${ST.fs}"><span style="font-size:20px">A</span></div></div>
   <div class="set-row"><span>行距</span><div class="mini-seg">${[[1.55, '紧凑'], [1.75, '标准'], [2, '宽松']].map(([v, l]) => `<button data-lh="${v}" class="${ST.lh == v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
   <div class="set-row"><span>字体</span><div class="mini-seg"><button data-font="serif" class="${ST.font === 'serif' ? 'on' : ''}" style="font-family:var(--serif)">衬线</button><button data-font="sans" class="${ST.font === 'sans' ? 'on' : ''}">无衬线</button></div></div>
   <div class="set-row"><span>背景</span><div class="theme-dots">
     <button data-th="paper" style="background:#FBFAF7;color:#23262A" class="${effTheme() === 'light' && ST.rtheme === 'paper' ? 'on' : ''}">白</button>
     <button data-th="sepia" style="background:#F4ECDA;color:#3A3024" class="${effTheme() === 'light' && ST.rtheme === 'sepia' ? 'on' : ''}">护眼</button>
     <button data-th="dark" style="background:#151618;color:#D8D5CE" class="${effTheme() === 'dark' ? 'on' : ''}">夜间</button></div></div>
   <div class="help">字号、行距和字体作用于重排模式；背景同时作用于两种模式。</div>`;
  openSheet(draw(), sh => {
    const art = () => $('#article');
    sh.oninput = e => { if (e.target.id === 'fsR') { ST.fs = +e.target.value; art() && art().style.setProperty('--rfs', ST.fs + 'px'); $('#fsV').textContent = ST.fs; saveST(); } };
    sh.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.lh) { ST.lh = +t.dataset.lh; art() && art().style.setProperty('--rlh', ST.lh); }
      if (t.dataset.font) { ST.font = t.dataset.font; art() && art().classList.toggle('sans', ST.font === 'sans'); }
      if (t.dataset.th) { if (t.dataset.th === 'dark') ST.theme = 'dark'; else { ST.theme = 'light'; ST.rtheme = t.dataset.th; } applyTheme(); renderToolbar(); }
      saveST(); redrawSheet(draw());
    };
  });
}
$('#r-more').onclick = () => {
  if (!R || !R.ready) return;
  openSheet(`<h3>更多</h3><div class="list">
    <div class="li" data-a="edit"><span class="ic">${ic('edit', 'sm')}</span><span class="lt">编辑标题、作者与标签</span></div>
    <div class="li" data-a="exp"><span class="ic">${ic('share', 'sm')}</span><span class="lt">导出本文笔记（Markdown）</span></div>
    <div class="li" data-a="cite"><span class="ic">${ic('copy', 'sm')}</span><span class="lt">复制引用信息</span></div>
    <div class="li" data-a="star"><span class="ic">${ic('star', 'sm')}</span><span class="lt">${R.p.star ? '取消收藏' : '收藏'}</span></div>
    <div class="li" data-a="reflow"><span class="ic">${ic('refresh', 'sm')}</span><span class="lt">重新生成重排版本</span></div></div>
    <div class="help">${esc(R.p.fileName || '')} · ${R.pdf.numPages} 页</div>`, sh => {
    sh.onclick = async e => {
      const li = e.target.closest('[data-a]'); if (!li) return; const a = li.dataset.a;
      if (a === 'edit') openPaperSheet(R.p.id, p => { if (R) { R.p = p; $('#r-t').textContent = p.title; const t = body.querySelector('.a-title'); if (t) t.textContent = p.title; } });
      if (a === 'exp') { closeSheet(); exportPaper(); }
      if (a === 'cite') { const p = R.p; const s = `${p.authors ? p.authors + '. ' : ''}${p.title}. ${p.venue ? p.venue + ', ' : ''}${p.year || ''}${p.arxivId ? '. arXiv:' + p.arxivId : ''}`.replace(/\s+/g, ' ').trim(); closeSheet(); toast(await copyText(s) ? '已复制：' + s.slice(0, 60) : s, 4000); }
      if (a === 'star') { R.p.star = !R.p.star; await savePaper(R.p); closeSheet(); toast(R.p.star ? '已收藏' : '已取消收藏'); }
      if (a === 'reflow') { closeSheet(); await db.del('reflow', R.p.id); const id = R.p.id; await closeReader(true); openReader(id); }
    };
  });
};

/* ---------- 选中文字 → 划线 / 笔记 ---------- */
let pending = null, selTimer = 0;
const selbar = $('#selbar'), popdef = $('#popdef');
function renderSelbar() {
  selbar.innerHTML = COLORS.map(c => `<button class="cdot ${ST.color === c ? 'on' : ''}" data-c="${c}" aria-label="${CN[c]}色划线"><i style="background:var(--dot-${c})"></i></button>`).join('') +
    `<span class="sep"></span><button class="act" data-s="note">${ic('pen')}笔记</button><button class="act" data-s="tr">${ic('trans')}翻译</button><button class="act" data-s="copy">${ic('copy')}复制</button>`;
}
const offsetIn = (el, node, off) => { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, off); return r.toString().length; };
function checkSel() {
  if (!R || !R.ready || sheetOpen()) return;
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { if (!popdef.classList.contains('show')) hideSel(); return; }
  const range = sel.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return;
  let next = null;
  if (R.mode === 'reflow') {
    const pe = n => { const el = n.nodeType === 1 ? n : n.parentElement; return el && el.closest ? el.closest('p.en') : null; };
    const a = pe(range.startContainer), b = pe(range.endContainer);
    if (!a || a !== b) { hideSel(); return; }
    const T = R.bmap[a.dataset.bid].text;
    let start = offsetIn(a, range.startContainer, range.startOffset), end = offsetIn(a, range.endContainer, range.endOffset);
    const raw = range.toString(); start += raw.length - raw.trimStart().length; end -= raw.length - raw.trimEnd().length;
    const W = /[A-Za-z0-9\-\u00C0-\u024F]/;
    while (start > 0 && W.test(T[start - 1]) && W.test(T[start])) start--;
    while (end < T.length && W.test(T[end - 1] || '') && W.test(T[end])) end++;
    if (end <= start) { hideSel(); return; }
    next = { mode: 'reflow', bid: a.dataset.bid, start, end, text: T.slice(start, end) };
  } else {
    const r = selectionToPdf(range); if (!r || !r.text) { hideSel(); return; }
    next = { mode: 'pdf', ...r };
  }
  if (pending && selbar.classList.contains('show') && pending.text === next.text && pending.bid === next.bid) return;
  pending = next; showSelbar(range.getBoundingClientRect());
}
function showSelbar(rect) {
  renderSelbar(); selbar.classList.add('show'); popdef.classList.remove('show');
  const pr = phone.getBoundingClientRect(); const w = selbar.offsetWidth, h = selbar.offsetHeight;
  let top = rect.bottom - pr.top + 12, above = false;
  if (top + h > pr.height - 90) { top = rect.top - pr.top - h - 12; above = true; }
  top = Math.max(60, top);
  const cx = rect.left + rect.width / 2 - pr.left; const left = Math.max(10, Math.min(pr.width - w - 10, cx - w / 2));
  selbar.style.top = top + 'px'; selbar.style.left = left + 'px'; selbar.style.setProperty('--ax', Math.max(16, Math.min(w - 16, cx - left)) + 'px');
  selbar.classList.toggle('above', above);
}
function hideSel() { selbar.classList.remove('show'); popdef.classList.remove('show'); }
document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(checkSel, 260); });
document.addEventListener('sheetopen', hideSel);
selbar.addEventListener('mousedown', e => e.preventDefault());
selbar.addEventListener('click', async e => {
  const c = e.target.closest('[data-c]'); const s = e.target.closest('[data-s]'); if (!pending) return;
  if (c) { ST.color = c.dataset.c; saveST(); await addHL(pending, ST.color); toast(CN[ST.color] + '色划线已添加'); return; }
  if (!s) return;
  if (s.dataset.s === 'note') { const h = await addHL(pending, ST.color); openHlSheet(h.id, true); }
  if (s.dataset.s === 'copy') { await copyText(pending.text); getSelection().removeAllRanges(); hideSel(); toast('已复制'); }
  if (s.dataset.s === 'tr') showTrans(pending.text);
});
async function showTrans(text) {
  const place = () => { const pr = phone.getBoundingClientRect(); popdef.classList.add('show'); let top = parseFloat(selbar.style.top) + (selbar.classList.contains('above') ? -popdef.offsetHeight - 8 : selbar.offsetHeight + 8); top = Math.max(60, Math.min(pr.height - popdef.offsetHeight - 70, top)); popdef.style.top = top + 'px'; popdef.style.left = Math.round((pr.width - popdef.offsetWidth) / 2) + 'px'; };
  if (!ai.hasAI()) { popdef.innerHTML = `<div style="font-size:13px">翻译需要先配置 AI 接口。</div><div class="k">在「我的 → AI 翻译与速读」中填写，密钥只保存在本机。</div>`; place(); return; }
  popdef.innerHTML = `<div style="display:flex;gap:8px;align-items:center;color:var(--text3)"><span class="spinner" style="width:14px;height:14px"></span>翻译中…</div>`; place();
  try { const t = await ai.translate(text); popdef.innerHTML = `<div style="font-size:12px;color:var(--text3);margin-bottom:4px;display:flex;gap:4px;align-items:center">${ic('trans', 'xs')} ${esc(ai.getCfg().model)} 翻译</div><div>${esc(t)}</div>`; }
  catch (err) { popdef.innerHTML = `<div class="status-err">翻译失败：${esc(err.message)}</div>`; }
  if (selbar.classList.contains('show')) place();
}

/* ---------- 划线数据 ---------- */
function syncLib(h, removed) {
  const i = LIB.hls.findIndex(x => x.id === h.id);
  if (removed) { if (i >= 0) LIB.hls.splice(i, 1); } else if (i >= 0) LIB.hls[i] = h; else LIB.hls.push(h);
}
async function addHL(sel, color) {
  const base = { id: uid('h'), paper: R.p.id, mode: sel.mode, text: sel.text, color, note: '', ts: Date.now() };
  let h;
  if (sel.mode === 'reflow') {
    const b = R.bmap[sel.bid];
    for (const o of R.hls.filter(x => x.mode === 'reflow' && x.bid === sel.bid && x.start < sel.end && x.end > sel.start)) await removeHL(o, true);
    h = { ...base, bid: sel.bid, start: sel.start, end: sel.end, page: b.page, order: b.idx * 1e5 + sel.start, sec: R.secOf[sel.bid] || '' };
  } else {
    const key = sel.text.slice(0, 40); const blk = R.blocks.find(b => b.page === sel.page && b.text && key.length > 6 && b.text.includes(key)) || R.blocks.find(b => b.page === sel.page && b.type === 'p');
    h = { ...base, page: sel.page, rects: sel.rects, order: Math.round(sel.rects[0][1] * 1e5), sec: (blk && R.secOf[blk.id]) || '' };
  }
  await db.put('highlights', h); R.hls.push(h); syncLib(h);
  getSelection().removeAllRanges(); hideSel(); pending = null;
  refreshHL(h); return h;
}
async function removeHL(h, quiet) {
  await db.del('highlights', h.id); R.hls = R.hls.filter(x => x.id !== h.id); syncLib(h, true); if (!quiet) refreshHL(h);
}
function refreshHL(h) {
  if (!R) return;
  if (h.mode === 'reflow') { const en = body.querySelector(`p.en[data-bid="${h.bid}"]`); if (en) en.innerHTML = hlHTML(R.bmap[h.bid]); }
  else if (R.pv) R.pv.drawHighlights(h.page);
  renderToolbar();
}
function openHlSheet(hid, isNew) {
  const h = R.hls.find(x => x.id === hid); if (!h) return;
  const ctx = h.mode === 'reflow' ? (R.bmap[h.bid] || {}).text || '' : '';
  openSheet(`<h3>${isNew ? '添加笔记' : '划线与笔记'} <small>${esc((h.sec || '').slice(0, 24))}${h.sec ? ' · ' : ''}第 ${h.page} 页</small></h3>
   <div class="quote" style="--qc:var(--dot-${h.color})">${esc(h.text)}</div>
   <div class="colors"><span class="lbl">颜色</span>${COLORS.map(c => `<button data-col="${c}" class="${h.color === c ? 'on' : ''}" style="background:var(--dot-${c})" aria-label="${CN[c]}"></button>`).join('')}</div>
   <textarea class="note" id="noteTa" placeholder="写下你的想法、疑问或与自己课题的联系……">${esc(h.note || '')}</textarea>
   <div class="sheet-actions"><button class="btn danger" data-del aria-label="删除">${ic('trash', 'sm')}</button><span class="grow"></span><button class="btn ghost" data-ask>${ic('spark', 'xs')} 问 AI</button><button class="btn" data-save>保存</button></div>`, sh => {
    sh.onclick = async e => {
      const c = e.target.closest('[data-col]');
      if (c) { h.color = c.dataset.col; ST.color = h.color; saveST(); sh.querySelector('.quote').style.setProperty('--qc', `var(--dot-${h.color})`); sh.querySelectorAll('[data-col]').forEach(b => b.classList.toggle('on', b === c)); await db.put('highlights', h); syncLib(h); refreshHL(h); }
      if (e.target.closest('[data-save]')) { h.note = $('#noteTa').value.trim(); await db.put('highlights', h); syncLib(h); refreshHL(h); closeSheet(); toast(h.note ? '笔记已保存' : '划线已保存'); }
      if (e.target.closest('[data-del]')) { await removeHL(h); closeSheet(); toast('已删除划线'); }
      const ask = e.target.closest('[data-ask]');
      if (ask) {
        if (!ai.hasAI()) { needAI('问 AI'); return; }
        ask.disabled = true; ask.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> 思考中';
        try {
          const out = await ai.chat([{ role: 'system', content: `你是科研助理。用${ai.getCfg().lang || '简体中文'}简明解释用户划线的学术文字（3-5 句）：含义、涉及的概念或方法、在本文中的作用。不要编造文中没有的数据。` },
            { role: 'user', content: `论文：${R.p.title}\n${ctx ? '所在段落：' + ctx.slice(0, 2500) + '\n' : ''}划线内容：${h.text}` }], { maxTokens: 500 });
          const ta = $('#noteTa'); if (ta) ta.value = (ta.value ? ta.value + '\n\n' : '') + '【AI 解释】' + out;
        } catch (err) { toast('AI 请求失败：' + err.message, 3500); }
        if (ask.isConnected) { ask.disabled = false; ask.innerHTML = `${ic('spark', 'xs')} 问 AI`; }
      }
    };
  });
}
export function hlCard(h) {
  return `<div class="hl-card" data-jump="${h.id}"><div class="q" style="--qc:var(--dot-${h.color})">${esc(h.text)}</div>${h.note ? `<div class="n">${ic('pen', 'xs')}<span>${esc(h.note).replace(/\n/g, '<br>')}</span></div>` : ''}<div class="m"><span>${esc((h.sec || '').slice(0, 30))}${h.sec ? ' · ' : ''}第 ${h.page} 页${h.mode === 'pdf' ? ' · 原版' : ''}</span><span>${ago(h.ts)}</span></div></div>`;
}
const sortHL = list => list.slice().sort((a, b) => (a.page - b.page) || (a.order - b.order));
function openNotesPanel() {
  let f = 'all';
  const draw = () => {
    const list = sortHL(R.hls).filter(h => f === 'all' || h.color === f);
    return `<h3><span>本文笔记<br><small>${R.hls.length} 条划线 · ${R.hls.filter(h => h.note).length} 条笔记</small></span>${R.hls.length ? `<button class="btn ghost" data-exp style="height:36px;font-size:13px;padding:0 12px">${ic('share', 'xs')} 导出 Markdown</button>` : ''}</h3>
     ${R.hls.length ? `<div class="chips" style="padding:0 0 12px;margin:0 -20px;padding-left:20px">${['all', ...COLORS].map(c => `<button class="chip ${f === c ? 'on' : ''}" data-nf="${c}">${c === 'all' ? '全部' : `<i class="cd" style="background:var(--dot-${c})"></i>${CN[c]}`}</button>`).join('')}</div>` : ''}
     ${list.length ? list.map(hlCard).join('') : '<div class="empty">还没有划线<br><span style="font-size:12px">长按选中文字即可划线或写笔记（重排与原版模式均可）</span></div>'}`;
  };
  openSheet(draw(), sh => {
    sh.onclick = e => {
      const n = e.target.closest('[data-nf]'); if (n) { f = n.dataset.nf; redrawSheet(draw()); return; }
      if (e.target.closest('[data-exp]')) { closeSheet(); return exportPaper(); }
      const j = e.target.closest('[data-jump]'); if (j) { closeSheet(); jumpTo(j.dataset.jump); }
    };
  });
}
async function jumpTo(hid) {
  if (!R) return;
  const h = R.hls.find(x => x.id === hid); if (!h) return;
  if (h.mode === 'reflow' && !h.orphan) {
    if (R.mode !== 'reflow') await setMode('reflow', { bid: h.bid });
    const m = body.querySelector(`mark[data-hid="${hid}"]`); if (!m) return;
    const top = m.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 140;
    body.scrollTo({ top, behavior: 'smooth' }); m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash');
  } else {
    const H = (R.rf.pages && R.rf.pages[h.page - 1]) ? R.rf.pages[h.page - 1][1] : 792;
    const target = h.rects ? { page: h.page, y: Math.max(0, h.rects[0][1] * H - 80) } : { page: h.page, frac: 0 };
    if (R.mode !== 'pdf') await setMode('pdf', target); else if (target.y != null) R.pv.scrollToPt(target.page, target.y); else R.pv.scrollTo(target.page, 0);
  }
}
export async function paperMarkdown(p) {
  const hs = sortHL(LIB.hls.filter(h => h.paper === p.id));
  const meta = [p.authors, p.venue, p.year, p.arxivId ? 'arXiv:' + p.arxivId : ''].filter(Boolean).join(' · ');
  let md = `# ${p.title}\n\n${meta ? '> ' + meta + '\n\n' : ''}*${hs.length} 条划线，${hs.filter(h => h.note).length} 条笔记 · 导出自「研读」${new Date().toLocaleDateString('zh-CN')}*\n`;
  let sec = null;
  for (const h of hs) {
    const s = h.sec || `第 ${h.page} 页`;
    if (s !== sec) { md += `\n## ${s}\n\n`; sec = s; }
    md += `- ==${h.text.replace(/\n/g, ' ')}==（${CN[h.color]} · p.${h.page}）\n`;
    if (h.note) md += h.note.split('\n').map((l, i) => `  ${i ? '  ' : '- 笔记：'}${l}`).join('\n') + '\n';
  }
  return md;
}
async function exportPaper() {
  if (!R.hls.length) return toast('本文还没有划线');
  const md = await paperMarkdown(R.p);
  download(`笔记-${safeName(R.p.title)}.md`, md);
  toast('已导出 Markdown 文件');
}
