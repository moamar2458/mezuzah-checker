# Mezuzah Checker

A free, offline phone app that helps a sofer check a mezuzah from a photo.
**It never decides that a mezuzah is kosher or pasul. It only circles places for the sofer to check.**

## What it does

1. **Photo** – live camera with three helpers: *Light*, *Sharp*, *Level* (tilt sensor). After the photo it also warns
   if the picture was dark, blurry, turned, taken at an angle, or too far away. The photo is straightened automatically.
2. **Find the letters** – finds the 22 lines, every letter, and the spaces between words.
3. **Compare with the text** – lines up every letter with the known mezuzah text (713 letters, 170 words) and marks
   *missing*, *extra*, *wrong* (needs the AI), *touching* and *broken* letters, and wrong spacing between words.
4. **Look for problems** – white spots and cracks inside the ink, very thin places, closed shapes, ה/ק legs touching
   the roof, letters touching the line above/below.
5. **Report** – the photo with every place circled in red and numbered, with a short note. Tap a note to zoom in.
6. **Our own small AI** – a tiny neural network (about 40,000 numbers) that knows only the 27 shapes of ktav ashuri.
   Written in plain JavaScript: no libraries, no internet, runs on the phone, trains in a browser on a PC.
7. **Learning library** – every checked photo adds its letters automatically. A letter is learned only when its
   whole word lines up exactly with the text and nothing looks wrong (and, once there is an AI, the AI agrees).
   Everything else goes to the **Review** list, where you confirm or correct it when you have time.

## Free tools used

| Need | Tool | Why |
|---|---|---|
| App | Plain HTML + JavaScript web app (PWA) | Installs on Android and iPhone from the browser, works offline, no app store |
| Image processing | Own code (`app/js/imageproc.js`) | Light correction, black/white, letter blobs, straightening, crack checks – no downloads |
| AI | Own tiny neural network (`app/js/nn.js`) | Runs offline on the phone and trains in Chrome/Edge on Windows – nothing to install |
| Starter letters | Culmus *Stam Ashkenaz CLM* and *Stam Sefarad CLM* fonts (GPL-2) | Gives the AI a start before you have many real mezuzot |
| Storage | IndexedDB on the phone, a `data` folder on the PC | Nothing goes anywhere except your own PC |
| PC program | Node.js (`pc/server.js`) | Stores every check, trains the AI by itself, shows checks on the PC screen |
| Phone ↔ PC link | Tailscale (free personal plan) | A private, encrypted https link to your PC – at home and away |

## Setting up the PC and the iPhone (once)

**On the Windows PC**
1. Install **Node.js LTS** from https://nodejs.org (all default options).
2. Install **Tailscale** from https://tailscale.com/download and sign in (Google / Microsoft / Apple account).
3. In the Tailscale admin page (https://login.tailscale.com/admin/dns): turn on **MagicDNS**, then
   **Enable HTTPS** (HTTPS Certificates).
4. Double-click **`start-windows.bat`**. A black window opens – keep it open while you work. It shows:
   - the **pairing code** (for example `8TK8-7W2T`),
   - and it opens **checking a mezuzah** in the browser (http://localhost:8080/). The button at the top, "🖥 Mezuzah Checker – PC", opens the **PC screen** (http://localhost:8080/pc.html) – type the pairing code there once.
5. The first time, Tailscale may print a link asking to allow "Serve" – open it and allow.
   Then run `tailscale serve status` in a command window to see your PC's address,
   like `https://my-pc.tail1234.ts.net`.

**On Ubuntu (instead of Windows)**
1. In a terminal: `cd ~/checker` then `./start-ubuntu.sh` – keep the window open.
2. It shares the PC privately on Tailscale port **8443** (it never touches other things this PC shares, and is not public).
   If it says so, run once: `sudo tailscale serve --bg --https=8443 8080`.
3. The phone's "PC address" is `https://<pc-name>.<tailnet>.ts.net:8443`.

**The app is also online:** https://moamar2458.github.io/mezuzah-checker/ – works on the iPhone even when the PC is off.
If you use this address, type the PC address in **Library & AI → PC sync**. Use one address only: each address
keeps its own library on the phone.

**On the iPhone**
1. Install **Tailscale** from the App Store and sign in with the **same** account. Turn it on.
2. In Safari open your PC's address (`https://my-pc.tail1234.ts.net`).
3. Tap **Share → Add to Home Screen**. From now on open the app from the home screen.
4. In the app: **Library & AI → PC sync** → type the pairing code → **Save & sync now**.
   (Leave "PC address" empty – the app already knows it.)
5. Allow the camera when asked.

**How it works day to day**
- The phone checks the mezuzah **by itself, also with no internet**. Each check (photo + results + sure letters) is
  put in an outbox and sent to the PC right away, or as soon as the PC can be reached.
- iPhones do not let web apps work in the background, so the sending happens **while the app is open**
  (on start, after each check, and every minute). Tailscale must be on to reach the PC when you are away from home.
- The PC must be on with the black window open to receive checks.
- The PC **trains the AI by itself** once it has 1,500 real letters, and again every 300 new letters. A new AI is sent to
  the phone at its next sync – but only if it is at least 97% correct on real letters and not worse than the current one.
- All checks can be opened on the PC screen with the same red circles and notes.

## Checking on the PC (camera, scanner, saved file)

The PC program serves the full app at **http://localhost:8080/** – it is the first page the PC program opens.
It has everything the phone has (customers, review, marking places, certificate…) and syncs into the same PC program by itself
(it uses the pairing code you typed on the PC screen).

* **Camera** – a built-in or external USB camera. With more than one camera, choose it at the top of the camera picture; the choice is remembered.
* **Scanner** – the 🖨 button. The PC program scans with SANE (`scanimage`, already part of Ubuntu; USB and network scanners).
  Lay the klaf on the glass; the white around it is cut away by itself. 600 dpi is a good start.
  If no scanner is found: `scanimage -L` in a terminal shows what Ubuntu sees.
  The phone can use the PC's scanner too, when it is synced with the owner's pairing code.
* **Saved file** – 🖼, or drag the file onto the camera screen. JPG, PNG, WEBP, BMP, or PDF (the first page; opened by the PC program with `pdftoppm`).
  TIFF and HEIC files cannot be opened by the browser – save them as JPG or PNG.

## Klaf frame, cut-out and "take it again"

* While the camera is open, the app looks for the klaf (like a document scanner): a green frame is drawn around the klaf only,
  everything around it is darkened, and the camera is asked to focus on the klaf.
* After the photo (or a scan / saved file), the klaf is cut out and straightened (also when the photo was taken at an angle).
  Only the klaf is checked – cloth, case and table are never checked.
* The photo is not checked at all, and nothing is saved, when it is too blurry, too dark, the klaf cannot be found,
  fewer than 45% of the letters can be read, or it gives more than 120 unclear places. The app says why and asks for a new photo.
* "White spot inside the ink" is only marked when the spot is big enough to see, nearly as bright as the klaf, and narrower than
  the stroke (a real gap or crack). Klaf texture, light and photo noise are not marked. Numbers: `HOLE_*` in `app/js/problems.js`.

## Teaching small details (marked places)
In **Review unsure letters**, tap a letter, then tap its picture (🔍) to open it big.
- Tap a place on the letter, or draw a small circle around it, and choose **⚠ Problem** or **✓ Good**; add a short note if you like.
  The whole letter can be right and a place in it can still be a problem.
- When you confirm the letter (*Yes, it is…* or the right letter), the marks are saved with it in the learning library,
  and sent to the PC, which shares them with every phone and helper.
- In every later check, the app looks at the same place on every letter of the same kind (a mark on an א is looked for
  on every א). A place is circled, with your note, only when it looks like your marked problem **and** unlike the same
  place on the other letters of that kind in the mezuzah. A place that looks more like one you marked *good* is not circled,
  and the app's own marks that look like a *good* place say so.
- Such letters are not added to the library automatically; they go to the review list again.
- *Library & AI → Marked places* lists every mark; 🗑 forgets the marks of a letter (on the PC too).
- It only points to places to check – it never decides kosher or not.

## Customers and reminders
- **Check a mezuzah** first asks *who is it for*: type a name (pick an existing customer or add a new one), then
  pick which mezuzah (Front door, Kitchen…). *Check without a customer* skips this.
- Each mezuzah has its own interval – **42 months (twice in 7 years) by default**, changeable per mezuzah.
- The home screen shows a 🔔 banner when checks are overdue or due within 30 days; *Customers & reminders* lists them.
- **📅 Reminder** saves a calendar file (opens the iPhone calendar) with an alert one week before.
- Customers are copied to the PC (Customers & reminders tab). A new or second phone gets them all back at its first sync.

## Before / after
When you check a customer's mezuzah that was checked before, the report shows **🔍 Before / after**.
It compares the *same letters of the text* in the last photo and the new one, and lists letters that lost ink
(crack, flaking), got lighter (fading) or have a new broken / missing letter – each as a pair: before | now.
Both whole photos are shown too. The last photo of every customer's mezuzah is always kept (and fetched from the PC
if the phone no longer has it).

## Printed-copy warning
A red 🖨 warning appears when a mezuzah is letter-for-letter almost identical to a *different* mezuzah checked
before (on this phone, and on the PC against every check ever received), or when its repeated letters are almost
exactly the same (typical of print). It only warns – the sofer decides.

## Result and certificate
**📜 Result & certificate** on the report: the sofer chooses the result (nothing is pre-selected), adds notes /
what was fixed, and can **print** a Hebrew/English certificate (or save it as PDF from the print screen).
Fill in your business details once in *Library & AI → Business details*. Results are copied to the PC, which can
print the certificate too.

## Melechet Sofer
**📤 Send to Melechet Sofer / share** makes a ready text of the check (date, customer, mezuzah, result, what was
found / fixed, next check) and opens the iPhone share sheet – choose Melechet Sofer if it accepts text, or paste it
into the customer's card. The PC can export **all checks as a CSV file** (Checks tab → Export) for importing.
(No public way to connect to Melechet Sofer directly was found – see DECISIONS.md.)

## Several people, one shared library
On the PC: *Library & AI → People sharing letters → Add helper*. Each helper gets their own pairing code.
- A helper's phone sends **only letter images** – never photos, customers or results (the phone leaves them out,
  and the PC refuses them anyway). Helpers get the shared AI back.
- Only *sure* letters (or letters the helper confirmed in their review list) are sent. Tick **Hold for my approval**
  to check a helper's letters yourself first (approve / discard on the PC screen).
- Helpers reach your PC through Tailscale: in the Tailscale admin page, **Share** your PC with their Tailscale
  account (free). They open your PC's address once and add the app to their home screen.
- *Remove* stops a helper's code at once; letters already in the library stay.

## Training the AI by hand (optional)
The PC does this by itself. Without the PC program you can still:
1. On the phone: *Library & AI → Export library* and send the file to the PC.
2. On the PC open http://localhost:8080/train.html (in Hebrew or English, like the app), add the library file(s), press **Start training**.
3. Download the model file, send it to the phone, and load it with *Library & AI → Load trained model*.

**Safety rule:** the app uses the AI only after it has learned from at least 1,500 real letters and scored at
least 97% on real test letters. An AI trained only on font letters was tested on a real klaf and made many mistakes
(it called most ה a ת), so until then the check runs on the known text and letter shapes alone.
In that mode a *wrong* letter (e.g. ד written as ר) is not detected – the report says so.
About 650 letters are learned from each clear mezuzah photo, so 3 mezuzot are enough for the first real training.

## Testing
`app/dev/test.html` draws a fake mezuzah with planted mistakes (missing letter, touching letters, broken letter,
white spot, swapped ד→ר) and shows what the checker finds. Add `?model=1` to use the AI saved in that browser.
`app/dev/photos/` holds real photos used for testing (first one: 702/713 letters matched one-to-one, the other 11
inside touching groups, 0 missing, 10 places marked).

## Not yet (planned)
- Tefillin parshiyot (different texts – the reference text system is already separate).
- More scribes' handwriting styles (the review list + retraining is how they will be added).
- Teaching the crack check what is "normal thin" for each letter, using the library.

## Folder map
```
pc/server.js          PC program           app/pc.html         PC screen
app/js/klaf.js        finding the klaf in a photo and cutting it out straight
app/js/sync.js        phone ↔ PC sync      data/               everything the PC stores
app/index.html        phone app            app/js/segment.js   lines, letters, words
app/train.html        AI trainer           app/js/align.js     match letters to the text
app/js/reference.js   mezuzah text         app/js/problems.js  cracks, spots, touching
app/js/pipeline.js    whole check          app/js/nn.js        the small AI
app/js/library.js     learning library     app/js/camera.js    live camera helper
app/js/spots.js       marked places        app/js/i18n.js      Hebrew / English
```
