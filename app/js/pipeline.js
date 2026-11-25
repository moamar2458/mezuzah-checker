// The whole check, from photo pixels to a list of places for the sofer to look at.
import { segment } from './segment.js';
import { align } from './align.js';
import { inspectLetter } from './problems.js';
import { normalizeMask, maskFromLabels, viewCrop, toBytes } from './crop.js';
import { predict } from './nn.js';
import { LETTERS, LETTER_INDEX, LETTER_NAMES } from './reference.js';
import { median } from './imageproc.js';
import { T } from './i18n.js';

const name = (ch) => T(`${ch} (${LETTER_NAMES[ch]})`, ch);

/** 16x16 summary of a 32x32 letter (0..255). */
export function fingerprint(x) {
  const out = new Uint8Array(256);
  for (let y = 0; y < 16; y++) for (let xx = 0; xx < 16; xx++) {
    const i = y * 64 + xx * 2;
    out[y * 16 + xx] = Math.round(((x[i] + x[i + 1] + x[i + 32] + x[i + 33]) / 4) * 255);
  }
  return out;
}

export const MIN_REAL = 1500, MIN_ACC = 0.97;
export function modelTrusted(model) {
  const m = (model && model.meta) || {};
  return !!(m.valFromReal && (m.realSamples || 0) >= MIN_REAL && (m.valAcc || 0) >= MIN_ACC);
}

export function photoQuality(seg) {
  const warnings = [];
  const { norm, mask, gray } = seg;
  let ink = 0, mid = 0, sum = 0;
  for (let i = 0; i < norm.d.length; i++) {
    sum += gray.d[i];
    if (mask.d[i]) ink++;
    else if (norm.d[i] < 190) mid++;
  }
  const blurRatio = ink ? mid / ink : 0;
  const mean = sum / gray.d.length;
  if (mean < 70) warnings.push({ kind: 'dark', note: T('Photo is dark. Add light (no direct flash glare) and take it again.', 'התמונה חשוכה. הוסף אור (בלי ברק ישיר של פלאש) וצלם שוב.') });
  if (blurRatio > 0.9) warnings.push({ kind: 'blur', note: T('Photo looks blurry. Hold the phone still, tap to focus, and take it again.', 'התמונה מטושטשת. החזק את הטלפון יציב, גע במסך למיקוד וצלם שוב.') });
  const deg = (seg.angle * 180) / Math.PI;
  if (Math.abs(deg) > 3) warnings.push({ kind: 'turn', note: T(`The klaf was turned ${deg.toFixed(1)}°. The app straightened it, but a straight photo is better.`, `הקלף היה מסובב ${deg.toFixed(1)}°. האפליקציה יישרה אותו, אבל עדיף לצלם ישר.`) });
  if (seg.lines && seg.lines.length >= 6) {
    const hs = seg.lines.map((L) => median(L.letters.map((g) => g.lineBot - g.lineTop)));
    const k = Math.max(2, Math.floor(hs.length / 4));
    const top = median(hs.slice(0, k)), bot = median(hs.slice(-k));
    const lefts = [], rights = [];
    const midX = seg.w / 2;
    for (const g of seg.letters) (g.x1 < midX ? lefts : rights).push(g.lineBot - g.lineTop);
    const lr = median(lefts) / Math.max(1, median(rights));
    if (top / bot > 1.12 || bot / top > 1.12 || lr > 1.12 || lr < 1 / 1.12) {
      warnings.push({ kind: 'tilt', note: T('The phone was tilted (letters are bigger on one side). Hold the phone flat, straight above the klaf.', 'הטלפון היה נטוי (האותיות גדולות יותר בצד אחד). החזק את הטלפון שטוח, ישר מעל הקלף.') });
    }
  }
  if (seg.H < 18) warnings.push({ kind: 'small', note: T('Letters are small in the photo. Move the phone closer so the klaf fills the screen.', 'האותיות קטנות בתמונה. קרב את הטלפון כך שהקלף ימלא את המסך.') });
  return { warnings, blurRatio, brightness: mean, angleDeg: deg, letterHeightPx: seg.H };
}

/**
 * rgba/w/h: the photo, already scaled to analysis size.
 * opts: { ref (parsed reference), model (optional), sens (crack sensitivity 0.2..0.5) }
 */
export function analyze(rgba, w, h, opts) {
  const { ref, sens = 0.15 } = opts;
  const seg = segment(rgba, w, h);
  if (!seg.ok) {
    return { ok: false, rgba: seg.rgba, w, h, issues: [], quality: { warnings: [{ kind: 'notext', note: T('Could not find the letters. Make sure the whole klaf is in the photo, sharp and well lit.', 'לא נמצאו האותיות. ודא שכל הקלף בתמונה, חד ומואר היטב.') }] } };
  }
  const quality = photoQuality(seg);
  // An AI that has only seen font letters is wrong on real handwriting, so it is used
  // only after it learned from enough real letters and was tested on real letters.
  let model = opts.model || null;
  if (model && !modelTrusted(model) && !opts.forceModel) {
    const m = model.meta || {};
    quality.warnings.push({ kind: 'model', note: T(`The AI model was not used: it has learned from ${m.realSamples || 0} real letters (it needs ${MIN_REAL} real letters, tested at least ${MIN_ACC * 100}% correct). Until then the check uses the known text and letter shapes, and "wrong letter" cannot be detected.`, `מודל הבינה לא שימש: הוא למד מ־${m.realSamples || 0} אותיות אמיתיות (צריך ${MIN_REAL} אותיות אמיתיות ולפחות ${MIN_ACC * 100}% נכון בבדיקה). עד אז הבדיקה משתמשת בנוסח הידוע ובצורות האותיות, ואי אפשר לזהות "אות שגויה".`) });
    model = null;
  }
  if (!opts.model) quality.warnings.push({ kind: 'model', note: T('No AI model yet: the check uses the known text and letter shapes. A wrong letter (for example ד written as ר) cannot be detected until the AI has learned from your mezuzot.', 'אין עדיין מודל בינה: הבדיקה משתמשת בנוסח הידוע ובצורות האותיות. אות שגויה (למשל ד שנכתבה כמו ר) לא תזוהה עד שהבינה תלמד מהמזוזות שלך.') });
  const { letters, W, H, A } = seg;

  // 1. cut out each letter, ask the AI (if there is one)
  for (const g of letters) {
    const { m, w: mw, h: mh } = maskFromLabels(seg.labels, seg.w, g, g.ids);
    g.x = normalizeMask(m, mw, mh);
    g.tiny = g.mainArea < 0.12 * A;
    // how much ink, and how dark it is (for comparing with the next check of the same mezuzah)
    let ink = 0, dark = 0;
    for (let yy = 0; yy < mh; yy++) for (let xx = 0; xx < mw; xx++) {
      if (!m[yy * mw + xx]) continue;
      ink++; dark += seg.norm.d[(g.y0 + yy) * seg.w + g.x0 + xx];
    }
    g.ink = ink; g.dark = ink ? dark / ink : 0;
    if (model) g.probs = predict(model, g.x);
  }

  // 2. line up with the text
  const steps = align(letters, ref, W);
  const issues = [];
  const add = (x, y, r, note, kind, extra = {}) => issues.push({ x, y, r: Math.max(r, H * 0.6), note, kind, ...extra });
  const center = (g) => [(g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2, Math.max(g.x1 - g.x0, g.y1 - g.y0) * 0.75];

  const lineEdits = new Map();
  const bump = (li) => lineEdits.set(li, (lineEdits.get(li) || 0) + 1);
  steps.forEach((s, k) => {
    for (const i of s.i) { letters[i].step = k; letters[i].op = s.op; }
    if (s.op === 'M') { letters[s.i[0]].ref = s.j[0]; }
    if (s.op !== 'M') {
      const li = s.i.length ? letters[s.i[0]].line : null;
      if (li !== null) bump(li);
    }
  });

  const word = (j) => ref[j].wordText;
  steps.forEach((s, k) => {
    if (s.op === 'D') {
      // place the mark between the neighbouring letters
      let prev = null, next = null;
      for (let q = k - 1; q >= 0 && !prev; q--) if (steps[q].i.length) prev = letters[steps[q].i[steps[q].i.length - 1]];
      for (let q = k + 1; q < steps.length && !next; q++) if (steps[q].i.length) next = letters[steps[q].i[0]];
      let x, y;
      if (prev && next && prev.line === next.line) { x = (prev.x0 + next.x1) / 2; y = (prev.lineTop + prev.lineBot) / 2; }
      else if (prev) { x = prev.x0 - W * 0.6; y = (prev.lineTop + prev.lineBot) / 2; }
      else if (next) { x = next.x1 + W * 0.6; y = (next.lineTop + next.lineBot) / 2; }
      else { x = w / 2; y = h / 2; }
      if (prev) bump(prev.line);
      add(x, y, W * 0.8, T(`Missing letter? Expected ${name(ref[s.j[0]].ch)} in the word ${word(s.j[0])}`, `אות חסרה? צריכה להיות ${name(ref[s.j[0]].ch)} במילה ${word(s.j[0])}`), 'missing', { refIndex: s.j[0] });
    } else if (s.op === 'I') {
      const g = letters[s.i[0]];
      const [x, y, r] = center(g);
      add(x, y, r, g.tiny ? T('Extra small mark (ink spot?) - check', 'סימן קטן עודף (כתם דיו?) - לבדוק') : T('Extra letter or mark that is not in the text - check', 'אות או סימן עודף שאינו בנוסח - לבדוק'), 'extra');
    } else if (s.op === 'T') {
      const g = letters[s.i[0]];
      const [x, y, r] = center(g);
      const chs = s.j.map((j) => ref[j].ch);
      const a = chs.slice(0, -1).join(', '), b = chs[chs.length - 1];
      add(x, y, r, T(`Letters ${a} and ${b} seem to touch or are very close (word ${word(s.j[0])}) - check`, `האותיות ${a} ו־${b} נראות נוגעות או קרובות מאוד (מילה ${word(s.j[0])}) - לבדוק`), 'touch', { refIndex: s.j[0] });
    } else if (s.op === 'B') {
      const [g1, g2] = s.i.map((i) => letters[i]);
      const x = (Math.min(g1.x0, g2.x0) + Math.max(g1.x1, g2.x1)) / 2, y = (Math.min(g1.y0, g2.y0) + Math.max(g1.y1, g2.y1)) / 2;
      add(x, y, Math.max(g1.x1, g2.x1) - Math.min(g1.x0, g2.x0), T(`Letter ${name(ref[s.j[0]].ch)} seems broken into two pieces (word ${word(s.j[0])}) - check`, `האות ${name(ref[s.j[0]].ch)} נראית שבורה לשני חלקים (מילה ${word(s.j[0])}) - לבדוק`), 'broken', { refIndex: s.j[0] });
    } else if (s.op === 'M') {
      const g = letters[s.i[0]], r = ref[s.j[0]];
      const [x, y, rr] = center(g);
      if (g.probs) {
        let top = 0; g.probs.forEach((p, c) => { if (p > g.probs[top]) top = c; });
        const cc = (model.meta && model.meta.classCounts) || null;
        const knows = (c) => !cc || cc[c] >= 30; // only judge shapes the AI has seen often in real mezuzot
        if (LETTERS[top] !== r.ch && g.probs[top] > 0.75 && g.probs[LETTER_INDEX[r.ch]] < 0.15 && knows(top) && knows(LETTER_INDEX[r.ch])) {
          g.wrong = true;
          add(x, y, rr, T(`Looks like ${name(LETTERS[top])}, but the text has ${name(r.ch)} (word ${r.wordText}) - check`, `נראית כמו ${name(LETTERS[top])}, אבל בנוסח ${name(r.ch)} (מילה ${r.wordText}) - לבדוק`), 'wrong', { refIndex: r.index });
        }
      } else if (s.score < -3) {
        add(x, y, rr, T(`Shape looks unusual for ${name(r.ch)} (word ${r.wordText}) - check`, `צורה לא רגילה ל־${name(r.ch)} (מילה ${r.wordText}) - לבדוק`), 'shape', { refIndex: r.index });
      }
      if (r.wordStart && !g.wordStart && g.gapBefore !== undefined && g.gapBefore < 0.5 * seg.wordGap) add(g.x1 + W * 0.15, y, W * 0.5, T(`Space between words looks too small before ${r.wordText} - check`, `הרווח בין המילים נראה קטן מדי לפני ${r.wordText} - לבדוק`), 'space');
      if (!r.wordStart && g.wordStart && g.gapBefore !== undefined && g.gapBefore > 1.3 * seg.wordGap) add(g.x1 + W * 0.15, y, W * 0.5, T(`Big space inside the word ${r.wordText} - check`, `רווח גדול בתוך המילה ${r.wordText} - לבדוק`), 'space');
    }
  });

  // 3. look inside the letters for cracks, white spots, thin ink, touching legs
  let lowRes = 0, inspected = 0;
  for (const g of letters) {
    if (g.op === 'I' && g.tiny) continue;
    const ch = g.op === 'M' ? ref[g.ref].ch : g.op === 'T' ? steps[g.step].j.map((j) => ref[j].ch).join('') : null;
    const res = inspectLetter(seg, g, ch, sens);
    g.spots = res.spots;
    inspected++; if (res.strokeW < 6) lowRes++;
    for (const sp of res.spots) add(sp.x, sp.y, H * 0.35, sp.note + (g.op === 'M' ? T(` (${ch}, word ${ref[g.ref].wordText})`, ` (${ch}, מילה ${ref[g.ref].wordText})`) : ''), sp.kind);
  }
  if (lowRes > inspected * 0.5) quality.warnings.push({ kind: 'lowres', note: T('Some strokes are too thin in the photo to check for cracks. Move closer or take the klaf in two halves.', 'חלק מהקווים דקים מדי בתמונה לבדיקת סדקים. התקרב או צלם את הקלף בשני חצאים.') });

  // 4. decide which letters are sure enough to teach the AI
  const wordOk = new Map();
  for (const s of steps) for (const j of s.j) {
    const wd = ref[j].word;
    if (!wordOk.has(wd)) wordOk.set(wd, true);
    if (s.op !== 'M') wordOk.set(wd, false);
    else {
      const g = letters[s.i[0]];
      if (g.wordStart !== ref[j].wordStart || g.wrong) wordOk.set(wd, false);
    }
  }
  const samples = [];
  for (const g of letters) {
    const view = viewCrop(seg.gray, g);
    const base = { x: toBytes(g.x), view, box: [g.x0, g.y0, g.x1, g.y1] };
    if (g.op === 'M') {
      const r = ref[g.ref];
      // Sure = its whole word lines up exactly with the text, the line is clean,
      // no problem was found in the letter, and the AI (if any) does not disagree.
      let sure = wordOk.get(r.word) && !(g.spots && g.spots.length) && (lineEdits.get(g.line) || 0) <= 1 && steps[g.step].score > -2;
      let modelP = null;
      if (g.probs) {
        modelP = g.probs[LETTER_INDEX[r.ch]];
        let top = 0; g.probs.forEach((p, c) => { if (p > g.probs[top]) top = c; });
        if (LETTERS[top] !== r.ch && modelP < 0.25) sure = false;
      }
      samples.push({ ...base, label: r.ch, sure: !!sure, modelP, why: sure ? '' : 'not sure' });
    } else if (g.op === 'I' && !g.tiny) {
      let guess = null;
      if (g.probs) { let top = 0; g.probs.forEach((p, c) => { if (p > g.probs[top]) top = c; }); guess = LETTERS[top]; }
      samples.push({ ...base, label: guess, sure: false, why: 'extra' });
    }
  }

  const matched = steps.filter((s) => s.op === 'M').length;
  return {
    ok: true, rgba: seg.rgba, w, h, issues, quality, samples,
    stats: {
      found: letters.length, expected: ref.length, matched, lines: seg.lines.length,
      missing: steps.filter((s) => s.op === 'D').length, extra: steps.filter((s) => s.op === 'I').length,
      touching: steps.filter((s) => s.op === 'T').length, broken: steps.filter((s) => s.op === 'B').length,
      sure: samples.filter((s) => s.sure).length, usedModel: !!model,
    },
    boxes: letters.map((g) => ({ b: [g.x0, g.y0, g.x1, g.y1], op: g.op, ch: g.op === 'M' ? ref[g.ref].ch : null })),
    // one entry per letter of the text that was found on its own: used for before/after and the printed-copy check
    letters: letters.filter((g) => g.op === 'M').map((g) => ({
      j: g.ref, b: [g.x0, g.y0, g.x1, g.y1], ink: g.ink, dark: Math.round(g.dark * 10) / 10,
      spots: (g.spots || []).length, fp: fingerprint(g.x),
    })),
    letterH: H,
  };
}
