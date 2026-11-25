// Hebrew / English. Hebrew is the default. The choice is kept on this device; switching reloads the page.
let lang = 'he';
try { if (typeof document !== 'undefined') lang = localStorage.getItem('lang') === 'en' ? 'en' : 'he'; } catch { /* worker or no storage: Hebrew */ }

export const getLang = () => lang;
export const setLang = (l) => { lang = l === 'en' ? 'en' : 'he'; };
/** T('English', 'עברית') → the text in the current language. */
export const T = (en, he) => (lang === 'he' ? he : en);
export const locale = () => (lang === 'he' ? 'he-IL' : 'en-GB');
export const dateStr = (d) => new Date(d).toLocaleDateString(locale());
export const dateTimeStr = (d) => new Date(d).toLocaleString(locale());

/**
 * Translate the fixed texts of a page. `dict` maps the English text (trimmed) to Hebrew.
 * Elements with data-he get their whole inner HTML replaced (for sentences with bold words or links inside).
 * Also adds the language button (top left) and turns the page right-to-left.
 */
export function translatePage(dict, buttonParent = document.querySelector('header')) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  if (buttonParent) {
    const b = document.createElement('button');
    b.id = 'langBtn'; b.className = 'lang-btn'; b.type = 'button';
    b.textContent = lang === 'he' ? 'English' : 'עברית';
    b.setAttribute('aria-label', lang === 'he' ? 'Switch to English' : 'החלף לעברית');
    b.onclick = () => { try { localStorage.setItem('lang', lang === 'he' ? 'en' : 'he'); } catch { /* ignore */ } location.reload(); };
    buttonParent.appendChild(b);
  }
  if (lang !== 'he') return;
  for (const el of document.querySelectorAll('[data-he]')) el.innerHTML = el.dataset.he;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const k = n.nodeValue.trim().replace(/\s+/g, ' ');
    if (k && dict[k]) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), dict[k]);
  }
  for (const attr of ['placeholder', 'aria-label', 'title']) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const k = el.getAttribute(attr).trim();
      if (dict[k]) el.setAttribute(attr, dict[k]);
    }
  }
  if (dict[document.title]) document.title = dict[document.title];
}
