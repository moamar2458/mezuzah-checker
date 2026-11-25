// Main screen logic of the phone app.
import * as db from './db.js';
import { Camera } from './camera.js';
import { MEZUZAH_TEXT, referenceStats, LETTERS, LETTER_NAMES } from './reference.js';
import { addScanLetters, resolveReview, exportLibrary, saveSpot, getSpots, allSpotRecords } from './library.js';
import { prepareMemory } from './spots.js';
import { deserializeModel } from './nn.js';
import { modelTrusted, MIN_REAL } from './pipeline.js';
import { sortIssues, paintIssues, paintBoxes } from './report.js';
import { getSettings, saveSettings, queueScan, queueSamples, queueRecords, syncNow, newUid } from './sync.js';
import * as C from './customers.js';
import { compareScans } from './compare.js';
import { printedCheck } from './fraud.js';
import { VERDICTS, certificateHTML, CERT_CSS, printCertificate, checkSummaryText } from './certificate.js';
import { queueResult, queueMarks, pcRequest } from './sync.js';
import { parseReference } from './reference.js';
import { b64ToU8 } from './library.js';
import { T, dateStr, dateTimeStr, translatePage, getLang } from './i18n.js';
import { HE_APP } from './lang-he.js';
translatePage(HE_APP);

const $ = (id) => document.getElementById(id);
const ANALYSIS_MAX = 3200; // longest side of the picture used for checking
const TITLES = {
  home: T('Mezuzah Checker', 'בודק מזוזות'), camera: T('Take a photo', 'צילום'), busy: T('Checking…', 'בודק…'), report: T('Places to check', 'מקומות לבדיקה'),
  learned: T('Learned', 'נלמד'), review: T('Review unsure letters', 'אותיות לבדיקה'), library: T('Library & AI', 'ספרייה ובינה'), reference: T('Reference text', 'נוסח המזוזה'), history: T('History', 'היסטוריה'),
  who: T('Who is this check for?', 'עבור מי הבדיקה?'), customers: T('Customers & reminders', 'לקוחות ותזכורות'), customer: T('Customer', 'לקוח'), compare: T('Before / after', 'לפני / אחרי'), cert: T('Result & certificate', 'תוצאה ותעודה'),
};

let state = { mode: 'check', refText: MEZUZAH_TEXT, refConfirmed: false, modelJson: null, sens: 0.15, target: null };
let camera = null;
// opened on the PC itself (the PC program serves the app at http://localhost:8080/)
const ON_PC = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const DESKTOP = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;
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
  if (ON_PC) {
    // the PC screen and this app share the pairing code, so a check made on the PC goes straight into the PC program
    const s = await getSettings();
    let code = ''; try { code = localStorage.getItem('pairCode') || ''; } catch { /* private mode */ }
    if (!s.code && code) await saveSettings({ code, url: '' });
  }
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
  $('newCustBtn').textContent = T(`+ New customer: ${q}`, `+ לקוח חדש: ${q}`);
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
  $('itemTitle').textContent = T(`Which mezuzah of ${c.name}?`, `איזו מזוזה של ${c.name}?`);
  const items = await C.itemsOf(c.uid);
  const ul = $('itemPick'); ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="sub"></span>';
    li.firstChild.textContent = it.name;
    li.lastChild.textContent = it.lastCheck ? T(`last ${dateStr(it.lastCheck)}`, `נבדקה ${dateStr(it.lastCheck)}`) : T('not checked yet', 'עוד לא נבדקה');
    li.onclick = () => { state.target = { customer: c, item: it }; for (const x of ul.children) x.classList.toggle('sel', x === li); $('whoGo').hidden = false; };
    ul.appendChild(li);
  }
  if (items.length === 1) ul.firstChild.click();
  if (!items.length) $('newItemName').value = T('Front door', 'דלת כניסה');
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
    box.innerHTML = `<h2>${T('Due for a check', 'הגיע זמן בדיקה')}</h2><ul class="pick-list" id="dueUl"></ul><button id="dueCal" class="big">📅 ${T('Add these reminders to my calendar', 'הוסף את התזכורות ליומן')}</button>`;
    for (const d of due) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><span class="sub"></span>';
      li.firstChild.textContent = `${d.customer.name} – ${d.item.name}`;
      li.lastChild.textContent = `${d.state === 'overdue' ? T('overdue since', 'באיחור מאז') : T('due', 'מועד')} ${dateStr(d.due)}`;
      li.lastChild.className = `sub due-${d.state}`;
      li.onclick = () => openCustomer(d.customer.uid);
      $('dueUl').appendChild(li);
    }
    $('dueCal').onclick = () => downloadCalendar(due, 'mezuzah-checks-due');
  } else box.innerHTML = `<p class="small">${T('Nothing is due in the next 30 days.', 'אין בדיקות ב־30 הימים הקרובים.')}</p>`;
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
    li.lastChild.textContent = `${T(`${items.length} mezuz${items.length === 1 ? 'ah' : 'ot'}`, items.length === 1 ? 'מזוזה אחת' : `${items.length} מזוזות`)}${dues.length ? ` · ${T('next', 'הבאה')} ${dateStr(dues[0])}` : ''}`;
    li.onclick = () => openCustomer(c.uid);
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = `<li class="small">${T('No customers yet. They are added when you start a check.', 'אין עדיין לקוחות. הם נוספים כשמתחילים בדיקה.')}</li>`;
}
$('custFilter').oninput = fillCustList;
$('addCustBtn').onclick = async () => {
  const name = prompt(T('Customer name', 'שם הלקוח')); if (!name || !name.trim()) return;
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
  if (!items.length) box.innerHTML = `<p class="small">${T('No mezuzot yet.', 'אין עדיין מזוזות.')}</p>`;
  for (const it of items) {
    const due = C.nextDue(it), st = C.dueState(it);
    const card = document.createElement('div'); card.className = 'item-card';
    card.innerHTML = `<b></b><div class="small last"></div><div class="small due"></div>
      <div class="row"><label class="small">${T('Check every', 'בדיקה כל')} <input type="number" min="1" max="120" class="months"> ${T('months', 'חודשים')}</label></div>
      <div class="row"><button class="primary go">📷 ${T('Check now', 'בדוק עכשיו')}</button><button class="cal">📅 ${T('Reminder', 'תזכורת')}</button><button class="del danger">${T('Remove', 'הסר')}</button></div>`;
    card.querySelector('b').textContent = it.name;
    card.querySelector('.last').textContent = it.lastCheck ? `${T('Last checked', 'נבדקה לאחרונה')} ${dateStr(it.lastCheck)}` : T('Not checked yet', 'עוד לא נבדקה');
    const dueEl = card.querySelector('.due');
    dueEl.textContent = due ? `${st === 'overdue' ? T('Overdue since', 'באיחור מאז') : T('Next check', 'הבדיקה הבאה')} ${dateStr(due)}` : '';
    dueEl.className = `small due due-${st}`;
    const mi = card.querySelector('.months'); mi.value = it.months || C.DEFAULT_MONTHS;
    mi.onchange = async () => { const r = await C.saveItem({ ...it, months: mi.value }); await queueRecords([], [r]); openCustomer(cuid); };
    card.querySelector('.go').onclick = () => { state.target = { customer: curCust, item: it }; startCapture('check', true); };
    card.querySelector('.cal').disabled = !due;
    card.querySelector('.cal').onclick = () => downloadCalendar([{ item: it, customer: curCust, due }], `mezuzah-${curCust.name}-${it.name}`);
    card.querySelector('.del').onclick = async () => { if (!confirm(T(`Remove "${it.name}"?`, `להסיר את "${it.name}"?`))) return; const r = await C.saveItem({ ...it, deleted: true }); await queueRecords([], [r]); openCustomer(cuid); };
    box.appendChild(card);
  }
}
$('cSave').onclick = async () => {
  if (!$('cName').value.trim()) { alert(T('Please enter a name.', 'נא להזין שם.')); return; }
  curCust = await C.saveCustomer({ ...curCust, name: $('cName').value, phone: $('cPhone').value, address: $('cAddress').value, notes: $('cNotes').value });
  await queueRecords([curCust], []); runSync();
  $('title').textContent = curCust.name;
};
$('cDelete').onclick = async () => {
  if (!confirm(T(`Delete ${curCust.name}? Their past checks stay in the history.`, `למחוק את ${curCust.name}? הבדיקות הקודמות נשארות בהיסטוריה.`))) return;
  const c = await C.saveCustomer({ ...curCust, deleted: true }); await queueRecords([c], []); runSync();
  show('customers', false);
};
$('cAddItem').onclick = async () => {
  if (!$('cNewItem').value.trim()) return;
  const it = await C.saveItem({ customerUid: curCust.uid, name: $('cNewItem').value });
  await queueRecords([], [it]); $('cNewItem').value = ''; openCustomer(curCust.uid);
};

// ---------- PC sync ----------
// places the sofer marked on letters, ready for the checker (rebuilt when marks change)
let spotMem = null;
async function spotMemory() {
  if (!spotMem) { try { spotMem = prepareMemory(await allSpotRecords()); } catch { spotMem = []; } }
  return spotMem;
}
const spotsChanged = () => { spotMem = null; };

async function runSync() {
  const r = await syncNow();
  if (r.spotsChanged) spotsChanged();
  if (r.modelJson) state.modelJson = r.modelJson;
  if (r.recordsChanged && !$('home').hidden) refreshHome();
  showSyncStatus();
  return r;
}
async function syncText() {
  const s = await getSettings();
  const st = (await db.get('syncStatus')) || {};
  const waiting = await db.count('outbox');
  if (!s.code) return T('PC sync is off (Library & AI → PC sync).', 'הסנכרון עם המחשב כבוי (ספרייה ובינה ← סנכרון עם המחשב).');
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? T('just now', 'עכשיו') : m < 60 ? T(`${m} min ago`, `לפני ${m} דק׳`) : T(`${Math.round(m / 60)} h ago`, `לפני ${Math.round(m / 60)} שע׳`); };
  const last = await db.get('lastSync');
  let txt = st.state === 'ok' ? `${T('PC: synced', 'מחשב: סונכרן')} ${ago(st.at)}${s.role === 'helper' ? T(' (helper: only letters are shared)', ' (עוזר: רק אותיות משותפות)') : ''}` : st.state === 'error' ? `${T('PC', 'מחשב')}: ${st.message}` : `${T('PC: not reachable now', 'מחשב: לא זמין כרגע')}${last ? ` (${T('last sync', 'סנכרון אחרון')} ${ago(last)})` : ''}`;
  if (waiting) txt += T(` · ${waiting} waiting to send`, ` · ${waiting} ממתינים לשליחה`);
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
  let model = T('No AI model yet: checks use the known text and letter shapes.', 'אין עדיין מודל בינה: הבדיקות משתמשות בנוסח הידוע ובצורות האותיות.');
  if (state.modelJson) {
    try {
      const m = JSON.parse(state.modelJson).meta || {};
      model = modelTrusted({ meta: m })
        ? T(`AI in use (trained ${m.trained ? dateStr(m.trained) : '?'} on ${m.realSamples} real letters, ${(m.valAcc * 100).toFixed(1)}% correct on real letters).`, `הבינה בשימוש (אומנה ${m.trained ? dateStr(m.trained) : '?'} על ${m.realSamples} אותיות אמיתיות, ${(m.valAcc * 100).toFixed(1)}% נכון על אותיות אמיתיות).`)
        : T(`AI loaded but NOT used yet: it learned from ${m.realSamples || 0} real letters, needs ${MIN_REAL}.`, `הבינה נטענה אבל עוד לא בשימוש: למדה מ־${m.realSamples || 0} אותיות אמיתיות, צריכה ${MIN_REAL}.`);
    } catch { /* ignore */ }
  }
  const due = await C.dueList();
  const over = due.filter((d) => d.state === 'overdue').length;
  $('dueCount').textContent = due.length; $('dueCount').hidden = !due.length;
  $('dueBanner').hidden = !due.length;
  $('dueBanner').textContent = due.length ? `🔔 ${T(`${due.length} mezuzah check${due.length > 1 ? 's are' : ' is'} due${over ? ` (${over} overdue)` : ' soon'}`, `${due.length} בדיקות מזוזה ${over ? `(${over} באיחור)` : 'בקרוב'}`)}: ${due.slice(0, 3).map((d) => d.customer.name).join(', ')}${due.length > 3 ? '…' : ''}` : '';
  $('dueBanner').onclick = () => show('customers');
  $('pcLink').hidden = location.hostname === 'moamar2458.github.io';
  $('homeStatus').innerHTML = `${T(`Library: <b>${nSamples}</b> sure letters · <b>${nReview}</b> to review · <b>${nScans}</b> mezuzot checked`, `ספרייה: <b>${nSamples}</b> אותיות בטוחות · <b>${nReview}</b> לבדיקה · <b>${nScans}</b> מזוזות נבדקו`)}<br>${model}<br><span id="syncLine"></span>`;
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
    if (!confirm(T('The reference text has not been confirmed yet. Open it now?\n(Press Cancel to continue anyway.)', 'נוסח המזוזה עוד לא אושר. לפתוח אותו עכשיו?\n(לחץ ביטול כדי להמשיך בכל זאת.)'))) { /* continue */ } else { show('reference'); return; }
  }
  state.mode = mode;
  show('camera');
  $('title').textContent = mode === 'learn' ? T('Learn: take a photo', 'למידה: צלם') : T('Check: take a photo', 'בדיקה: צלם');
  $('noCam').hidden = true; $('camPick').hidden = true;
  const ss = await getSettings();
  $('scanBtn').hidden = $('scanBtn2').hidden = !(ss.code && ss.scan);
  const noCam = () => {
    $('noCam').hidden = false; document.querySelector('.cam-wrap').hidden = true; document.querySelector('.cam-buttons').hidden = true;
    if (DESKTOP) {
      $('noCamMsg').textContent = T('No camera was found on this computer (or it was not allowed). You can scan with the scanner, or choose a saved photo or PDF – or drag the file here:', 'לא נמצאה מצלמה במחשב הזה (או שלא ניתנה הרשאה). אפשר לסרוק מהסורק, או לבחור תמונה או PDF שמורים – או לגרור את הקובץ לכאן:');
      $('nativeCam').parentElement.hidden = true;
    }
  };
  if (!Camera.supported()) { noCam(); return; }
  document.querySelector('.cam-wrap').hidden = false; document.querySelector('.cam-buttons').hidden = false;
  camera = new Camera($('video'), camStatus);
  try { await camera.start(await db.get('camDevice')); fillCamPick(); } catch (err) { camera = null; noCam(); }
}

// a PC can have more than one camera (built-in and an external USB camera): let the sofer choose, and remember it
async function fillCamPick() {
  const list = await Camera.list();
  const sel = $('camPick');
  if (list.length < 2 || !camera) { sel.hidden = true; return; }
  sel.innerHTML = '';
  list.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = `📷 ${d.label || `${T('Camera', 'מצלמה')} ${i + 1}`}`; sel.appendChild(o); });
  sel.value = camera.deviceId || list[0].deviceId;
  sel.hidden = false;
}
$('camPick').onchange = async (e) => {
  const id = e.target.value;
  await db.set('camDevice', id);
  if (!camera) return;
  camera.stop();
  camera = new Camera($('video'), camStatus);
  try { await camera.start(id); } catch (err) { alert(T('This camera could not be opened: ', 'לא ניתן לפתוח את המצלמה הזו: ') + err.message); }
};
function stopCamera() { if (camera) { camera.stop(); camera = null; } }

function camStatus(s) {
  const set = (el, ok, txt) => { el.className = `chip ${ok === null ? '' : ok ? 'ok' : 'bad'}`; el.textContent = txt; };
  set($('stLight'), s.light === 'ok', s.light === 'dark' ? T('Too dark', 'חשוך מדי') : s.light === 'glare' ? T('Glare', 'ברק') : T('Light ✓', 'תאורה ✓'));
  set($('stSharp'), s.sharp === 'ok', s.sharp === 'ok' ? T('Sharp ✓', 'חד ✓') : T('Blurry', 'מטושטש'));
  set($('stLevel'), s.level === 'unknown' ? null : s.level === 'ok', s.level === 'unknown' ? T('Level ?', 'ישר ?') : s.level === 'ok' ? T('Level ✓', 'ישר ✓') : T(`Tilted ${Math.round(s.tiltDeg)}°`, `נטוי ${Math.round(s.tiltDeg)}°`));
  const tips = [];
  if (s.light === 'dark') tips.push(T('Add more light.', 'הוסף אור.'));
  if (s.light === 'glare') tips.push(T('Move the light to avoid shine on the klaf.', 'הזז את האור כדי שלא יהיה ברק על הקלף.'));
  if (s.sharp !== 'ok') tips.push(T('Hold still, tap the screen to focus.', 'החזק יציב, גע במסך למיקוד.'));
  if (s.level === 'tilted') tips.push(T('Hold the phone flat, straight above the klaf.', 'החזק את הטלפון שטוח, ישר מעל הקלף.'));
  $('camTip').textContent = tips.join(' ') || T('Looks good — take the photo.', 'נראה טוב — צלם.');
}
let torchOn = false;
$('torchBtn').onclick = async () => { torchOn = !torchOn; if (camera && !(await camera.torch(torchOn))) { torchOn = false; alert(T('This phone does not allow the light to be turned on from the app.', 'הטלפון הזה לא מאפשר להדליק את הפנס מהאפליקציה.')); } };
$('shootBtn').onclick = async () => {
  if (!camera) return;
  const img = await camera.capture();
  stopCamera();
  process(img);
};
for (const id of ['pickFile', 'pickFile2', 'nativeCam']) {
  $(id).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) openFile(f, id !== 'nativeCam');
  };
}

/** A saved photo, a scanned picture or a PDF (its first page; the PC program turns it into a picture). */
async function openFile(f, crop = true) {
  stopCamera();
  let img;
  try {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const s = await getSettings();
      if (!s.code || !s.pdf) { alert(T('PDF files are opened by the PC program. Connect to the PC (Library & AI → PC sync), or save the page as a JPG or PNG picture.', 'קבצי PDF נפתחים בעזרת תוכנת המחשב. התחבר למחשב (ספרייה ובינה ← סנכרון עם המחשב), או שמור את הדף כתמונת JPG או PNG.')); startCapture(state.mode, true); return; }
      show('busy', false);
      $('busyMsg').textContent = T('Opening the PDF (first page)…', 'פותח את קובץ ה-PDF (עמוד ראשון)…');
      const res = await pcRequest('/api/pdf', { method: 'POST', body: f, headers: { 'Content-Type': 'application/pdf' }, timeout: 180000 });
      img = await createImageBitmap(await res.blob());
    } else {
      img = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
    }
  } catch (err) {
    alert(T('This file could not be opened. Use a JPG, PNG or PDF file.\n', 'לא ניתן לפתוח את הקובץ. השתמש בקובץ JPG, PNG או PDF.\n') + (err && err.message ? err.message : ''));
    startCapture(state.mode, true); return;
  }
  process(crop ? cropToKlaf(img) : img);
}

/**
 * A scan (or a saved scan) shows the whole scanner glass: cut away the white around the klaf,
 * so the letters keep their full detail. Photos without a white border stay as they are.
 */
function cropToKlaf(img) {
  const W = img.width, H = img.height, k = Math.min(1, 700 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h), hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) { const v = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) | 0; g[i] = v; hist[v]++; }
  let acc = 0, white = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= w * h * 0.1) { white = v; break; } }
  if (white < 170) return img; // no white glass / lid around it
  const bx = Math.round(w * 0.015), by = Math.round(h * 0.015); // ignore the dark edge of the scanner glass
  const rows = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = by; y < h - by; y++) for (let x = bx; x < w - bx; x++) {
    const i = y * w + x;
    if (g[i] < white - 22 || d[i * 4] - d[i * 4 + 2] > 22) { rows[y]++; cols[x]++; } // darker than the lid, or the yellow of the klaf
  }
  const span = (arr, n, other) => { let a = -1, b = -1; for (let i = 0; i < n; i++) if (arr[i] > other * 0.04) { if (a < 0) a = i; b = i; } return [a, b]; };
  const [y0, y1] = span(rows, h, w), [x0, x1] = span(cols, w, h);
  if (y0 < 0 || x0 < 0) return img;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw * bh > w * h * 0.85 || bw * bh < w * h * 0.02) return img;
  const m = 0.03 * Math.max(bw, bh);
  const X0 = Math.max(0, (x0 - m) / k), Y0 = Math.max(0, (y0 - m) / k), X1 = Math.min(W, (x1 + 1 + m) / k), Y1 = Math.min(H, (y1 + 1 + m) / k);
  const out = document.createElement('canvas'); out.width = Math.round(X1 - X0); out.height = Math.round(Y1 - Y0);
  out.getContext('2d').drawImage(img, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, out.width, out.height);
  return out;
}

// drag a saved photo / scan / PDF onto the camera screen (on the PC)
const dragFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', (e) => { if (!dragFiles(e)) return; e.preventDefault(); if (!$('camera').hidden) document.body.classList.add('drop-on'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop-on'); });
document.addEventListener('drop', (e) => {
  if (!dragFiles(e)) return;
  e.preventDefault(); document.body.classList.remove('drop-on');
  const f = e.dataTransfer.files[0];
  if (f && !$('camera').hidden) openFile(f);
});

// ---------- the scanner connected to the PC ----------
for (const id of ['scanBtn', 'scanBtn2']) $(id).onclick = () => openScanner();
$('scanClose').onclick = () => { $('scanBox').hidden = true; };
$('scanFind').onclick = () => findScanners(true);
async function openScanner() {
  $('scanBox').hidden = false;
  $('scanDpi').value = String((await db.get('scanDpi')) || 600);
  if (!$('scanDev').options.length) await findScanners();
}
async function findScanners() {
  const sel = $('scanDev'); sel.innerHTML = ''; $('scanGo').disabled = true;
  $('scanMsg').textContent = T('Looking for scanners…', 'מחפש סורקים…');
  try {
    const r = await (await pcRequest('/api/scanners', { timeout: 60000 })).json();
    if (!r.ok) throw new Error(r.error === 'no-sane' ? T('The scanner program (SANE) is not installed on the PC.', 'תוכנת הסורק (SANE) אינה מותקנת במחשב.') : r.error);
    if (!r.list.length) { $('scanMsg').textContent = T('No scanner was found. Check that it is on and connected (USB, or the same network), then press "Look for scanners again".', 'לא נמצא סורק. בדוק שהוא דלוק ומחובר (USB או אותה רשת), ולחץ "חפש סורקים שוב".'); return; }
    const last = await db.get('scanDevice');
    for (const d of r.list) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; sel.appendChild(o); }
    if (last && r.list.some((d) => d.id === last)) sel.value = last;
    $('scanGo').disabled = false; $('scanMsg').textContent = '';
  } catch (e) { $('scanMsg').textContent = e.message; }
}
$('scanGo').onclick = async () => {
  const device = $('scanDev').value, dpi = Number($('scanDpi').value);
  await db.set('scanDevice', device); await db.set('scanDpi', dpi);
  $('scanGo').disabled = true;
  $('scanMsg').textContent = T('Scanning… (this can take a minute)', 'סורק… (זה יכול לקחת דקה)');
  try {
    const res = await pcRequest('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, dpi }), timeout: 300000 });
    const img = await createImageBitmap(await res.blob());
    $('scanBox').hidden = true; $('scanMsg').textContent = '';
    stopCamera();
    process(cropToKlaf(img));
  } catch (e) { $('scanMsg').textContent = T('Scanning failed: ', 'הסריקה נכשלה: ') + e.message; }
  finally { $('scanGo').disabled = false; }
};

// ---------- running the check ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0; const jobs = new Map();
worker.onmessage = (e) => { const j = jobs.get(e.data.id); if (j) { jobs.delete(e.data.id); e.data.ok ? j.resolve(e.data.res) : j.reject(new Error(e.data.error)); } };
const runJob = (msg, transfer) => new Promise((resolve, reject) => { const id = ++jobId; jobs.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer); });

async function process(img) {
  show('busy', false);
  $('busyMsg').textContent = state.mode === 'learn' ? T('Finding and learning the letters…', 'מחפש ולומד את האותיות…') : T('Finding the letters and comparing with the text…', 'מחפש את האותיות ומשווה לנוסח…');
  const iw = img.width, ih = img.height;
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const c = $('work'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let res;
  try {
    res = await runJob({ rgba: data.buffer, w, h, refText: state.refText, modelJson: state.modelJson, sens: state.sens, lang: getLang(), spots: await spotMemory() }, [data.buffer]);
  } catch (err) {
    alert(T('Something went wrong while checking:\n', 'משהו השתבש בבדיקה:\n') + err.message);
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
  l.querySelector('b').textContent = v.he; l.querySelector('.small').textContent = T(v.en, '');
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
  $('certFor').textContent = `${scan.customerName ? `${scan.customerName} – ${scan.itemName}` : T('No customer', 'בלי לקוח')} · ${dateStr(scan.date)}`;
  for (const r of document.querySelectorAll('input[name=verdict]')) r.checked = !!(scan.result && scan.result.verdict === r.value);
  $('certNotes').value = (scan.result && scan.result.notes) || '';
  $('certMsg').textContent = scan.result ? `${T('Saved', 'נשמר')} ${dateTimeStr(scan.result.date)}` : '';
  certPreview();
}
$('certBtn').onclick = openCert;
async function saveResult() {
  const d = await certData();
  if (!d.verdict) { alert(T('Please choose the result first.', 'נא לבחור קודם את התוצאה.')); return false; }
  const scan = state.lastScan;
  scan.result = { verdict: d.verdict, notes: d.notes, date: Date.now(), business: d.business };
  await db.put('scans', scan);
  await queueResult(scan.uid, scan.result);
  runSync();
  $('certMsg').textContent = `${T('Saved', 'נשמר')} ${dateTimeStr(scan.result.date)}`;
  return true;
}
$('certSave').onclick = saveResult;
$('certPrint').onclick = async () => { if (!(await saveResult())) return; printCertificate(certificateHTML(await certData())); };

// Melechet Sofer (and any other app): share a ready text, or copy it.
$('certShare').onclick = async () => {
  const scan = state.lastScan, d = await certData();
  const text = checkSummaryText({ ...scan, result: scan.result || (d.verdict ? { verdict: d.verdict, notes: d.notes } : null), nextDate: d.nextDate, business: d.business });
  try {
    if (navigator.share) { await navigator.share({ title: T('Mezuzah check', 'בדיקת מזוזה'), text }); $('certMsg').textContent = T('Shared.', 'שותף.'); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); $('certMsg').textContent = T('Copied – paste it into the customer card in Melechet Sofer.', 'הועתק – הדבק בכרטיס הלקוח במלאכת סופר.'); }
  catch { prompt(T('Copy this text:', 'העתק את הטקסט:'), text); }
};

$('bizSave').onclick = async () => {
  await db.set('business', { name: $('bizName').value.trim(), sofer: $('bizSofer').value.trim(), phone: $('bizPhone').value.trim(), address: $('bizAddress').value.trim(), extra: $('bizExtra').value.trim() });
  $('bizSave').textContent = T('Saved ✓', 'נשמר ✓'); setTimeout(() => { $('bizSave').textContent = T('Save business details', 'שמור פרטי עסק'); }, 1500);
};

// ---------- before / after ----------
async function openCompare() {
  const cmp = state.compare; if (!cmp) return;
  show('compare');
  const { prev, cur, result } = cmp;
  $('cmpHead').textContent = T(`Last check ${dateStr(prev.date)} → this check ${dateStr(cur.date)}`, `בדיקה קודמת ${dateStr(prev.date)} ← בדיקה זו ${dateStr(cur.date)}`);
  const [pb, cb] = await Promise.all([createImageBitmap(prev.photo), createImageBitmap(cur.photo)]);
  const whole = (cv, bmp, scan) => { cv.width = bmp.width; cv.height = bmp.height; const x = cv.getContext('2d'); x.drawImage(bmp, 0, 0); paintIssues(x, bmp.width, scan.issues || []); };
  whole($('cmpOld'), pb, prev); whole($('cmpNew'), cb, cur);
  const list = $('cmpList'); list.innerHTML = '';
  if (!result.ok) { list.innerHTML = `<p class="small">${T('Too few letters were found in both photos to compare.', 'נמצאו מעט מדי אותיות בשתי התמונות כדי להשוות.')}</p>`; return; }
  if (!result.changes.length) list.innerHTML = `<p>${T(`No letter changed clearly since the last check (${result.common} letters compared). The sofer should still check the whole mezuzah.`, `אף אות לא השתנתה בבירור מאז הבדיקה הקודמת (הושוו ${result.common} אותיות). הסופר צריך בכל זאת לבדוק את כל המזוזה.`)}</p>`;
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
    a.title = T('before', 'לפני'); b.title = T('now', 'עכשיו');
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
    $('forLine').textContent = `${T('For', 'עבור')}: ${t.customer.name} – ${it.name} · ${dateStr(Date.now())} · ${T('next check about', 'הבדיקה הבאה בערך')} ${dateStr(C.addMonths(Date.now(), it.months || C.DEFAULT_MONTHS))}`;
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
    ? `🔍 ${T('Before / after', 'לפני / אחרי')}: ${cmp.result.changes.length ? T(`${cmp.result.changes.length} letter${cmp.result.changes.length > 1 ? 's' : ''} changed`, `${cmp.result.changes.length} אותיות השתנו`) : T('no clear change', 'אין שינוי ברור')} ${T('since', 'מאז')} ${dateStr(cmp.prev.date)}`
    : `🔍 ${T('Before / after', 'לפני / אחרי')} (${dateStr(cmp.prev.date)})`;
  if (!res.ok) { $('summary').innerHTML = ''; $('issueList').innerHTML = ''; setZoom(1); return; }
  const s = res.stats;
  const cell = (n, label, bad) => `<div class="${bad && n ? 'bad' : ''}"><b>${n}</b>${label}</div>`;
  $('summary').innerHTML = [
    cell(`${s.matched}/${s.expected}`, T('letters matched', 'אותיות הותאמו')), cell(res.issues.length, T('places to check', 'מקומות לבדיקה'), true),
    cell(s.missing, T('missing?', 'חסרות?'), true), cell(s.extra, T('extra?', 'עודפות?'), true), cell(s.touching, T('touching?', 'נוגעות?'), true), cell(s.broken, T('broken?', 'שבורות?'), true),
  ].join('') + `<div><b>${learned.sure}</b>${T(`learned (+${learned.unsure} to review)`, `נלמדו · ${learned.unsure} לבדיקה`)}</div>`;
  const list = $('issueList');
  list.innerHTML = '';
  if (!res.issues.length) list.innerHTML = `<li>${T('No places were marked. The sofer should still check the whole mezuzah.', 'לא סומנו מקומות. הסופר צריך בכל זאת לבדוק את כל המזוזה.')}</li>`;
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
    ? T(`<p><b>${learned.sure}</b> letters were matched to the text with high certainty and added to the library.</p>
       <p><b>${learned.unsure}</b> letters were not certain and wait in the review list.</p>`, `<p><b>${learned.sure}</b> אותיות הותאמו לנוסח בוודאות גבוהה ונוספו לספרייה.</p>
       <p><b>${learned.unsure}</b> אותיות לא היו ודאיות ומחכות ברשימת הבדיקה.</p>`)
    : `<p>${T('No letters could be read from this photo.', 'לא ניתן היה לקרוא אותיות מהתמונה הזאת.')}</p>`)
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
  if (!reviewItems.length) grid.innerHTML = `<p class="small">${T('Nothing to review. 👍', 'אין מה לבדוק. 👍')}</p>`;
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
  showMarkCount();
  $('reviewGuess').textContent = it.guess ? (getLang() === 'he' ? it.guess : `${it.guess} (${LETTER_NAMES[it.guess]})`) : T('unknown', 'לא ידוע');
  $('reviewYesL').textContent = it.guess || '';
  $('reviewYes').hidden = !it.guess;
  $('reviewPanel').hidden = false;
}
async function decide(label) {
  if (!reviewSel) return;
  const { it, cell } = reviewSel;
  if (!label && it.marks && it.marks.length && !confirm(T('This letter has marked places. They are kept only when the letter is confirmed. Remove it anyway?', 'באות הזאת יש מקומות מסומנים. הם נשמרים רק כשמאשרים את האות. להסיר בכל זאת?'))) return;
  const sample = await resolveReview(it, label);
  if (sample) {
    await queueSamples([sample]);
    if (sample.spot) { await queueMarks(sample.spot); spotsChanged(); }
    clearTimeout(decide.t); decide.t = setTimeout(runSync, 5000);
  }
  const next = cell.nextElementSibling;
  cell.remove();
  reviewItems = reviewItems.filter((x) => x !== it);
  const nextItem = next && reviewItems.find((x, i) => $('reviewGrid').children[i] === next);
  if (next && nextItem) selectReview(nextItem, next); else { $('reviewPanel').hidden = true; reviewSel = null; }
}
// ---------- big letter view: mark places as good / problem ----------
let zoomKind = 'problem', zoomDrag = null;
function showMarkCount() {
  const n = (reviewSel && reviewSel.it.marks && reviewSel.it.marks.length) || 0;
  $('reviewMarkN').textContent = n; $('reviewMarkN').hidden = !n;
  if (reviewSel) { const c = $('reviewBig'); c.width = c.height = 192; paintMarks(c, reviewSel.it.zoom || reviewSel.it.view, reviewSel.it.marks || []); }
}
/** Draw a letter view big, with its marked places (numbered circles: red = problem, green = good). */
function paintMarks(canvas, view, marks, extra = null) {
  const n = Math.round(Math.sqrt(view.length));
  const small = document.createElement('canvas'); drawCrop(small, view);
  const W = canvas.width, ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, n, n, 0, 0, W, W);
  const all = extra ? [...marks, extra] : marks;
  ctx.font = `bold ${Math.round(W / 20)}px system-ui, sans-serif`;
  all.forEach((m, k) => {
    const col = m.kind === 'good' ? '#138a13' : '#d00000';
    ctx.lineWidth = Math.max(2, W / 120); ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(m.u * W, m.v * W, m.r * W, 0, Math.PI * 2); ctx.stroke();
    if (m === extra) return;
    const tx = m.u * W + m.r * W * 0.75, ty = m.v * W - m.r * W * 0.75;
    ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.strokeText(String(k + 1), tx, ty);
    ctx.fillStyle = col; ctx.fillText(String(k + 1), tx, ty);
  });
}
function openZoom() {
  if (!reviewSel) return;
  const it = reviewSel.it;
  it.marks = it.marks || [];
  $('zoomTitle').textContent = it.guess ? T(`Letter ${it.guess} – mark places`, `האות ${it.guess} – סימון מקומות`) : T('Mark places', 'סימון מקומות');
  setZoomKind(zoomKind);
  drawZoom(); $('zoomBox').hidden = false;
}
function drawZoom(extra = null) { const it = reviewSel.it; paintMarks($('zoomCanvas'), it.zoom || it.view, it.marks, extra); renderZoomList(); }
function setZoomKind(k) { zoomKind = k; $('zkProblem').classList.toggle('sel', k === 'problem'); $('zkGood').classList.toggle('sel', k === 'good'); }
async function saveReviewMarks() { const it = reviewSel.it; await db.put('review', it); showMarkCount(); }
function renderZoomList() {
  const it = reviewSel.it, box = $('zoomList'); box.innerHTML = '';
  if (!it.marks.length) { box.innerHTML = `<div class="small">${T('No places marked yet.', 'עוד לא סומנו מקומות.')}</div>`; return; }
  it.marks.forEach((m, k) => {
    const row = document.createElement('div');
    row.innerHTML = `<span class="num ${m.kind}">${k + 1}</span>
      <select aria-label="${T('Kind', 'סוג')}"><option value="problem">⚠ ${T('Problem', 'בעיה')}</option><option value="good">✓ ${T('Good', 'תקין')}</option></select>
      <input maxlength="120" placeholder="${T('Note (optional), e.g. crack in the roof', 'הערה (לא חובה), למשל סדק בגג')}">
      <button type="button" aria-label="${T('Remove', 'הסר')}">🗑</button>`;
    const [sel, inp, del] = [row.querySelector('select'), row.querySelector('input'), row.querySelector('button')];
    sel.value = m.kind; inp.value = m.note || '';
    sel.onchange = () => { m.kind = sel.value; saveReviewMarks(); drawZoom(); };
    inp.oninput = () => { m.note = inp.value.trim(); saveReviewMarks(); };
    del.onclick = () => { it.marks.splice(k, 1); saveReviewMarks(); drawZoom(); };
    box.appendChild(row);
  });
}
const zoomPos = (e) => { const r = $('zoomCanvas').getBoundingClientRect(); return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height }; };
const clampR = (r) => Math.min(0.25, Math.max(0.04, r));
$('zoomCanvas').addEventListener('pointerdown', (e) => {
  e.preventDefault(); $('zoomCanvas').setPointerCapture(e.pointerId);
  const p = zoomPos(e); zoomDrag = { u: p.u, v: p.v, r: 0.07, moved: false, kind: zoomKind };
  drawZoom(zoomDrag);
});
$('zoomCanvas').addEventListener('pointermove', (e) => {
  if (!zoomDrag) return;
  const p = zoomPos(e); const d = Math.hypot(p.u - zoomDrag.u, p.v - zoomDrag.v);
  if (d > 0.03) { zoomDrag.moved = true; zoomDrag.r = clampR(d); }
  drawZoom(zoomDrag);
});
const endDrag = () => {
  if (!zoomDrag) return;
  const m = { u: Math.min(1, Math.max(0, zoomDrag.u)), v: Math.min(1, Math.max(0, zoomDrag.v)), r: zoomDrag.moved ? zoomDrag.r : 0.07, kind: zoomDrag.kind, note: '' };
  zoomDrag = null;
  reviewSel.it.marks.push(m); saveReviewMarks(); drawZoom();
};
$('zoomCanvas').addEventListener('pointerup', endDrag);
$('zoomCanvas').addEventListener('pointercancel', () => { zoomDrag = null; drawZoom(); });
$('reviewZoom').onclick = openZoom;
$('zkProblem').onclick = () => setZoomKind('problem');
$('zkGood').onclick = () => setZoomKind('good');
const closeZoom = () => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); $('zoomBox').hidden = true; };
$('zoomClose').onclick = closeZoom; $('zoomDone').onclick = closeZoom;
$('zoomBox').onclick = (e) => { if (e.target === $('zoomBox')) closeZoom(); };

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
  let info = T('No model loaded. The app still works using letter shapes and the known text. Train a model on your PC (or here) to make it better.', 'לא נטען מודל. האפליקציה עובדת בכל זאת לפי צורות האותיות והנוסח הידוע. אמן מודל במחשב (או כאן) כדי לשפר.');
  if (state.modelJson) {
    try {
      const m = JSON.parse(state.modelJson).meta || {};
      info = T(`Model loaded. Trained ${m.trained ? dateTimeStr(m.trained) : '?'} on ${m.realSamples ?? '?'} real + ${m.synthSamples ?? '?'} font letters, ${m.valAcc ? `${(m.valAcc * 100).toFixed(1)}% correct on ${m.valFromReal ? 'real' : 'font'} test letters` : ''}. `,
          `מודל נטען. אומן ${m.trained ? dateTimeStr(m.trained) : '?'} על ${m.realSamples ?? '?'} אותיות אמיתיות + ${m.synthSamples ?? '?'} אותיות גופן, ${m.valAcc ? `${(m.valAcc * 100).toFixed(1)}% נכון על אותיות בדיקה ${m.valFromReal ? 'אמיתיות' : 'מגופן'}` : ''}. `)
        + (modelTrusted({ meta: m }) ? T('It is used in checks.', 'הוא בשימוש בבדיקות.') : T(`It is NOT used in checks until it is trained on at least ${MIN_REAL} real letters (a font-only AI makes many mistakes on real handwriting).`, `הוא לא בשימוש בבדיקות עד שיאומן על לפחות ${MIN_REAL} אותיות אמיתיות (בינה שלמדה רק מגופן טועה הרבה בכתב יד אמיתי).`));
    } catch { /* ignore */ }
  }
  $('modelInfo').textContent = info;
  showSpotList();
  $('sens').value = state.sens; $('sensLbl').textContent = state.sens;
  const ss = await getSettings();
  $('pairCode').value = ss.code; $('pcUrl').value = ss.url;
  const biz = (await db.get('business')) || {};
  $('bizName').value = biz.name || ''; $('bizSofer').value = biz.sofer || ''; $('bizPhone').value = biz.phone || ''; $('bizAddress').value = biz.address || ''; $('bizExtra').value = biz.extra || '';
  showSyncStatus();
}
async function showSpotList() {
  const recs = await allSpotRecords();
  const nP = recs.reduce((a, r) => a + r.marks.filter((m) => m.kind === 'problem').length, 0);
  const nG = recs.reduce((a, r) => a + r.marks.filter((m) => m.kind === 'good').length, 0);
  $('spotInfo').textContent = recs.length
    ? T(`${nP} problem places and ${nG} good places on ${recs.length} letters. In every check, similar places on letters of the same kind are circled with your note.`, `${nP} מקומות בעיה ו־${nG} מקומות תקינים על ${recs.length} אותיות. בכל בדיקה, מקומות דומים באותיות מאותו סוג מסומנים בעיגול עם ההערה שלך.`)
    : T('None yet. In "Review unsure letters", tap the letter picture to see it big and mark places as good or problem.', 'עדיין אין. ב"אותיות לבדיקה" לחץ על תמונת האות כדי לראות אותה גדולה ולסמן מקומות כתקינים או כבעיה.');
  const list = $('spotList'); list.innerHTML = '';
  for (const r of recs.sort((a, b) => (b.date || 0) - (a.date || 0))) {
    const row = document.createElement('div'); row.className = 'spot';
    const cv = document.createElement('canvas'); cv.width = 192; cv.height = 192; paintMarks(cv, r.zoom, r.marks);
    const txt = document.createElement('div');
    txt.innerHTML = `<b>${r.label}</b>${r.fromPC ? ` <span class="small">${T('(from the PC)', '(מהמחשב)')}</span>` : ''}<div class="small">${r.marks.map((m, k) => `${k + 1}. ${m.kind === 'good' ? T('✓ good', '✓ תקין') : T('⚠ problem', '⚠ בעיה')}${m.note ? ` – ${escapeHtml(m.note)}` : ''}`).join('<br>')}</div>`;
    const del = document.createElement('button'); del.textContent = '🗑'; del.setAttribute('aria-label', T('Forget these marks', 'שכח את הסימונים האלה'));
    del.onclick = async () => {
      if (!confirm(T('Forget the marked places on this letter? (The letter stays in the library.)', 'לשכוח את המקומות שסומנו באות הזאת? (האות נשארת בספרייה.)'))) return;
      const empty = { uid: r.uid, label: r.label, zoom: null, marks: [] };
      const pc = (await db.get('pcSpots')) || {}; delete pc[r.uid]; await db.set('pcSpots', pc);
      if (!r.fromPC) await saveSpot(empty);
      await queueMarks(empty); spotsChanged(); runSync(); showSpotList();
    };
    row.append(cv, txt, del); list.appendChild(row);
  }
}
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('syncSave').onclick = async () => {
  await saveSettings({ code: $('pairCode').value.trim().toUpperCase(), url: $('pcUrl').value.trim() });
  if (ON_PC) { try { localStorage.setItem('pairCode', $('pairCode').value.trim().toUpperCase()); } catch { /* ignore */ } }
  $('syncInfo').textContent = T('Connecting…', 'מתחבר…');
  const r = await runSync();
  if (r.state === 'ok') $('syncInfo').textContent = `${T('Connected to the PC ✓', 'מחובר למחשב ✓')}${r.newModel ? T(' – new AI received', ' – התקבלה בינה חדשה') : ''}`;
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
  alert(T('Model loaded. It will be used from the next check.', 'המודל נטען. הוא ישמש מהבדיקה הבאה.'));
  openLibrary();
};
$('removeModel').onclick = async () => { if (!confirm(T('Remove the AI model from this phone?', 'להסיר את מודל הבינה מהטלפון?'))) return; state.modelJson = null; await db.set('model', null); openLibrary(); };
$('clearLib').onclick = async () => { if (!confirm(T('Delete ALL letters in the library? This cannot be undone.', 'למחוק את כל האותיות בספרייה? אי אפשר לבטל.'))) return; await db.clear('samples'); openLibrary(); };
$('clearReview').onclick = async () => { if (!confirm(T('Delete all letters waiting for review?', 'למחוק את כל האותיות שממתינות לבדיקה?'))) return; await db.clear('review'); openLibrary(); };

// ---------- reference text ----------
function refStatsText() {
  const s = referenceStats($('refText').value);
  const ok = s.letters === 713 && s.words === 170;
  $('refStats').innerHTML = `${T(`${s.letters} letters, ${s.words} words`, `${s.letters} אותיות, ${s.words} מילים`)} ${ok ? T('✓ (713 / 170 as expected)', '✓ (713 / 170 כמצופה)') : `<b style="color:var(--red)">${T('— expected 713 letters and 170 words', '— מצופה 713 אותיות ו־170 מילים')}</b>`}${s.invalid.length ? `<br><b style="color:var(--red)">${T('Not allowed characters', 'תווים לא מותרים')}: ${s.invalid.join(' ')}</b>` : ''}`;
}
function openReference() { $('refText').value = state.refText.trim(); refStatsText(); }
$('refText').oninput = refStatsText;
$('refReset').onclick = () => { $('refText').value = MEZUZAH_TEXT.trim(); refStatsText(); };
$('refConfirm').onclick = async () => {
  const s = referenceStats($('refText').value);
  if (s.invalid.length) { alert(T('Please remove the characters that are not letters: ', 'נא להסיר את התווים שאינם אותיות: ') + s.invalid.join(' ')); return; }
  if ((s.letters !== 713 || s.words !== 170) && !confirm(T(`The text has ${s.letters} letters and ${s.words} words (expected 713 and 170). Save anyway?`, `בנוסח יש ${s.letters} אותיות ו־${s.words} מילים (מצופה 713 ו־170). לשמור בכל זאת?`))) return;
  state.refText = $('refText').value; state.refConfirmed = true;
  await db.set('refText', state.refText); await db.set('refConfirmed', true);
  show('home', false); stack.length = 0;
};

// ---------- history ----------
async function openHistory() {
  const scans = (await db.all('scans')).reverse();
  const ul = $('historyList'); ul.innerHTML = ''; $('historyImg').hidden = true;
  if (!scans.length) ul.innerHTML = `<li class="small">${T('No mezuzot checked yet.', 'עוד לא נבדקו מזוזות.')}</li>`;
  for (const s of scans) {
    const li = document.createElement('li');
    const st = s.stats;
    li.textContent = `${dateTimeStr(s.date)} — ${s.customerName ? `${s.customerName} – ${s.itemName}` : s.mode === 'learn' ? T('learn', 'למידה') : T('check', 'בדיקה')} — ${st ? T(`${st.matched}/${st.expected} letters, ${s.issues.length} places to check`, `${st.matched}/${st.expected} אותיות, ${s.issues.length} מקומות לבדיקה`) : T('no letters found', 'לא נמצאו אותיות')}`;
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
