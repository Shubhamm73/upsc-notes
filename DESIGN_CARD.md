# Design card — UPSC Notes (distilled 2026-10-25 from `src/styles.css` and `CLAUDE.md`; those win on conflict)

**Feel:** a lit study desk with paper on it. Warm cream by day, deep slate by night; serif headings, a highly legible sans for writing; the note is a raised sheet of paper, sticky bars are frosted glass. Built for his tablet: touch and S Pen first, keyboard optional.

## Tokens (`:root` and `:root[data-theme='…']` in `src/styles.css`; 9 themes + Custom; never hard-code colours)
| Token | Day (default) | Night |
|---|---|---|
| `--bg` / `--surface` | #eeeae0 / #fffdf8 | #111519 / #1a1f25 |
| `--fg` / `--muted` | #1c1f24 / #5d636c | #ece8de / #a3aab4 |
| `--accent` / `--accent-fg` | #2d5b4e / #fffdf8 | #8ccbb8 / #10231d |
| `--line` / `--chip` / `--rail` | #ddd6c6 / #ebe6d9 / #e6e1d4 | #2c333c / #242a31 / #161b20 |
| `--warn-bg` / `--warn-fg` / `--error` / `--mark` | #fbecd9 / #7a3d12 / #a3261b / #fde68a | per theme |
- Subject colours `--sub-*`, callout colours `--co-*` and chart colours `--chart-1..6` are fixed sets: reuse them, never add one.
- Fonts: 6 styles of `--font-head` (serif: Source Serif 4, Literata, EB Garamond, IBM Plex Serif …) + `--font-body` (Atkinson Hyperlegible, Public Sans, Libre Franklin, IBM Plex Sans …), chosen in Settings. Style with the variables, never a font name.
- Radius `--r` (user "roundness" setting) and density come from Custom: use the variables so the setting keeps working.
- Depth (the `0.18: depth` block): three heights only, rest, raised, overlay. Paint only: no shadow or background ever animates.
- Layout: icon rail at >= 900 px, bottom bar below; breakpoints 600 / 700 / 900 / 1000.
- Motion <= 300 ms, transform and opacity only; respect `prefers-reduced-motion`, `forced-colors` and the Contrast theme.

## Do
- Touch first: targets >= 44 px, primary actions 56 px; everything works by finger alone.
- Headings in `--font-head`, writing and UI in `--font-body`; numbers and dates in the eyebrow style (uppercase, letter-spaced, `--muted`).
- New UI must look right in all 9 themes, not just Day and Night (the themes smoke test checks this).
- Check day AND night at 800 (tablet portrait) and 1280 (tablet landscape) px; add 390 if the change touches the bottom bar.

## Don't
- No Hindi, no paper-grain texture (dropped by the owner).
- No new colours, fonts or shadow levels; no animated shadows or backgrounds.
- Never touch `src/db.ts`, backup, storage, trash, Drive or the import path (see GUARDRAILS.md).

## Screenshots for the judge
`npm run build`, then `npx vite preview --port 4173 &` (it listens on localhost/IPv6 only: use `localhost`, not 127.0.0.1), then
`node /Users/shubhamsingh/Python/tools/shots.mjs http://localhost:4173/upsc-notes/ <review dir> --widths 800,1280 --theme both --name after --wait 2000 --sheet`
Fresh profile = first-run state (no notes). Stop the server with `lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill` (never `pkill -f "vite preview"`). Then `PATH="$HOME/.venvs/upsc-notes/bin:$PATH" scripts/run-suites.sh` (system python3 lacks playwright/PIL; put this exact form in BRIEF Acceptance). Baseline 0.18.1: 28 suites, 1585 checks.

## Reference shots (Opus-approved 2026-10-25)
- `docs/design-ref/ref-1280-light.png`: Today, landscape, Day.
- `docs/design-ref/ref-800-dark.png`: Today, portrait, Night.

## Rubric (judge scores 1-5; pass = every line >= 4)
1. Writing comfort: the note reads like a well-set page; serif headings, legible body, nothing cramped.
2. Hierarchy: one clear primary action per card; chrome never competes with his notes.
3. Theme fidelity: tokens only; correct in Day, Night, Contrast and at least one other theme.
4. Depth and rhythm: rest / raised / overlay used as defined; spacing and radii follow `--r` and density.
5. Touch: >= 44 px targets, works by finger alone, S Pen behaviour untouched unless asked.
6. Finish: build and all suites pass, no console errors, no overflow at 800 px, a11y suite clean.
