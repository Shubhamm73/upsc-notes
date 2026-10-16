/**
 * Diagrams "from words" (0.13): timeline, flowchart, cycle, pyramid, Venn, hierarchy, comparison and a
 * 2×2 matrix. Each is a list of items (a label, a detail line, an optional colour); the layout is drawn
 * for him. Pure: data + Ink in, SVG string out, the same on screen and in the PDF.
 */
import { arrowHead, clip, esc, keyColour, lines, measure, mix, n1, onColour, paletteColours, readPalette, svgDoc, T, wrap, type Ink, type PaletteId } from './svg-ink';
import { colourKey } from './looks';

export type DiagramKind = 'timeline' | 'flow' | 'cycle' | 'pyramid' | 'venn' | 'tree' | 'compare' | 'matrix';
export interface DiagramItem {
  text: string;
  detail: string;
  /** One of the 13 colour keys, or null (palette colour). */
  color: string | null;
  /** Hierarchy only: 0 = top. */
  level: number;
  /** Comparison only: one cell per column. */
  cells: string[];
}
export interface DiagramData {
  kind: DiagramKind;
  title: string;
  items: DiagramItem[];
  /** Comparison: column heads. */
  heads: string[];
  /** Venn: what every set shares. Cycle: the word in the middle. */
  note: string;
  palette: PaletteId;
}

export const DIAGRAM_KINDS: { kind: DiagramKind; name: string; hint: string }[] = [
  { kind: 'timeline', name: 'Timeline', hint: 'Events in order' },
  { kind: 'flow', name: 'Flowchart', hint: 'Steps with arrows' },
  { kind: 'cycle', name: 'Cycle', hint: 'Steps that loop back' },
  { kind: 'pyramid', name: 'Pyramid', hint: 'Levels from top to base' },
  { kind: 'venn', name: 'Venn', hint: 'What two or three things share' },
  { kind: 'tree', name: 'Hierarchy', hint: 'Who sits under whom' },
  { kind: 'compare', name: 'Comparison', hint: 'Side-by-side facts' },
  { kind: 'matrix', name: '2×2 matrix', hint: 'SWOT and other four-box grids' }
];
export const isDiagramKind = (v: unknown): v is DiagramKind => DIAGRAM_KINDS.some((k) => k.kind === v);
export const diagramKindName = (k: string) => DIAGRAM_KINDS.find((c) => c.kind === k)?.name ?? 'Diagram';
/** What "Text" and "Detail" mean for each kind, for the editor's labels. */
export const ITEM_WORDS: Record<DiagramKind, [string, string, string]> = {
  timeline: ['Event', 'Date or year', 'What happened'],
  flow: ['Step', 'Step', 'Note (optional)'],
  cycle: ['Step', 'Step', 'Note (optional)'],
  pyramid: ['Level', 'Level', 'Note (optional)'],
  venn: ['Set', 'Name', 'Only in this set'],
  tree: ['Box', 'Name', 'Note (optional)'],
  compare: ['Row', 'Row label', ''],
  matrix: ['Box', 'Heading', 'Points']
};

const it = (text: string, detail = '', level = 0, cells: string[] = []): DiagramItem => ({ text, detail, color: null, level, cells });
type Sample = Omit<DiagramData, 'kind' | 'palette'>;
export const DIAGRAM_SAMPLES: Record<DiagramKind, Sample> = {
  timeline: {
    title: 'National movement',
    items: [it('1857', 'Revolt'), it('1885', 'INC founded'), it('1905', 'Bengal partition'), it('1919', 'Jallianwala'), it('1920', 'Non-Cooperation'), it('1930', 'Dandi March'), it('1942', 'Quit India'), it('1947', 'Independence')],
    heads: [],
    note: ''
  },
  flow: {
    title: 'How a Bill becomes law',
    items: [it('Introduced'), it('First reading'), it('Committee'), it('Passed by both Houses'), it("President's assent"), it('Becomes an Act')],
    heads: [],
    note: ''
  },
  cycle: { title: 'Water cycle', items: [it('Evaporation'), it('Condensation'), it('Precipitation'), it('Collection')], heads: [], note: 'Water cycle' },
  pyramid: { title: 'Ecological pyramid', items: [it('Tertiary consumers'), it('Secondary consumers'), it('Primary consumers'), it('Producers')], heads: [], note: '' },
  venn: {
    title: 'Fundamental Rights and DPSP',
    items: [it('Fundamental Rights', 'Justiciable\nLimit the State'), it('DPSP', 'Not justiciable\nGuide the State')],
    heads: [],
    note: 'Both aim at a welfare state'
  },
  tree: {
    title: 'Parliament of India',
    items: [it('Parliament', '', 0), it('Lok Sabha', 'House of the People', 1), it('President', 'Head of State', 1), it('Rajya Sabha', 'Council of States', 1)],
    heads: [],
    note: ''
  },
  compare: {
    title: 'Lok Sabha vs Rajya Sabha',
    items: [it('Members', '', 0, ['552 max', '250 max']), it('Term', '', 0, ['5 years', 'Permanent']), it('Money Bill', '', 0, ['Introduced', 'Recommends']), it('No-confidence', '', 0, ['Yes', 'No'])],
    heads: ['Lok Sabha', 'Rajya Sabha'],
    note: ''
  },
  matrix: {
    title: "SWOT: India's space sector",
    items: [
      it('Strengths', 'Low-cost launches\nProven Mars and Moon missions'),
      it('Weaknesses', 'Small private industry\nFew launches a year'),
      it('Opportunities', 'Global satellite market\nSpace start-ups'),
      it('Threats', 'Space debris\nCompetition from others')
    ],
    heads: [],
    note: ''
  }
};
export function sampleDiagram(kind: DiagramKind): DiagramData {
  return { kind, palette: 'desk', ...structuredClone(DIAGRAM_SAMPLES[kind]) };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
export function readDiagram(a: Record<string, unknown>): DiagramData {
  const kind: DiagramKind = isDiagramKind(a.kind) ? a.kind : 'timeline';
  const items = Array.isArray(a.items)
    ? (a.items as unknown[]).filter((x) => x && typeof x === 'object').map((x) => {
        const o = x as Record<string, unknown>;
        return { text: str(o.text), detail: str(o.detail), color: colourKey(o.color), level: Math.max(0, Math.min(6, Math.round(Number(o.level) || 0))), cells: Array.isArray(o.cells) ? o.cells.map(str) : [] };
      })
    : sampleDiagram(kind).items;
  return { kind, title: str(a.title), items, heads: Array.isArray(a.heads) ? a.heads.map(str) : kind === 'compare' ? ['A', 'B'] : [], note: str(a.note), palette: readPalette(a.palette) };
}
/** Every word of a diagram, for search. */
export const diagramWords = (d: DiagramData) => ['diagram', diagramKindName(d.kind), d.title, d.note, ...d.heads, ...d.items.flatMap((i) => [i.text, i.detail, ...i.cells])].filter(Boolean).join(' ');

/** Hierarchy levels as drawn: the first item is the top; each item sits at most one level under the one above it. */
export function treeLevels(items: DiagramItem[]): number[] {
  const out: number[] = [];
  items.forEach((s, i) => out.push(i === 0 ? 0 : Math.max(1, Math.min(s.level, out[i - 1] + 1))));
  return out;
}

const W = 560;
export function renderDiagram(d: DiagramData, ink: Ink, o: { animate?: boolean; desk?: string[] } = {}): { svg: string; w: number; h: number } {
  const cols = paletteColours(d.palette, ink, o.desk);
  const col = (i: number) => cols[((i % 6) + 6) % 6];
  const ic = (i: number, fallback = i) => (d.items[i]?.color ? keyColour(d.items[i].color, ink) : col(fallback));
  const anim = o.animate ? ' class="ch-in"' : '';
  const fg = ink.fg;
  const muted = ink.muted;
  const tint = (c: string, t: number) => mix(ink.surface, c, t);
  const items = d.items;
  const n = items.length;
  let body = '';
  let h = 320;
  if (!n) return { svg: svgDoc(W, 120, T(W / 2, 64, 'Add an item to draw this diagram', { c: muted, s: 14 }), diagramKindName(d.kind)), w: W, h: 120 };

  switch (d.kind) {
    case 'timeline': {
      if (n <= 8) {
        const L = 36;
        const R = W - 36;
        const y = 160;
        body += `<line x1="${L - 10}" x2="${R + 10}" y1="${y}" y2="${y}" stroke="${ink.line}" stroke-width="4" stroke-linecap="round"/>`;
        const gap = n > 1 ? (R - L) / (n - 1) : 0;
        items.forEach((e, i) => {
          const x = n > 1 ? L + i * gap : W / 2;
          const up = i % 2 === 0;
          const c = ic(i, i % 6);
          const room = Math.max(gap * 2 - 12, 90);
          body += `<g${anim}><line x1="${n1(x)}" x2="${n1(x)}" y1="${y}" y2="${up ? y - 46 : y + 46}" stroke="${c}" stroke-width="2"/><circle cx="${n1(x)}" cy="${y}" r="9" fill="${ink.surface}" stroke="${c}" stroke-width="4"/>`;
          const det = wrap(e.detail, room, 11.5, false, 3);
          if (up) body += T(x, y - 54 - (det.length - 1) * 14 - 16, clip(e.text, room, 15, true), { c, s: 15, bold: true }) + det.map((l, k) => T(x, y - 54 - (det.length - 1 - k) * 14, l, { c: fg, s: 11.5 })).join('');
          else body += T(x, y + 70, clip(e.text, room, 15, true), { c, s: 15, bold: true }) + det.map((l, k) => T(x, y + 88 + k * 14, l, { c: fg, s: 11.5 })).join('');
          body += '</g>';
        });
      } else {
        // a long timeline runs down the page
        const x = 110;
        let y = 24;
        body += '';
        const rows: string[] = [];
        items.forEach((e, i) => {
          const c = ic(i, i % 6);
          const det = wrap(e.detail, W - x - 40, 13, false, 4);
          const rh = Math.max(40, det.length * 17 + 14);
          rows.push(`<g${anim}><circle cx="${x}" cy="${y + 10}" r="8" fill="${ink.surface}" stroke="${c}" stroke-width="4"/>${T(x - 20, y + 15, clip(e.text, x - 30, 14, true), { a: 'end', c, s: 14, bold: true })}${det.map((l, k) => T(x + 22, y + 15 + k * 17, l, { a: 'start', c: fg, s: 13 })).join('')}</g>`);
          y += rh;
        });
        body += `<line x1="${x}" x2="${x}" y1="18" y2="${y - 20}" stroke="${ink.line}" stroke-width="4" stroke-linecap="round"/>` + rows.join('');
        h = y + 4;
      }
      break;
    }
    case 'flow': {
      const per = 3;
      const bw = 160;
      const gx = (W - per * bw) / (per + 1);
      const rows = Math.ceil(n / per);
      const bh = items.some((s) => s.detail) ? 78 : 64;
      const gy = 70;
      const pos = items.map((_, i) => {
        const r = Math.floor(i / per);
        const c = r % 2 === 0 ? i % per : per - 1 - (i % per);
        return [gx + c * (bw + gx), 30 + r * (bh + gy)] as [number, number];
      });
      h = 30 + rows * (bh + gy) - gy + 24;
      const c0 = col(0);
      for (let i = 0; i < n - 1; i++) {
        const [x1, y1] = pos[i];
        const [x2, y2] = pos[i + 1];
        if (y1 === y2) {
          const dir = x2 > x1 ? 1 : -1;
          const sx = x1 + (dir > 0 ? bw : 0) + dir * 4;
          const ex = x2 + (dir > 0 ? 0 : bw) - dir * 4;
          body += `<line x1="${n1(sx)}" y1="${n1(y1 + bh / 2)}" x2="${n1(ex - dir * 8)}" y2="${n1(y2 + bh / 2)}" stroke="${muted}" stroke-width="2"/>` + arrowHead(ex, y2 + bh / 2, dir > 0 ? 0 : Math.PI, muted);
        } else {
          body += `<line x1="${n1(x1 + bw / 2)}" y1="${n1(y1 + bh + 4)}" x2="${n1(x2 + bw / 2)}" y2="${n1(y2 - 12)}" stroke="${muted}" stroke-width="2"/>` + arrowHead(x2 + bw / 2, y2 - 4, Math.PI / 2, muted);
        }
      }
      items.forEach((s, i) => {
        const [x, y] = pos[i];
        const last = i === n - 1;
        const c = s.color ? keyColour(s.color, ink) : c0;
        const txt = wrap(s.text, bw - 20, 13.5, true, s.detail ? 2 : 3);
        const det = s.detail ? [clip(s.detail, bw - 18, 11.5)] : [];
        const ty = y + bh / 2 - (det.length ? 8 : 0);
        body += `<g${anim}><rect x="${n1(x)}" y="${n1(y)}" width="${bw}" height="${bh}" rx="14" fill="${last ? c : tint(c, 0.12)}" stroke="${c}" stroke-width="1.5"/>` + lines(x + bw / 2, ty, txt, { c: last ? onColour(c) : fg, s: 13.5, bold: true, lh: 16 }) + (det.length ? T(x + bw / 2, y + bh - 14, det[0], { c: last ? onColour(c) : muted, s: 11.5 }) : '') + T(x + 14, y - 8, String(i + 1), { a: 'start', s: 11, c: muted }) + '</g>';
      });
      break;
    }
    case 'cycle': {
      const cx = W / 2;
      const r = n > 6 ? 128 : 110;
      const cy = r + 50;
      h = cy * 2;
      const pw = n > 6 ? 116 : 132;
      const gapA = Math.min(0.42, (Math.PI / n) * 0.84) + (n > 6 ? 0.02 : 0);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const a2 = a + (2 * Math.PI) / n;
        const s0 = a + gapA + (n <= 2 ? 0.3 : 0);
        const s1 = a2 - gapA - (n <= 2 ? 0.3 : 0);
        if (s1 <= s0) continue;
        body += `<path d="M${n1(cx + r * Math.cos(s0))},${n1(cy + r * Math.sin(s0))} A${r},${r} 0 0 1 ${n1(cx + r * Math.cos(s1 - 0.06))},${n1(cy + r * Math.sin(s1 - 0.06))}" fill="none" stroke="${muted}" stroke-width="2.5"/>` + arrowHead(cx + r * Math.cos(s1), cy + r * Math.sin(s1), s1 + Math.PI / 2, muted);
      }
      items.forEach((s, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        const c = ic(i, 2 + (i % 2) * 2);
        const t = wrap(s.text, pw - 22, 13.5, true, 2);
        const ph = t.length > 1 ? 56 : 44;
        body += `<g${anim}><rect x="${n1(x - pw / 2)}" y="${n1(y - ph / 2)}" width="${pw}" height="${ph}" rx="${ph / 2}" fill="${c}"/>${lines(x, y, t, { c: onColour(c), s: 13.5, bold: true, lh: 16 })}</g>`;
      });
      if (d.note) body += lines(cx, cy, wrap(d.note, r * 1.1, 16, true, 3), { c: fg, s: 16, bold: true, lh: 19 });
      break;
    }
    case 'pyramid': {
      const top = 24;
      const lh = n > 6 ? 46 : n > 4 ? 56 : 66;
      const cx = W / 2;
      const step = Math.min(110, (W - 100) / n);
      h = top + n * (lh + 4) + 20;
      items.forEach((s, i) => {
        const w0 = 70 + i * step;
        const w1 = 70 + (i + 1) * step;
        const y = top + i * (lh + 4);
        const base = s.color ? keyColour(s.color, ink) : col(4);
        const c = s.color ? base : tint(base, 0.45 + (0.55 * i) / Math.max(n - 1, 1));
        const room = w0 + (w1 - w0) / 2 - 24;
        const t = wrap(s.text, room, 13.5, true, 2);
        const det = s.detail && room > 140 ? [clip(s.detail, room, 11.5)] : [];
        const tc = onColour(c);
        body += `<g${anim}><path d="M${n1(cx - w0 / 2)},${y} L${n1(cx + w0 / 2)},${y} L${n1(cx + w1 / 2)},${y + lh} L${n1(cx - w1 / 2)},${y + lh} Z" fill="${c}"/>${lines(cx, y + lh / 2 - (det.length ? 7 : 0), t, { c: tc, s: 13.5, bold: true, lh: 16 })}${det.length ? T(cx, y + lh / 2 + 15, det[0], { c: tc, s: 11.5 }) : ''}</g>`;
      });
      break;
    }
    case 'venn': {
      const sets = items.slice(0, 3);
      if (sets.length === 3) {
        const r = 104;
        const C: [number, number][] = [
          [W / 2 - 66, 156],
          [W / 2 + 66, 156],
          [W / 2, 268]
        ];
        h = 404;
        sets.forEach((_, i) => (body += `<circle cx="${C[i][0]}" cy="${C[i][1]}" r="${r}" fill="${ic(i, [2, 1, 4][i])}" fill-opacity="0.2" stroke="${ic(i, [2, 1, 4][i])}" stroke-width="2"${anim}/>`));
        const lab: [number, number, 'start' | 'end' | 'middle'][] = [
          [C[0][0] - 50, 86, 'middle'],
          [C[1][0] + 50, 86, 'middle'],
          [W / 2, 350, 'middle']
        ];
        sets.forEach((s, i) => {
          const c = ic(i, [2, 1, 4][i]);
          const [x, y] = lab[i];
          // set names sit outside their circles, clear of the strokes
          body += T(x, i === 2 ? C[2][1] + r + 22 : C[i][1] - r - 12, clip(s.text, 150, 14, true), { c, s: 14, bold: true });
          const det = s.detail.split('\n').flatMap((l) => wrap(l, 96, 12)).slice(0, 3);
          det.forEach((l, k) => (body += T(i === 2 ? x : x + (i === 0 ? -6 : 6), (i === 2 ? y - 34 : y + 34) + k * 15 - (i === 2 ? (det.length - 1) * 15 : 0), l, { c: fg, s: 12 })));
        });
        if (d.note) body += lines(W / 2, 196, wrap(d.note, 70, 11.5, true, 3), { c: fg, s: 11.5, bold: true, lh: 14 });
      } else {
        const r = 122;
        const cxs = sets.length === 1 ? [W / 2] : [215, 345];
        sets.forEach((_, i) => (body += `<circle cx="${cxs[i]}" cy="160" r="${r}" fill="${ic(i, [2, 1][i])}" fill-opacity="0.2" stroke="${ic(i, [2, 1][i])}" stroke-width="2"${anim}/>`));
        sets.forEach((s, i) => {
          const x = sets.length === 1 ? W / 2 : i === 0 ? 160 : 400;
          body += T(x, 80, clip(s.text, 150, 14, true), { c: ic(i, [2, 1][i]), s: 14, bold: true });
          const det = s.detail.split('\n').flatMap((l) => wrap(l, sets.length === 1 ? 200 : 104, 13)).slice(0, 4);
          det.forEach((l, k) => (body += T(x, 150 + k * 22 - (det.length > 2 ? 11 : 0), l, { c: fg, s: 13 })));
        });
        if (d.note && sets.length === 2) body += lines(W / 2, 160, wrap(d.note, 84, 12.5, true, 4), { c: fg, s: 12.5, bold: true, lh: 18 });
      }
      break;
    }
    case 'tree': {
      // parents come from levels: an item hangs under the nearest item above it one level up
      const lv = treeLevels(items);
      const parent = lv.map((l, i) => {
        if (i === 0) return -1;
        for (let j = i - 1; j >= 0; j--) if (lv[j] < l) return j;
        return 0;
      });
      const kids = (p: number) => items.map((_, i) => i).filter((i) => parent[i] === p);
      const depth = (i: number): number => (parent[i] < 0 ? 0 : 1 + depth(parent[i]));
      const leaves = (i: number): number => (kids(i).length ? kids(i).reduce((a, k) => a + leaves(k), 0) : 1);
      const roots = items.map((_, i) => i).filter((i) => parent[i] < 0);
      const maxD = Math.max(...items.map((_, i) => depth(i)));
      const totalLeaves = roots.reduce((a, r) => a + leaves(r), 0);
      const pos: [number, number][] = [];
      const bw = 150;
      const bh = 50;
      const colourOf = (i: number): string => {
        let j = i;
        while (j >= 0 && !items[j].color && depth(j) > 1) j = parent[j];
        if (j >= 0 && items[j].color) return keyColour(items[j].color, ink);
        const top = depth(i) === 0 ? i : (() => { let k = i; while (depth(k) > 1) k = parent[k]; return k; })();
        return depth(i) === 0 ? col(0) : col(kids(parent[top]).indexOf(top) * 2 + 1);
      };
      if (totalLeaves <= 4 && maxD <= 2) {
        // top-down
        const lw = (W - 20) / totalLeaves;
        let leaf = 0;
        const walk = (i: number): number => {
          const ks = kids(i);
          const y = 30 + depth(i) * 130;
          if (!ks.length) {
            pos[i] = [10 + lw * (leaf + 0.5), y];
            leaf++;
          } else {
            const xs = ks.map(walk);
            pos[i] = [(xs[0] + xs[xs.length - 1]) / 2, y];
          }
          return pos[i][0];
        };
        roots.forEach(walk);
        h = 30 + maxD * 130 + bh + (items.some((s, i) => s.detail && depth(i) > 0) ? 44 : 20);
        const w = Math.min(bw + 10, lw - 16);
        items.forEach((_, i) => {
          if (parent[i] < 0) return;
          const [px, py] = pos[parent[i]];
          const [x, y] = pos[i];
          body += `<path d="M${n1(px)},${py + bh} V${n1(py + bh + 44)} H${n1(x)} V${y}" fill="none" stroke="${muted}" stroke-width="2"/>`;
        });
        items.forEach((s, i) => {
          const [x, y] = pos[i];
          const c = colourOf(i);
          const root = depth(i) === 0;
          const t = wrap(s.text, w - 16, root ? 16 : 14.5, true, 2);
          body += `<g${anim}><rect x="${n1(x - w / 2)}" y="${y}" width="${n1(w)}" height="${bh}" rx="14" fill="${root ? c : tint(c, 0.15)}" stroke="${c}" stroke-width="${root ? 0 : 2}"/>${lines(x, y + bh / 2, t, { c: root ? onColour(c) : fg, s: root ? 16 : 14.5, bold: true, lh: 17 })}`;
          if (s.detail) body += lines(x, y + bh + 22, wrap(s.detail, lw - 10, 12, false, 2), { c: muted, s: 12, lh: 15 });
          body += '</g>';
        });
      } else {
        // left to right, one row per leaf
        const colW = Math.min(180, (W - 20) / (maxD + 1));
        const w = colW - 26;
        const gap = 44;
        let row = 0;
        const walk = (i: number): number => {
          const ks = kids(i);
          const x = 10 + depth(i) * colW + w / 2;
          if (!ks.length) {
            pos[i] = [x, 26 + gap * row + gap / 2];
            row++;
          } else {
            const ys = ks.map(walk);
            pos[i] = [x, (ys[0] + ys[ys.length - 1]) / 2];
          }
          return pos[i][1];
        };
        roots.forEach(walk);
        h = 26 + gap * row + 26;
        const bh2 = 34;
        items.forEach((_, i) => {
          if (parent[i] < 0) return;
          const [px, py] = pos[parent[i]];
          const [x, y] = pos[i];
          const sx = px + w / 2;
          const ex = x - w / 2;
          body += `<path d="M${n1(sx)},${n1(py)} C${n1((sx + ex) / 2)},${n1(py)} ${n1((sx + ex) / 2)},${n1(y)} ${n1(ex)},${n1(y)}" fill="none" stroke="${colourOf(i)}" stroke-width="2" stroke-opacity="0.8"/>`;
        });
        items.forEach((s, i) => {
          const [x, y] = pos[i];
          const c = colourOf(i);
          const root = depth(i) === 0;
          body += `<g${anim}><rect x="${n1(x - w / 2)}" y="${n1(y - bh2 / 2)}" width="${n1(w)}" height="${bh2}" rx="10" fill="${root ? c : tint(c, 0.15)}" stroke="${c}" stroke-width="${root ? 0 : 1.5}"/>${T(x, y + 4.5, clip(s.text, w - 12, 13, true), { c: root ? onColour(c) : fg, s: 13, bold: true })}</g>`;
        });
      }
      break;
    }
    case 'compare': {
      const heads = d.heads.length ? d.heads.slice(0, 4) : ['A', 'B'];
      const k = heads.length;
      const labW = Math.min(180, Math.max(110, ...items.map((r) => measure(r.text, 14, true) + 28)));
      const colW = (W - 10 - labW - 10 * k) / k;
      const x0 = 10 + labW;
      body += heads.map((t, j) => `<rect x="${n1(x0 + j * (colW + 10))}" y="20" width="${n1(colW)}" height="44" rx="12" fill="${col(j === 0 ? 2 : j === 1 ? 1 : j + 2)}"/>` + T(x0 + j * (colW + 10) + colW / 2, 47, clip(t, colW - 16, 15, true), { c: onColour(col(j === 0 ? 2 : j === 1 ? 1 : j + 2)), s: 15, bold: true })).join('');
      let y = 78;
      items.forEach((r, i) => {
        const cells = heads.map((_, j) => wrap(r.cells[j] ?? '', colW - 16, 14, false, 3));
        const lab = wrap(r.text, labW - 24, 14, true, 3);
        const rows = Math.max(1, lab.length, ...cells.map((c) => c.length));
        const rh = 30 + rows * 18;
        body += `<g${anim}><rect x="10" y="${y}" width="${W - 20}" height="${rh - 8}" rx="10" fill="${i % 2 ? ink.surface : ink.surface2}"/>`;
        body += lab.map((l, q) => T(22, y + (rh - 8) / 2 + 5 - ((lab.length - 1) * 18) / 2 + q * 18, l, { a: 'start', c: fg, s: 14, bold: true })).join('');
        cells.forEach((c, j) => (body += lines(x0 + j * (colW + 10) + colW / 2, y + (rh - 8) / 2, c, { c: fg, s: 14, lh: 18 })));
        body += '</g>';
        y += rh;
      });
      h = y + 6;
      break;
    }
    case 'matrix': {
      const q = items.slice(0, 4);
      const gw = (W - 30) / 2;
      const det = q.map((s) => s.detail.split('\n').flatMap((l) => (l.trim() ? wrap(`• ${l.trim()}`, gw - 32, 13) : [])).slice(0, 6));
      const gh = Math.max(120, 56 + Math.max(...det.map((x) => x.length)) * 18 + 12);
      h = 10 + gh * 2 + 10 + 10;
      q.forEach((s, i) => {
        const x = 10 + (i % 2) * (gw + 10);
        const y = 10 + Math.floor(i / 2) * (gh + 10);
        const c = ic(i, [0, 3, 2, 1][i]);
        body += `<g${anim}><rect x="${n1(x)}" y="${n1(y)}" width="${n1(gw)}" height="${gh}" rx="14" fill="${tint(c, 0.1)}" stroke="${c}" stroke-width="1.5"/><path d="M${n1(x)},${n1(y + 40)} V${n1(y + 14)} Q${n1(x)},${n1(y)} ${n1(x + 14)},${n1(y)} H${n1(x + gw - 14)} Q${n1(x + gw)},${n1(y)} ${n1(x + gw)},${n1(y + 14)} V${n1(y + 40)} Z" fill="${c}"/>${T(x + 16, y + 26, clip(s.text, gw - 32, 15, true), { a: 'start', c: onColour(c), s: 15, bold: true })}`;
        det[i].forEach((l, k) => (body += T(x + 16, y + 64 + k * 18, l, { a: 'start', c: fg, s: 13 })));
        body += '</g>';
      });
      break;
    }
  }
  return { svg: svgDoc(W, h, body, `${diagramKindName(d.kind)}: ${esc(d.title || 'untitled')}`), w: W, h };
}
