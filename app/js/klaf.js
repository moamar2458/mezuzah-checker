// Finding the klaf in a photo (like a document scanner) and cutting it out straight.
// Everything outside the klaf (cloth, case, table) is never checked.

/** A small grey copy of the picture (longest side = side). */
function smallGray(rgba, w, h, side) {
  const s = Math.min(1, side / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * s)), sh = Math.max(8, Math.round(h * s));
  const g = new Float32Array(sw * sh);
  const fx = w / sw, fy = h / sh;
  const step = Math.max(1, Math.round(Math.min(fx, fy) / 2)); // a few samples per cell are enough
  for (let y = 0; y < sh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < sw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy += step) for (let xx = x0; xx < x1; xx += step) {
        const i = (yy * w + xx) * 4;
        sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; n++;
      }
      g[y * sw + x] = sum / n;
    }
  }
  return { w: sw, h: sh, d: g, sx: w / sw, sy: h / sh };
}

function filter(img, r, useMax) {
  const { w, h, d } = img;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const pick = useMax ? Math.max : Math.min;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = d[y * w + x];
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = pick(m, d[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = tmp[y * w + x];
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = pick(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return { ...img, d: out };
}

function otsu(d) {
  const hist = new Float64Array(256);
  for (const v of d) hist[Math.max(0, Math.min(255, v | 0))]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const polyArea = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; };

/** Cut a convex outline down to its 4 main corners (drop the corner that changes the area least, again and again). */
function fourCorners(h) {
  const p = h.slice();
  while (p.length > 4) {
    let best = 0, bestA = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = Math.abs(cross(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length]));
      if (a < bestA) { bestA = a; best = i; }
    }
    p.splice(best, 1);
  }
  return p;
}

/** Order as top-left, top-right, bottom-right, bottom-left. */
function order(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const byAng = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0; byAng.forEach((p, i) => { if (p[0] + p[1] < byAng[k][0] + byAng[k][1]) k = i; });
  return [0, 1, 2, 3].map((i) => byAng[(k + i) % 4]);
}

/**
 * Find the klaf: the large bright sheet in the picture (the letters are erased first, so the sheet is one even area).
 * Returns { quad: [[x,y] ×4] (top-left, top-right, bottom-right, bottom-left, in picture pixels), full, cover } or null.
 * full = the klaf fills the whole picture (or cannot be told apart from what is around it).
 */
export function findKlaf(rgba, w, h, side = 240, fine = 900) {
  const sm = smallGray(rgba, w, h, side);
  const r = Math.max(2, Math.round(Math.max(sm.w, sm.h) / 80));
  const closed = filter(filter(sm, r, true), r, false); // erase thin dark letters
  const t = otsu(closed.d);
  const W = sm.w, H = sm.h, N = W * H;
  const fullQuad = { quad: [[0, 0], [w, 0], [w, h], [0, h]], full: true, cover: 1 };
  let lo = 0, hi = 0, nlo = 0, nhi = 0;
  for (const v of closed.d) if (v > t) { hi += v; nhi++; } else { lo += v; nlo++; }
  if (!nlo || !nhi || hi / nhi - lo / nlo < 25) return fullQuad; // one even surface: the klaf fills the picture
  // bright connected areas; keep the biggest one, preferring the middle of the picture
  const lab = new Int32Array(N);
  let best = null;
  for (let s = 0; s < N; s++) {
    if (lab[s] || closed.d[s] <= t) continue;
    const id = s + 1, stack = [s], px = []; lab[s] = id;
    let edge = 0;
    while (stack.length) {
      const p = stack.pop(); px.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge++;
      if (x > 0 && !lab[p - 1] && closed.d[p - 1] > t) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && !lab[p + 1] && closed.d[p + 1] > t) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && !lab[p - W] && closed.d[p - W] > t) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && !lab[p + W] && closed.d[p + W] > t) { lab[p + W] = id; stack.push(p + W); }
    }
    let cx = 0, cy = 0; for (const p of px) { cx += p % W; cy += (p / W) | 0; }
    cx /= px.length; cy /= px.length;
    const off = Math.hypot(cx / W - 0.5, cy / H - 0.5);
    const score = px.length * (1 - off);
    if (!best || score > best.score) best = { px, score, edge };
  }
  if (!best || best.px.length < N * 0.06) return null;
  // its outline (row ends are enough for a convex outline)
  const left = new Int32Array(H).fill(-1), right = new Int32Array(H).fill(-1);
  for (const p of best.px) { const x = p % W, y = (p / W) | 0; if (left[y] < 0 || x < left[y]) left[y] = x; if (x > right[y]) right[y] = x; }
  const pts = [];
  for (let y = 0; y < H; y++) if (left[y] >= 0) { pts.push([left[y], y], [right[y] + 1, y], [left[y], y + 1], [right[y] + 1, y + 1]); }
  const hl = hull(pts);
  const hullA = polyArea(hl);
  if (hullA > N * 0.9) return fullQuad;
  if (best.px.length < hullA * 0.8) return null; // not a sheet shape (a crumpled cloth, scattered light)
  const q4 = order(fourCorners(hl));
  if (polyArea(q4) < hullA * 0.9) return null;
  const rough = q4.map(([x, y]) => [x * sm.sx, y * sm.sy]);
  // the rough corners come from a small picture: find the real edges of the klaf on a bigger one
  let quad = rough;
  try { quad = refineEdges(rgba, w, h, rough, fine) || rough; } catch { /* keep the rough corners */ }
  quad = quad.map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]);
  return { quad, full: false, cover: polyArea(quad) / (w * h), refined: quad !== rough };
}

let EXPAND = 0.004; // the frame is put this much (part of the picture size) outside the found edge
export const setExpand = (v) => { EXPAND = v; };

/** Bilinear value of a small grey picture at (x, y); null outside. */
function at(img, x, y) {
  if (x < 0 || y < 0 || x > img.w - 1.001 || y > img.h - 1.001) return null;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * img.w + x0, d = img.d;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + img.w] * (1 - fx) + d[i + img.w + 1] * fx) * fy;
}

/** Straight line through points (total least squares), dropping points far from it. Returns { px, py, dx, dy } or null. */
function fitLine(pts) {
  let use = pts;
  let L = null;
  for (let it = 0; it < 3; it++) {
    if (use.length < 6) return L;
    let mx = 0, my = 0; for (const [x, y] of use) { mx += x; my += y; } mx /= use.length; my /= use.length;
    let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of use) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    L = { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
    const res = pts.map(([x, y]) => Math.abs((x - L.px) * L.dy - (y - L.py) * L.dx));
    const sorted = res.slice().sort((a, b) => a - b);
    const lim = Math.max(1.2, sorted[Math.floor(sorted.length / 2)] * 2.5);
    use = pts.filter((p, i) => res[i] <= lim);
  }
  return L;
}
function meet(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return [a.px + a.dx * t, a.py + a.dy * t];
}

/**
 * The real edge of the klaf near each rough side: walking across the side, the place where the (letter-free) picture
 * drops most from klaf to background. A straight line is fitted through those places on each side,
 * and the corners are where the lines meet – so a crooked or bumpy outline still gives the true four corners.
 */
function refineEdges(rgba, w, h, rough, fineSide) {
  const fm = smallGray(rgba, w, h, Math.min(Math.max(w, h), fineSide));
  const r = Math.max(2, Math.round(Math.max(fm.w, fm.h) / 150));
  const cl = filter(filter(fm, r, true), r, false); // letters erased, the klaf edge kept
  const q = rough.map(([x, y]) => [x / fm.sx, y / fm.sy]);
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const R = Math.max(6, 0.05 * Math.max(fm.w, fm.h));
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const A = q[i], B = q[(i + 1) % 4];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    let nx = -(B[1] - A[1]) / len, ny = (B[0] - A[0]) / len;
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // point outwards
    const pts = [];
    const N = 60;
    for (let k = 0; k < N; k++) {
      const t = 0.08 + (0.84 * k) / (N - 1);
      const px = A[0] + (B[0] - A[0]) * t, py = A[1] + (B[1] - A[1]) * t;
      let best = 0, bestS = null;
      for (let s = -R; s <= R; s += 0.5) {
        const inn = at(cl, px + nx * (s - 2), py + ny * (s - 2)), out = at(cl, px + nx * (s + 2), py + ny * (s + 2));
        if (inn === null || out === null) continue;
        const drop = inn - out;
        if (drop > best) { best = drop; bestS = s; }
      }
      if (bestS !== null && best >= 14) pts.push([px + nx * bestS, py + ny * bestS]);
    }
    // a side that runs along the picture border (klaf cut off by the photo) keeps its rough line
    lines.push(pts.length >= 15 ? fitLine(pts) : null);
    if (!lines[i]) lines[i] = { px: A[0], py: A[1], dx: (B[0] - A[0]) / len, dy: (B[1] - A[1]) / len };
  }
  const corners = [];
  for (let i = 0; i < 4; i++) { const c = meet(lines[(i + 3) % 4], lines[i]); if (!c) return null; corners.push(c); }
  // a little outside the edge, so the whole klaf is in the frame
  const ex = corners.map(([x, y]) => { const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1; const k = (EXPAND * Math.max(fm.w, fm.h)) / L; return [(x + dx * k) * fm.sx, (y + dy * k) * fm.sy]; });
  // sanity: the refined shape must stay close to the rough one
  const a0 = polyArea(rough), a1 = polyArea(ex), diag = Math.hypot(w, h);
  if (a1 < a0 * 0.8 || a1 > a0 * 1.35) return null;
  if (ex.some((p, i) => Math.hypot(p[0] - rough[i][0], p[1] - rough[i][1]) > 0.08 * diag)) return null;
  if (cross(ex[0], ex[1], ex[2]) <= 0 || cross(ex[1], ex[2], ex[3]) <= 0 || cross(ex[2], ex[3], ex[0]) <= 0 || cross(ex[3], ex[0], ex[1]) <= 0) return null;
  return ex;
}

/** The perspective map from the output rectangle (ow × oh) to the quad in the picture. */
function homography(quad, ow, oh) {
  const src = [[0, 0], [ow, 0], [ow, oh], [0, oh]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = quad[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Cut the quad out of the picture and make it a straight rectangle (longest side at most maxSide).
 * Returns { rgba, w, h }.
 */
export function warpQuad(rgba, w, h, quad, maxSide = 3200) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2]));
  let oh = Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]));
  const s = Math.min(1, maxSide / Math.max(ow, oh));
  ow = Math.max(8, Math.round(ow * s)); oh = Math.max(8, Math.round(oh * s));
  const [a, b, c, dd, e, f, g, hh] = homography(quad, ow, oh);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < ow; x++) {
      const xc = x + 0.5;
      const z = g * xc + hh * yc + 1;
      const u = Math.min(w - 1.001, Math.max(0, (a * xc + b * yc + c) / z - 0.5));
      const v = Math.min(h - 1.001, Math.max(0, (dd * xc + e * yc + f) / z - 0.5));
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
      const o = (y * ow + x) * 4;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (rgba[i00 + k] * (1 - fx) + rgba[i10 + k] * fx) * (1 - fy) + (rgba[i01 + k] * (1 - fx) + rgba[i11 + k] * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { rgba: out, w: ow, h: oh };
}
