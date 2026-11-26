// A suggested level for the whole mezuzah: mehudar, kosher, or needs checking – with the reasons.
// Only a suggestion for the sofer. The app never decides; the sofer's own answers on each place count first.
import { T } from './i18n.js';

// places that may make the mezuzah not kosher until the sofer looked at them
const SERIOUS = new Set(['missing', 'extra', 'touch', 'bridge', 'broken', 'pieces', 'hole', 'thin', 'closed', 'leg', 'wrong', 'shape', 'taught']);
// places that only touch on beauty (hiddur)
const HIDDUR = new Set(['space', 'style', 'retouch']);

// how uneven the writing may be and still count as even (spread / average); real neat mezuzot measured about half of this
export const EVEN = { letterGapCV: 0.55, wordGapCV: 0.32, lineHeightCV: 0.06, linePitchCV: 0.06 };

const KIND_WORDS = {
  missing: ['missing letter?', 'אות חסרה?'], extra: ['extra mark?', 'סימן עודף?'], touch: ['letters touching?', 'אותיות נוגעות?'],
  bridge: ['touching the next line?', 'נגיעה בשורה הבאה?'], broken: ['broken letter?', 'אות שבורה?'], pieces: ['crack?', 'סדק?'],
  hole: ['crack or missing ink?', 'סדק או חסר דיו?'], thin: ['very thin ink?', 'דיו דק מאוד?'], closed: ['closed letter?', 'אות סגורה?'],
  leg: ['leg touching the roof?', 'רגל נוגעת בגג?'], wrong: ['wrong letter?', 'אות שגויה?'], shape: ['unusual shape?', 'צורה לא רגילה?'],
  taught: ['like a problem you marked', 'דומה לבעיה שסימנת'], space: ['doubtful space between words', 'רווח חשוד בין מילים'],
  style: ['letters not well shaped for the ktav', 'אותיות שאינן מעוצבות היטב לפי הכתב'], retouch: ['maybe a corrected letter', 'אולי אות מתוקנת'],
};
const kw = (k) => T(...(KIND_WORDS[k] || ['other', 'אחר']));

/**
 * issues: the places of the check (each may have .answer = { verdict: 'kosher'|'pasul'|'mehudar', why }).
 * metrics: from the check (spacing). ok: whether the check could read the mezuzah.
 * Returns { level: 'check'|'kosher'|'mehudar', reasons: [text], good: [text] }
 */
export function suggestLevel({ issues = [], metrics = null, ok = true, matched = 0, expected = 713, warnings = [] } = {}) {
  const reasons = [], hiddur = [], good = [];
  if (!ok) return { level: 'check', reasons: [T('The photo could not be checked.', 'לא ניתן היה לבדוק את התמונה.')], good };
  // the sofer's own answers come first
  const pasul = issues.filter((i) => i.answer && i.answer.verdict === 'pasul');
  const mehud = issues.filter((i) => i.answer && i.answer.verdict === 'mehudar');
  const open = issues.filter((i) => !i.answer);
  if (pasul.length) reasons.push(T(`You marked ${pasul.length} place(s) as not kosher`, `סימנת ${pasul.length} מקומות כפסולים`) + (pasul[0].answer.why ? `: "${pasul[0].answer.why}"` : ''));
  // places not answered yet
  const serious = {}, light = {};
  for (const is of open) {
    if (SERIOUS.has(is.kind) && !(is.kind === 'taught' && is.taughtKind === 'mehudar')) serious[is.kind] = (serious[is.kind] || 0) + 1;
    else light[is.kind] = (light[is.kind] || 0) + 1;
  }
  for (const [k, n] of Object.entries(serious)) reasons.push(`${kw(k)} × ${n}`);
  if (matched && matched < expected * 0.98) reasons.push(T(`only ${matched} of ${expected} letters were read`, `רק ${matched} מתוך ${expected} אותיות נקראו`));
  if (warnings.some((w) => w.kind === 'lowres')) reasons.push(T('the photo is not sharp enough for small cracks', 'התמונה לא חדה מספיק לסדקים קטנים'));
  // hiddur (beauty): answers, light places and how even the writing is
  if (mehud.length) hiddur.push(T(`You marked ${mehud.length} mehudar problem(s)`, `סימנת ${mehud.length} בעיות הידור`) + (mehud[0].answer.why ? `: "${mehud[0].answer.why}"` : ''));
  for (const [k, n] of Object.entries(light)) hiddur.push(`${kw(k)} × ${n}`);
  if (metrics) {
    const m = metrics;
    if (m.letterGapCV !== null && m.letterGapCV > EVEN.letterGapCV) hiddur.push(T('uneven spacing between letters', 'ריווח לא אחיד בין האותיות'));
    else if (m.letterGapCV !== null) good.push(T('even spacing between letters', 'ריווח אחיד בין האותיות'));
    if (m.wordGapCV !== null && m.wordGapCV > EVEN.wordGapCV) hiddur.push(T('uneven spacing between words', 'ריווח לא אחיד בין המילים'));
    else if (m.wordGapCV !== null) good.push(T('even spacing between words', 'ריווח אחיד בין המילים'));
    if (m.lineHeightCV !== null && m.lineHeightCV > EVEN.lineHeightCV) hiddur.push(T('letter height changes from line to line', 'גובה האותיות משתנה משורה לשורה'));
    else if (m.lineHeightCV !== null) good.push(T('even letter height', 'גובה אותיות אחיד'));
    if (m.linePitchCV !== null && m.linePitchCV > EVEN.linePitchCV) hiddur.push(T('uneven distance between lines', 'מרחק לא אחיד בין השורות'));
    else if (m.linePitchCV !== null) good.push(T('even distance between lines', 'מרחק אחיד בין השורות'));
  }
  if (!open.some((i) => i.kind === 'style')) good.push(T('letters shaped like the rest of the ktav', 'צורות האותיות אחידות לפי הכתב'));
  if (reasons.length) return { level: 'check', reasons: [...reasons, ...hiddur], good };
  if (hiddur.length) return { level: 'kosher', reasons: hiddur, good };
  return { level: 'mehudar', reasons: [], good };
}

export const LEVELS = {
  check: { en: 'Needs checking', he: 'צריך בדיקה', icon: '🔍', cls: 'bad' },
  kosher: { en: 'Kosher', he: 'כשר', icon: '✓', cls: 'warn' },
  mehudar: { en: 'Mehudar', he: 'מהודר', icon: '★', cls: 'ok' },
};
export const levelName = (l) => { const x = LEVELS[l]; return x ? `${x.icon} ${T(x.en, x.he)}` : ''; };
