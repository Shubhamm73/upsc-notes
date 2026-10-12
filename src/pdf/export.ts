import { Chart } from 'chart.js';
import { db, SUBJECTS, type DocNode, type Note, type Vocab } from '../db';
import { chartConfig, PRINT_PALETTE, readChart, type ChartData } from '../editor/chart-block';
import { collectImageIds } from '../editor/images';
import { ymd } from '../lib/dates';
import { groupInsights } from '../lib/insights';
import { calloutKind } from '../lib/callouts';

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

async function loadImages(docs: DocNode[]): Promise<Map<string, { url: string; w: number; h: number }>> {
  const ids = new Set<string>();
  docs.forEach((d) => collectImageIds(d, ids));
  const out = new Map<string, { url: string; w: number; h: number }>();
  for (const id of ids) {
    const rec = await db.images.get(id);
    if (rec) out.set(id, { url: await blobToDataUrl(rec.blob), w: rec.width, h: rec.height });
  }
  return out;
}

/** Draws a chart off-screen in print colours and returns it as a PNG. */
function chartToPng(d: ChartData): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 600;
  Object.assign(canvas.style, { position: 'fixed', left: '-10000px', top: '0', width: '600px', height: '300px' });
  document.body.append(canvas);
  const cfg = chartConfig(d, { animate: false, text: INK, grid: LINE, palette: PRINT_PALETTE, surface: '#ffffff' });
  (cfg.options as Record<string, unknown>).responsive = false;
  (cfg.options as Record<string, unknown>).devicePixelRatio = 2;
  const prevSize = Chart.defaults.font.size;
  Chart.defaults.font.size = 15; // readable once the chart is scaled onto the page
  const chart = new Chart(canvas, cfg);
  const url = chart.toBase64Image('image/png', 1);
  chart.destroy();
  Chart.defaults.font.size = prevSize;
  canvas.remove();
  return url;
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
  images: Map<string, { url: string; w: number; h: number }>;
  width: number; // available width at this nesting level
}

function blocks(nodes: DocNode[] | undefined, ctx: Ctx): Content[] {
  return (nodes ?? []).map((n) => block(n, ctx)).filter((c): c is Content => c !== null);
}

function block(n: DocNode, ctx: Ctx): Content | null {
  switch (n.type) {
    case 'paragraph':
      return { text: n.content?.length ? inlines(n.content) : ' ', margin: [0, 0, 0, 6] };
    case 'heading': {
      const level = Number(n.attrs?.level ?? 2);
      return { text: inlines(n.content), style: `h${level}` };
    }
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
    case 'imageBlock': {
      const img = ctx.images.get(String(n.attrs?.imageId));
      if (!img) return { text: '[image missing]', color: MUTED, italics: true, margin: [0, 4, 0, 8] };
      const pct = Math.min(100, Math.max(10, Number(n.attrs?.width ?? 100)));
      let w = (ctx.width * pct) / 100;
      // keep very tall images within one page
      const maxH = 640;
      if ((w * img.h) / img.w > maxH) w = (maxH * img.w) / img.h;
      return { image: img.url, width: w, alignment: String(n.attrs?.align ?? 'center'), margin: [0, 4, 0, 10] };
    }
    case 'chartBlock': {
      const d = readChart(n.attrs as Partial<ChartData>);
      const w = Math.min(ctx.width, CONTENT_W);
      return {
        stack: [
          { text: d.title || 'Chart', bold: true, margin: [0, 0, 0, 4] },
          { image: chartToPng(d), width: w, height: w / 2 }
        ],
        unbreakable: true,
        margin: [0, 4, 0, 10]
      };
    }
    case 'callout': {
      const k = calloutKind(n.attrs?.kind);
      return {
        table: {
          widths: ['*'],
          body: [
            [
              {
                stack: [
                  { text: k.label.toUpperCase(), fontSize: 8.5, bold: true, color: k.print, characterSpacing: 0.8, margin: [0, 0, 0, 3] },
                  ...blocks(n.content, { ...ctx, width: ctx.width - 24 })
                ],
                fillColor: k.printBg,
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
  const body = rows.map((r) => {
    const cells: Content[] = [];
    for (const c of r.content ?? []) {
      const header = c.type === 'tableHeader';
      const colspan = Number(c.attrs?.colspan ?? 1);
      cells.push({
        stack: blocks(c.content, { ...ctx, width: cellW * colspan }),
        colSpan: colspan > 1 ? colspan : undefined,
        fillColor: header ? HEAD_FILL : undefined,
        bold: header || undefined
      });
      for (let i = 1; i < colspan; i++) cells.push({});
    }
    while (cells.length < cols) cells.push({ text: '' });
    return cells;
  });
  const headerRows = rows.length && (rows[0].content ?? []).every((c) => c.type === 'tableHeader') ? 1 : 0;
  return {
    table: { headerRows, widths: Array(cols).fill('*'), body, dontBreakRows: true },
    layout: {
      hLineWidth: () => 0.6,
      vLineWidth: () => 0.6,
      hLineColor: () => LINE,
      vLineColor: () => LINE,
      paddingLeft: () => 5,
      paddingRight: () => 5,
      paddingTop: () => 4,
      paddingBottom: () => 2
    },
    margin: [0, 4, 0, 10]
  };
}

// ---------------- document pieces ----------------

function noteMeta(n: Note): Content {
  return { text: [n.subject, n.topic].filter(Boolean).join(' · '), color: MUTED, margin: [0, 0, 0, 12] };
}

function sectionContent(n: Note, sectionIds: string[] | null, ctx: Ctx, tocDepth: boolean): Content[] {
  const out: Content[] = [];
  for (const s of n.sections) {
    if (sectionIds && !sectionIds.includes(s.id)) continue;
    if (s.heading.trim()) out.push({ text: s.heading, style: 'section', tocItem: tocDepth ? 'toc' : undefined, tocMargin: [24, 0, 0, 0] });
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

  if (scope.kind === 'section' || scope.kind === 'note') {
    const n = scope.note;
    const ids = scope.kind === 'section' ? [scope.sectionId] : null;
    const docs = n.sections.filter((s) => !ids || ids.includes(s.id)).map((s) => s.doc);
    const ctx: Ctx = { images: await loadImages(docs), width: CONTENT_W };
    header = n.title || 'Untitled note';
    content = [
      { text: n.title || 'Untitled note', style: 'title' },
      noteMeta(n),
      ...(scope.kind === 'note' ? insightsBlock(n) : []),
      ...sectionContent(n, ids, ctx, false)
    ];
    if (scope.kind === 'note') content.push(...reflection(n));
    const sec = scope.kind === 'section' ? n.sections.find((s) => s.id === scope.sectionId) : null;
    filename = `${safeName(n.title)}${sec ? '-' + safeName(sec.heading || 'section') : ''}.pdf`;
  } else {
    const all = (await db.notes.toArray()).filter((n) => !n.deletedAt && (scope.subject === 'All' || n.subject === scope.subject));
    const words = scope.includeVocab ? (await db.vocab.toArray()).filter((w) => !w.deletedAt).sort((a, b) => a.word.localeCompare(b.word)) : [];
    const ctx: Ctx = { images: await loadImages(all.flatMap((n) => n.sections.map((s) => s.doc))), width: CONTENT_W };
    content = [
      { text: 'UPSC Study Notes', style: 'title', margin: [0, 160, 0, 6] },
      { text: scope.subject === 'All' ? 'All subjects' : scope.subject, fontSize: 14, color: ACCENT },
      { text: `${all.length} notes${scope.includeVocab ? ` · ${words.length} words` : ''} · exported ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`, color: MUTED, margin: [0, 4, 0, 0] },
      { toc: { id: 'toc', title: { text: 'Contents', style: 'subject' } }, pageBreak: 'before' }
    ];
    const order = [...SUBJECTS, ...new Set(all.map((n) => n.subject).filter((s) => !(SUBJECTS as readonly string[]).includes(s)))];
    for (const subject of order) {
      const notes = all.filter((n) => n.subject === subject).sort((a, b) => (a.topic + a.title).localeCompare(b.topic + b.title));
      if (!notes.length) continue;
      content.push({ text: subject, style: 'subject', tocItem: 'toc', pageBreak: 'before' });
      notes.forEach((n, i) => {
        content.push(
          { text: n.title || 'Untitled note', style: 'noteTitle', tocItem: 'toc', tocMargin: [12, 0, 0, 0], pageBreak: i > 0 ? 'before' : undefined },
          noteMeta(n),
          ...insightsBlock(n),
          ...sectionContent(n, null, ctx, false),
          ...reflection(n)
        );
      });
    }
    if (words.length) content.push({ text: 'Vocabulary', style: 'subject', tocItem: 'toc', pageBreak: 'before' }, vocabTable(words));
    if (!all.length && !words.length) content.push({ text: 'Nothing to export for this choice.', color: MUTED, pageBreak: 'before' });
    filename = `upsc-notes-${scope.subject === 'All' ? 'all' : safeName(scope.subject)}-${ymd()}.pdf`;
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
