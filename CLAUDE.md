# UPSC Study Notes — project handoff (read this first)

Offline-first study-notes PWA for one UPSC aspirant (owner's brother) on a **Samsung Galaxy Tab S8**.
Owner: Shubham (GitHub `Shubhamm73`). Live: https://shubhamm73.github.io/upsc-notes/ (GitHub Pages via Actions on push to `main`).
Current version: **0.14.0 (Themes and templates, R6 of the six-asks plan; R1–R6 all done)**. Next: **UI-4 U4-2 Mark with the pen** (see the UI-4 plan in the roadmap; versions renumber from 0.15).

**Read this before doing anything: the work order is the "Six-asks plan" table below (R1–R6), then the rest of UI-4.** On 13 Oct 2026 the six-asks plan (UPSC Notes Redesign Plan artifact) recommended moving UI-4 after the six asks, but this file was written with the UI-4 plan instead, so 0.9.0 built Sketch and the next session started UI-4 step 2 again. The owner confirmed (13 Oct 2026, "go ahead with the recommended plan steps"): six asks first, every recommended decision, UI-4 U4-2…U4-4 after them. Sketch (0.9.0) stays.

## Non-negotiable rules
- **Local-only data.** Notes, words, images live in IndexedDB (Dexie) on the device. No server storage, no accounts, no login. GitHub Pages serves code only. **Approved exception, built in 0.11 (R3)**: optional Google sign-in for backup only, files go from the tablet straight to his own Google Drive (`drive.file` scope); never any server of ours.
- **Never lose data.** Autosave (~0.8 s debounce, flush on hide/pagehide), backup JSON (Downloads or share sheet → Google Drive), import merges by id keeping newer `updatedAt` and never deletes. Any schema change = new Dexie version with an `upgrade()` + map old data in `importBackup`.
- **Touch-first**: targets ≥ 44 px (primary 56 px); works by touch alone; keyboard + S Pen optional extras.
- **Motion ≤ 300 ms**, transform/opacity only, respect `prefers-reduced-motion`.
- **English only.** Hindi and paper-grain texture were explicitly dropped by the owner.
- Every phase: add a smoke test, run ALL smoke tests, bump `package.json` version (0.7, 0.8 …), commit, push, watch the Pages deploy.
- Owner prefers: direct disagreement when he's wrong, structured answers (tables/bullets), state your understanding before big builds, solutions not lectures.

## Stack and layout
Vite 8 + TypeScript (vanilla, no framework), vite-plugin-pwa (generateSW, `registerType: 'prompt'`), Dexie 4, TipTap 3 (`@tiptap/*` 3.31.3), pdfmake 0.3 (lazy-loaded); charts, diagrams and mind maps are the app's own SVG (Chart.js dropped in 0.13), fontsource fonts (Latin subsets). `base: '/upsc-notes/'`.

```
src/main.ts            fonts, applyAppearance(), SW registration
src/app.ts             shell: icon rail (≥900px) / bottom bar, routes, banners, Ctrl+K / Ctrl+N
src/db.ts              Dexie schema v4 (notes, vocab, images, meta, cards, folders); SUBJECTS; RENAMED_SUBJECTS (CSAT→Interview)
src/views/today.ts     Today home: greeting, streak, due card (one queue + chips), continue writing, subject rings, quick capture
src/views/review.ts    review session (#/review): card faces, flip, swipe, keys, undo, summary
src/views/notes.ts     notes folders (Notes › main subject › subject, Recent, search, due list, Edit, Move to…) + writing canvas (template picker, header, chips, sections, outline rail, focus mode, meter, review, details)
src/views/vocab.ts     vocabulary folders (month › date, Add word to today) + word form (word, meaning, uses w/ context, synonyms/antonyms chips, review, Move to another date)
src/views/folder-ui.ts breadcrumb, folder card grid, Edit mode (rename, red −, drag handle: pointer + arrow keys), shared by notes and words
src/views/trash.ts     trash: restore, delete forever (type DELETE), empty trash
src/views/settings.ts  Backup & storage (Google Drive section, backup file, PDF of everything, import)
src/views/drive-ui.ts  Drive screens: connect (sign-in → folder → schedule → first backup), Back up now, Change schedule, restore list, Disconnect; Today's restore card; finishing a full-page sign-in
src/views/appearance.ts Settings (#/prefs): theme tiles (system + 9 themes + Custom: accent, roundness, density) + 6 font styles
src/views/more.ts      More menu;  src/views/search.ts  Ctrl+K overlay
src/editor/            editor.ts (TipTap setup, dash-list attr, active-block + mark-sweep decorations, slash hook)
                       table.ts (styled table card, figure columns, resize), heading-look.ts, panel.ts (containers), look-tools.ts (Style panel, table dialog, size popover, container sheet)
                       tools.ts (slash/+ insert menu, floating toolbar + link box, context bar, touch bar, highlight sweep)
                       insert.ts (insert items + list/block helpers), callout.ts (callout node, PYQ details), image-block.ts, images.ts
                       chart-block.ts, diagram-block.ts, mindmap-block.ts, mindmap-editor.ts (full-screen), gallery.ts (Insert → Chart), figure-kit.ts
                       paste.ts, flow.ts (text on every side of a picture), crop.ts (Crop & shape screen), history.ts (note-wide Undo/Redo),
                       sketch-block.ts (Sketch node view: pen input, palm rejection, tools strip)
src/pdf/               export.ts (section / note / all → pdfmake), run.ts
src/lib/               drive-config (owner's public Google values), drive (GIS popup / full-page sign-in, token, Drive REST: folder, resumable upload, list, download, trash, Picker),
                       drive-backup (schedule, backup run, keep last 10 + guard, restore, next-tap renewal), changes ("big change" event),
                       backup, storage (persist), dates (review intervals 1,3,7,16,35), insights (+ key lines with paragraph context), trash, prefs, activity (streak, milestones, last note),
                       schedule (steps, Again/Hard/Easy), cards (pure card sync, used by the Dexie upgrade), review (queue, session, rateItem, reviewNote), rings (subject rings),
                       folder-plan (pure: fixed folder ids, where a note/word shows, planFolders used by upgrade, launch and import), folders (FolderIndex, add/rename/reorder/delete, last subject used),
                       sheet (centred dialog), icons, h (DOM builder), doc (text, search text, word count, callouts, captions), callouts, templates (19 built-in, 5 groups), my-templates (Save as template, meta `templates`), note-look (cover, heading set, accent; defaults in meta `looks`), themes (9 + Custom, tokens), menu (popover),
                       shapes (picture shapes: CSS clip-path, canvas path for the PDF, crop maths),
                       sketch (stroke code, colours, drawing, eraser hit test, PNG for the PDF; pure, shared by screen and PDF)
                       looks (colours, heading looks, containers, table styles, figure columns; pure), my-styles (saved styles, Same as last),
                       svg-ink (screen/print ink, palettes), charts / diagrams / mindmap (pure: data, samples, layout, → SVG string; shared by screen, gallery and PDF)
scripts/smoke-test*.py Playwright checks (run against `npx vite preview --port 4173`)
```

Routes: `#/` Today · `#/review` (`/insights`, `/words`, `/notes`) · `#/notes` (main subjects) · `#/notes/f/<folder id>` (a main subject or a subject; ids URI-encoded, e.g. `main%3AGS1`) · `#/notes/due` · `#/notes/s/<subject>` (0.6–0.9 links → `main:<subject>`) · `#/n/<id>` · `#/n/new` (template picker) / `#/n/new/<template>` (any of the 19 ids, or `my:…`) · `#/vocab` (months) · `#/vocab/f/<wm:YYYY-MM | wd:YYYY-MM-DD>` · `#/vocab/due` · `#/v/<id>` · `#/more` · `#/prefs` · `#/settings` · `#/trash`.

## Commands
```
npm ci
npm run build                       # tsc + vite build
npx vite preview --port 4173 &      # then:
for t in smoke-test smoke-test-m2 smoke-test-m3 smoke-test-m4 smoke-test-m5 smoke-test-ui1 smoke-test-ui2 smoke-test-ui3 smoke-test-paste smoke-test-canvas2 smoke-test-sketch smoke-test-share smoke-test-folders smoke-test-drive smoke-test-inline smoke-test-tables smoke-test-looks smoke-test-charts smoke-test-diagrams smoke-test-mindmap smoke-test-templates smoke-test-themes; do python3 scripts/$t.py; done
scripts/run-suites.sh               # the same, starts/stops the preview itself, prints totals; LIVE=1 for the live site; on macOS adds scripts/linux-shim
```
Python deps: playwright, pypdf, Pillow; `pdftotext` for the PDF test. In the cloud container pin `pip install playwright==1.56.0` (matches the pre-installed Chromium build 1194; newer pip versions look for a browser that isn't there).
0.14.0 baseline: 22 suites, 1292 checks, all passing (smoke-test-templates adds 144, smoke-test-themes 107); upgrade test from 0.13.0 (73ff19d): 60 checks, all passing, 4 runs in a row. It now proves an old theme "night" is still Night, the update writes no look or template, the new build's backup is format 8 with theme, note look, template and look default (a fresh tablet takes all four), the 0.13 build refuses format 8 and stores nothing, and 0.13 opens a 0.14 note editable and an edit there keeps `note.look` byte-for-byte.
0.13.0 baseline was: 20 suites, 1041 checks, all passing (smoke-test-charts adds 57, smoke-test-diagrams 62, smoke-test-mindmap 68; ui3 +1: a selection made just before the highlight sweep ends is kept); upgrade test from 0.12.0 (33a36de): 56 checks, all passing, 4 runs in a row. It now proves the upgraded tablet's backup is format 7, and that the 0.12 build refuses a format-7 backup, stores nothing, and opens a 0.13 note read-only without changing it. The 0.12 worktree needs its own `npm ci` (Chart.js is no longer in our node_modules).
0.12.0 baseline was: 17 suites, 853 checks, all passing (smoke-test-tables adds 68, smoke-test-looks 83); upgrade test from 0.11.0 (039257d): 56 checks, all passing, 4 runs in a row (from 0.10.0 (c1328e6): 53). It now also proves an upgraded tablet's backup is format 6 with no saved styles, and that the 0.11 build refuses a format-6 backup, stores nothing, and opens a 0.12 note read-only (its "newer version" notice in place of the section) without changing it.
0.11.0 baseline was: 15 suites, 702 checks, all passing (smoke-test-drive adds 80, smoke-test-inline 26, canvas2 +1: a heading beside a picture, then ↓ Below picture); upgrade test from 0.10.0 (c1328e6): 52 checks, all passing, 4 runs in a row (from 0.9.1 (6f13571): 54). It now also proves his device settings survive the update, the upgraded tablet's format-5 backup carries them and every record (a fresh tablet takes both), and the old build refuses format 5 and stores nothing.
0.10.0 baseline was: 13 suites, 595 checks, all passing (smoke-test-folders adds 88); upgrade test from 0.9.1 (6f13571): 48 checks, all passing, 4 runs in a row (from 0.9.0 (7d85b13) also 48). From a 0.9+ old build it first loads a real-size tablet (220 notes, 1,100 words, 30 pictures, 147 cards) through the old build's own Import.
0.9.1 baseline was: 12 suites, 507 checks (smoke-test-share adds 18); upgrade test from 0.9.0 (7d85b13): 31 checks (the 3 "an old build refuses a sketch backup" checks run only when the old build is below 0.9.0).
0.9.0 baseline was: 11 suites, 489 checks, all passing (smoke-test-sketch adds 83); upgrade test from 0.8.3 (865b995): 34 checks (adds: the old build refuses a 0.9 backup and stores nothing).
0.8.3 baseline was: 10 suites, 406 checks (smoke-test-canvas2 adds 79); upgrade test from 0.8.2 (3be8bd7): 31 checks.
0.8.2 baseline was: 9 suites, 327 checks, all passing; upgrade test from 0.8.1 (4f17a05): 31 checks. 0.8.1 baseline was: 8 suites, 300 checks; upgrade test 31 checks from 0.7.1 (09379bc) and from 0.8.0 (144da24): v2 → v3 keeps every note, word, image, quick insight and setting byte-for-byte, and a 0.7.1 backup imports intact (fresh and upgraded tablet, no duplicate cards).

**Upgrade test** (run it every release, and above all for any schema change): an installed previous release
updates to this build on one browser profile, nothing lost, nothing rewritten. It starts/stops its own servers on 4173.
```
git worktree add /tmp/prev <previous-release-commit> && cd /tmp/prev && ln -s <repo>/node_modules . && npm run build
cd <repo> && npm run build && python3 scripts/upgrade-test.py /tmp/prev
```
Stop a preview server with `fuser -k 4173/tcp`. Never `pkill -f "vite preview"`: the pattern matches the shell running it and kills that.
The live site (shubhamm73.github.io) is on the cloud environment's allowed domains: after a deploy, run the suites against it
by swapping `URL` to `https://shubhamm73.github.io/upsc-notes/`.


## Where the rest lives (read on demand, not every session)
- `docs/roadmap.md`: approved roadmap, Six-asks plan table (R1-R6), UI-4 plan, motion spec. READ before starting any release. **Next up: UI-4 U4-2 (0.15) Mark with the pen.**
- `docs/history.md`: "Done so far" and the "as built" gotchas for R5, R4, R3, R2, U4-1, UI-3, UI-2. Read the matching section before changing that feature.
- Where the roadmap says "update this file", do: as-built notes -> `docs/history.md`; tick the step -> `docs/roadmap.md`; version and "Next" line -> the header of this file. Keep this file short.

## Reference documents (claude.ai artifacts, owner's account)
- **UPSC Notes Redesign Plan (the six asks, 13 Oct 2026; current work order)**: https://claude.ai/artifact/YA51kuXRmKJg1KN56w4HJR
- Design & deployment plan: https://claude.ai/code/artifact/18300a71-5a98-4c0d-9726-ed89b2ac3732
- UI redesign plan (sections 1–9, approved): https://claude.ai/code/artifact/6f3dba36-5e4c-41b2-ad68-726fbe4691ef
- UI-0 mockups (Today, writing canvas, review card, note list; day/night): https://claude.ai/artifact/4k13PnRV9qeBR1MD72uLnt
- The earliest artifact version (server-stored notes) is obsolete — never give it to the brother.

## Known limits
- PDF engine can't shape complex scripts (Hindi dropped anyway). PDF table columns are equal width unless dragged to widths on screen (then proportional).
- Sketches: the eraser removes whole strokes (no partial rub-out); no pinch-zoom inside a sketch; beside the outline rail on the Tab S8 the sketch tools wrap to two rows. The S Pen hover / no-scroll behaviour, real pressure range and side-button reporting are emulated in tests and must be confirmed on the tablet.
- Text follows a picture's shape on screen only; the PDF wraps beside its box. Undo history is per open note (ends when the note closes).
- Precache ≈ 3.07 MB (pdfmake + fonts; 0.13 dropped Chart.js but added its own chart, diagram and mind-map code).
- Subject rings count notes only (reviewed and not overdue), so insight and word cards don't move them; the summary rings only change when a note card is rated.
- Folders (0.10): notes inside a subject are listed newest edit first (no manual order); words have no Review-these-words button per date (the review session still takes every due word); a word is moved by date only (no Move to… across a list); dates and months sort themselves (no drag). Deleted folders are kept as small records forever (they stop a merge from bringing them back). "Add word to today" makes today's date folder even if he then leaves the word empty (an empty date can be deleted in Edit).
- Rating a note (or Mark reviewed) changes its `updatedAt`, so Today's "Continue writing" may show it as "Edited just now" when no note was opened since.
- Highlight is an inclusive mark: typing right after a highlighted run continues the highlight (unmark with the toolbar or Ctrl+Shift+H).
- Drive backup (0.11) runs only while the app is open and online (a website can't wake itself); it is a backup, not a sync (two tablets don't merge each other automatically: Restore merges on demand). The Google token lasts ~1 h; renewal needs a tap (popup) or a launch (full-page sign-in). The real Google sign-in, the popup inside the installed app, the Picker and the real Drive were not reachable from the test container (GIS and Drive are stubbed in `smoke-test-drive.py`; the client ID, redirect address and Drive's CORS were checked with curl): **confirm on the tablet**. Backup file by hand (Save to Downloads, Share) still works.
- `git remote` may print "repository moved" — canonical URL is https://github.com/Shubhamm73/upsc-notes.git.
