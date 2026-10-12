import type { DocNode } from '../db';

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
