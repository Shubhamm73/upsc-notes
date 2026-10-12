# UPSC Study Notes — project handoff (read this first)

Offline-first study-notes PWA for one UPSC aspirant (owner's brother) on a **Samsung Galaxy Tab S8**.
Owner: Shubham (GitHub `Shubhamm73`). Live: https://shubhamm73.github.io/upsc-notes/ (GitHub Pages via Actions on push to `main`).
Current version: **0.7.0 (UI-2 done)**. Next: **UI-3 — review & recall** (after the UI-2 gate: a week of real notes in the canvas, nothing lost).

## Non-negotiable rules
- **Local-only data.** Notes, words, images live in IndexedDB (Dexie) on the device. No server storage, no accounts, no login. GitHub Pages serves code only.
- **Never lose data.** Autosave (~0.8 s debounce, flush on hide/pagehide), backup JSON (Downloads or share sheet → Google Drive), import merges by id keeping newer `updatedAt` and never deletes. Any schema change = new Dexie version with an `upgrade()` + map old data in `importBackup`.
- **Touch-first**: targets ≥ 44 px (primary 56 px); works by touch alone; keyboard + S Pen optional extras.
- **Motion ≤ 300 ms**, transform/opacity only, respect `prefers-reduced-motion`.
- **English only.** Hindi and paper-grain texture were explicitly dropped by the owner.
- Every phase: add a smoke test, run ALL smoke tests, bump `package.json` version (0.7, 0.8 …), commit, push, watch the Pages deploy.
- Owner prefers: direct disagreement when he's wrong, structured answers (tables/bullets), state your understanding before big builds, solutions not lectures.

## Stack and layout
Vite 8 + TypeScript (vanilla, no framework), vite-plugin-pwa (generateSW, `registerType: 'prompt'`), Dexie 4, TipTap 3 (`@tiptap/*` 3.31.3), Chart.js 4, pdfmake 0.3 (lazy-loaded), fontsource fonts (Latin subsets). `base: '/upsc-notes/'`.

```
src/main.ts            fonts, applyAppearance(), SW registration
src/app.ts             shell: icon rail (≥900px) / bottom bar, routes, banners, Ctrl+K / Ctrl+N
src/db.ts              Dexie schema v2 (notes, vocab, images, meta); SUBJECTS; RENAMED_SUBJECTS (CSAT→Interview)
src/views/today.ts     Today home: greeting, streak, due card, continue writing, subject rings, quick capture
src/views/notes.ts     notes list + writing canvas (template picker, header, chips, sections, outline rail, focus mode, meter, review, details)
src/views/vocab.ts     vocabulary (word, meaning, uses w/ context, synonyms/antonyms chips, review)
src/views/trash.ts     trash: restore, delete forever (type DELETE), empty trash
src/views/settings.ts  Backup & storage + "PDF of everything"
src/views/appearance.ts Settings: theme (system/day/night) + 6 font styles
src/views/more.ts      More menu;  src/views/search.ts  Ctrl+K overlay
src/editor/            editor.ts (TipTap setup, dash-list attr, active-block + mark-sweep decorations, slash hook)
                       tools.ts (slash/+ insert menu, floating toolbar + link box, context bar, touch bar, highlight sweep)
                       insert.ts (insert items + list/block helpers), callout.ts (callout node), image-block.ts, chart-block.ts, images.ts
src/pdf/               export.ts (section / note / all → pdfmake), run.ts
src/lib/               backup, storage (persist), dates (review intervals 1,3,7,16,35), insights (+ per-section key lines), trash, prefs, activity (streak, last note),
                       subjects (colour vars), icons, h (DOM builder), doc (text, search text, word count, callouts), callouts, templates, menu (popover)
scripts/smoke-test*.py Playwright checks (run against `npx vite preview --port 4173`)
```

Routes: `#/` Today · `#/notes` (`/due`, `/s/<subject>`) · `#/n/<id>` · `#/n/new` (template picker) / `#/n/new/<template>` (gs-answer, topic-sheet, current-affairs, blank) · `#/vocab` (`/due`) · `#/v/<id>` · `#/more` · `#/prefs` · `#/settings` · `#/trash`.

## Commands
```
npm ci
npm run build                       # tsc + vite build
npx vite preview --port 4173 &      # then:
for t in smoke-test smoke-test-m2 smoke-test-m3 smoke-test-m4 smoke-test-m5 smoke-test-ui1 smoke-test-ui2; do python3 scripts/$t.py; done
```
Python deps: playwright, pypdf, Pillow; `pdftotext` for the PDF test. In the cloud container pin `pip install playwright==1.56.0` (matches the pre-installed Chromium build 1194; newer pip versions look for a browser that isn't there).
0.7.0 baseline: 7 suites, 190 checks, all passing.

## Done so far
M1 offline foundation · M2 rich editor (sections, lists incl. dash, tables, resizable images, charts) · M3 vocabulary · M4 PDF export (section/note/all) · v0.5 quick insights from highlights on Mark reviewed, CSAT→Interview, trash + permanent delete, unified search, inline link box · **UI-1**: day/night/system themes, subject colour system, 6 font styles (app-wide + per-note), rail/bottom-bar shell, Today screen, streak, quick capture, Ctrl+K search, More/Settings.

**UI-2 (0.7.0)**: full-page writing canvas, templates, slash menu, floating toolbar, touch bar, focus mode, UPSC callouts, outline rail, GS answer meter, live key-line count, UI-2 motion. Details below.

## UI-2 as built (things to know)
- **Data**: `note.template?` (`gs-answer` | `topic-sheet` | `current-affairs`; absent = Blank) and the `callout` node (`attrs.kind`: article, case, data, example, wayforward; content = paragraphs/lists) inside `section.doc`. Neither is indexed, so **no Dexie version bump**; old notes and old backups load unchanged, and `importBackup` passes both through. Opening a note never rewrites it (tested). The next real schema change (UI-3 review state) still needs a new Dexie version + upgrade + import mapping.
- **Layout**: an open note is full-page at every width (`.notes-layout.is-notes`; vocab still uses the old two-pane rules). Header row: ← Notes · subject·topic · key-line pill · meter (GS answer only) · save state · Focus · **Mark reviewed** (in the header per the UI-0 mockup, not tucked away) · ⋯. Context bar (table / image / chart / callout tools) is a second header row that only appears in context. Column `max-width: 31em` ≈ 72 characters (`ch` measures "0" and gave ~85). `40vh` bottom padding so the outline can jump to the last section.
- **Tucked away**: "Reflect and settings" `<details>` at the bottom holds Explain, Connect, font style, note PDF, Move to trash. The outline's Reflect links open it.
- **Floating toolbar** (B I U Mark Link + inline link box): above the selection with a mouse, **below it (+34 px) on touch/pen** so Android's copy/paste menu doesn't cover it (`isTouchLike()` = last pointerType, else `(pointer: coarse)`).
- **Slash menu**: `/` at the start of an empty paragraph; filters by name then keywords; `/case` etc. jump straight to a callout kind; "Callout" opens a kind submenu; Sketch is a "coming soon" toast (UI-4). Esc keeps the typed text and doesn't reopen until the line changes.
- **Touch bar** (`(pointer: coarse) and (orientation: portrait)`, while an editor has focus): + (same insert list, plus Indent/Outdent in lists), Mark, List (bullets → dashes → numbers → off), Undo, Done. Rides above the keyboard via `visualViewport`; hides the bottom nav while shown. Landscape touch has no Undo button (spec); Ctrl+Z on the keyboard cover.
- **Outline rail** (≥1000 px wide): tap = jump; long-press 450 ms then drag = reorder; ⋯ per section = Collapse, Move up/down, **Export section as PDF**, Delete (two taps). Portrait: the same ⋯ menu is on each section heading. Collapse state is screen-only, not saved.
- **Focus mode**: Ctrl + . or the Focus button; Esc or "Exit focus" leaves. Esc/Ctrl+. are handled on `document` in the **capture** phase (the editor swallows Esc otherwise): one press closes a menu first, then focus mode.
- **Search**: `noteSearchText()` adds "<Kind> callout" for every callout, so Ctrl+K "case" lists notes with Case callouts first, showing the callout text. Highlights inside callouts count as key lines / quick insights.
- **Motion**: card → page 240 ms (WAAPI), save dot pulse → ✓ 160 ms, highlighter sweep 200 ms (overlay + a ProseMirror *decoration* hides the real mark; never mutate the editor's DOM directly, ProseMirror re-reads it and can reset the selection), Mark reviewed fly-up 300 ms, slash/popover fade + rise 4 px 120 ms. All transform/opacity, all off under reduced motion.
- **Test gotcha**: ProseMirror reads keyboard-driven selection changes on `selectionchange`, a beat after the key. Playwright's instant Home/Arrow/End/Enter sequences race it. The smoke tests therefore select text with a DOM range (`select_text`/`mark` helpers) and move to paragraph end by range, then wait ~100–150 ms. Don't "fix" this in the app; real input is never that fast.

Subject colours (day/night CSS vars `--sub-*`): GS1 ochre, GS2 indigo, GS3 teal, GS4 plum, Essay graphite, Interview rose, Current affairs vermilion, PSIR forest.
Callout colours (`--co-*`): Article blue, Case berry, Data teal, Example amber, Way forward green; PDF uses fixed day colours from `src/lib/callouts.ts`.
Font styles: Study desk (Source Serif 4 + Atkinson Hyperlegible, default), Editorial (Literata + Public Sans), Academic (EB Garamond + Libre Franklin), Clean professional (IBM Plex Serif + Sans), Notebook (Caveat + Nunito), Bold & friendly (Fraunces + Nunito). PDFs keep Roboto.

## Approved roadmap (all decisions confirmed by owner on 12 Oct 2026)
### UI-2 — Writing canvas ✅ done in 0.7.0 (see "UI-2 as built" below)
- Full-page canvas: 34–36 px serif title; subject/topic/template as small chips under it; ~72-char column; details tucked away.
- **Slash menu**: `/` at line start → Heading, Bullet, Dash, Numbered, Table, Chart, Image, Sketch (placeholder until UI-4), Callout, Divider; filters as you type; Enter inserts.
- **Floating toolbar** on text selection: Bold, Italic, Underline, **Mark** (highlight), Link. Replace the permanent 20-button toolbar.
- **Touch bottom bar** in portrait above the keyboard: + (insert), Mark, List, Undo, Done.
- **Focus mode** (Ctrl + .): hide everything but the text; dim non-active paragraphs.
- **Templates** on New note: GS answer (Intro, Body, Way forward), Topic sheet (Key terms, Articles and cases, Data, Examples), Current affairs (News, Background, Syllabus link, Prelims facts, Mains angle), Blank.
- **UPSC callouts** (new TipTap node): Article, Case, Data, Example, Way forward — icon + colour, exported to PDF, searchable.
- **Outline rail** (right edge, landscape): section headings, tap to jump, long-press drag to reorder, collapse sections; key-line count per section. Replaces ↑↓ buttons.
- **Answer-length meter** for GS answer template (150 / 250 word marks).
- **Live insight count** in header ("5 key lines") as highlights are added.
- Keep: autosave, sections data model (`note.sections[]` with TipTap JSON), quick insights, per-note font, PDF export of all new blocks.
- Gate: a week of real notes in the new canvas, nothing lost.

### UI-3 — Review & recall (Opus, high) ← NEXT
Today queue → full-screen **review session**: one card at a time; card types: insight (front = note title + section, back = highlighted line), vocabulary, whole note. Ratings **Again / Hard / Easy** (Again = later in session, Hard = keep interval, Easy = next interval); swipe left/right or 64 px buttons; session summary (items, time, streak, subjects). Per-card review state must be stored and carried in backups (new Dexie version). Streak celebrations at 7/30/100 days, quiet; motion spec below.

### UI-4 — S Pen & finishing (Opus medium for sketch, Sonnet medium for rest)
Sketch block (pressure, palm rejection, stored as image, in PDF), mark with the pen, optional haptics (setting), speed pass on a 5,000-word note, accessibility pass, PDF for new blocks.

### Motion spec (UI-2/UI-3)
Open note: card expands to page 240 ms · Save: dot pulse then ✓ 160 ms · Highlight: marker sweep 200 ms · Mark reviewed: highlighted lines fly up into Quick insights 300 ms · Slash menu: fade + rise 4 px 120 ms · Flashcard flip 240 ms · Rating: slide out 200 ms · Summary rings fill 300 ms · Delete forever: row collapse 160 ms, no celebration.

## Reference documents (claude.ai artifacts, owner's account)
- Design & deployment plan: https://claude.ai/code/artifact/18300a71-5a98-4c0d-9726-ed89b2ac3732
- UI redesign plan (sections 1–9, approved): https://claude.ai/code/artifact/6f3dba36-5e4c-41b2-ad68-726fbe4691ef
- UI-0 mockups (Today, writing canvas, review card, note list; day/night): https://claude.ai/artifact/4k13PnRV9qeBR1MD72uLnt
- The earliest artifact version (server-stored notes) is obsolete — never give it to the brother.

## Known limits
- PDF engine can't shape complex scripts (Hindi dropped anyway). PDF table columns are equal width.
- Precache ≈ 2.95 MB (pdfmake + fonts).
- Highlight is an inclusive mark: typing right after a highlighted run continues the highlight (unmark with the toolbar or Ctrl+Shift+H).
- `git remote` may print "repository moved" — canonical URL is https://github.com/Shubhamm73/upsc-notes.git.
