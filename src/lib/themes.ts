/**
 * App themes (0.14). Each theme is a full set of the app's colour tokens, applied as inline custom
 * properties on <html> (prefs.applyAppearance), so every screen, chart, diagram and mind map follows it
 * (svg-ink reads the tokens). "Match the tablet" keeps the CSS day/night blocks in styles.css.
 * Light themes use day-safe subject, callout and chart colours, dark themes night-safe ones.
 * Contrast: text pairs reach WCAG AA (4.5:1) in every theme and AAA (7:1) in High contrast; subject,
 * callout and chart colours reach 3:1 (4.5:1 in High contrast) on the page (smoke-test-themes checks it).
 * PDFs never use these: they print in the fixed day palette (svg-ink PRINT_INK, pdf/export.ts).
 */
import { luminance, mix } from './svg-ink';

export type ThemeId = 'day' | 'night' | 'slate' | 'black' | 'sepia' | 'ocean' | 'forest' | 'rose' | 'contrast';

export interface Theme {
  id: ThemeId;
  name: string;
  hint: string;
  dark: boolean;
  /** CSS custom property (without --) → colour. */
  tokens: Record<string, string>;
}

type Base = { bg: string; surface: string; fg: string; muted: string; accent: string; afg: string; line: string; chip: string; rail: string; mark: string; warnBg: string; warnFg: string; error: string };
type Family = Record<string, string>;

const SUB_KEYS = ['gs1', 'gs2', 'gs3', 'gs4', 'essay', 'interview', 'ca', 'psir', 'other', 'blue', 'violet', 'cyan', 'olive'];
const CO_KEYS = ['article', 'case', 'data', 'example', 'wayforward', 'pyq'];

function family(sub: string[], co: string[], chart: string[], rest: Family): Family {
  const out: Family = { ...rest };
  SUB_KEYS.forEach((k, i) => (out[`sub-${k}`] = sub[i]));
  CO_KEYS.forEach((k, i) => (out[`co-${k}`] = co[i]));
  chart.forEach((c, i) => (out[`chart-${i + 1}`] = c));
  return out;
}

const DAY_REST: Family = {
  float: '#1c1f24', 'float-fg': '#fffdf8', 'sweep-blend': 'darken', 'on-sub': '#ffffff', sticky: '#fff0a6', 'sticky-fg': '#3b3313',
  'sk-ink': '#1c1f24', 'sk-blue': '#2f5fb3', 'sk-red': '#c0392b', 'sk-green': '#2e7d4f', 'sk-orange': '#cf7420',
  'sk-hl-yellow': '#ffd400', 'sk-hl-green': '#5ad17a', 'sk-hl-pink': '#ff6fae', 'sk-hl-blue': '#5aa9ff',
  'color-scheme': 'light'
};
const NIGHT_REST: Family = {
  float: '#ece8de', 'float-fg': '#1a1f25', 'sweep-blend': 'lighten', 'on-sub': '#10161b', sticky: '#4a4220', 'sticky-fg': '#f3ead0',
  'sk-ink': '#ece8de', 'sk-blue': '#8fb3f0', 'sk-red': '#f08a7e', 'sk-green': '#7fcf9d', 'sk-orange': '#f4b26b',
  'sk-hl-yellow': '#ffe14d', 'sk-hl-green': '#6fdc8c', 'sk-hl-pink': '#ff8cc4', 'sk-hl-blue': '#7cc0ff',
  'color-scheme': 'dark'
};
const DAY_SUB = ['#b07a1f', '#3f51a3', '#1f7a72', '#7b3f8c', '#4a5058', '#b0465f', '#c4532b', '#2d5b4e', '#6b7280', '#4f6fa8', '#7a5ea8', '#12707a', '#6b8f3a'];
const DAY_CO = ['#2f5fa8', '#8a3d6b', '#12707a', '#9a6410', '#3c7a3a', '#5b3fa0'];
const DAY_CHART = ['#2d5b4e', '#c27c2c', '#4f6fa8', '#a3475a', '#6b8f3a', '#7a5ea8'];
const NIGHT_SUB = ['#e0b25a', '#9aa8f0', '#6cc9be', '#c99be0', '#b4bac2', '#ec9aae', '#f0997a', '#8ccbb8', '#b4bac2', '#8fb0e8', '#b8a0e3', '#6cc9d2', '#a9cf74'];
const NIGHT_CO = ['#8fb0e8', '#e39ac4', '#6cc9d2', '#e5b45e', '#9fd39b', '#b9a4ec'];
const NIGHT_CHART = ['#8ccbb8', '#e5a95e', '#8fb0e8', '#e38fa1', '#a9cf74', '#b8a0e3'];

const DAY = family(DAY_SUB, DAY_CO, DAY_CHART, DAY_REST);
const NIGHT = family(NIGHT_SUB, NIGHT_CO, NIGHT_CHART, NIGHT_REST);
// Sepia's page is darker: a few day colours are deepened to keep 3:1 on it.
const SEPIA = family(
  ['#94661a', '#3f51a3', '#1f7a72', '#7b3f8c', '#4a5058', '#b0465f', '#b44a24', '#2d5b4e', '#646b78', '#4f6fa8', '#7a5ea8', '#12707a', '#5a7a30'],
  DAY_CO,
  ['#2d5b4e', '#a2651d', '#4f6fa8', '#a3475a', '#5a7a30', '#7a5ea8'],
  DAY_REST
);
// High contrast: every colour deep enough for 4.5:1 on white (text 7:1).
const CONTRAST = family(
  ['#6e4a00', '#2b3a8f', '#0d5a54', '#5e2a6e', '#33383f', '#8a2c45', '#8f3412', '#1d4a3e', '#474d5a', '#2f4f8a', '#553a88', '#0b5560', '#435e20'],
  ['#1f4a8a', '#6e2a54', '#0b5560', '#6a4300', '#2a5e28', '#45288a'],
  ['#1d4a3e', '#8a4f00', '#2f4f8a', '#8a2c45', '#435e20', '#553a88'],
  { ...DAY_REST, float: '#000000', 'float-fg': '#ffffff', sticky: '#fff3a0', 'sticky-fg': '#000000' }
);

function theme(id: ThemeId, name: string, hint: string, dark: boolean, b: Base, fam: Family): Theme {
  return {
    id,
    name,
    hint,
    dark,
    tokens: {
      bg: b.bg, surface: b.surface, fg: b.fg, muted: b.muted, accent: b.accent, 'accent-fg': b.afg, line: b.line,
      chip: b.chip, rail: b.rail, mark: b.mark, 'warn-bg': b.warnBg, 'warn-fg': b.warnFg, error: b.error,
      ...fam
    }
  };
}

const WARM_WARN = { warnBg: '#fbecd9', warnFg: '#7a3d12', error: '#a3261b' };
const NIGHT_WARN = { warnFg: '#f1c08f', error: '#ff8f80' };

export const THEMES: Theme[] = [
  theme('day', 'Study desk', 'Paper and ink', false, { bg: '#eeeae0', surface: '#fffdf8', fg: '#1c1f24', muted: '#5d636c', accent: '#2d5b4e', afg: '#fffdf8', line: '#ddd6c6', chip: '#ebe6d9', rail: '#e6e1d4', mark: '#fde68a', ...WARM_WARN }, DAY),
  theme('night', 'Night', 'Slate, for late study', true, { bg: '#111519', surface: '#1a1f25', fg: '#ece8de', muted: '#a3aab4', accent: '#8ccbb8', afg: '#10231d', line: '#2c333c', chip: '#242a31', rail: '#161b20', mark: '#6b5a1a', warnBg: '#3a2a1a', ...NIGHT_WARN }, NIGHT),
  theme('slate', 'Slate', 'Cool grey, calm blue', false, { bg: '#e8ebef', surface: '#fbfcfd', fg: '#1d232a', muted: '#5a6370', accent: '#3b5b8c', afg: '#ffffff', line: '#d3d9e0', chip: '#e2e7ed', rail: '#dfe4ea', mark: '#ffe08a', ...WARM_WARN }, DAY),
  theme('black', 'True black', 'Pure black, saves battery', true, { bg: '#000000', surface: '#0e1013', fg: '#e8e6e1', muted: '#9aa1aa', accent: '#8ccbb8', afg: '#08140f', line: '#23272d', chip: '#191c20', rail: '#050607', mark: '#5c4d12', warnBg: '#2e2114', ...NIGHT_WARN }, NIGHT),
  theme('sepia', 'Sepia', 'Old book, easy on the eyes', false, { bg: '#ede0c6', surface: '#f8efdc', fg: '#3b2f22', muted: '#665540', accent: '#8a4b1f', afg: '#fff8ea', line: '#d9c6a3', chip: '#e7d8b9', rail: '#e5d6b8', mark: '#f3cf6b', warnBg: '#f6dcc0', warnFg: '#6e3410', error: '#9a2318' }, SEPIA),
  theme('ocean', 'Ocean', 'Sea blue and white', false, { bg: '#e3edf0', surface: '#f7fbfc', fg: '#15262c', muted: '#4f6670', accent: '#1f6f86', afg: '#ffffff', line: '#cadde2', chip: '#dae8ec', rail: '#d7e5e9', mark: '#fde68a', ...WARM_WARN }, DAY),
  theme('forest', 'Forest night', 'Deep green, for late study', true, { bg: '#0f1a16', surface: '#16241f', fg: '#e4ece6', muted: '#9fb3a8', accent: '#9fd39b', afg: '#0e1f12', line: '#24382f', chip: '#1d2e27', rail: '#0c1512', mark: '#55601c', warnBg: '#33291a', ...NIGHT_WARN }, NIGHT),
  theme('rose', 'Rose', 'Soft pink, warm', false, { bg: '#f3e7ea', surface: '#fdf8f9', fg: '#2a1d21', muted: '#6d5a60', accent: '#a3475a', afg: '#ffffff', line: '#e5d1d6', chip: '#efe0e4', rail: '#ecdde1', mark: '#fde68a', ...WARM_WARN }, DAY),
  theme('contrast', 'High contrast', 'Black on white, strongest', false, { bg: '#ffffff', surface: '#ffffff', fg: '#000000', muted: '#262626', accent: '#0039a6', afg: '#ffffff', line: '#000000', chip: '#e6e6e6', rail: '#f2f2f2', mark: '#ffe600', warnBg: '#fff0d6', warnFg: '#5c2a00', error: '#8a0000' }, CONTRAST)
];

export const isThemeId = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);
export const themeOf = (id: unknown): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0];

// ---------------- Custom ----------------
export type Density = 'compact' | 'regular' | 'roomy';
export interface CustomTheme {
  /** The theme it starts from. */
  base: ThemeId;
  /** One of CUSTOM_ACCENTS (or null: the base theme's accent). Shown nudged to pass contrast. */
  accent: string | null;
  /** Corner roundness, 0–24 px for a normal card (12 = the app's usual). */
  round: number;
  density: Density;
}
export const CUSTOM_ACCENTS = ['#2d5b4e', '#3f51a3', '#1f7a72', '#7b3f8c', '#b0465f', '#c4532b', '#b07a1f', '#1f6f86'];
export const CUSTOM_DEFAULT: CustomTheme = { base: 'day', accent: null, round: 12, density: 'regular' };
export const DENSITIES: { id: Density; name: string }[] = [
  { id: 'compact', name: 'Compact' },
  { id: 'regular', name: 'Regular' },
  { id: 'roomy', name: 'Roomy' }
];

/** A stored custom theme, checked field by field (anything odd falls back to the default). */
export function readCustom(raw: unknown): CustomTheme {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const round = typeof r.round === 'number' && Number.isFinite(r.round) ? Math.max(0, Math.min(24, Math.round(r.round))) : CUSTOM_DEFAULT.round;
  return {
    base: isThemeId(r.base) ? r.base : CUSTOM_DEFAULT.base,
    accent: typeof r.accent === 'string' && /^#[0-9a-f]{6}$/i.test(r.accent) ? r.accent.toLowerCase() : null,
    round,
    density: r.density === 'compact' || r.density === 'roomy' ? r.density : 'regular'
  };
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * An accent colour made readable on this theme: darkened (light themes) or lightened (dark themes)
 * in small steps until text in it reaches 4.5:1 (7:1 in High contrast) on the page and on cards.
 * Returns the accent and the text colour that sits on it.
 */
export function fitAccent(hex: string, t: Theme): { accent: string; fg: string } {
  const need = t.id === 'contrast' ? 7 : 4.5;
  const toward = t.dark ? '#ffffff' : '#000000';
  const ok = (c: string) => contrast(c, t.tokens.surface) >= need && contrast(c, t.tokens.bg) >= need;
  let c = hex;
  for (let i = 1; i <= 20 && !ok(c); i++) c = mix(hex, toward, i * 0.05);
  const dark = '#0b0f12';
  const fg = contrast('#ffffff', c) >= contrast(dark, c) ? '#ffffff' : dark;
  return { accent: c, fg };
}

/** Every token for a theme pick (custom: the base theme with its accent). */
export function tokensFor(id: ThemeId | 'custom', custom: CustomTheme): Record<string, string> {
  if (id !== 'custom') return themeOf(id).tokens;
  const t = themeOf(custom.base);
  if (!custom.accent) return t.tokens;
  const { accent, fg } = fitAccent(custom.accent, t);
  return { ...t.tokens, accent, 'accent-fg': fg };
}
