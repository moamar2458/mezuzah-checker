// Learning library: saving letters from every check, and moving them between phone and PC.
import * as db from './db.js';
import { T } from './i18n.js';

export const u8ToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const b64ToU8 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

/**
 * Add the letters of one checked photo to the library.
 * Sure letters go straight in; unsure ones go to the review list.
 */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function addScanLetters(scanId, samples, scanUid = null) {
  const date = Date.now();
  const sure = samples.filter((s) => s.sure && s.label).map((s) => ({ uid: uid(), label: s.label, x: s.x, view: s.view, src: 'auto', scan: scanId, scanUid, date }));
  const unsure = samples.filter((s) => !s.sure).map((s) => ({ guess: s.label, x: s.x, view: s.view, zoom: s.zoom || null, why: s.why, modelP: s.modelP, scan: scanId, scanUid, date }));
  await db.addMany('samples', sure);
  await db.addMany('review', unsure);
  return { sure: sure.length, unsure: unsure.length, sureSamples: sure };
}

/** Sofer confirmed a letter from the review list. label = null means "not a letter" (just removed). Returns the new library letter. */
export async function resolveReview(item, label) {
  let sample = null;
  if (label) {
    sample = { uid: uid(), label, x: item.x, view: item.view, src: 'confirmed', scan: item.scan, scanUid: item.scanUid, date: Date.now() };
    await db.add('samples', sample);
    // places the sofer marked on this letter go to the spot memory, together with the letter's big view
    if (item.marks && item.marks.length) {
      sample.spot = { uid: sample.uid, label, zoom: item.zoom || item.view, marks: item.marks, date: sample.date };
      await saveSpot(sample.spot);
    }
  }
  await db.del('review', item.id);
  return sample;
}

// ---------- spot memory: places the sofer marked as good / problem ----------
/** The sofer's own marked letters on this phone: { uid: { uid, label, zoom, marks, date } } */
export async function getSpots() { return (await db.get('spots')) || {}; }
export async function saveSpot(rec) {
  const all = await getSpots();
  if (rec.marks && rec.marks.length) all[rec.uid] = rec; else delete all[rec.uid];
  await db.set('spots', all);
}
/** Everything the checker compares with: this phone's marks + marks shared through the PC. */
export async function allSpotRecords() {
  const mine = await getSpots();
  const pc = (await db.get('pcSpots')) || {};
  const out = Object.values(mine);
  for (const r of Object.values(pc)) {
    if (mine[r.uid] || !r.zoom) continue;
    out.push({ ...r, zoom: typeof r.zoom === 'string' ? b64ToU8(r.zoom) : r.zoom, fromPC: true });
  }
  return out;
}

export async function exportLibrary() {
  const samples = await db.all('samples');
  return JSON.stringify({
    format: 'mezuzah-letter-library', version: 1, exported: new Date().toISOString(),
    samples: samples.map((s) => ({ l: s.label, x: u8ToB64(s.x), src: s.src })),
  });
}

/** Parse a library export file (used by the trainer). Returns [{label, x: Uint8Array(1024), src}] */
export function parseLibrary(text) {
  const o = JSON.parse(text);
  if (o.format !== 'mezuzah-letter-library') throw new Error(T('This is not a letter library file', 'זה לא קובץ ספריית אותיות'));
  return o.samples.map((s) => ({ label: s.l, x: b64ToU8(s.x), src: s.src }));
}
