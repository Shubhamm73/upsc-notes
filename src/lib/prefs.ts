/**
 * Appearance preferences: theme, font style, width, outline, streak moments, sketch tools. They live in
 * localStorage (read before first paint, no flash). Since 0.11 (backup format 5) they also travel in the
 * backup: each one carries the time it was last chosen, and an import takes a setting only when the
 * file's choice is newer than this device's (a fresh tablet takes them all, an old file never undoes
 * a newer choice).
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
    if (SYNCED[key]) stamp(key, Date.now());
  } catch {
    /* private mode or blocked storage: the choice simply lasts for this visit */
  }
}

// ---------- settings in the backup (format 5) ----------
const KEY_STAMPS = 'upsc.settingsAt';
/** Backup name → localStorage key, and a check of the value an import may write. */
const SYNCED_KEYS: Record<string, { key: string; ok: (v: string) => boolean }> = {
  theme: { key: 'upsc.theme', ok: (v) => ['system', 'day', 'night'].includes(v) },
  font: { key: 'upsc.font', ok: (v) => FONT_STYLES.some((f) => f.id === v) },
  width: { key: 'upsc.width', ok: (v) => v === 'full' || v === 'comfortable' },
  outline: { key: 'upsc.outline', ok: (v) => v === 'shown' || v === 'hidden' },
  celebrate: { key: 'upsc.celebrate', ok: (v) => v === 'on' || v === 'off' },
  sketch: { key: 'upsc.sketch', ok: (v) => jsonObject(v) },
  lastFolder: { key: 'upsc.lastFolder', ok: (v) => v.length > 0 && v.length < 200 },
  drive: { key: 'upsc.drive', ok: (v) => jsonObject(v) }
};
const SYNCED: Record<string, string> = Object.fromEntries(Object.entries(SYNCED_KEYS).map(([name, s]) => [s.key, name]));

function jsonObject(v: string): boolean {
  try {
    const o = JSON.parse(v);
    return !!o && typeof o === 'object' && !Array.isArray(o);
  } catch {
    return false;
  }
}

function stamps(): Record<string, number> {
  try {
    const o = JSON.parse(localStorage.getItem(KEY_STAMPS) ?? '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function stamp(key: string, at: number) {
  const name = SYNCED[key];
  if (!name) return;
  try {
    localStorage.setItem(KEY_STAMPS, JSON.stringify({ ...stamps(), [name]: at }));
  } catch {
    /* blocked storage */
  }
}

/** A setting saved by another module (last subject used, Drive schedule): stored and stamped like the rest. */
export function writeSetting(key: string, value: string) {
  write(key, value);
}

export type SettingsOut = Record<string, { value: string; at: number }>;

/** Every setting chosen on this device, with when it was chosen (backup format 5). */
export function collectSettings(): SettingsOut {
  const at = stamps();
  const out: SettingsOut = {};
  for (const [name, { key }] of Object.entries(SYNCED_KEYS)) {
    const value = read(key);
    // Chosen before 0.11 (no time kept): 1, older than any real choice, newer than "never chosen".
    if (value !== null) out[name] = { value, at: Number(at[name]) || 1 };
  }
  return out;
}

/** Takes each setting from a backup that is newer than this device's. Returns how many were taken. */
export function applySettings(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const here = stamps();
  const hereAt = (name: string, key: string) => Number(here[name]) || (read(key) !== null ? 1 : 0);
  let n = 0;
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    const spec = SYNCED_KEYS[name];
    const e = entry as { value?: unknown; at?: unknown } | null;
    if (!spec || !e || typeof e.value !== 'string' || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
    if (!spec.ok(e.value) || e.at <= hereAt(name, spec.key)) continue;
    try {
      localStorage.setItem(spec.key, e.value);
      stamp(spec.key, e.at);
      n++;
    } catch {
      /* blocked storage */
    }
  }
  if (n) applyAppearance();
  return n;
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

/** Sketch tools last used on this device: tool, colour and size per tool, and whether a finger draws. */
export interface SketchPrefs {
  tool: 'pen' | 'hl' | 'eraser';
  pen: { color: string; size: 's' | 'm' | 'l' };
  hl: { color: string; size: 's' | 'm' | 'l' };
  /** Off by default: a finger scrolls, only the S Pen (or a mouse) draws. */
  finger: boolean;
}

const KEY_SKETCH = 'upsc.sketch';
const SKETCH_DEFAULTS: SketchPrefs = { tool: 'pen', pen: { color: 'ink', size: 'm' }, hl: { color: 'hl-yellow', size: 'm' }, finger: false };

export function getSketchPrefs(): SketchPrefs {
  try {
    const v = JSON.parse(read(KEY_SKETCH) ?? 'null') as Partial<SketchPrefs> | null;
    const size = (s: unknown, d: 's' | 'm' | 'l') => (s === 's' || s === 'm' || s === 'l' ? s : d);
    const color = (c: unknown, d: string) => (typeof c === 'string' && /^[a-z-]+$/.test(c) ? c : d);
    return {
      tool: v?.tool === 'hl' || v?.tool === 'eraser' ? v.tool : 'pen',
      pen: { color: color(v?.pen?.color, 'ink'), size: size(v?.pen?.size, 'm') },
      hl: { color: color(v?.hl?.color, 'hl-yellow'), size: size(v?.hl?.size, 'm') },
      finger: v?.finger === true
    };
  } catch {
    return structuredClone(SKETCH_DEFAULTS);
  }
}

export function setSketchPrefs(p: SketchPrefs) {
  write(KEY_SKETCH, JSON.stringify(p));
}
