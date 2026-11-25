// Main screen logic of the phone app.
import * as db from './db.js';
import { Camera } from './camera.js';
import { MEZUZAH_TEXT, referenceStats, LETTERS, LETTER_NAMES } from './reference.js';
import { addScanLetters, resolveReview, exportLibrary } from './library.js';
import { deserializeModel } from './nn.js';
import { modelTrusted, MIN_REAL } from './pipeline.js';
import { sortIssues, paintIssues, paintBoxes } from './report.js';
import { getSettings, saveSettings, queueScan, queueSamples, queueRecords, syncNow, newUid } from './sync.js';
import * as C from './customers.js';
import { compareScans } from './compare.js';
import { printedCheck } from './fraud.js';
import { VERDICTS, certificateHTML, CERT_CSS, printCertificate, checkSummaryText } from './certificate.js';
import { queueResult } from './sync.js';
import { parseReference } from './reference.js';
import { b64ToU8 } from './library.js';

const $ = (id) => document.getElementById(id);
const ANALYSIS_MAX = 3200; // longest side of the picture used for checking
const TITLES = {
  home: 'Mezuzah Checker', camera: 'Take a photo', busy: 'Checking…', report: 'Places to check',
  learned: 'Learned', review: 'Review unsure letters', library: 'Library & AI', reference: 'Reference text', history: 'History',
  who: 'Who is this check for?', customers: 'Customers & reminders', customer: 'Customer', compare: 'Before / after', cert: 'Result & certificate',
};

let state = { mode: 'check', refText: MEZUZAH_TEXT, refConfirmed: false, modelJson: null, sens: 0.15, target: null };
let camera = null;
const stack = [];

// ---------- navigation ----------
function show(id, push = true) {
  const cur = document.querySelector('.screen:not([hidden])');
  if (cur && cur.id === 'camera' && id !== 'camera') stopCamera();
  if (push && cur && cur.id !== id && cur.id !== 'busy') stack.push(cur.id);
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  $('title').textContent = TITLES[id] || '';
  $('backBtn').hidden = id === 'home';
  window.scrollTo(0, 0);
  const enter = { home: refreshHome, review: openReview, library: openLibrary, reference: openReference, history: openHistory, customers: openCustomers, who: openWho }[id];
  if (enter) enter();
}
$('backBtn').onclick = () => show(stack.pop() || 'home', false);
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); if (go.dataset.go === 'home') stack.length = 0; show(go.dataset.go, go.dataset.go !== 'home'); }
});

// ---------- startup ----------
async function init() {
  state.refText = (await db.get('refText')) || MEZUZAH_TEXT;
  state.refConfirmed = !!(await db.get('refConfirmed'));
  state.modelJson = (await db.get('model')) || null;
  state.sens = (await db.get('sens')) ?? 0.15;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  show('home', false);
  runSync();
  setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);
  window.addEventListener('online', runSync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(); });
}

// ---------- who is the check for ----------
let whoCust = null;
async function openWho() {
  whoCust = null; $('custSearch').value = ''; $('itemBox').hidden = true; $('whoGo').hidden = true;
  await fillCustPick();
}
async function fillCustPick() {
  const q = $('custSearch').value.trim();
  const all = await C.customers();
  const list = q ? all.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || (c.phone || '').includes(q)) : all.slice(0, 30);
  const ul = $('custPick'); ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="sub"></span>';
    li.firstChild.textContent = c.name; li.lastChild.textContent = c.phone || '';
    li.classList.toggle('sel', whoCust && whoCust.uid === c.uid);
    li.onclick = () => pickCustomer(c);
    ul.appendChild(li);
  }
  const exact = all.some((c) => c.name === q);
  $('newCustBtn').hidden = !q || exact;
  $('newCustBtn').textContent = `+ New customer: ${q}`;
}
$('custSearch').oninput = () => { whoCust = null; $('itemBox').hidden = true; $('whoGo').hidden = true; fillCustPick(); };
$('newCustBtn').onclick = async () => {
  const c = await C.saveCustomer({ name: $('custSearch').value });
  await queueRecords([c], []);
  $('custSearch').value = c.name; pickCustomer(c);
};
async function pickCustomer(c) {
  whoCust = c; state.target = null; $('whoGo').hidden = true;
  await fillCustPick();
  $('itemBox').hidden = false;
  $('itemTitle').textContent = `Which mezuzah of ${c.name}?`;
  const items = await C.itemsOf(c.uid);
  const ul = $('itemPick'); ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="sub"></span>';
    li.firstChild.textContent = it.name;
    li.lastChild.textContent = it.lastCheck ? `last ${new Date(it.lastCheck).toLocaleDateString()}` : 'not checked yet';
    li.onclick = () => { state.target = { customer: c, item: it }; for (const x of ul.children) x.classList.toggle('sel', x === li); $('whoGo').hidden = false; };
    ul.appendChild(li);
  }
  if (items.length === 1) ul.firstChild.click();
  if (!items.length) $('newItemName').value = 'Front door';
}
$('newItemBtn').onclick = async () => {
  if (!whoCust || !$('newItemName').value.trim()) return;
  const it = await C.saveItem({ customerUid: whoCust.uid, name: $('newItemName').value });
  await queueRecords([], [it]);
  $('newItemName').value = '';
  await pickCustomer(whoCust);
  [...$('itemPick').children].at(-1).click();
};
$('whoGo').onclick = () => startCapture('check', true);
$('whoSkip').onclick = () => { state.target = null; startCapture('check', true); };

// ---------- customers & reminders ----------
async function openCustomers() {
  const due = await C.dueList();
  const box = $('dueBox'); box.innerHTML = '';
  if (due.length) {
    box.innerHTML = '<h2>Due for a check</h2><ul class="pick-list" id="dueUl"></ul><button id="dueCal" class="big">📅 Add these reminders to my calendar</button>';
    for (const d of due) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><span class="sub"></span>';
      li.firstChild.textContent = `${d.customer.name} – ${d.item.name}`;
      li.lastChild.textContent = `${d.state === 'overdue' ? 'overdue since' : 'due'} ${new Date(d.due).toLocaleDateString()}`;
      li.lastChild.className = `sub due-${d.state}`;
      li.onclick = () => openCustomer(d.customer.uid);
      $('dueUl').appendChild(li);
    }
    $('dueCal').onclick = () => downloadCalendar(due, 'mezuzah-checks-due');
  } else box.innerHTML = '<p class="small">Nothing is due in the next 30 days.</p>';
  await fillCustList();
}
async function fillCustList() {
  const q = $('custFilter').value.trim().toLowerCase();
  const ul = $('custList'); ul.innerHTML = '';
  for (const c of await C.customers()) {
    if (q && !c.name.toLowerCase().includes(q) && !(c.phone || '').includes(q)) continue;
    const items = await C.itemsOf(c.uid);
    const dues = items.map(C.nextDue).filter(Boolean).sort((a, b) => a - b);
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="sub"></span>';
    li.firstChild.textContent = c.name;
    li.lastChild.textContent = `${items.length} mezuz${items.length === 1 ? 'ah' : 'ot'}${dues.length ? ` · next ${new Date(dues[0]).toLocaleDateString()}` : ''}`;
    li.onclick = () => openCustomer(c.uid);
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = '<li class="small">No customers yet. They are added when you start a check.</li>';
}
$('custFilter').oninput = fillCustList;
$('addCustBtn').onclick = async () => {
  const name = prompt('Customer name'); if (!name || !name.trim()) return;
  const c = await C.saveCustomer({ name }); await queueRecords([c], []); openCustomer(c.uid);
};

function downloadCalendar(entries, name) {
  const file = new File([C.calendarFile(entries)], `${name}.ics`, { type: 'text/calendar' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

let curCust = null;
async function openCustomer(cuid) {
  curCust = await C.getCustomer(cuid);
  if (!curCust) return;
  show('customer');
  $('title').textContent = curCust.name;
  $('cName').value = curCust.name; $('cPhone').value = curCust.phone || ''; $('cAddress').value = curCust.address || ''; $('cNotes').value = curCust.notes || '';
  const box = $('cItems'); box.innerHTML = '';
  const items = await C.itemsOf(cuid);
  if (!items.length) box.innerHTML = '<p class="small">No mezuzot yet.</p>';
  for (const it of items) {
    const due = C.nextDue(it), st = C.dueState(it);
    const card = document.createElement('div'); card.className = 'item-card';
    card.innerHTML = `<b></b><div class="small last"></div><div class="small due"></div>
      <div class="row"><label class="small">Check every <input type="number" min="1" max="120" class="months"> months</label></div>
      <div class="row"><button class="primary go">📷 Check now</button><button class="cal">📅 Reminder</button><button class="del danger">Remove</button></div>`;
    card.querySelector('b').textContent = it.name;
    card.querySelector('.last').textContent = it.lastCheck ? `Last checked ${new Date(it.lastCheck).toLocaleDateString()}` : 'Not checked yet';
    const dueEl = card.querySelector('.due');
    dueEl.textContent = due ? `${st === 'overdue' ? 'Overdue since' : 'Next check'} ${new Date(due).toLocaleDateString()}` : '';
    dueEl.className = `small due due-${st}`;
    const mi = card.querySelector('.months'); mi.value = it.months || C.DEFAULT_MONTHS;
    mi.onchange = async () => { const r = await C.saveItem({ ...it, months: mi.value }); await queueRecords([], [r]); openCustomer(cuid); };
    card.querySelector('.go').onclick = () => { state.target = { customer: curCust, item: it }; startCapture('check', true); };
    card.querySelector('.cal').disabled = !due;
    card.querySelector('.cal').onclick = () => downloadCalendar([{ item: it, customer: curCust, due }], `mezuzah-${curCust.name}-${it.name}`);
    card.querySelector('.del').onclick = async () => { if (!confirm(`Remove "${it.name}"?`)) return; const r = await C.saveItem({ ...it, deleted: true }); await queueRecords([], [r]); openCustomer(cuid); };
    box.appendChild(card);
  }
}
$('cSave').onclick = async () => {
  if (!$('cName').value.trim()) { alert('Please enter a name.'); return; }
  curCust = await C.saveCustomer({ ...curCust, name: $('cName').value, phone: $('cPhone').value, address: $('cAddress').value, notes: $('cNotes').value });
  await queueRecords([curCust], []); runSync();
  $('title').textContent = curCust.name;
};
$('cDelete').onclick = async () => {
  if (!confirm(`Delete ${curCust.name}? Their past checks stay in the history.`)) return;
  const c = await C.saveCustomer({ ...curCust, deleted: true }); await queueRecords([c], []); runSync();
  show('customers', false);
};
$('cAddItem').onclick = async () => {
  if (!$('cNewItem').value.trim()) return;
  const it = await C.saveItem({ customerUid: curCust.uid, name: $('cNewItem').value });
  await queueRecords([], [it]); $('cNewItem').value = ''; openCustomer(curCust.uid);
};

// ---------- PC sync ----------
async function runSync() {
  const r = await syncNow();
  if (r.modelJson) state.modelJson = r.modelJson;
  if (r.recordsChanged && !$('home').hidden) refreshHome();
  showSyncStatus();
  return r;
}
async function syncText() {
  const s = await getSettings();
  const st = (await db.get('syncStatus')) || {};
  const waiting = await db.count('outbox');
  if (!s.code) return 'PC sync is off (Library & AI → PC sync).';
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const last = await db.get('lastSync');
  let txt = st.state === 'ok' ? `PC: synced ${ago(st.at)}${s.role === 'helper' ? ' (helper: only letters are shared)' : ''}` : st.state === 'error' ? `PC: ${st.message}` : `PC: not reachable now${last ? ` (last sync ${ago(last)})` : ''}`;
  if (waiting) txt += ` · ${waiting} waiting to send`;
  return txt;
}
async function showSyncStatus() {
  const t = await syncText();
  if ($('syncLine')) $('syncLine').textContent = t;
  if ($('syncInfo')) $('syncInfo').textContent = t;
}

async function refreshHome() {
  $('refWarn').hidden = state.refConfirmed;
  const [nSamples, nReview, nScans] = await Promise.all([db.count('samples'), db.count('review'), db.count('scans')]);
  $('reviewCount').textContent = nReview;
  $('reviewCount').hidden = !nReview;
  let model = 'No AI model yet: checks use the known text and letter shapes.';
  if (state.modelJson) {
    try {
      const m = JSON.parse(state.modelJson).meta || {};
      model = modelTrusted({ meta: m })
        ? `AI in use (trained ${m.trained ? new Date(m.trained).toLocaleDateString() : '?'} on ${m.realSamples} real letters, ${(m.valAcc * 100).toFixed(1)}% correct on real letters).`
        : `AI loaded but NOT used yet: it learned from ${m.realSamples || 0} real letters, needs ${MIN_REAL}.`;
    } catch { /* ignore */ }
  }
  const due = await C.dueList();
  const over = due.filter((d) => d.state === 'overdue').length;
  $('dueCount').textContent = due.length; $('dueCount').hidden = !due.length;
  $('dueBanner').hidden = !due.length;
  $('dueBanner').textContent = due.length ? `🔔 ${due.length} mezuzah check${due.length > 1 ? 's are' : ' is'} due${over ? ` (${over} overdue)` : ' soon'}: ${due.slice(0, 3).map((d) => d.customer.name).join(', ')}${due.length > 3 ? '…' : ''}` : '';
  $('dueBanner').onclick = () => show('customers');
  $('homeStatus').innerHTML = `Library: <b>${nSamples}</b> sure letters · <b>${nReview}</b> to review · <b>${nScans}</b> mezuzot checked<br>${model}<br><span id="syncLine"></span>`;
  showSyncStatus();
}

// ---------- camera ----------
$('checkBtn').onclick = () => { state.target = null; show('who'); };
$('learnBtn').onclick = () => startCapture('learn');
$('learnAgain').onclick = () => startCapture('learn');
$('retakeBtn').onclick = () => startCapture(state.mode, true);

async function startCapture(mode, keepTarget = false) {
  if (!keepTarget) state.target = null;
  if (!state.refConfirmed) {
    if (!confirm('The reference text has not been confirmed yet. Open it now?\n(Press Cancel to continue anyway.)')) { /* continue */ } else { show('reference'); return; }
  }
  state.mode = mode;
  show('camera');
  $('title').textContent = mode === 'learn' ? 'Learn: take a photo' : 'Check: take a photo';
  $('noCam').hidden = true;
  if (!Camera.supported()) { $('noCam').hidden = false; document.querySelector('.cam-wrap').hidden = true; document.querySelector('.cam-buttons').hidden = true; return; }
  document.querySelector('.cam-wrap').hidden = false; document.querySelector('.cam-buttons').hidden = false;
  camera = new Camera($('video'), camStatus);
  try { await camera.start(); } catch (err) {
    $('noCam').hidden = false; document.querySelector('.cam-wrap').hidden = true; document.querySelector('.cam-buttons').hidden = true;
  }
}
function stopCamera() { if (camera) { camera.stop(); camera = null; } }

function camStatus(s) {
  const set = (el, ok, txt) => { el.className = `chip ${ok === null ? '' : ok ? 'ok' : 'bad'}`; el.textContent = txt; };
  set($('stLight'), s.light === 'ok', s.light === 'dark' ? 'Too dark' : s.light === 'glare' ? 'Glare' : 'Light ✓');
  set($('stSharp'), s.sharp === 'ok', s.sharp === 'ok' ? 'Sharp ✓' : 'Blurry');
  set($('stLevel'), s.level === 'unknown' ? null : s.level === 'ok', s.level === 'unknown' ? 'Level ?' : s.level === 'ok' ? 'Level ✓' : `Tilted ${Math.round(s.tiltDeg)}°`);
  const tips = [];
  if (s.light === 'dark') tips.push('Add more light.');
  if (s.light === 'glare') tips.push('Move the light to avoid shine on the klaf.');
  if (s.sharp !== 'ok') tips.push('Hold still, tap the screen to focus.');
  if (s.level === 'tilted') tips.push('Hold the phone flat, straight above the klaf.');
  $('camTip').textContent = tips.join(' ') || 'Looks good — take the photo.';
}
let torchOn = false;
$('torchBtn').onclick = async () => { torchOn = !torchOn; if (camera && !(await camera.torch(torchOn))) { torchOn = false; alert('This phone does not allow the light to be turned on from the app.'); } };
$('shootBtn').onclick = async () => {
  if (!camera) return;
  const img = await camera.capture();
  stopCamera();
  process(img);
};
for (const id of ['pickFile', 'pickFile2', 'nativeCam']) {
  $(id).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    stopCamera();
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
    process(bmp);
  };
}

// ---------- running the check ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0; const jobs = new Map();
worker.onmessage = (e) => { const j = jobs.get(e.data.id); if (j) { jobs.delete(e.data.id); e.data.ok ? j.resolve(e.data.res) : j.reject(new Error(e.data.error)); } };
const runJob = (msg, transfer) => new Promise((resolve, reject) => { const id = ++jobId; jobs.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer); });

async function process(img) {
  show('busy', false);
  $('busyMsg').textContent = state.mode === 'learn' ? 'Finding and learning the letters…' : 'Finding the letters and comparing with the text…';
  const iw = img.width, ih = img.height;
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const c = $('work'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let res;
  try {
    res = await runJob({ rgba: data.buffer, w, h, refText: state.refText, modelJson: state.modelJson, sens: state.sens }, [data.buffer]);
  } catch (err) {
    alert('Something went wrong while checking:\n' + err.message);
    show('home', false); return;
  }
  res.rgba = new Uint8ClampedArray(res.rgba);
  sortIssues(res.issues || [], (res.quality && res.quality.letterHeightPx) || 40);
  drawReport(res);
  // keep the clean (straightened) photo; the circles are drawn again when it is shown
  const clean = document.createElement('canvas'); clean.width = res.w; clean.height = res.h;
  clean.getContext('2d').putImageData(new ImageData(res.rgba, res.w, res.h), 0, 0);
  const photo = await new Promise((r) => clean.toBlob(r, 'image/jpeg', 0.85));
  const t = state.mode === 'check' ? state.target : null;
  const scan = {
    uid: newUid(), date: Date.now(), mode: state.mode, stats: res.stats || null, issues: res.issues || [],
    quality: res.quality || null, w: res.w, h: res.h, photo,
    customerUid: t ? t.customer.uid : null, itemUid: t ? t.item.uid : null,
    customerName: t ? t.customer.name : null, itemName: t ? t.item.name : null,
    letters: res.letters || [], letterH: res.letterH || null,
  };
  const prevUid = t ? t.item.lastScanUid : null; // the last check of this same mezuzah
  // printed-copy warning: compare with earlier checks of other mezuzot on this phone (the PC compares with all)
  if (res.ok && scan.letters.length) {
    const others = (await db.all('scans')).filter((o) => o.letters && o.letters.length);
    const pc = printedCheck(scan, others, parseReference(state.refText));
    scan.printWarnings = pc.warnings.map((w) => ({ kind: w.kind, note: w.note, score: w.score }));
    res.quality = res.quality || { warnings: [] };
    for (const w of pc.warnings) res.quality.warnings.unshift({ kind: 'print', note: w.note });
  }
  const scanId = await db.add('scans', scan);
  scan.id = scanId; state.lastScan = scan;
  state.compare = null;
  if (t && res.ok) {
    // the item was checked today: the next check is due in N months
    const it = await C.recordCheck(t.item.uid, scan.uid, scan.date);
    t.item = it;
    await queueRecords([t.customer], [it]);
    // before / after: compare with the last check of the same mezuzah
    if (prevUid && prevUid !== scan.uid) {
      const prev = await loadScan(prevUid);
      if (prev && prev.letters) state.compare = { prev, cur: scan, result: compareScans(prev, scan, parseReference(state.refText)) };
    }
  }
  pruneHistory();
  // every checked photo adds its letters to the library automatically
  let learned = { sure: 0, unsure: 0, sureSamples: [] };
  if (res.ok) learned = await addScanLetters(scanId, res.samples, scan.uid);
  // and is sent to the PC (now, or as soon as the PC can be reached)
  await queueScan(scan, photo, learned.sureSamples);
  runSync();
  if (state.mode === 'learn') showLearned(res, learned); else showReport(res, learned);
}

async function pruneHistory() {
  // keep the last 40 checks, and always the last check of every customer's mezuzah (for before / after)
  const keep = new Set((await db.all('items')).map((i) => i.lastScanUid).filter(Boolean));
  const scans = await db.all('scans');
  for (const s of scans.slice(0, Math.max(0, scans.length - 40))) if (!keep.has(s.uid)) await db.del('scans', s.id);
}

/** A past check: from this phone, or else from the PC. */
async function loadScan(uid) {
  const local = (await db.all('scans')).find((s) => s.uid === uid);
  if (local && local.photo) return local;
  try {
    const ss = await getSettings();
    if (!ss.code) return null;
    const base = (ss.url || location.origin).replace(/\/+$/, '');
    const h = { headers: { 'x-pair-code': ss.code } };
    const meta = await (await fetch(`${base}/api/scans/${uid}`, h)).json();
    const photo = await (await fetch(`${base}/api/scans/${uid}/photo`, h)).blob();
    meta.letters = (meta.letters || []).map((l) => ({ ...l, fp: typeof l.fp === 'string' ? b64ToU8(l.fp) : l.fp }));
    return { ...meta, photo };
  } catch { return null; }
}

// ---------- result & certificate ----------
{ const st = document.createElement('style'); st.textContent = CERT_CSS; document.head.appendChild(st); }
for (const v of VERDICTS) {
  const l = document.createElement('label');
  l.innerHTML = `<input type="radio" name="verdict" value="${v.id}"><span><b dir="rtl"></b><br><span class="small"></span></span>`;
  l.querySelector('b').textContent = v.he; l.querySelector('.small').textContent = v.en;
  l.querySelector('input').onchange = certPreview;
  $('verdicts').appendChild(l);
}
$('certNotes').oninput = certPreview;
async function certData() {
  const scan = state.lastScan;
  const business = (await db.get('business')) || {};
  const verdict = (document.querySelector('input[name=verdict]:checked') || {}).value || null;
  let nextDate = null;
  if (scan.itemUid) { const it = await C.getItem(scan.itemUid); if (it) nextDate = C.nextDue(it); }
  return {
    business, customerName: scan.customerName || '', itemName: scan.itemName || '', date: scan.date, verdict,
    notes: $('certNotes').value.trim(), nextDate, number: scan.uid.slice(0, 8).toUpperCase(),
  };
}
async function certPreview() {
  const d = await certData();
  $('certPreview').innerHTML = certificateHTML(d);
  $('certNeedBiz').hidden = !!(d.business && d.business.name);
}
async function openCert() {
  const scan = state.lastScan; if (!scan) return;
  show('cert');
  $('certFor').textContent = `${scan.customerName ? `${scan.customerName} – ${scan.itemName}` : 'No customer'} · ${new Date(scan.date).toLocaleDateString()}`;
  for (const r of document.querySelectorAll('input[name=verdict]')) r.checked = !!(scan.result && scan.result.verdict === r.value);
  $('certNotes').value = (scan.result && scan.result.notes) || '';
  $('certMsg').textContent = scan.result ? `Saved ${new Date(scan.result.date).toLocaleString()}` : '';
  certPreview();
}
$('certBtn').onclick = openCert;
async function saveResult() {
  const d = await certData();
  if (!d.verdict) { alert('Please choose the result first.'); return false; }
  const scan = state.lastScan;
  scan.result = { verdict: d.verdict, notes: d.notes, date: Date.now(), business: d.business };
  await db.put('scans', scan);
  await queueResult(scan.uid, scan.result);
  runSync();
  $('certMsg').textContent = `Saved ${new Date(scan.result.date).toLocaleString()}`;
  return true;
}
$('certSave').onclick = saveResult;
$('certPrint').onclick = async () => { if (!(await saveResult())) return; printCertificate(certificateHTML(await certData())); };

// Melechet Sofer (and any other app): share a ready text, or copy it.
$('certShare').onclick = async () => {
  const scan = state.lastScan, d = await certData();
  const text = checkSummaryText({ ...scan, result: scan.result || (d.verdict ? { verdict: d.verdict, notes: d.notes } : null), nextDate: d.nextDate, business: d.business });
  try {
    if (navigator.share) { await navigator.share({ title: 'Mezuzah check', text }); $('certMsg').textContent = 'Shared.'; return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); $('certMsg').textContent = 'Copied – paste it into the customer card in Melechet Sofer.'; }
  catch { prompt('Copy this text:', text); }
};

$('bizSave').onclick = async () => {
  await db.set('business', { name: $('bizName').value.trim(), sofer: $('bizSofer').value.trim(), phone: $('bizPhone').value.trim(), address: $('bizAddress').value.trim(), extra: $('bizExtra').value.trim() });
  $('bizSave').textContent = 'Saved ✓'; setTimeout(() => { $('bizSave').textContent = 'Save business details'; }, 1500);
};

// ---------- before / after ----------
async function openCompare() {
  const cmp = state.compare; if (!cmp) return;
  show('compare');
  const { prev, cur, result } = cmp;
  $('cmpHead').textContent = `Last check ${new Date(prev.date).toLocaleDateString()} → this check ${new Date(cur.date).toLocaleDateString()}`;
  const [pb, cb] = await Promise.all([createImageBitmap(prev.photo), createImageBitmap(cur.photo)]);
  const whole = (cv, bmp, scan) => { cv.width = bmp.width; cv.height = bmp.height; const x = cv.getContext('2d'); x.drawImage(bmp, 0, 0); paintIssues(x, bmp.width, scan.issues || []); };
  whole($('cmpOld'), pb, prev); whole($('cmpNew'), cb, cur);
  const list = $('cmpList'); list.innerHTML = '';
  if (!result.ok) { list.innerHTML = '<p class="small">Too few letters were found in both photos to compare.</p>'; return; }
  if (!result.changes.length) list.innerHTML = `<p>No letter changed clearly since the last check (${result.common} letters compared). The sofer should still check the whole mezuzah.</p>`;
  const crop = (bmp, b) => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 120;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 120, 120);
    if (b) { const side = Math.max(b[2] - b[0], b[3] - b[1]) * 1.8 + 6, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; x.drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, 120, 120); }
    return c;
  };
  for (const ch of result.changes) {
    const row = document.createElement('div'); row.className = 'cmp-row';
    const pair = document.createElement('div'); pair.className = 'cmp-pair';
    const a = crop(pb, ch.old && ch.old.b), b = crop(cb, ch.now && ch.now.b);
    a.title = 'before'; b.title = 'now';
    pair.append(a, b);
    const note = document.createElement('div'); note.className = 'small'; note.textContent = ch.note;
    row.append(pair, note); list.appendChild(row);
  }
}
$('cmpBtn').onclick = openCompare;

// ---------- report ----------
let zoom = 1, current = null;
function drawReport(res, sel = -1) {
  const cv = $('reportCanvas');
  cv.width = res.w; cv.height = res.h;
  const ctx = cv.getContext('2d');
  ctx.putImageData(new ImageData(res.rgba, res.w, res.h), 0, 0);
  if ($('showBoxes').checked) paintBoxes(ctx, res.w, res.boxes);
  paintIssues(ctx, res.w, res.issues, sel);
  return cv;
}

function showReport(res, learned) {
  current = res;
  show('report', false);
  const t = state.target;
  $('forLine').innerHTML = '';
  if (t) {
    const it = t.item;
    $('forLine').textContent = `For: ${t.customer.name} – ${it.name} · ${new Date().toLocaleDateString()} · next check about ${new Date(C.addMonths(Date.now(), it.months || C.DEFAULT_MONTHS)).toLocaleDateString()}`;
  }
  stack.length = 0; stack.push('home');
  const q = res.quality || { warnings: [] };
  $('qualityBox').innerHTML = '';
  for (const w of q.warnings) {
    const d = document.createElement('div');
    d.className = `note ${w.kind === 'notext' || w.kind === 'print' ? 'bad' : 'warn'}`;
    d.textContent = `${w.kind === 'print' ? '🖨' : '⚠'} ${w.note}`;
    $('qualityBox').appendChild(d);
  }
  const cmp = state.compare;
  $('cmpBtn').hidden = !cmp;
  if (cmp) $('cmpBtn').textContent = cmp.result.ok
    ? `🔍 Before / after: ${cmp.result.changes.length ? `${cmp.result.changes.length} letter${cmp.result.changes.length > 1 ? 's' : ''} changed` : 'no clear change'} since ${new Date(cmp.prev.date).toLocaleDateString()}`
    : `🔍 Before / after (${new Date(cmp.prev.date).toLocaleDateString()})`;
  if (!res.ok) { $('summary').innerHTML = ''; $('issueList').innerHTML = ''; setZoom(1); return; }
  const s = res.stats;
  const cell = (n, label, bad) => `<div class="${bad && n ? 'bad' : ''}"><b>${n}</b>${label}</div>`;
  $('summary').innerHTML = [
    cell(`${s.matched}/${s.expected}`, 'letters matched'), cell(res.issues.length, 'places to check', true),
    cell(s.missing, 'missing?', true), cell(s.extra, 'extra?', true), cell(s.touching, 'touching?', true), cell(s.broken, 'broken?', true),
  ].join('') + `<div><b>${learned.sure}</b>learned (+${learned.unsure} to review)</div>`;
  const list = $('issueList');
  list.innerHTML = '';
  if (!res.issues.length) list.innerHTML = '<li>No places were marked. The sofer should still check the whole mezuzah.</li>';
  res.issues.forEach((is, k) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${k + 1}</span><span></span>`;
    li.lastChild.textContent = is.note;
    li.onclick = () => focusIssue(k);
    list.appendChild(li);
  });
  setZoom(1);
}

function setZoom(z) {
  zoom = Math.max(1, Math.min(8, z));
  $('reportCanvas').style.width = `${zoom * 100}%`;
  $('zoomLbl').textContent = `${Math.round(zoom * 100)}%`;
}
$('zoomIn').onclick = () => setZoom(zoom * 1.5);
$('zoomOut').onclick = () => setZoom(zoom / 1.5);
$('showBoxes').onchange = () => current && drawReport(current);
$('reportCanvas').addEventListener('dblclick', (e) => {
  const r = e.target.getBoundingClientRect(); const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  setZoom(zoom >= 4 ? 1 : zoom * 2); centerOn(fx, fy);
});
function centerOn(fx, fy) {
  const wrap = $('canvasWrap'), cv = $('reportCanvas');
  wrap.scrollLeft = fx * cv.clientWidth - wrap.clientWidth / 2;
  wrap.scrollTop = fy * cv.clientHeight - wrap.clientHeight / 2;
}
function focusIssue(k) {
  const is = current.issues[k];
  drawReport(current, k);
  for (const [i, li] of [...$('issueList').children].entries()) li.classList.toggle('sel', i === k);
  setZoom(Math.max(zoom, 3));
  centerOn(is.x / current.w, is.y / current.h);
  $('canvasWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showLearned(res, learned) {
  show('learned', false);
  stack.length = 0; stack.push('home');
  const q = (res.quality && res.quality.warnings) || [];
  $('learnSummary').innerHTML = (res.ok
    ? `<p><b>${learned.sure}</b> letters were matched to the text with high certainty and added to the library.</p>
       <p><b>${learned.unsure}</b> letters were not certain and wait in the review list.</p>`
    : '<p>No letters could be read from this photo.</p>')
    + q.map((w) => `<div class="note warn">⚠ ${w.note}</div>`).join('');
}

// ---------- review ----------
let reviewItems = [], reviewSel = null, reviewLimit = 120;
function drawCrop(canvas, view) {
  const n = Math.round(Math.sqrt(view.length));
  canvas.width = n; canvas.height = n;
  const ctx = canvas.getContext('2d'); const im = ctx.createImageData(n, n);
  for (let i = 0; i < view.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = view[i]; im.data[i * 4 + 3] = 255; }
  ctx.putImageData(im, 0, 0);
}
async function openReview() {
  reviewItems = await db.all('review', reviewLimit);
  const grid = $('reviewGrid'); grid.innerHTML = '';
  $('reviewPanel').hidden = true; reviewSel = null;
  if (!reviewItems.length) grid.innerHTML = '<p class="small">Nothing to review. 👍</p>';
  for (const it of reviewItems) {
    const cell = document.createElement('div'); cell.className = 'cell';
    const cv = document.createElement('canvas'); drawCrop(cv, it.view); cell.appendChild(cv);
    const g = document.createElement('span'); g.className = 'guess'; g.textContent = it.guess || '?'; cell.appendChild(g);
    cell.onclick = () => selectReview(it, cell);
    grid.appendChild(cell);
  }
  $('reviewMore').hidden = reviewItems.length < reviewLimit;
}
$('reviewMore').onclick = () => { reviewLimit += 120; openReview(); };
function selectReview(it, cell) {
  reviewSel = { it, cell };
  for (const c of document.querySelectorAll('.review-grid .cell')) c.classList.toggle('sel', c === cell);
  drawCrop($('reviewBig'), it.view);
  $('reviewGuess').textContent = it.guess ? `${it.guess} (${LETTER_NAMES[it.guess]})` : 'unknown';
  $('reviewYesL').textContent = it.guess || '';
  $('reviewYes').hidden = !it.guess;
  $('reviewPanel').hidden = false;
}
async function decide(label) {
  if (!reviewSel) return;
  const { it, cell } = reviewSel;
  const sample = await resolveReview(it, label);
  if (sample) { await queueSamples([sample]); clearTimeout(decide.t); decide.t = setTimeout(runSync, 5000); }
  const next = cell.nextElementSibling;
  cell.remove();
  reviewItems = reviewItems.filter((x) => x !== it);
  const nextItem = next && reviewItems.find((x, i) => $('reviewGrid').children[i] === next);
  if (next && nextItem) selectReview(nextItem, next); else { $('reviewPanel').hidden = true; reviewSel = null; }
}
$('reviewYes').onclick = () => decide(reviewSel && reviewSel.it.guess);
$('reviewNot').onclick = () => decide(null);
for (const L of LETTERS) {
  const b = document.createElement('button'); b.textContent = L; b.title = LETTER_NAMES[L];
  b.onclick = () => decide(L);
  $('letterKeys').appendChild(b);
}

// ---------- library & model ----------
async function openLibrary() {
  const counts = await db.labelCounts();
  $('libCounts').innerHTML = LETTERS.map((L) => `<div class="${(counts[L] || 0) < 20 ? 'low' : ''}"><b>${L}</b>${counts[L] || 0}</div>`).join('');
  let info = 'No model loaded. The app still works using letter shapes and the known text. Train a model on your PC (or here) to make it better.';
  if (state.modelJson) {
    try {
      const m = JSON.parse(state.modelJson).meta || {};
      info = `Model loaded. Trained ${m.trained ? new Date(m.trained).toLocaleString() : '?'} on ${m.realSamples ?? '?'} real + ${m.synthSamples ?? '?'} font letters, ${m.valAcc ? `${(m.valAcc * 100).toFixed(1)}% correct on ${m.valFromReal ? 'real' : 'font'} test letters` : ''}. `
        + (modelTrusted({ meta: m }) ? 'It is used in checks.' : `It is NOT used in checks until it is trained on at least ${MIN_REAL} real letters (a font-only AI makes many mistakes on real handwriting).`);
    } catch { /* ignore */ }
  }
  $('modelInfo').textContent = info;
  $('sens').value = state.sens; $('sensLbl').textContent = state.sens;
  const ss = await getSettings();
  $('pairCode').value = ss.code; $('pcUrl').value = ss.url;
  const biz = (await db.get('business')) || {};
  $('bizName').value = biz.name || ''; $('bizSofer').value = biz.sofer || ''; $('bizPhone').value = biz.phone || ''; $('bizAddress').value = biz.address || ''; $('bizExtra').value = biz.extra || '';
  showSyncStatus();
}
$('syncSave').onclick = async () => {
  await saveSettings({ code: $('pairCode').value.trim().toUpperCase(), url: $('pcUrl').value.trim() });
  $('syncInfo').textContent = 'Connecting…';
  const r = await runSync();
  if (r.state === 'ok') $('syncInfo').textContent = `Connected to the PC ✓${r.newModel ? ' – new AI received' : ''}`;
  openLibrary();
};
$('sens').oninput = async (e) => { state.sens = Number(e.target.value); $('sensLbl').textContent = state.sens; await db.set('sens', state.sens); };
$('exportLib').onclick = async () => {
  const text = await exportLibrary();
  const name = `mezuzah-library-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* fall back to download */ }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('loadModel').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const text = await f.text();
  try { deserializeModel(text); } catch (err) { alert(err.message); return; }
  state.modelJson = text; await db.set('model', text);
  alert('Model loaded. It will be used from the next check.');
  openLibrary();
};
$('removeModel').onclick = async () => { if (!confirm('Remove the AI model from this phone?')) return; state.modelJson = null; await db.set('model', null); openLibrary(); };
$('clearLib').onclick = async () => { if (!confirm('Delete ALL letters in the library? This cannot be undone.')) return; await db.clear('samples'); openLibrary(); };
$('clearReview').onclick = async () => { if (!confirm('Delete all letters waiting for review?')) return; await db.clear('review'); openLibrary(); };

// ---------- reference text ----------
function refStatsText() {
  const s = referenceStats($('refText').value);
  const ok = s.letters === 713 && s.words === 170;
  $('refStats').innerHTML = `${s.letters} letters, ${s.words} words ${ok ? '✓ (713 / 170 as expected)' : '<b style="color:var(--red)">— expected 713 letters and 170 words</b>'}${s.invalid.length ? `<br><b style="color:var(--red)">Not allowed characters: ${s.invalid.join(' ')}</b>` : ''}`;
}
function openReference() { $('refText').value = state.refText.trim(); refStatsText(); }
$('refText').oninput = refStatsText;
$('refReset').onclick = () => { $('refText').value = MEZUZAH_TEXT.trim(); refStatsText(); };
$('refConfirm').onclick = async () => {
  const s = referenceStats($('refText').value);
  if (s.invalid.length) { alert('Please remove the characters that are not letters: ' + s.invalid.join(' ')); return; }
  if ((s.letters !== 713 || s.words !== 170) && !confirm(`The text has ${s.letters} letters and ${s.words} words (expected 713 and 170). Save anyway?`)) return;
  state.refText = $('refText').value; state.refConfirmed = true;
  await db.set('refText', state.refText); await db.set('refConfirmed', true);
  show('home', false); stack.length = 0;
};

// ---------- history ----------
async function openHistory() {
  const scans = (await db.all('scans')).reverse();
  const ul = $('historyList'); ul.innerHTML = ''; $('historyImg').hidden = true;
  if (!scans.length) ul.innerHTML = '<li class="small">No mezuzot checked yet.</li>';
  for (const s of scans) {
    const li = document.createElement('li');
    const st = s.stats;
    li.textContent = `${new Date(s.date).toLocaleString()} — ${s.customerName ? `${s.customerName} – ${s.itemName}` : s.mode === 'learn' ? 'learn' : 'check'} — ${st ? `${st.matched}/${st.expected} letters, ${s.issues.length} places to check` : 'no letters found'}`;
    li.onclick = async () => {
      const cv = $('historyImg');
      if (s.photo) {
        const bmp = await createImageBitmap(s.photo);
        cv.width = bmp.width; cv.height = bmp.height;
        const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
        paintIssues(ctx, bmp.width, s.issues);
      } else if (s.image) { // checks saved by the first version
        const bmp = await createImageBitmap(s.image);
        cv.width = bmp.width; cv.height = bmp.height; cv.getContext('2d').drawImage(bmp, 0, 0);
      }
      cv.hidden = false; cv.scrollIntoView({ behavior: 'smooth' });
    };
    ul.appendChild(li);
  }
}

// for automatic testing only (open index.html?dev)
if (location.search.includes('dev')) window.__checkImage = (img, mode = 'check') => { state.mode = mode; if (mode !== 'check') state.target = null; return process(img); };

init();
