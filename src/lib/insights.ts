import type { DocNode, InsightItem, Note, NoteInsights } from '../db';
import { markedNodes, readMindMap } from './mindmap';

/**
 * Pulls every highlighted run of text out of a note, in reading order,
 * tagged with the section it came from. Adjacent highlighted pieces in one
 * line (e.g. a bold word inside a highlight) are joined into one point.
 */
export function extractInsights(note: Note): NoteInsights {
  const items: InsightItem[] = [];
  const seen = new Set<string>();
  for (const s of note.sections) {
    const section = s.heading.trim() || 'Notes';
    for (const text of sectionKeyLines(s.doc)) {
      const key = `${section}\u0000${text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ section, text });
    }
  }
  return { generatedAt: Date.now(), items };
}

/**
 * The highlighted lines ("key lines") of one section, in reading order, without repeats.
 * Highlights inside callouts, lists and tables count too: every text block is visited.
 */
export function sectionKeyLines(doc: DocNode): string[] {
  return keyLineDetails(doc).map((d) => d.text);
}

/** Each key line with the rest of its paragraph (`before` / `after`), used for the blanked-out review prompt. */
export function keyLineDetails(doc: DocNode): { text: string; before: string; after: string }[] {
  // 0.17 speed pass: remembered per doc object (a saved doc is never changed in place; each edit makes a new one),
  // so the live key-line counts walk only the section being edited. Callers get their own copies.
  const known = doc && typeof doc === 'object' ? linesOf.get(doc) : undefined;
  if (known) return known.map((d) => ({ ...d }));
  const out = findKeyLines(doc);
  if (doc && typeof doc === 'object') linesOf.set(doc, out.map((d) => ({ ...d })));
  return out;
}

const linesOf = new WeakMap<DocNode, { text: string; before: string; after: string }[]>();

function findKeyLines(doc: DocNode): { text: string; before: string; after: string }[] {
  const out: { text: string; before: string; after: string }[] = [];
  const seen = new Set<string>();
  const walk = (n: DocNode) => {
    // a marked idea in a mind map (0.13) is a key line; its path ("Centre › Branch") stands before the blank
    if (n.type === 'mindMap') {
      for (const m of markedNodes(readMindMap((n.attrs ?? {}) as Record<string, unknown>))) {
        if (seen.has(m.text.toLowerCase())) continue;
        seen.add(m.text.toLowerCase());
        out.push({ text: m.text, before: m.context ? `${m.context} › ` : '', after: '' });
      }
      return;
    }
    const kids = n.content ?? [];
    const isTextBlock = kids.length > 0 && kids.every((k) => k.type === 'text' || k.type === 'hardBreak');
    if (!isTextBlock) {
      kids.forEach(walk);
      return;
    }
    const plain = kids.map((k) => (k.type === 'text' ? k.text ?? '' : ' ')).join('');
    let pos = 0;
    let run = '';
    let start = 0;
    const flush = () => {
      const text = run.replace(/\s+/g, ' ').trim();
      const end = start + run.length;
      run = '';
      if (!text || seen.has(text.toLowerCase())) return;
      seen.add(text.toLowerCase());
      out.push({ text, before: plain.slice(0, start).replace(/\s+/g, ' '), after: plain.slice(end).replace(/\s+/g, ' ') });
    };
    for (const k of kids) {
      const piece = k.type === 'text' ? k.text ?? '' : ' ';
      const marked = k.type === 'text' && (k.marks ?? []).some((m) => m.type === 'highlight');
      if (marked) {
        if (!run) start = pos;
        run += piece;
      } else flush();
      pos += piece.length;
    }
    flush();
  };
  walk(doc);
  return out;
}

/** Items grouped by section, keeping first-seen order. */
export function groupInsights(ins: NoteInsights): { section: string; texts: string[] }[] {
  const groups: { section: string; texts: string[] }[] = [];
  for (const it of ins.items) {
    let g = groups.find((x) => x.section === it.section);
    if (!g) groups.push((g = { section: it.section, texts: [] }));
    g.texts.push(it.text);
  }
  return groups;
}
