// Match the letters found on the photo, one by one, to the known text.
// Dynamic programming (like a "diff"), with five possible steps:
//   M  one letter on the klaf  = one letter of the text
//   D  a letter of the text has no letter on the klaf           -> missing
//   I  a mark on the klaf has no letter of the text            -> extra
//   T  one blob on the klaf = two letters of the text          -> letters touching
//   B  two pieces on the klaf = one letter of the text         -> letter broken
import { SHAPE, LETTER_INDEX } from './reference.js';

const GAP_D = -2.6, GAP_I = -2.6, GAP_I_SMALL = -1.4, JOIN = -1.4;

const widthTerm = (rel, exp) => -1.3 * Math.min(2.5, Math.abs(Math.log(Math.max(0.05, rel) / exp)));

function classTerm(probs, ch) {
  if (!probs) return 0;
  const p = probs[LETTER_INDEX[ch]];
  let pmax = 0; for (const v of probs) if (v > pmax) pmax = v;
  return 1.5 * Math.log((p + 0.02) / (pmax + 0.02)) + p;
}

export function matchScore(g, r) {
  const sh = SHAPE[r.ch];
  let s = 1 + widthTerm(g.relW, sh.w);
  if (g.up !== !!sh.up) s -= 1.5;
  if (g.down !== !!sh.down) s -= 1.5;
  if (g.small !== !!sh.small) s -= 0.8;
  s += g.wordStart === r.wordStart ? 0.6 : -1.0;
  s += classTerm(g.probs, r.ch);
  return s;
}

function touchScore(g, r1, r2) {
  const a = SHAPE[r1.ch], b = SHAPE[r2.ch];
  let s = 1 + JOIN + widthTerm(g.relW, a.w + b.w + 0.1);
  if (r2.wordStart) s -= 0.6; // two words touching: rarer, but possible
  if (g.down !== !!(a.down || b.down)) s -= 1.0;
  if (g.up !== !!(a.up || b.up)) s -= 1.0;
  s += g.wordStart === r1.wordStart ? 0.6 : -1.0;
  return s;
}

function touch3Score(g, r1, r2, r3) {
  const a = SHAPE[r1.ch], b = SHAPE[r2.ch], c = SHAPE[r3.ch];
  let s = 1 + 1.6 * JOIN + widthTerm(g.relW, a.w + b.w + c.w + 0.2);
  if (r2.wordStart || r3.wordStart) s -= 0.6;
  if (g.down !== !!(a.down || b.down || c.down)) s -= 1.0;
  if (g.up !== !!(a.up || b.up || c.up)) s -= 1.0;
  s += g.wordStart === r1.wordStart ? 0.6 : -1.0;
  return s;
}

function brokenScore(g1, g2, r) {
  const sh = SHAPE[r.ch];
  const span = (Math.max(g1.x1, g2.x1) - Math.min(g1.x0, g2.x0) + 1) / (g1.W || 1);
  let s = 1 + JOIN + widthTerm(span, sh.w);
  if (g2.wordStart) s -= 1.5;
  if ((g1.down || g2.down) !== !!sh.down) s -= 1.0;
  if ((g1.up || g2.up) !== !!sh.up) s -= 1.0;
  s += g1.wordStart === r.wordStart ? 0.6 : -1.0;
  return s;
}

/**
 * letters: detected letters in reading order (with relW, up, down, small, wordStart, optional probs)
 * ref: parsed reference letters
 * returns list of steps in order.
 */
export function align(letters, ref, W = 1) {
  const n = letters.length, m = ref.length, C = m + 1;
  for (const g of letters) g.W = W;
  const S = new Float32Array((n + 1) * C).fill(-Infinity);
  const P = new Uint8Array((n + 1) * C); // 1=M 2=D 3=I 4=T 5=B 6=T(three letters)
  S[0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const k = i * C + j;
    if (k === 0) continue;
    let best = -Infinity, op = 0, v;
    if (i > 0 && j > 0) { v = S[k - C - 1] + matchScore(letters[i - 1], ref[j - 1]); if (v > best) { best = v; op = 1; } }
    if (j > 0) { v = S[k - 1] + GAP_D; if (v > best) { best = v; op = 2; } }
    if (i > 0) { const g = letters[i - 1]; v = S[k - C] + (g.tiny ? GAP_I_SMALL : GAP_I); if (v > best) { best = v; op = 3; } }
    if (i > 0 && j > 1 && letters[i - 1].relW > 1.15) {
      v = S[k - C - 2] + touchScore(letters[i - 1], ref[j - 2], ref[j - 1]); if (v > best) { best = v; op = 4; }
    }
    if (i > 0 && j > 2 && letters[i - 1].relW > 1.8) {
      v = S[k - C - 3] + touch3Score(letters[i - 1], ref[j - 3], ref[j - 2], ref[j - 1]); if (v > best) { best = v; op = 6; }
    }
    if (i > 1 && j > 0 && letters[i - 1].line === letters[i - 2].line) {
      v = S[k - 2 * C - 1] + brokenScore(letters[i - 2], letters[i - 1], ref[j - 1]); if (v > best) { best = v; op = 5; }
    }
    S[k] = best; P[k] = op;
  }
  const steps = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const op = P[i * C + j];
    if (op === 1) { steps.push({ op: 'M', i: [i - 1], j: [j - 1], score: matchScore(letters[i - 1], ref[j - 1]) }); i--; j--; }
    else if (op === 2) { steps.push({ op: 'D', i: [], j: [j - 1] }); j--; }
    else if (op === 3) { steps.push({ op: 'I', i: [i - 1], j: [] }); i--; }
    else if (op === 4) { steps.push({ op: 'T', i: [i - 1], j: [j - 2, j - 1] }); i--; j -= 2; }
    else if (op === 6) { steps.push({ op: 'T', i: [i - 1], j: [j - 3, j - 2, j - 1] }); i--; j -= 3; }
    else if (op === 5) { steps.push({ op: 'B', i: [i - 2, i - 1], j: [j - 1] }); i -= 2; j--; }
    else break;
  }
  steps.reverse();
  return steps;
}
