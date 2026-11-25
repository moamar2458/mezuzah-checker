// Reference text of the mezuzah: Devarim 6:4-9 (Shema) and 11:13-21 (Vehaya im shamoa).
// THE SOFER MUST CONFIRM THIS TEXT before relying on the app (Settings -> Reference text).
// "|" marks the parasha setuma break between the two parshiyot.
// Expected: 713 letters, 170 words.

export const MEZUZAH_TEXT = `
שמע ישראל יהוה אלהינו יהוה אחד
ואהבת את יהוה אלהיך בכל לבבך ובכל נפשך ובכל מאדך
והיו הדברים האלה אשר אנכי מצוך היום על לבבך
ושננתם לבניך ודברת בם בשבתך בביתך ובלכתך בדרך ובשכבך ובקומך
וקשרתם לאות על ידך והיו לטטפת בין עיניך
וכתבתם על מזזות ביתך ובשעריך
|
והיה אם שמע תשמעו אל מצותי אשר אנכי מצוה אתכם היום לאהבה את יהוה אלהיכם ולעבדו בכל לבבכם ובכל נפשכם
ונתתי מטר ארצכם בעתו יורה ומלקוש ואספת דגנך ותירשך ויצהרך
ונתתי עשב בשדך לבהמתך ואכלת ושבעת
השמרו לכם פן יפתה לבבכם וסרתם ועבדתם אלהים אחרים והשתחויתם להם
וחרה אף יהוה בכם ועצר את השמים ולא יהיה מטר והאדמה לא תתן את יבולה ואבדתם מהרה מעל הארץ הטבה אשר יהוה נתן לכם
ושמתם את דברי אלה על לבבכם ועל נפשכם וקשרתם אתם לאות על ידכם והיו לטוטפת בין עיניכם
ולמדתם אתם את בניכם לדבר בם בשבתך בביתך ובלכתך בדרך ובשכבך ובקומך
וכתבתם על מזוזות ביתך ובשעריך
למען ירבו ימיכם וימי בניכם על האדמה אשר נשבע יהוה לאבתיכם לתת להם כימי השמים על הארץ
`;

// The 27 shapes the model knows, in a fixed order (class index = position).
export const LETTERS = 'אבגדהוזחטיכךלמםנןסעפףצץקרשת'.split('');
export const LETTER_INDEX = Object.fromEntries(LETTERS.map((l, i) => [l, i]));

export const LETTER_NAMES = {
  'א': 'alef', 'ב': 'bet', 'ג': 'gimel', 'ד': 'dalet', 'ה': 'he', 'ו': 'vav', 'ז': 'zayin',
  'ח': 'chet', 'ט': 'tet', 'י': 'yud', 'כ': 'kaf', 'ך': 'final kaf', 'ל': 'lamed', 'מ': 'mem',
  'ם': 'final mem', 'נ': 'nun', 'ן': 'final nun', 'ס': 'samech', 'ע': 'ayin', 'פ': 'pe',
  'ף': 'final pe', 'צ': 'tzadi', 'ץ': 'final tzadi', 'ק': 'kuf', 'ר': 'resh', 'ש': 'shin', 'ת': 'tav',
};

// Rough shape priors, used to align letters before the AI is trained.
// w = width relative to a typical letter, up = rises above the line, down = goes below the line.
export const SHAPE = {
  'א': { w: 1.0 }, 'ב': { w: 1.0 }, 'ג': { w: 0.6 }, 'ד': { w: 1.0 }, 'ה': { w: 1.0 },
  'ו': { w: 0.3 }, 'ז': { w: 0.4 }, 'ח': { w: 1.0 }, 'ט': { w: 1.0 }, 'י': { w: 0.35, small: true },
  'כ': { w: 0.9 }, 'ך': { w: 0.9, down: true }, 'ל': { w: 0.9, up: true }, 'מ': { w: 1.0 },
  'ם': { w: 1.0 }, 'נ': { w: 0.55 }, 'ן': { w: 0.3, down: true }, 'ס': { w: 1.0 }, 'ע': { w: 1.0 },
  'פ': { w: 1.0 }, 'ף': { w: 0.9, down: true }, 'צ': { w: 1.0 }, 'ץ': { w: 1.0, down: true },
  'ק': { w: 1.0, down: true }, 'ר': { w: 0.9 }, 'ש': { w: 1.1 }, 'ת': { w: 1.0 },
};

/**
 * Parse a reference text into a flat list of letters.
 * Each item: { ch, word, posInWord, wordLen, wordStart, parasha, index }
 */
export function parseReference(text = MEZUZAH_TEXT) {
  const out = [];
  let word = 0, parasha = 0;
  const parts = text.split('|');
  parts.forEach((part, p) => {
    parasha = p;
    const words = part.split(/\s+/).filter(Boolean);
    for (const w of words) {
      const letters = [...w].filter((c) => c in LETTER_INDEX);
      letters.forEach((ch, i) => out.push({
        ch, word, posInWord: i, wordLen: letters.length, wordStart: i === 0, parasha, index: out.length,
        wordText: letters.join(''),
      }));
      if (letters.length) word++;
    }
  });
  return out;
}

export function referenceStats(text = MEZUZAH_TEXT) {
  const ref = parseReference(text);
  const words = ref.length ? ref[ref.length - 1].word + 1 : 0;
  const invalid = [...text].filter((c) => !(c in LETTER_INDEX) && !/[\s|]/.test(c));
  return { letters: ref.length, words, invalid: [...new Set(invalid)] };
}
