import { db, type DocNode, type Note, type Vocab } from '../db';
import { FolderIndex } from '../lib/folders';
import { chartKindName, readChartData, renderChart } from '../lib/charts';
import { diagramKindName, readDiagram, renderDiagram } from '../lib/diagrams';
import { readMindMap, renderMindMap } from '../lib/mindmap';
import { PRINT_INK } from '../lib/svg-ink';
import { collectImageIds } from '../editor/images';
import { ymd } from '../lib/dates';
import { groupInsights } from '../lib/insights';
import { calloutKind, calloutLabel } from '../lib/callouts';
import { docToText } from '../lib/doc';
import { isPlain, normRotate, readCrop, shapeOf, tracePath } from '../lib/shapes';
import { readHeight, readStrokes, sketchToPng } from '../lib/sketch';
import { figureColumns, printColour, panelTitle, readFill, readHeadingLook, readPanelLook, tableStyle, type Fill, type HeadingLook } from '../lib/looks';
import { PATHS } from '../lib/icons';
import { loadLooks, resolveLook, SET_LOOKS, type HeadingSet, type NoteLook } from '../lib/note-look';

/** A4 in points, with 48 pt margins. */
const PAGE_W = 595.28;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK = '#1c1f24';
const MUTED = '#5b616b';
const LINE = '#d8d2c4';
const ACCENT = '#2d5b4e';
const HEAD_FILL = '#ebe6d9';
const MARK = '#fde68a';

type Content = Record<string, unknown> | string | Content[];

export type PdfScope =
  | { kind: 'section'; note: Note; sectionId: string }
  | { kind: 'note'; note: Note }
  /** subject: a main subject's folder id, or 'All'. */
  | { kind: 'all'; subject: string | 'All'; includeVocab: boolean };

// ---------------- assets ----------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

type Pic = { url: string; w: number; h: number };

/** Which prepared picture an image block prints: the stored one, or its cropped / shaped version. */
function picKey(attrs: Record<string, unknown> | undefined): string {
  const a = attrs ?? {};
  const id = String(a.imageId);
  if (isPlain(a) && shapeOf(a.shape).id === 'rect') return id;
  return [id, JSON.stringify(readCrop(a.crop)), shapeOf(a.shape).id, normRotate(a.rotate), a.flip ? 1 : 0].join('|');
}

async function loadImages(docs: DocNode[]): Promise<Map<string, Pic>> {
  const ids = new Set<string>();
  docs.forEach((d) => collectImageIds(d, ids));
  const out = new Map<string, Pic>();
  for (const id of ids) {
    const rec = await db.images.get(id);
    if (rec) out.set(id, { url: await blobToDataUrl(rec.blob), w: rec.width, h: rec.height });
  }
  // Cropped, turned, mirrored or shaped pictures are drawn once, as they look on screen.
  const shaped: Record<string, unknown>[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'imageBlock' && n.attrs && picKey(n.attrs) !== String(n.attrs.imageId)) shaped.push(n.attrs);
    (n.content ?? []).forEach(walk);
  };
  docs.forEach(walk);
  for (const a of shaped) {
    const key = picKey(a);
    const src = out.get(String(a.imageId));
    if (!src || out.has(key)) continue;
    try {
      out.set(key, await shapePicture(src, a));
    } catch {
      out.set(key, src); // printing the plain picture beats printing nothing
    }
  }
  return out;
}

/** Draws a picture with its crop, turn, mirror and shape (transparent outside the shape). */
async function shapePicture(src: Pic, a: Record<string, unknown>): Promise<Pic> {
  const img = new Image();
  img.src = src.url;
  await img.decode();
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const rot = normRotate(a.rotate);
  const tw = rot % 180 ? H : W;
  const th = rot % 180 ? W : H;
  const c = readCrop(a.crop) ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = c.w * tw;
  const ch = c.h * th;
  const k = Math.min(1, 1600 / Math.max(cw, ch));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cw * k));
  canvas.height = Math.max(1, Math.round(ch * k));
  const g = canvas.getContext('2d')!;
  const shape = shapeOf(a.shape).id;
  if (shape !== 'rect') {
    g.beginPath();
    tracePath(g, shape, 0, 0, canvas.width, canvas.height);
    g.clip();
  } else {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  g.scale(k, k);
  g.translate(-c.x * tw, -c.y * th);
  g.translate(tw / 2, th / 2);
  if (a.flip) g.scale(-1, 1);
  g.rotate((rot * Math.PI) / 180);
  g.drawImage(img, -W / 2, -H / 2, W, H);
  const url = shape === 'rect' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
  return { url, w: canvas.width, h: canvas.height };
}

/**
 * A chart, diagram or mind map (0.13) as vector SVG in print colours: crisp at any zoom.
 * pdfmake reads the SVG's own attributes (no CSS); text falls back to Roboto.
 */
interface Figure {
  title: string;
  sub: string;
  source: string;
  svg: string;
  w: number;
  h: number;
}
function figureOf(n: DocNode, ctx: Ctx): Figure | null {
  const a = (n.attrs ?? {}) as Record<string, unknown>;
  const ink = { ...PRINT_INK, subj: ctx.subj };
  if (n.type === 'chart' || n.type === 'chartBlock') {
    const d = readChartData(a, n.type === 'chartBlock');
    const out = renderChart(d, ink, { legend: true });
    return { title: d.title || chartKindName(d.kind), sub: d.subtitle, source: d.source, svg: out.svg, w: out.w, h: out.h };
  }
  if (n.type === 'diagram') {
    const d = readDiagram(a);
    const out = renderDiagram(d, ink);
    return { title: d.title || diagramKindName(d.kind), sub: '', source: '', svg: out.svg, w: out.w, h: out.h };
  }
  if (n.type === 'mindMap') {
    const m = readMindMap(a);
    // folded branches print unfolded: the page can't be tapped open
    const out = renderMindMap(m, ink, { unfold: true });
    return { title: m.nodes[0]?.text.trim() || 'Mind map', sub: `Mind map · ${m.nodes.length} ideas`, source: '', svg: out.svg, w: out.w, h: out.h };
  }
  return null;
}
/** A4 landscape inside the margins: a big mind map gets a page of its own. */
const LAND_W = 841.89 - MARGIN * 2;
// page height less the top/bottom page margins (56 + 52) and room for the title and subtitle above the map
const LAND_H = PAGE_W - 56 - 52 - 48;

function figureHead(f: Figure, alignment: string): Content[] {
  const out: Content[] = [{ text: f.title, bold: true, margin: [0, 0, 0, f.sub ? 1 : 4], alignment }];
  if (f.sub) out.push({ text: f.sub, color: MUTED, fontSize: 9, margin: [0, 0, 0, 4], alignment });
  return out;
}
const figureFoot = (f: Figure, alignment: string): Content[] => (f.source ? [{ text: /^source\b/i.test(f.source) ? f.source : `Source: ${f.source}`, color: MUTED, fontSize: 8.5, italics: true, margin: [0, 3, 0, 0], alignment }] : []);

function figureBlock(n: DocNode, ctx: Ctx): Content {
  const f = figureOf(n, ctx)!;
  const side = n.attrs?.align === 'left' || n.attrs?.align === 'right' ? String(n.attrs.align) : null;
  const pct = Math.min(100, Math.max(20, Number(n.attrs?.width ?? 50)));
  const alignment = side ?? 'left';
  const big = n.type === 'mindMap' && ((n.attrs?.nodes as unknown[] | undefined)?.length ?? 0) > 30;
  const tooWide = n.type === 'mindMap' && (ctx.width * f.h) / f.w < 160 && f.w > ctx.width * 1.4;
  if ((big || tooWide) && ctx.width >= CONTENT_W - 1) {
    // its own landscape page, then back to portrait for what follows
    const w = Math.min(LAND_W, (LAND_H * f.w) / f.h);
    return {
      stack: [
        { stack: [...figureHead(f, 'left'), { svg: f.svg, width: w, height: (w * f.h) / f.w, alignment: 'center' }], pageBreak: 'before', pageOrientation: 'landscape' },
        { text: '', pageBreak: 'before', pageOrientation: 'portrait' }
      ]
    } as Content;
  }
  let w = side ? (ctx.width * pct) / 100 : Math.min(ctx.width, n.type === 'mindMap' ? f.w * 0.8 : f.w * 0.9, CONTENT_W);
  // 0.16: a centred figure made narrower on screen prints at that share of the column
  const own = Number(n.attrs?.width);
  if (!side && own > 0 && own < 100) w = Math.min(w, (ctx.width * own) / 100);
  // keep within one page
  if ((w * f.h) / f.w > 600) w = (600 * f.w) / f.h;
  return { stack: [...figureHead(f, alignment), { svg: f.svg, width: w, height: (w * f.h) / f.w, alignment }, ...figureFoot(f, alignment)], unbreakable: true, margin: [0, 4, 0, 10] };
}

// ---------------- editor JSON -> pdfmake ----------------

function inlines(nodes: DocNode[] | undefined): Content[] {
  const out: Content[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out.push('\n');
      continue;
    }
    if (n.type !== 'text') continue;
    const t: Record<string, unknown> = { text: n.text ?? '' };
    const deco: string[] = [];
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') t.bold = true;
      if (m.type === 'italic') t.italics = true;
      if (m.type === 'underline') deco.push('underline');
      if (m.type === 'strike') deco.push('lineThrough');
      if (m.type === 'highlight') t.background = MARK;
      if (m.type === 'link' && typeof m.attrs?.href === 'string') {
        t.link = m.attrs.href;
        t.color = ACCENT;
        deco.push('underline');
      }
    }
    if (deco.length) t.decoration = deco.length === 1 ? deco[0] : deco;
    out.push(t);
  }
  return out;
}

interface Ctx {
  images: Map<string, Pic>;
  /** Sketches drawn so far (each once, from its strokes, in print colours). */
  sketches: Map<DocNode, Pic>;
  width: number; // available width at this nesting level
  /** The note's subject colour in print (looks that follow the subject), its main subject's name (Split headings). */
  subj: string;
  subjName: string;
  /** Numbered headings, counted across the note. */
  hnum: { n: number };
  /** The note's heading style set (0.14 Note look): what plain headings and section titles look like. */
  hset?: HeadingSet;
}

const NOTE_CTX = { subj: ACCENT, subjName: 'Notes', hnum: { n: 0 } };
const ON_COLOUR = '#ffffff';
const STICKY = '#fff0a6';

/** A colour mixed with white: pct of the colour (the screen's color-mix over the page). */
function tint(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(255 + (c - 255) * (pct / 100));
  return `#${[(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
}

/** A heading or container icon, drawn (the PDF font has no star or flag). */
function iconSvg(id: string | null | undefined, colour: string, size: number): Content | null {
  const path = id ? PATHS[id] : undefined;
  if (!path) return null;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`, width: size, height: size };
}

/** One box round some content: fill, a border per side ([left, top, right, bottom] widths), padding. */
function box(content: Content, o: { fill?: string; border?: number[]; borderColor?: string | string[]; pad?: number[]; width?: 'auto' | '*' | number; align?: string; margin?: number[] }): Content {
  const b = o.border ?? [0, 0, 0, 0];
  const bc = Array.isArray(o.borderColor) ? o.borderColor : Array(4).fill(o.borderColor ?? LINE);
  const pad = o.pad ?? [0, 0, 0, 0];
  const t: Content = {
    table: { widths: [o.width ?? '*'], body: [[{ stack: Array.isArray(content) ? content : [content], fillColor: o.fill }]] },
    layout: {
      hLineWidth: (i: number) => (i === 0 ? b[1] : b[3]),
      vLineWidth: (i: number) => (i === 0 ? b[0] : b[2]),
      hLineColor: (i: number) => (i === 0 ? bc[1] : bc[3]),
      vLineColor: (i: number) => (i === 0 ? bc[0] : bc[2]),
      paddingLeft: () => pad[0],
      paddingTop: () => pad[1],
      paddingRight: () => pad[2],
      paddingBottom: () => pad[3]
    }
  };
  return o.width === 'auto' ? place(t, o.align ?? 'left', o.margin ?? [0, 0, 0, 0]) : { ...t, margin: o.margin ?? [0, 0, 0, 0] };
}

/** A fit-width piece left or centred on its line. */
function place(c: Content, align: string, margin: number[]): Content {
  if (align !== 'center') return { columns: [{ width: 'auto', stack: [c] }, { width: '*', text: '' }], columnGap: 0, margin };
  return { columns: [{ width: '*', text: '' }, { width: 'auto', stack: [c] }, { width: '*', text: '' }], columnGap: 0, margin };
}


/** What a picture block prints: a stored picture (cropped / shaped), or a sketch drawn from its strokes. */
function pictureOf(n: DocNode, ctx: Ctx): Pic | undefined {
  if (n.type === 'imageBlock') return ctx.images.get(picKey(n.attrs));
  if (n.type !== 'sketchBlock') return undefined;
  let pic = ctx.sketches.get(n);
  if (!pic) {
    pic = sketchToPng(readStrokes(n.attrs?.strokes), readHeight(n.attrs?.height));
    ctx.sketches.set(n, pic);
  }
  return pic;
}

/** Rough printed height of a text block at a given width (10.5 pt Roboto, ~5.3 pt a character). */
function textHeight(n: DocNode, width: number): number {
  const lines = (t: string) => Math.max(1, Math.ceil((t.length * 5.3) / Math.max(40, width)));
  if (n.type === 'bulletList' || n.type === 'orderedList') {
    return (n.content ?? []).reduce((h, li) => h + lines(docToText(li)) * 13.5 + 2, 6);
  }
  if (n.type === 'table') return (n.content ?? []).length * 22 + 10;
  if (n.type === 'callout' || n.type === 'blockquote') return lines(docToText(n)) * 13.5 + 26;
  if (n.type === 'panel') return lines(docToText(n)) * 13.5 + (n.attrs?.kind === 'titled' ? 52 : 32);
  return lines(docToText(n)) * 13.5 + (n.type === 'heading' ? 10 : 6);
}

/** Blocks that can print beside a floated picture, as on screen (headings, callouts, quotes and tables since 0.11). */
const WRAPS = ['paragraph', 'bulletList', 'orderedList', 'heading', 'blockquote', 'callout', 'table', 'panel'];
/** …unless set to start below it: `clear: true`, or a heading not set to sit beside it (`clear: false`). */
const wraps = (n: DocNode | undefined) =>
  !!n && WRAPS.includes(n.type) && n.attrs?.clear !== true && !(n.type === 'heading' && n.attrs?.clear !== false);

/** A picture's caption, under it. */
function captionOf(n: DocNode, alignment: string): Content[] {
  const t = typeof n.attrs?.caption === 'string' ? n.attrs.caption.trim() : '';
  return t ? [{ text: t, italics: true, color: MUTED, fontSize: 9, alignment, margin: [0, 3, 0, 0] }] : [];
}

function blocks(nodes: DocNode[] | undefined, ctx: Ctx): Content[] {
  const list = nodes ?? [];
  const out: Content[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    const align = n.attrs?.align;
    const floated = (align === 'left' || align === 'right') && wraps(list[i + 1]);
    const fig = floated && ['chartBlock', 'chart', 'diagram', 'mindMap'].includes(n.type) ? figureOf(n, ctx) : null;
    const img: Pic | undefined = fig ? { url: '', w: fig.w, h: fig.h } : floated ? pictureOf(n, ctx) : undefined;
    // A left/right picture, sketch or chart with text after it prints side by side with that text, as on
    // screen: the text blocks that fit next to the picture's height go in the column beside it.
    if (img && floated) {
      const pct = Math.min(100, Math.max(10, Number(n.attrs?.width ?? 50)));
      const w = Math.min((ctx.width * pct) / 100, ctx.width - 120);
      const imgH = Math.min((w * img.h) / img.w, 640);
      const textW = ctx.width - w - 14;
      const beside: DocNode[] = [];
      let used = 0;
      while (wraps(list[i + 1]) && (beside.length === 0 || used < imgH)) {
        used += textHeight(list[i + 1], textW);
        beside.push(list[++i]);
      }
      const picture = fig ? { stack: [...figureHead(fig, 'left'), { svg: fig.svg, width: w, height: imgH }, ...figureFoot(fig, 'left')] } : { stack: [{ image: img.url, width: w, height: imgH }, ...captionOf(n, 'left')] };
      const text = { width: '*', stack: blocks(beside, { ...ctx, width: textW }) };
      out.push({ columns: align === 'left' ? [{ width: w, stack: [picture] }, text] : [text, { width: w, stack: [picture] }], columnGap: 14, margin: [0, 4, 0, 10] });
      continue;
    }
    const c = block(n, ctx);
    if (c !== null) out.push(c);
  }
  return out;
}

function block(n: DocNode, ctx: Ctx): Content | null {
  switch (n.type) {
    case 'paragraph':
      return { text: n.content?.length ? inlines(n.content) : ' ', margin: [0, 0, 0, 6] };
    case 'heading': {
      const level = Number(n.attrs?.level ?? 2);
      const look = readHeadingLook(n.attrs?.look) ?? setLook(level, ctx);
      return look ? styledHeading(n, level, look, ctx) : { text: inlines(n.content), style: `h${level}` };
    }
    case 'panel':
      return panel(n, ctx);
    case 'blockquote':
      return {
        table: { widths: [3, '*'], body: [[{ text: '', fillColor: LINE }, { stack: blocks(n.content, ctx), color: MUTED, margin: [8, 0, 0, 0] }]] },
        layout: 'noBorders',
        margin: [0, 2, 0, 8]
      };
    case 'horizontalRule':
      return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: ctx.width, y2: 0, lineWidth: 0.75, lineColor: LINE }], margin: [0, 6, 0, 10] };
    case 'bulletList': {
      const dash = n.attrs?.listStyle === 'dash';
      const items = (n.content ?? []).map((li) => listItem(li, { ...ctx, width: ctx.width - 18 }, dash ? '–  ' : ''));
      return dash ? { ul: items, type: 'none', margin: [0, 0, 0, 6] } : { ul: items, margin: [0, 0, 0, 6] };
    }
    case 'orderedList':
      return {
        ol: (n.content ?? []).map((li) => listItem(li, { ...ctx, width: ctx.width - 22 }, '')),
        start: Number(n.attrs?.start ?? 1),
        margin: [0, 0, 0, 6]
      };
    case 'table':
      return table(n, ctx);
    case 'imageBlock':
    case 'sketchBlock': {
      const img = pictureOf(n, ctx);
      if (!img) return { text: '[image missing]', color: MUTED, italics: true, margin: [0, 4, 0, 8] };
      const pct = Math.min(100, Math.max(10, Number(n.attrs?.width ?? 100)));
      let w = (ctx.width * pct) / 100;
      // keep very tall images within one page
      const maxH = 640;
      if ((w * img.h) / img.w > maxH) w = (maxH * img.w) / img.h;
      const alignment = String(n.attrs?.align ?? 'center');
      const caption = captionOf(n, alignment);
      const picture = { image: img.url, width: w, alignment };
      return caption.length ? { stack: [picture, ...caption], unbreakable: true, margin: [0, 4, 0, 10] } : { ...picture, margin: [0, 4, 0, 10] };
    }
    case 'chart':
    case 'chartBlock':
    case 'diagram':
    case 'mindMap':
      return figureBlock(n, ctx);
    case 'callout': {
      const k = calloutKind(n.attrs?.kind);
      return {
        table: {
          widths: ['*'],
          body: [
            [
              {
                stack: [
                  { text: calloutLabel(n.attrs).toUpperCase(), fontSize: 8.5, bold: true, color: k.print, characterSpacing: 0.8, margin: [0, 0, 0, 3] },
                  ...blocks(n.content, { ...ctx, width: ctx.width - 24 })
                ],
                fillColor: calloutFill(k.print, k.printBg, readFill(n.attrs?.fill)),
                margin: [8, 6, 8, 2]
              }
            ]
          ]
        },
        layout: 'noBorders',
        margin: [0, 2, 0, 10]
      };
    }
    default:
      return n.content ? { stack: blocks(n.content, ctx) } : null;
  }
}

function listItem(li: DocNode, ctx: Ctx, prefix: string): Content {
  const kids = li.content ?? [];
  const parts: Content[] = kids.map((k, i) => {
    if (k.type === 'paragraph') {
      const text = inlines(k.content);
      return { text: i === 0 && prefix ? [prefix, ...text] : text.length ? text : ' ', margin: [0, 0, 0, 2] };
    }
    return block(k, ctx) ?? '';
  });
  return parts.length === 1 ? parts[0] : { stack: parts };
}

function table(n: DocNode, ctx: Ctx): Content {
  const rows = n.content ?? [];
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + Number(c.attrs?.colspan ?? 1), 0)));
  const cellW = ctx.width / cols - 8;
  const style = tableStyle(n.attrs?.tstyle);
  const c = n.attrs?.color ? printColour(n.attrs.color) : ctx.subj;
  const boldFirst = n.attrs?.firstCol === true;
  // figure columns line up on the right, as on screen
  const found: { header: boolean; col: number; span: number; text: string }[] = [];
  for (const r of rows) {
    let col = 0;
    for (const cell of r.content ?? []) {
      const span = Number(cell.attrs?.colspan ?? 1);
      found.push({ header: cell.type === 'tableHeader', col, span, text: docToText(cell) });
      col += span;
    }
  }
  const figures = figureColumns(found);
  const headFill = style === 'lined' ? HEAD_FILL : style === 'boxed' ? c : style === 'minimal' ? undefined : tint(c, 14);
  const body = rows.map((r) => {
    const cells: Content[] = [];
    let col = 0;
    for (const cell of r.content ?? []) {
      const header = cell.type === 'tableHeader';
      const colspan = Number(cell.attrs?.colspan ?? 1);
      cells.push({
        stack: blocks(cell.content, { ...ctx, width: cellW * colspan }),
        colSpan: colspan > 1 ? colspan : undefined,
        fillColor: header ? headFill : undefined,
        color: header && style === 'boxed' ? ON_COLOUR : undefined,
        bold: header || (boldFirst && col === 0) || undefined,
        alignment: colspan === 1 && figures.has(col) ? 'right' : undefined
      });
      for (let i = 1; i < colspan; i++) cells.push({});
      col += colspan;
    }
    while (cells.length < cols) cells.push({ text: '' });
    return cells;
  });
  const headerRows = rows.length && (rows[0].content ?? []).every((c) => c.type === 'tableHeader') ? 1 : 0;
  // Columns dragged to a width on screen print in the same proportions; otherwise equal shares.
  const px: number[] = [];
  for (const c of rows[0]?.content ?? []) {
    const span = Number(c.attrs?.colspan ?? 1);
    const cw = Array.isArray(c.attrs?.colwidth) ? (c.attrs!.colwidth as unknown[]) : [];
    for (let j = 0; j < span; j++) px.push(Number(cw[j]) || 0);
  }
  let widths: (number | string)[] = Array(cols).fill('*');
  if (px.length === cols && px.some((v) => v > 0)) {
    const known = px.filter((v) => v > 0);
    const avg = known.reduce((a, b) => a + b, 0) / known.length;
    const full = px.map((v) => v || avg);
    const total = full.reduce((a, b) => a + b, 0);
    const room = ctx.width - cols * 10 - (cols + 1) * 0.6;
    widths = full.map((v) => Math.max(24, (v / total) * room));
  }
  // Each style's lines (square corners: the PDF has no rounded card)
  const R = body.length;
  const H = headerRows;
  const outerH = (i: number) => i === 0 || i === R;
  const outerV = (i: number) => i === 0 || i === cols;
  const lines: Record<string, (i: number) => number | string> =
    style === 'lined'
      ? { h: () => 0.6, v: () => 0.6, hc: () => LINE, vc: () => LINE }
      : style === 'boxed'
        ? { h: (i) => (outerH(i) ? 1.5 : 0.6), v: (i) => (outerV(i) ? 1.5 : 0.6), hc: (i) => (outerH(i) ? c : tint(c, 35)), vc: (i) => (outerV(i) ? c : tint(c, 35)) }
        : style === 'minimal'
          ? { h: (i) => (outerH(i) ? 0 : H && i === H ? 1.2 : 0.4), v: () => 0, hc: (i) => (H && i === H ? INK : LINE), vc: () => LINE }
          : { h: (i) => (H && i === H ? 1.5 : 0.6), v: (i) => (outerV(i) ? 0.6 : 0), hc: (i) => (H && i === H ? c : LINE), vc: () => LINE };
  const caption = typeof n.attrs?.caption === 'string' ? n.attrs.caption.trim() : '';
  const grid: Content = {
    table: { headerRows, widths, body, dontBreakRows: true },
    layout: {
      hLineWidth: lines.h,
      vLineWidth: lines.v,
      hLineColor: lines.hc,
      vLineColor: lines.vc,
      fillColor: (row: number) => (style === 'banded' && row >= H && row % 2 === 1 ? tint(c, 6) : null),
      paddingLeft: () => 5,
      paddingRight: () => 5,
      paddingTop: () => 4,
      paddingBottom: () => 2
    },
    margin: caption ? [0, 0, 0, 0] : [0, 4, 0, 10]
  };
  return caption ? { stack: [{ text: caption, bold: true, margin: [0, 0, 0, 4] }, grid], margin: [0, 4, 0, 10] } : grid;
}

const HEAD_SIZE: Record<number, number> = { 1: 13.5, 2: 13, 3: 12, 4: 11 }; // 1: a section title under a heading set (0.14)
const TINT: Record<Fill, number> = { soft: 14, medium: 28, solid: 40 };

/** A heading with a look, as on screen in print colours (square corners, no tilt or shadow). */
function styledHeading(n: DocNode, level: number, look: HeadingLook, ctx: Ctx): Content {
  const c = look.color ? printColour(look.color) : ctx.subj;
  const fs = HEAD_SIZE[level] ?? 13;
  const solid = look.fill === 'solid';
  const t = TINT[look.fill];
  const full = look.width === 'full';
  const align = look.align === 'center' ? 'center' : 'left';
  const margin = level === 1 ? [0, 10, 0, 6] : level === 2 ? [0, 8, 0, 4] : [0, 6, 0, 3];
  const words = inlines(n.content);
  let before: Content[] = [];
  let after: Content[] = [];
  if (look.style === 'numbered') before = [{ text: ` ${++ctx.hnum.n} `, background: c, color: ON_COLOUR, bold: true }, '  '];
  if (look.style === 'brackets') {
    before = [{ text: '[ ', color: solid ? ON_COLOUR : c }];
    after = [{ text: ' ]', color: solid ? ON_COLOUR : c }];
  }
  const inner = (color: string) => {
    const text: Content = { text: [...before, ...(words.length ? words : [' ']), ...after], bold: true, fontSize: fs, color, alignment: full ? align : undefined };
    const ic = iconSvg(look.icon, color === INK ? c : color, fs * 0.95);
    if (!ic) return text;
    const mark = { width: fs, stack: [ic], margin: [0, 1, 0, 0] };
    // centred across the full line: the icon stays beside the words (empty columns either side)
    if (full && align === 'center') return { columns: [{ width: '*', text: '' }, mark, { width: 'auto', stack: [{ ...(text as object), alignment: undefined }] }, { width: '*', text: '' }], columnGap: 6 };
    return { columns: [mark, { width: full ? '*' : 'auto', stack: [text] }], columnGap: 6 };
  };
  const width = full ? '*' : 'auto';
  switch (look.style) {
    case 'plain':
      return box(inner(c), { width, align, margin });
    case 'underline':
      return box(inner(INK), { border: [0, 0, 0, look.fill === 'soft' ? 1.5 : look.fill === 'medium' ? 2 : 2.5], borderColor: c, pad: [0, 0, 0, 2], width, align, margin });
    case 'marker':
      return box(inner(INK), { fill: tint(c, t + 8), pad: [3, 1, 3, 0], width, align, margin });
    case 'pill':
    case 'boxed':
      return box(inner(solid ? ON_COLOUR : INK), { fill: solid ? c : tint(c, t), border: look.style === 'boxed' ? [1.25, 1.25, 1.25, 1.25] : undefined, borderColor: c, pad: [10, 3, 10, 2], width, align, margin });
    case 'banner':
      return box(inner(solid ? ON_COLOUR : INK), { fill: solid ? c : tint(c, t), border: [4, 0, 0, 0], borderColor: c, pad: [10, 5, 10, 4], width: '*', margin });
    case 'card':
      return box(inner(INK), { fill: tint(c, t / 2), border: [0.75, 3, 0.75, 0.75], borderColor: [tint(c, 40), c, tint(c, 40), tint(c, 40)], pad: [10, 6, 10, 5], width: '*', margin });
    case 'tab':
      return { stack: [box(inner(ON_COLOUR), { fill: c, pad: [10, 3, 10, 2], width: 'auto', align }), { canvas: [{ type: 'line', x1: 0, y1: 0, x2: ctx.width, y2: 0, lineWidth: 1.5, lineColor: c }] }], margin };
    case 'brackets':
      return box(inner(solid ? ON_COLOUR : INK), { fill: solid ? c : look.fill === 'medium' ? tint(c, 14) : undefined, pad: [solid ? 6 : 0, 1, solid ? 6 : 0, 0], width, align, margin });
    case 'split': {
      const label = { text: ctx.subjName.toUpperCase(), fontSize: 7.5, bold: true, color: ON_COLOUR, characterSpacing: 0.8, fillColor: c, margin: [0, (fs - 7.5) / 2, 0, 0] };
      const t2: Content = { table: { widths: ['auto', width], body: [[label, { stack: [inner(solid ? ON_COLOUR : INK)], fillColor: solid ? c : tint(c, t) }]] }, layout: { defaultBorder: false, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 3, paddingBottom: () => 2 } };
      return full ? { ...(t2 as object), margin } : place(t2, align, margin);
    }
    case 'sticky':
      return box(inner('#3b3313'), { fill: STICKY, border: [0, 3, 0, 0], borderColor: c, pad: [10, 4, 10, 3], width, align, margin });
    default:
      return box(inner(INK), { width, align, margin });
  }
}

const PANEL_TINT: Record<Fill, number> = { soft: 12, medium: 24, solid: 36 };

/** A container: soft panel, titled panel, sticky note, frame, quote or two columns (always side by side in print). */
function panel(n: DocNode, ctx: Ctx): Content {
  const l = readPanelLook(n.attrs);
  const c = l.color ? printColour(l.color) : ctx.subj;
  const t = PANEL_TINT[l.fill];
  const pad = [10, 8, 10, 6];
  const w = ctx.width - 22;
  const kids = n.content ?? [];
  const body: Content[] =
    kids[0]?.type === 'panelColumn'
      ? [{ columns: kids.map((col) => ({ width: '*', stack: blocks(col.content, { ...ctx, width: (w - 16) / 2 }) })), columnGap: 16 }]
      : blocks(kids, { ...ctx, width: w });
  const margin = [0, 4, 0, 10];
  const title = panelTitle(l);
  switch (l.kind) {
    case 'titled': {
      const ic = l.icon ? iconSvg(l.icon, ON_COLOUR, 10.5) : null;
      const label: Content = { text: title, bold: true, color: ON_COLOUR, fontSize: 9.5 };
      const head = ic ? { columns: [{ width: 11, stack: [ic], margin: [0, 0.5, 0, 0] }, { width: '*', stack: [label] }], columnGap: 6 } : label;
      const tints: Record<Fill, number> = { soft: 7, medium: 16, solid: 26 };
      return { stack: [box(head, { fill: c, pad: [10, 5, 10, 4] }), box(body, { fill: tint(c, tints[l.fill]), border: [0.75, 0, 0.75, 0.75], borderColor: tint(c, 35), pad })], margin };
    }
    case 'sticky':
      return box([...(title ? [{ text: title, bold: true, margin: [0, 0, 0, 4] }] : []), ...body], { fill: STICKY, border: [0, 3, 0, 0], borderColor: c, pad, margin });
    case 'framed':
      return box(body, { fill: tint(c, t / 2), border: [1.5, 1.5, 1.5, 1.5], borderColor: c, pad, margin });
    case 'quote':
      return box(
        [{ text: '“', fontSize: 22, bold: true, color: c, lineHeight: 0.8, margin: [0, 0, 0, -2] }, ...body, ...(l.author ? [{ text: `— ${l.author}`, alignment: 'right', color: MUTED, margin: [0, 4, 0, 0] }] : [])],
        { fill: tint(c, t), border: [3.5, 0, 0, 0], borderColor: c, pad, margin }
      );
    default:
      return box(body, { fill: tint(c, t), pad, margin });
  }
}

/** A callout's fill: the soft one it always had, or the medium / solid tint of its colour. */
function calloutFill(print: string, soft: string, fill: Fill | null): string {
  return fill === 'medium' ? tint(print, 22) : fill === 'solid' ? tint(print, 34) : soft;
}

// ---------------- document pieces ----------------

/** Folders, for where each note is filed (loaded at the start of each export). */
let fidx = new FolderIndex([]);

function noteMeta(n: Note): Content {
  return { text: [fidx.label(n), n.topic].filter(Boolean).join(' · '), color: MUTED, margin: [0, 0, 0, 12] };
}

/** A note's look (0.14): its own, else its subject's or the every-note default. */
function lookOf(n: Note): NoteLook {
  const { main, sub } = fidx.placeOf(n);
  return resolveLook(n, [sub?.id ?? fidx.noteFolder(n), main?.id]).look;
}

/** Plain headings under a heading set: h2 gets the set's main look, h3 and h4 the second one. */
function setLook(level: number, ctx: Ctx): HeadingLook | null {
  const l = ctx.hset ? SET_LOOKS[ctx.hset] : null;
  return l ? (level === 2 ? l.h2 : l.h3) : null;
}

/** The note's cover band, in print colours (a single note's PDF). */
function coverBand(n: Note): Content[] {
  const look = lookOf(n);
  if (look.cover === 'none') return [];
  const colour = look.cover === 'subject' ? printColour(fidx.placeOf(n).main?.colour) : look.accent ? printColour(look.accent) : ACCENT;
  return [{ canvas: [{ type: 'rect', x: 0, y: 0, w: CONTENT_W, h: 30, r: 6, color: colour }], margin: [0, 0, 0, 14] }];
}

function sectionContent(n: Note, sectionIds: string[] | null, base: Ctx, tocDepth: boolean): Content[] {
  const out: Content[] = [];
  const main = fidx.placeOf(n).main;
  const look = lookOf(n);
  const ctx: Ctx = { ...base, subj: look.accent ? printColour(look.accent) : printColour(main?.colour), subjName: main?.name ?? 'Notes', hnum: { n: 0 }, hset: look.headings };
  const secLook = look.headings === 'classic' ? null : SET_LOOKS[look.headings]!.h2;
  const snum = { n: 0 };
  for (const s of n.sections) {
    if (sectionIds && !sectionIds.includes(s.id)) continue;
    if (s.heading.trim() && secLook) out.push(styledHeading({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: s.heading }] }, 1, secLook, { ...ctx, hnum: snum }));
    else if (s.heading.trim()) out.push({ text: s.heading, style: 'section', tocItem: tocDepth ? 'toc' : undefined, tocMargin: [24, 0, 0, 0] });
    out.push(...blocks(s.doc.content, ctx));
  }
  return out;
}

function insightsBlock(n: Note): Content[] {
  if (!n.insights?.items.length) return [];
  const groups = groupInsights(n.insights);
  const stack: Content[] = [{ text: 'Quick insights', bold: true, fontSize: 12, margin: [0, 0, 0, 4] }];
  for (const g of groups) {
    if (groups.length > 1) stack.push({ text: g.section.toUpperCase(), fontSize: 8, bold: true, color: MUTED, margin: [0, 4, 0, 2] });
    stack.push({ ul: g.texts.map((t) => ['–  ', t].join('')), type: 'none', margin: [0, 0, 0, 2] });
  }
  return [
    {
      table: { widths: ['*'], body: [[{ stack, fillColor: '#fdf6dc', margin: [8, 6, 8, 6] }]] },
      layout: { hLineWidth: () => 0.75, vLineWidth: () => 0.75, hLineColor: () => '#e8d48a', vLineColor: () => '#e8d48a' },
      margin: [0, 0, 0, 12]
    }
  ];
}

function reflection(n: Note): Content[] {
  const out: Content[] = [];
  if (n.explain.trim()) out.push({ text: 'In my own words', style: 'section' }, { text: n.explain, margin: [0, 0, 0, 8] });
  if (n.connect.trim()) out.push({ text: 'Connections', style: 'section' }, { text: n.connect, margin: [0, 0, 0, 8] });
  return out;
}

function vocabTable(words: Vocab[]): Content {
  const head = ['Word', 'Meaning', 'Use cases', 'Synonyms', 'Antonyms'].map((t) => ({ text: t, bold: true, fillColor: HEAD_FILL }));
  const rows = words.map((w) => [
    { text: w.word, bold: true },
    w.meaning,
    { stack: w.uses.filter((u) => u.sentence.trim()).map((u) => ({ text: [u.sentence, { text: `  (${u.context})`, color: MUTED }], margin: [0, 0, 0, 3] })) },
    w.synonyms.join(', '),
    w.antonyms.join(', ')
  ]);
  return {
    table: { headerRows: 1, widths: [70, 90, '*', 70, 70], body: [head, ...rows], dontBreakRows: true },
    layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => LINE, vLineColor: () => LINE, paddingTop: () => 4, paddingBottom: () => 3 },
    fontSize: 9.5
  };
}

const styles = {
  title: { fontSize: 22, bold: true, color: INK, margin: [0, 0, 0, 4] },
  subject: { fontSize: 18, bold: true, color: ACCENT, margin: [0, 0, 0, 12] },
  folder: { fontSize: 14, bold: true, color: MUTED, margin: [0, 0, 0, 8] },
  noteTitle: { fontSize: 16, bold: true, color: INK, margin: [0, 8, 0, 2] },
  section: { fontSize: 13.5, bold: true, color: ACCENT, margin: [0, 10, 0, 6] },
  h2: { fontSize: 13, bold: true, margin: [0, 8, 0, 4] },
  h3: { fontSize: 12, bold: true, margin: [0, 6, 0, 3] },
  h4: { fontSize: 11, bold: true, color: MUTED, margin: [0, 6, 0, 3] }
};

function safeName(s: string) {
  return (s.trim() || 'note').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60);
}

// ---------------- public ----------------

export async function buildPdf(scope: PdfScope): Promise<{ blob: Blob; filename: string }> {
  let header = 'UPSC Study Notes';
  let filename = `upsc-notes-${ymd()}.pdf`;
  let content: Content[] = [];
  fidx = new FolderIndex(await db.folders.toArray());
  await loadLooks();

  if (scope.kind === 'section' || scope.kind === 'note') {
    const n = scope.note;
    const ids = scope.kind === 'section' ? [scope.sectionId] : null;
    const docs = n.sections.filter((s) => !ids || ids.includes(s.id)).map((s) => s.doc);
    const ctx: Ctx = { images: await loadImages(docs), sketches: new Map(), width: CONTENT_W, ...NOTE_CTX };
    header = n.title || 'Untitled note';
    content = [
      ...coverBand(n),
      { text: n.title || 'Untitled note', style: 'title' },
      noteMeta(n),
      ...(scope.kind === 'note' ? insightsBlock(n) : []),
      ...sectionContent(n, ids, ctx, false)
    ];
    if (scope.kind === 'note') content.push(...reflection(n));
    const sec = scope.kind === 'section' ? n.sections.find((s) => s.id === scope.sectionId) : null;
    filename = `${safeName(n.title)}${sec ? '-' + safeName(sec.heading || 'section') : ''}.pdf`;
  } else {
    const all = (await db.notes.toArray()).filter((n) => !n.deletedAt && (scope.subject === 'All' || fidx.placeOf(n).main?.id === scope.subject));
    const scopeName = scope.subject === 'All' ? 'All subjects' : (fidx.get(scope.subject)?.name ?? 'Subject');
    const words = scope.includeVocab ? (await db.vocab.toArray()).filter((w) => !w.deletedAt).sort((a, b) => a.word.localeCompare(b.word)) : [];
    const ctx: Ctx = { images: await loadImages(all.flatMap((n) => n.sections.map((s) => s.doc))), sketches: new Map(), width: CONTENT_W, ...NOTE_CTX };
    content = [
      { text: 'UPSC Study Notes', style: 'title', margin: [0, 160, 0, 6] },
      { text: scopeName, fontSize: 14, color: ACCENT },
      { text: `${all.length} notes${scope.includeVocab ? ` · ${words.length} words` : ''} · exported ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`, color: MUTED, margin: [0, 4, 0, 0] },
      { toc: { id: 'toc', title: { text: 'Contents', style: 'subject' } }, pageBreak: 'before' }
    ];
    // Main subject → subject → notes, in his folder order.
    for (const { main, subjects } of fidx.subjectsByMain()) {
      const groups = subjects
        .map((s) => ({ s, notes: all.filter((n) => fidx.noteFolder(n) === s.id).sort((a, b) => (a.topic + a.title).localeCompare(b.topic + b.title)) }))
        .filter((g) => g.notes.length);
      if (!groups.length) continue;
      content.push({ text: main.name, style: 'subject', tocItem: 'toc', pageBreak: 'before' });
      const named = groups.length > 1 || groups[0].s.name !== 'General';
      groups.forEach(({ s, notes }, gi) => notes.forEach((n, i) => {
        const first = i === 0;
        if (first && named) content.push({ text: s.name, style: 'folder', tocItem: 'toc', tocMargin: [12, 0, 0, 0], pageBreak: gi > 0 ? 'before' : undefined });
        content.push(
          { text: n.title || 'Untitled note', style: 'noteTitle', tocItem: 'toc', tocMargin: [named ? 24 : 12, 0, 0, 0], pageBreak: (i > 0 || (gi > 0 && !named)) ? 'before' : undefined },
          noteMeta(n),
          ...insightsBlock(n),
          ...sectionContent(n, null, ctx, false),
          ...reflection(n)
        );
      }));
    }
    if (words.length) content.push({ text: 'Vocabulary', style: 'subject', tocItem: 'toc', pageBreak: 'before' }, vocabTable(words));
    if (!all.length && !words.length) content.push({ text: 'Nothing to export for this choice.', color: MUTED, pageBreak: 'before' });
    filename = `upsc-notes-${scope.subject === 'All' ? 'all' : safeName(scopeName)}-${ymd()}.pdf`;
  }

  const doc = {
    pageSize: 'A4',
    pageMargins: [MARGIN, 56, MARGIN, 52],
    info: { title: header, creator: 'UPSC Study Notes' },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25, color: INK },
    styles,
    header: (page: number) =>
      page === 1 ? null : { text: header, fontSize: 8.5, color: MUTED, margin: [MARGIN, 24, MARGIN, 0] },
    footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8.5, color: MUTED, margin: [0, 18, 0, 0] }),
    content
  };

  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  pdfMake.addVirtualFileSystem(vfs);
  const blob = await pdfMake.createPdf(doc).getBlob();
  return { blob, filename };
}
