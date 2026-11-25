// Printable check certificate (Hebrew / English). The verdict is always the sofer's own choice.

export const VERDICTS = [
  { id: 'kosher', he: 'כשרה', en: 'Kosher' },
  { id: 'kosher-repaired', he: 'כשרה לאחר תיקון', en: 'Kosher after repair' },
  { id: 'needs-repair', he: 'צריכה תיקון', en: 'Needs repair' },
  { id: 'pasul', he: 'פסולה', en: 'Not kosher (pasul)' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** data: { business:{name,sofer,phone,address,extra}, customerName, itemName, place, date, verdict, notes, number } */
export function certificateHTML(d) {
  const b = d.business || {};
  const v = VERDICTS.find((x) => x.id === d.verdict);
  const date = new Date(d.date || Date.now());
  return `
  <div class="cert-sheet">
    <div class="cert-biz">
      <div class="cert-biz-name">${esc(b.name) || '&nbsp;'}</div>
      <div class="cert-biz-sub">${[b.sofer, b.phone, b.address].filter(Boolean).map(esc).join(' · ')}</div>
      ${b.extra ? `<div class="cert-biz-sub">${esc(b.extra)}</div>` : ''}
    </div>
    <h1 class="cert-title"><span dir="rtl">תעודת בדיקת מזוזה</span><br><small>Mezuzah Check Certificate</small></h1>
    <table class="cert-table">
      <tr><th dir="rtl">שם הלקוח</th><td>${esc(d.customerName) || '&nbsp;'}</td><th>Customer</th></tr>
      <tr><th dir="rtl">מיקום המזוזה</th><td>${esc([d.itemName, d.place].filter(Boolean).join(' – ')) || '&nbsp;'}</td><th>Mezuzah</th></tr>
      <tr><th dir="rtl">תאריך הבדיקה</th><td>${date.toLocaleDateString('he-IL')} · ${date.toLocaleDateString('en-GB')}</td><th>Date checked</th></tr>
      <tr><th dir="rtl">תוצאת הבדיקה</th><td class="cert-verdict">${v ? `<span dir="rtl">${v.he}</span> · ${v.en}` : '&nbsp;'}</td><th>Result</th></tr>
      ${d.notes ? `<tr><th dir="rtl">הערות / תיקונים</th><td>${esc(d.notes)}</td><th>Notes / repairs</th></tr>` : ''}
      ${d.nextDate ? `<tr><th dir="rtl">בדיקה הבאה</th><td>${new Date(d.nextDate).toLocaleDateString('he-IL')}</td><th>Next check</th></tr>` : ''}
    </table>
    <div class="cert-sign">
      <div><div class="cert-line"></div><span dir="rtl">חתימת הסופר</span> · Sofer's signature${b.sofer ? `<br>${esc(b.sofer)}` : ''}</div>
    </div>
    ${d.number ? `<div class="cert-no">No. ${esc(d.number)}</div>` : ''}
  </div>`;
}

export const CERT_CSS = `
.cert-sheet { background: #fff; color: #111; max-width: 680px; margin: 0 auto; padding: 36px 40px; border: 3px double #6b5a3a; border-radius: 6px; font-family: "Frank Ruehl CLM", "David", "Times New Roman", serif; }
.cert-biz { text-align: center; border-bottom: 1px solid #b9a88a; padding-bottom: 10px; }
.cert-biz-name { font-size: 26px; font-weight: 700; }
.cert-biz-sub { font-size: 14px; color: #444; margin-top: 2px; }
.cert-title { text-align: center; font-size: 30px; margin: 18px 0 14px; line-height: 1.2; }
.cert-title small { font-size: 18px; font-weight: 400; color: #444; }
.cert-table { width: 100%; border-collapse: collapse; font-size: 17px; }
.cert-table th { width: 28%; font-weight: 600; color: #333; padding: 9px 6px; vertical-align: top; }
.cert-table th:first-child { text-align: right; } .cert-table th:last-child { text-align: left; font-weight: 400; font-size: 14px; }
.cert-table td { text-align: center; border-bottom: 1px dotted #999; padding: 9px 6px; }
.cert-verdict { font-weight: 700; font-size: 19px; }
.cert-sign { display: flex; justify-content: center; margin-top: 44px; text-align: center; font-size: 14px; }
.cert-line { width: 240px; border-bottom: 1px solid #222; margin: 0 auto 6px; height: 36px; }
.cert-no { text-align: center; font-size: 12px; color: #666; margin-top: 14px; }
@media print {
  @page { margin: 12mm; }
  body.print-cert > *:not(#printArea) { display: none !important; }
  body.print-cert #printArea { display: block !important; }
  body.print-cert { background: #fff !important; }
  .cert-sheet { border-color: #6b5a3a; }
}
#printArea { display: none; }
`;

/** Print only the certificate. */
export function printCertificate(html) {
  let area = document.getElementById('printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = html;
  document.body.classList.add('print-cert');
  const done = () => { document.body.classList.remove('print-cert'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 60000);
}

/** Plain text summary of a check, to share with another app (Melechet Sofer, WhatsApp, e-mail…). */
export function checkSummaryText({ customerName, itemName, date, stats, issues, result, nextDate, business }) {
  const v = result && VERDICTS.find((x) => x.id === result.verdict);
  const kinds = {};
  for (const i of issues || []) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
  const names = { missing: 'missing?', extra: 'extra?', touch: 'touching', broken: 'broken', bridge: 'touching next line', hole: 'white spot', thin: 'thin ink', closed: 'closed shape', space: 'spacing', wrong: 'wrong letter?', pieces: 'pieces', leg: 'leg touching', shape: 'unusual shape' };
  const found = Object.entries(kinds).map(([k, n]) => `${n} ${names[k] || k}`).join(', ');
  return [
    `בדיקת מזוזה / Mezuzah check – ${new Date(date).toLocaleDateString('he-IL')}`,
    customerName ? `לקוח / Customer: ${customerName}` : null,
    itemName ? `מזוזה / Mezuzah: ${itemName}` : null,
    v ? `תוצאה / Result: ${v.he} (${v.en})` : 'תוצאה / Result: (not saved yet)',
    stats ? `נמצא בבדיקה / Marked by the app: ${(issues || []).length} places to check${found ? ` (${found})` : ''}` : null,
    result && result.notes ? `הערות / תוקן / Notes – fixed: ${result.notes}` : null,
    nextDate ? `בדיקה הבאה / Next check: ${new Date(nextDate).toLocaleDateString('he-IL')}` : null,
    business && business.name ? `— ${business.name}${business.sofer ? `, ${business.sofer}` : ''}` : null,
  ].filter(Boolean).join('\n');
}
