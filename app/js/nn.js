// Our own small AI: a tiny convolutional network that knows the 27 letter shapes.
// Pure JavaScript (no libraries), so it runs offline on the phone and trains in a browser on the PC.
//
// input 1x32x32 -> conv3x3(8) relu pool -> conv3x3(16) relu pool -> conv3x3(32) relu pool
//              -> dense 512->64 relu -> dense 64->27 -> softmax

export const ARCH = [
  { type: 'conv', in: 1, out: 8, size: 32 },
  { type: 'conv', in: 8, out: 16, size: 16 },
  { type: 'conv', in: 16, out: 32, size: 8 },
  { type: 'dense', in: 512, out: 64, relu: true },
  { type: 'dense', in: 64, out: 27, relu: false },
];

function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export function createModel() {
  const layers = ARCH.map((a) => {
    const fanIn = a.type === 'conv' ? a.in * 9 : a.in;
    const nW = a.type === 'conv' ? a.out * a.in * 9 : a.out * a.in;
    const W = new Float32Array(nW).map(() => randn() * Math.sqrt(2 / fanIn));
    return { ...a, W, b: new Float32Array(a.out) };
  });
  return { layers, meta: { created: new Date().toISOString() } };
}

function convFwd(L, x, S) {
  const { in: C, out: O, W, b } = L;
  const y = new Float32Array(O * S * S);
  for (let o = 0; o < O; o++) {
    const yo = o * S * S;
    for (let i = 0; i < S * S; i++) y[yo + i] = b[o];
    for (let c = 0; c < C; c++) {
      const xc = c * S * S, wb = (o * C + c) * 9;
      for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) {
        const wv = W[wb + ky * 3 + kx]; if (!wv) continue;
        const dy = ky - 1, dx = kx - 1;
        const ys = Math.max(0, -dy), ye = Math.min(S, S - dy), xs = Math.max(0, -dx), xe = Math.min(S, S - dx);
        for (let yy = ys; yy < ye; yy++) {
          const yr = yo + yy * S, xr = xc + (yy + dy) * S + dx;
          for (let xx = xs; xx < xe; xx++) y[yr + xx] += wv * x[xr + xx];
        }
      }
    }
  }
  for (let i = 0; i < y.length; i++) if (y[i] < 0) y[i] = 0;
  return y;
}

function convBwd(L, x, y, dy, S, g, needDx) {
  // dy is gradient wrt relu output; mask by relu
  const { in: C, out: O, W } = L;
  const dx = needDx ? new Float32Array(C * S * S) : null;
  for (let i = 0; i < dy.length; i++) if (y[i] <= 0) dy[i] = 0;
  for (let o = 0; o < O; o++) {
    const yo = o * S * S;
    let sb = 0; for (let i = 0; i < S * S; i++) sb += dy[yo + i];
    g.b[o] += sb;
    for (let c = 0; c < C; c++) {
      const xc = c * S * S, wb = (o * C + c) * 9;
      for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) {
        const dy_ = ky - 1, dx_ = kx - 1, wi = wb + ky * 3 + kx, wv = W[wi];
        const ys = Math.max(0, -dy_), ye = Math.min(S, S - dy_), xs = Math.max(0, -dx_), xe = Math.min(S, S - dx_);
        let sw = 0;
        for (let yy = ys; yy < ye; yy++) {
          const yr = yo + yy * S, xr = xc + (yy + dy_) * S + dx_;
          for (let xx = xs; xx < xe; xx++) {
            const d = dy[yr + xx];
            sw += d * x[xr + xx];
            if (dx) dx[xr + xx] += d * wv;
          }
        }
        g.W[wi] += sw;
      }
    }
  }
  return dx;
}

function poolFwd(x, C, S) {
  const H = S >> 1, y = new Float32Array(C * H * H), arg = new Int32Array(C * H * H);
  for (let c = 0; c < C; c++) for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < H; xx++) {
    const o = c * H * H + yy * H + xx;
    let best = -Infinity, bi = 0;
    for (let k = 0; k < 4; k++) {
      const i = c * S * S + (2 * yy + (k >> 1)) * S + 2 * xx + (k & 1);
      if (x[i] > best) { best = x[i]; bi = i; }
    }
    y[o] = best; arg[o] = bi;
  }
  return { y, arg };
}

function denseFwd(L, x) {
  const { in: I, out: O, W, b } = L;
  const y = new Float32Array(O);
  for (let o = 0; o < O; o++) { let s = b[o]; const r = o * I; for (let i = 0; i < I; i++) s += W[r + i] * x[i]; y[o] = L.relu && s < 0 ? 0 : s; }
  return y;
}

function softmax(z) {
  let m = -Infinity; for (const v of z) if (v > m) m = v;
  const e = z.map((v) => Math.exp(v - m)); let s = 0; for (const v of e) s += v;
  return e.map((v) => v / s);
}

function forward(model, x, keep) {
  const [c1, c2, c3, d1, d2] = model.layers;
  const a1 = convFwd(c1, x, 32), p1 = poolFwd(a1, 8, 32);
  const a2 = convFwd(c2, p1.y, 16), p2 = poolFwd(a2, 16, 16);
  const a3 = convFwd(c3, p2.y, 8), p3 = poolFwd(a3, 32, 8);
  const h = denseFwd(d1, p3.y), z = denseFwd(d2, h);
  const p = softmax(z);
  return keep ? { x, a1, p1, a2, p2, a3, p3, h, p } : p;
}

/** Probabilities for one 32x32 letter (Float32Array 1024, 1 = ink). */
export const predict = (model, x) => forward(model, x, false);

function zeroGrads(model) { return model.layers.map((L) => ({ W: new Float32Array(L.W.length), b: new Float32Array(L.b.length) })); }

function backward(model, f, label, grads) {
  const [c1, c2, c3, d1, d2] = model.layers;
  const dz = Float32Array.from(f.p); dz[label] -= 1;
  // dense 2
  const dh = new Float32Array(64);
  for (let o = 0; o < 27; o++) { grads[4].b[o] += dz[o]; for (let i = 0; i < 64; i++) { grads[4].W[o * 64 + i] += dz[o] * f.h[i]; dh[i] += dz[o] * d2.W[o * 64 + i]; } }
  for (let i = 0; i < 64; i++) if (f.h[i] <= 0) dh[i] = 0;
  // dense 1
  const dp3 = new Float32Array(512);
  for (let o = 0; o < 64; o++) { const d = dh[o]; if (!d) continue; grads[3].b[o] += d; const r = o * 512; for (let i = 0; i < 512; i++) { grads[3].W[r + i] += d * f.p3.y[i]; dp3[i] += d * d1.W[r + i]; } }
  const unpool = (dp, arg, n) => { const d = new Float32Array(n); for (let i = 0; i < dp.length; i++) d[arg[i]] += dp[i]; return d; };
  const da3 = unpool(dp3, f.p3.arg, f.a3.length);
  const dp2 = convBwd(c3, f.p2.y, f.a3, da3, 8, grads[2], true);
  const da2 = unpool(dp2, f.p2.arg, f.a2.length);
  const dp1 = convBwd(c2, f.p1.y, f.a2, da2, 16, grads[1], true);
  const da1 = unpool(dp1, f.p1.arg, f.a1.length);
  convBwd(c1, f.x, f.a1, da1, 32, grads[0], false);
}

/** For testing: loss and gradients for one letter. */
export function gradients(model, x, label) {
  const g = zeroGrads(model);
  const f = forward(model, x, true);
  backward(model, f, label, g);
  return { loss: -Math.log(f.p[label] + 1e-9), grads: g };
}

/** Adam optimizer state. */
export function createTrainer(model, lr = 0.002) {
  const m = zeroGrads(model), v = zeroGrads(model);
  return { model, m, v, t: 0, lr };
}

/** One minibatch step. xs: array of Float32Array(1024), ys: array of class indices. Returns mean loss. */
export function trainBatch(tr, xs, ys) {
  const grads = zeroGrads(tr.model);
  let loss = 0;
  for (let k = 0; k < xs.length; k++) {
    const f = forward(tr.model, xs[k], true);
    loss -= Math.log(f.p[ys[k]] + 1e-9);
    backward(tr.model, f, ys[k], grads);
  }
  tr.t++;
  const b1 = 0.9, b2 = 0.999, eps = 1e-8, n = xs.length;
  const c1 = 1 - b1 ** tr.t, c2 = 1 - b2 ** tr.t;
  tr.model.layers.forEach((L, li) => {
    for (const key of ['W', 'b']) {
      const P = L[key], G = grads[li][key], M = tr.m[li][key], V = tr.v[li][key];
      for (let i = 0; i < P.length; i++) {
        const gr = G[i] / n + (key === 'W' ? 1e-4 * P[i] : 0);
        M[i] = b1 * M[i] + (1 - b1) * gr;
        V[i] = b2 * V[i] + (1 - b2) * gr * gr;
        P[i] -= (tr.lr * (M[i] / c1)) / (Math.sqrt(V[i] / c2) + eps);
      }
    }
  });
  return loss / n;
}

// ---- saving / loading the model as a small JSON file ----
const b64 = (f32) => { const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Float32Array(u8.buffer); };

export function serializeModel(model) {
  return JSON.stringify({
    format: 'ktav-ashuri-cnn', version: 1, letters: 'אבגדהוזחטיכךלמםנןסעפףצץקרשת', meta: model.meta,
    layers: model.layers.map((L) => ({ type: L.type, in: L.in, out: L.out, size: L.size, relu: L.relu, W: b64(L.W), b: b64(L.b) })),
  });
}

export function deserializeModel(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (o.format !== 'ktav-ashuri-cnn') throw new Error('This is not a letter model file');
  return { meta: o.meta || {}, layers: o.layers.map((L) => ({ ...L, W: unb64(L.W), b: unb64(L.b) })) };
}
