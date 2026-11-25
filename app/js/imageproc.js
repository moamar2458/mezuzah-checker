// Basic image processing on plain typed arrays. No dependencies.
// A "gray" image is { w, h, d: Float32Array } with values 0..255.

export function rgbaToGray(rgba, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) {
    d[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return { w, h, d };
}

/** Box blur with radius r using an integral image. */
export function boxBlur(img, r) {
  const { w, h, d } = img;
  const W = w + 1;
  const integ = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += d[y * w + x];
      integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return { w, h, d: out };
}

/** Downscale by an integer factor (area average). */
export function shrink(img, f) {
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) s += img.d[(y * f + yy) * img.w + x * f + xx];
    d[y * w + x] = s / (f * f);
  }
  return { w, h, d };
}

function maxFilter(img, r) {
  const { w, h, d } = img;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, d[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return { w, h, d: out };
}

/** Bilinear sample of a small image at full-size coordinates. */
function sampleUp(small, f, x, y) {
  const sx = Math.min(small.w - 1.001, Math.max(0, x / f - 0.5));
  const sy = Math.min(small.h - 1.001, Math.max(0, y / f - 0.5));
  const x0 = Math.floor(sx), y0 = Math.floor(sy), ax = sx - x0, ay = sy - y0;
  const i = y0 * small.w + x0;
  return (small.d[i] * (1 - ax) + small.d[i + 1] * ax) * (1 - ay) +
         (small.d[i + small.w] * (1 - ax) + small.d[i + small.w + 1] * ax) * ay;
}

/**
 * Even out lighting: estimate the parchment brightness (ink is dark, so a
 * local max filter removes it) and divide by it. Result: 0 = ink, ~255 = klaf.
 */
export function normalizeLight(gray, letterSize = 40) {
  const f = Math.max(2, Math.round(letterSize / 4));
  const small = shrink(gray, f);
  const bg = boxBlur(maxFilter(small, 3), 3);
  const out = new Float32Array(gray.w * gray.h);
  for (let y = 0; y < gray.h; y++) for (let x = 0; x < gray.w; x++) {
    const b = Math.max(8, sampleUp(bg, f, x, y));
    out[y * gray.w + x] = Math.min(255, (gray.d[y * gray.w + x] / b) * 235);
  }
  return { w: gray.w, h: gray.h, d: out };
}

export function otsu(img, step = 1) {
  const hist = new Float64Array(256);
  for (let i = 0; i < img.d.length; i += step) hist[Math.max(0, Math.min(255, img.d[i] | 0))]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

/** Binary ink mask: 1 where darker than threshold. */
export function binarize(img, t) {
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) m[i] = img.d[i] < t ? 1 : 0;
  return { w: img.w, h: img.h, d: m };
}

/**
 * 8-connected component labeling.
 * Returns { labels: Int32Array (0 = background), comps: [{id, x0,y0,x1,y1, area, sx, sy}] }
 */
export function components(mask) {
  const { w, h, d } = mask;
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  let next = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    const n = [];
    if (x > 0 && labels[i - 1]) n.push(labels[i - 1]);
    if (y > 0) {
      if (labels[i - w]) n.push(labels[i - w]);
      if (x > 0 && labels[i - w - 1]) n.push(labels[i - w - 1]);
      if (x < w - 1 && labels[i - w + 1]) n.push(labels[i - w + 1]);
    }
    if (!n.length) { labels[i] = next; parent.push(next); next++; }
    else { let m = n[0]; for (const v of n) m = Math.min(m, v); labels[i] = m; for (const v of n) union(m, v); }
  }
  const remap = new Int32Array(next);
  const comps = [];
  for (let l = 1; l < next; l++) {
    const r = find(l);
    if (!remap[r]) { comps.push({ id: comps.length + 1, x0: w, y0: h, x1: -1, y1: -1, area: 0, sx: 0, sy: 0 }); remap[r] = comps.length; }
    remap[l] = remap[r];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!labels[i]) continue;
    const id = remap[labels[i]];
    labels[i] = id;
    const c = comps[id - 1];
    if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
    if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
    c.area++; c.sx += x; c.sy += y;
  }
  for (const c of comps) { c.cx = c.sx / c.area; c.cy = c.sy / c.area; c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; }
  return { labels, comps };
}

/** Sharpness: variance of the Laplacian (higher = sharper). */
export function sharpness(gray) {
  const { w, h, d } = gray;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * d[i] - d[i - 1] - d[i + 1] - d[i - w] - d[i + w];
    s += l; s2 += l * l; n++;
  }
  const m = s / n;
  return s2 / n - m * m;
}

export function brightness(gray) {
  let s = 0, bright = 0;
  for (let i = 0; i < gray.d.length; i++) { s += gray.d[i]; if (gray.d[i] > 250) bright++; }
  return { mean: s / gray.d.length, glare: bright / gray.d.length };
}

/** Estimate text skew (radians) from ink pixel positions: the angle that gives the sharpest row profile. */
export function estimateSkew(mask, maxDeg = 6, stepDeg = 0.2) {
  const { w, h, d } = mask;
  const pts = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 400000)));
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) if (d[y * w + x]) pts.push(x - w / 2, y - h / 2);
  if (pts.length < 100) return 0;
  // bins as wide as the sampling step, so the sampling grid itself does not create fake "lines"
  const size = Math.ceil(Math.hypot(w, h) / stride) + 4;
  const hist = new Float64Array(size);
  let best = -1, bestA = 0;
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += stepDeg) {
    const a = (deg * Math.PI) / 180, sn = Math.sin(a), cs = Math.cos(a);
    hist.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const yy = Math.round((pts[i + 1] * cs - pts[i] * sn) / stride + size / 2);
      hist[yy]++;
    }
    let v = 0;
    for (let i = 1; i < size; i++) { const dd = hist[i] - hist[i - 1]; v += dd * dd; }
    if (v > best) { best = v; bestA = a; }
  }
  return bestA;
}

/**
 * Rotate an RGBA image by -angle around its center (so text skewed by `angle` becomes level).
 * Bilinear; outside pixels are filled with the edge color.
 */
export function rotateRGBA(rgba, w, h, angle) {
  const out = new Uint8ClampedArray(w * h * 4);
  const cs = Math.cos(angle), sn = Math.sin(angle), cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy;
    let sx = cx + dx * cs - dy * sn, sy = cy + dx * sn + dy * cs;
    sx = Math.min(w - 1.001, Math.max(0, sx)); sy = Math.min(h - 1.001, Math.max(0, sy));
    const x0 = sx | 0, y0 = sy | 0, ax = sx - x0, ay = sy - y0;
    const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4, o = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) {
      out[o + c] = (rgba[i00 + c] * (1 - ax) + rgba[i10 + c] * ax) * (1 - ay) + (rgba[i01 + c] * (1 - ax) + rgba[i11 + c] * ax) * ay;
    }
  }
  return out;
}

/** Chamfer (3-4) distance transform of a binary mask: distance of each ink pixel to the nearest background, in pixels. */
export function distanceTransform(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/** Zhang-Suen thinning. Returns a new Uint8Array skeleton. */
export function skeletonize(mask, w, h) {
  const s = Uint8Array.from(mask);
  const P = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : s[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const del = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!s[y * w + x]) continue;
        const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1);
        const p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let A = 0; for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
        if (A !== 1) continue;
        if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(y * w + x);
      }
      if (del.length) { changed = true; for (const i of del) s[i] = 0; }
    }
  }
  return s;
}

export function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  return a[a.length >> 1];
}
