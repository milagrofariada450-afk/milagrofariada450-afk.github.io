// IndexedDB 封装：论文元数据、PDF 文件、重排缓存、划线、翻译缓存，全部只存本机。
const DB_NAME = 'yandu', DB_VER = 1;
let dbp = null;
export function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('papers')) db.createObjectStore('papers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reflow')) db.createObjectStore('reflow', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('highlights')) { const s = db.createObjectStore('highlights', { keyPath: 'id' }); s.createIndex('paper', 'paper'); }
      if (!db.objectStoreNames.contains('trans')) db.createObjectStore('trans', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = 'readonly') { const db = await open(); return db.transaction(name, mode).objectStore(name); }
export async function get(name, key) { return req((await store(name)).get(key)); }
export async function put(name, val) { return req((await store(name, 'readwrite')).put(val)); }
export async function del(name, key) { return req((await store(name, 'readwrite')).delete(key)); }
export async function all(name) { return req((await store(name)).getAll()); }
export async function byPaper(paper) { return req((await store('highlights')).index('paper').getAll(paper)); }
export async function clear(name) { return req((await store(name, 'readwrite')).clear()); }
export async function deletePaper(id) {
  const db = await open();
  const tx = db.transaction(['papers', 'files', 'reflow', 'highlights'], 'readwrite');
  tx.objectStore('papers').delete(id); tx.objectStore('files').delete(id); tx.objectStore('reflow').delete(id);
  const idx = tx.objectStore('highlights').index('paper');
  idx.openCursor(IDBKeyRange.only(id)).onsuccess = e => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
