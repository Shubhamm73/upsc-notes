# UPSC Study Notes — project handoff (read this first)

Offline-first study-notes PWA for one UPSC aspirant (owner's brother) on a **Samsung Galaxy Tab S8**.
Owner: Shubham (GitHub `Shubhamm73`). Live: https://shubhamm73.github.io/upsc-notes/ (GitHub Pages via Actions on push to `main`).
Current version: **0.8.1 (UI-3 done: review & recall; backup/install reminders moved off the home screen)**. Next: **UI-4 — S Pen & finishing** (after the UI-3 gate: a week of real review sessions on the tablet, nothing lost).

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
src/db.ts              Dexie schema v3 (notes, vocab, images, meta, cards); SUBJECTS; RENAMED_SUBJECTS (CSAT→Interview)
src/views/today.ts     Today home: greeting, streak, due card (one queue + chips), continue writing, subject rings, quick capture
src/views/review.ts    review session (#/review): card faces, flip, swipe, keys, undo, summary
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
src/lib/               backup, storage (persist), dates (review intervals 1,3,7,16,35), insights (+ key lines with paragraph context), trash, prefs, activity (streak, milestones, last note),
                       schedule (steps, Again/Hard/Easy), cards (pure card sync, used by the Dexie upgrade), review (queue, session, rateItem, reviewNote), rings (subject rings),
                       subjects (colour vars), icons, h (DOM builder), doc (text, search text, word count, callouts), callouts, templates, menu (popover)
scripts/smoke-test*.py Playwright checks (run against `npx vite preview --port 4173`)
```

Routes: `#/` Today · `#/review` (`/insights`, `/words`, `/notes`) · `#/notes` (`/due`, `/s/<subject>`) · `#/n/<id>` · `#/n/new` (template picker) / `#/n/new/<template>` (gs-answer, topic-sheet, current-affairs, blank) · `#/vocab` (`/due`) · `#/v/<id>` · `#/more` · `#/prefs` · `#/settings` · `#/trash`.

## Commands
```
npm ci
npm run build                       # tsc + vite build
npx vite preview --port 4173 &      # then:
for t in smoke-test smoke-test-m2 smoke-test-m3 smoke-test-m4 smoke-test-m5 smoke-test-ui1 smoke-test-ui2 smoke-test-ui3; do python3 scripts/$t.py; done
```
Python deps: playwright, pypdf, Pillow; `pdftotext` for the PDF test. In the cloud container pin `pip install playwright==1.56.0` (matches the pre-installed Chromium build 1194; newer pip versions look for a browser that isn't there).
0.8.1 baseline: 8 suites, 300 checks, all passing; upgrade test 31 checks from 0.7.1 (09379bc) and from 0.8.0 (144da24): v2 → v3 keeps every note, word, image, quick insight and setting byte-for-byte, and a 0.7.1 backup imports intact (fresh and upgraded tablet, no duplicate cards).

**Upgrade test** (run it every release, and above all for any schema change): an installed previous release
updates to this build on one browser profile, nothing lost, nothing rewritten. It starts/stops its own servers on 4173.
```
git worktree add /tmp/prev <previous-release-commit> && cd /tmp/prev && ln -s <repo>/node_modules . && npm run build
cd <repo> && npm run build && python3 scripts/upgrade-test.py /tmp/prev
```
Stop a preview server with `fuser -k 4173/tcp`. Never `pkill -f "vite preview"`: the pattern matches the shell running it and kills that.
The live site (shubhamm73.github.io) is on the cloud environment's allowed domains: after a deploy, run the suites against it
by swapping `URL` to `https://shubhamm73.github.io/upsc-notes/`.

## Done so far
M1 offline foundation · M2 rich editor (sections, lists incl. dash, tables, resizable images, charts) · M3 vocabulary · M4 PDF export (section/note/all) · v0.5 quick insights from highlights on Mark reviewed, CSAT→Interview, trash + permanent delete, unified search, inline link box · **UI-1**: day/night/system themes, subject colour system, 6 font styles (app-wide + per-note), rail/bottom-bar shell, Today screen, streak, quick capture, Ctrl+K search, More/Settings.

**UI-2 (0.7.0)**: full-page writing canvas, templates, slash menu, floating toolbar, touch bar, focus mode, UPSC callouts, outline rail, GS answer meter, live key-line count, UI-2 motion. Details below.

**0.8.1**: the owner asked for no warning banners over the home screen. The backup and install reminders now live only in More (the Backup & storage row turns into "No backup yet. Back up now." / "Last backup N days ago." in warning colour once there are notes and no backup for > 7 days) and in Backup & storage ("Last backup: never." in warning colour, Install section). The only app-wide banner left is "A new version is ready → Reload now": keep it, it's how updates reach the tablet (`registerType: 'prompt'`).

**UI-3 (0.8.0)**: review cards for quick insights (Dexie v3), one Today queue, full-screen review session (insight / word / whole-note cards, Again / Hard / Easy, swipes, keys, undo, summary with rings), streak moments at 7/30/100 with a Settings switch, backup format 2. Details below.

## UI-3 as built (things to know)
- **Data (Dexie v3, `SCHEMA_VERSION` 3)**: new `cards` table (`id, noteId, due`), one `ReviewCard` per quick insight: `text`, `key` (lowercased, spaces collapsed), `section`, `pos`, `before`/`after` (rest of the paragraph, for the blanked front), `step` (index into 1,3,7,16,35; -1 = never), `due`, `reps`, `lapses`, `lastReviewed`, `retiredAt`. Notes and words got an unindexed `reviewStep?` (and words `lastReviewed?`), written only when next reviewed; when absent it's read as `reviewCount − 1` (`stepOf`), so the upgrade rewrites **no** note or word. `upgrade()` only creates cards from each note's `insights.items`, on the note's own step and `nextReview`.
- **Card identity** (`lib/cards.ts planCardSync`, pure, also used by `upgrade()`): id = `noteId:hash(key)` when created, never changed after. Sync runs only when insights are rebuilt (Mark reviewed, Hard/Easy on a note, upgrade, import), never on edits. Same key → same card (a retired one comes back with its history). A new line ≥ 0.6 word-overlap (Dice) with a card whose line just vanished takes over that card (edited highlight keeps its history). A vanished line → card **retired, never deleted**. Two live cards with one key → the less recently reviewed is retired. New cards: step 0, due tomorrow; seeded (upgrade/import) cards: the note's step and next review. Only "Delete forever" / Empty trash / trash purge delete a note's cards.
- **Ratings** (`lib/schedule.ts`): Again = due today, step → min(step, 0) (a never-reviewed item stays new, so forgetting never lengthens its first gap), back 3 cards later; Hard = same step (min 0); Easy = step + 1 (max 35 days). Buttons show the real result ("in 3 days"). Hard/Easy add to `reviewCount`/`reps`; Again adds a lapse. **Every** rating logs the streak day; undo of the day's only rating takes it (and its milestone) back. Mark reviewed (note and word) = Easy.
- **One note-review path**: `reviewNote()` in `lib/review.ts` does the note's review fields + insight rebuild + card sync in **one transaction**; the note's Mark reviewed button and session ratings both use it (Mark reviewed saves the draft first, then copies the review fields back into the open draft). Never re-implement it in a view.
- **Session** (`#/review`, `/insights` `/words` `/notes` from the Today chips): every due note (never capped) + the 40 most overdue key lines and words; insights and words alternate, notes last; "Keep going (N more)" in the summary. Each rating is written at once (`rateItem` reads the stored record fresh, so a note re-sync earlier in the session is never overwritten). Undo = header button or Ctrl+Z, one level, restores the exact records (and deletes cards that rating created).
- **Faces**: insight = subject · "Insight card" · note title · section · paragraph with a blank (or "Key line 2 of 4 in this section" when the whole paragraph is marked) / back: the line + "Marked on … · reviewed N times · Open note". Word = the word / meaning, sentences, synonym and antonym chips. Note = title + "Explain it in your own words" / his Explain text + the note in **read-only TipTap editors** (`createEditor({ editable: false })`, `onChange` is a no-op; the session never writes note text).
- **Input**: Show answer (64 px), tap the card, swipe up, Space/Enter. Rate: 76 px buttons, 1/2/3, ←/→, swipe left = Again / right = Easy past 30 % width or a 40 px flick (Hard is button-only). Swipes from within 24 px of the screen edge (Android back), from inside tables/charts, and mouse drags over the note's text don't count. Esc ends (summary, or Today if nothing rated). Keys typed in a field or with the Ctrl+K search open are ignored.
- **Motion**: flip = 120 ms to edge-on, swap, 120 ms back; slide-out 200 ms is a fixed-position **clone** (`.rv-ghost`) so the next card settles in (200 ms) at the same time; summary rings: the gained arc (`.ring-gain`) rotates into place 300 ms; streak number rolls up 300 ms. All transform/opacity, none under reduced motion.
- **Streak moments**: `logReviewDay()` returns `{ added, milestone }`; 7/30/100 is shown once per streak (`meta.streakMilestones = { start, shown }`) as a quiet line in the summary (a toast after Mark reviewed). Switch: Settings → Appearance → "Streak moments" (localStorage `upsc.celebrate`, per device like theme/font).
- **Backup format 2** (schemaVersion 3): adds `cards` (retired too) and `meta.reviewDays`. 0.7.1 refuses a format-2 file ("made by a newer version") instead of dropping cards. Import accepts 1 and 2; cards merge by id (newer `updatedAt`), cards are validated field by field (a bad one = nothing imported), review days merge as a union, and every note the import wrote gets `syncNoteCards(seed)` **inside the import transaction**, so a format-1 file gets its cards and importing twice adds none.

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
- **0.7.1 fix**: `setEditable(false)` makes TipTap emit an "update" event by default, which the app took as an edit, so *leaving* any note re-saved it with a new `updatedAt` (since 0.6). Now `setEditable(false, false)`. Any code that calls editor methods must not trigger `onChange` without a real change; `smoke-test-ui2` and `upgrade-test` check `updatedAt` survives open + leave.
- **Test gotcha**: ProseMirror reads keyboard-driven selection changes on `selectionchange`, a beat after the key. Playwright's instant Home/Arrow/End/Enter sequences race it. The smoke tests therefore select text with a DOM range (`select_text`/`mark` helpers) and move to paragraph end by range, then wait ~100–150 ms. Don't "fix" this in the app; real input is never that fast. Likewise, a selection set within ~2 ms of the last typed key is put back by the editor, so `select_text` waits 150 ms first.
- **More test gotchas**: notes seeded with raw IndexedDB (bypassing Dexie) don't reach the live list until reload. `wait_for_selector("a, b")` waits on the *first* match, even if it's hidden.
- **UI-3 gotchas (each one bit once)**:
  - Chrome drops the `click` of a tap that lands while the previous swipe's fling is settling. A quick tap on the next card did nothing (5/5 in the stress loop). The card reveals on a short, still pointerdown→up instead; `click` stays as the keyboard/AT fallback.
  - The rating buttons appear at the flip's midpoint; the view was still `busy` for the last 120 ms and dropped the tap (10/10). The second half of the flip is now cosmetic; a rating cancels it (`stopMotion`).
  - Ctrl+Z pressed while a rating was still being written was dropped (10/10). It is now queued (`saving` / `undoAsked`) and runs when the write finishes; `undo()` also bumps `token` so a loading summary can't paint over the restored card.
  - Never give the card a class that is also a component class: `rv-word` / `rv-note` on the card made every card 40 px text. Card types are `is-insight` / `is-word` / `is-note`.
  - Tests pin time with `page.clock.set_fixed_time()` (Date only; timers keep running), then reload to "move to the next day". A full-line highlight is inclusive, so a test that types the next line after marking one carries the highlight on: type first, mark after.
  - The animation checks wrap `Element.prototype.animate` in an init script (`window.__anims`) instead of polling `getAnimations()`, which races 120–300 ms animations.

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

### UI-3 — Review & recall ✅ done in 0.8.0 (see "UI-3 as built" above)
Today queue → full-screen **review session**: one card at a time; card types: insight (front = note title + section, back = highlighted line), vocabulary, whole note. Ratings **Again / Hard / Easy** (Again = later in session, Hard = keep interval, Easy = next interval); swipe left/right or 64 px buttons; session summary (items, time, streak, subjects). Per-card review state must be stored and carried in backups (new Dexie version). Streak celebrations at 7/30/100 days, quiet; motion spec below.

Decisions taken at build time (owner, 12 Oct 2026): whole-note card has Again/Hard/Easy (Easy = Mark reviewed); insight front blanks the line inside its paragraph; backup format 2; one-level undo; Settings switch for streak moments; session = 40 key lines/words + every due note; smoke-test-ui1's Start review checks now follow the session.

### UI-4 — S Pen & finishing (Opus medium for sketch, Sonnet medium for rest) ← NEXT
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
- Precache ≈ 2.98 MB (pdfmake + fonts).
- Subject rings count notes only (reviewed and not overdue), so insight and word cards don't move them; the summary rings only change when a note card is rated.
- Rating a note (or Mark reviewed) changes its `updatedAt`, so Today's "Continue writing" may show it as "Edited just now" when no note was opened since.
- Highlight is an inclusive mark: typing right after a highlighted run continues the highlight (unmark with the toolbar or Ctrl+Shift+H).
- Backup is a file, not an account link: Save to Downloads, or Share → the Android share sheet → Google Drive (the Drive app uses whatever Google account is signed in on the tablet). There is no automatic sync and no Google sign-in in the app (local-only rule). A direct "Back up to my Drive" button would need Google sign-in (Google Identity Services + Drive API `drive.file` scope, a Google Cloud OAuth client owned by the owner); not built, owner to decide.
- `git remote` may print "repository moved" — canonical URL is https://github.com/Shubhamm73/upsc-notes.git.
