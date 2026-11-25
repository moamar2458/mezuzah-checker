// Printed-copy warning. Two signals:
//  1. copy:    this mezuzah is letter-for-letter almost identical to a different mezuzah checked before
//              (two handwritten mezuzot are never that alike; a print and its copies are).
//  2. uniform: every instance of the same letter looks almost exactly the same (print), where a scribe's
//              hand always varies a little.
// It only warns; the sofer decides.
import { T, dateStr } from './i18n.js';

function corr(a, b) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; const n = a.length;
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
  const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/** How alike two checks are, letter by letter (0..1), using the same letters of the text. */
export function similarity(lettersA, lettersB) {
  const byJ = new Map(lettersA.filter((l) => l.fp).map((l) => [l.j, l.fp]));
  const vals = [];
  for (const l of lettersB) { const o = byJ.get(l.j); if (o && l.fp) vals.push(corr(o, l.fp)); }
  if (vals.length < 200) return { score: null, n: vals.length };
  vals.sort((x, y) => x - y);
  return { score: vals[vals.length >> 1], n: vals.length }; // median: robust to a few bad letters
}

/** How alike the repeated letters inside one check are (0..1). */
export function uniformity(letters, ref) {
  const by = {};
  for (const l of letters) if (l.fp && ref[l.j]) (by[ref[l.j].ch] = by[ref[l.j].ch] || []).push(l.fp);
  const per = [];
  for (const fps of Object.values(by)) {
    if (fps.length < 8) continue;
    const s = fps.slice(0, 16); const v = [];
    for (let i = 0; i < s.length; i++) for (let k = i + 1; k < s.length; k++) v.push(corr(s[i], s[k]));
    v.sort((x, y) => x - y); per.push(v[v.length >> 1]);
  }
  if (per.length < 5) return null;
  per.sort((x, y) => x - y);
  return per[per.length >> 1];
}

// Tests: copies of the same mezuzah 0.99, different hands 0.66–0.80; uniformity handwriting 0.82, print 0.99.
export const COPY_LIMIT = 0.95;
export const UNIFORM_LIMIT = 0.93;

/**
 * scan: { uid, itemUid, letters }, others: earlier checks [{uid, itemUid, letters, date, customerName, itemName}]
 * Returns a list of warnings [{ kind, note, score, other }].
 */
export function printedCheck(scan, others, ref) {
  const out = [];
  let best = null;
  for (const o of others) {
    if (o.uid === scan.uid || !o.letters) continue;
    if (scan.itemUid && o.itemUid === scan.itemUid) continue; // the same mezuzah checked again: of course alike
    const s = similarity(o.letters, scan.letters || []);
    if (s.score !== null && (!best || s.score > best.score)) best = { ...s, other: o };
  }
  if (best && best.score >= COPY_LIMIT) {
    const o = best.other;
    out.push({
      kind: 'copy', score: best.score, other: { uid: o.uid, date: o.date, customerName: o.customerName, itemName: o.itemName },
      note: T(`Possible printed copy: this mezuzah is almost identical (${Math.round(best.score * 100)}%) to the one checked ${dateStr(o.date)}${o.customerName ? ` for ${o.customerName} – ${o.itemName}` : ''}. Two handwritten mezuzot are never this alike – unless it is the same mezuzah photographed again. Check that it is handwritten.`, `ייתכן העתק מודפס: המזוזה הזאת כמעט זהה (${Math.round(best.score * 100)}%) לזו שנבדקה ב־${dateStr(o.date)}${o.customerName ? ` עבור ${o.customerName} – ${o.itemName}` : ''}. שתי מזוזות בכתב יד אף פעם לא דומות כל כך – אלא אם זו אותה מזוזה שצולמה שוב. יש לבדוק שהיא כתובה ביד.`),
    });
  }
  const u = uniformity(scan.letters || [], ref);
  if (u !== null && u >= UNIFORM_LIMIT) {
    out.push({ kind: 'uniform', score: u, note: T(`Possible print: repeated letters look almost exactly the same (${Math.round(u * 100)}%), which is unusual for handwriting. Check that it is handwritten.`, `ייתכן הדפסה: אותיות חוזרות נראות כמעט זהות לגמרי (${Math.round(u * 100)}%), דבר לא רגיל בכתב יד. יש לבדוק שהיא כתובה ביד.`) });
  }
  return { warnings: out, bestCopy: best ? best.score : null, uniformity: u };
}
