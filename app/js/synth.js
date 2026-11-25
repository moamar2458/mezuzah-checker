// Synthetic letters and test pages drawn with free STaM fonts (Culmus project, GPL-2).
// Used (1) to give the AI a first start before real mezuzot are in the library,
// and (2) to test the app with a fake mezuzah that has known mistakes in it.
import { normalizeMask } from './crop.js';
import { components, otsu } from './imageproc.js';

export const FONTS = [
  { family: 'StamAshkenaz', url: 'fonts/StamAshkenazCLM.ttf' },
  { family: 'StamSefarad', url: 'fonts/StamSefaradCLM.ttf' },
];

export async function loadFonts(base = '') {
  for (const f of FONTS) {
    const ff = new FontFace(f.family, `url(${base}${f.url})`);
    await ff.load();
    document.fonts.add(ff);
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);

/** One synthetic training letter, normalized like a real one. */
export function synthLetter(ch, canvas) {
  const S = 96;
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S);
  const font = FONTS[Math.floor(Math.random() * FONTS.length)].family;
  const size = rnd(44, 60);
  ctx.translate(S / 2, S / 2);
  ctx.rotate(rnd(-0.06, 0.06));
  ctx.transform(1, 0, rnd(-0.12, 0.12), 1, 0, 0);
  ctx.scale(rnd(0.85, 1.2), rnd(0.9, 1.1));
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(ch, 0, 0);
  const stroke = rnd(-1, 2.5);
  if (stroke > 0) { ctx.strokeStyle = '#000'; ctx.lineWidth = stroke; ctx.strokeText(ch, 0, 0); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // ink texture and small specks
  for (let k = 0; k < 6; k++) {
    ctx.fillStyle = Math.random() < 0.6 ? '#fff' : '#000';
    ctx.beginPath(); ctx.arc(rnd(20, 76), rnd(20, 76), rnd(0.3, 1.2), 0, 7); ctx.fill();
  }
  const img = ctx.getImageData(0, 0, S, S).data;
  const gray = { w: S, h: S, d: new Float32Array(S * S) };
  const blur = Math.random() < 0.5;
  for (let i = 0; i < S * S; i++) gray.d[i] = img[i * 4] + rnd(-30, 30);
  if (blur) for (let i = S + 1; i < S * S - S - 1; i++) gray.d[i] = (gray.d[i] * 2 + gray.d[i - 1] + gray.d[i + 1] + gray.d[i - S] + gray.d[i + S]) / 6;
  const t = otsu(gray) + rnd(-25, 25);
  const mask = { w: S, h: S, d: new Uint8Array(S * S) };
  for (let i = 0; i < S * S; i++) mask.d[i] = gray.d[i] < t ? 1 : 0;
  // keep only real parts of the letter (drop single specks) and crop to them
  const { labels, comps } = components(mask);
  const big = comps.filter((c) => c.area >= 12);
  if (!big.length) return null;
  const keep = new Set(big.map((c) => c.id));
  const x0 = Math.min(...big.map((c) => c.x0)), y0 = Math.min(...big.map((c) => c.y0));
  const x1 = Math.max(...big.map((c) => c.x1)), y1 = Math.max(...big.map((c) => c.y1));
  const w = x1 - x0 + 1, h = y1 - y0 + 1, m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = keep.has(labels[(y0 + y) * S + x0 + x]) ? 1 : 0;
  return normalizeMask(m, w, h);
}

/**
 * A fake mezuzah page with known mistakes, for testing.
 * defects: { missing: [refIndex], touch: [refIndex], crack: [refIndex], legTouch: [refIndex] }
 */
export function synthPage(refLetters, opts = {}) {
  const { font = 'StamAshkenaz', size = 40, lines = 22, defects = {}, angle = 0 } = opts;
  const width = opts.width || Math.round(size * 28);
  const pitch = size * 1.7, margin = size * 1.5, W = width;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = 10;
  let ctx = cv.getContext('2d');
  ctx.font = `${size}px ${font}`;
  // group letters into words
  const words = [];
  for (const r of refLetters) { if (r.wordStart) words.push([]); words[words.length - 1].push(r); }
  const space = size * 0.45, gap = size * 0.06;
  const wordW = (wd) => wd.reduce((s, r) => s + ctx.measureText(r.ch).width + gap, -gap);
  const lineW = W - 2 * margin;
  // greedy layout into about the requested number of lines
  const total = words.reduce((s, wd) => s + wordW(wd) + space, 0);
  const target = Math.min(lineW, total / lines * 1.04);
  const rows = [[]]; let cur = 0;
  for (const wd of words) {
    const ww = wordW(wd);
    if (cur + ww > target && rows[rows.length - 1].length) { rows.push([]); cur = 0; }
    rows[rows.length - 1].push(wd); cur += ww + space;
  }
  const H = Math.ceil(rows.length * pitch + 2 * margin);
  cv.height = H; ctx = cv.getContext('2d');
  // parchment with uneven light
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#e9dcc0'); grad.addColorStop(1, '#cdbb94');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2); ctx.rotate(angle); ctx.translate(-W / 2, -H / 2);
  ctx.font = `${size}px ${font}`; ctx.textBaseline = 'alphabetic';
  const truth = [];
  ctx.fillStyle = '#16120e';
  rows.forEach((row, li) => {
    let x = W - margin; const y = margin + (li + 0.75) * pitch;
    for (const wd of row) {
      for (const r of wd) {
        const ch = (defects.swap && defects.swap[r.index]) || r.ch;
        const cw = ctx.measureText(ch).width;
        if (!(defects.missing || []).includes(r.index)) {
          ctx.fillText(ch, x - cw, y);
          truth.push({ index: r.index, x0: x - cw, x1: x, y });
        }
        if ((defects.touch || []).includes(r.index)) {
          // a blob of ink joining this letter to the next one (to its left)
          ctx.fillRect(x - cw - size * 0.2, y - size * 0.3, size * 0.35, size * 0.06);
        }
        if ((defects.crack || []).includes(r.index)) {
          // a thin line of "parchment" cutting through the ink
          ctx.save(); ctx.strokeStyle = '#dccfae'; ctx.lineWidth = Math.max(1.5, size * 0.03);
          ctx.beginPath(); ctx.moveTo(x - cw * 0.3, y - size * 0.66); ctx.lineTo(x - cw * 0.25, y - size * 0.3); ctx.stroke(); ctx.restore();
        }
        if ((defects.spot || []).includes(r.index)) {
          // a small white spot inside the bottom stroke
          ctx.save(); ctx.fillStyle = '#dccfae';
          ctx.beginPath(); ctx.arc(x - cw * 0.5, y - size * 0.05, size * 0.025, 0, 7); ctx.fill(); ctx.restore();
        }
        x -= cw + gap;
      }
      x -= space - gap;
    }
  });
  // sensor noise
  const id = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < id.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
  }
  ctx.putImageData(id, 0, 0);
  return { canvas: cv, truth, rows: rows.length };
}
