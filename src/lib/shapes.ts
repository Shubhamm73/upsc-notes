/**
 * Picture shapes (Crop & shape). One definition drives the screen (CSS clip-path, and
 * shape-outside so text beside a floated picture follows its edge), the crop editor's
 * preview, and the PDF (a canvas clip). Points are fractions of the picture's box.
 */
export interface ShapeDef {
  id: string;
  label: string;
  /** Corner points, or an ellipse, or a rounded rectangle; none = the plain picture. */
  kind: 'none' | 'polygon' | 'ellipse' | 'round';
  points?: [number, number][];
  /** Width ÷ height that makes the shape regular (picked with it, can be changed after). */
  ratio?: number;
  /** The circle only works as a square crop. */
  lock?: boolean;
}

function star(points = 5, inner = 0.4): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    out.push([0.5 + (r * Math.cos(a)) / 2, 0.5 + (r * Math.sin(a)) / 2 + 0.05]);
  }
  // stretch so the star touches the top and bottom of its box
  const ys = out.map((p) => p[1]);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  return out.map(([x, y]) => [round(x), round((y - min) / (max - min))]);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export const SHAPES: ShapeDef[] = [
  { id: 'rect', label: 'Original', kind: 'none' },
  { id: 'rounded', label: 'Rounded', kind: 'round' },
  { id: 'circle', label: 'Circle', kind: 'ellipse', ratio: 1, lock: true },
  { id: 'oval', label: 'Oval', kind: 'ellipse' },
  { id: 'triangle', label: 'Triangle', kind: 'polygon', ratio: 1.155, points: [[0.5, 0], [1, 1], [0, 1]] },
  { id: 'rhombus', label: 'Rhombus', kind: 'polygon', ratio: 1, points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] },
  { id: 'pentagon', label: 'Pentagon', kind: 'polygon', ratio: 1.051, points: [[0.5, 0], [1, 0.382], [0.809, 1], [0.191, 1], [0, 0.382]] },
  { id: 'hexagon', label: 'Hexagon', kind: 'polygon', ratio: 1.155, points: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]] },
  { id: 'octagon', label: 'Octagon', kind: 'polygon', ratio: 1, points: [[0.293, 0], [0.707, 0], [1, 0.293], [1, 0.707], [0.707, 1], [0.293, 1], [0, 0.707], [0, 0.293]] },
  { id: 'star', label: 'Star', kind: 'polygon', ratio: 1.05, points: star() },
  { id: 'parallelogram', label: 'Parallelogram', kind: 'polygon', ratio: 1.6, points: [[0.22, 0], [1, 0], [0.78, 1], [0, 1]] },
  { id: 'arch', label: 'Arch', kind: 'polygon', ratio: 0.8, points: arch() }
];

function arch(): [number, number][] {
  const out: [number, number][] = [[0, 1]];
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI + (i * Math.PI) / 16;
    out.push([round(0.5 + 0.5 * Math.cos(a)), round(0.4 + 0.4 * Math.sin(a))]);
  }
  out.push([1, 1]);
  return out;
}

export function shapeOf(id: unknown): ShapeDef {
  return SHAPES.find((s) => s.id === id) ?? SHAPES[0];
}

/** Rounded corners: this share of the shorter side. */
export const ROUND = 0.08;

/** CSS clip-path for a shape ('' = none). */
export function clipCss(id: unknown): string {
  const s = shapeOf(id);
  if (s.kind === 'ellipse') return 'ellipse(50% 50% at 50% 50%)';
  if (s.kind === 'round') return 'inset(0 round 18px)';
  if (s.kind === 'polygon') return `polygon(${s.points!.map(([x, y]) => `${round(x * 100)}% ${round(y * 100)}%`).join(', ')})`;
  return '';
}

/** Traces a shape on a canvas (or Path2D) in a box of w × h at x, y. */
export function tracePath(ctx: CanvasRenderingContext2D | Path2D, id: unknown, x: number, y: number, w: number, h: number) {
  const s = shapeOf(id);
  if (s.kind === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (s.kind === 'round') {
    const r = Math.min(w, h) * ROUND;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  } else if (s.kind === 'polygon') {
    s.points!.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * w, y + py * h) : ctx.moveTo(x + px * w, y + py * h)));
    ctx.closePath();
  } else {
    ctx.rect(x, y, w, h);
  }
}

/** SVG path data for a shape in a box (crop editor preview and shape chips). */
export function svgPath(id: unknown, x: number, y: number, w: number, h: number): string {
  const s = shapeOf(id);
  if (s.kind === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    return `M${x} ${y + ry}a${rx} ${ry} 0 1 0 ${w} 0a${rx} ${ry} 0 1 0 ${-w} 0Z`;
  }
  if (s.kind === 'round') {
    const r = Math.min(w, h) * ROUND * 1.6;
    return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
  }
  if (s.kind === 'polygon') return `M${s.points!.map(([px, py]) => `${x + px * w} ${y + py * h}`).join('L')}Z`;
  return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}

/** A crop: the visible part of the (rotated) picture, as fractions of it. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function readCrop(v: unknown): Crop | null {
  const c = v as Partial<Crop> | null;
  if (!c || typeof c !== 'object') return null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (!ok(c.x) || !ok(c.y) || !ok(c.w) || !ok(c.h)) return null;
  const w = Math.min(1, Math.max(0.01, c.w!));
  const h = Math.min(1, Math.max(0.01, c.h!));
  return { x: Math.min(1 - w, Math.max(0, c.x!)), y: Math.min(1 - h, Math.max(0, c.y!)), w, h };
}

export const normRotate = (v: unknown) => (((Math.round(Number(v) / 90) * 90) % 360) + 360) % 360 || 0;

/** True when the picture is shown exactly as stored (no crop, turn or mirror). */
export function isPlain(attrs: Record<string, unknown>): boolean {
  return !readCrop(attrs.crop) && !normRotate(attrs.rotate) && !attrs.flip;
}

/**
 * Lays out a picture (natural size W × H) turned by `rotate` and mirrored by `flip` so it
 * exactly fills its positioned parent box. Transform only; the stored picture is never changed.
 */
export function placeRotated(img: HTMLElement, W: number, H: number, rotate: number, flip: boolean) {
  const rot = normRotate(rotate);
  const mirror = flip ? 'scaleX(-1) ' : '';
  const s = img.style;
  s.position = 'absolute';
  if (rot % 180 === 0) {
    Object.assign(s, { left: '0', top: '0', width: '100%', height: '100%', transform: `${mirror}rotate(${rot}deg)` });
  } else {
    // the unturned picture is as wide as the box is tall, then turned a quarter
    const wr = H; // turned width
    const hr = W; // turned height
    Object.assign(s, {
      left: '50%',
      top: '50%',
      width: `${(hr / wr) * 100}%`,
      height: `${(wr / hr) * 100}%`,
      transform: `translate(-50%, -50%) ${mirror}rotate(${rot}deg)`
    });
  }
  s.transformOrigin = '50% 50%';
  s.maxWidth = 'none';
}
