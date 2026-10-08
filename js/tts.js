// 朗读：Web Speech API。按句切短（iOS 长时间朗读会停住），中文段落用中文语音，其余用英文。
export const RATES = [0.75, 1, 1.25, 1.5];
const SPEAKABLE = new Set(['p', 'h2', 'h3', 'caption', 'title', 'front']);

export function detectLang(text) {
  const cjk = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  const lat = (String(text).match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && cjk >= lat ? 'zh-CN' : 'en-US';
}

const ABBR = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Fig|Figs|Eq|Eqs|Tab|No|Vol|pp|al|vs|etc|e\.g|i\.e)\.$/i;

function splitOnce(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (detectLang(t) === 'zh-CN') return t.split(/(?<=[。！？!?；;])/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    buf += t[i];
    const end = /[.!?]/.test(t[i]) && (i === t.length - 1 || t[i + 1] === ' ');
    if (end && !ABBR.test(buf.trim())) { out.push(buf.trim()); buf = ''; i++; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function chop(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = -1;
    for (const sep of ['，', '、', ',', ';', '；', ' ']) {
      const i = win.lastIndexOf(sep);
      if (i >= Math.floor(max * 0.45)) { cut = i; break; }
    }
    if (cut < 0) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function splitSentences(text) {
  const max = detectLang(text) === 'zh-CN' ? 70 : 180;
  return splitOnce(text).flatMap(s => (s.length > max ? chop(s, max) : [s]));
}

export function pickVoice(voices, lang) {
  const list = voices || [];
  const norm = v => String(v.lang || '').toLowerCase().replace('_', '-');
  const prefs = lang.startsWith('zh') ? ['zh-cn', 'zh-hans', 'zh-tw', 'zh-hk', 'zh'] : ['en-us', 'en-gb', 'en'];
  for (const p of prefs) {
    const v = list.find(v => norm(v).startsWith(p));
    if (v) return v;
  }
  return null;
}

export function speakableBlocks(blocks) {
  return (blocks || []).filter(b => {
    if (!SPEAKABLE.has(b.type) || !b.text) return false;
    const t = b.text.replace(/\s/g, '');
    if (t.length < 2) return false;
    if (b.type === 'front' && t.length < 12) return false;
    return true;
  });
}

export class Speaker {
  constructor(synth, Utterance) {
    this.synth = synth;
    this.U = Utterance;
    this.rate = 1;
    this.blocks = [];
    this.bi = 0;
    this.si = 0;
    this.sents = [];
    this.state = 'idle';
    this.onchange = null;
    this._gen = 0;
    this._pending = false;
    this._spokeAt = 0;
    this._retries = 0;
    this._watch = null;
  }
  setBlocks(blocks, startId) {
    this.blocks = speakableBlocks(blocks);
    const i = startId ? this.blocks.findIndex(b => b.id === startId) : 0;
    this.bi = i >= 0 ? i : 0;
    this.si = 0;
    this.sents = [];
  }
  current() { return this.blocks[this.bi] || null; }
  sentence() { return this.sents[this.si] || ''; }
  start() {
    if (!this.blocks.length || !this.U) return false;
    this._arm();
    this._load();
    this._speak();
    return true;
  }
  toggle() {
    if (this.state === 'playing') { this._cancel(); this.state = 'paused'; this._emit(); }
    else if (this.state === 'paused') this._speak();
  }
  next() { return this._move(1); }
  prev() { return this._move(-1); }
  setRate(r) {
    this.rate = r;
    if (this.state === 'playing') { this._cancel(); this._speak(); }
    else this._emit();
  }
  stop() {
    this._cancel();
    this._disarm();
    this.state = 'idle';
    this.sents = [];
    this._emit();
  }
  _move(dir) {
    const n = this.bi + dir;
    if (n < 0 || n >= this.blocks.length) return false;
    const was = this.state;
    this._cancel();
    this.bi = n; this.si = 0; this.sents = [];
    if (was === 'idle') this.state = 'playing';
    this._arm();
    this._load();
    this._speak();
    return true;
  }
  _load() {
    const b = this.current();
    this.sents = b ? splitSentences(b.text) : [];
    if (this.si >= this.sents.length) this.si = 0;
  }
  _speak() {
    const text = this.sents[this.si];
    if (!text) { this._advance(); return; }
    const lang = detectLang(text);
    let u;
    try { u = new this.U(text); } catch (e) { this.state = 'idle'; this._emit(); return; }
    u.lang = lang;
    u.rate = this.rate;
    try { const v = pickVoice(this.synth.getVoices ? this.synth.getVoices() : [], lang); if (v) u.voice = v; } catch (e) {}
    const gen = ++this._gen;
    this._pending = true;
    this._spokeAt = Date.now();
    u.onend = () => { if (gen !== this._gen) return; this._pending = false; this._retries = 0; this._advance(); };
    u.onerror = () => { if (gen !== this._gen) return; this._pending = false; };
    this.state = 'playing';
    try { this.synth.speak(u); } catch (e) { this._pending = false; this.state = 'idle'; }
    this._emit();
  }
  _advance() {
    if (this.state !== 'playing') return;
    if (this.si + 1 < this.sents.length) { this.si++; this._speak(); return; }
    if (this.bi + 1 < this.blocks.length) { this.bi++; this.si = 0; this._load(); this._speak(); return; }
    this.stop();
  }
  _cancel() {
    this._gen++;
    this._pending = false;
    try { this.synth.cancel(); } catch (e) {}
  }
  _arm() {
    if (this._watch) return;
    this._watch = setInterval(() => this._kick(), 10000); if (this._watch.unref) this._watch.unref();
  }
  _disarm() { if (this._watch) { clearInterval(this._watch); this._watch = null; } }
  // iOS 上 speechSynthesis 会在十几秒后静默停住，且 pause/resume 不可靠：句子保持很短，并定期轻推。
  _kick() {
    if (this.state !== 'playing') return;
    try {
      if (this.synth.speaking) { this.synth.pause(); this.synth.resume(); }
      else if (this._pending && Date.now() - this._spokeAt > 10000 && this._retries < 1) { this._retries++; this._speak(); }
    } catch (e) {}
  }
  _emit() { try { this.onchange && this.onchange(); } catch (e) {} }
}
