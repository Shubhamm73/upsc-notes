/**
 * Mind maps (0.13): a tree of labelled nodes with no size limit. Stored as one flat list of nodes in the
 * section's doc (node `mindMap`). Only nodes he dragged keep a position (pinned); everything else is laid
 * out each time it is drawn, radially around the centre or as a left-to-right tree. Pure.
 */
import { COLOURS, colourKey } from './looks';
import { esc, keyColour, measure, mix, n1, onColour, svgDoc, wrap, type Ink } from './svg-ink';

export type MMShape = 'pill' | 'box' | 'circle' | 'text';
export type MMLayout = 'radial' | 'tree';
export interface MMNode {
  id: string;
  text: string;
  parent: string | null;
  /** One of the 13 colour keys; null = the branch's colour (the centre: the subject's). */
  color: string | null;
  shape: MMShape;
  /** Position, only kept when pinned (he dragged it). */
  x: number;
  y: number;
  pinned: boolean;
  folded: boolean;
  /** A key line: shows in the header count, insights and review cards. */
  marked: boolean;
}
export interface MindMap {
  layout: MMLayout;
  nodes: MMNode[];
}
export const SHAPES: { id: MMShape; label: string }[] = [
  { id: 'pill', label: 'Pill' },
  { id: 'box', label: 'Box' },
  { id: 'circle', label: 'Circle' },
  { id: 'text', label: 'Text' }
];
/** Colours the main branches take in turn when he has not picked one. */
export const BRANCH_KEYS = ['psir', 'gs1', 'blue', 'interview', 'olive', 'violet', 'ca', 'cyan', 'gs2', 'gs4'].filter((k) => COLOURS.some((c) => c.key === k));

export const newId = () => 'n' + Math.random().toString(36).slice(2, 9);
const node = (id: string, text: string, parent: string | null, shape: MMShape = 'pill'): MMNode => ({ id, text, parent, color: null, shape, x: 0, y: 0, pinned: false, folded: false, marked: false });

export function sampleMindMap(): MindMap {
  const nodes: MMNode[] = [node('n0', 'Indian Federalism', null)];
  const br: [string, string[]][] = [
    ['Constitutional features', ['Seventh Schedule', 'Single Constitution', 'Article 356']],
    ['Fiscal federalism', ['Finance Commission', 'GST Council']],
    ['Cooperative federalism', ['NITI Aayog', 'Inter-State Council']],
    ['Challenges', ["Governor's role", 'Centre–state disputes']],
    ['Way forward', ['Sarkaria Commission', 'Punchhi Commission']]
  ];
  br.forEach(([t, ks], i) => {
    const b = `b${i}`;
    nodes.push(node(b, t, 'n0'));
    ks.forEach((k, j) => nodes.push(node(`b${i}k${j}`, k, b, 'box')));
  });
  return { layout: 'radial', nodes };
}

const SHAPE_IDS = SHAPES.map((s) => s.id);
/** Reads stored attributes into a map that always draws: one centre, no loops, no orphans. */
export function readMindMap(a: Record<string, unknown>): MindMap {
  const raw = Array.isArray(a.nodes) ? (a.nodes as unknown[]).filter((x) => x && typeof x === 'object') : [];
  const seen = new Set<string>();
  const nodes: MMNode[] = [];
  for (const x of raw) {
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id && !seen.has(o.id) ? o.id : newId();
    seen.add(id);
    nodes.push({
      id,
      text: typeof o.text === 'string' ? o.text : '',
      parent: typeof o.parent === 'string' ? o.parent : null,
      color: colourKey(o.color),
      shape: SHAPE_IDS.includes(o.shape as MMShape) ? (o.shape as MMShape) : 'pill',
      x: Number(o.x) || 0,
      y: Number(o.y) || 0,
      pinned: !!o.pinned,
      folded: !!o.folded,
      marked: !!o.marked
    });
  }
  if (!nodes.length) return sampleMindMap();
  const ids = new Set(nodes.map((n) => n.id));
  const root = nodes.find((n) => n.parent === null || !ids.has(n.parent)) ?? nodes[0];
  root.parent = null;
  for (const n of nodes) if (n !== root && (n.parent === null || !ids.has(n.parent) || n.parent === n.id)) n.parent = root.id;
  // break loops: anything that cannot reach the centre hangs from it
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const path = new Set<string>();
    let p: MMNode | undefined = n;
    while (p && p.parent !== null) {
      if (path.has(p.id)) {
        n.parent = root.id;
        break;
      }
      path.add(p.id);
      p = byId.get(p.parent);
    }
  }
  nodes.splice(nodes.indexOf(root), 1);
  nodes.unshift(root);
  return { layout: a.layout === 'tree' ? 'tree' : 'radial', nodes };
}

// ---------------- structure ----------------
export class Tree {
  byId: Map<string, MMNode>;
  kids: Map<string, MMNode[]>;
  root: MMNode;
  constructor(public m: MindMap) {
    this.byId = new Map(m.nodes.map((n) => [n.id, n]));
    this.kids = new Map();
    for (const n of m.nodes) {
      if (n.parent === null) continue;
      const k = this.kids.get(n.parent) ?? [];
      k.push(n);
      this.kids.set(n.parent, k);
    }
    this.root = m.nodes.find((n) => n.parent === null) ?? m.nodes[0];
  }
  childrenOf(id: string) {
    return this.kids.get(id) ?? [];
  }
  depth(n: MMNode) {
    let d = 0;
    let p = n;
    while (p.parent !== null && d < 999) {
      p = this.byId.get(p.parent)!;
      d++;
    }
    return d;
  }
  /** The node and everything under it. */
  subtree(id: string): MMNode[] {
    const out: MMNode[] = [];
    const walk = (n: MMNode) => {
      out.push(n);
      this.childrenOf(n.id).forEach(walk);
    };
    const n = this.byId.get(id);
    if (n) walk(n);
    return out;
  }
  /** Everything under a node (not the node). */
  descendants(id: string) {
    return this.subtree(id).length - 1;
  }
  /** Hidden because a node above it is folded. */
  hidden(n: MMNode, unfold = false): boolean {
    if (unfold) return false;
    let p = n.parent === null ? undefined : this.byId.get(n.parent);
    while (p) {
      if (p.folded) return true;
      p = p.parent === null ? undefined : this.byId.get(p.parent);
    }
    return false;
  }
  /** "Centre › Branch › Node" for a node (its context on a review card). */
  path(n: MMNode): string[] {
    const out: string[] = [];
    let p: MMNode | undefined = n;
    while (p) {
      out.unshift(p.text.trim() || 'Untitled');
      p = p.parent === null ? undefined : this.byId.get(p.parent);
    }
    return out;
  }
  /** The colour key of a node's branch (its own, else the nearest one above it, else the main branch's turn). */
  colourKeyOf(n: MMNode): string | null {
    let p: MMNode | undefined = n;
    while (p) {
      if (p.color) return p.color;
      if (p.parent === this.root.id) {
        const i = this.childrenOf(this.root.id).indexOf(p);
        return BRANCH_KEYS[i % BRANCH_KEYS.length];
      }
      p = p.parent === null ? undefined : this.byId.get(p.parent);
    }
    return null;
  }
}

// ---------------- sizes ----------------
export interface Box {
  w: number;
  h: number;
  fs: number;
  bold: boolean;
  lines: string[];
}
const sizes = new Map<string, Box>();
export function sizeOf(n: MMNode, d: number): Box {
  const key = `${Math.min(d, 2)}|${n.shape}|${n.text}`;
  const hit = sizes.get(key);
  if (hit) return hit;
  if (sizes.size > 4000) sizes.clear();
  const b = measureBox(n, d);
  sizes.set(key, b);
  return b;
}
function measureBox(n: MMNode, d: number): Box {
  const fs = d === 0 ? 21 : d === 1 ? 17 : 15;
  const bold = d < 2;
  const max = d === 0 ? 260 : 220;
  const ls = wrap(n.text.trim() || ' ', max, fs, bold, 4);
  const tw = Math.max(...ls.map((l) => measure(l, fs, bold)));
  const lh = fs * 1.22;
  if (n.shape === 'circle') {
    const dia = Math.max(64, Math.hypot(tw + 20, ls.length * lh + 14));
    return { w: dia, h: dia, fs, bold, lines: ls };
  }
  const padX = d === 0 ? 48 : 34;
  const base = d === 0 ? 60 : d === 1 ? 46 : 38;
  return { w: Math.max(70, tw + padX), h: base + (ls.length - 1) * lh, fs, bold, lines: ls };
}

// ---------------- layout ----------------
export type Pos = Map<string, { x: number; y: number }>;
/** Where every shown node sits. Pinned nodes keep their place; the rest are laid out. */
export function layoutMap(m: MindMap, opts: { unfold?: boolean } = {}): Pos {
  const t = new Tree(m);
  const pos: Pos = new Map();
  const shown = (n: MMNode) => opts.unfold || !n.folded;
  const kidsShown = (n: MMNode) => (shown(n) ? t.childrenOf(n.id) : []);
  const leaves = new Map<string, number>();
  const countLeaves = (n: MMNode): number => {
    const ks = kidsShown(n);
    const v = ks.length ? ks.reduce((a, k) => a + countLeaves(k), 0) : 1;
    leaves.set(n.id, v);
    return v;
  };
  countLeaves(t.root);
  const size = new Map<string, Box>();
  const sz = (n: MMNode) => {
    let b = size.get(n.id);
    if (!b) size.set(n.id, (b = sizeOf(n, t.depth(n))));
    return b;
  };
  // first every shown node's place as laid out (raw), then pins: a pinned node keeps its place and moves what hangs under it
  const raw: Pos = new Map();
  const set = (n: MMNode, x: number, y: number) => raw.set(n.id, { x, y });

  if (m.layout === 'tree') {
    // columns by depth, one row per leaf
    const colX: number[] = [0];
    const widest: number[] = [];
    const walkW = (n: MMNode, d: number) => {
      widest[d] = Math.max(widest[d] ?? 0, sz(n).w);
      kidsShown(n).forEach((k) => walkW(k, d + 1));
    };
    walkW(t.root, 0);
    for (let d = 1; d < widest.length; d++) colX[d] = colX[d - 1] + widest[d - 1] / 2 + 70 + widest[d] / 2;
    let y = 0;
    const walk = (n: MMNode, d: number): number => {
      const ks = kidsShown(n);
      let cy: number;
      if (!ks.length) {
        const hh = sz(n).h;
        cy = y + hh / 2;
        y += hh + 14;
      } else {
        const ys = ks.map((k) => walk(k, d + 1));
        cy = (ys[0] + ys[ys.length - 1]) / 2;
      }
      set(n, colX[d], cy);
      return cy;
    };
    walk(t.root, 0);
    // centre the root at 0,0
    const dy = raw.get(t.root.id)!.y;
    for (const p of raw.values()) p.y -= dy;
  } else {
    // radial: each main branch gets a slice of the circle in proportion to its leaves
    const total = leaves.get(t.root.id) || 1;
    let maxD = 0;
    const md = (n: MMNode, d: number) => {
      maxD = Math.max(maxD, d);
      kidsShown(n).forEach((k) => md(k, d + 1));
    };
    md(t.root, 0);
    // the outer ring starts at about 46 px per leaf, then grows until no two ideas overlap
    // (wide labels near the top and bottom of the ring need more room than tall ones at the sides)
    const outer = Math.max(170 + (maxD - 1) * 150, (total * 46) / (2 * Math.PI));
    let grow = 1;
    const ring = (d: number) => grow * (maxD <= 1 ? Math.max(170, outer) : 170 + ((outer - 170) * (d - 1)) / (maxD - 1));
    const place = (n: MMNode, a0: number, a1: number, d: number) => {
      const a = (a0 + a1) / 2;
      const r = ring(d);
      set(n, Math.cos(a) * r * 1.35, Math.sin(a) * r);
      let s = a0;
      const ks = kidsShown(n);
      const sum = ks.reduce((q, k) => q + (leaves.get(k.id) || 1), 0) || 1;
      for (const k of ks) {
        const share = ((a1 - a0) * (leaves.get(k.id) || 1)) / sum;
        place(k, s, s + share, d + 1);
        s += share;
      }
    };
    const overlaps = () => {
      const bs = [...raw].map(([id, p]) => ({ p, b: sz(byId.get(id)!) }));
      for (let i = 0; i < bs.length; i++)
        for (let j = i + 1; j < bs.length; j++) {
          const A = bs[i];
          const B = bs[j];
          if (Math.abs(A.p.x - B.p.x) < (A.b.w + B.b.w) / 2 + 6 && Math.abs(A.p.y - B.p.y) < (A.b.h + B.b.h) / 2 + 6) return true;
        }
      return false;
    };
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    for (let tries = 0; ; tries++) {
      raw.clear();
      set(t.root, 0, 0);
      let s = -Math.PI / 2 - Math.PI / Math.max(kidsShown(t.root).length, 1) + 0.35;
      for (const k of kidsShown(t.root)) {
        const share = (2 * Math.PI * (leaves.get(k.id) || 1)) / total;
        place(k, s, s + share, 1);
        s += share;
      }
      if (tries >= 12 || !overlaps()) break;
      grow *= 1.1;
    }
  }
  const fin = (n: MMNode, sx: number, sy: number) => {
    const r = raw.get(n.id);
    if (!r) return;
    const p = n.pinned ? { x: n.x, y: n.y } : { x: r.x + sx, y: r.y + sy };
    pos.set(n.id, p);
    for (const k of kidsShown(n)) fin(k, p.x - r.x, p.y - r.y);
  };
  fin(t.root, 0, 0);
  return pos;
}

// ---------------- drawing ----------------
export interface MMDrawOpts {
  unfold?: boolean;
  selected?: string | null;
  /** Night or day "marked" colour. */
  mark?: string;
  animate?: boolean;
}
/** The inner SVG (edges, then nodes) and the box it covers. */
export function mindMapBody(m: MindMap, ink: Ink, o: MMDrawOpts = {}): { body: string; box: { x: number; y: number; w: number; h: number }; pos: Pos } {
  const t = new Tree(m);
  const pos = layoutMap(m, { unfold: o.unfold });
  const mark = o.mark ?? (ink.night ? '#6b5a1a' : '#fde68a');
  const colour = (n: MMNode) => {
    if (n.parent === null) return n.color ? keyColour(n.color, ink) : ink.subj;
    const k = t.colourKeyOf(n);
    return k ? keyColour(k, ink) : ink.subj;
  };
  let edges = '';
  let nodes = '';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of m.nodes) {
    if (t.hidden(n, o.unfold) || !pos.has(n.id)) continue;
    const p = pos.get(n.id)!;
    const d = t.depth(n);
    const b = sizeOf(n, d);
    x0 = Math.min(x0, p.x - b.w / 2 - 8);
    y0 = Math.min(y0, p.y - b.h / 2 - 8);
    x1 = Math.max(x1, p.x + b.w / 2 + 30);
    y1 = Math.max(y1, p.y + b.h / 2 + 8);
    const c = colour(n);
    if (n.parent !== null && pos.has(n.parent)) {
      const q = pos.get(n.parent)!;
      const horiz = m.layout === 'tree' || Math.abs(p.x - q.x) > Math.abs(p.y - q.y);
      const path = horiz ? `M${n1(q.x)},${n1(q.y)} C${n1((q.x + p.x) / 2)},${n1(q.y)} ${n1((q.x + p.x) / 2)},${n1(p.y)} ${n1(p.x)},${n1(p.y)}` : `M${n1(q.x)},${n1(q.y)} C${n1(q.x)},${n1((q.y + p.y) / 2)} ${n1(p.x)},${n1((q.y + p.y) / 2)} ${n1(p.x)},${n1(p.y)}`;
      edges += `<path d="${path}" fill="none" stroke="${c}" stroke-width="${d === 1 ? 5 : d === 2 ? 3 : 2}" stroke-opacity="0.8" stroke-linecap="round"/>`;
    }
    const w = b.w;
    const h = b.h;
    const rx = n.shape === 'box' ? 10 : n.shape === 'circle' ? w / 2 : h / 2;
    let shape: string;
    let tc = ink.fg;
    if (d === 0 && n.shape !== 'text') {
      shape = `<rect x="${n1(-w / 2)}" y="${n1(-h / 2)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(n.shape === 'box' ? 12 : rx)}" fill="${c}"/>`;
      tc = onColour(c);
    } else if (n.shape === 'text') shape = `<rect x="${n1(-w / 2)}" y="${n1(-h / 2)}" width="${n1(w)}" height="${n1(h)}" fill="${mix(ink.surface, ink.surface2, 0.5)}" fill-opacity="0.85"/><line x1="${n1(-w / 2 + 10)}" x2="${n1(w / 2 - 10)}" y1="${n1(h / 2 - 4)}" y2="${n1(h / 2 - 4)}" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`;
    else shape = `<rect x="${n1(-w / 2)}" y="${n1(-h / 2)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(rx)}" fill="${d === 1 ? mix(ink.surface, c, 0.18) : ink.surface}" stroke="${c}" stroke-width="${d === 1 ? 2.5 : 1.5}"/>`;
    const sel = o.selected === n.id ? `<rect x="${n1(-w / 2 - 6)}" y="${n1(-h / 2 - 6)}" width="${n1(w + 12)}" height="${n1(h + 12)}" rx="${n1(n.shape === 'box' && d ? 14 : Math.min((h + 12) / 2, (w + 12) / 2))}" fill="none" stroke="${ink.fg}" stroke-width="2" stroke-dasharray="5 4"/>` : '';
    const lh = b.fs * 1.22;
    const top = -((b.lines.length - 1) * lh) / 2 + b.fs * 0.35;
    const hl = n.marked ? b.lines.map((l, i) => { const lw = measure(l, b.fs, b.bold); return `<rect x="${n1(-lw / 2 - 3)}" y="${n1(top + i * lh - b.fs * 0.8)}" width="${n1(lw + 6)}" height="${n1(b.fs * 1.05)}" rx="3" fill="${mark}"/>`; }).join('') : '';
    const text = b.lines.map((l, i) => `<text x="0" y="${n1(top + i * lh)}" text-anchor="middle" fill="${n.marked ? ink.fg : tc}" font-size="${b.fs}"${b.bold ? ' font-weight="bold"' : ''} font-family="Atkinson Hyperlegible, Roboto, sans-serif">${esc(l)}</text>`).join('');
    const kids = t.childrenOf(n.id).length;
    const fold = n.folded && kids && !o.unfold ? `<g><circle cx="${n1(w / 2 + 14)}" cy="0" r="13" fill="${c}"/><text x="${n1(w / 2 + 14)}" y="4.5" text-anchor="middle" fill="${onColour(c)}" font-size="12" font-weight="bold" font-family="Atkinson Hyperlegible, Roboto, sans-serif">+${t.descendants(n.id)}</text></g>` : '';
    nodes += `<g class="mm-node${o.animate ? ' ch-in' : ''}" data-id="${esc(n.id)}" transform="translate(${n1(p.x)},${n1(p.y)})">${sel}${shape}${hl}${text}${fold}</g>`;
  }
  if (!Number.isFinite(x0)) (x0 = -100), (y0 = -50), (x1 = 100), (y1 = 50);
  return { body: edges + nodes, box: { x: x0 - 10, y: y0 - 10, w: x1 - x0 + 20, h: y1 - y0 + 20 }, pos };
}
/** The whole map as one picture (in the note, and in the PDF with every branch unfolded). */
export function renderMindMap(m: MindMap, ink: Ink, o: MMDrawOpts = {}): { svg: string; w: number; h: number } {
  const { body, box } = mindMapBody(m, ink, o);
  const label = `Mind map: ${m.nodes[0]?.text ?? ''}, ${m.nodes.length} ideas`;
  const svg = svgDoc(box.w, box.h, body, label).replace(`viewBox="0 0 ${n1(box.w)} ${n1(box.h)}"`, `viewBox="${n1(box.x)} ${n1(box.y)} ${n1(box.w)} ${n1(box.h)}"`);
  return { svg, w: box.w, h: box.h };
}

/** Every label, for search. */
export const mindMapWords = (m: MindMap) => ['mind map', ...m.nodes.map((n) => n.text)].join(' ');
/** Marked nodes with their path ("Centre › Branch") for key lines and review cards. */
export function markedNodes(m: MindMap): { text: string; context: string }[] {
  const t = new Tree(m);
  return m.nodes.filter((n) => n.marked && n.text.trim()).map((n) => ({ text: n.text.trim(), context: t.path(n).slice(0, -1).join(' › ') }));
}
