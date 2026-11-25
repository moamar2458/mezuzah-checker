// Trainer page: collects letters (library files + font letters) and trains the AI in a worker.
import { LETTERS, LETTER_INDEX } from './reference.js';
import { parseLibrary } from './library.js';
import { loadFonts, synthLetter } from './synth.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
let real = []; // [{label, x: Uint8Array}]
let startModel = null, resultModel = null;
const log = (s) => { $('log').textContent += s + '\n'; };

function showCounts() {
  const c = {}; for (const s of real) c[s.label] = (c[s.label] || 0) + 1;
  $('libInfo').textContent = `${real.length} real letters from mezuzot.`;
  $('libCounts').innerHTML = LETTERS.map((L) => `<div class="${(c[L] || 0) < 20 ? 'low' : ''}"><b>${L}</b>${c[L] || 0}</div>`).join('');
}

$('libFiles').onchange = async (e) => {
  for (const f of e.target.files) {
    try { real.push(...parseLibrary(await f.text()).filter((s) => s.label in LETTER_INDEX)); }
    catch (err) { alert(`${f.name}: ${err.message}`); }
  }
  e.target.value = ''; showCounts();
};
$('useLocal').onclick = async () => {
  const s = await db.all('samples');
  real.push(...s.filter((x) => x.label in LETTER_INDEX).map((x) => ({ label: x.label, x: x.x })));
  showCounts();
};
$('startModel').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  startModel = await f.text(); $('startInfo').textContent = `starting from ${f.name}`;
};

$('trainBtn').onclick = async () => {
  $('trainBtn').disabled = true; $('doneBox').hidden = true; $('log').textContent = '';
  const nSynth = Number($('synthN').value) || 0;
  const epochs = Number($('epochs').value) || 8;
  const total = real.length + nSynth * LETTERS.length;
  if (total < 100) { alert('Add a library file or some font letters first.'); $('trainBtn').disabled = false; return; }
  const data = new Uint8Array(total * 1024), labels = new Int32Array(total), isReal = new Uint8Array(total);
  let k = 0;
  for (const s of real) { data.set(s.x, k * 1024); labels[k] = LETTER_INDEX[s.label]; isReal[k] = 1; k++; }
  if (nSynth) {
    log('Drawing font letters…');
    await loadFonts('');
    const cv = document.createElement('canvas');
    for (let li = 0; li < LETTERS.length; li++) {
      for (let n = 0; n < nSynth; n++) {
        const x = synthLetter(LETTERS[li], cv);
        if (!x) continue;
        for (let p = 0; p < 1024; p++) data[k * 1024 + p] = Math.round(x[p] * 255);
        labels[k] = li; k++;
      }
      $('prog').value = (li + 1) / LETTERS.length;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  log(`Training on ${k} letters (${real.length} real, ${k - real.length} font) for ${epochs} rounds…`);
  const worker = new Worker(new URL('./train-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { $('prog').value = (m.epoch - 1 + m.done) / m.epochs; }
    if (m.type === 'epoch') log(`round ${m.epoch}/${m.epochs}: loss ${m.loss.toFixed(3)}, correct on test letters ${(m.valAcc * 100).toFixed(1)}%${m.valFromReal ? ' (real)' : ' (mixed)'} — ${Math.round(m.secs)}s`);
    if (m.type === 'done') {
      resultModel = m.model; $('prog').value = 1;
      const conf = Object.entries(m.confusion).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([key, n]) => { const [a, b] = key.split('>').map(Number); return `${LETTERS[a]}→${LETTERS[b]} ×${n}`; });
      log(`Done. ${(m.valAcc * 100).toFixed(1)}% correct.${conf.length ? ' Most common mix-ups: ' + conf.join(', ') : ''}`);
      $('doneBox').hidden = false; $('trainBtn').disabled = false; worker.terminate();
    }
  };
  worker.onerror = (err) => { log('Error: ' + err.message); $('trainBtn').disabled = false; };
  worker.postMessage({ data: data.subarray(0, k * 1024), labels: labels.subarray(0, k), real: isReal.subarray(0, k), epochs, startModel });
};

$('saveModel').onclick = () => {
  const name = `letter-model-${new Date().toISOString().slice(0, 10)}.json`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([resultModel], { type: 'application/json' })); a.download = name; a.click();
};
$('installModel').onclick = async () => { await db.set('model', resultModel); alert('The model is now used by the checker on this device.'); };
showCounts();
