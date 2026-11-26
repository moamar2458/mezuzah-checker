// Spot memory: small places on letters that the sofer marked as "good" or "problem", with a short note.
// Each mark is kept as a tiny picture of that place (9x9, cut from the big letter view).
// In later checks, the same place on another letter of the same kind is circled when it looks like a marked problem
// AND unlike the same place on the other letters of that kind in the same mezuzah.
// A marked "good" place stops similar places from being circled, and is mentioned next to the app's own marks.
// It only points to places for the sofer to check. It never decides kosher or not.

export const ZOOM = 96; // size of the big letter view kept for marking
const P = 9;            // a place is compared as a P×P picture
const NN = P * P;

/** The square of the photo that a letter view shows (the same square as viewCrop in crop.js). */
export function viewSquare(box) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const side = Math.max(bw, bh) * 1.4 + 4;
  return { left: (box.x0 + box.x1) / 2 - side / 2, top: (box.y0 + box.y1) / 2 - side / 2, side };
}

/** Paper and ink grey levels of a view, so photos with different light compare the same. */
export function levels(view) {
  const h = new Uint32Array(256);
  for (let i = 0; i < view.length; i++) h[view[i]]++;
  const at = (q) => { let s = 0; const lim = view.length * q; for (let v = 0; v < 256; v++) { s += h[v]; if (s >= lim) return v; } return 255; };
  const paper = at(0.85);
  const ink = Math.min(at(0.03), paper - 30);
  return { paper, k: 1 / (paper - ink) };
}

const sample = (view, n, x, y) => {
  // bilinear, outside = paper
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g = (xx, yy) => (xx >= 0 && yy >= 0 && xx < n && yy < n ? view[yy * n + xx] : 255);
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
};

/** The P×P picture of a place: u, v = center (0..1 of the view), r = radius (0..1). 1 = ink, 0 = klaf. */
export function patch(view, lv, u, v, r) {
  const n = Math.round(Math.sqrt(view.length));
  const out = new Float32Array(NN);
  for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
    const su = u + (((i + 0.5) / P) * 2 - 1) * r, sv = v + (((j + 0.5) / P) * 2 - 1) * r;
    const val = sample(view, n, su * n - 0.5, sv * n - 0.5);
    out[j * P + i] = Math.min(1, Math.max(0, (lv.paper - val) * lv.k));
  }
  return out;
}

/** Mean difference between two place pictures (0 = same, 1 = opposite). Stops early above `limit`. */
function diff(a, b, limit = Infinity) {
  let s = 0; const lim = limit * NN;
  for (let i = 0; i < NN; i++) { s += Math.abs(a[i] - b[i]); if (s > lim) return Infinity; }
  return s / NN;
}

/**
 * Turn the saved marks into what the checker compares with.
 * records: [{ uid, label, zoom: Uint8Array, marks: [{ u, v, r, kind: 'good'|'problem', note }] }]
 */
export function prepareMemory(records) {
  const out = [];
  for (const rec of records || []) {
    if (!rec || !rec.zoom || !rec.marks || !rec.marks.length) continue;
    const lv = levels(rec.zoom);
    for (const m of rec.marks) {
      out.push({ uid: rec.uid, label: rec.label, u: m.u, v: m.v, r: m.r, kind: m.kind, note: m.note || '', d: patch(rec.zoom, lv, m.u, m.v, m.r) });
    }
  }
  return out;
}

// how close a place must be to a marked problem, and how much more it must look like the problem
// than like the same place on the other letters of its kind
const NEAR = 0.16, RATIO = 0.6, MIN_ODD = 0.1;

/**
 * letters: [{ label, zoom }] – every letter of the check that was matched to the text.
 * A marked problem is looked for on the letters of the same kind (a mark on an א is looked for on every א).
 * Returns [{ li (letter index), mark, u, v, r, d }] – places to circle, at most `maxPerMark` for each marked problem.
 */
export function findTaught(letters, memory, { maxPerMark = 6, maxMarks = 40 } = {}) {
  const problems = (memory || []).filter((m) => m.kind === 'problem' || m.kind === 'mehudar').slice(-maxMarks);
  const goods = (memory || []).filter((m) => m.kind === 'good');
  if (!problems.length || !letters.length) return [];
  for (const L of letters) if (!L.lv) L.lv = levels(L.zoom);
  const byLabel = {};
  letters.forEach((L, i) => { (byLabel[L.label] = byLabel[L.label] || []).push(i); });

  // best place near (u, v) on letter L that looks like `target`
  const search = (L, target, u, v, r, reach, step, limit) => {
    let best = { d: Infinity };
    for (let dv = -reach; dv <= reach + 1e-9; dv += step) for (let du = -reach; du <= reach + 1e-9; du += step) {
      const pu = u + du, pv = v + dv;
      const d = diff(patch(L.zoom, L.lv, pu, pv, r), target, Math.min(limit, best.d));
      if (d < best.d) best = { d, u: pu, v: pv };
    }
    return best;
  };
  // how unusual a place is: the typical difference to the same place on the other letters of this kind
  const oddness = (li, pic, u, v, r) => {
    const ids = (byLabel[letters[li].label] || []).filter((i) => i !== li);
    if (ids.length < 4) return null;
    const pick = ids.length > 30 ? Array.from({ length: 30 }, (_, k) => ids[Math.floor((k * ids.length) / 30)]) : ids;
    const ds = pick.map((i) => search(letters[i], pic, u, v, r, 0.06, 0.03, Infinity).d).sort((a, b) => a - b);
    return ds[Math.floor(ds.length * 0.3)];
  };

  const hits = [];
  const taken = new Set();
  for (const mk of problems) {
    const cands = [];
    for (const li of byLabel[mk.label] || []) {
      const b = search(letters[li], mk.d, mk.u, mk.v, mk.r, 0.06, 0.02, NEAR);
      if (b.d < NEAR) cands.push({ li, ...b });
    }
    cands.sort((a, b) => a.d - b.d);
    let n = 0, misses = 0;
    for (const c of cands) {
      if (n >= maxPerMark || misses >= 6) break; // the closest ones were normal places: the rest are too
      const key = `${c.li}:${Math.round(c.u * 10)}:${Math.round(c.v * 10)}`;
      if (taken.has(key)) continue;
      const L = letters[c.li];
      const pic = patch(L.zoom, L.lv, c.u, c.v, mk.r);
      const odd = oddness(c.li, pic, c.u, c.v, mk.r);
      if (odd === null ? c.d > NEAR / 3 : (odd < MIN_ODD || c.d > RATIO * odd)) { misses++; continue; }
      if (goods.some((g) => diff(pic, g.d, c.d) < c.d)) { misses++; continue; } // looks even more like a place marked good
      taken.add(key); n++;
      hits.push({ li: c.li, mark: mk, u: c.u, v: c.v, r: mk.r, d: c.d, odd });
    }
  }
  return hits;
}

/** A marked "good" place that looks like this place (and more than any marked problem), or null. */
export function goodLike(L, memory, u, v, r = 0.08) {
  const goods = (memory || []).filter((m) => m.kind === 'good');
  if (!goods.length) return null;
  if (!L.lv) L.lv = levels(L.zoom);
  let best = null, bestD = 0.1;
  for (const g of goods) {
    const d = diff(patch(L.zoom, L.lv, u, v, g.r), g.d, bestD);
    if (d < bestD) { best = g; bestD = d; }
  }
  if (!best) return null;
  for (const p of memory) if ((p.kind === 'problem' || p.kind === 'mehudar') && diff(patch(L.zoom, L.lv, u, v, p.r), p.d, bestD) < bestD) return null;
  return best;
}

/** The saved mark of any kind (kosher / not kosher / mehudar) that looks most like this place, or null. */
export function similarMark(L, memory, u, v, limit = 0.1) {
  if (!memory || !memory.length) return null;
  if (!L.lv) L.lv = levels(L.zoom);
  let best = null, bestD = limit;
  for (const m of memory) {
    if (m.label && L.label && m.label !== L.label) continue;
    const d = diff(patch(L.zoom, L.lv, u, v, m.r), m.d, bestD);
    if (d < bestD) { best = m; bestD = d; }
  }
  return best;
}
