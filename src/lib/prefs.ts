/**
 * Appearance preferences: theme and font style. They are per-device conveniences,
 * so they live in localStorage (read before first paint, no flash) rather than in
 * the notes database or backups.
 */

export type ThemePref = 'system' | 'day' | 'night';

export interface FontStyle {
  id: string;
  name: string;
  head: string;
  body: string;
  feel: string;
  bestFor: string;
  creative?: boolean;
}

export const FONT_STYLES: FontStyle[] = [
  { id: 'desk', name: 'Study desk', head: 'Source Serif 4', body: 'Atkinson Hyperlegible', feel: 'A good textbook', bestFor: 'Long notes, daily use' },
  { id: 'editorial', name: 'Editorial', head: 'Literata', body: 'Public Sans', feel: 'A quality newspaper', bestFor: 'Current affairs, essays' },
  { id: 'academic', name: 'Academic', head: 'EB Garamond', body: 'Libre Franklin', feel: 'A university journal', bestFor: 'Ethics (GS4), PSIR theory' },
  { id: 'professional', name: 'Clean professional', head: 'IBM Plex Serif', body: 'IBM Plex Sans', feel: 'A government report', bestFor: 'Polity, economy, data-heavy notes' },
  { id: 'notebook', name: 'Notebook', head: 'Caveat', body: 'Nunito', feel: 'Neat handwriting in a ruled notebook', bestFor: 'Mind dumps, revision sheets', creative: true },
  { id: 'bold', name: 'Bold & friendly', head: 'Fraunces', body: 'Nunito', feel: 'A designed magazine', bestFor: 'Topic covers, essay outlines', creative: true }
];

const KEY_THEME = 'upsc.theme';
const KEY_FONT = 'upsc.font';
const KEY_CELEBRATE = 'upsc.celebrate';
const KEY_WIDTH = 'upsc.width';
const KEY_OUTLINE = 'upsc.outline';

/** Note width: the whole screen (default), or a comfortable reading column. PDFs are A4 either way. */
export type PageWidth = 'full' | 'comfortable';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the choice simply lasts for this visit */
  }
}

export function getTheme(): ThemePref {
  const v = read(KEY_THEME);
  return v === 'day' || v === 'night' ? v : 'system';
}

export function getFontStyle(): string {
  const v = read(KEY_FONT);
  return FONT_STYLES.some((f) => f.id === v) ? (v as string) : 'desk';
}

/** True when the night palette is showing right now. */
export function isNight(): boolean {
  const t = getTheme();
  return t === 'night' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function applyAppearance() {
  const root = document.documentElement;
  const t = getTheme();
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  root.dataset.font = getFontStyle();
  root.dataset.width = getPageWidth();
  root.dataset.outline = outlineShown() ? 'shown' : 'hidden';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isNight() ? '#111519' : '#2d5b4e');
  window.dispatchEvent(new Event('themechange'));
}

export function setTheme(t: ThemePref) {
  write(KEY_THEME, t);
  applyAppearance();
}

export function setFontStyle(id: string) {
  write(KEY_FONT, id);
  applyAppearance();
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'system') applyAppearance();
});

/** Quiet streak moments at 7, 30 and 100 days (Settings → Appearance). On unless switched off. */
export function celebrationsOn(): boolean {
  return read(KEY_CELEBRATE) !== 'off';
}

export function setCelebrations(on: boolean) {
  write(KEY_CELEBRATE, on ? 'on' : 'off');
}

export function getPageWidth(): PageWidth {
  return read(KEY_WIDTH) === 'comfortable' ? 'comfortable' : 'full';
}

export function setPageWidth(w: PageWidth) {
  write(KEY_WIDTH, w);
  applyAppearance();
}

/** The outline rail beside an open note (landscape). Shown unless folded away. */
export function outlineShown(): boolean {
  return read(KEY_OUTLINE) !== 'hidden';
}

export function setOutlineShown(on: boolean) {
  write(KEY_OUTLINE, on ? 'shown' : 'hidden');
  applyAppearance();
}
