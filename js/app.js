// 研读 · 主程序：书架、导入、笔记、设置、离线
import * as db from './db.js';
import * as ai from './ai.js';
import { extractReflow, guessMeta, REFLOW_VERSION } from './reflow.js';
import { loadPdf, renderThumb, closePdf } from './pdfview.js';
import { ic, $, esc, phone, CN, COLORS, toast, ago, fmtSize, uid, ST, saveST, applyTheme, effTheme, openSheet, redrawSheet, closeSheet, confirmSheet, download, copyText, safeName } from './util.js';
import { openReader, closeReader, isReading, hlCard, paperMarkdown, onReaderThemeChange } from './reader.js';

export const APPVER = '1.0.0';
export const LIB = { papers: [], hls: [] };
const S = { tab: 'library', filter: '全部', query: '', ncolor: 'all', importing: null };
const TAGCLS = { TFM: 't-tfm', FMC: 't-fmc', SAFT: 't-saft', '深度学习': 't-dl', '混凝土': 't-con' };

export async function reloadLib() {
  LIB.papers = await db.all('papers');
  LIB.hls = await db.all('highlights');
}
export async function savePaper(p) {
  await db.put('papers', p);
  const i = LIB.papers.findIndex(x => x.id === p.id); if (i >= 0) LIB.papers[i] = p; else LIB.papers.push(p);
}

/* ---------- tab bar ---------- */
function renderTabbar() {
  const T = [['library', 'book', '书架'], ['notes', 'pen', '笔记'], ['me', 'user', '我的']];
  $('#tabbar').innerHTML = T.map(([k, i, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${ic(i)}<span>${l}</span></button>`).join('');
  $('#fab').style.display = S.tab === 'library' && LIB.papers.length ? 'flex' : 'none';
  $('#fab').innerHTML = ic('plus', 'sm') + '导入';
}
export function switchTab(t) {
  S.tab = t; document.querySelectorAll('.tabview').forEach(v => v.classList.toggle('active', v.id === 'v-' + t));
  renderTabbar(); renderTab();
}
export function renderTab() { if (S.tab === 'notes') renderNotes(); else if (S.tab === 'me') renderMe(); else renderLibrary(); renderTabbar(); }
$('#tabbar').onclick = e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); };

/* ---------- 书架 ---------- */
const greeting = () => { const h = new Date().getHours(); return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'; };
function allTags() { const m = new Map(); LIB.papers.forEach(p => (p.tags || []).forEach(t => m.set(t, (m.get(t) || 0) + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); }
const SORTS = { recent: '最近阅读', added: '导入时间', title: '标题', year: '年份' };
function sorted(list) {
  const s = ST.sort;
  return list.slice().sort((a, b) => s === 'title' ? a.title.localeCompare(b.title) : s === 'year' ? (b.year || 0) - (a.year || 0) : s === 'added' ? b.addedAt - a.addedAt : (Math.max(b.openedAt || 0, b.addedAt) - Math.max(a.openedAt || 0, a.addedAt)));
}
function filtered() {
  const q = S.query.trim().toLowerCase();
  return sorted(LIB.papers.filter(p => {
    const f = S.filter;
    if (f === '在读' && !(p.progress > 0 && p.progress < 98)) return false;
    if (f === '收藏' && !p.star) return false;
    if (f === '未读' && p.progress > 0) return false;
    if (!['全部', '在读', '收藏', '未读'].includes(f) && !(p.tags || []).includes(f)) return false;
    if (q && !(p.title + ' ' + (p.authors || '') + ' ' + (p.venue || '') + ' ' + (p.year || '') + ' ' + (p.tags || []).join(' ') + ' ' + (p.arxivId || '')).toLowerCase().includes(q)) return false;
    return true;
  }));
}
function authLine(p) {
  const a = (p.authors || '').split(/,|;| and /).map(s => s.trim()).filter(Boolean);
  return [a.length ? a[0] + (a.length > 1 ? ' 等' : '') : '', p.year, p.venue].filter(Boolean).map(esc).join(' · ') || esc(p.fileName || '');
}
function paperItem(p) {
  const prog = p.progress >= 98 ? '<span class="done">✓ 已读完</span>' : p.progress > 0 ? `<span class="bar"><i style="width:${p.progress}%"></i></span><span>${Math.round(p.progress)}%</span>` : '<span class="badge-new">未读</span>';
  const nh = LIB.hls.filter(h => h.paper === p.id).length;
  return `<div class="pitem" data-id="${p.id}">
    ${p.thumb ? `<div class="thumb img"><img src="${p.thumb}" alt="" loading="lazy"></div>` : `<div class="thumb"><i></i><i></i><i></i><i></i><i></i><i></i><span>PDF</span></div>`}
    <div class="pmeta">
      <div class="ptitle">${esc(p.title)}</div>
      <div class="pauth">${authLine(p)}</div>
      <div class="ptags">${p.star ? '<span class="star">★</span>' : ''}${(p.tags || []).map(t => `<span class="tag ${TAGCLS[t] || ''}">${esc(t)}</span>`).join('')}${nh ? `<span class="tag">✎ ${nh}</span>` : ''}</div>
      <div class="pprog">${prog}<span style="margin-left:auto">${p.openedAt ? ago(p.openedAt) : ago(p.addedAt) + '导入'}</span></div>
    </div>
    <button class="pmore" data-more="${p.id}" aria-label="更多操作">${ic('more', 'sm')}</button></div>`;
}
function importRow() {
  const im = S.importing; if (!im) return '';
  return `<div class="import-row"><span class="spinner"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(im.msg)}</span>${im.total > 1 ? `<span>${im.done + 1}/${im.total}</span>` : ''}</div>`;
}
export function renderLibrary() {
  const v = $('#v-library');
  const keep = document.activeElement && document.activeElement.id === 'q';
  const head = `<div class="page-head"><div><div class="hello">${greeting()}</div><h1>论文库</h1></div><div class="avatar" data-go="me" aria-label="我的">研</div></div>`;
  if (!LIB.papers.length) {
    v.innerHTML = head + importRow() + `<div class="empty-state"><div class="big">${ic('book')}</div><h2>导入第一篇论文</h2>
      <p>选择手机里的 PDF（可多选），或输入 arXiv 编号。<br>论文与笔记只保存在本机，可离线阅读。</p>
      <button class="btn" data-imp="pdf">${ic('upload', 'sm')} 选择 PDF 文件</button>
      <button class="btn ghost" data-imp="arxiv">${ic('link', 'sm')} 从 arXiv 导入</button>
      <div class="tips">· 微信 / QQ 里的 PDF：先用「其他应用打开 → 存储到文件」，再在这里选择<br>· 重排模式适合手机阅读，公式与图表以原图显示<br>· 添加到主屏幕后可像 App 一样全屏使用</div></div>`;
    renderTabbar(); return;
  }
  const list = filtered();
  const chips = ['全部', '在读', '收藏', '未读', ...allTags()];
  const cur = sorted(LIB.papers).find(p => p.openedAt && p.progress > 0 && p.progress < 98);
  const showCont = cur && !S.query && S.filter === '全部';
  v.innerHTML = head + `<label class="search">${ic('search', 'sm')}<input id="q" type="search" placeholder="搜索标题、作者、标签" value="${esc(S.query)}" autocomplete="off"></label>
  <div class="chips">${chips.map(c => `<button class="chip ${S.filter === c ? 'on' : ''}" data-f="${esc(c)}">${c === '收藏' ? '★ ' : ''}${esc(c)}</button>`).join('')}</div>
  ${importRow()}
  ${showCont ? `<div class="continue" data-id="${cur.id}"><div class="lbl">${ic('clock', 'xs')} 继续阅读${cur.posLabel ? ' · 上次读到 ' + esc(cur.posLabel) : ''}</div>
    <div class="t">${esc(cur.title)}</div><div class="row"><span class="bar"><i style="width:${cur.progress}%"></i></span><span>${Math.round(cur.progress)}%</span><span style="width:34px"></span></div>
    <div class="go">${ic('right', 'sm')}</div></div>` : ''}
  <div class="sec-head"><span><b>${S.filter === '全部' ? '全部论文' : esc(S.filter)}</b>&nbsp; ${list.length} 篇</span><button id="sortBtn">${ic('sort', 'xs')} ${SORTS[ST.sort]}</button></div>
  <div class="plist">${list.length ? list.map(paperItem).join('') : '<div class="empty">没有匹配的论文<br><span style="font-size:12px">试试其他关键词或标签</span></div>'}</div>`;
  if (keep) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  renderTabbar();
}
$('#v-library').addEventListener('input', e => { if (e.target.id === 'q') { S.query = e.target.value; renderLibrary(); } });
$('#v-library').addEventListener('click', e => {
  const im = e.target.closest('[data-imp]'); if (im) { im.dataset.imp === 'pdf' ? $('#file').click() : openImportSheet(true); return; }
  const f = e.target.closest('[data-f]'); if (f) { S.filter = f.dataset.f; renderLibrary(); return; }
  if (e.target.closest('#sortBtn')) return openSortSheet();
  if (e.target.closest('[data-go]')) return switchTab('me');
  const m = e.target.closest('[data-more]'); if (m) { openPaperSheet(m.dataset.more); return; }
  const it = e.target.closest('[data-id]'); if (it) openReader(it.dataset.id);
});
$('#fab').onclick = () => openImportSheet();

function openSortSheet() {
  openSheet(`<h3>排序</h3><div class="list">${Object.entries(SORTS).map(([k, l]) => `<div class="li ${ST.sort === k ? 'on' : ''}" data-s="${k}"><span class="lt">${l}</span>${ST.sort === k ? ic('check', 'sm') : ''}</div>`).join('')}</div>`, sh => {
    sh.onclick = e => { const li = e.target.closest('[data-s]'); if (li) { ST.sort = li.dataset.s; saveST(); closeSheet(); renderLibrary(); } };
  });
}

/* ---------- 导入 ---------- */
function openImportSheet(focusArxiv) {
  openSheet(`<h3>导入论文 <small>PDF / arXiv</small></h3>
  <div class="imp-grid">
    <div class="imp-card" data-imp="pdf"><div class="ic" style="background:#E3EDF5;color:#2D5F7F">${ic('upload')}</div>上传 PDF<small>可多选</small></div>
    <div class="imp-card" data-imp="arxiv"><div class="ic" style="background:#F6E3E3;color:#B31B1B">${ic('link')}</div>arXiv<small>编号或链接</small></div>
    <div class="imp-card" data-imp="wx"><div class="ic" style="background:#E3F3E6;color:#2E8B47">${ic('phone')}</div>微信 / 网盘<small>使用说明</small></div>
  </div>
  <div class="field"><input id="axIn" placeholder="arXiv 编号或链接，如 2412.07347" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn" id="axGo">导入</button></div>
  <div class="help">文件只保存在本机浏览器（IndexedDB），不会上传到任何服务器。导入后自动识别标题和作者（可编辑），并生成重排版本。</div>`, sh => {
    sh.onclick = e => {
      const c = e.target.closest('[data-imp]'); if (!c) return;
      if (c.dataset.imp === 'pdf') $('#file').click();
      else if (c.dataset.imp === 'arxiv') $('#axIn').focus();
      else openSheet(`<h3>从微信、QQ 或网盘导入</h3><div class="help" style="font-size:14px;color:var(--text2);line-height:1.8">
        <b>iPhone：</b>在聊天中打开 PDF → 右上角「…」→「用其他应用打开」→「存储到文件」，然后回到研读点「上传 PDF」，在「文件」中选择。<br><br>
        <b>安卓：</b>在聊天中打开 PDF →「用其他应用打开」或「保存到手机」，然后在研读点「上传 PDF」，从「下载」或对应文件夹中选择。</div>
        <div class="sheet-actions"><span class="grow"></span><button class="btn" data-pick>选择 PDF</button></div>`, s2 => { s2.onclick = ev => { if (ev.target.closest('[data-pick]')) { closeSheet(); $('#file').click(); } }; });
    };
    $('#axGo').onclick = () => { const v = $('#axIn').value.trim(); if (!v) { $('#axIn').focus(); return toast('请先输入 arXiv 编号或链接'); } importArxiv(v); };
    $('#axIn').onkeydown = e => { if (e.key === 'Enter') $('#axGo').click(); };
    if (focusArxiv) setTimeout(() => $('#axIn').focus(), 350);
  });
}
$('#file').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  closeSheet(); if (S.tab !== 'library') switchTab('library');
  await importFiles(files);
};

let importChain = Promise.resolve();
export function importFiles(files) {
  importChain = importChain.then(async () => {
    let ok = 0; const total = files.length;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      S.importing = { done: i, total, msg: '正在导入：' + f.name }; renderLibrary();
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('已跳过非 PDF 文件：' + f.name); continue; }
      try { const buf = await f.arrayBuffer(); if (await importBuffer(buf, { fileName: f.name, source: 'file' })) ok++; }
      catch (err) { console.warn(err); toast('导入失败：' + f.name + (err && err.name === 'PasswordException' ? '（加密的 PDF）' : '')); }
    }
    S.importing = null; renderLibrary();
    if (ok) toast(ok === 1 ? '已导入 1 篇论文' : `已导入 ${ok} 篇论文`);
  });
  return importChain;
}

async function importBuffer(buf, extra) {
  const head = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  if (!String.fromCharCode(...head).includes('%PDF')) throw new Error('不是有效的 PDF 文件');
  const dup = LIB.papers.find(p => p.size === buf.byteLength && (p.fileName === extra.fileName || (extra.arxivId && p.arxivId === extra.arxivId)));
  if (dup) { toast('已在书架中：' + dup.title.slice(0, 30)); return false; }
  const pdf = await loadPdf(buf);
  try {
    const meta = await guessMeta(pdf, extra.fileName);
    if (S.importing) { S.importing.msg = '正在解析：' + (meta.title || extra.fileName).slice(0, 60); renderLibrary(); }
    let thumb = ''; try { thumb = await renderThumb(pdf); } catch (e) {}
    const id = uid('p');
    const paper = { id, title: meta.title || extra.fileName.replace(/\.pdf$/i, ''), authors: (meta.authors || '').replace(/\s*,(\s*,)+/g, ',').replace(/[,\s]+$/, ''), year: extra.year || meta.year || '', venue: extra.venue || '', tags: [], star: false, progress: 0,
      numPages: pdf.numPages, size: buf.byteLength, fileName: extra.fileName, source: extra.source, arxivId: extra.arxivId || '', addedAt: Date.now(), openedAt: 0, thumb, pos: null };
    await db.put('files', { id, data: buf });
    await savePaper(paper);
    renderLibrary();
    try { const r = await extractReflow(pdf); await db.put('reflow', { id, ...r }); } catch (e) { console.warn('reflow failed', e); }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return true;
  } finally { closePdf(pdf); }
}

function parseArxiv(v) {
  v = v.trim();
  let m = v.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*)?(\d{4}\.\d{4,5})(v\d+)?/i);
  if (m) return m[1] + (m[2] || '');
  m = v.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  return m ? m[1] + (m[2] || '') : null;
}
async function importArxiv(v) {
  const id = parseArxiv(v);
  if (!id) return toast('无法识别 arXiv 编号，例如 2412.07347 或 arxiv.org/abs/2412.07347');
  closeSheet(); if (S.tab !== 'library') switchTab('library');
  const url = `https://arxiv.org/pdf/${id}`;
  importChain = importChain.then(async () => {
    S.importing = { done: 0, total: 1, msg: `正在从 arXiv 下载 ${id}…` }; renderLibrary();
    let buf = null, err = '';
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(url, { signal: ctl.signal, mode: 'cors', credentials: 'omit' }); clearTimeout(tm);
      if (!r.ok) err = r.status === 404 ? '没有找到这篇论文（404），请检查编号' : 'arXiv 返回错误 ' + r.status;
      else buf = await r.arrayBuffer();
    } catch (e) { err = e.name === 'AbortError' ? 'TIMEOUT' : 'CORS'; }
    try {
      if (buf) {
        const ym = id.match(/^(\d{2})(\d{2})\./);
        const ok = await importBuffer(buf, { fileName: `arXiv-${id.replace('/', '_')}.pdf`, source: 'arxiv', arxivId: id, venue: 'arXiv', year: ym ? 2000 + +ym[1] : '' });
        if (ok) toast('已从 arXiv 导入 ' + id);
      }
    } catch (e) { err = 'PARSE'; console.warn(e); }
    S.importing = null; renderLibrary();
    if (err) arxivFail(id, url, err);
  });
}
function arxivFail(id, url, err) {
  const why = err === 'CORS' ? '浏览器无法直接下载这个文件（可能是网络不通，或被跨域策略 CORS 拦截）。' : err === 'TIMEOUT' ? '下载超时，网络可能较慢。' : err === 'PARSE' ? '下载的文件无法解析为 PDF。' : esc(err) + '。';
  openSheet(`<h3>未能从 arXiv 导入</h3><div class="help" style="font-size:14px;color:var(--text2);line-height:1.75;margin-top:0">${why}<br>可以手动下载后再导入：<br>1. 点下方按钮在浏览器中打开 PDF<br>2. 用「分享 → 存储到文件」（iPhone）或「下载」（安卓）保存<br>3. 回到研读，点「上传 PDF」选择该文件</div>
    <div class="sheet-actions"><a class="btn ghost" href="${url}" target="_blank" rel="noopener" style="text-decoration:none">${ic('link', 'xs')} 打开 arXiv PDF</a><span class="grow"></span><button class="btn" data-pick>上传 PDF</button></div>`, sh => {
    sh.onclick = e => { if (e.target.closest('[data-pick]')) { closeSheet(); $('#file').click(); } };
  });
}

/* ---------- 论文信息编辑 / 收藏 / 删除 ---------- */
export function openPaperSheet(id, after) {
  const p = LIB.papers.find(x => x.id === id); if (!p) return;
  let tags = [...(p.tags || [])];
  const known = [...new Set(['TFM', 'FMC', 'SAFT', '混凝土', '深度学习', ...allTags()])];
  const tagBtns = () => known.concat(tags.filter(t => !known.includes(t))).map(t => `<button data-tag="${esc(t)}" class="${tags.includes(t) ? 'on' : ''}">${esc(t)}</button>`).join('');
  openSheet(`<h3>论文信息 <button class="btn ghost" data-star style="height:34px;font-size:13px;padding:0 12px">${p.star ? '★ 已收藏' : '☆ 收藏'}</button></h3>
    <div class="form" style="margin:0;box-shadow:none;background:var(--surface3);padding:0 12px">
      <div class="fld"><label>标题</label><input id="e-title" value="${esc(p.title)}"></div>
      <div class="fld"><label>作者（逗号分隔）</label><input id="e-auth" value="${esc(p.authors)}"></div>
      <div class="fld"><div class="row"><div style="flex:1"><label>年份</label><input id="e-year" inputmode="numeric" value="${esc(p.year)}"></div><div style="flex:2"><label>期刊 / 会议</label><input id="e-venue" value="${esc(p.venue)}"></div></div></div>
      <div class="fld"><label>标签</label><div class="row"><input id="e-tag" placeholder="输入新标签后点添加"><button class="btn ghost" data-addtag style="height:40px">添加</button></div><div class="edit-tags" id="e-tags">${tagBtns()}</div></div>
    </div>
    <div class="help">${esc(p.fileName || '')} · ${p.numPages || '?'} 页 · ${fmtSize(p.size || 0)} · ${ago(p.addedAt)}导入</div>
    <div class="sheet-actions"><button class="btn danger" data-del>${ic('trash', 'sm')} 删除</button><span class="grow"></span><button class="btn" data-save>保存</button></div>`, sh => {
    sh.onclick = async e => {
      const t = e.target.closest('[data-tag]');
      if (t) { const v = t.dataset.tag; tags = tags.includes(v) ? tags.filter(x => x !== v) : [...tags, v]; $('#e-tags').innerHTML = tagBtns(); return; }
      if (e.target.closest('[data-addtag]')) { const v = $('#e-tag').value.trim().replace(/[,，]/g, ''); if (v && !tags.includes(v)) { tags.push(v); } $('#e-tag').value = ''; $('#e-tags').innerHTML = tagBtns(); return; }
      if (e.target.closest('[data-star]')) { p.star = !p.star; await savePaper(p); e.target.closest('[data-star]').textContent = p.star ? '★ 已收藏' : '☆ 收藏'; renderLibrary(); return; }
      if (e.target.closest('[data-save]')) {
        const pend = $('#e-tag').value.trim(); if (pend && !tags.includes(pend)) tags.push(pend);
        p.title = $('#e-title').value.trim() || p.title; p.authors = $('#e-auth').value.trim(); p.year = $('#e-year').value.trim(); p.venue = $('#e-venue').value.trim(); p.tags = tags;
        await savePaper(p); closeSheet(); renderLibrary(); toast('已保存'); after && after(p); return;
      }
      if (e.target.closest('[data-del]')) {
        const n = LIB.hls.filter(h => h.paper === p.id).length;
        if (await confirmSheet('删除这篇论文？', `「${esc(p.title)}」的 PDF${n ? `和 ${n} 条划线笔记` : ''}将从本机删除，无法恢复。`, '删除', true)) {
          if (isReading(p.id)) closeReader();
          await db.deletePaper(p.id); await reloadLib(); renderTab(); toast('已删除');
        }
      }
    };
  });
}

/* ---------- 笔记 tab ---------- */
const colorChips = (cur, attr) => ['all', ...COLORS].map(c => `<button class="chip ${cur === c ? 'on' : ''}" ${attr}="${c}">${c === 'all' ? '全部' : `<i class="cd" style="background:var(--dot-${c})"></i>${CN[c]}`}</button>`).join('');
export function renderNotes() {
  const v = $('#v-notes'); const f = S.ncolor;
  const groups = sorted(LIB.papers).map(p => ({ p, items: LIB.hls.filter(h => h.paper === p.id).sort((a, b) => (a.page - b.page) || (a.order - b.order)) })).filter(g => g.items.length);
  const total = LIB.hls.length, notes = LIB.hls.filter(h => h.note).length;
  const shown = groups.map(g => ({ ...g, items: g.items.filter(h => f === 'all' || h.color === f) })).filter(g => g.items.length);
  const gh = (p, n) => `<div class="ngroup-h" data-open="${p.id}">${p.thumb ? `<div class="thumb img" style="width:30px;height:40px"><img src="${p.thumb}" alt=""></div>` : `<div class="thumb" style="width:30px;height:40px;padding:7px 4px 0"><i></i><i></i><i></i></div>`}<div class="t">${esc(p.title)}</div><span class="c">${n} 条</span></div>`;
  v.innerHTML = `<div class="page-head"><div><div class="hello">所有论文的划线与想法</div><h1>笔记</h1></div>${total ? `<button class="icon-btn" id="nExp" aria-label="导出全部笔记">${ic('share')}</button>` : ''}</div>
   <div class="stats"><div><b>${total}</b><span>划线</span></div><div><b>${notes}</b><span>笔记</span></div><div><b>${groups.length}</b><span>篇论文</span></div></div>
   ${total ? `<div class="cfilter">${colorChips(f, 'data-nc')}</div>` : ''}
   ${shown.map(g => `<div class="ngroup">${gh(g.p, g.items.length)}${g.items.map(h => hlCard(h)).join('')}</div>`).join('')}
   ${!total ? '<div class="empty">还没有划线<br><span style="font-size:12px">阅读时长按选中文字，即可划线或写笔记</span></div>' : !shown.length ? '<div class="empty">该颜色下没有划线</div>' : ''}
   <div style="height:24px"></div>`;
}
$('#v-notes').addEventListener('click', async e => {
  const c = e.target.closest('[data-nc]'); if (c) { S.ncolor = c.dataset.nc; renderNotes(); return; }
  if (e.target.closest('#nExp')) return exportAll();
  const j = e.target.closest('[data-jump]'); if (j) { const h = LIB.hls.find(x => x.id === j.dataset.jump); if (h) openReader(h.paper, { jump: h.id }); return; }
  const o = e.target.closest('[data-open]'); if (o) openReader(o.dataset.open);
});
async function exportAll() {
  const parts = [];
  for (const p of sorted(LIB.papers)) { if (LIB.hls.some(h => h.paper === p.id)) parts.push(await paperMarkdown(p)); }
  const md = parts.join('\n\n---\n\n');
  download(`研读笔记-${new Date().toISOString().slice(0, 10)}.md`, md);
  toast('已导出全部笔记（Markdown）');
}

/* ---------- 我的 / 设置 ---------- */
const PRESETS = [
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
  ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['月之暗面', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k'],
  ['硅基流动', 'https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-7B-Instruct'],
  ['Ollama 本机', 'http://localhost:11434/v1', 'qwen2.5:7b']
];
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (S.tab === 'me') renderMe(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function renderMe() {
  const c = ai.getCfg();
  const nNotes = LIB.hls.filter(h => h.note).length;
  let est = null, persisted = null;
  try { est = await navigator.storage?.estimate?.(); persisted = await navigator.storage?.persisted?.(); } catch (e) {}
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  const ae = document.activeElement; const keepFocus = ae && ae.matches && ae.matches('#v-me input, #v-me select');
  if (keepFocus) return; // 正在编辑表单时不重绘
  $('#v-me').innerHTML = `<div class="page-head"><div><div class="hello">设置与数据</div><h1>我的</h1></div></div>
  <div class="stats"><div><b>${LIB.papers.length}</b><span>篇论文</span></div><div><b>${LIB.hls.length}</b><span>划线 · ${nNotes} 笔记</span></div><div><b>${est ? fmtSize(est.usage || 0) : '—'}</b><span>本机占用</span></div></div>
  <div class="group-t">外观与阅读</div>
  <div class="group">
    <div class="li"><span class="ic">${ic(effTheme() === 'dark' ? 'moon' : 'sun', 'sm')}</span><span class="lt">外观</span><div class="mini-seg">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, l]) => `<button data-thm="${k}" class="${ST.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="li"><span class="ic">${ic('file', 'sm')}</span><span class="lt">默认阅读模式</span><div class="mini-seg"><button data-dm="reflow" class="${ST.defMode === 'reflow' ? 'on' : ''}">重排</button><button data-dm="pdf" class="${ST.defMode === 'pdf' ? 'on' : ''}">原版</button></div></div>
  </div>
  <div class="group-t">AI 翻译与速读 ${ai.hasAI() ? '<span class="status-ok">· 已配置</span>' : '<span>· 未配置</span>'}</div>
  <div class="form" id="aiForm">
    <div class="fld"><label>快速填入（示例模型名，可按需修改）</label><div class="presets">${PRESETS.map((p, i) => `<button data-preset="${i}">${p[0]}</button>`).join('')}</div></div>
    <div class="fld"><label>接口地址 Base URL（OpenAI 兼容）</label><input id="ai-base" placeholder="https://api.example.com/v1" value="${esc(c.base || '')}" autocapitalize="off" spellcheck="false" inputmode="url"></div>
    <div class="fld"><label>API Key</label><div class="row"><input id="ai-key" type="password" placeholder="sk-…（本地模型可留空）" value="${esc(c.key || '')}" autocapitalize="off" spellcheck="false" autocomplete="off"><button class="btn ghost" data-showkey style="height:40px;padding:0 12px">显示</button></div></div>
    <div class="fld"><label>模型名称</label><input id="ai-model" placeholder="例如 deepseek-chat" value="${esc(c.model || '')}" autocapitalize="off" spellcheck="false"></div>
    <div class="fld"><label>译文语言</label><select id="ai-lang">${['简体中文', '繁體中文', 'English'].map(l => `<option ${(c.lang || '简体中文') === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="hint">密钥只保存在本机浏览器（localStorage），请求从你的设备直接发往该接口，不经过任何中转服务器。部分服务不允许浏览器直接跨域调用，测试失败时可换用支持 CORS 的服务或自建转发。</div></div>
  </div>
  <div class="form-actions"><button class="btn ghost" data-aitest>测试连接</button><button class="btn" data-aisave>保存</button></div>
  <div class="help" id="aiStatus" style="margin:8px 32px 0"></div>
  ${c.base || c.key ? `<div style="margin:6px 20px 0;text-align:right"><button class="btn danger" data-aiclear style="height:32px;font-size:13px">清除 AI 配置</button></div>` : ''}
  <div class="group-t">数据（仅保存在本机）</div>
  <div class="group">
    <div class="li" data-persist><span class="ic">${ic('db', 'sm')}</span><span class="lt">存储空间</span><span class="lv">${est ? `${fmtSize(est.usage || 0)} / ${fmtSize(est.quota || 0)}` : '未知'}</span></div>
    <div class="li" data-persist><span class="ic">${ic('check', 'sm')}</span><span class="lt">持久存储<div style="font-size:11.5px;color:var(--text3)">开启后浏览器不会自动清理论文</div></span><span class="lv">${persisted ? '已开启' : '点按申请'}</span></div>
    <div class="li" data-expall><span class="ic">${ic('share', 'sm')}</span><span class="lt">导出全部笔记（Markdown）</span>${ic('right', 'xs')}</div>
    <div class="li" data-cleartrans><span class="ic">${ic('trans', 'sm')}</span><span class="lt">清除翻译缓存</span>${ic('right', 'xs')}</div>
  </div>
  <div class="group-t">应用</div>
  <div class="group">
    ${isStandalone() ? '' : `<div class="li" data-install><span class="ic">${ic('phone', 'sm')}</span><span class="lt">添加到主屏幕</span><span class="lv">${deferredInstall ? '安装' : '查看方法'}</span>${ic('right', 'xs')}</div>`}
    <div class="li"><span class="ic">${ic('wifi', 'sm')}</span><span class="lt">离线使用</span><span class="lv">${sw ? '已就绪' : '首次加载后可用'}</span></div>
    <div class="li" data-update><span class="ic">${ic('refresh', 'sm')}</span><span class="lt">检查更新</span><span class="lv">v${APPVER}</span></div>
  </div>
  <div class="foot">研读 · 本地优先的论文阅读器<br>论文、笔记与密钥都只保存在这台设备的浏览器中；清除浏览器数据会一并删除，请定期导出笔记。<br>PDF 渲染：pdf.js（Apache-2.0）</div>`;
}
function readForm() { return { base: $('#ai-base').value.trim(), key: $('#ai-key').value.trim(), model: $('#ai-model').value.trim(), lang: $('#ai-lang').value }; }
function aiStatus(msg, ok) { const el = $('#aiStatus'); if (el) { el.className = 'help ' + (ok === true ? 'status-ok' : ok === false ? 'status-err' : ''); el.style.margin = '8px 32px 0'; el.textContent = msg; } }
$('#v-me').addEventListener('click', async e => {
  const t = e.target.closest("#v-me [data-thm]"); if (t) { ST.theme = t.dataset.thm; saveST(); applyTheme(); onReaderThemeChange(); renderMe(); return; }
  const dm = e.target.closest('[data-dm]'); if (dm) { ST.defMode = dm.dataset.dm; saveST(); renderMe(); return; }
  const pr = e.target.closest('[data-preset]'); if (pr) { const p = PRESETS[+pr.dataset.preset]; $('#ai-base').value = p[1]; $('#ai-model').value = p[2]; aiStatus(`已填入 ${p[0]} 的接口地址和示例模型名，请填写 API Key 后保存。`); return; }
  if (e.target.closest('[data-showkey]')) { const k = $('#ai-key'); const show = k.type === 'password'; k.type = show ? 'text' : 'password'; e.target.closest('[data-showkey]').textContent = show ? '隐藏' : '显示'; return; }
  if (e.target.closest('[data-aisave]')) {
    const f = readForm();
    if (f.base && !/^https?:\/\//i.test(f.base)) return aiStatus('接口地址需以 https:// 或 http:// 开头', false);
    if (f.base && !f.model) return aiStatus('请填写模型名称', false);
    ai.setCfg(f); document.activeElement && document.activeElement.blur(); await renderMe(); aiStatus(f.base ? '已保存在本机。' : '已清空。', true); return;
  }
  if (e.target.closest('[data-aitest]')) {
    const f = readForm(); if (!f.base || !f.model) return aiStatus('请先填写接口地址和模型名称', false);
    const old = ai.getCfg(); ai.setCfg(f); aiStatus('正在测试…');
    try { const out = await ai.test(); aiStatus('连接成功，模型回复：' + out.slice(0, 40), true); }
    catch (err) { aiStatus('测试失败：' + (err.message || err), false); ai.setCfg(old); }
    return;
  }
  if (e.target.closest('[data-aiclear]')) { if (await confirmSheet('清除 AI 配置？', '接口地址、密钥和模型名将从本机删除。', '清除', true)) { ai.setCfg({}); renderMe(); toast('已清除'); } return; }
  if (e.target.closest('[data-persist]')) { try { const ok = await navigator.storage.persist(); toast(ok ? '已开启持久存储' : '浏览器未授予持久存储；添加到主屏幕后通常可开启'); } catch (er) { toast('当前浏览器不支持'); } renderMe(); return; }
  if (e.target.closest('[data-expall]')) { if (!LIB.hls.length) return toast('还没有划线笔记'); return exportAll(); }
  if (e.target.closest('[data-cleartrans]')) { await db.clear('trans'); toast('已清除翻译缓存'); return; }
  if (e.target.closest('[data-install]')) {
    if (deferredInstall) { deferredInstall.prompt(); const r = await deferredInstall.userChoice.catch(() => null); deferredInstall = null; if (r && r.outcome === 'accepted') toast('已添加到主屏幕'); renderMe(); return; }
    openSheet(`<h3>添加到主屏幕</h3><div class="help" style="font-size:14px;color:var(--text2);line-height:1.85;margin-top:0">
      ${isIOS() ? '<b>iPhone / iPad（Safari）：</b><br>1. 点底部的「分享」按钮<br>2. 选择「添加到主屏幕」<br>3. 点「添加」' : '<b>安卓（Chrome / Edge）：</b><br>1. 点右上角「⋮」菜单<br>2. 选择「安装应用」或「添加到主屏幕」<br><br>国产浏览器若没有该选项，请改用 Chrome 或 Edge 打开。'}
      <br><br>添加后可以全屏使用、离线打开，浏览器也更不容易清理本地数据。</div>`);
    return;
  }
  if (e.target.closest('[data-update]')) {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (!reg) return toast('离线功能尚未启用');
    toast('正在检查更新…'); await reg.update().catch(() => {});
    setTimeout(() => { if (!reg.waiting && !reg.installing) toast('已是最新版本'); }, 1500);
  }
});

/* ---------- Service Worker ---------- */
let wantReload = false;
function showUpdateBar(reg) {
  if (document.querySelector('.update-bar')) return;
  const bar = document.createElement('div'); bar.className = 'update-bar';
  bar.innerHTML = `${ic('refresh', 'sm')}<span>新版本已就绪</span><button>立即刷新</button>`;
  bar.querySelector('button').onclick = () => { wantReload = true; if (reg.waiting) reg.waiting.postMessage('skipWaiting'); else location.reload(); };
  phone.appendChild(bar);
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js'); if (!reg) return;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading || !wantReload) return; reloading = true; location.reload(); });
    } catch (e) { console.warn('SW 注册失败', e); }
  });
}

/* ---------- 启动 ---------- */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (ST.theme === 'auto') { applyTheme(); onReaderThemeChange(); } });
const fitWide = () => document.body.classList.toggle('wide', innerWidth >= 700);
addEventListener('resize', fitWide); fitWide();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !isReading()) reloadLib().then(renderTab); });
(async function boot() {
  applyTheme(); renderTabbar();
  try { await reloadLib(); } catch (e) { console.error(e); toast('无法打开本地数据库（隐私模式下可能不可用）', 5000); }
  renderLibrary();
  window.APP = { LIB, S, openReader, closeReader, switchTab, importFiles, renderLibrary, reloadLib };
})();
