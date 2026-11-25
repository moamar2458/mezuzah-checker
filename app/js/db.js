// Local storage on the phone (IndexedDB). Nothing leaves the phone except to your own PC (when paired) or when you export it.
//   samples: letters the app is sure about (used to train the AI)
//   review:  letters the app was not sure about, waiting for the sofer
//   scans:   history of checked mezuzot
//   kv:      settings, confirmed reference text, the AI model
//   outbox:  checks and letters waiting to be sent to the PC
//   customers, items: who owns which mezuzah, and when it is due to be checked again
const DB_NAME = 'mezuzah-checker';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        const s = db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
        s.createIndex('label', 'label');
        db.createObjectStore('review', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('scans', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('kv');
      }
      // version 2: things waiting to be sent to the PC
      if (e.oldVersion < 2) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      // version 3: customers and the items (mezuzot) they own
      if (e.oldVersion < 3) {
        db.createObjectStore('customers', { keyPath: 'uid' });
        const it = db.createObjectStore('items', { keyPath: 'uid' });
        it.createIndex('customer', 'customerUid');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

export async function get(key) { return done((await store('kv')).get(key)); }
export async function set(key, value) { return done((await store('kv', 'readwrite')).put(value, key)); }

export async function addMany(name, items) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const st = tx.objectStore(name);
    for (const it of items) st.add(it);
    tx.oncomplete = () => resolve(items.length);
    tx.onerror = () => reject(tx.error);
  });
}
export async function add(name, item) { return done((await store(name, 'readwrite')).add(item)); }
export async function put(name, item) { return done((await store(name, 'readwrite')).put(item)); }
export async function del(name, id) { return done((await store(name, 'readwrite')).delete(id)); }
export async function count(name) { return done((await store(name)).count()); }
export async function all(name, limit) { return done((await store(name)).getAll(null, limit)); }
export async function clear(name) { return done((await store(name, 'readwrite')).clear()); }

/** Count of sure letters per label. */
export async function labelCounts() {
  const st = await store('samples');
  const counts = {};
  await new Promise((resolve, reject) => {
    const req = st.index('label').openKeyCursor();
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); counts[c.key] = (counts[c.key] || 0) + 1; c.continue(); };
    req.onerror = () => reject(req.error);
  });
  return counts;
}

export async function byIndex(name, index, key) { return done((await store(name)).index(index).getAll(key)); }
export async function getOne(name, key) { return done((await store(name)).get(key)); }
