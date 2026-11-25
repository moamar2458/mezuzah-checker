// Look inside each letter for spots the sofer should check:
// white spots / cracks in the ink, very thin places, closed shapes, extra pieces.
import { distanceTransform, skeletonize, median } from './imageproc.js';
import { maskFromLabels } from './crop.js';
import { T } from './i18n.js';

const EXPECTED_PARTS = { 'ה': 2, 'ק': 2 };
const HAS_HOLE = new Set(['ם', 'ס', 'ט']);

function backgroundHoles(m, w, h) {
  // 4-connected background regions that do not touch the border
  const lab = new Int32Array(w * h);
  const holes = [];
  let id = 0;
  for (let s = 0; s < w * h; s++) {
    if (m[s] || lab[s]) continue;
    id++;
    const stack = [s]; lab[s] = id;
    let area = 0, border = false, sx = 0, sy = 0;
    const px = [];
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y; px.push(p);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && !m[q] && !lab[q]) { lab[q] = id; stack.push(q); }
    }
    if (!border) holes.push({ area, x: sx / area, y: sy / area, px });
  }
  return holes.sort((a, b) => b.area - a.area);
}

export const HOLE_MIN = 0.06;    // smallest white spot: this part of the letter height, squared
export const HOLE_BRIGHT = 0.8;  // and at least this bright compared with the klaf
export const HOLE_WIDE = 0.8;    // and narrower than this part of the stroke width

/** Brightness of the klaf just around a letter (from the normalised picture). */
function klafAround(seg, b) {
  const vals = [];
  const pad = Math.round(seg.H * 0.4);
  const x0 = Math.max(0, b.x0 - pad), x1 = Math.min(seg.w - 1, b.x1 + pad), y0 = Math.max(0, b.y0 - pad), y1 = Math.min(seg.h - 1, b.y1 + pad);
  const step = Math.max(1, Math.round(seg.H / 12));
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) vals.push(seg.norm.d[y * seg.w + x]);
  vals.sort((a, b) => b - a);
  return Math.max(60, vals[Math.floor(vals.length * 0.2)] || 235);
}

/**
 * Returns a list of { kind, x, y, note } in image coordinates.
 * ch: the letter of the text this blob was matched to (or null).
 */
export function inspectLetter(seg, g, ch, sens = 0.15) {
  const out = [];
  const pad = 1;
  const box = {
    x0: Math.max(0, g.x0 - pad), y0: Math.max(0, g.y0 - pad),
    x1: Math.min(seg.w - 1, g.x1 + pad), y1: Math.min(seg.h - 1, g.y1 + pad),
  };
  const { m, w, h } = maskFromLabels(seg.labels, seg.w, box, g.ids);
  let ink = 0; for (const v of m) ink += v;

  const dt = distanceTransform(m, w, h);
  const sk = skeletonize(m, w, h);
  const widths = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) widths.push(2 * dt[i]);
  const strokeW = median(widths);

  // holes = white spots inside the ink (possible crack / missing ink), or a closed shape
  const holes = backgroundHoles(m, w, h);
  // A real gap shows the klaf through the ink: big enough to see, and nearly as bright as the klaf around the letter.
  // Tiny or greyish specks are klaf texture, light and photo noise – not checked.
  const minHole = Math.max(6, (seg.H * HOLE_MIN) ** 2);
  const paper = klafAround(seg, box);
  let nHoles = 0;
  holes.forEach((hole, k) => {
    if (k === 0 && ch && [...ch].some((c) => HAS_HOLE.has(c))) return; // the natural inside of ם ס ט
    if (hole.area < minHole) return;
    const big = hole.area > 0.06 * w * h;
    if (!big) {
      // the brightest part of the spot, compared with the klaf (0 = like the ink, 1 = like the klaf)
      const vals = hole.px.map((p) => seg.norm.d[(box.y0 + ((p / w) | 0)) * seg.w + box.x0 + (p % w)]).sort((a, b) => b - a);
      const top = vals[Math.floor(vals.length * 0.25)];
      if (top < paper * HOLE_BRIGHT) return;
      // a gap inside a stroke is narrower than the stroke; a wider one is the space between two strokes (closed by a crown or blur)
      const hm = new Uint8Array(w * h); for (const p of hole.px) hm[p] = 1;
      const hd = distanceTransform(hm, w, h);
      let wide = 0; for (const p of hole.px) if (hd[p] > wide) wide = hd[p];
      if (2 * wide > HOLE_WIDE * Math.max(2, strokeW)) return;
      if (++nHoles > 2) return; // a letter full of spots is a noisy photo, not many cracks
    }
    out.push({
      kind: big ? 'closed' : 'hole', x: box.x0 + hole.x, y: box.y0 + hole.y,
      note: big ? T('Shape looks closed here - check that the letter is not closed', 'הצורה נראית סגורה כאן - לבדוק שהאות לא סגורה') : T('White spot inside the ink - check for a crack or missing ink', 'נקודה לבנה בתוך הדיו - לבדוק סדק או חסר דיו'),
    });
  });

  // thin places along the strokes
  if (strokeW >= 6) {
    const nb = (x, y) => {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) c++;
      }
      return c;
    };
    const ends = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sk[y * w + x] && nb(x, y) === 1) ends.push([x, y]);
    const nearEnd = (x, y) => ends.some(([ex, ey]) => Math.abs(ex - x) + Math.abs(ey - y) <= strokeW * 1.2);
    const lim = sens * strokeW;
    // how thick does the stroke get on each side of this point (walking along the skeleton)?
    const sidesThick = (x0, y0) => {
      const seen = new Set([y0 * w + x0]);
      const starts = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x0 + dx, yy = y0 + dy;
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) starts.push(yy * w + xx);
      }
      if (starts.length !== 2) return false;
      starts.forEach((s) => seen.add(s));
      const reach = Math.ceil(strokeW * 2.5);
      const need = Math.max(3 * Math.max(0.5, dt[y0 * w + x0]), 0.35 * strokeW);
      return starts.every((s) => {
        let front = [s], best = dt[s];
        for (let step = 0; step < reach && front.length; step++) {
          const nf = [];
          for (const p of front) {
            const px = p % w, py = (p / w) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const xx = px + dx, yy = py + dy, q = yy * w + xx;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h || !sk[q] || seen.has(q)) continue;
              seen.add(q); nf.push(q); if (dt[q] > best) best = dt[q];
            }
          }
          front = nf;
        }
        return best >= need;
      });
    };
    const spots = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!sk[i] || 2 * dt[i] > lim || nb(x, y) !== 2 || nearEnd(x, y) || !sidesThick(x, y)) continue;
      const s = spots.find((p) => Math.abs(p.x - x) + Math.abs(p.y - y) <= strokeW);
      if (s) { s.n++; } else spots.push({ x, y, n: 1 });
    }
    for (const s of spots.slice(0, 2)) {
      out.push({ kind: 'thin', x: box.x0 + s.x, y: box.y0 + s.y, note: T('Ink is very thin here - check for a crack or break', 'הדיו דק מאוד כאן - לבדוק סדק או שבר') });
    }
  }

  // ch can be several letters when they are joined in one blob
  const expParts = ch ? [...ch].reduce((n, c) => n + (EXPECTED_PARTS[c] || 1), 0) : 1;
  if (g.parts > expParts) {
    out.push({ kind: 'pieces', x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, note: T(`Letter is made of ${g.parts} separate pieces - check for a break`, `האות בנויה מ־${g.parts} חלקים נפרדים - לבדוק שבר`) });
  }
  if (ch === 'ה' || ch === 'ק') {
    if (g.parts < 2) out.push({ kind: 'leg', x: g.x0 + (g.x1 - g.x0) * 0.2, y: (g.y0 + g.y1) / 2, note: T(`The left leg of ${ch} seems to touch the roof - check`, `הרגל השמאלית של ${ch} נראית נוגעת בגג - לבדוק`) });
  }
  if (g.bridge) {
    const at = g.bridgeAt || { x: (g.x0 + g.x1) / 2, y: g.y1 };
    out.push({ kind: 'bridge', x: at.x, y: at.y, note: T('Letter seems to touch a letter (or crown) in the next line', 'האות נראית נוגעת באות (או בתג) בשורה הבאה') });
  }
  return { spots: out, strokeW, ink };
}
