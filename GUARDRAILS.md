# Guard rails — UPSC Notes (binding for Claude Code and Codex)

**At risk:** the brother's notes, vocabulary, images and cards on his tablet (IndexedDB via Dexie, schema v4 in `src/db.ts`) and their Google Drive backups. **Pushing to `main` deploys to his tablet through GitHub Pages.** The full project guide is `CLAUDE.md`; read the parts relevant to the task.

## Free zone (edit without asking)
- Visual polish in `src/styles.css` and view rendering in `src/views/*` that does not change how notes are stored; copy text; new tests.

## Ask first (state the change and why, wait for the user's yes)
- Editor behaviour (`src/editor/*`), settings, PDF output, PWA/service worker, `vite.config.ts`, npm dependencies, version bump.

## Never touch without the user's explicit yes (user rule 2026-10-25: Codex does the build work here too)
With a yes: the brief requires the upgrade test; Codex builds the change; Claude judges the diff line by line. No yes: nobody edits.
- `src/db.ts` (schema, tables, `RENAMED_SUBJECTS`), `src/lib/backup.ts`, `src/lib/storage.ts`, `src/lib/trash.ts`, `src/lib/drive*.ts`, `src/views/drive-ui.ts`, the import/merge path, "delete forever" in `src/views/trash.ts`.
- `git push` or any deploy. Never `pkill -f "vite preview"` (stop a server with `lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill`).

## Verify before handing back
`npm run build` and the test suites described in `CLAUDE.md` (baseline 0.18.0: 27 suites, 1536 checks, all pass). Any change near the data layer additionally needs the upgrade test in `CLAUDE.md` (Claude runs it).

## Release
The user approves, then Claude (or the user) pushes. Keep this file and STATE.md out of git: they are listed in `.git/info/exclude` (public repo).
