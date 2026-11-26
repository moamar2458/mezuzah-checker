// The four kinds of ktav (writing style) of a mezuzah, and how the app tells them apart.
// Each style has a typical shape for each letter (a "prototype": the average 32x32 letter picture).
// Prototypes come from (1) STaM fonts – only for Beit Yosef (Ashkenaz font) and Sefaradi (Sefarad font) –
// and (2) the sofer's own library: every letter of a mezuzah whose style was confirmed or corrected.
// Arizal and Temani can only be recognised after the sofer has confirmed some mezuzot in that style.
import { T } from './i18n.js';

export const STYLES = [
  { id: 'by', en: 'Beit Yosef', he: 'בית יוסף' },
  { id: 'ari', en: 'Arizal', he: 'האר"י' },
  { id: 'sfd', en: 'Sefaradi (Velish)', he: 'ספרדי (וליש)' },
  { id: 'tmn', en: 'Temani (Yemenite)', he: 'תימני' },
];
export const styleName = (id) => { const s = STYLES.find((x) => x.id === id); return s ? T(s.en, s.he) : T('unknown', 'לא ידוע'); };

const FONT_WEIGHT = 4; // a font letter counts like this many real letters

/** 16x16 average of a 32x32 letter (0..1), so small shifts and stroke widths matter less. */
export function pool(x) {
  const out = new Float32Array(256);
  const k = x instanceof Uint8Array ? 1 / 255 : 1;
  for (let y = 0; y < 16; y++) for (let xx = 0; xx < 16; xx++) {
    const i = y * 64 + xx * 2;
    out[y * 16 + xx] = ((x[i] + x[i + 1] + x[i + 32] + x[i + 33]) / 4) * k;
  }
  return out;
}
const dist = (a, b) => { let s = 0; for (let i = 0; i < 256; i++) s += Math.abs(a[i] - b[i]); return s / 256; };

/**
 * Build the prototypes. font: { by: { letter: Float32Array(1024) }, sfd: {...} } (may be empty),
 * samples: [{ label, x: Uint8Array(1024), style }] from the library.
 * Returns { style: { letter: { p: Float32Array(256), n } } }
 */
export function buildPrototypes(font = {}, samples = []) {
  const acc = {};
  const add = (st, label, v, w) => {
    const s = (acc[st] = acc[st] || {});
    const e = (s[label] = s[label] || { sum: new Float32Array(256), n: 0 });
    for (let i = 0; i < 256; i++) e.sum[i] += v[i] * w;
    e.n += w;
  };
  for (const [st, letters] of Object.entries(font || {})) for (const [label, x] of Object.entries(letters)) add(st, label, pool(x), FONT_WEIGHT);
  for (const s of samples) if (s.style && s.label && s.x) add(s.style, s.label, pool(s.x), 1);
  const out = {};
  for (const [st, letters] of Object.entries(acc)) {
    out[st] = {};
    for (const [label, e] of Object.entries(letters)) out[st][label] = { p: e.sum.map((v) => v / e.n), n: e.n, real: e.n - (font[st] && font[st][label] ? FONT_WEIGHT : 0) };
  }
  return out;
}

/**
 * Which style is this mezuzah written in? items: [{ label, x }] (the letters matched to the text).
 * Returns { id, conf (0..1), scores: { style: number }, known: [style ids that could be compared] } or null.
 */
export function guessStyle(items, protos) {
  const ids = STYLES.map((s) => s.id).filter((id) => protos[id] && Object.keys(protos[id]).length >= 12);
  if (!ids.length || items.length < 30) return null;
  // compare on the letters every candidate style knows
  const per = {}; for (const id of ids) per[id] = 0;
  let n = 0;
  for (const it of items) {
    if (!ids.every((id) => protos[id][it.label])) continue;
    const v = pool(it.x);
    const ds = ids.map((id) => dist(v, protos[id][it.label].p));
    const lo = Math.min(...ds);
    ids.forEach((id, k) => { per[id] += ds[k] - lo; });
    n++;
  }
  if (n < 30) return null;
  for (const id of ids) per[id] /= n;
  const sorted = ids.slice().sort((a, b) => per[a] - per[b]);
  if (sorted.length === 1) return { id: sorted[0], conf: 0, scores: per, known: ids };
  const best = per[sorted[0]], second = per[sorted[1]];
  // how much better the best style fits, compared with the typical difference between styles
  const conf = Math.max(0, Math.min(1, (second - best) / Math.max(0.01, second)));
  return { id: sorted[0], conf, scores: per, known: ids };
}

/**
 * Letters whose shape is far from the style's shape, much more than the other copies of the same letter in this mezuzah.
 * items: [{ label, x, i }]. Returns [{ i, d, med }].
 */
export function styleOutliers(items, protos, style, { max = 6 } = {}) {
  const P = protos[style];
  if (!P) return [];
  const byLabel = {};
  for (const it of items) if (P[it.label]) (byLabel[it.label] = byLabel[it.label] || []).push({ ...it, d: dist(pool(it.x), P[it.label].p) });
  const out = [];
  for (const list of Object.values(byLabel)) {
    if (list.length < 5) continue;
    const ds = list.map((x) => x.d).sort((a, b) => a - b);
    const med = ds[Math.floor(ds.length / 2)];
    const mad = ds.map((d) => Math.abs(d - med)).sort((a, b) => a - b)[Math.floor(ds.length / 2)] || 0.005;
    for (const x of list) if (x.d > med + 6 * 1.4826 * mad && x.d > med * 1.8 && x.d > 0.12) out.push({ i: x.i, d: x.d, med });
  }
  return out.sort((a, b) => b.d / b.med - a.d / a.med).slice(0, max);
}
