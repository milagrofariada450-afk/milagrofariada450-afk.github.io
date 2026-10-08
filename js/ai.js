// 可插拔 AI：OpenAI 兼容的 /chat/completions。配置只存 localStorage，不内置任何密钥。
import * as db from './db.js';
const KEY = 'yandu.ai';
export function getCfg() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
export function setCfg(c) { localStorage.setItem(KEY, JSON.stringify(c)); }
export function hasAI() { const c = getCfg(); return !!(c.base && c.model); }

export async function chat(messages, { signal, maxTokens } = {}) {
  const c = getCfg();
  if (!hasAI()) throw new Error('NO_CONFIG');
  const url = c.base.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (c.key) headers.Authorization = 'Bearer ' + c.key;
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify({ model: c.model, messages, temperature: 0.2, ...(maxTokens ? { max_tokens: maxTokens } : {}) }) });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('无法连接到接口（网络错误或该服务不允许浏览器跨域调用）');
  }
  if (!r.ok) {
    let msg = ''; try { const j = await r.json(); msg = j.error?.message || JSON.stringify(j).slice(0, 160); } catch (e) { msg = r.statusText; }
    throw new Error(`接口返回 ${r.status}：${msg}`);
  }
  const j = await r.json();
  const out = j.choices?.[0]?.message?.content;
  if (typeof out !== 'string') throw new Error('接口返回格式不符合 OpenAI 兼容规范');
  return out.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '').trim();
}

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length; };
const cjkRatio = s => (s.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(1, s.replace(/\s/g, '').length);

const TRANS_SYS = '你是专业的学术论文翻译。把用户给出的学术文本翻译成{LANG}。要求：忠实准确、语句通顺；专业术语使用该领域通用译法（如超声无损检测、阵列成像、信号处理等），首次出现的缩写可保留英文（如 TFM、FMC）；保留公式符号、变量名、单位和引用编号（如 [12]）；不要添加任何解释或前后缀，只输出译文。';
const inflight = new Map();
export async function translate(text, { signal } = {}) {
  const c = getCfg();
  const lang = c.lang || '简体中文';
  if (/中文/.test(lang) && cjkRatio(text) > 0.3) return text; // 已是中文
  const key = hash(`${c.model}|${lang}|${text}`);
  const cached = await db.get('trans', key).catch(() => null);
  if (cached) return cached.text;
  if (inflight.has(key)) return inflight.get(key);
  const p = chat([{ role: 'system', content: TRANS_SYS.replace('{LANG}', lang) }, { role: 'user', content: text }], { signal })
    .then(async out => { await db.put('trans', { key, text: out, ts: Date.now() }).catch(() => {}); return out; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export async function summarize(paper, blocks) {
  const pick = [];
  let n = 0;
  const heads = blocks.map((b, i) => [b, i]);
  const body = blocks.filter(b => b.text && ['p', 'h2', 'h3'].includes(b.type));
  // 摘要+引言前部+结论
  const conclIdx = body.findIndex(b => /^(\d+\.?\s*|[IVX]+\.\s*)?(conclusions?|summary|结论|总结)/i.test(b.text) && b.type !== 'p');
  for (const b of body.slice(0, 14)) { pick.push(b.text); n += b.text.length; if (n > 7000) break; }
  if (conclIdx > 0) for (const b of body.slice(conclIdx, conclIdx + 6)) pick.push(b.text);
  const text = pick.join('\n\n').slice(0, 11000);
  const c = getCfg();
  const lang = c.lang || '简体中文';
  const sys = `你是科研助理，为研究者快速梳理论文。用${lang}输出严格的 JSON（不要 Markdown 代码块），格式：{"summary":"2-3 句话概括研究问题与主要发现","method":["方法要点，3-5 条"],"conclusion":["结论或局限，3-5 条"],"keywords":["3-6 个关键词"]}。只依据给定文本，不要编造数据。`;
  const out = await chat([{ role: 'system', content: sys }, { role: 'user', content: `标题：${paper.title}\n\n${text}` }]);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 返回的不是 JSON');
  const j = JSON.parse(m[0]);
  return { summary: String(j.summary || ''), method: [].concat(j.method || []).map(String), conclusion: [].concat(j.conclusion || []).map(String), keywords: [].concat(j.keywords || []).map(String), model: c.model, ts: Date.now() };
}

export async function test() {
  const out = await chat([{ role: 'user', content: '请只回复：OK' }], { maxTokens: 10 });
  return out;
}
