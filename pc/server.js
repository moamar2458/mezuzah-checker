// Mezuzah Checker – PC program.
//  * serves the app to the phone (through Tailscale it gets a secure https address)
//  * receives every check and its letters from the phone and keeps them in the data folder
//  * trains the letter AI by itself when enough new letters arrived, and hands the new AI to the phone
//  * shows all checks on the PC screen: http://localhost:8080/pc.html
//
//   node pc/server.js [--port 8080] [--data <folder>] [--lan]
//
// No installs besides Node.js. All data stays on this PC.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { LETTERS, LETTER_INDEX } from '../app/js/reference.js';
import { modelTrusted, MIN_REAL } from '../app/js/pipeline.js';
import { printedCheck } from '../app/js/fraud.js';
import { parseReference } from '../app/js/reference.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const PORT = Number(arg('--port', process.env.PORT || 8080));
const DATA = path.resolve(arg('--data', process.env.MZ_DATA || path.join(here, '..', 'data')));
const APP = path.join(here, '..', 'app');
const LAN = process.argv.includes('--lan');
const AUTO_MIN = Number(process.env.MZ_MIN_REAL || MIN_REAL); // real letters needed before training starts by itself
const AUTO_EVERY = Number(process.env.MZ_TRAIN_EVERY || 300); // retrain after this many new letters
const EPOCHS = Number(arg('--epochs', process.env.MZ_EPOCHS || 10));

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

// ---------- data folder ----------
fs.mkdirSync(path.join(DATA, 'scans'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'models'), { recursive: true });
const configFile = path.join(DATA, 'config.json');
if (!fs.existsSync(configFile)) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.randomBytes(8), (b) => abc[b % abc.length]).join('');
  fs.writeFileSync(configFile, JSON.stringify({ pairCode: `${code.slice(0, 4)}-${code.slice(4)}`, created: new Date().toISOString() }, null, 2));
}
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const newCode = () => { const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const c = Array.from(crypto.randomBytes(8), (b) => abc[b % abc.length]).join(''); return `${c.slice(0, 4)}-${c.slice(4)}`; };
// users: the owner (you) and helpers who only share letters
if (!config.users) config.users = [{ id: 'owner', name: 'Me (owner)', code: config.pairCode, role: 'owner', trusted: true, created: Date.now() }];
const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
saveConfig();
const libFile = path.join(DATA, 'library.jsonl');
const recordsFile = path.join(DATA, 'customers.json');
const records = fs.existsSync(recordsFile) ? JSON.parse(fs.readFileSync(recordsFile, 'utf8')) : { customers: {}, items: {} };
function mergeRecords(b) {
  let n = 0;
  for (const kind of ['customers', 'items']) {
    for (const r of b[kind] || []) {
      if (!r || !r.uid) continue;
      const mine = records[kind][r.uid];
      if (!mine || (r.updated || 0) > (mine.updated || 0)) { records[kind][r.uid] = r; n++; }
    }
  }
  if (n) fs.writeFileSync(recordsFile, JSON.stringify(records, null, 1));
  return n;
}
const stateFile = path.join(DATA, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { currentModel: null, lettersAtLastTrain: 0 };
const saveState = () => fsp.writeFile(stateFile, JSON.stringify(state, null, 2));

// library in memory: only what training needs (label + 32x32 letter)
const library = []; // { uid, label, x: Buffer(1024), src, scan, device }
const libUids = new Set();
if (fs.existsSync(libFile)) {
  for (const line of fs.readFileSync(libFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line); libUids.add(s.uid); library.push({ ...s, x: Buffer.from(s.x, 'base64'), view: undefined }); } catch { /* skip bad line */ }
  }
}

// letters from helpers who need the owner's approval wait here
const pendingFile = path.join(DATA, 'pending.jsonl');
let pending = fs.existsSync(pendingFile) ? fs.readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
for (const p of pending) libUids.add(p.uid);
const savePending = () => fsp.writeFile(pendingFile, pending.map((p) => JSON.stringify(p)).join('\n') + (pending.length ? '\n' : ''));

async function addSamples(items, device, scan, user = config.users[0]) {
  const lines = [];
  const hold = user.role === 'helper' && !user.trusted;
  let added = 0;
  for (const it of items || []) {
    if (!it || !it.uid || libUids.has(it.uid) || !(it.label in LETTER_INDEX) || !it.x) continue;
    const x = Buffer.from(it.x, 'base64');
    if (x.length !== 1024) continue;
    if (it.src !== 'auto' && it.src !== 'confirmed') continue; // only sure or sofer-approved letters
    const rec = { uid: it.uid, label: it.label, x: it.x, view: it.view || null, src: it.src, scan: user.role === 'owner' ? (it.scan || scan || null) : null, device, user: user.id, date: it.date || Date.now() };
    libUids.add(it.uid);
    if (hold) { pending.push(rec); added++; continue; }
    lines.push(JSON.stringify(rec));
    library.push({ ...rec, x, view: undefined });
    added++;
  }
  if (hold && added) { await savePending(); return added; }
  if (lines.length) await fsp.appendFile(libFile, lines.join('\n') + '\n');
  if (added) maybeAutoTrain();
  return added;
}

// ---------- spot memory: places marked on letters as good / problem (shared with every phone and helper) ----------
const marksFile = path.join(DATA, 'marks.json');
const marks = fs.existsSync(marksFile) ? JSON.parse(fs.readFileSync(marksFile, 'utf8')) : {};
let spotsVer = Object.keys(marks).length ? Math.max(...Object.values(marks).map((r) => r.date || 0)) : 0;
function setMarks(b, user, device) {
  const uid = String(b.uid || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (!uid || !(b.label in LETTER_INDEX)) return { error: 'bad letter' };
  const mine = marks[uid];
  if (mine && mine.user !== user.id && user.role !== 'owner') return { error: 'not yours' };
  const list = (Array.isArray(b.marks) ? b.marks : []).slice(0, 30).map((m) => ({
    u: Math.min(1, Math.max(0, Number(m.u) || 0)), v: Math.min(1, Math.max(0, Number(m.v) || 0)), r: Math.min(0.4, Math.max(0.02, Number(m.r) || 0.08)),
    kind: m.kind === 'good' ? 'good' : 'problem', note: String(m.note || '').slice(0, 200),
  }));
  if (!list.length) { if (!mine) return { ok: true }; delete marks[uid]; }
  else {
    const zoom = typeof b.zoom === 'string' ? Buffer.from(b.zoom, 'base64') : null;
    if (!zoom || (zoom.length !== 96 * 96 && zoom.length !== 48 * 48)) return { error: 'bad picture' };
    marks[uid] = { uid, label: b.label, zoom: zoom.toString('base64'), marks: list, user: mine ? mine.user : user.id, device, date: Date.now() };
  }
  spotsVer = Date.now();
  fs.writeFileSync(marksFile, JSON.stringify(marks));
  return { ok: true };
}

// ---------- printed-copy check against every check on this PC ----------
const REF = parseReference();
let printIndex = null; // [{uid, itemUid, date, customerName, itemName, letters}]
const fpLetters = (letters) => (letters || []).map((l) => ({ j: l.j, fp: l.fp ? Buffer.from(l.fp, 'base64') : null }));
async function loadPrintIndex() {
  if (printIndex) return printIndex;
  printIndex = [];
  for (const id of await fsp.readdir(path.join(DATA, 'scans'))) {
    try {
      const mt = JSON.parse(await fsp.readFile(path.join(DATA, 'scans', id, 'meta.json'), 'utf8'));
      if (mt.letters && mt.letters.length) printIndex.push({ uid: mt.uid, itemUid: mt.itemUid, date: mt.date, customerName: mt.customerName, itemName: mt.itemName, letters: fpLetters(mt.letters) });
    } catch { /* skip */ }
  }
  return printIndex;
}

// ---------- AI training ----------
// ---------- scanner (SANE: scanimage) and PDF files (pdftoppm) on this PC ----------
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'buffer', maxBuffer: 400e6, timeout: opts.timeout || 240000 }, (err, out, errOut) => {
    if (err) reject(Object.assign(err, { text: String(errOut || err.message).trim().split('\n').slice(-2).join(' ') })); else resolve(out);
  });
});
const tools = { scan: false, pdf: false };
run('scanimage', ['--version'], { timeout: 8000 }).then(() => { tools.scan = true; }).catch(() => {});
run('pdftoppm', ['-v'], { timeout: 8000 }).then(() => { tools.pdf = true; }).catch((e) => { if (e.code !== 'ENOENT') tools.pdf = true; });
let scannerCache = null; // { at, list }
async function listScanners() {
  if (scannerCache && Date.now() - scannerCache.at < 30000) return scannerCache.list;
  const out = String(await run('scanimage', ['-f', '%d|%v %m%n', '-L'], { timeout: 40000 }));
  const list = out.split('\n').map((l) => l.trim()).filter((l) => l.includes('|')).map((l) => { const [id, ...n] = l.split('|'); return { id, name: n.join('|').trim() || id }; });
  scannerCache = { at: Date.now(), list };
  return list;
}
let scanning = false;
async function scanPage(device, dpi) {
  if (scanning) throw new Error('The scanner is busy');
  scanning = true;
  try {
    const base = ['--format=png', `--resolution=${dpi}`];
    if (device) base.unshift('-d', device);
    try { return await run('scanimage', [...base, '--mode', 'Gray']); }
    catch (e) { if (e.killed) throw e; return await run('scanimage', base); } // this scanner has no "Gray" mode
  } finally { scanning = false; }
}
function readRaw(req, limit = 80e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function pdfPage(buf) {
  const dir = await fsp.mkdtemp(path.join(DATA, 'tmp-'));
  try {
    await fsp.writeFile(path.join(dir, 'in.pdf'), buf);
    await run('pdftoppm', ['-png', '-scale-to', '5000', '-f', '1', '-l', '1', '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'out')], { timeout: 120000 });
    return await fsp.readFile(path.join(dir, 'out.png'));
  } finally { fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

let training = null; // { started, log: [], progress }
const trainLog = [];
function log(msg) { const line = `${new Date().toLocaleString()}  ${msg}`; trainLog.push(line); if (trainLog.length > 200) trainLog.shift(); console.log(line); }

function maybeAutoTrain() {
  if (training) return;
  if (library.length >= AUTO_MIN && library.length - (state.lettersAtLastTrain || 0) >= AUTO_EVERY) startTraining('automatic');
}

function currentModelMeta() {
  if (!state.currentModel) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'models', `${state.currentModel}.json`), 'utf8')).meta; } catch { return null; }
}

function startTraining(why) {
  if (training) return false;
  const n = library.length;
  if (n < 100) { log('Not enough letters to train yet.'); return false; }
  const data = new Uint8Array(n * 1024), labels = new Int32Array(n), real = new Uint8Array(n).fill(1);
  library.forEach((s, i) => { data.set(s.x, i * 1024); labels[i] = LETTER_INDEX[s.label]; });
  training = { started: Date.now(), progress: 0, why, letters: n };
  log(`Training started (${why}) on ${n} real letters…`);
  const worker = new Worker(path.join(here, 'trainer.js'), { workerData: { data, labels, real, epochs: EPOCHS } });
  worker.on('message', async (m) => {
    if (m.type === 'progress') training.progress = (m.epoch - 1 + m.done) / m.epochs;
    if (m.type === 'epoch') log(`  round ${m.epoch}/${m.epochs}: ${(m.valAcc * 100).toFixed(1)}% correct on real test letters`);
    if (m.type === 'done') {
      state.lettersAtLastTrain = n;
      const old = currentModelMeta();
      const ok = modelTrusted({ meta: m.meta });
      const better = !old || m.valAcc >= (old.valAcc || 0) - 0.005;
      if (ok && better) {
        const version = new Date().toISOString().replace(/[:.]/g, '-');
        const meta = { ...m.meta, version };
        const json = JSON.parse(m.model); json.meta = meta;
        await fsp.writeFile(path.join(DATA, 'models', `${version}.json`), JSON.stringify(json));
        state.currentModel = version;
        log(`New AI published (${(m.valAcc * 100).toFixed(1)}% correct). Phones get it at their next sync.`);
      } else {
        log(`AI trained (${(m.valAcc * 100).toFixed(1)}% correct) but NOT sent to phones: ${!ok ? `it needs ${MIN_REAL} real letters and 97% correct` : 'the current AI is better'}.`);
      }
      await saveState();
      training = null;
    }
  });
  worker.on('error', (e) => { log('Training failed: ' + e.message); training = null; });
  return true;
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 80e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const safeId = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

async function api(req, res, p) {
  const user = config.users.find((u) => u.code === String(req.headers['x-pair-code'] || '').toUpperCase());
  if (!user) return send(res, 401, { error: 'Wrong or missing pairing code' });
  const m = req.method;
  if (p === '/api/ping') return send(res, 200, { ok: true, server: 'mezuzah-pc', letters: library.length, model: state.currentModel, role: user.role, name: user.name, spots: spotsVer, scan: tools.scan && user.role === 'owner', pdf: tools.pdf && user.role === 'owner' });
  if (p === '/api/marks' && m === 'POST') { const b = await readBody(req, 2e6); const r = setMarks(b, user, safeId(b.device)); return send(res, r.error ? 400 : 200, r); }
  if (p === '/api/spots' && m === 'GET') return send(res, 200, Object.values(marks).map(({ uid, label, zoom, marks: mk }) => ({ uid, label, zoom, marks: mk })));

  // helpers share letters and get the AI back – nothing else (no photos, customers or results)
  if (user.role === 'helper') {
    if (p === '/api/samples' && m === 'POST') { const b = await readBody(req); return send(res, 200, { ok: true, added: await addSamples(b.items, safeId(b.device), null, user) }); }
    if (p === '/api/scans' && m === 'POST') { const b = await readBody(req); return send(res, 200, { ok: true, added: await addSamples(b.samples, safeId(b.device), null, user) }); }
    if (p !== '/api/model/meta' && p !== '/api/model') return send(res, 403, { error: 'This pairing code can only share letters' });
  }

  // the scanner connected to this PC, and PDF files (first page) – for the owner only
  if (p === '/api/scanners' && m === 'GET') {
    if (!tools.scan) return send(res, 200, { ok: false, error: 'no-sane' });
    try { return send(res, 200, { ok: true, list: await listScanners() }); } catch (e) { return send(res, 200, { ok: false, error: e.text || e.message }); }
  }
  if (p === '/api/scan' && m === 'POST') {
    if (!tools.scan) return send(res, 400, { error: 'no-sane' });
    const b = await readBody(req, 1e4);
    const dpi = [150, 200, 300, 400, 600, 800, 1200].includes(Number(b.dpi)) ? Number(b.dpi) : 600;
    const dev = typeof b.device === 'string' && /^[\w:.\-\/@%=?&+,\[\] ]{1,200}$/.test(b.device) ? b.device : '';
    try { const png = await scanPage(dev, dpi); log(`Scanned a page (${dpi} dpi).`); return send(res, 200, png, 'image/png'); }
    catch (e) { return send(res, 500, { error: e.killed ? 'The scanner took too long' : (e.text || e.message) }); }
  }
  if (p === '/api/pdf' && m === 'POST') {
    if (!tools.pdf) return send(res, 400, { error: 'no-pdftoppm' });
    const buf = await readRaw(req, 80e6);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return send(res, 400, { error: 'Not a PDF file' });
    try { return send(res, 200, await pdfPage(buf), 'image/png'); } catch (e) { return send(res, 500, { error: e.text || e.message }); }
  }

  if (p === '/api/users' && m === 'GET') {
    const by = {}; for (const s of library) by[s.user || 'owner'] = (by[s.user || 'owner'] || 0) + 1;
    const pend = {}; for (const s of pending) pend[s.user] = (pend[s.user] || 0) + 1;
    return send(res, 200, config.users.map((u) => ({ id: u.id, name: u.name, code: u.code, role: u.role, trusted: u.trusted, letters: by[u.id] || 0, pending: pend[u.id] || 0 })));
  }
  if (p === '/api/users' && m === 'POST') {
    const b = await readBody(req);
    const u = { id: `h${crypto.randomBytes(4).toString('hex')}`, name: String(b.name || 'Helper').slice(0, 60), code: newCode(), role: 'helper', trusted: b.trusted !== false, created: Date.now() };
    config.users.push(u); saveConfig();
    return send(res, 200, u);
  }
  const um = p.match(/^\/api\/users\/([a-z0-9]+)$/);
  if (um && m === 'POST') {
    const b = await readBody(req);
    const u = config.users.find((x) => x.id === um[1] && x.role === 'helper');
    if (!u) return send(res, 404, { error: 'not found' });
    if (b.remove) config.users = config.users.filter((x) => x !== u);
    if (typeof b.trusted === 'boolean') u.trusted = b.trusted;
    saveConfig();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/pending' && m === 'GET') {
    return send(res, 200, { total: pending.length, items: pending.slice(0, 300).map((s) => ({ uid: s.uid, label: s.label, view: s.view, user: s.user })) });
  }
  if (p === '/api/pending' && m === 'POST') {
    const b = await readBody(req);
    const pick = pending.filter((s) => (!b.user || s.user === b.user) && (!b.uids || b.uids.includes(s.uid)));
    const keep = new Set(pick.map((s) => s.uid));
    pending = pending.filter((s) => !keep.has(s.uid));
    if (b.action === 'approve' && pick.length) {
      await fsp.appendFile(libFile, pick.map((s) => JSON.stringify({ ...s, approved: Date.now() })).join('\n') + '\n');
      for (const s of pick) library.push({ ...s, x: Buffer.from(s.x, 'base64'), view: undefined });
      maybeAutoTrain();
    }
    await savePending();
    return send(res, 200, { ok: true, moved: pick.length });
  }

  if (p === '/api/scans' && m === 'POST') {
    const b = await readBody(req);
    const uid = safeId(b.uid);
    if (!uid) return send(res, 400, { error: 'missing uid' });
    const dir = path.join(DATA, 'scans', uid);
    await fsp.mkdir(dir, { recursive: true });
    if (b.photo) await fsp.writeFile(path.join(dir, 'photo.jpg'), Buffer.from(b.photo, 'base64'));
    const meta = {
      uid, device: safeId(b.device), date: b.date, mode: b.mode, stats: b.stats, issues: b.issues, quality: b.quality, w: b.w, h: b.h, received: Date.now(),
      customerUid: b.customerUid || null, itemUid: b.itemUid || null, customerName: b.customerName || null, itemName: b.itemName || null,
      letters: Array.isArray(b.letters) ? b.letters : [], letterH: b.letterH || null, printWarnings: b.printWarnings || [],
    };
    if (meta.letters.length) {
      const idx = await loadPrintIndex();
      const me = { uid, itemUid: meta.itemUid, date: meta.date, customerName: meta.customerName, itemName: meta.itemName, letters: fpLetters(meta.letters) };
      const pc = printedCheck(me, idx, REF);
      meta.printWarningsPC = pc.warnings.map((w) => ({ kind: w.kind, note: w.note, score: w.score, other: w.other || null }));
      if (pc.warnings.length) log(`Printed-copy warning for check ${uid}: ${pc.warnings.map((w) => w.kind).join(', ')}`);
      if (!idx.some((x) => x.uid === uid)) idx.push(me);
    }
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    const added = await addSamples(b.samples, meta.device, uid, user);
    return send(res, 200, { ok: true, added });
  }
  if (p === '/api/scans' && m === 'GET') {
    const out = [];
    for (const id of await fsp.readdir(path.join(DATA, 'scans'))) {
      try { const mt = JSON.parse(await fsp.readFile(path.join(DATA, 'scans', id, 'meta.json'), 'utf8')); out.push({ uid: mt.uid, date: mt.date, device: mt.device, mode: mt.mode, stats: mt.stats, nIssues: (mt.issues || []).length, customerName: mt.customerName, itemName: mt.itemName, customerUid: mt.customerUid, itemUid: mt.itemUid, printed: !!((mt.printWarningsPC || []).length || (mt.printWarnings || []).length), verdict: mt.result ? mt.result.verdict : null }); } catch { /* skip */ }
    }
    out.sort((a, b) => b.date - a.date);
    return send(res, 200, out);
  }
  const rm = p.match(/^\/api\/scans\/([a-zA-Z0-9_-]+)\/result$/);
  if (rm && m === 'POST') {
    const b = await readBody(req);
    const f = path.join(DATA, 'scans', safeId(rm[1]), 'meta.json');
    try {
      const mt = JSON.parse(await fsp.readFile(f, 'utf8'));
      mt.result = b.result || null;
      await fsp.writeFile(f, JSON.stringify(mt));
      return send(res, 200, { ok: true });
    } catch { return send(res, 404, { error: 'check not found' }); }
  }
  let mm = p.match(/^\/api\/scans\/([a-zA-Z0-9_-]+)(\/photo)?$/);
  if (mm && m === 'GET') {
    const dir = path.join(DATA, 'scans', safeId(mm[1]));
    try {
      if (mm[2]) return send(res, 200, await fsp.readFile(path.join(dir, 'photo.jpg')), 'image/jpeg');
      return send(res, 200, await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
    } catch { return send(res, 404, { error: 'not found' }); }
  }
  if (p === '/api/records' && m === 'POST') return send(res, 200, { ok: true, changed: mergeRecords(await readBody(req)) });
  if (p === '/api/records' && m === 'GET') return send(res, 200, { customers: Object.values(records.customers), items: Object.values(records.items) });
  if (p === '/api/export.csv') {
    // every check, one line each – for Excel or for importing into another app (e.g. Melechet Sofer)
    const V = { kosher: 'כשרה', 'kosher-repaired': 'כשרה לאחר תיקון', 'needs-repair': 'צריכה תיקון', pasul: 'פסולה' };
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Customer', 'Phone', 'Address', 'Mezuzah', 'Result', 'Notes / fixed', 'Places marked', 'What the app marked', 'Printed-copy warning', 'Check id']];
    const list = [];
    for (const id of await fsp.readdir(path.join(DATA, 'scans'))) {
      try { list.push(JSON.parse(await fsp.readFile(path.join(DATA, 'scans', id, 'meta.json'), 'utf8'))); } catch { /* skip */ }
    }
    list.sort((a, b) => a.date - b.date);
    for (const mt of list) {
      if (mt.mode !== 'check') continue;
      const c = (mt.customerUid && records.customers[mt.customerUid]) || {};
      const kinds = {}; for (const i of mt.issues || []) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
      rows.push([new Date(mt.date).toISOString().slice(0, 10), mt.customerName || '', c.phone || '', c.address || '', mt.itemName || '',
        mt.result ? V[mt.result.verdict] || mt.result.verdict : '', mt.result ? mt.result.notes || '' : '', (mt.issues || []).length,
        Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join('; '), ((mt.printWarningsPC || mt.printWarnings || []).length ? 'yes' : ''), mt.uid]);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mezuzah-checks.csv"', 'Cache-Control': 'no-store' });
    return res.end('\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n');
  }
  if (p === '/api/samples' && m === 'POST') {
    const b = await readBody(req);
    return send(res, 200, { ok: true, added: await addSamples(b.items, safeId(b.device), null, user) });
  }
  if (p === '/api/library/stats') {
    const counts = Object.fromEntries(LETTERS.map((l) => [l, 0]));
    for (const s of library) counts[s.label]++;
    return send(res, 200, { spots: Object.keys(marks).length, total: library.length, counts, sinceTrain: library.length - (state.lettersAtLastTrain || 0), autoMin: AUTO_MIN, autoEvery: AUTO_EVERY });
  }
  if (p === '/api/model/meta') {
    const meta = currentModelMeta();
    return send(res, 200, { version: state.currentModel, meta, trusted: meta ? modelTrusted({ meta }) : false });
  }
  if (p === '/api/model') {
    if (!state.currentModel) return send(res, 404, { error: 'no model yet' });
    return send(res, 200, await fsp.readFile(path.join(DATA, 'models', `${state.currentModel}.json`), 'utf8'));
  }
  if (p === '/api/train' && m === 'POST') return send(res, 200, { started: startTraining('started on the PC') });
  if (p === '/api/train/status') return send(res, 200, { running: training, log: trainLog.slice(-40) });
  return send(res, 404, { error: 'unknown' });
}

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/api/')) {
      // the phone app may also be opened from GitHub Pages; only that page may talk to this PC (and only with a pairing code)
      if (req.headers.origin === 'https://moamar2458.github.io') {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'x-pair-code, content-type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      }
      return await api(req, res, p);
    }
    let file = path.normalize(path.join(APP, p.endsWith('/') ? p + 'index.html' : p));
    if (!file.startsWith(APP)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use – is the PC program already open in another window?\n`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('\n  Mezuzah Checker – PC program');
  console.log(`  PC screen:      http://localhost:${PORT}/pc.html`);
  console.log(`  Check on the PC: http://localhost:${PORT}/   (camera, scanner or a saved file)`);
  console.log(`  Pairing code:   ${config.users[0].code}   (type it into your phone once)`);
  if (config.users.length > 1) console.log(`  Helpers:        ${config.users.length - 1} (manage them on the PC screen → Library & AI)`);
  console.log(`  Data folder:    ${DATA}`);
  console.log(`  Letters:        ${library.length} in the library, AI: ${state.currentModel || 'none yet'}`);
  console.log(LAN ? '  Open to the home network (no https: the phone uses its own camera app).' : `  For the phone (once, private to your tailnet):  sudo tailscale serve --bg --https=8443 ${PORT}`);
  console.log('');
});
