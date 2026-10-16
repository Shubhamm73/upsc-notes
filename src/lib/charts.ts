/**
 * Data charts (0.13): twelve kinds drawn as one SVG string, the same on screen and in the PDF.
 * The look follows the plan's mock-ups: rounded bars, a light dashed grid, values printed on the bars
 * (or shown on tap), soft area fills, chip legends. Pure: give it the data and an Ink, get SVG back.
 */
import { bar, clip, esc, fmt, measure, n1, niceScale, paletteColours, readPalette, smooth, svgDoc, T, type Ink, type PaletteId } from './svg-ink';

export type ChartKind = 'column' | 'bar' | 'stacked' | 'line' | 'area' | 'combo' | 'pie' | 'donut' | 'radar' | 'polar' | 'scatter' | 'bubble';
export interface Series {
  name: string;
  values: number[];
}
export interface ChartData {
  kind: ChartKind;
  title: string;
  subtitle: string;
  source: string;
  labels: string[];
  series: Series[];
  palette: PaletteId;
  /** 'all': numbers printed on the chart; 'tap': numbers show when a part is tapped. */
  values: 'all' | 'tap';
  unit: string;
}

export const CHART_KINDS: { kind: ChartKind; name: string; hint: string }[] = [
  { kind: 'column', name: 'Column', hint: 'Compare amounts; two or more series stand side by side' },
  { kind: 'bar', name: 'Bar', hint: 'Rank items with long names' },
  { kind: 'stacked', name: 'Stacked', hint: 'Parts of a whole, over time' },
  { kind: 'line', name: 'Line', hint: 'A trend over time' },
  { kind: 'area', name: 'Area', hint: 'A trend with a soft fill' },
  { kind: 'combo', name: 'Bar + line', hint: 'An amount and its rate together' },
  { kind: 'pie', name: 'Pie', hint: 'Shares of one whole' },
  { kind: 'donut', name: 'Donut', hint: 'Shares with the total in the middle' },
  { kind: 'radar', name: 'Radar', hint: 'Scores on several parts' },
  { kind: 'polar', name: 'Polar area', hint: 'Scores as petals' },
  { kind: 'scatter', name: 'Scatter', hint: 'Two measures: each dot is one item' },
  { kind: 'bubble', name: 'Bubble', hint: 'Two measures and a size' }
];
export const isChartKind = (v: unknown): v is ChartKind => CHART_KINDS.some((k) => k.kind === v);
export const chartKindName = (k: string) => CHART_KINDS.find((c) => c.kind === k)?.name ?? 'Chart';
/** Kinds whose rows are points with an x and y (and a size) instead of categories. */
export const isXY = (k: ChartKind) => k === 'scatter' || k === 'bubble';
/** Kinds that draw only the first series. */
export const oneSeries = (k: ChartKind) => k === 'pie' || k === 'donut' || k === 'polar';

const YRS = ['2021', '2022', '2023', '2024', '2025'];
const STATES = ['State A', 'State B', 'State C', 'State D', 'State E', 'State F', 'State G', 'State H', 'State I'];
const RUPEE = ['Interest', "States' share", 'Schemes', 'Defence', 'Subsidies', 'Other'];
const PARTS = ['Intro', 'Content', 'Examples', 'Data', 'Structure', 'Way forward'];
const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
const CPI = [5.5, 6.7, 5.4, 4.9, 4.1, 3.6, 4.4];
const LIT = [62, 74, 94, 70, 82, 66, 88, 77, 79];
const INC = [2.1, 2.8, 3.6, 1.6, 4.2, 1.8, 3.2, 2.4, 3.9];

type Sample = Omit<ChartData, 'kind' | 'palette' | 'values'>;
const s = (title: string, subtitle: string, labels: string[], series: Series[], unit = ''): Sample => ({ title, subtitle, source: '', labels, series, unit });
/** What a new chart of each kind starts with: the plan's example numbers, ready to overwrite. */
export const SAMPLES: Record<ChartKind, Sample> = {
  column: s('Renewable energy capacity', 'Gigawatts installed, by year · example numbers', YRS, [{ name: 'Capacity (GW)', values: [104, 119, 134, 158, 186] }]),
  bar: s('Forest cover: top 5 states', '% of geographical area · example numbers', ['Mizoram', 'Arunachal Pradesh', 'Meghalaya', 'Manipur', 'Nagaland'], [{ name: 'Forest cover', values: [85, 79, 76, 74, 73] }], '%'),
  stacked: s('Electricity mix', 'Share of generation, % · example numbers', YRS, [
    { name: 'Coal', values: [58, 56, 54, 51, 48] },
    { name: 'Renewables', values: [22, 25, 28, 32, 36] },
    { name: 'Hydro', values: [12, 11, 11, 10, 10] },
    { name: 'Other', values: [8, 8, 7, 7, 6] }
  ], '%'),
  line: s('Inflation, month by month', '% year on year · example numbers', MONTHS, [{ name: 'CPI inflation', values: CPI }], '%'),
  area: s('Inflation, month by month', '% year on year · example numbers', MONTHS, [{ name: 'CPI inflation', values: CPI }], '%'),
  combo: s('Capacity and its growth', 'Bars: GW · line: growth % · example numbers', YRS, [
    { name: 'Capacity (GW)', values: [104, 119, 134, 158, 186] },
    { name: 'Growth %', values: [10, 14, 13, 18, 18] }
  ]),
  pie: s('Where a rupee goes', 'Share of spending · example numbers', RUPEE, [{ name: 'Share', values: [20, 22, 16, 8, 6, 28] }], '%'),
  donut: s('Where a rupee goes', 'Share of spending · example numbers', RUPEE, [{ name: 'Share', values: [20, 22, 16, 8, 6, 28] }], '%'),
  radar: s('My answer, self-check', 'Score out of 5 on each part of a GS answer', PARTS, [{ name: 'Score', values: [4, 3.5, 2.5, 2, 4.5, 3] }]),
  polar: s('My answer, self-check', 'Same scores as petals', PARTS, [{ name: 'Score', values: [4, 3.5, 2.5, 2, 4.5, 3] }]),
  scatter: s('Literacy vs income', 'Each dot is a state · example numbers', STATES, [
    { name: 'Literacy rate (%)', values: LIT },
    { name: 'Income (₹ lakh)', values: INC }
  ]),
  bubble: s('Literacy, income and population', 'Bubble size = population · example numbers', STATES, [
    { name: 'Literacy rate (%)', values: LIT },
    { name: 'Income (₹ lakh)', values: INC },
    { name: 'Population (crore)', values: [3, 5, 2, 6, 4, 7, 3, 4, 2] }
  ])
};
export const defaultValues = (k: ChartKind): 'all' | 'tap' => (['column', 'bar', 'stacked', 'pie', 'donut'].includes(k) ? 'all' : 'tap');
export function sampleChart(kind: ChartKind): ChartData {
  return { kind, palette: 'desk', values: defaultValues(kind), ...structuredClone(SAMPLES[kind]) };
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** Reads stored attributes (a new `chart` node or a 0.12 `chartBlock`) into chart data that always draws. */
export function readChartData(a: Record<string, unknown>, legacy = false): ChartData {
  // A 0.12 "bar" chart had upright bars: that is a column chart now.
  const kind: ChartKind = legacy ? (a.kind === 'line' ? 'line' : a.kind === 'pie' ? 'pie' : 'column') : isChartKind(a.kind) ? a.kind : 'column';
  const labels = Array.isArray(a.labels) ? a.labels.map((l) => String(l ?? '')) : [];
  const series = Array.isArray(a.series)
    ? (a.series as unknown[]).filter((x) => x && typeof x === 'object').map((x, i) => {
        const o = x as Record<string, unknown>;
        return { name: typeof o.name === 'string' ? o.name : `Series ${i + 1}`, values: Array.isArray(o.values) ? o.values.map(num) : [] };
      })
    : [];
  if (!labels.length && !series.length) {
    const d = sampleChart(kind);
    return { ...d, title: typeof a.title === 'string' ? a.title : d.title };
  }
  if (!series.length) series.push({ name: 'Value', values: labels.map(() => 0) });
  if (isXY(kind)) while (series.length < (kind === 'bubble' ? 3 : 2)) series.push({ name: series.length === 1 ? 'Y' : 'Size', values: labels.map(() => 1) });
  for (const sr of series) while (sr.values.length < labels.length) sr.values.push(0);
  return {
    kind,
    title: typeof a.title === 'string' ? a.title : '',
    subtitle: typeof a.subtitle === 'string' ? a.subtitle : '',
    source: typeof a.source === 'string' ? a.source : '',
    labels,
    series,
    palette: readPalette(a.palette),
    values: a.values === 'all' || a.values === 'tap' ? a.values : legacy ? (kind === 'line' ? 'tap' : 'all') : defaultValues(kind),
    unit: typeof a.unit === 'string' ? a.unit : ''
  };
}

/** Every word of a chart, for search. */
export const chartWords = (d: ChartData) => ['chart', chartKindName(d.kind), d.title, d.subtitle, d.source, ...d.labels, ...d.series.map((x) => x.name)].filter(Boolean).join(' ');

export interface ChartOpts {
  /** Series switched off from the legend (screen only). */
  hidden?: Set<number>;
  /** Draw the series legend inside the picture (for the PDF). */
  legend?: boolean;
  /** Draw-in animation classes (screen only). */
  animate?: boolean;
  /** Six colours of the "Study desk" palette as the screen shows them. */
  desk?: string[];
}
export interface ChartOut {
  svg: string;
  w: number;
  h: number;
  /** One chip per series (or per slice for pie / donut / polar). */
  legend: { name: string; colour: string }[];
}

const W = 560;
const H = 320;
/** Draws a chart. Each part that holds a number carries data-tip (what a tap shows). */
export function renderChart(d: ChartData, ink: Ink, o: ChartOpts = {}): ChartOut {
  const cols = paletteColours(d.palette, ink, o.desk);
  const col = (i: number) => cols[((i % 6) + 6) % 6];
  const hidden = o.hidden ?? new Set<number>();
  const anim = o.animate ? ' class="ch-in"' : '';
  const showAll = d.values === 'all';
  const u = d.unit;
  const tip = (label: string, si: number, v: number) => esc(`${label}${d.series.length > 1 && !oneSeries(d.kind) ? ` · ${d.series[si]?.name ?? ''}` : ''}: ${fmt(v, u)}`);
  const legend: { name: string; colour: string }[] = oneSeries(d.kind) ? d.labels.map((l, i) => ({ name: l, colour: col(i) })) : isXY(d.kind) ? [] : d.series.map((x, i) => ({ name: x.name, colour: col(i) }));
  const vis = d.series.map((_, i) => !hidden.has(i));
  let body = '';
  let h = H;
  const fg = ink.fg;
  const muted = ink.muted;
  const n = d.labels.length;

  // the axis says "%" when the numbers are percentages; other units go in the title and the tap
  const au = u === '%' ? '%' : '';
  const grid = (lo: number, hi: number, step: number, L: number, R: number, Tp: number, B: number, side: 'left' | 'right' = 'left', c = muted) => {
    let out = '';
    const y = (v: number) => B - ((B - Tp) * (v - lo)) / (hi - lo || 1);
    for (let v = lo; v <= hi + step / 1000; v += step) {
      const yy = y(v);
      if (side === 'left') out += `<line x1="${n1(L)}" x2="${n1(R)}" y1="${n1(yy)}" y2="${n1(yy)}" stroke="${ink.line}" stroke-width="1"${Math.abs(v) > step / 1000 ? ' stroke-dasharray="3 4"' : ''}/>`;
      out += T(side === 'left' ? L - 8 : R + 8, yy + 4, fmt(Math.round(v * 1000) / 1000, au), { a: side === 'left' ? 'end' : 'start', s: 11, c });
    }
    return out;
  };
  const tickW = (lo: number, hi: number, step: number) => {
    let m = 0;
    for (let v = lo; v <= hi + step / 1000; v += step) m = Math.max(m, measure(fmt(Math.round(v * 1000) / 1000, au), 11));
    return m;
  };
  /** Category labels under a plot, thinned out when they would collide. */
  const catLabels = (xs: number[], bw: number, B: number) => {
    const need = Math.min(90, Math.max(0, ...d.labels.map((l) => measure(l, 12)))) + 8;
    const every = Math.max(1, Math.ceil(need / Math.max(bw, 1)));
    return d.labels.map((l, i) => (i % every ? '' : T(xs[i], B + 20, clip(l, bw * every - 6, 12), { c: muted }))).join('');
  };

  switch (d.kind) {
    case 'column':
    case 'stacked':
    case 'combo': {
      const bars = d.kind === 'combo' ? [0] : d.series.map((_, i) => i).filter((i) => vis[i]);
      const lineS = d.kind === 'combo' ? d.series.map((_, i) => i).filter((i) => i > 0 && vis[i]) : [];
      let lo = 0;
      let hi = 0;
      if (d.kind === 'stacked')
        for (let j = 0; j < n; j++) {
          let p = 0;
          let m = 0;
          for (const i of bars) (d.series[i].values[j] >= 0 ? (p += d.series[i].values[j]) : (m += d.series[i].values[j]));
          hi = Math.max(hi, p);
          lo = Math.min(lo, m);
        }
      else for (const i of bars) if (vis[i]) for (const v of d.series[i].values) (hi = Math.max(hi, v)), (lo = Math.min(lo, v));
      const sc = niceScale(lo, hi, 4);
      let R = W - 12;
      let sc2 = sc;
      if (lineS.length) {
        let a = 0;
        let b = 0;
        for (const i of lineS) for (const v of d.series[i].values) (a = Math.min(a, v)), (b = Math.max(b, v));
        sc2 = niceScale(a, b, 4);
        R = W - 18 - tickW(sc2.lo, sc2.hi, sc2.step);
      }
      const L = 18 + tickW(sc.lo, sc.hi, sc.step);
      const Tp = 24;
      const B = H - 34;
      const y = (v: number) => B - ((B - Tp) * (v - sc.lo)) / (sc.hi - sc.lo || 1);
      const y0 = y(0);
      const bw = (R - L) / Math.max(n, 1);
      body += grid(sc.lo, sc.hi, sc.step, L, R, Tp, B);
      if (lineS.length) body += grid(sc2.lo, sc2.hi, sc2.step, L, R, Tp, B, 'right', col(1));
      const xs = d.labels.map((_, j) => L + j * bw + bw / 2);
      const k = d.kind === 'column' ? Math.max(bars.length, 1) : 1;
      const gw = bw * (k > 1 ? 0.72 : 0.56);
      const sw = gw / k;
      const r = Math.min(8, sw / 3);
      for (let j = 0; j < n; j++) {
        if (d.kind === 'stacked') {
          let up = y0;
          let dn = y0;
          const X = xs[j] - gw / 2;
          const pos = bars.filter((i) => d.series[i].values[j] > 0);
          const neg = bars.filter((i) => d.series[i].values[j] < 0);
          for (const i of [...pos, ...neg]) {
            const v = d.series[i].values[j];
            const hh = Math.abs(y(v) - y0);
            const last = v > 0 ? i === pos[pos.length - 1] : i === neg[neg.length - 1];
            const top = v > 0 ? up - hh : dn;
            const piece = last ? `<path d="${bar(X, top, gw, hh, r, v > 0 ? 'top' : 'bottom')}" fill="${col(i)}"` : `<rect x="${n1(X)}" y="${n1(v > 0 ? top + 1.5 : top)}" width="${n1(gw)}" height="${n1(Math.max(hh - 1.5, 0))}" fill="${col(i)}"`;
            body += `${piece}${anim} data-tip="${tip(d.labels[j], i, v)}"/>`;
            if (showAll && hh >= 16 && gw >= 22) body += T(xs[j], top + hh / 2 + 4, fmt(v), { c: '#ffffff', s: 11.5, bold: true });
            if (v > 0) up -= hh;
            else dn += hh;
          }
        } else {
          bars.forEach((i, bi) => {
            const v = d.series[i].values[j];
            const X = xs[j] - gw / 2 + bi * sw + (k > 1 ? sw * 0.06 : 0);
            const ww = k > 1 ? sw * 0.88 : sw;
            const yy = y(v);
            const top = Math.min(yy, y0);
            const hh = Math.abs(yy - y0);
            body += `<path d="${bar(X, top, ww, hh, r, v >= 0 ? 'top' : 'bottom')}" fill="${col(i)}"${d.kind === 'combo' ? ' fill-opacity="0.85"' : ''}${anim} data-tip="${tip(d.labels[j], i, v)}"/>`;
            if (hh === 0) body += `<rect x="${n1(X)}" y="${n1(y0 - 1)}" width="${n1(ww)}" height="2" fill="${col(i)}" data-tip="${tip(d.labels[j], i, v)}"/>`;
            if (showAll && ww >= 18) body += T(X + ww / 2, v >= 0 ? top - 7 : top + hh + 15, fmt(v), { c: fg, s: k > 2 ? 11 : 13, bold: true });
          });
        }
      }
      for (const i of lineS) {
        const y2 = (v: number) => B - ((B - Tp) * (v - sc2.lo)) / (sc2.hi - sc2.lo || 1);
        const pts = d.series[i].values.slice(0, n).map((v, j) => [xs[j], y2(v)] as [number, number]);
        body += `<path d="${smooth(pts)}" fill="none" stroke="${col(i)}" stroke-width="3" stroke-linecap="round"${anim}/>`;
        pts.forEach((p, j) => {
          body += `<circle cx="${n1(p[0])}" cy="${n1(p[1])}" r="5" fill="${ink.surface}" stroke="${col(i)}" stroke-width="3" data-tip="${tip(d.labels[j], i, d.series[i].values[j])}"/>`;
          if (showAll) body += T(p[0], p[1] - 11, fmt(d.series[i].values[j]), { c: col(i), s: 11.5, bold: true });
        });
      }
      body += catLabels(xs, bw, B);
      break;
    }
    case 'bar': {
      const S = d.series.map((_, i) => i).filter((i) => vis[i]);
      let lo = 0;
      let hi = 0;
      for (const i of S) for (const v of d.series[i].values) (hi = Math.max(hi, v)), (lo = Math.min(lo, v));
      const sc = niceScale(lo, hi, 4);
      const nameW = Math.min(170, Math.max(40, ...d.labels.map((l) => measure(l, 13)))) + 12;
      const L = 8 + nameW;
      const R = W - 30;
      const rowH = Math.max(26, Math.min(50, 260 / Math.max(n, 1)) + (S.length > 1 ? 14 * (S.length - 1) : 0));
      const Tp = 10;
      h = Math.max(H - 60, Tp + rowH * n + 30);
      const x = (v: number) => L + ((R - L) * (v - sc.lo)) / (sc.hi - sc.lo || 1);
      const x0 = x(0);
      const k = Math.max(S.length, 1);
      const bh = Math.min(28, ((rowH - 12) / k) * (k > 1 ? 0.9 : 1));
      d.labels.forEach((l, j) => {
        const yy = Tp + j * rowH + (rowH - bh * k - (k - 1) * 3) / 2;
        body += T(L - 10, Tp + j * rowH + rowH / 2 + 4.5, clip(l, nameW - 10, 13), { a: 'end', c: fg, s: 13 });
        S.forEach((i, bi) => {
          const v = d.series[i].values[j];
          const by = yy + bi * (bh + 3);
          if (sc.lo >= 0) body += `<rect x="${n1(L)}" y="${n1(by)}" width="${n1(R - L)}" height="${n1(bh)}" rx="${n1(Math.min(8, bh / 2))}" fill="${ink.chip}"/>`;
          const a = Math.min(x(v), x0);
          const ww = Math.abs(x(v) - x0);
          body += `<path d="${bar(a, by, Math.max(ww, 2), bh, Math.min(8, bh / 2), v >= 0 ? 'right' : 'left')}" fill="${col(S.length > 1 ? i : 4)}"${anim} data-tip="${tip(l, i, v)}"/>`;
          if (showAll) {
            const t = fmt(v, u);
            const tw = measure(t, 12.5, true);
            const inside = ww > tw + 16;
            body += T(v >= 0 ? (inside ? a + ww - 10 : a + ww + 6) : inside ? a + 10 : a - 6, by + bh / 2 + 4.5, t, { a: v >= 0 ? (inside ? 'end' : 'start') : inside ? 'start' : 'end', c: inside ? '#ffffff' : fg, s: 12.5, bold: true });
          }
        });
      });
      if (sc.lo < 0) body += `<line x1="${n1(x0)}" x2="${n1(x0)}" y1="${Tp}" y2="${n1(Tp + rowH * n)}" stroke="${ink.line}" stroke-width="1.5"/>`;
      break;
    }
    case 'line':
    case 'area': {
      const S = d.series.map((_, i) => i).filter((i) => vis[i]);
      let lo = Infinity;
      let hi = -Infinity;
      for (const i of S) for (const v of d.series[i].values.slice(0, n)) (hi = Math.max(hi, v)), (lo = Math.min(lo, v));
      if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
      const sc = niceScale(Math.min(0, lo), Math.max(hi, 0), 4);
      const L = 18 + tickW(sc.lo, sc.hi, sc.step);
      const R = W - 20;
      const Tp = 24;
      const B = H - 34;
      const y = (v: number) => B - ((B - Tp) * (v - sc.lo)) / (sc.hi - sc.lo || 1);
      body += grid(sc.lo, sc.hi, sc.step, L, R, Tp, B);
      const xs = d.labels.map((_, j) => L + 10 + (n > 1 ? (j * (R - L - 20)) / (n - 1) : (R - L - 20) / 2));
      for (const i of S) {
        const vals = d.series[i].values.slice(0, n);
        const pts = vals.map((v, j) => [xs[j], y(v)] as [number, number]);
        if (!pts.length) continue;
        const path = smooth(pts);
        if (d.kind === 'area') body += `<path d="${path} L${n1(pts[pts.length - 1][0])},${n1(y(Math.max(sc.lo, 0)))} L${n1(pts[0][0])},${n1(y(Math.max(sc.lo, 0)))} Z" fill="${col(i === 0 && S.length === 1 ? 2 : i)}" fill-opacity="${S.length > 1 ? 0.12 : 0.16}"${anim}/>`;
        const c = col(i === 0 && S.length === 1 ? 2 : i);
        body += `<path d="${path}" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"${anim}/>`;
        pts.forEach((p, j) => {
          const last = j === pts.length - 1;
          body += `<circle cx="${n1(p[0])}" cy="${n1(p[1])}" r="${last ? 7 : 4.5}" fill="${last ? ink.surface : c}" stroke="${c}" stroke-width="${last ? 3 : 0}" data-tip="${tip(d.labels[j], i, vals[j])}"/>`;
          if (last || showAll) body += T(p[0], p[1] - (last ? 14 : 10), fmt(vals[j], last ? u : ''), { c: last ? fg : c, s: last ? 13 : 11.5, bold: true });
        });
      }
      body += catLabels(xs, (R - L - 20) / Math.max(n - 1, 1), B);
      break;
    }
    case 'pie':
    case 'donut': {
      const vals = (d.series[0]?.values ?? []).slice(0, n).map((v) => Math.max(0, v));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      const cx = 170;
      const cy = 160;
      const r = 132;
      const ri = d.kind === 'donut' ? 82 : 0;
      let a0 = -Math.PI / 2;
      const p = (a: number, rr: number) => `${n1(cx + rr * Math.cos(a))},${n1(cy + rr * Math.sin(a))}`;
      const rowH = Math.min(38, 272 / Math.max(n, 1));
      const ly = cy - (rowH * n) / 2;
      d.labels.forEach((l, j) => {
        const v = vals[j];
        const frac = v / total;
        const a1 = a0 + frac * Math.PI * 2;
        const la = a1 - a0 > Math.PI ? 1 : 0;
        if (frac >= 0.9999) body += ri ? `<path d="M${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} Z M${cx - ri},${cy} A${ri},${ri} 0 1 0 ${cx + ri},${cy} A${ri},${ri} 0 1 0 ${cx - ri},${cy} Z" fill="${col(j)}" fill-rule="evenodd"${anim} data-tip="${tip(l, 0, d.series[0].values[j])}"/>` : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col(j)}"${anim} data-tip="${tip(l, 0, d.series[0].values[j])}"/>`;
        else if (frac > 0)
          body += `<path d="${ri ? `M${p(a0, r)} A${r},${r} 0 ${la} 1 ${p(a1, r)} L${p(a1, ri)} A${ri},${ri} 0 ${la} 0 ${p(a0, ri)} Z` : `M${cx},${cy} L${p(a0, r)} A${r},${r} 0 ${la} 1 ${p(a1, r)} Z`}" fill="${col(j)}" stroke="${ink.surface}" stroke-width="3" stroke-linejoin="round"${anim} data-tip="${tip(l, 0, d.series[0].values[j])}"/>`;
        if (showAll && frac >= 0.06) {
          const am = (a0 + a1) / 2;
          const rr = ri ? (r + ri) / 2 : r * 0.64;
          body += T(cx + rr * Math.cos(am), cy + rr * Math.sin(am) + 4.5, `${Math.round(frac * 100)}%`, { c: '#ffffff', s: 12.5, bold: true });
        }
        const yy = ly + j * rowH + rowH / 2;
        body += `<rect x="350" y="${n1(yy - 7)}" width="14" height="14" rx="4" fill="${col(j)}"/>` + T(374, yy + 5, clip(l, 120, Math.min(14, rowH * 0.5)), { a: 'start', c: fg, s: Math.min(14, rowH * 0.5) }) + T(W - 16, yy + 5, fmt(d.series[0].values[j], u), { a: 'end', c: fg, s: Math.min(14, rowH * 0.5), bold: true });
        a0 = a1;
      });
      if (ri) body += T(cx, cy + 4, fmt(Math.round(total * 100) / 100, u), { c: fg, s: 26, bold: true }) + T(cx, cy + 26, clip(d.series[0]?.name || 'Total', ri * 1.6, 12), { c: muted, s: 12 });
      break;
    }
    case 'radar':
    case 'polar': {
      const S = d.kind === 'polar' ? [0] : d.series.map((_, i) => i).filter((i) => vis[i]);
      let hi = 0;
      for (const i of S) for (const v of d.series[i]?.values.slice(0, n) ?? []) hi = Math.max(hi, v);
      const sc = niceScale(0, hi || 1, 5);
      const cx = W / 2;
      const cy = 160;
      const r = 118;
      const m = Math.max(n, 3);
      const ang = (j: number) => -Math.PI / 2 + (j * 2 * Math.PI) / m;
      const p = (j: number, rr: number): [number, number] => [cx + rr * Math.cos(ang(j)), cy + rr * Math.sin(ang(j))];
      const rv = (v: number) => (r * Math.max(0, v)) / (sc.hi || 1);
      const rings = Math.round(sc.hi / sc.step);
      for (let k2 = 1; k2 <= rings; k2++) {
        const rr = (r * k2) / rings;
        body += d.kind === 'polar' ? `<circle cx="${cx}" cy="${cy}" r="${n1(rr)}" fill="none" stroke="${ink.line}"/>` : `<polygon points="${Array.from({ length: m }, (_, j) => p(j, rr).map(n1).join(',')).join(' ')}" fill="none" stroke="${ink.line}"/>`;
      }
      if (d.kind === 'radar') {
        for (let j = 0; j < m; j++) body += `<line x1="${cx}" y1="${cy}" x2="${n1(p(j, r)[0])}" y2="${n1(p(j, r)[1])}" stroke="${ink.line}"/>`;
        for (const i of S) {
          const c = S.length === 1 && i === 0 ? col(5) : col(i);
          const vals = d.series[i].values.slice(0, n);
          body += `<polygon points="${vals.map((v, j) => p(j, rv(v)).map(n1).join(',')).join(' ')}" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="3" stroke-linejoin="round"${anim}/>`;
          vals.forEach((v, j) => {
            const [a, b] = p(j, rv(v));
            body += `<circle cx="${n1(a)}" cy="${n1(b)}" r="5" fill="${c}" data-tip="${tip(d.labels[j], i, v)}"/>`;
            if (showAll) body += T(a, b - 9, fmt(v), { c: fg, s: 11, bold: true });
          });
        }
      } else {
        const vals = d.series[0]?.values.slice(0, n) ?? [];
        vals.forEach((v, j) => {
          const a0 = ang(j) + 0.03;
          const a1 = ang(j) + (2 * Math.PI) / m - 0.03;
          const rr = rv(v);
          if (rr > 0) body += `<path d="M${cx},${cy} L${n1(cx + rr * Math.cos(a0))},${n1(cy + rr * Math.sin(a0))} A${n1(rr)},${n1(rr)} 0 0 1 ${n1(cx + rr * Math.cos(a1))},${n1(cy + rr * Math.sin(a1))} Z" fill="${col(j)}" fill-opacity="0.82"${anim} data-tip="${tip(d.labels[j], 0, v)}"/>`;
        });
      }
      // polar labels sit at the middle of each petal; radar labels at the spokes
      d.labels.forEach((l, j) => {
        const a = d.kind === 'polar' ? ang(j) + Math.PI / m : ang(j);
        const x = cx + (r + 24) * Math.cos(a);
        const yy = cy + (r + 20) * Math.sin(a);
        const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
        body += T(anchor === 'start' ? x - 12 : anchor === 'end' ? x + 12 : x, yy + 4, clip(l, 120, 13), { a: anchor, c: fg, s: 13 });
      });
      break;
    }
    case 'scatter':
    case 'bubble': {
      const X = d.series[0]?.values ?? [];
      const Y = d.series[1]?.values ?? [];
      const Z = d.series[2]?.values ?? [];
      const xs = niceScale(Math.min(...X.slice(0, n), Infinity), Math.max(...X.slice(0, n), -Infinity), 5);
      const ys = niceScale(Math.min(0, ...Y.slice(0, n)), Math.max(...Y.slice(0, n), 0), 5);
      const L = 22 + tickW(ys.lo, ys.hi, ys.step);
      const R = W - 22;
      const Tp = 26;
      const B = H - 44;
      body += grid(ys.lo, ys.hi, ys.step, L, R, Tp, B);
      const px = (v: number) => L + ((R - L) * (v - xs.lo)) / (xs.hi - xs.lo || 1);
      const py = (v: number) => B - ((B - Tp) * (v - ys.lo)) / (ys.hi - ys.lo || 1);
      for (let v = xs.lo; v <= xs.hi + xs.step / 1000; v += xs.step) body += T(px(v), B + 18, fmt(Math.round(v * 1000) / 1000), { s: 11, c: muted });
      const zmax = Math.max(...Z.slice(0, n).map((z) => Math.abs(z)), 1);
      const order = d.labels.map((_, j) => j).sort((a, b) => Math.abs(Z[b] ?? 0) - Math.abs(Z[a] ?? 0));
      for (const j of d.kind === 'bubble' ? order : order.sort((a, b) => a - b)) {
        const c = d.kind === 'bubble' ? col(j) : col(2);
        const rr = d.kind === 'bubble' ? 6 + 24 * Math.sqrt(Math.abs(Z[j] ?? 0) / zmax) : 7;
        const t = esc(`${d.labels[j]}: ${d.series[0]?.name ?? 'x'} ${fmt(X[j])}, ${d.series[1]?.name ?? 'y'} ${fmt(Y[j])}${d.kind === 'bubble' ? `, ${d.series[2]?.name ?? 'size'} ${fmt(Z[j] ?? 0)}` : ''}`);
        body += `<circle cx="${n1(px(X[j]))}" cy="${n1(py(Y[j]))}" r="${n1(rr)}" fill="${c}" fill-opacity="${d.kind === 'bubble' ? 0.55 : 0.85}" stroke="${c}" stroke-width="1.5"${anim} data-tip="${t}"/>`;
        if (showAll) body += T(px(X[j]) + rr + 4, py(Y[j]) + 4, clip(d.labels[j], 90, 11), { a: 'start', c: fg, s: 11 });
      }
      body += T((L + R) / 2, B + 36, `${clip(d.series[0]?.name || 'x', 300, 12)} →`, { s: 12, c: muted }) + T(8, Tp - 12, `${clip(d.series[1]?.name || 'y', 260, 11.5)} ↑`, { a: 'start', s: 11.5, c: muted });
      break;
    }
  }
  if (!n) body = T(W / 2, H / 2, 'Add a row of numbers to draw this chart', { c: muted, s: 14 });

  // legend inside the picture (PDF): chips in rows under the chart
  if (o.legend && legend.length > 1 && !(d.kind === 'pie' || d.kind === 'donut')) {
    let x = 12;
    let yy = h + 8;
    let out = '';
    for (const it of legend) {
      const t = clip(it.name, 200, 12.5);
      const w = measure(t, 12.5) + 34;
      if (x + w > W - 8) (x = 12), (yy += 30);
      out += `<rect x="${n1(x)}" y="${n1(yy)}" width="${n1(w)}" height="24" rx="12" fill="${ink.chip}"/><rect x="${n1(x + 10)}" y="${n1(yy + 7.5)}" width="9" height="9" rx="3" fill="${it.colour}"/>` + T(x + 25, yy + 16.5, t, { a: 'start', c: fg, s: 12.5 });
      x += w + 8;
    }
    body += out;
    h = yy + 32;
  }
  return { svg: svgDoc(W, h, body, `${chartKindName(d.kind)} chart: ${d.title || 'untitled'}`), w: W, h, legend };
}
