// Customer record: customers, their items (each mezuzah), and when each is due to be checked again.
// Every change gets a time stamp, so phone and PC can merge their copies (newest wins).
import * as db from './db.js';
import { T, dateStr } from './i18n.js';

export const DEFAULT_MONTHS = 42; // twice in seven years

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function addMonths(t, months) {
  const d = new Date(t);
  const whole = Math.floor(months), day = d.getDate();
  d.setMonth(d.getMonth() + whole);
  if (d.getDate() < day) d.setDate(0); // e.g. 31 Aug + 6 months -> 28/29 Feb
  return d.getTime() + Math.round((months - whole) * 30.44 * 864e5);
}

/** When is this item due? (null if never checked) */
export function nextDue(item) {
  if (!item.lastCheck) return null;
  return addMonths(item.lastCheck, item.months || DEFAULT_MONTHS);
}

/** 'overdue' | 'soon' (within 30 days) | 'ok' | 'never' */
export function dueState(item, now = Date.now()) {
  const due = nextDue(item);
  if (!due) return 'never';
  if (due < now) return 'overdue';
  if (due - now < 30 * 864e5) return 'soon';
  return 'ok';
}

export async function saveCustomer(c) {
  const rec = { uid: c.uid || uid(), name: (c.name || '').trim(), phone: (c.phone || '').trim(), address: (c.address || '').trim(), notes: c.notes || '', created: c.created || Date.now(), updated: Date.now(), deleted: !!c.deleted };
  await db.put('customers', rec);
  return rec;
}

export async function saveItem(it) {
  const rec = {
    uid: it.uid || uid(), customerUid: it.customerUid, name: (it.name || '').trim(), kind: it.kind || 'mezuzah',
    months: Number(it.months) || DEFAULT_MONTHS, lastCheck: it.lastCheck || null, lastScanUid: it.lastScanUid || null,
    notes: it.notes || '', created: it.created || Date.now(), updated: Date.now(), deleted: !!it.deleted,
  };
  await db.put('items', rec);
  return rec;
}

export async function customers() {
  return (await db.all('customers')).filter((c) => !c.deleted).sort((a, b) => a.name.localeCompare(b.name, 'he'));
}
export async function itemsOf(customerUid) {
  return (await db.byIndex('items', 'customer', customerUid)).filter((i) => !i.deleted).sort((a, b) => a.created - b.created);
}
export const getCustomer = (u) => db.getOne('customers', u);
export const getItem = (u) => db.getOne('items', u);

/** A check was done on this item. */
export async function recordCheck(itemUid, scanUid, date) {
  const it = await getItem(itemUid);
  if (!it) return null;
  if (!it.lastCheck || date >= it.lastCheck) { it.lastCheck = date; it.lastScanUid = scanUid; }
  return saveItem(it);
}

/** All items that are overdue or due within 30 days, with their customer. */
export async function dueList(now = Date.now()) {
  const cs = new Map((await customers()).map((c) => [c.uid, c]));
  const out = [];
  for (const it of await db.all('items')) {
    if (it.deleted || !cs.has(it.customerUid)) continue;
    const st = dueState(it, now);
    if (st === 'overdue' || st === 'soon') out.push({ item: it, customer: cs.get(it.customerUid), due: nextDue(it), state: st });
  }
  return out.sort((a, b) => a.due - b.due);
}

/** Merge records that came from the PC (newest change wins). Returns how many changed here. */
export async function mergeRecords({ customers: cs = [], items = [] }) {
  let n = 0;
  for (const c of cs) { const mine = await db.getOne('customers', c.uid); if (!mine || (c.updated || 0) > (mine.updated || 0)) { await db.put('customers', c); n++; } }
  for (const it of items) { const mine = await db.getOne('items', it.uid); if (!mine || (it.updated || 0) > (mine.updated || 0)) { await db.put('items', it); n++; } }
  return n;
}

// ---------- calendar reminder (.ics file: opens the iPhone / Google / Outlook calendar) ----------
const icsDate = (t) => { const d = new Date(t); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const icsText = (s) => String(s).replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');

export function calendarFile(entries) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = entries.map(({ item, customer, due }) => [
    'BEGIN:VEVENT',
    `UID:${item.uid}-${icsDate(due)}@mezuzah-checker`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(due)}`,
    `DTEND;VALUE=DATE:${icsDate(due + 864e5)}`,
    `SUMMARY:${icsText(T(`Check ${item.kind === 'mezuzah' ? 'mezuzah' : item.kind}: ${customer.name} – ${item.name}`, `בדיקת מזוזה: ${customer.name} – ${item.name}`))}`,
    `DESCRIPTION:${icsText(T(`Last checked ${new Date(item.lastCheck).toLocaleDateString()}.${customer.phone ? ` Phone: ${customer.phone}` : ''}${customer.address ? ` Address: ${customer.address}` : ''}`, `נבדקה לאחרונה ${dateStr(item.lastCheck)}.${customer.phone ? ` טלפון: ${customer.phone}` : ''}${customer.address ? ` כתובת: ${customer.address}` : ''}`))}`,
    'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(T(`Mezuzah check due: ${customer.name}`, `הגיע זמן בדיקת מזוזה: ${customer.name}`))}`, 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mezuzah Checker//EN', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
