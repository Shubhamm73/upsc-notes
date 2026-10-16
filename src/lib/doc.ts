import type { DocNode, Note } from '../db';
import { calloutLabel } from './callouts';
import { chartWords, readChartData } from './charts';
import { diagramWords, readDiagram } from './diagrams';
import { mindMapWords, readMindMap } from './mindmap';

/**
 * M1 keeps a plain-text body but stores it in the editor's JSON shape,
 * so notes written now open unchanged in the rich editor that arrives in M2.
 */
export function textToDoc(text: string): DocNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return {
    type: 'doc',
    content: lines.map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    )
  };
}

/** Plain text of any doc. Block nodes become lines; works for rich content too. */
export function docToText(doc: DocNode | undefined): string {
  if (!doc) return '';
  const lines: string[] = [];
  const inline = (n: DocNode): string =>
    n.type === 'text' ? n.text ?? '' : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(inline).join('');
  const walk = (n: DocNode) => {
    const kids = n.content ?? [];
    const isTextBlock = kids.length === 0 || kids.every((k) => k.type === 'text' || k.type === 'hardBreak');
    if (n.type !== 'doc' && isTextBlock) {
      lines.push(inline(n));
      return;
    }
    kids.forEach(walk);
  };
  walk(doc);
  return lines.join('\n');
}

/** Every UPSC callout in a doc, in reading order, with its plain text. */
export function calloutsIn(doc: DocNode | undefined): { kind: string; label: string; text: string }[] {
  const out: { kind: string; label: string; text: string }[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'callout') out.push({ kind: String(n.attrs?.kind ?? 'article'), label: calloutLabel(n.attrs), text: docToText(n).replace(/\s+/g, ' ').trim() });
    (n.content ?? []).forEach(walk);
  };
  if (doc) walk(doc);
  return out;
}

/**
 * Everything search looks at for a note. Callouts add their label ("Case callout"),
 * so typing "case" finds notes that hold Case callouts.
 */
export function noteSearchText(n: Note): string {
  return [
    n.title,
    n.topic,
    n.subject,
    n.explain,
    n.connect,
    ...n.sections.map((s) => [s.heading, docToText(s.doc), ...calloutsIn(s.doc).map((c) => `${c.label} callout`), ...imageCaptions(s.doc), ...lookTexts(s.doc), ...figureWords(s.doc), ...sketchesIn(s.doc).map(() => 'sketch')].join(' '))
  ]
    .join(' ')
    .toLowerCase();
}

/** Every sketch block in a doc (search finds "sketch"). */
export function sketchesIn(doc: DocNode | undefined): DocNode[] {
  const out: DocNode[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'sketchBlock') out.push(n);
    (n.content ?? []).forEach(walk);
  };
  if (doc) walk(doc);
  return out;
}

/** Captions under pictures and sketches (searchable like text). */
export function imageCaptions(doc: DocNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if ((n.type === 'imageBlock' || n.type === 'sketchBlock') && typeof n.attrs?.caption === 'string' && n.attrs.caption.trim()) out.push(n.attrs.caption.trim());
    (n.content ?? []).forEach(walk);
  };
  walk(doc ?? { type: 'doc' });
  return out;
}

/** Every word of the charts, diagrams and mind maps (0.13): titles, labels, series, items, ideas. */
export function figureWords(doc: DocNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    const a = (n.attrs ?? {}) as Record<string, unknown>;
    if (n.type === 'chart' || n.type === 'chartBlock') out.push(chartWords(readChartData(a, n.type === 'chartBlock')));
    else if (n.type === 'diagram') out.push(diagramWords(readDiagram(a)));
    else if (n.type === 'mindMap') out.push(mindMapWords(readMindMap(a)));
    (n.content ?? []).forEach(walk);
  };
  walk(doc ?? { type: 'doc' });
  return out;
}

/** Table captions and container titles / quote authors (0.12): searchable like text. */
export function lookTexts(doc: DocNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    for (const k of n.type === 'table' ? ['caption'] : n.type === 'panel' ? ['title', 'author'] : []) {
      const v = n.attrs?.[k];
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc ?? { type: 'doc' });
  return out;
}

/** Words in a note's sections (title, headings and the reflection fields are not counted). */
export function wordCount(n: Note): number {
  let total = 0;
  for (const s of n.sections) total += docToText(s.doc).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return total;
}
