// Find text lines, letters and words on the photo of the klaf.
import {
  rgbaToGray, normalizeLight, otsu, binarize, components, estimateSkew, rotateRGBA, median,
} from './imageproc.js';

const fit = (pts) => {
  // least squares y = a + b*x; falls back to a constant
  const n = pts.length;
  if (!n) return { a: 0, b: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx;
  if (n < 4 || Math.abs(den) < 1e-6) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / den;
  return { a: (sy - b * sx) / n, b };
};
const robustFit = (pts) => {
  let f = fit(pts);
  for (let it = 0; it < 2; it++) {
    const res = pts.map(([x, y]) => Math.abs(y - (f.a + f.b * x)));
    const lim = Math.max(2, median(res) * 2.5);
    const keep = pts.filter((p, i) => res[i] <= lim);
    if (keep.length >= 3) f = fit(keep);
  }
  return f;
};

function binarizeImage(rgba, w, h, letterGuess) {
  const gray = rgbaToGray(rgba, w, h);
  const norm = normalizeLight(gray, letterGuess);
  const t = otsu(norm, 3);
  const mask = binarize(norm, Math.min(t, 200));
  return { gray, norm, mask };
}

/** Typical letter body height/width from the components. */
function letterScale(comps) {
  const big = comps.filter((c) => c.h >= 6 && c.area >= 20);
  if (!big.length) return null;
  let H = median(big.map((c) => c.h));
  for (let i = 0; i < 3; i++) H = median(big.filter((c) => c.h > 0.6 * H && c.h < 1.6 * H).map((c) => c.h)) || H;
  const body = big.filter((c) => c.h > 0.75 * H && c.h < 1.3 * H);
  const W = median(body.map((c) => c.w)) || H;
  const A = median(body.map((c) => c.area)) || H * W * 0.3;
  return { H, W, A, body };
}

export function segment(rgbaIn, w, h, opts = {}) {
  let letterGuess = Math.max(12, Math.min(w, h) / 35);
  // pass 1: find skew
  let { mask } = binarizeImage(rgbaIn, w, h, letterGuess);
  let cc = components(mask);
  let sc = letterScale(cc.comps);
  if (sc) letterGuess = sc.H;
  // only use letter-sized blobs for the skew estimate (ignore klaf edges, table, shadows)
  if (sc) {
    const keep = new Uint8Array(cc.comps.length + 1);
    for (const c of cc.comps) keep[c.id] = c.h < 2.5 * sc.H && c.w < 4 * sc.W && c.area > 0.05 * sc.A ? 1 : 0;
    const m2 = new Uint8Array(w * h);
    for (let i = 0; i < m2.length; i++) m2[i] = keep[cc.labels[i]];
    mask = { w, h, d: m2 };
  }
  const angle = opts.noDeskew ? 0 : estimateSkew(mask);
  const rgba = Math.abs(angle) > 0.002 ? rotateRGBA(rgbaIn, w, h, angle) : rgbaIn;

  // pass 2: on the straightened image
  const bin = binarizeImage(rgba, w, h, letterGuess);
  cc = components(bin.mask);
  sc = letterScale(cc.comps);
  if (!sc || sc.body.length < 10) return { ok: false, reason: 'no-text', angle, rgba, w, h };
  const { H, W, A } = sc;

  // drop dust and very large blobs (klaf border, table, shadows)
  const minArea = Math.max(4, 0.012 * A);
  // when the klaf was cut out, nothing is written right at its edge: marks there are the edge itself, a fold or the sheet below
  const band = opts.edgeBand ? Math.max(0.6 * H, opts.edgeBand * Math.max(w, h)) : 0;
  const inBand = (c) => band && (c.x1 < band || c.x0 > w - 1 - band || c.y1 < band || c.y0 > h - 1 - band);
  const comps = cc.comps.filter((c) => c.area >= minArea && c.h < 3.5 * H && c.w < 8 * W && !inBand(c));

  // lines: cluster body-sized components by their vertical center
  const body = comps.filter((c) => c.h > 0.7 * H && c.h < 1.35 * H).sort((a, b) => a.cy - b.cy);
  const clusters = [];
  for (const c of body) {
    const last = clusters[clusters.length - 1];
    if (last && c.cy - last.lastCy < 0.45 * H) { last.items.push(c); last.lastCy = c.cy; }
    else clusters.push({ items: [c], lastCy: c.cy });
  }
  let lines = clusters.filter((cl) => cl.items.length >= 2).map((cl) => {
    const top = robustFit(cl.items.map((c) => [c.cx, c.y0]));
    const bot = robustFit(cl.items.map((c) => [c.cx, c.y1]));
    const cy = median(cl.items.map((c) => c.cy));
    return { top, bot, comps: [], n: cl.items.length, cy };
  });
  // drop small "lines" squeezed against a fuller line (rows of crowns, ascenders, specks)
  if (lines.length > 3) {
    const big = lines.filter((L) => L.n >= 6);
    const pitch = median(big.slice(1).map((L, i) => L.cy - big[i].cy)) || 2 * H;
    lines = lines.filter((L, i) => {
      if (L.n >= 6) return true;
      const near = [lines[i - 1], lines[i + 1]].filter(Boolean);
      return !near.some((N) => N.n > L.n && Math.abs(N.cy - L.cy) < 0.65 * pitch);
    });
  }
  const bandAt = (L, x) => [L.top.a + L.top.b * x, L.bot.a + L.bot.b * x];

  const smallA = 0.07 * A;
  const stray = [];
  for (const c of comps) {
    let best = -1, bestOv = -Infinity, second = -Infinity;
    lines.forEach((L, i) => {
      const [t, b] = bandAt(L, c.cx);
      const ov = Math.min(b, c.y1) - Math.max(t, c.y0);
      if (ov > bestOv) { second = bestOv; bestOv = ov; best = i; } else if (ov > second) second = ov;
    });
    if (best < 0) continue;
    if (bestOv <= 0) {
      // tag (crown) just above a line, or a stray mark
      const L = lines.findIndex((Ln) => { const [t] = bandAt(Ln, c.cx); return c.y1 <= t + 1 && t - c.y1 < 0.7 * H; });
      if (c.area < smallA && L >= 0) { lines[L].comps.push(c); continue; }
      if (bestOv > -0.5 * H) { lines[best].comps.push(c); continue; }
      stray.push(c); continue;
    }
    if (c.area >= smallA && c.h > 1.3 * H) {
      // A tall letter: ל rises from its line (bottom sits on the line), ך ן ף ץ ק hang from it (top on the line).
      // A long tail can reach the next line, so pick the line by these anchors, not by overlap.
      let topLine = -1, topD = Infinity, botLine = -1, botD = Infinity;
      lines.forEach((L, i) => {
        const [t, b] = bandAt(L, c.cx);
        if (Math.abs(c.y0 - t) < topD) { topD = Math.abs(c.y0 - t); topLine = i; }
        if (Math.abs(c.y1 - b) < botD) { botD = Math.abs(c.y1 - b); botLine = i; }
      });
      const tol = 0.3 * H;
      // one blob anchored to the top of one line and the bottom of the next = letters of two lines touching
      c.bridge = topD < tol && botD < tol && botLine !== topLine;
      if (c.bridge) {
        // cut the blob between the two lines so each letter stays in its own line
        const lo = Math.min(topLine, botLine), hi = Math.max(topLine, botLine);
        const parts = splitBlob(cc, w, c, bandAt(lines[lo], c.cx)[1], bandAt(lines[hi], c.cx)[0]);
        if (parts) {
          parts[0].bridge = true; parts[0].bridgeAt = parts.at;
          lines[lo].comps.push(parts[0]); lines[hi].comps.push(parts[1]);
          continue;
        }
        best = topLine;
      } else if (topD < tol && topD <= botD) best = topLine;
      else if (botD < tol) best = botLine;
    }
    lines[best].comps.push(c);
  }

  // letters inside each line (right to left)
  const letters = [];
  lines.forEach((L, li) => {
    const prim = L.comps.filter((c) => c.area >= smallA).sort((a, b) => b.area - a.area);
    const small = L.comps.filter((c) => c.area < smallA);
    const groups = [];
    for (const c of prim) {
      // a smaller piece lying under/over a bigger one (leg of ה / ק, a piece cut off by a crack)
      const host = groups.find((g) => {
        const ov = Math.min(g.x1, c.x1) - Math.max(g.x0, c.x0) + 1;
        const gh = g.y1 - g.y0 + 1;
        // the piece must sit mostly inside the bigger letter AND start lower than its top
        // (a leg hangs under a roof); a neighbour letter standing next to it starts at the same height
        const startsLow = c.y0 > g.y0 + 0.2 * gh;
        const endsHigh = c.y1 < g.y1 - 0.2 * gh; // or a piece over a base, cut off by a crack
        return ov >= 0.75 * c.w && c.area < 0.6 * g.mainArea && (startsLow || endsHigh);
      });
      if (host) { host.ids.push(c.id); host.parts++; grow(host, c); }
      else groups.push({ ids: [c.id], x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, mainArea: c.area, parts: 1, tags: 0, bridge: !!c.bridge, bridgeAt: c.bridgeAt, line: li });
      if (c.bridge && host) { host.bridge = true; host.bridgeAt = host.bridgeAt || c.bridgeAt; }
    }
    for (const c of small) {
      let best = null, bd = Infinity;
      for (const g of groups) {
        const ov = Math.min(g.x1, c.x1) - Math.max(g.x0, c.x0);
        const dist = ov > 0 ? 0 : -ov;
        if (dist < bd) { bd = dist; best = g; }
      }
      if (best && bd < 0.4 * W) {
        best.ids.push(c.id); grow(best, c);
        // above the line = a crown (tag); inside the line = a small piece cut off the letter
        const [top] = bandAt(L, c.cx);
        if (c.cy > top + 0.15 * H && c.area > 0.02 * A) best.parts++; else best.tags++;
      }
    }
    // how wide is each letter inside the writing line itself (ignoring ל's raised head, tails and crowns)?
    for (const g of groups) {
      const cx = (g.x0 + g.x1) / 2;
      const [t, b] = bandAt(L, cx);
      const y0 = Math.max(g.y0, Math.round(t + 0.15 * (b - t))), y1 = Math.min(g.y1, Math.round(b - 0.1 * (b - t)));
      const ids = new Set(g.ids);
      let bx0 = Infinity, bx1 = -1;
      for (let y = y0; y <= y1; y++) for (let x = g.x0; x <= g.x1; x++) {
        if (ids.has(cc.labels[y * w + x])) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
      }
      g.bx0 = bx1 >= 0 ? bx0 : g.x0; g.bx1 = bx1 >= 0 ? bx1 : g.x1;
    }
    groups.sort((a, b) => (b.bx0 + b.bx1) - (a.bx0 + a.bx1)); // right to left, by the letter body
    L.letters = groups;
  });
  lines = lines.filter((L) => L.letters.length >= 2);

  // word gaps: split the gaps between letters into "inside word" and "between words"
  const gaps = [];
  for (const L of lines) for (let i = 1; i < L.letters.length; i++) {
    L.letters[i].gapBefore = L.letters[i - 1].bx0 - L.letters[i].bx1;
    gaps.push(L.letters[i].gapBefore);
  }
  // best split of all gaps into two groups (Otsu on the sorted gap sizes)
  const sg = Float64Array.from(gaps).sort();
  let t = 0.35 * W, bestV = -1;
  const tot = sg.reduce((a, b) => a + b, 0);
  let sumLo = 0;
  for (let i = 0; i < sg.length - 1; i++) {
    sumLo += sg[i];
    const nLo = i + 1, nHi = sg.length - nLo;
    if (sg[i + 1] - sg[i] < 1e-9) continue;
    const v = nLo * nHi * (sumLo / nLo - (tot - sumLo) / nHi) ** 2;
    if (v > bestV) { bestV = v; t = (sg[i] + sg[i + 1]) / 2; }
  }
  const wordGap = Math.max(t, 0.12 * W);

  lines.forEach((L, li) => {
    L.index = li;
    L.letters.forEach((g, i) => {
      g.line = li;
      g.wordStart = i === 0 || g.gapBefore >= wordGap;
      const cx = (g.x0 + g.x1) / 2;
      const [top, bot] = bandAt(L, cx);
      const bh = Math.max(1, bot - top);
      g.relW = (g.x1 - g.x0 + 1) / W;
      g.up = top - g.y0 > 0.35 * bh;
      g.down = g.y1 - bot > 0.35 * bh;
      g.small = g.y1 - g.y0 + 1 < 0.6 * bh && !g.up && !g.down;
      g.lineTop = top; g.lineBot = bot;
      g.index = letters.length;
      letters.push(g);
    });
  });

  return {
    ok: true, angle, rgba, w, h, gray: bin.gray, norm: bin.norm, mask: bin.mask, labels: cc.labels,
    comps: cc.comps, lines, letters, stray, H, W, A, wordGap,
  };
}

function grow(g, c) {
  g.x0 = Math.min(g.x0, c.x0); g.y0 = Math.min(g.y0, c.y0);
  g.x1 = Math.max(g.x1, c.x1); g.y1 = Math.max(g.y1, c.y1);
}

/**
 * Cut one blob in two at the row (between yA and yB) where it has the least ink.
 * Used when a letter touches a letter of the next line. Returns [upper, lower] or null.
 */
function splitBlob(cc, w, c, yA, yB) {
  const lo = Math.max(c.y0 + 1, Math.floor(Math.min(yA, yB)) - 2);
  const hi = Math.min(c.y1 - 1, Math.ceil(Math.max(yA, yB)) + 2);
  if (hi < lo) return null;
  let cut = -1, bestN = Infinity;
  const mid = (lo + hi) / 2;
  for (let y = lo; y <= hi; y++) {
    let n = 0;
    for (let x = c.x0; x <= c.x1; x++) if (cc.labels[y * w + x] === c.id) n++;
    if (n < bestN || (n === bestN && Math.abs(y - mid) < Math.abs(cut - mid))) { bestN = n; cut = y; }
  }
  const newId = cc.comps.length + 1;
  const lower = { id: newId };
  cc.comps.push(lower);
  for (let y = cut + 1; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    if (cc.labels[y * w + x] === c.id) cc.labels[y * w + x] = newId;
  }
  const restat = (o, x0, y0, x1, y1) => {
    Object.assign(o, { x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0, sx: 0, sy: 0 });
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (cc.labels[y * w + x] !== o.id) continue;
      o.x0 = Math.min(o.x0, x); o.x1 = Math.max(o.x1, x); o.y0 = Math.min(o.y0, y); o.y1 = Math.max(o.y1, y);
      o.area++; o.sx += x; o.sy += y;
    }
    if (o.area) { o.cx = o.sx / o.area; o.cy = o.sy / o.area; o.w = o.x1 - o.x0 + 1; o.h = o.y1 - o.y0 + 1; }
  };
  const box = [c.x0, c.y0, c.x1, c.y1];
  restat(c, ...box); restat(lower, ...box);
  if (!c.area || !lower.area) return null;
  // where the two letters meet (for the red circle)
  let sx = 0, n = 0;
  for (let x = c.x0; x <= c.x1; x++) if (cc.labels[cut * w + x] === c.id) { sx += x; n++; }
  const parts = [c, lower];
  parts.at = { x: n ? sx / n : c.cx, y: cut };
  return parts;
}
