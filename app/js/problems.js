// Look inside each letter for spots the sofer should check:
// white spots / cracks in the ink, very thin places, closed shapes, extra pieces.
import { distanceTransform, skeletonize, median } from './imageproc.js';
import { maskFromLabels } from './crop.js';

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
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && !m[q] && !lab[q]) { lab[q] = id; stack.push(q); }
    }
    if (!border) holes.push({ area, x: sx / area, y: sy / area });
  }
  return holes.sort((a, b) => b.area - a.area);
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

  // holes = white spots inside the ink (possible crack / missing ink), or a closed shape
  const holes = backgroundHoles(m, w, h);
  const minHole = Math.max(2, (seg.H * 0.03) ** 2);
  holes.forEach((hole, k) => {
    if (k === 0 && ch && [...ch].some((c) => HAS_HOLE.has(c))) return; // the natural inside of ם ס ט
    if (hole.area < minHole) return;
    const big = hole.area > 0.06 * w * h;
    out.push({
      kind: big ? 'closed' : 'hole', x: box.x0 + hole.x, y: box.y0 + hole.y,
      note: big ? 'Shape looks closed here - check that the letter is not closed' : 'White spot inside the ink - check for a crack or missing ink',
    });
  });

  // thin places along the strokes
  const dt = distanceTransform(m, w, h);
  const sk = skeletonize(m, w, h);
  const widths = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) widths.push(2 * dt[i]);
  const strokeW = median(widths);
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
      out.push({ kind: 'thin', x: box.x0 + s.x, y: box.y0 + s.y, note: 'Ink is very thin here - check for a crack or break' });
    }
  }

  // ch can be several letters when they are joined in one blob
  const expParts = ch ? [...ch].reduce((n, c) => n + (EXPECTED_PARTS[c] || 1), 0) : 1;
  if (g.parts > expParts) {
    out.push({ kind: 'pieces', x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, note: `Letter is made of ${g.parts} separate pieces - check for a break` });
  }
  if (ch === 'ה' || ch === 'ק') {
    if (g.parts < 2) out.push({ kind: 'leg', x: g.x0 + (g.x1 - g.x0) * 0.2, y: (g.y0 + g.y1) / 2, note: `The left leg of ${ch} seems to touch the roof - check` });
  }
  if (g.bridge) {
    const at = g.bridgeAt || { x: (g.x0 + g.x1) / 2, y: g.y1 };
    out.push({ kind: 'bridge', x: at.x, y: at.y, note: 'Letter seems to touch a letter (or crown) in the next line' });
  }
  return { spots: out, strokeW, ink };
}
