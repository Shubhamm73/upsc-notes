import type { DocNode, InsightItem, Note, NoteInsights } from '../db';

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
    const walk = (n: DocNode) => {
      const kids = n.content ?? [];
      const isTextBlock = kids.length > 0 && kids.every((k) => k.type === 'text' || k.type === 'hardBreak');
      if (!isTextBlock) {
        kids.forEach(walk);
        return;
      }
      let run = '';
      const flush = () => {
        const text = run.replace(/\s+/g, ' ').trim();
        run = '';
        if (!text) return;
        const key = `${section}\u0000${text.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ section, text });
      };
      for (const k of kids) {
        const marked = k.type === 'text' && (k.marks ?? []).some((m) => m.type === 'highlight');
        if (marked) run += k.text ?? '';
        else flush();
      }
      flush();
    };
    walk(s.doc);
  }
  return { generatedAt: Date.now(), items };
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
