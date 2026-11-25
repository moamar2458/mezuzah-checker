// The training loop, shared by the browser trainer (train-worker.js) and the PC program (pc/trainer.js).
import { createModel, createTrainer, trainBatch, predict, serializeModel, deserializeModel } from './nn.js';

const N = 1024;

function augment(src) {
  // random shift by up to 2 pixels + a little noise
  const dx = Math.round(Math.random() * 4 - 2), dy = Math.round(Math.random() * 4 - 2);
  const out = new Float32Array(N);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const sx = x - dx, sy = y - dy;
    let v = sx >= 0 && sy >= 0 && sx < 32 && sy < 32 ? src[sy * 32 + sx] : 0;
    if (Math.random() < 0.02) v = 1 - v;
    out[y * 32 + x] = v;
  }
  return out;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/**
 * data: Uint8Array(count*1024), labels: Int32Array(count) class indices, real: Uint8Array(count) 1 = from a real mezuzah.
 * onMessage receives {type:'progress'|'epoch', ...}. Returns { model (JSON text), valAcc, confusion, meta }.
 */
export function trainModel({ data, labels, real, epochs = 8, startModel = null, batch = 32, lr = 0.002 }, onMessage = () => {}) {
  const count = labels.length;
  const get = (i) => { const f = new Float32Array(N); for (let k = 0; k < N; k++) f[k] = data[i * N + k] / 255; return f; };

  // hold out some letters to test how good the model is (real letters when there are enough)
  const idx = shuffle([...Array(count).keys()]);
  const realIdx = idx.filter((i) => real[i]);
  const valFromReal = realIdx.length >= 200;
  const pool = valFromReal ? realIdx : idx;
  const nVal = Math.min(2000, Math.max(50, Math.round(pool.length * 0.1)));
  const valSet = new Set(pool.slice(0, nVal));
  const train = idx.filter((i) => !valSet.has(i));
  const val = [...valSet];

  // how many real training letters each shape has (the checker ignores the AI for shapes it barely knows)
  const classCounts = new Array(27).fill(0);
  for (const i of train) if (real[i]) classCounts[labels[i]]++;

  const model = startModel ? deserializeModel(startModel) : createModel();
  const tr = createTrainer(model, lr);
  const evaluate = () => {
    let ok = 0; const conf = {};
    for (const i of val) {
      const p = predict(model, get(i));
      let top = 0; for (let c = 1; c < 27; c++) if (p[c] > p[top]) top = c;
      if (top === labels[i]) ok++; else { const k = `${labels[i]}>${top}`; conf[k] = (conf[k] || 0) + 1; }
    }
    return { acc: ok / Math.max(1, val.length), conf };
  };

  const t0 = Date.now();
  let lastAcc = 0, lastConf = {};
  for (let ep = 0; ep < epochs; ep++) {
    // real letters count three times as much as font letters
    const order = [];
    for (const i of train) { order.push(i); if (real[i]) order.push(i, i); }
    shuffle(order);
    if (ep === Math.floor(epochs * 0.7)) tr.lr = lr * 0.3;
    let lossSum = 0, nb = 0;
    for (let b = 0; b < order.length; b += batch) {
      const ids = order.slice(b, b + batch);
      lossSum += trainBatch(tr, ids.map((i) => augment(get(i))), ids.map((i) => labels[i])); nb++;
      if (nb % 20 === 0) onMessage({ type: 'progress', epoch: ep + 1, epochs, done: b / order.length, loss: lossSum / nb, secs: (Date.now() - t0) / 1000 });
    }
    const { acc, conf } = evaluate();
    lastAcc = acc; lastConf = conf;
    onMessage({ type: 'epoch', epoch: ep + 1, epochs, loss: lossSum / nb, valAcc: acc, valFromReal, secs: (Date.now() - t0) / 1000 });
  }
  model.meta = {
    ...(model.meta || {}), trained: new Date().toISOString(), valAcc: lastAcc, valFromReal,
    realSamples: realIdx.length, synthSamples: count - realIdx.length, epochs, classCounts,
  };
  return { model: serializeModel(model), valAcc: lastAcc, confusion: lastConf, meta: model.meta };
}
