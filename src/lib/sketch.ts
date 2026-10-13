/**
 * Sketches (U4-1): pen strokes kept inside the note, drawn on screen and in the PDF from the same data.
 *
 * A sketch is 1000 units wide (it scales with its block, like a picture) and `height` units tall.
 * Each stroke is one short string: "tool.colour.size:points", the points being x, y (quarter units)
 * and pressure (0–100), delta-coded as zigzag varints in base64. About 4 characters a point.
 * Strings, not arrays: a new version of the sketch shares every unchanged stroke with the old one,
 * so Undo history stays small however many steps it holds.
 */

export const SKETCH_W = 1000;
export const SKETCH_H = 600;
export const SKETCH_MIN_H = 200;
export const SKETCH_MAX_H = 4000;
export const SKETCH_GROW = 300;

export type SketchTool = 'pen' | 'hl';
export type SketchSize = 's' | 'm' | 'l';

export interface Stroke {
  tool: SketchTool;
  color: string;
  size: SketchSize;
  /** Flat x, y, pressure (0–1) triples, x and y in sketch units. */
  pts: number[];
}

/** A stroke with what drawing and erasing need. */
export interface Decoded extends Stroke {
  code: string;
  box: [number, number, number, number]; // minX, minY, maxX, maxY, widened by the stroke's width
}

export interface InkColor {
  id: string;
  name: string;
  /** Day and print colour; the night colour comes from the CSS variable --sk-<id>. */
  print: string;
}

export const PEN_COLORS: InkColor[] = [
  { id: 'ink', name: 'Ink', print: '#1c1f24' },
  { id: 'blue', name: 'Blue', print: '#2f5fb3' },
  { id: 'red', name: 'Red', print: '#c0392b' },
  { id: 'green', name: 'Green', print: '#2e7d4f' },
  { id: 'orange', name: 'Orange', print: '#cf7420' }
];

export const HL_COLORS: InkColor[] = [
  { id: 'hl-yellow', name: 'Yellow', print: '#ffd400' },
  { id: 'hl-green', name: 'Green', print: '#5ad17a' },
  { id: 'hl-pink', name: 'Pink', print: '#ff6fae' },
  { id: 'hl-blue', name: 'Blue', print: '#5aa9ff' }
];

const ALL_COLORS = [...PEN_COLORS, ...HL_COLORS];

export const SIZES: { id: SketchSize; name: string }[] = [
  { id: 's', name: 'Fine' },
  { id: 'm', name: 'Medium' },
  { id: 'l', name: 'Bold' }
];

/** Base width in sketch units. A pen line is thinner when pressed lightly, thicker when pressed hard. */
const WIDTH: Record<SketchTool, Record<SketchSize, number>> = {
  pen: { s: 2.2, m: 3.8, l: 7 },
  hl: { s: 12, m: 20, l: 32 }
};
export const HL_ALPHA = 0.38;

export function penWidth(s: Stroke, pressure: number): number {
  const base = WIDTH[s.tool][s.size] ?? 3.8;
  return s.tool === 'hl' ? base : base * (0.35 + 0.9 * Math.min(1, Math.max(0.05, pressure)));
}

function maxWidth(s: Stroke): number {
  return s.tool === 'hl' ? WIDTH.hl[s.size] ?? 20 : (WIDTH.pen[s.size] ?? 3.8) * 1.25;
}

// ---------------- the stroke code ----------------

const isTool = (t: string): t is SketchTool => t === 'pen' || t === 'hl';
const isSize = (s: string): s is SketchSize => s === 's' || s === 'm' || s === 'l';

export function encodeStroke(s: Stroke): string {
  const bytes: number[] = [];
  const put = (v: number) => {
    let z = v < 0 ? -2 * v - 1 : 2 * v; // zigzag
    while (z >= 0x80) {
      bytes.push((z & 0x7f) | 0x80);
      z = Math.floor(z / 128);
    }
    bytes.push(z);
  };
  let px = 0;
  let py = 0;
  let pp = 0;
  for (let i = 0; i + 2 < s.pts.length; i += 3) {
    const x = Math.round(s.pts[i] * 4);
    const y = Math.round(s.pts[i + 1] * 4);
    const p = Math.round(Math.min(1, Math.max(0, s.pts[i + 2])) * 100);
    put(x - px);
    put(y - py);
    put(p - pp);
    px = x;
    py = y;
    pp = p;
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${s.tool}.${s.color}.${s.size}:${btoa(bin)}`;
}

/** The stroke a code holds, or null when it isn't one (a damaged or unknown stroke is skipped, never fatal). */
export function decodeStroke(code: unknown): Decoded | null {
  if (typeof code !== 'string') return null;
  const m = /^([a-z]+)\.([a-z-]+)\.([a-z]):([A-Za-z0-9+/=]*)$/.exec(code);
  if (!m || !isTool(m[1]) || !isSize(m[3])) return null;
  let bin: string;
  try {
    bin = atob(m[4]);
  } catch {
    return null;
  }
  const vals: number[] = [];
  let z = 0;
  let mul = 1;
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    z += (b & 0x7f) * mul;
    if (b & 0x80) {
      mul *= 128;
      continue;
    }
    vals.push(z % 2 ? -(z + 1) / 2 : z / 2);
    z = 0;
    mul = 1;
  }
  if (!vals.length || vals.length % 3) return null;
  const pts: number[] = [];
  let x = 0;
  let y = 0;
  let p = 0;
  for (let i = 0; i < vals.length; i += 3) {
    x += vals[i];
    y += vals[i + 1];
    p += vals[i + 2];
    pts.push(x / 4, y / 4, Math.min(1, Math.max(0, p / 100)));
  }
  const s: Stroke = { tool: m[1], color: ALL_COLORS.some((c) => c.id === m[2]) ? m[2] : m[1] === 'hl' ? 'hl-yellow' : 'ink', size: m[3], pts };
  return { ...s, code, box: boxOf(s) };
}

function boxOf(s: Stroke): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 3) {
    x0 = Math.min(x0, s.pts[i]);
    y0 = Math.min(y0, s.pts[i + 1]);
    x1 = Math.max(x1, s.pts[i]);
    y1 = Math.max(y1, s.pts[i + 1]);
  }
  const r = maxWidth(s) / 2;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

/** The strokes of a sketch's `strokes` attribute (anything that isn't a list of codes gives none). */
export function readStrokes(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}

export function readHeight(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(SKETCH_MAX_H, Math.max(SKETCH_MIN_H, n)) : SKETCH_H;
}

/** Lowest point any ink reaches (the sketch can't be made shorter than this). */
export function inkBottom(strokes: Decoded[]): number {
  return strokes.reduce((m, s) => Math.max(m, s.box[3]), 0);
}

// ---------------- drawing ----------------

export type Palette = (color: string) => string;

/** Day colours, as printed. */
export const printPalette: Palette = (id) => ALL_COLORS.find((c) => c.id === id)?.print ?? '#1c1f24';

/** The colours on screen now (night mode has its own, from --sk-<id>). */
export function screenPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const cache = new Map<string, string>();
  return (id) => {
    let v = cache.get(id);
    if (v === undefined) {
      v = css.getPropertyValue(`--sk-${id}`).trim() || printPalette(id);
      cache.set(id, v);
    }
    return v;
  };
}

/**
 * Draws one stroke. `g` is already scaled to sketch units.
 * Pen: short curves through the midpoints, each as wide as the pressure at its point (round ends hide the joins).
 * Highlighter: one see-through path, so where it crosses itself it doesn't get darker.
 */
export function drawStroke(g: CanvasRenderingContext2D, s: Stroke, palette: Palette) {
  const p = s.pts;
  const n = p.length / 3;
  if (!n) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = g.fillStyle = palette(s.color);
  if (s.tool === 'hl') g.globalAlpha = HL_ALPHA;
  if (n === 1 || (n === 2 && Math.hypot(p[3] - p[0], p[4] - p[1]) < 0.5)) {
    g.beginPath();
    g.arc(p[0], p[1], penWidth(s, p[2]) / 2, 0, Math.PI * 2);
    g.fill();
  } else if (s.tool === 'hl') {
    g.lineWidth = penWidth(s, 0.5);
    g.beginPath();
    g.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (p[i * 3] + p[i * 3 + 3]) / 2;
      const my = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
      g.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx, my);
    }
    g.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    g.stroke();
  } else {
    let sx = p[0];
    let sy = p[1];
    for (let i = 1; i < n; i++) {
      const last = i === n - 1;
      const ex = last ? p[i * 3] : (p[i * 3] + p[i * 3 + 3]) / 2;
      const ey = last ? p[i * 3 + 1] : (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
      g.lineWidth = penWidth(s, p[i * 3 + 2]);
      g.beginPath();
      g.moveTo(sx, sy);
      if (last) g.lineTo(ex, ey);
      else g.quadraticCurveTo(p[i * 3], p[i * 3 + 1], ex, ey);
      g.stroke();
      sx = ex;
      sy = ey;
    }
  }
  g.restore();
}

export function drawAll(g: CanvasRenderingContext2D, strokes: Stroke[], palette: Palette, skip?: Set<number>) {
  strokes.forEach((s, i) => {
    if (!skip?.has(i)) drawStroke(g, s, palette);
  });
}

// ---------------- erasing ----------------

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True when the eraser at (x, y) with radius r touches the stroke. */
export function touches(s: Decoded, x: number, y: number, r: number): boolean {
  const [x0, y0, x1, y1] = s.box;
  if (x < x0 - r || x > x1 + r || y < y0 - r || y > y1 + r) return false;
  const p = s.pts;
  const reach = r + maxWidth(s) / 2;
  if (p.length === 3) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i + 5 < p.length; i += 3) if (segDist(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach) return true;
  return false;
}

// ---------------- printing ----------------

/** The sketch as a PNG for the PDF: print colours on white, 1600 px wide at most. */
export function sketchToPng(codes: string[], height: number): { url: string; w: number; h: number } {
  const k = 1.6;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(SKETCH_W * k);
  canvas.height = Math.max(1, Math.round(height * k));
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(k, k);
  drawAll(g, codes.map(decodeStroke).filter((s): s is Decoded => !!s), printPalette);
  return { url: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
}
