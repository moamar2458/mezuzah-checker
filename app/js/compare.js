// Before / after: compare the same letters of the text between the last check and this one.
// Two photos never have the same size or light, so every letter is compared to the change of the whole page
// (the median), and only letters that changed much more than the rest are reported.
import { median } from './imageproc.js';

export const LESS_INK = 0.75;   // letter has less than 75% of its ink, compared to the page as a whole
export const LIGHTER = 18;      // ink got this much lighter (0 = black … 255 = parchment), compared to the page

/**
 * oldScan / newScan: { letters: [{j, b, ink, dark, spots}], issues: [{kind, refIndex}], letterH }
 * ref: parsed reference text (for the notes)
 */
export function compareScans(oldScan, newScan, ref) {
  const oldBy = new Map((oldScan.letters || []).map((l) => [l.j, l]));
  const pairs = [];
  for (const n of newScan.letters || []) { const o = oldBy.get(n.j); if (o && o.ink > 0 && n.ink > 0) pairs.push([o, n]); }
  if (pairs.length < 50) return { ok: false, common: pairs.length, changes: [] };

  const ratios = pairs.map(([o, n]) => n.ink / o.ink);
  const medRatio = median(ratios);
  const medDark = median(pairs.map(([o, n]) => n.dark - o.dark));
  const word = (j) => (ref && ref[j] ? `${ref[j].ch} in ${ref[j].wordText}` : `letter ${j + 1}`);

  const changes = [];
  for (const [o, n] of pairs) {
    const r = n.ink / o.ink / medRatio;
    const dd = n.dark - o.dark - medDark;
    if (r < LESS_INK) changes.push({ j: n.j, kind: 'less-ink', score: 1 - r, old: o, now: n, note: `Less ink than last time (${Math.round((1 - r) * 100)}% less) – check for a crack or flaking: ${word(n.j)}` });
    else if (dd > LIGHTER) changes.push({ j: n.j, kind: 'lighter', score: dd / 100, old: o, now: n, note: `Ink looks lighter than last time – check for fading: ${word(n.j)}` });
    // a new white spot alone moves about between two photos; it counts when the letter also lost some ink
    else if (n.spots > 0 && !o.spots && r < 0.93) changes.push({ j: n.j, kind: 'new-spot', score: 0.5, old: o, now: n, note: `New white spot or thin place since last time: ${word(n.j)}` });
  }
  // problems found by the text matching that were not there last time. "Touching" is left out: very close
  // letters join or not depending on the photo, and they are in the normal report anyway.
  const KINDS = new Set(['broken', 'missing', 'wrong', 'extra']);
  const oldIssues = new Set((oldScan.issues || []).filter((i) => i.refIndex !== undefined && i.refIndex !== null).map((i) => `${i.kind}:${i.refIndex}`));
  const newBy = new Map((newScan.letters || []).map((l) => [l.j, l]));
  for (const is of newScan.issues || []) {
    if (!KINDS.has(is.kind) || is.refIndex === undefined || is.refIndex === null || oldIssues.has(`${is.kind}:${is.refIndex}`)) continue;
    const o = oldBy.get(is.refIndex);
    changes.push({ j: is.refIndex, kind: 'new-issue', score: 1, old: o || null, now: newBy.get(is.refIndex) || { b: [is.x - is.r, is.y - is.r, is.x + is.r, is.y + is.r] }, note: `New since last time: ${is.note}` });
  }
  changes.sort((a, b) => a.j - b.j);
  return { ok: true, common: pairs.length, medRatio, medDark, changes };
}
