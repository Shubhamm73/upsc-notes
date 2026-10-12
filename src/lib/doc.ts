import type { DocNode, Note } from '../db';
import { calloutKind } from './callouts';

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
export function calloutsIn(doc: DocNode | undefined): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'callout') out.push({ kind: String(n.attrs?.kind ?? 'article'), text: docToText(n).replace(/\s+/g, ' ').trim() });
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
    ...n.sections.map((s) => [s.heading, docToText(s.doc), ...calloutsIn(s.doc).map((c) => `${calloutKind(c.kind).label} callout`)].join(' '))
  ]
    .join(' ')
    .toLowerCase();
}

/** Words in a note's sections (title, headings and the reflection fields are not counted). */
export function wordCount(n: Note): number {
  let total = 0;
  for (const s of n.sections) total += docToText(s.doc).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return total;
}
