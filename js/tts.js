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

export function voiceId(v) { return (v && (v.voiceURI || v.name)) || ''; }

function langFamily(lang) {
  const l = String(lang || '').toLowerCase().replace(/_/g, '-');
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('en')) return 'en';
  return '';
}

export function voicesFor(voices, lang) {
  const want = String(lang || '').startsWith('zh') ? 'zh' : 'en';
  return (voices || []).filter(v => langFamily(v.lang) === want);
}

function scoreVoice(v, lang) {
  const name = String(v.name || '');
  const l = String(v.lang || '').toLowerCase().replace(/_/g, '-');
  let s = v.localService ? 10 : 0;
  if (/compact/i.test(name)) s -= 60;
  if (/novelty|bad news|bells|boing|bubbles|zarvox|trinoids|whisper/i.test(name)) s -= 80;
  if (String(lang).startsWith('zh')) {
    if (l.startsWith('zh-cn') || l.startsWith('zh-hans')) s += 20;
    else if (l.startsWith('zh-tw') || l.startsWith('zh-hk') || l.includes('yue')) s += 4;
    else if (l.startsWith('zh')) s += 8;
    if (/siri/i.test(name)) s += 100;
    if (/语舒|yu[-\s]?shu|yushu/i.test(name)) s += 110;
    if (/李牧|li[-\s]?mu/i.test(name)) s += 70;
    if (/premium/i.test(name)) s += 60;
    if (/enhanced|增强/i.test(name)) s += 50;
    if (/婷婷|ting-?ting/i.test(name) && !/enhanced|premium|增强/i.test(name)) s += 15;
  } else {
    if (l.startsWith('en-us')) s += 20;
    else if (l.startsWith('en-gb')) s += 12;
    else if (l.startsWith('en')) s += 6;
    if (/siri/i.test(name)) s += 96;
    if (/samantha/i.test(name) && /enhanced|premium/i.test(name)) s += 100;
    else if (/\bava\b/i.test(name)) s += 94;
    else if (/allison/i.test(name)) s += 90;
    else if (/nicky/i.test(name)) s += 86;
    else if (/samantha/i.test(name)) s += 30;
    if (/premium/i.test(name) && !/samantha/i.test(name)) s += 55;
    if (/enhanced/i.test(name) && !/samantha/i.test(name)) s += 45;
  }
  return s;
}

export function rankedVoices(voices, lang) {
  return voicesFor(voices, lang).slice().sort((a, b) => scoreVoice(b, lang) - scoreVoice(a, lang) || String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
}

export function pickVoice(voices, lang, savedId) {
  const list = voicesFor(voices, lang);
  if (savedId) {
    const hit = list.find(v => voiceId(v) === savedId);
    if (hit) return hit;
  }
  return rankedVoices(voices, lang)[0] || null;
}

export function voiceLabel(v) {
  const name = String(v.name || '语音');
  const lang = String(v.lang || '').toLowerCase().replace(/_/g, '-');
  let who = name;
  if (/语舒|yu[-\s]?shu|yushu/i.test(name)) who = '语舒';
  else if (/婷婷|ting-?ting/i.test(name)) who = '婷婷';
  else if (/善怡|sinji/i.test(name)) who = '善怡';
  else if (/美佳|meijia/i.test(name)) who = '美佳';
  else if (/李牧|li[-\s]?mu/i.test(name)) who = '李牧';
  else if (/samantha/i.test(name)) who = 'Samantha';
  else if (/\bava\b/i.test(name)) who = 'Ava';
  else if (/allison/i.test(name)) who = 'Allison';
  else if (/nicky/i.test(name)) who = 'Nicky';
  else if (/siri/i.test(name)) who = 'Siri';
  let qual = '';
  if (/premium|高品质/i.test(name)) qual = '高品质';
  else if (/enhanced|增强/i.test(name)) qual = '增强';
  else if (/compact/i.test(name)) qual = '精简';
  else if (v.localService) qual = '本机';
  let region = '';
  if (lang.startsWith('zh-cn') || lang.startsWith('zh-hans')) region = '普通话';
  else if (lang.startsWith('zh-tw') || lang.includes('hant')) region = '台湾';
  else if (lang.startsWith('zh-hk') || lang.startsWith('zh-yue')) region = '粤语';
  else if (lang.startsWith('en-us')) region = '美式英语';
  else if (lang.startsWith('en-gb')) region = '英式英语';
  else if (lang.startsWith('en')) region = '英语';
  else if (lang.startsWith('zh')) region = '中文';
  return [who, qual, region].filter(Boolean).join(' · ');
}

export function voiceNote(count, lang) {
  if (count !== 1) return '';
  if (String(lang).startsWith('zh')) return '这台设备只有这一种中文语音。想更好听，可在「设置 → 辅助功能 → 朗读内容 → 语音」里下载增强音质。';
  return '这台设备只有这一种英文语音。';
}

export function whenVoices(synth, timeout = 1500) {
  let list = [];
  try { list = synth && synth.getVoices ? synth.getVoices() : []; } catch (e) {}
  if (list && list.length) return Promise.resolve(list);
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      let v = [];
      try { v = synth.getVoices ? synth.getVoices() : []; } catch (e) {}
      if (!v.length) return;
      done = true;
      cleanup();
      resolve(v);
    };
    const on = () => finish();
    try { synth.addEventListener && synth.addEventListener('voiceschanged', on); } catch (e) {}
    const prev = synth.onvoiceschanged;
    synth.onvoiceschanged = (...a) => { try { prev && prev.apply(synth, a); } catch (e) {} finish(); };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      let v = [];
      try { v = synth.getVoices ? synth.getVoices() : []; } catch (e) {}
      resolve(v);
    }, timeout);
    if (t.unref) t.unref();
    function cleanup() {
      clearTimeout(t);
      try { synth.removeEventListener && synth.removeEventListener('voiceschanged', on); } catch (e) {}
    }
  });
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
    this._wait = 0;
    this._voicesReady = false;
    this.voiceIds = { 'zh-CN': '', 'en-US': '' };
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
  setVoice(lang, id) {
    const key = String(lang).startsWith('zh') ? 'zh-CN' : 'en-US';
    this.voiceIds[key] = id || '';
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
    let voices = [];
    try { voices = this.synth.getVoices ? this.synth.getVoices() : []; } catch (e) {}
    if ((voices && voices.length) || this._voicesReady) { this._voicesReady = true; this._utter(voices || []); return; }
    const ticket = ++this._wait;
    this.state = 'playing';
    this._pending = true;
    this._emit();
    whenVoices(this.synth).then(v => {
      if (ticket !== this._wait || this.state !== 'playing') return;
      this._voicesReady = true;
      this._utter(v || []);
    });
  }
  _utter(voices) {
    const text = this.sents[this.si];
    if (!text) { this._advance(); return; }
    const lang = detectLang(text);
    let u;
    try { u = new this.U(text); } catch (e) { this.state = 'idle'; this._emit(); return; }
    u.lang = lang;
    u.rate = this.rate;
    try { const v = pickVoice(voices, lang, this.voiceIds[lang]); if (v) u.voice = v; } catch (e) {}
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
    this._wait++;
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
