// PC screen: all checks sent from the phone, the learning library, and AI training.
import { LETTERS } from './reference.js';
import { paintIssues } from './report.js';
import { nextDue, dueState, calendarFile } from './customers.js';
import { VERDICTS, certificateHTML, CERT_CSS, printCertificate } from './certificate.js';
import { T, dateStr, dateTimeStr, translatePage } from './i18n.js';
import { HE_PC } from './lang-he.js';
translatePage(HE_PC);
{ const st = document.createElement('style'); st.textContent = CERT_CSS; document.head.appendChild(st); }

const $ = (id) => document.getElementById(id);
let code = '';
try { code = localStorage.getItem('pairCode') || ''; } catch { /* private mode */ }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'x-pair-code': code, ...(opts.headers || {}) } });
  if (res.status === 401) throw Object.assign(new Error('wrong code'), { auth: true });
  if (!res.ok) throw new Error(`error ${res.status}`);
  return res;
}

async function start() {
  try { await api('/api/ping'); } catch { $('pair').hidden = false; $('ui').hidden = true; return; }
  $('pair').hidden = true; $('ui').hidden = false;
  loadChecks();
  setInterval(loadChecks, 15000); // new checks from the phone appear by themselves
}
$('codeBtn').onclick = async () => {
  code = $('code').value.trim().toUpperCase();
  try { await api('/api/ping'); try { localStorage.setItem('pairCode', code); } catch { /* ignore */ } start(); }
  catch { $('codeMsg').textContent = T('That code is not right.', 'הקוד לא נכון.'); }
};

// ---------- tabs ----------
function tab(name) {
  for (const [t, sec] of [['tabChecks', 'checks'], ['tabCust', 'cust'], ['tabLib', 'lib']]) { $(t).classList.toggle('on', sec === name); $(sec).hidden = sec !== name; }
  if (name === 'lib') loadLib();
  if (name === 'cust') loadCustomers();
}
$('tabChecks').onclick = () => tab('checks');
$('tabCust').onclick = () => tab('cust');
$('tabLib').onclick = () => tab('lib');

// ---------- customers ----------
async function loadCustomers() {
  const r = await (await api('/api/records')).json();
  const cs = new Map(r.customers.filter((c) => !c.deleted).map((c) => [c.uid, c]));
  const items = r.items.filter((i) => !i.deleted && cs.has(i.customerUid));
  const due = items.map((item) => ({ item, customer: cs.get(item.customerUid), due: nextDue(item), state: dueState(item) }))
    .filter((d) => d.state === 'overdue' || d.state === 'soon').sort((a, b) => a.due - b.due);
  const box = $('pcDue');
  box.innerHTML = due.length ? `<h2>${T('Due for a check (next 30 days)', 'הגיע זמן בדיקה (30 הימים הקרובים)')}</h2><table class="cust-table"><tbody id="pcDueBody"></tbody></table><div class="row" style="max-width:420px"><button id="pcCal">📅 ${T('Download calendar reminders', 'הורד תזכורות ליומן')}</button></div>` : `<p class="small">${T('Nothing is due in the next 30 days.', 'אין בדיקות ב־30 הימים הקרובים.')}</p>`;
  for (const d of due) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td>';
    tr.children[0].textContent = d.customer.name; tr.children[1].textContent = d.customer.phone || '';
    tr.children[2].textContent = d.item.name;
    tr.children[3].textContent = `${d.state === 'overdue' ? T('overdue since', 'באיחור מאז') : T('due', 'מועד')} ${dateStr(d.due)}`;
    tr.children[3].className = `due-${d.state}`;
    $('pcDueBody').appendChild(tr);
  }
  if (due.length) $('pcCal').onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([calendarFile(due)], { type: 'text/calendar' })); a.download = 'mezuzah-checks-due.ics'; a.click();
  };
  const q = $('pcCustFilter').value.trim().toLowerCase();
  const body = $('pcCustBody'); body.innerHTML = '';
  const sorted = [...cs.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  for (const c of sorted) {
    if (q && !c.name.toLowerCase().includes(q) && !(c.phone || '').includes(q)) continue;
    const its = items.filter((i) => i.customerUid === c.uid);
    for (const [k, it] of (its.length ? its : [null]).entries()) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
      if (k === 0) { tr.children[0].textContent = c.name; tr.children[1].textContent = c.phone || ''; }
      if (it) {
        tr.children[2].textContent = it.name;
        tr.children[3].textContent = it.lastCheck ? dateStr(it.lastCheck) : '—';
        const nd = nextDue(it);
        tr.children[4].textContent = nd ? dateStr(nd) : '—';
        tr.children[4].className = `due-${dueState(it)}`;
      }
      body.appendChild(tr);
    }
  }
}
$('pcCustFilter').oninput = loadCustomers;

// ---------- checks ----------
let selected = null, shown = '';
async function loadChecks() {
  const list = await (await api('/api/scans')).json();
  const key = list.map((s) => s.uid).join();
  if (key === shown) return;
  shown = key;
  $('scanCount').textContent = T(`${list.length} checks`, `${list.length} בדיקות`);
  const ul = $('scanList'); ul.innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    const st = s.stats;
    li.innerHTML = `<div><b></b></div><div class="meta"></div>`;
    li.querySelector('b').textContent = `${s.printed ? '🖨 ' : ''}${s.customerName ? `${s.customerName} – ${s.itemName}` : dateTimeStr(s.date)}`;
    const vv = s.verdict && VERDICTS.find((x) => x.id === s.verdict);
    li.querySelector('.meta').textContent = `${vv ? `${T(vv.en, vv.he)} · ` : ''}${s.customerName ? dateTimeStr(s.date) + ' · ' : ''}${s.mode === 'learn' ? T('learn', 'למידה') : T('check', 'בדיקה')} · ${st ? T(`${st.matched}/${st.expected} letters · ${s.nIssues} places to check`, `${st.matched}/${st.expected} אותיות · ${s.nIssues} מקומות לבדיקה`) : T('no letters found', 'לא נמצאו אותיות')} · ${s.device || ''}`;
    li.classList.toggle('sel', s.uid === selected);
    li.onclick = () => openCheck(s.uid);
    ul.appendChild(li);
  }
  if (!selected && list.length) openCheck(list[0].uid);
}

let zoom = 1;
async function openCheck(uid) {
  selected = uid;
  for (const li of $('scanList').children) li.classList.remove('sel');
  const meta = await (await api(`/api/scans/${uid}`)).json();
  const bmp = await createImageBitmap(await (await api(`/api/scans/${uid}/photo`)).blob());
  const v = $('viewer');
  v.innerHTML = `
    <div id="q"></div>
    <div id="res" class="for-line"></div>
    <div class="zoom-bar" dir="ltr"><button id="zo">−</button><span id="zl">100%</span><button id="zi">+</button></div>
    <div class="canvas-wrap" id="wrap" dir="ltr"><canvas id="cv"></canvas></div>
    <ol class="issues issues-pc" id="il"></ol>`;
  // printed-copy warnings: the PC's (compared with every check on the PC) or else the phone's
  const pw = (meta.printWarningsPC && meta.printWarningsPC.length ? meta.printWarningsPC : meta.printWarnings) || [];
  const notes = [...pw.map((w) => ({ bad: true, text: '🖨 ' + w.note })), ...((meta.quality && meta.quality.warnings) || []).filter((w) => w.kind !== 'print').map((w) => ({ bad: false, text: '⚠ ' + w.note }))];
  for (const n of notes) { const d = document.createElement('div'); d.className = `note ${n.bad ? 'bad' : 'warn'}`; d.textContent = n.text; $('q').appendChild(d); }
  const draw = (sel = -1) => {
    const cv = $('cv'); cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    paintIssues(ctx, bmp.width, meta.issues, sel);
  };
  const setZoom = (z) => { zoom = Math.max(1, Math.min(8, z)); $('cv').style.width = `${zoom * 100}%`; $('zl').textContent = `${Math.round(zoom * 100)}%`; };
  $('zi').onclick = () => setZoom(zoom * 1.5); $('zo').onclick = () => setZoom(zoom / 1.5);
  draw(); setZoom(1);
  // the sofer's result and certificate
  const verdict = meta.result && VERDICTS.find((x) => x.id === meta.result.verdict);
  $('res').innerHTML = '';
  if (verdict) {
    const t = document.createElement('span');
    t.textContent = `${T("Sofer's result", 'תוצאת הסופר')}: ${verdict.he} · ${verdict.en}${meta.result.notes ? ` – ${meta.result.notes}` : ''}  `;
    const b = document.createElement('button'); b.textContent = T('🖨 Print certificate', '🖨 הדפס תעודה');
    b.onclick = () => printCertificate(certificateHTML({
      business: meta.result.business || {}, customerName: meta.customerName, itemName: meta.itemName, date: meta.date,
      verdict: meta.result.verdict, notes: meta.result.notes, number: meta.uid.slice(0, 8).toUpperCase(),
    }));
    $('res').append(t, b);
  } else $('res').textContent = meta.mode === 'check' ? T('No result saved by the sofer yet.', 'הסופר עוד לא שמר תוצאה.') : '';
  const il = $('il');
  if (!(meta.issues || []).length) il.innerHTML = `<li>${T('No places were marked. The sofer should still check the whole mezuzah.', 'לא סומנו מקומות. הסופר צריך בכל זאת לבדוק את כל המזוזה.')}</li>`;
  (meta.issues || []).forEach((is, k) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${k + 1}</span><span></span>`;
    li.lastChild.textContent = is.note;
    li.onclick = () => {
      draw(k); setZoom(Math.max(zoom, 3));
      for (const [i, x] of [...il.children].entries()) x.classList.toggle('sel', i === k);
      const wrap = $('wrap'), cv = $('cv');
      wrap.scrollLeft = (is.x / bmp.width) * cv.clientWidth - wrap.clientWidth / 2;
      wrap.scrollTop = (is.y / bmp.height) * cv.clientHeight - wrap.clientHeight / 2;
    };
    il.appendChild(li);
  });
  shown = ''; loadChecks();
}

// ---------- library & AI ----------
let poll = null;
async function loadLib() {
  loadUsers();
  const st = await (await api('/api/library/stats')).json();
  $('libInfo').textContent = T(`${st.total} sure letters from real mezuzot. The AI trains by itself after ${st.autoMin} letters, and again every ${st.autoEvery} new letters (${st.sinceTrain} new since the last training).`, `${st.total} אותיות בטוחות ממזוזות אמיתיות. הבינה מתאמנת לבד אחרי ${st.autoMin} אותיות, ושוב כל ${st.autoEvery} אותיות חדשות (${st.sinceTrain} חדשות מאז האימון האחרון).`);
  $('libCounts').innerHTML = LETTERS.map((L) => `<div class="${st.counts[L] < 30 ? 'low' : ''}"><b>${L}</b>${st.counts[L]}</div>`).join('');
  const m = await (await api('/api/model/meta')).json();
  $('modelInfo').textContent = m.version
    ? T(`Current AI: trained ${dateTimeStr(m.meta.trained)} on ${m.meta.realSamples} real letters, ${(m.meta.valAcc * 100).toFixed(1)}% correct on real test letters. ${m.trusted ? 'Phones use it.' : ''}`, `הבינה הנוכחית: אומנה ${dateTimeStr(m.meta.trained)} על ${m.meta.realSamples} אותיות אמיתיות, ${(m.meta.valAcc * 100).toFixed(1)}% נכון על אותיות בדיקה אמיתיות. ${m.trusted ? 'הטלפונים משתמשים בה.' : ''}`)
    : T('No AI has been published yet. The phone checks with the known text and letter shapes until then.', 'עוד לא פורסמה בינה. עד אז הטלפון בודק לפי הנוסח הידוע וצורות האותיות.');
  const t = await (await api('/api/train/status')).json();
  $('trainLog').textContent = t.log.join('\n') || T('No training yet.', 'עוד לא היה אימון.');
  $('trainBtn').disabled = !!t.running;
  $('trainProg').hidden = !t.running;
  if (t.running) $('trainProg').value = t.running.progress || 0;
  clearTimeout(poll);
  if (t.running) poll = setTimeout(loadLib, 3000);
}
// ---------- helpers (shared library) ----------
const b64u8 = (b) => { const t = atob(b); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
async function loadUsers() {
  const users = await (await api('/api/users')).json();
  const body = $('usersBody'); body.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td><code></code></td><td></td><td></td><td></td>';
    tr.children[0].textContent = u.name === 'Me (owner)' ? T(u.name, 'אני (בעלים)') : u.name;
    tr.querySelector('code').textContent = u.code;
    tr.children[2].textContent = `${u.letters}${u.pending ? T(` (+${u.pending} waiting)`, ` (+${u.pending} ממתינות)`) : ''}`;
    if (u.role === 'helper') {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !u.trusted;
      cb.onchange = async () => { await api(`/api/users/${u.id}`, { method: 'POST', body: JSON.stringify({ trusted: !cb.checked }) }); loadUsers(); };
      tr.children[3].appendChild(cb);
      const rm = document.createElement('button'); rm.textContent = T('Remove', 'הסר'); rm.className = 'danger';
      rm.onclick = async () => { if (!confirm(T(`Remove ${u.name}? Their pairing code stops working. Letters already in the library stay.`, `להסיר את ${u.name}? קוד הצימוד שלו יפסיק לעבוד. אותיות שכבר בספרייה נשארות.`))) return; await api(`/api/users/${u.id}`, { method: 'POST', body: JSON.stringify({ remove: true }) }); loadUsers(); };
      tr.children[4].appendChild(rm);
    } else tr.children[3].textContent = '—';
    body.appendChild(tr);
  }
  // letters waiting for approval
  const pend = await (await api('/api/pending')).json();
  const box = $('pendBox'); box.innerHTML = '';
  if (pend.total) {
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    box.innerHTML = `<h2>${T('Letters waiting for your approval', 'אותיות שממתינות לאישורך')} (${pend.total})</h2><p class="small">${T('Check that each letter is labelled right (blue letter). Approve adds them to the shared library.', 'בדוק שכל אות מסומנת נכון (האות הכחולה). אישור מוסיף אותן לספרייה המשותפת.')}</p><div class="pend-grid" id="pendGrid"></div><div class="row" style="max-width:520px"><button class="primary" id="pendOk">${T('✓ Approve all shown', '✓ אשר את כל המוצגות')}</button><button class="danger" id="pendNo">${T('✗ Discard all shown', '✗ מחק את כל המוצגות')}</button></div>`;
    for (const it of pend.items) {
      const d = document.createElement('div'); d.title = names[it.user] || '';
      const cv = document.createElement('canvas'); cv.width = 48; cv.height = 48;
      if (it.view) { const v = b64u8(it.view); const im = cv.getContext('2d').createImageData(48, 48); for (let i = 0; i < v.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v[i]; im.data[i * 4 + 3] = 255; } cv.getContext('2d').putImageData(im, 0, 0); }
      const sp = document.createElement('span'); sp.textContent = it.label;
      d.append(cv, sp); $('pendGrid').appendChild(d);
    }
    const uids = pend.items.map((i) => i.uid);
    $('pendOk').onclick = async () => { await api('/api/pending', { method: 'POST', body: JSON.stringify({ action: 'approve', uids }) }); loadLib(); };
    $('pendNo').onclick = async () => { if (!confirm(T('Discard these letters?', 'למחוק את האותיות האלה?'))) return; await api('/api/pending', { method: 'POST', body: JSON.stringify({ action: 'discard', uids }) }); loadLib(); };
  }
}
$('addHelper').onclick = async () => {
  const name = $('helperName').value.trim(); if (!name) return;
  const u = await (await api('/api/users', { method: 'POST', body: JSON.stringify({ name }) })).json();
  $('helperName').value = '';
  alert(T(`${u.name}'s pairing code: ${u.code}\nThey type it in their app: Library & AI → PC sync.`, `קוד הצימוד של ${u.name}: ${u.code}\nמקלידים אותו באפליקציה: ספרייה ובינה ← סנכרון עם המחשב.`));
  loadUsers();
};

$('trainBtn').onclick = async () => { await api('/api/train', { method: 'POST' }); loadLib(); };

if (!code) $('pair').hidden = false;
start();

$('csvBtn').onclick = async () => {
  const blob = await (await api('/api/export.csv')).blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mezuzah-checks.csv'; a.click();
};
