/**
 * Looks for headings, containers (panels) and tables (0.12). Everything here is stored as plain
 * attributes inside a section's doc, so a note carries its own looks (no Dexie change). Colours are the
 * 13 folder colours (CSS --sub-<key>, with night variants); null means "follow the note's subject".
 */
import { FOLDER_COLOURS } from './folder-plan';

export interface Colour {
  key: string;
  name: string;
  /** Day colour, used in the PDF (always printed in day colours). */
  print: string;
}

export const COLOURS: Colour[] = [
  { key: 'gs1', name: 'Amber', print: '#b07a1f' },
  { key: 'gs2', name: 'Indigo', print: '#3f51a3' },
  { key: 'gs3', name: 'Teal', print: '#1f7a72' },
  { key: 'gs4', name: 'Plum', print: '#7b3f8c' },
  { key: 'interview', name: 'Rose', print: '#b0465f' },
  { key: 'ca', name: 'Rust', print: '#c4532b' },
  { key: 'psir', name: 'Green', print: '#2d5b4e' },
  { key: 'essay', name: 'Slate', print: '#4a5058' },
  { key: 'blue', name: 'Blue', print: '#4f6fa8' },
  { key: 'violet', name: 'Violet', print: '#7a5ea8' },
  { key: 'cyan', name: 'Cyan', print: '#12707a' },
  { key: 'olive', name: 'Olive', print: '#6b8f3a' },
  { key: 'other', name: 'Grey', print: '#6b7280' }
].filter((c) => FOLDER_COLOURS.includes(c.key));

/** The app's accent: a note whose subject has no colour. */
export const ACCENT_PRINT = '#2d5b4e';

export const colourKey = (v: unknown): string | null => (typeof v === 'string' && COLOURS.some((c) => c.key === v) ? v : null);
export const printColour = (key: unknown, fallback = ACCENT_PRINT): string => COLOURS.find((c) => c.key === key)?.print ?? fallback;
/** CSS colour for a stored colour key (null: the subject's, set on the note as --subj). */
export const cssColour = (key: unknown): string => (colourKey(key) ? `var(--sub-${key})` : 'var(--subj, var(--accent))');

export type Fill = 'soft' | 'medium' | 'solid';
export type Corner = 'square' | 'round' | 'pill';
export const FILLS: { id: Fill; label: string }[] = [
  { id: 'soft', label: 'Soft' },
  { id: 'medium', label: 'Medium' },
  { id: 'solid', label: 'Solid' }
];
export const CORNERS: { id: Corner; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'round', label: 'Round' },
  { id: 'pill', label: 'Pill' }
];
/** Tint strength of each fill on screen and in the PDF (share of the colour mixed into white). */
export const FILL_TINT: Record<Fill, number> = { soft: 0.14, medium: 0.28, solid: 0.4 };

export const ICONS: { id: string; label: string }[] = [
  { id: 'star', label: 'Star' },
  { id: 'flag', label: 'Flag' },
  { id: 'bulb', label: 'Bulb' },
  { id: 'book', label: 'Book' }
];
/** Small text marks for the icons in the PDF (its font has no pictures). */

const pick = <T extends string>(v: unknown, ids: readonly T[], fallback: T): T => (ids.includes(v as T) ? (v as T) : fallback);
const iconId = (v: unknown): string | null => (ICONS.some((i) => i.id === v) ? (v as string) : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// ---------- headings ----------
export const HEADING_STYLES = ['plain', 'underline', 'marker', 'pill', 'banner', 'card', 'tab', 'numbered', 'boxed', 'brackets', 'split', 'sticky'] as const;
export type HeadingStyle = (typeof HEADING_STYLES)[number];
export const HEADING_STYLE_NAMES: Record<HeadingStyle, string> = {
  plain: 'Plain',
  underline: 'Underline',
  marker: 'Marker',
  pill: 'Pill',
  banner: 'Banner',
  card: 'Card',
  tab: 'Tab',
  numbered: 'Numbered',
  boxed: 'Boxed',
  brackets: 'Brackets',
  split: 'Split',
  sticky: 'Sticky'
};

/** A heading's look. Stored as the heading's `look` attribute; null (the default) is a plain heading. */
export interface HeadingLook {
  style: HeadingStyle;
  color: string | null;
  fill: Fill;
  corner: Corner;
  icon: string | null;
  width: 'fit' | 'full';
  align: 'left' | 'center';
}

/** What a plain heading turns into when he first picks a look. */
export const HEADING_START: HeadingLook = { style: 'underline', color: null, fill: 'soft', corner: 'round', icon: null, width: 'fit', align: 'left' };

/** A stored look, checked field by field (a bad field falls back; "plain" with nothing else is no look). */
export function readHeadingLook(raw: unknown): HeadingLook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const look: HeadingLook = {
    style: pick(r.style, HEADING_STYLES, 'plain'),
    color: colourKey(r.color),
    fill: pick(r.fill, ['soft', 'medium', 'solid'] as const, 'soft'),
    corner: pick(r.corner, ['square', 'round', 'pill'] as const, 'round'),
    icon: iconId(r.icon),
    width: pick(r.width, ['fit', 'full'] as const, 'fit'),
    align: pick(r.align, ['left', 'center'] as const, 'left')
  };
  if (look.style === 'plain' && !look.color && !look.icon && look.align === 'left') return null;
  return look;
}

// ---------- containers ----------
export const PANEL_KINDS = ['soft', 'titled', 'sticky', 'framed', 'quote', 'columns'] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];
export const PANEL_INFO: Record<PanelKind, { name: string; hint: string }> = {
  soft: { name: 'Soft panel', hint: 'A tinted block behind the text' },
  titled: { name: 'Titled panel', hint: 'A coloured title strip with your label and icon' },
  sticky: { name: 'Sticky note', hint: 'Mnemonics and one-liners' },
  framed: { name: 'Framed', hint: 'A thin border with corner marks' },
  quote: { name: 'Quote', hint: 'Essay and ethics quotes, with an author line' },
  columns: { name: 'Two columns', hint: 'Two lists side by side: for and against, then and now' }
};

/** A container's look: the `panel` node's attributes. */
export interface PanelLook {
  kind: PanelKind;
  color: string | null;
  fill: Fill;
  corner: Corner;
  icon: string | null;
  title: string | null;
  author: string | null;
}

export const PANEL_DEFAULT: PanelLook = { kind: 'soft', color: null, fill: 'soft', corner: 'round', icon: null, title: null, author: null };

export function readPanelLook(raw: unknown): PanelLook {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    kind: pick(r.kind, PANEL_KINDS, 'soft'),
    color: colourKey(r.color),
    fill: pick(r.fill, ['soft', 'medium', 'solid'] as const, 'soft'),
    corner: pick(r.corner, ['square', 'round', 'pill'] as const, 'round'),
    icon: iconId(r.icon),
    title: text(r.title, 80),
    author: text(r.author, 120)
  };
}

/** The label a titled panel or sticky note shows when he hasn't typed one. */
export const panelTitle = (l: Pick<PanelLook, 'kind' | 'title'>): string => l.title ?? (l.kind === 'titled' ? 'Key point' : l.kind === 'sticky' ? 'Remember' : '');

// ---------- callouts (0.12: restylable) ----------
export const readFill = (v: unknown): Fill | null => (['soft', 'medium', 'solid'].includes(v as string) ? (v as Fill) : null);
export const readCorner = (v: unknown): Corner | null => (['square', 'round', 'pill'].includes(v as string) ? (v as Corner) : null);

// ---------- tables ----------
export const TABLE_STYLES = ['clean', 'banded', 'lined', 'boxed', 'minimal'] as const;
export type TableStyle = (typeof TABLE_STYLES)[number];
export const TABLE_STYLE_INFO: Record<TableStyle, { name: string; hint: string }> = {
  clean: { name: 'Clean', hint: 'Tinted header, quiet row lines' },
  banded: { name: 'Banded', hint: 'Every other row tinted' },
  lined: { name: 'Lined', hint: 'Lines between columns too' },
  boxed: { name: 'Boxed', hint: 'A box round every cell' },
  minimal: { name: 'Minimal', hint: 'A rule under the header, nothing else' }
};
export const tableStyle = (v: unknown): TableStyle => pick(v, TABLE_STYLES, 'clean');

export const TABLE_MAX_ROWS = 50;
export const TABLE_MAX_COLS = 12;

/**
 * A cell that holds only a figure: 552, 1,234.5, -3%, ₹5.2 cr, (12), 2019–20. A column whose filled body
 * cells are all figures is right-aligned in a fixed-width font so the figures line up (worked out when
 * shown, never stored).
 */
export function isFigure(s: string): boolean {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 24) return false;
  return /^\(?[-−+~≈]?\s?[₹$€£]?\s?\d[\d,]*(\.\d+)?(\s?(%|x|×|cr|crore|lakh|lakhs|bn|mn|million|billion|trillion|k|km|kg|ha|mt|gw|mw|°c|years?|yrs?))?\)?$/i.test(t) || /^\d{4}\s?[-–]\s?\d{2,4}$/.test(t);
}

/**
 * Which columns of a table are figure columns, from its cells (header or not, first column, columns
 * spanned, text). Header cells are skipped; a column needs at least one filled body cell.
 */
export function figureColumns(cells: { header: boolean; col: number; span: number; text: string }[]): Set<number> {
  const seen = new Map<number, boolean>();
  for (const c of cells) {
    if (c.header || !c.text.trim()) continue;
    if (c.span === 1) seen.set(c.col, (seen.get(c.col) ?? true) && isFigure(c.text));
    else for (let j = 0; j < c.span; j++) seen.set(c.col + j, false);
  }
  return new Set([...seen].filter(([, ok]) => ok).map(([c]) => c));
}
