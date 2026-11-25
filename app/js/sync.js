// Sending checks and letters from the phone to the PC program, and getting the newest AI back.
// Everything waits in an "outbox" on the phone, so nothing is lost when there is no connection.
import * as db from './db.js';
import { u8ToB64 } from './library.js';
import { mergeRecords } from './customers.js';
import { T } from './i18n.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');
export const newUid = uid;

export async function getSettings() {
  let s = await db.get('sync');
  if (!s) { s = { url: '', code: '', device: `phone-${uid().slice(0, 8)}` }; await db.set('sync', s); }
  return s;
}
export async function saveSettings(patch) { const s = { ...(await getSettings()), ...patch }; await db.set('sync', s); return s; }

const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(r.error); r.readAsDataURL(blob);
});

/** Put a finished check (photo + results + its sure letters) in the outbox. */
export async function queueScan(scan, photoBlob, sureSamples) {
  await db.add('outbox', {
    kind: 'scan',
    body: {
      uid: scan.uid, date: scan.date, mode: scan.mode, stats: scan.stats, issues: scan.issues, quality: scan.quality, w: scan.w, h: scan.h,
      letters: (scan.letters || []).map((l) => ({ ...l, fp: l.fp ? u8ToB64(l.fp) : null })), letterH: scan.letterH || null,
      printWarnings: scan.printWarnings || [],
      customerUid: scan.customerUid || null, itemUid: scan.itemUid || null, customerName: scan.customerName || null, itemName: scan.itemName || null,
      photo: photoBlob ? await blobToB64(photoBlob) : null,
      samples: sureSamples.map((s) => ({ uid: s.uid, label: s.label, x: u8ToB64(s.x), view: u8ToB64(s.view), src: s.src, date: s.date })),
    },
  });
}

/** Put letters the sofer confirmed in the review list in the outbox. */
export async function queueSamples(samples) {
  if (!samples.length) return;
  await db.add('outbox', { kind: 'samples', body: { items: samples.map((s) => ({ uid: s.uid, label: s.label, x: u8ToB64(s.x), view: u8ToB64(s.view), src: s.src, scan: s.scanUid, date: s.date })) } });
}

/** Customers / items that were added or changed. */
export async function queueRecords(customers, items) {
  if (!customers.length && !items.length) return;
  await db.add('outbox', { kind: 'records', body: { customers, items } });
}

/** The sofer's result for a check (and the business details printed on the certificate). */
export async function queueResult(scanUid, result) {
  await db.add('outbox', { kind: 'result', body: { uid: scanUid, result } });
}

let running = null;
/** Try to sync now. Returns { state: 'off' | 'offline' | 'ok' | 'error', waiting, newModel, message } */
export function syncNow() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function call(base, s, path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  try {
    const res = await fetch(base + path, { ...opts, signal: ctrl.signal, headers: { 'x-pair-code': s.code, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401) throw Object.assign(new Error(T('The pairing code is wrong', 'קוד הצימוד שגוי')), { auth: true });
    if (!res.ok) throw new Error(T(`PC answered ${res.status}`, `המחשב ענה ${res.status}`));
    return res;
  } finally { clearTimeout(t); }
}

async function doSync() {
  const s = await getSettings();
  const waiting = await db.count('outbox');
  if (!s.code) return { state: 'off', waiting };
  const base = (s.url || location.origin).replace(/\/+$/, '');
  let role = 'owner';
  try {
    const ping = await (await call(base, s, '/api/ping', { timeout: 6000 })).json();
    role = ping.role || 'owner';
    if (role !== s.role) await saveSettings({ role, userName: ping.name || '' });
  } catch (e) {
    const r = { state: e.auth ? 'error' : 'offline', waiting, message: e.auth ? e.message : T('PC not reachable', 'המחשב לא זמין') };
    await db.set('syncStatus', { ...r, at: Date.now() });
    return r;
  }
  try {
    // 1. send everything that is waiting, oldest first
    for (const item of await db.all('outbox')) {
      if (role === 'helper') {
        // a helper shares only letter images with the shared library – never photos, customers or results
        if (item.kind === 'scan' || item.kind === 'samples') {
          const items = item.kind === 'scan' ? item.body.samples : item.body.items;
          const clean = (items || []).map(({ uid, label, x, view, src, date }) => ({ uid, label, x, view, src, date }));
          if (clean.length) await call(base, s, '/api/samples', { method: 'POST', body: JSON.stringify({ items: clean, device: s.device }), timeout: 120000 });
        }
        await db.del('outbox', item.id);
        continue;
      }
      const path = { scan: '/api/scans', samples: '/api/samples', records: '/api/records', result: `/api/scans/${item.body.uid}/result` }[item.kind];
      await call(base, s, path, { method: 'POST', body: JSON.stringify({ ...item.body, device: s.device }), timeout: 120000 });
      await db.del('outbox', item.id);
    }
    // 2. customers and items from the PC (other phones, or a new phone getting everything back)
    const changed = role === 'helper' ? 0 : await mergeRecords(await (await call(base, s, '/api/records')).json());
    // 3. is there a newer AI on the PC?
    let newModel = null;
    const meta = await (await call(base, s, '/api/model/meta')).json();
    if (meta.version && meta.version !== (await db.get('modelVersion'))) {
      const text = await (await call(base, s, '/api/model', { timeout: 60000 })).text();
      await db.set('model', text); await db.set('modelVersion', meta.version);
      newModel = text;
    }
    const r = { state: 'ok', waiting: await db.count('outbox'), newModel: !!newModel, recordsChanged: changed };
    await db.set('syncStatus', { ...r, at: Date.now() });
    await db.set('lastSync', Date.now());
    return { ...r, modelJson: newModel };
  } catch (e) {
    const r = { state: e.auth ? 'error' : 'offline', waiting: await db.count('outbox'), message: e.message };
    await db.set('syncStatus', { ...r, at: Date.now() });
    return r;
  }
}
