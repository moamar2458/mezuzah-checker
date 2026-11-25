# Decisions made while you were asleep

You asked me to choose the simplest free option whenever something needed your decision.
Everything here can be changed – tell me which ones you want different.

## Step 3 – Before / after
| Decision | Why |
|---|---|
| Compare **letter by letter** (the same letter of the text in both photos), not pixel by pixel | Two photos never line up exactly; the letter matching already knows which letter is which |
| A letter is reported if it has **less than 75% of its ink** compared to the rest of the page, or its ink got clearly **lighter** | Tested: a re-photo of the same mezuzah (smaller, turned, darker) gave **0** false changes; 5 drawn cracks + 4 faded letters were **all** found |
| **"Touching" is not reported as new** in before/after | Very close letters join or not depending on the photo (3 false alarms in the test); they are still in the normal report |
| The last photo of every customer's mezuzah is never deleted from the phone; if missing, it is fetched from the PC | So before/after always works |

## Step 4 – Printed-copy warning
| Decision | Why |
|---|---|
| Two signals: **almost identical to another mezuzah** (≥ 95%) and **repeated letters almost identical** (≥ 93%) | Tests: copies 99%, different hands 66–80%; handwriting uniformity 82%, print 99% |
| The same customer's mezuzah checked again is never compared with itself | It is supposed to be identical |
| ⚠ **Not tested: two different mezuzot by the same scribe** (I only had one real photo) | They may score higher than different hands – if you see false warnings on your own scribe's work, tell me and I'll raise the limit |
| The phone compares with its own checks; the PC compares with every check it ever received and marks 🖨 | The PC sees more |

## Step 5 – Certificate
| Decision | Why |
|---|---|
| **Hebrew + English** on one certificate | Didn't know your customers' language |
| Result options: כשרה / כשרה לאחר תיקון / צריכה תיקון / פסולה – **nothing pre-selected** | The app never decides |
| Business name, sofer name, phone, address and one extra line, entered in *Library & AI → Business details* | I don't know your business name – **please fill it in** |
| Printing through the phone's / PC's own print screen (also "Save as PDF") | Free, no extra tools |
| Certificate number = first 8 characters of the check's id | Unique, no counter to keep |

## Step 6 – Melechet Sofer
| Decision | Why |
|---|---|
| I searched and found **no public information** about an app called Melechet Sofer, or a way to connect to it | Couldn't build a direct link without knowing how it takes data |
| Built: **Share** button (ready text → iPhone share sheet, or copied) + **CSV export** of all checks on the PC | Works with almost any app: share, paste, or import a CSV |
| **To do for you:** tell me how Melechet Sofer takes data in (import file, e-mail, API, a share target) and I'll connect it directly | |

## Step 7 – Shared library
| Decision | Why |
|---|---|
| **Your PC is the hub**; helpers connect through Tailscale node sharing | Free; no server to rent |
| Each helper has **their own pairing code**, which only allows: send letters, get the AI | You can remove one person without changing your own code |
| Helpers send **only letter images** (32×32 letter + small view of it, its label) – never photos, customers, results, which check they came from | As you asked; enforced on the phone **and** on the PC |
| Helpers' sure letters go straight in by default; per helper you can tick **Hold for my approval** | Same "sure letters only" rule as yours; approval is there for anyone you don't fully trust |
| Tailscale's free plan has a limit on users in your own account; **sharing** your PC with helpers' own accounts avoids it | Check the current limits on tailscale.com/pricing |

## Also changed on the way
- The PC program now replaces the old `serve.js` (`start-windows.bat` runs it).
- Each check now also stores a small per-letter record (ink, darkness, a 16×16 fingerprint) – needed for steps 3 and 4.
