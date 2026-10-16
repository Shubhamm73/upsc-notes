/**
 * Colours, text measuring and SVG helpers shared by charts, diagrams and mind maps (0.13).
 * Everything is drawn as an SVG string with presentation attributes (fill=, stroke=, font-weight="bold"),
 * so the same picture shows on screen and prints in the PDF (pdfmake's SVG reader takes only attributes).
 * Colours are always concrete hex values: on screen they are read from the app's CSS tokens, in the PDF
 * they are the day colours.
 */
import { COLOURS, colourKey } from './looks';

export interface Ink {
  fg: string;
  muted: string;
  line: string;
  surface: string;
  /** A slightly darker surface: zebra rows, tracks. */
  surface2: string;
  chip: string;
  accent: string;
  accentFg: string;
  /** The note's subject colour (or the accent). */
  subj: string;
  /** true in the night theme: palette colours are lightened. */
  night: boolean;
  /** true when drawing for the PDF. */
  print: boolean;
}

export const PRINT_INK: Ink = {
  fg: '#1c1f24',
  muted: '#5d636c',
  line: '#ddd6c6',
  surface: '#ffffff',
  surface2: '#f6f2e8',
  chip: '#ebe6d9',
  accent: '#2d5b4e',
  accentFg: '#fffdf8',
  subj: '#2d5b4e',
  night: false,
  print: true
};

// ---------------- colour maths ----------------
function rgb(c: string): [number, number, number] {
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [45, 91, 78];
}
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const toHex = (c: string) => hex(...rgb(c));
/** a mixed with b: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}
export function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Text colour that reads on a filled shape of colour c. */
export const onColour = (c: string) => (luminance(c) > 0.42 ? '#10161b' : '#ffffff');

// ---------------- palettes ----------------
export type PaletteId = 'subject' | 'desk' | 'vivid' | 'earth' | 'ocean' | 'berry' | 'greys';
export const PALETTES: { id: PaletteId; name: string; day: string[] }[] = [
  { id: 'subject', name: 'Subject', day: [] },
  { id: 'desk', name: 'Study desk', day: ['#2d5b4e', '#c27c2c', '#4f6fa8', '#a3475a', '#6b8f3a', '#7a5ea8'] },
  { id: 'vivid', name: 'Vivid', day: ['#1f6fd1', '#e0662b', '#1b9e77', '#d6336c', '#7048e8', '#e8a317'] },
  { id: 'earth', name: 'Earth', day: ['#8c5a2b', '#5f7a3a', '#b8862e', '#7a4b5c', '#4f6b6b', '#a65f3f'] },
  { id: 'ocean', name: 'Ocean', day: ['#0f4c75', '#1f7a8c', '#3f8fd2', '#5aa9a0', '#274c77', '#7fb3d5'] },
  { id: 'berry', name: 'Berry', day: ['#7b2d5b', '#b0465f', '#d9825b', '#5b3fa0', '#a3475a', '#e0a458'] },
  { id: 'greys', name: 'Greys', day: ['#2f343b', '#5d636c', '#8a9099', '#454b53', '#737a83', '#a3aab4'] }
];
export const readPalette = (v: unknown): PaletteId => (PALETTES.some((p) => p.id === v) ? (v as PaletteId) : 'desk');

/** Six colours for a palette, ready to draw with this ink. */
export function paletteColours(id: PaletteId, ink: Ink, desk?: string[]): string[] {
  if (id === 'subject') {
    const b = ink.subj;
    const dark = ink.night ? ink.surface : ink.fg;
    const light = ink.night ? '#ffffff' : ink.surface;
    return [b, mix(b, dark, 0.4), mix(b, light, 0.45), mix(b, dark, 0.65), mix(b, light, 0.7), mix(b, dark, 0.2)];
  }
  if (id === 'desk' && desk?.length === 6) return desk;
  const p = PALETTES.find((x) => x.id === id) ?? PALETTES[1];
  return ink.night ? p.day.map((c) => mix(c, '#ffffff', 0.38)) : p.day;
}

/** A stored colour key (the 13 folder colours) as a colour for this ink; null = the subject's. */
export function keyColour(key: unknown, ink: Ink): string {
  const k = colourKey(key);
  if (!k) return ink.subj;
  if (ink.print) return COLOURS.find((c) => c.key === k)!.print;
  return toHex(getComputedStyle(document.documentElement).getPropertyValue(`--sub-${k}`) || ink.subj);
}

/** The app's colours as they are right now (day or night), and the subject colour set on `el`'s canvas. */
export function screenInk(el?: Element | null): Ink {
  const root = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => root.getPropertyValue(n).trim() || f;
  const surface = toHex(v('--surface', '#fffdf8'));
  const bg = toHex(v('--bg', '#eeeae0'));
  const subjRaw = el ? getComputedStyle(el).getPropertyValue('--subj').trim() : '';
  const accent = toHex(v('--accent', '#2d5b4e'));
  return {
    fg: toHex(v('--fg', '#1c1f24')),
    muted: toHex(v('--muted', '#5d636c')),
    line: toHex(v('--line', '#ddd6c6')),
    surface,
    surface2: mix(surface, bg, 0.55),
    chip: toHex(v('--chip', '#ebe6d9')),
    accent,
    accentFg: toHex(v('--accent-fg', '#fffdf8')),
    subj: subjRaw ? toHex(subjRaw) : accent,
    night: luminance(surface) < 0.2,
    print: false
  };
}
/** The six --chart-N tokens (the "Study desk" palette in day or night). */
export function deskColours(): string[] {
  const root = getComputedStyle(document.documentElement);
  return [1, 2, 3, 4, 5, 6].map((i, j) => toHex(root.getPropertyValue(`--chart-${i}`).trim() || PALETTES[1].day[j]));
}

// ---------------- text ----------------
let ctx2d: CanvasRenderingContext2D | null = null;
const FONT = '"Atkinson Hyperlegible", system-ui, sans-serif';
/** Width of a text in px at a font size (bold or not). Works without a DOM (rough estimate). */
export function measure(text: string, size: number, bold = false): number {
  if (typeof document !== 'undefined') {
    ctx2d ??= document.createElement('canvas').getContext('2d');
    if (ctx2d) {
      ctx2d.font = `${bold ? 700 : 400} ${size}px ${FONT}`;
      // + 6 %: the PDF's font runs a little wider
      return ctx2d.measureText(text).width * 1.06;
    }
  }
  return text.length * size * (bold ? 0.58 : 0.53);
}
/** Breaks a text into lines no wider than `max` px (a long word is cut). At most `lines` lines, the last ends in "…". */
export function wrap(text: string, max: number, size: number, bold = false, lines = 99): string[] {
  const out: string[] = [];
  for (const para of String(text ?? '').split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (measure(next, size, bold) <= max) cur = next;
      else {
        if (cur) out.push(cur);
        let w = word;
        while (measure(w, size, bold) > max && w.length > 1) {
          let i = w.length - 1;
          while (i > 1 && measure(w.slice(0, i), size, bold) > max) i--;
          out.push(w.slice(0, i));
          w = w.slice(i);
        }
        cur = w;
      }
    }
    out.push(cur);
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = clip(kept[lines - 1] + '…', max, size, bold);
    return kept;
  }
  return out;
}
/** Shortens a text to fit `max` px, ending in "…". */
export function clip(text: string, max: number, size: number, bold = false): string {
  if (measure(text, size, bold) <= max) return text;
  let t = text;
  while (t.length > 1 && measure(t + '…', size, bold) > max) t = t.slice(0, -1);
  return t.replace(/\s+$/, '') + '…';
}

// ---------------- SVG ----------------
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

export interface TextOpts {
  a?: 'start' | 'middle' | 'end';
  c?: string;
  s?: number;
  bold?: boolean;
  cls?: string;
}
export function T(x: number, y: number, s: unknown, o: TextOpts = {}): string {
  return `<text x="${n1(x)}" y="${n1(y)}" text-anchor="${o.a ?? 'middle'}" fill="${o.c ?? '#5d636c'}" font-size="${o.s ?? 12}"${o.bold ? ' font-weight="bold"' : ''}${o.cls ? ` class="${o.cls}"` : ''} font-family="Atkinson Hyperlegible, Roboto, sans-serif">${esc(s)}</text>`;
}
/** Several lines of text centred on (x, y). */
export function lines(x: number, y: number, ls: string[], o: TextOpts & { lh?: number } = {}): string {
  const lh = o.lh ?? (o.s ?? 12) * 1.25;
  const top = y - ((ls.length - 1) * lh) / 2 + (o.s ?? 12) * 0.35;
  return ls.map((l, i) => T(x, top + i * lh, l, o)).join('');
}
export function svgDoc(w: number, h: number, body: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n1(w)} ${n1(h)}" width="${n1(w)}" height="${n1(h)}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}
/** A rounded bar whose value end is rounded (top for up, bottom for down, right for sideways). */
export function bar(x: number, y: number, w: number, h: number, r: number, end: 'top' | 'bottom' | 'right' | 'left' = 'top'): string {
  if (w <= 0 || h <= 0) return '';
  if (end === 'top' || end === 'bottom') r = Math.min(r, w / 2, h);
  else r = Math.min(r, h / 2, w);
  const f = (v: number) => n1(v);
  switch (end) {
    case 'top':
      return `M${f(x)},${f(y + h)} V${f(y + r)} Q${f(x)},${f(y)} ${f(x + r)},${f(y)} H${f(x + w - r)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)} V${f(y + h)} Z`;
    case 'bottom':
      return `M${f(x)},${f(y)} V${f(y + h - r)} Q${f(x)},${f(y + h)} ${f(x + r)},${f(y + h)} H${f(x + w - r)} Q${f(x + w)},${f(y + h)} ${f(x + w)},${f(y + h - r)} V${f(y)} Z`;
    case 'right':
      return `M${f(x)},${f(y)} H${f(x + w - r)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)} V${f(y + h - r)} Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h)} H${f(x)} Z`;
    default:
      return `M${f(x + w)},${f(y)} H${f(x + r)} Q${f(x)},${f(y)} ${f(x)},${f(y + r)} V${f(y + h - r)} Q${f(x)},${f(y + h)} ${f(x + r)},${f(y + h)} H${f(x + w)} Z`;
  }
}
/** A smooth curve through points (Catmull-Rom as cubic Béziers). */
export function smooth(pts: [number, number][]): string {
  if (!pts.length) return '';
  let d = `M${n1(pts[0][0])},${n1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${n1(c1[0])},${n1(c1[1])} ${n1(c2[0])},${n1(c2[1])} ${n1(p2[0])},${n1(p2[1])}`;
  }
  return d;
}
/** An arrow head at (x, y) pointing along angle a (radians). Drawn as a path: the PDF has no markers we trust. */
export function arrowHead(x: number, y: number, a: number, c: string, size = 9): string {
  const p = (t: number, r: number) => `${n1(x + Math.cos(a + t) * r)},${n1(y + Math.sin(a + t) * r)}`;
  return `<path d="M${n1(x)},${n1(y)} L${p(Math.PI - 0.45, size)} L${p(Math.PI + 0.45, size)} Z" fill="${c}"/>`;
}

/** Numbers as he reads them: 1,20,000 (Indian grouping), at most 2 decimals. */
export function fmt(v: number, unit = ''): string {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(v) >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : String(Math.round(v * 100) / 100);
  return unit ? (/^[%°]/.test(unit) ? s + unit : unit.startsWith('₹') || unit === '$' ? unit + s : `${s} ${unit.trim()}`) : s;
}
/** A round top for an axis (and its step) that holds every value. */
export function niceScale(min: number, max: number, ticks = 4): { lo: number; hi: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, step: 0.25 };
  if (min === max) max = min + 1;
  const span = max - min;
  const raw = span / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}
