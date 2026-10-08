// 重排引擎：从 pdf.js 文本内容中启发式重建阅读顺序、段落、标题、图表与公式区域。
// 纯函数模块，浏览器与 Node 均可运行（不直接依赖 pdf.js 包路径）。
export const REFLOW_VERSION = 6;

const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const letters = s => (s.match(/[A-Za-z\u00C0-\u024F\u4e00-\u9fff]/g) || []).length;
const nonspace = s => s.replace(/\s/g, '').length;
const cjkN = s => (s.match(/[\u4e00-\u9fff]/g) || []).length;
const isCJK = s => cjkN(s) / Math.max(1, nonspace(s)) > 0.3;
// 去掉汉字之间的空格（"摘 要" → "摘要"）
const CJK_SP = /([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g;
const squeeze = s => s.replace(CJK_SP, '$1');

/* ---------- 1. 每页：文本项 → 行 ---------- */
async function pageLines(page, pi) {
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.transform) continue;
    const t = mul(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    if (size < 1) continue;
    const rotated = Math.abs(t[1]) > 0.05 * Math.abs(t[0]) || t[0] <= 0;
    if (rotated) continue; // arXiv 侧边水印等旋转文本
    const w = it.width * (Math.hypot(t[0], t[1]) / Math.max(1e-6, Math.hypot(it.transform[0], it.transform[1])) || 1);
    items.push({ s: it.str, x: t[4], y: t[5], w: w, size });
  }
  const lines = [];
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };
  for (const it of items) {
    if (!it.s.trim()) { if (cur) { cur.pendingSpace = true; } continue; }
    if (/^[¨´`ˆ˜¸ˇ˙˚]$/.test(it.s.trim())) { if (cur && Math.abs(it.y - cur.y) < 1.3 * cur.size && it.x - cur.x1 < cur.size) { cur.text += it.s.trim(); cur.pendingSpace = false; } continue; }
    if (cur) {
      const sz = Math.max(cur.size, it.size);
      const dy = Math.abs(it.y - cur.y);
      const gap = it.x - cur.x1;
      const label = /^([IVX]{1,5}|[A-Z]|\d{1,2}(\.\d{1,2}){0,3}|[A-H](\.\d{1,2}){1,3})\.?$|^第\s*[0-9一二三四五六七八九十]{1,3}\s*章$|^附录\s*[A-Z0-9]?$|^(fig\.?|figure|table|tab\.)\s*([0-9]+|[IVX]+)[a-z]?[.:]?$/i.test(cur.text.trim());
      if (dy < 0.55 * sz && gap > -0.6 * sz && (gap < 1.1 * sz || (label && gap < 3.5 * sz))) {
        const needSpace = cur.pendingSpace || (gap > 0.14 * Math.min(cur.size, it.size) && !/\s$/.test(cur.text) && !/^\s/.test(it.s));
        cur.text += (needSpace ? ' ' : '') + it.s;
        cur.x1 = Math.max(cur.x1, it.x + it.w);
        cur.pendingSpace = false;
        // 主字号：取更长片段的字号；基线取主字号片段
        if (it.s.trim().length >= cur.mainLen) { cur.mainLen = it.s.trim().length; cur.size = it.size; cur.y = it.y; }
        cur.minTop = Math.min(cur.minTop, it.y - it.size * 0.85);
        cur.maxBot = Math.max(cur.maxBot, it.y + it.size * 0.25);
        continue;
      }
      flush();
    }
    cur = { text: it.s, x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, mainLen: it.s.trim().length, page: pi,
      minTop: it.y - it.size * 0.85, maxBot: it.y + it.size * 0.25, pendingSpace: false };
  }
  flush();
  for (const l of lines) { l.text = fixDiacritics(fixRadicals(l.text).replace(/\s+/g, ' ').trim()); delete l.pendingSpace; delete l.mainLen; }
  return { W, H, lines };
}

/* ---------- 2. 版式分析 ---------- */
const HEAD_KW = /^((\d{1,2}(\.\d)*\.?|[IVX]{1,5}\.)\s*)?(abstract|references|bibliography|acknowledge?ments?|introduction|conclusions?|discussion|appendix|keywords?|index terms|related work|methods?|results?|summary|contents|摘要|关键词|参考文献|引言|结论|致谢)\s*[:.：]?$/i;
const NUM_HEAD = /^(((\d{1,2}(\.\d{1,2}){0,3})\.?|[IVX]{1,5}\.|[A-H]\.|[A-H](\.\d{1,2}){1,3})\s+[A-Z\u4e00-\u9fff]|\d{1,2}(\.\d{1,2}){1,3}\s*[\u4e00-\u9fff]|[A-H](\.\d{1,2}){1,3}\s*[\u4e00-\u9fff]|[一二三四五六七八九十]{1,3}[、.．]\s*[\u4e00-\u9fff]|第\s*[0-9一二三四五六七八九十]{1,3}\s*[章节](\s|[\u4e00-\u9fff]|$))/;
// 中文学位论文的无编号标题（在去掉汉字间空格后匹配）
const CN_KW = /^(摘要|中文摘要|英文摘要|目录|主要符号对照表|主要符号表|符号说明|符号对照表|插图索引|表格索引|插图目录|附图目录|图目录|表目录|插图清单|附表清单|图表目录|引言|绪论|前言|结论|结论与展望|总结与展望|全文总结|致谢|谢辞|参考文献|主要参考文献|附录[A-Z0-9一二三四五六七八九十]?(\s.{1,40}|[\u4e00-\u9fff].{0,40})?|(个人简历|作者简介|作者简历|攻读|在学期间|在读期间|学位论文数据集|声明).{0,40})$/;
const CHAPTER = /^第\s*[0-9一二三四五六七八九十]{1,3}\s*章/;
const LEADER = /(\.\s?){4,}\s*[\divxlcIVXLC]*$|…{2,}|·{4,}|(\.\s?){6,}/;
const BULLET = /^[•·▪◦●○■□◆◇►▸‣⁃–—\-*]\s?/;
const CAPTION = /^((fig\.?|figure|table|tab\.)\s*([0-9]+|[IVX]+)[a-z]?(\s*[.:|：]|\s*$)|(图|表)\s*([0-9]+|[IVX]+)[a-z]?(\s*[.:|：]|\s*$)|(图|表|续表)\s*[0-9]{1,2}\s*[.\-–－]\s*[0-9]{1,3}[a-z]?(\s|[\u4e00-\u9fffA-Za-z(（:：]|$))/i;
// 正文开始的标志行（用于跳过学位论文封面、声明页里的"大字"）
const START = /^(摘要|中文摘要|abstract|目录|contents|tableofcontents|第[1一]章|引言|绪论|前言|introduction|1\.?(introduction|引言|绪论|概述|前言)|[iⅠ]\.?introduction)$/i;

export async function extractReflow(pdf, onProgress) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    pages.push(await pageLines(page, i));
    page.cleanup && page.cleanup();
    onProgress && onProgress(i / pdf.numPages);
  }
  return analyze(pages);
}

export function analyze(pages) {
  const all = pages.flatMap(p => p.lines);
  // 正文字号：按字符数加权的众数
  const hist = {};
  for (const l of all) { const k = Math.round(l.size * 2) / 2; hist[k] = (hist[k] || 0) + l.text.length; }
  const body = +Object.entries(hist).sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

  // 页眉页脚：页面上下边缘、跨页重复（数字归一化）或纯页码
  const norm = s => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const edgeCount = {};
  pages.forEach(p => {
    const seen = new Set();
    p.lines.forEach(l => { if (l.y < p.H * 0.085 || l.y > p.H * 0.885) { const k = norm(l.text); if (!seen.has(k)) { seen.add(k); edgeCount[k] = (edgeCount[k] || 0) + 1; } } });
  });
  const minRep = Math.max(2, Math.ceil(pages.length * 0.3));
  pages.forEach(p => {
    p.lines = p.lines.filter(l => {
      const edge = l.y < p.H * 0.085 || l.y > p.H * 0.885;
      if (!edge) return true;
      const t = l.text.trim();
      // 页眉（顶部、字号小于正文，如"同济大学 博士学位论文 第4章 …"）
      if (l.y < p.H * 0.085 && l.size < body * 0.95 && pages.length > 2 && !/^\[\d+\]/.test(t)) {
        const below = p.lines.filter(o => o.y > l.y + 0.5).reduce((m, o) => Math.min(m, o.y - l.y), Infinity);
        if (below > body * 1.8) return false;
      }
      if (/^(page\s*)?[#\d]{1,4}(\s*(of|\/)\s*\d+)?$/i.test(t) || /^[ivxlc]{1,6}$/i.test(t) || /^[-–—]\s*\d+\s*[-–—]$/.test(t)) return false;
      if (edgeCount[norm(t)] >= minRep && pages.length > 2) return false;
      if (/preprint submitted to|arxiv:\d{4}\.\d{4,5}|^(downloaded|authorized licensed|this article has been accepted|copyright|©)/i.test(t)) return false;
      if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}$/i.test(t)) return false;
      return true;
    });
  });

  // 行距估计
  const gaps = [];
  pages.forEach(p => { const ls = p.lines.filter(l => Math.abs(l.size - body) < 0.6); for (let i = 1; i < ls.length; i++) { const d = ls[i].y - ls[i - 1].y; if (d > body * 0.9 && d < body * 2) gaps.push(d); } });
  const LS = median(gaps) || body * 1.2;

  // 正文起始页：学位论文封面/声明页上的大字不作为标题
  let startPage = 0;
  for (let i = 0; i < pages.length && i < 30; i++) {
    if (pages[i].lines.some(l => l.text.length < 40 && START.test(squeeze(l.text).replace(/\s+/g, '').replace(/[:：]$/, '')) || /^abstract\s*[—–:-]/i.test(l.text))) { startPage = i; break; }
  }

  const out = [];
  let bid = 0;
  const push = b => { b.id = 'b' + (bid++); out.push(b); return b; };
  let inRefs = false, frontDone = false, titleDone = false, refsNumbered = null;
  let para = null, lastHead = null;

  pages.forEach((p, pi) => {
    const { W, H } = p;
    const mid = W / 2;
    // 列分类
    for (const l of p.lines) {
      l.col = l.x1 <= mid + W * 0.012 ? 'L' : l.x0 >= mid - W * 0.012 ? 'R' : 'S';
    }
    const longL = p.lines.filter(l => l.col === 'L' && l.x1 - l.x0 > W * 0.28).length;
    const longR = p.lines.filter(l => l.col === 'R' && l.x1 - l.x0 > W * 0.28).length;
    const twoCol = longL >= 4 && longR >= 4;
    if (!twoCol) p.lines.forEach(l => (l.col = 'F'));
    // 列边界（正文行 x0 众数 / x1 最大分位）
    const colInfo = {};
    for (const c of ['L', 'R', 'S', 'F']) {
      const ls = p.lines.filter(l => l.col === c && Math.abs(l.size - body) < 0.8);
      const x0s = ls.map(l => Math.round(l.x0));
      const cnt = {}; x0s.forEach(x => (cnt[x] = (cnt[x] || 0) + 1));
      const left = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || (c === 'R' ? mid : 0);
      const x1s = ls.map(l => l.x1).sort((a, b) => a - b);
      const right = x1s.length ? x1s[Math.floor(x1s.length * 0.9)] : (c === 'L' ? mid : W);
      colInfo[c] = { left, right };
    }
    if (twoCol) {
      const sl = p.lines.filter(l => l.col === 'S' && Math.abs(l.size - body) < 0.8);
      if (sl.length >= 3) { const xs = sl.map(l => Math.round(l.x0)); const c2 = {}; xs.forEach(x => (c2[x] = (c2[x] || 0) + 1)); colInfo.S = { left: +Object.entries(c2).sort((a, b) => b[1] - a[1])[0][0], right: Math.max(...sl.map(l => l.x1)) }; }
      else colInfo.S = { left: colInfo.L.left, right: colInfo.R.right };
    }
    const ci = l => colInfo[l.col];
    // 标题续行：上一行写到行尾（自动换行），或两行都居中
    const centeredIn = l => { const c = ci(l); return l.x0 > c.left + body * 1.5 && Math.abs((l.x0 + l.x1) / 2 - (c.left + c.right) / 2) < body * 2; };
    const midOf = l => (l.x0 + l.x1) / 2;
    const wrapped = (a, b) => a.x1 > ci(a).right - body * 3 || (centeredIn(b) && Math.abs(midOf(a) - midOf(b)) < body * 2);
    const prevCont = l => p.lines.some(o => o !== l && o.col === l.col && o.y < l.y && l.y - o.y < LS * 1.4 && o.x1 > (colInfo[o.col] || colInfo.F || { right: W }).right - body * 1.6 && !/[.:?!。！？：；]$/.test(o.text) && Math.abs(o.size - body) < 0.8);
    const rowOf = l => p.lines.filter(o => Math.abs(o.y - l.y) < l.size * 0.5 && (o.col === l.col || !twoCol));
    const leaderRow = l => LEADER.test(l.text) || rowOf(l).some(o => LEADER.test(o.text));
    const isCap = l => CAPTION.test(l.text) && l.text.length > 4 && !leaderRow(l) && capPos(l) && !prevCont(l);
    const capPos = l => { const c = ci(l); return l.col === 'S' || l.col === 'F' || Math.abs(l.x0 - c.left) < body * 3 || Math.abs((l.x0 + l.x1) / 2 - (c.left + c.right) / 2) < body * 2.5; };
    const bodyLike = l => Math.abs(l.size - body) < 0.7 && (l.x1 - l.x0) > (ci(l).right - ci(l).left) * 0.6 && letters(l.text) / Math.max(1, nonspace(l.text)) > 0.7;

    // 图表区域：根据题注向上（图）或向下（表）搜索
    // 段落末行（较短但紧接在正文行之后、左对齐）也视为正文，避免被裁进图里
    const tailLike = o => Math.abs(o.size - body) < 0.7 && Math.abs(o.x0 - ci(o).left) < body * 1.2 && letters(o.text) / Math.max(1, nonspace(o.text)) > 0.7 && p.lines.some(q => q !== o && q.col === o.col && q.y < o.y && o.y - q.y < LS * 1.4 && bodyLike(q));
    const regions = [];
    // 编号标题行（左对齐、无同行其它单元格）不能被裁进图表区域
    const headStop = o => (NUM_HEAD.test(o.text) || CHAPTER.test(o.text)) && o.text.length < 60 && !/[，。；=]/.test(o.text) && Math.abs(o.x0 - ci(o).left) < body * 1.5
      && !p.lines.some(q => q !== o && Math.abs(q.y - o.y) < o.size * 0.5 && q.col === o.col);
    const caps = p.lines.filter(isCap);
    const xrOf = l => (l.col === 'S' || l.col === 'F') ? [colInfo[l.col].left, colInfo[l.col].right] : [ci(l).left, ci(l).right];
    const scope = l => p.lines.filter(o => o !== l && (o.col === l.col || (l.col === 'S' && o.col !== 'S') || o.col === 'S' || l.col === 'F'));
    const capBottom = l => { let cb = l.maxBot; for (const o of p.lines.filter(o => o.col === l.col && o.y > l.y).sort((a, b) => a.y - b.y)) { if (o.y - cb < LS * 1.3 && Math.abs(o.size - l.size) < 0.6 && !isCap(o)) cb = o.maxBot; else break; } return cb; };
    const regAbove = l => { const xr = xrOf(l); let lim = H * 0.06; for (const o of scope(l)) if (o.y < l.minTop && (bodyLike(o) || tailLike(o) || isCap(o) || headStop(o)) && o.maxBot > lim && overlapX(o, xr)) lim = o.maxBot; return [xr[0] - 4, lim + 2, xr[1] + 4, l.minTop - 2]; };
    const regBelow = (l, cb) => { const xr = xrOf(l); let lim = H * 0.94; for (const o of scope(l)) if (o.y > cb && (bodyLike(o) || isCap(o) || headStop(o)) && o.minTop < lim && overlapX(o, xr)) lim = o.minTop; return [xr[0] - 4, cb + 2, xr[1] + 4, lim - 2]; };
    const linesIn = bb => p.lines.filter(o => o.y > bb[1] && o.y < bb[3] && o.x0 >= bb[0] - 2 && o.x1 <= bb[2] + 2).length;
    const overlaps = bb => regions.some(r => Math.min(r.bbox[3], bb[3]) - Math.max(r.bbox[1], bb[1]) > 10 && Math.min(r.bbox[2], bb[2]) - Math.max(r.bbox[0], bb[0]) > 10);
    // 先处理图（题注在下），再处理表（题注在上或在下）
    for (const l of caps.filter(c => !/^(table|tab\.|表)/i.test(c.text))) {
      const bb = regAbove(l);
      if (bb[3] - bb[1] > 30 && !overlaps(bb)) regions.push({ cap: l, above: true, bbox: bb });
    }
    for (const l of caps.filter(c => /^(table|tab\.|表)/i.test(c.text))) {
      const cb = capBottom(l);
      const up = regAbove(l), dn = regBelow(l, cb);
      const upOk = up[3] - up[1] > 25 && !overlaps(up) && linesIn(up) >= 2;
      const dnOk = dn[3] - dn[1] > 25 && !overlaps(dn) && linesIn(dn) >= 2;
      if (dnOk && (!upOk || linesIn(dn) >= linesIn(up))) regions.push({ cap: l, table: true, capBot: cb, bbox: dn });
      else if (upOk) regions.push({ cap: l, above: true, isTable: true, bbox: up });
    }
    const inRegion = l => regions.some(r => l.y > r.bbox[1] && l.y < r.bbox[3] + 1 && l.x0 >= r.bbox[0] - 2 && l.x1 <= r.bbox[2] + 2 && !r.capLines?.includes(l));
    // 表题注的多行不能被当成表内容
    regions.forEach(r => { if (r.table) r.capLines = p.lines.filter(o => o.col === r.cap.col && o.y >= r.cap.y && o.y <= r.capBot); });
    let lines = p.lines.filter(l => !inRegion(l));

    // 阅读顺序：通栏行切分区段，区段内先左列后右列
    let ordered;
    if (twoCol) {
      const S = lines.filter(l => l.col === 'S').sort((a, b) => a.y - b.y);
      const cols = lines.filter(l => l.col !== 'S');
      ordered = [];
      let prevY = -1;
      const emit = (y0, y1) => {
        const seg = cols.filter(l => l.y > y0 && l.y <= y1);
        ordered.push(...seg.filter(l => l.col === 'L').sort((a, b) => a.y - b.y || a.x0 - b.x0));
        ordered.push(...seg.filter(l => l.col === 'R').sort((a, b) => a.y - b.y || a.x0 - b.x0));
      };
      for (const s of S) { emit(prevY, s.y - 0.01); ordered.push(s); prevY = s.y; }
      emit(prevY, Infinity);
    } else ordered = lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);

    // 插入图表块：放在题注前（图）或题注后（表）——以题注行为锚点
    const regByCap = new Map(regions.map(r => [r.cap, r]));

    // 首页：标题与作者信息
    if (pi === 0 && !titleDone) {
      const top = ordered.filter(l => l.y < H * 0.4 && letters(l.text) > 3 && !/arxiv|preprint|journal|vol\.|doi|issn|http|proceedings/i.test(l.text));
      const maxSize = Math.max(...top.map(l => l.size), 0);
      if (maxSize > body * 1.15) {
        const tl = top.filter(l => l.size > maxSize - 0.6);
        const first = tl[0];
        const titleLines = tl.filter(l => Math.abs(l.y - first.y) < maxSize * 4.5);
        push({ type: 'title', text: titleLines.map(l => l.text).join(' ').replace(/\s+/g, ' '), page: pi + 1, top: Math.min(...titleLines.map(l => l.minTop)) });
        titleLines.forEach(l => (l.used = true));
        titleDone = true;
      }
    }

    // 段落构建（para 跨页保持，以便段落跨页续接）
    const endPara = () => { if (para) { finalizePara(para); para = null; } };
    const finalizePara = b => {
      b.text = b.text.replace(/\s+/g, ' ').trim();
      if (!b.text) { out.splice(out.indexOf(b), 1); return; }
    };
    const startPara = (type, l) => { endPara(); para = push({ type, text: l.text, page: pi + 1, y: l.y, last: l, col: l.col, top: l.minTop, bot: l.maxBot, x0: l.x0, x1: l.x1, centered: l.x0 > ci(l).left + body * 1.5 && l.x1 < ci(l).right - body }); return para; };
    let mathRun = null;
    const endMath = () => { if (mathRun) { const r = mathRun; push({ type: 'eq', page: pi + 1, col: r.col, bbox: [r.x0 - 6, r.top - 3, r.x1 + 6, r.bot + 3], text: r.text.join(' ') }); mathRun = null; } };

    for (let i = 0; i < ordered.length; i++) {
      const l = ordered[i];
      if (l.used) continue;
      const col = ci(l);
      const t = l.text;
      const reg = regByCap.get(l);
      const len = t.length;
      const lr = letters(t) / Math.max(1, nonspace(t));
      const tb = t.replace(/^(第\s*[0-9一二三四五六七八九十]{1,3}\s*[章节]|[A-H]?[\d.]+|[A-H]\.|附录\s*[A-Z0-9]?)\s*/, '');
      const lrH = letters(tb) / Math.max(1, nonspace(tb)); // 去掉编号后的字母占比
      const colW = col.right - col.left;

      // 首页正文前（作者、单位等）：标题之后、首个标题/Abstract 之前
      if (pi === 0 && !frontDone && titleDone && l.y < H * 0.55) {
        if (HEAD_KW.test(t) || NUM_HEAD.test(t) && len < 60 || /^(abstract|a b s t r a c t)/i.test(t)) { frontDone = true; }
        else if (l.size >= body * 0.75) {
          if (para && para.type === 'front' && l.y - para.last.y < LS * 2.6) { para.text += ' · ' + t; para.last = l; }
          else startPara('front', l);
          continue;
        }
      }
      // 目录 / 图表索引行（带引导点）：整行合并为一条小字
      if (leaderRow(l)) {
        endMath(); endPara();
        const row = rowOf(l).filter(o => !o.used).sort((a, b) => a.x0 - b.x0); row.forEach(o => (o.used = true));
        const txt = row.map(o => o.text).join(' ').replace(/(\s?[.·…]\s?){3,}/g, ' … ').replace(/\s+/g, ' ').trim();
        startPara('small', l); para.text = txt; endPara();
        continue;
      }
      // 图（题注上方）
      if (reg && reg.above) { endPara(); endMath(); const fb = push({ type: 'figure', page: pi + 1, bbox: reg.bbox }); if (reg.isTable) fb.table = true; }

      // 题注
      if (isCap(l)) {
        endMath(); startPara('caption', l);
        if (reg && reg.table) { para.afterTable = reg; }
        continue;
      }
      // 公式：居中、字母占比低、或带编号
      const eqNo = /\(\s*[A-Z]?\d{1,3}[a-z]?\s*\)$/.test(t) && l.x1 > col.right - body * 2.5 && (l.x0 > col.left + body * 1.5 || lr < 0.6);
      const centered = l.x0 > col.left + body * 1.5 && l.x1 < col.right - body * 1.0;
      const mathy = (lr < 0.55 && nonspace(t) > 0) || eqNo || (centered && lr < 0.78 && len < 90 && /[=+−\-∑∫∂≈≤≥×·∇∈∝λπθφωαβγδεμσ()]/.test(t) && !/[.!?]$/.test(t)) || (centered && len < 24 && /[=+−×÷∑∫]/.test(t) && !/^[IVX]+\.\s/.test(t));
      const fragment = len <= 4 && lr < 0.9 && !/^\[?\d+\]?$/.test(t);
      const paraTail = para && (para.type === 'p' || para.type === 'small') && l.x0 < col.left + body * 0.8 && !eqNo && lr >= 0.3 && para.last.x1 > (colInfo[para.last.col] || col).right - body * 2;
      const headLike = (NUM_HEAD.test(t) || HEAD_KW.test(t) || CHAPTER.test(t)) && lrH > 0.6 && len < 90 && !/[，。；=]/.test(t);
      if (!inRefs && !paraTail && !headLike && (mathy || (fragment && mathRun)) && l.size < body * 1.3) {
        endPara();
        const top = l.minTop, bot = l.maxBot;
        if (mathRun && l.col === mathRun.col && top - mathRun.bot < LS * 1.2) {
          mathRun.x0 = Math.min(mathRun.x0, l.x0); mathRun.x1 = Math.max(mathRun.x1, l.x1); mathRun.bot = Math.max(mathRun.bot, bot); mathRun.top = Math.min(mathRun.top, top); mathRun.text.push(t);
        } else { endMath(); mathRun = { col: l.col, x0: Math.min(l.x0, col.left + (l.col === 'F' ? 0 : 0)), x1: Math.max(l.x1, col.right), top, bot, text: [t] }; mathRun.x0 = col.left; }
        continue;
      }
      if (fragment && !para) { continue; } // 孤立碎片（图内标注等）

      // 标题
      const cjk = isCJK(t), sq = squeeze(t);
      const short = cjk ? l.x1 < col.right - body * 1.5 : (l.x1 < col.right - body * 3 || len < 60);
      const bigger = l.size > body * 1.12;
      const noHead = LEADER.test(t) || BULLET.test(t) || /[{}\\=%]|[A-Za-z]_|_[A-Za-z]|\(\)/.test(t) || (pi < startPage) || /[：]|\s:\s?|\s:$/.test(t) && !NUM_HEAD.test(t)
        || p.lines.some(o => o !== l && o.col === l.col && Math.abs(o.y - l.y) < l.size * 0.5 && (o.x0 > l.x1 + body * 1.5 || o.x1 < l.x0 - body * 1.5));
      const cjkPunct = cjk && /[，。；！？]/.test(t);
      const chap = CHAPTER.test(t) && short && !cjkPunct && len < 60;
      const singleDotCJK = /^\d{1,2}\.\s*[\u4e00-\u9fff]/.test(t) && !/^\d{1,2}\.\d/.test(t);
      const numHead = !noHead && NUM_HEAD.test(t) && len < 90 && short && !/[.,;:，。；：]$/.test(t) && lrH > 0.6 && !cjkPunct && (!singleDotCJK || bigger);
      const kwHead = !noHead && (HEAD_KW.test(t) && len < 50 || (/^(Appendix|APPENDIX)\s+[A-Z0-9]{1,2}\b\s*[:.—–-]?\s*[A-Z]/.test(t) && len < 90 && short && !/[.,;]$/.test(t)) || (cjk && CN_KW.test(sq.replace(/\s+(?=[\u4e00-\u9fff])/g, '')) && short && !cjkPunct));
      const ups = (t.match(/[A-Z]/g) || []).length, lows = (t.match(/[a-z]/g) || []).length;
      const capsHead = !noHead && !cjk && (/\s/.test(t.trim()) || len >= 8) && ups >= 4 && lows <= ups * 0.15 && len < 80 && (l.x0 > col.left + body * 1.5 || /^[IVX]{1,5}\.\s/.test(t)) && lr > 0.6 && !/[=+−×÷<>/]/.test(t) && /[A-Z]{3,}/.test(t);
      const bigHead = !noHead && bigger && len < 160 && lr > 0.5 && (!cjk || ((len < 40 || chap) && !/[，。；！？：]/.test(t) && (short || l.size > body * 1.3)));
      const contLikely = para && para.type === 'p' && para.last.col === l.col && para.last.page === l.page && l.y - para.last.y < LS * 1.35 && para.last.x1 > (colInfo[para.last.col] || col).right - body * 1.6 && !/[.:?!。！？：；]$/.test(para.last.text);
      if (bigHead || chap && !noHead || ((numHead || kwHead || capsHead) && !contLikely)) {
        endMath();
        // 多行大字号标题合并
        if (para && para.type.startsWith('h') && bigger && Math.abs(para.last.size - l.size) < 0.4 && l.y - para.last.y < l.size * 1.8 && para.page === pi + 1 && !NUM_HEAD.test(t) && !CHAPTER.test(t)) {
          para.text += (cjk ? '' : ' ') + t; para.last = l; continue;
        }
        if (lastHead && lastHead.l.page === l.page && lastHead.l.col === l.col && l.y - lastHead.l.y < LS * 1.7 && l.y > lastHead.l.y && !NUM_HEAD.test(t) && !CHAPTER.test(t) && Math.abs(lastHead.l.size - l.size) < 0.5 && wrapped(lastHead.l, l)) { lastHead.b.text += (cjk ? '' : ' ') + t; lastHead.l = l; continue; }
        const lvl = /^\d+\.\d+/.test(t) || /^[A-H](\.\d{1,2}){1,3}/.test(t) || /^[A-H]\.\s/.test(t) || /^第\s*[0-9一二三四五六七八九十]{1,3}\s*节/.test(t) ? 'h3' : 'h2';
        startPara(lvl, l); lastHead = { b: para, l };
        if (/^(references|bibliography|参考文献|主要参考文献)/i.test(sq)) { inRefs = true; refsNumbered = null; }
        else if (inRefs && lvl === 'h2') inRefs = /^(appendix|acknowledg|附录|致谢|谢辞|个人简历|作者简|攻读|在学期间|在读期间|第\s*[0-9一二三四五六七八九十]+\s*章|\d{1,2}\.?\s)/i.test(sq) ? false : inRefs;
        frontDone = true;
        endPara();
        continue;
      }
      if (lastHead && lastHead.l.page === l.page && lastHead.l.col === l.col && l.y > lastHead.l.y && l.y - lastHead.l.y < LS * 1.5 && len < 60 && wrapped(lastHead.l, l) && centeredIn(l) && Math.abs(lastHead.l.size - l.size) < 0.5 && !/[.。，]$/.test(t)) { lastHead.b.text += ' ' + t; lastHead.l = l; continue; }
      lastHead = null;
      endMath();
      const small = l.size < body * 0.88;
      const type = inRefs ? 'ref' : small ? 'small' : 'p';
      if (para && (para.type === type || (para.type === 'caption' && Math.abs(l.size - para.last.size) < 0.6)) && !para.type.startsWith('h') && para.type !== 'front') {
        const prev = para.last;
        const pcol = colInfo[prev.col] || col;
        const samePage = para.page === pi + 1 || prev.page === l.page;
        const sameCol = prev.col === l.col && prev.page === l.page;
        const vgap = l.y - prev.y;
        const indent = l.x0 > col.left + body * 0.7 && l.x0 < col.left + body * 3.5;
        const prevFull = prev.x1 > pcol.right - body * 1.6;
        const prevEnds = /[.:?!。]["”')\]]?$/.test(prev.text);
        let cont;
        if (type === 'ref') {
          if (refsNumbered === null) refsNumbered = /^\s*\[\d+\]/.test(para.text);
          const newRef = refsNumbered ? /^\s*\[\d+\]/.test(t) : (/^\s*(\d+\.\s|[A-Z][A-Za-z'’\-]+,\s+[A-Z]\.)/.test(t) && !indent);
          cont = !newRef && (sameCol ? vgap < LS * 1.6 : true);
        } else if (para.type === 'caption') {
          cont = sameCol && vgap < LS * 1.5 && Math.abs(l.size - prev.size) < 0.6;
        } else if (sameCol) {
          cont = vgap > 0 && vgap < LS * 1.45 && !(indent && prevFull && prevEnds) && !(indent && !prevFull) && !(!prevFull && prevEnds) && Math.abs(l.size - prev.size) < 0.7;
          if (indent && prevEnds) cont = false;
        } else {
          // 跨列 / 跨页：上一行写满且未以句号结束（或下一行以小写开头）则续接
          cont = (prevFull && !indent) && (!prevEnds || /^[a-z(]/.test(t));
        }
        if (cont) { para.text = joinLines(para.text, t); para.last = l; para.bot = Math.max(para.bot, l.maxBot); para.x0 = Math.min(para.x0, l.x0); para.x1 = Math.max(para.x1, l.x1); para.centered = false; continue; }
      }
      startPara(type, l);
      // 表在题注后
    }
    endMath();
    // 表格区域：插到对应题注之后
    for (const r of regions.filter(r => r.table)) {
      const idx = out.findIndex(b => b.type === 'caption' && b.page === pi + 1 && b.afterTable === r);
      const tb = { type: 'figure', table: true, page: pi + 1, bbox: r.bbox, id: 'b' + (bid++) };
      if (idx >= 0) out.splice(idx + 1, 0, tb); else out.push(tb);
    }
  });

  if (para) { para.text = para.text.replace(/\s+/g, ' ').trim(); para = null; }
  // 公式合并：相邻公式块、以及夹在公式旁的短行（分式的分子分母、上下标行）
  for (let k = 0; k < out.length; k++) {
    const E = out[k];
    if (E.type !== 'eq') continue;
    let changed = true;
    while (changed) {
      changed = false;
      for (const dir of [-1, 1]) {
        const j = k + dir, N = out[j];
        if (!N || N.page !== E.page) continue;
        const nTop = N.bbox ? N.bbox[1] : N.top, nBot = N.bbox ? N.bbox[3] : N.bot;
        if (nTop == null) continue;
        const dist = Math.max(nTop - E.bbox[3], E.bbox[1] - nBot);
        if (dist > LS * 0.9) continue;
        let ok = false;
        if (N.type === 'eq' && N.col === E.col) ok = true;
        else if ((N.type === 'p' || N.type === 'small') && N.col === E.col && N.text.length < 48 && (N.centered || ((letters(N.text) / Math.max(1, nonspace(N.text)) < 0.8 || N.text.length < 22) && !/[.:]$/.test(N.text))) || ((N.type === 'p' || N.type === 'small') && /^[a-zα-ω]?\s?[δ∂]?[a-z]{0,3}\.?$/.test(N.text.trim()))) ok = N.col === E.col;
        if (!ok) continue;
        E.bbox = [Math.min(E.bbox[0], N.bbox ? N.bbox[0] : N.x0 - 6), Math.min(E.bbox[1], nTop - 2), Math.max(E.bbox[2], N.bbox ? N.bbox[2] : N.x1 + 6), Math.max(E.bbox[3], nBot + 2)];
        E.text = (dir < 0 ? (N.text || '') + ' ' + E.text : E.text + ' ' + (N.text || ''));
        out.splice(j, 1); if (dir < 0) k--; changed = true; break;
      }
    }
  }
  // 清理：过短的孤立块（图内残留文字）
  const cleaned = out.filter(b => {
    if (b.type === 'p' || b.type === 'small') {
      if (b.text.length < 25 && !/[.:?!]$/.test(b.text) && letters(b.text) < 15) return false;
    }
    return true;
  }).map(b => { const o = { id: b.id, type: b.type, page: b.page }; if (b.text) o.text = /^(h2|h3|title)$/.test(b.type) ? squeeze(b.text).replace(/^(第\s*[0-9一二三四五六七八九十]{1,3}\s*[章节])(?=\S)/, '$1 ') : b.text; if (b.bbox) { const [PW, PH] = [pages[b.page - 1].W, pages[b.page - 1].H]; o.bbox = [Math.max(0, b.bbox[0]), Math.max(0, b.bbox[1]), Math.min(PW, b.bbox[2]), Math.min(PH, b.bbox[3])].map(v => Math.round(v * 10) / 10); } if (b.table) o.table = true; const top = b.bbox ? b.bbox[1] : b.top; if (top != null && isFinite(top)) o.y = Math.max(0, Math.round(top * 10) / 10); return o; });
  return { version: REFLOW_VERSION, body, blocks: cleaned, pages: pages.map(p => [Math.round(p.W), Math.round(p.H)]) };
}

// 部分 PDF（如 Chrome/Word 导出的思源字体）把常用汉字映射成康熙部首（⼟ ⽂ ⽬ …），统一回标准汉字
const RAD2 = '⺠民⺟母⻄西⻅见⻆角⻉贝⻋车⻓长⻔门⻘青⻚页⻛风⻜飞⻝食⻢马⻣骨⻤鬼⻥鱼⻦鸟⻨麦⻩黄⻬齐⻮齿⻰龙⻳龟⻭齿⺁厂⺇几⺈刀⺊卜⺋卩⺍小⺗心⺝月⺩王⺪疋⺫目⺬示⺮竹⺶羊⺸羊⺻聿⺼肉⻊足⻌辶⻍辶⻏阝⻖阝';
const RADMAP = {}; for (let i = 0; i < RAD2.length; i += 2) RADMAP[RAD2[i]] = RAD2[i + 1];
export const fixRadicals = t => t.replace(/[\u2e80-\u2fdf]/g, c => RADMAP[c] || c.normalize('NFKC'));
const COMB = { '¨': '\u0308', '´': '\u0301', '`': '\u0300', 'ˆ': '\u0302', '˜': '\u0303', '¸': '\u0327', 'ˇ': '\u030C', '˙': '\u0307', '˚': '\u030A' };
export function fixDiacritics(t) {
  return t.replace(/([A-Za-z]) ([¨´`ˆ˜ˇ˙˚])(?=[A-Za-zı])/g, '$1$2').replace(/([¨´`ˆ˜ˇ˙˚])\s?([A-Za-zı])/g, (m, acc, ch) => ((ch === 'ı' ? 'i' : ch) + COMB[acc]).normalize('NFC'))
          .replace(/([A-Za-z])\s?¸/g, (m, ch) => (ch + COMB['¸']).normalize('NFC'));
}
function overlapX(o, xr) { return Math.min(o.x1, xr[1]) - Math.max(o.x0, xr[0]) > 10; }

export function joinLines(a, b) {
  a = a.replace(/\s+$/, '');
  if (/[A-Za-z]\u00AD$/.test(a)) return a.slice(0, -1) + b;
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // 断词连字符
  if (/-$/.test(a) && /^[A-Z0-9]/.test(b)) return a + b;
  if (/[A-Z0-9]-$/.test(a) && /^[a-z]/.test(b)) return a + b; // 如 Y-shaped、F1-score
  if (/[\u4e00-\u9fff，。；：、]$/.test(a) && /^[\u4e00-\u9fff]/.test(b)) return a + b; // 中文不加空格
  return a + ' ' + b;
}

/* ---------- 元数据猜测 ---------- */
export async function guessMeta(pdf, filename) {
  let title = '', authors = '', year = '';
  try {
    const md = await pdf.getMetadata();
    const info = md.info || {};
    const t = (info.Title || '').trim();
    if (t && t.length > 8 && !/^(untitled|microsoft word|document|paper|title|about:|https?:|file:|\S+\.(docx?|pdf|tex|dvi))/i.test(t) && letters(t) > 6) title = t;
    const a = (info.Author || '').trim();
    if (a && a.length > 2 && !/^(author|user|admin|administrator)$/i.test(a)) authors = a.replace(/[*∗]/g, '').replace(/\s*;\s*/g, ', ').replace(/,\s*$/, '');
    const d = info.CreationDate || '';
    const m = d.match(/D:(\d{4})/); if (m) year = m[1];
  } catch (e) {}
  try {
    const page = await pdf.getPage(1);
    const { H, lines } = await pageLines(page, 1);
    const top = lines.filter(l => l.y < H * 0.5 && letters(l.text) > 3 && !/arxiv|preprint|journal|vol\.|doi|issn|http/i.test(l.text));
    if (top.length) {
      const maxSize = Math.max(...top.map(l => l.size));
      const tl = top.filter(l => l.size > maxSize - 0.6);
      const first = tl[0];
      const tlines = tl.filter(l => Math.abs(l.y - first.y) < maxSize * 4.5);
      const guess = squeeze(tlines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim());
      if (!title && guess.length > 8) title = guess;
      if (!authors) {
        const lastY = Math.max(...tlines.map(l => l.y));
        const after = top.filter(l => l.y > lastY && l.y < lastY + maxSize * 6 && l.size < maxSize - 0.6 && !/^(abstract|university|department|school|institute|\d)/i.test(l.text));
        if (after.length) authors = after[0].text.replace(/[*∗†‡§¶]|\d+(,\d+)*(?=\s|,|$)/g, '').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    }
    const all = lines.map(l => l.text).join(' ');
    const ax = all.match(/arXiv:(\d{4}\.\d{4,5})(v\d+)?/);
    if (ax && !year) year = '20' + ax[1].slice(0, 2);
  } catch (e) {}
  if (!title) title = (filename || '未命名论文').replace(/\.pdf$/i, '');
  return { title, authors, year };
}
