/**
 * "Save this note as a template" (0.14). A saved template keeps the note's sections, headings with their
 * looks, containers and callouts (emptied) and tables (header text kept, other cells emptied); it drops
 * paragraph text, lists, images, sketches and figures. Templates live in the `meta` table under
 * `templates` and travel in the backup (format 8). A deleted one stays as a small record (deletedAt) so
 * merging an older backup can't bring it back; an import takes a template only when the file's copy is
 * newer (updatedAt), like notes. Ids start with "my:" so they never clash with the built-in ones.
 */
import { getMeta, setMeta, type DocNode } from '../db';
import type { NoteTemplate } from './templates';

export interface SavedTemplate {
  id: string;
  name: string;
  sections: { heading: string; doc: DocNode }[];
  meter: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

const KEY = 'templates';
const MAX_SECTIONS = 40;
let cache: SavedTemplate[] = [];
const listeners = new Set<() => void>();

const isDoc = (v: unknown): v is DocNode => !!v && typeof v === 'object' && !Array.isArray(v) && (v as DocNode).type === 'doc';

/** A saved template, checked field by field (a damaged one is skipped, never shown half-made). */
export function readSavedTemplate(raw: unknown): SavedTemplate | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (typeof r.id !== 'string' || !r.id.startsWith('my:') || typeof r.name !== 'string') return null;
  if (!num(r.createdAt) || !num(r.updatedAt) || !(r.deletedAt === null || num(r.deletedAt))) return null;
  if (!Array.isArray(r.sections)) return null;
  const sections = r.sections
    .filter((x): x is { heading: string; doc: DocNode } => !!x && typeof x === 'object' && typeof (x as { heading?: unknown }).heading === 'string' && isDoc((x as { doc?: unknown }).doc))
    .slice(0, MAX_SECTIONS)
    .map((x) => ({ heading: x.heading.slice(0, 200), doc: x.doc }));
  if (!sections.length && !r.deletedAt) return null;
  return { id: r.id, name: r.name.trim().slice(0, 60) || 'My template', sections, meter: r.meter === true, createdAt: r.createdAt as number, updatedAt: r.updatedAt as number, deletedAt: r.deletedAt as number | null };
}

export async function loadTemplates(): Promise<SavedTemplate[]> {
  const raw = await getMeta<unknown[]>(KEY, []);
  cache = (Array.isArray(raw) ? raw : []).map(readSavedTemplate).filter((x): x is SavedTemplate => !!x);
  listeners.forEach((f) => f());
  return cache;
}

/** Every saved template record, deleted ones included (the backup carries both). */
export const allSavedTemplates = (): SavedTemplate[] => cache;
export const liveSavedTemplates = (): SavedTemplate[] => cache.filter((x) => !x.deletedAt).sort((a, b) => a.createdAt - b.createdAt);
export const onTemplatesChange = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

const asTemplate = (x: SavedTemplate): NoteTemplate => ({
  id: x.id,
  group: 'My templates',
  name: x.name,
  hint: `Saved from a note · ${x.sections.length} ${x.sections.length === 1 ? 'section' : 'sections'}`,
  sections: x.sections.map((sec) => ({ heading: sec.heading, make: () => structuredClone(sec.doc) })),
  meter: x.meter
});
/** His live templates, shaped like the built-in ones. */
export const myTemplates = (): NoteTemplate[] => liveSavedTemplates().map(asTemplate);
export const findMyTemplate = (id: string): NoteTemplate | undefined => {
  const x = cache.find((y) => y.id === id && !y.deletedAt);
  return x ? asTemplate(x) : undefined;
};

async function store(next: SavedTemplate[]) {
  cache = next;
  await setMeta(KEY, next);
  listeners.forEach((f) => f());
}

// ---------- what a template keeps from a note ----------
const DROP = new Set(['paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'imageBlock', 'sketchBlock', 'chart', 'chartBlock', 'diagram', 'mindMap', 'codeBlock']);
const empty = (): DocNode => ({ type: 'paragraph' });

function keepBlock(n: DocNode): DocNode | null {
  if (DROP.has(n.type)) return null;
  if (n.type === 'callout') return { type: 'callout', attrs: { ...n.attrs }, content: [empty()] };
  if (n.type === 'panel') {
    const cols = (n.content ?? []).filter((c) => c.type === 'panelColumn');
    return cols.length === 2
      ? { type: 'panel', attrs: { ...n.attrs }, content: cols.map((c) => ({ type: 'panelColumn', content: keepBlocks(c.content ?? []) })) }
      : { type: 'panel', attrs: { ...n.attrs }, content: keepBlocks(n.content ?? []) };
  }
  if (n.type === 'table')
    return {
      type: 'table',
      attrs: { ...n.attrs },
      content: (n.content ?? []).map((row) => ({
        type: 'tableRow',
        content: (row.content ?? []).map((c) => ({ type: c.type, attrs: c.attrs ? { ...c.attrs } : undefined, content: c.type === 'tableHeader' ? (c.content?.length ? structuredClone(c.content) : [empty()]) : [empty()] }))
      }))
    };
  return structuredClone(n); // headings (with their looks), rules
}
/** Blocks a container or section keeps, never empty (one empty line at least). */
function keepBlocks(list: DocNode[]): DocNode[] {
  const out = list.map(keepBlock).filter((x): x is DocNode => !!x);
  if (!out.length || out[out.length - 1].type !== 'paragraph') out.push(empty());
  return out;
}
/** The template version of a section's doc. */
export const templateDoc = (d: DocNode): DocNode => ({ type: 'doc', content: keepBlocks(d.content ?? []) });

/** A name not yet used: the note's title, or "My template 1" … */
export function nextTemplateName(base: string): string {
  const used = new Set(liveSavedTemplates().map((x) => x.name.toLowerCase()));
  const b = base.trim().slice(0, 50);
  if (b && !used.has(b.toLowerCase())) return b;
  for (let i = 1; ; i++) if (!used.has(`${b || 'My template'} ${i}`.toLowerCase())) return `${b || 'My template'} ${i}`;
}

export async function saveTemplate(name: string, sections: { heading: string; doc: DocNode }[], meter: boolean): Promise<SavedTemplate> {
  const now = Date.now();
  const x: SavedTemplate = {
    id: `my:${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim().slice(0, 60) || nextTemplateName(''),
    sections: sections.slice(0, MAX_SECTIONS).map((sec) => ({ heading: sec.heading, doc: templateDoc(sec.doc) })),
    meter,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
  await store([...cache, x]);
  return x;
}

export async function renameTemplate(id: string, name: string) {
  const n = name.trim().slice(0, 60);
  if (!n) return;
  await store(cache.map((x) => (x.id === id ? { ...x, name: n, updatedAt: Date.now() } : x)));
}

export async function deleteTemplate(id: string) {
  const now = Date.now();
  await store(cache.map((x) => (x.id === id ? { ...x, deletedAt: now, updatedAt: now } : x)));
}

/** Undo of a delete: the record as it was, with a fresh updatedAt so it wins over the deleted copy. */
export async function restoreTemplate(id: string) {
  await store(cache.map((x) => (x.id === id ? { ...x, deletedAt: null, updatedAt: Date.now() } : x)));
}

/** Backup import: each template from the file that is new here or newer in the file. Returns how many were taken. */
export async function mergeTemplates(raw: unknown): Promise<number> {
  if (!Array.isArray(raw) || !raw.length) return 0;
  await loadTemplates();
  const byId = new Map(cache.map((x) => [x.id, x]));
  let n = 0;
  for (const r of raw) {
    const x = readSavedTemplate(r);
    if (!x) continue;
    const here = byId.get(x.id);
    if (!here || x.updatedAt > here.updatedAt) {
      byId.set(x.id, x);
      n++;
    }
  }
  if (n) await store([...byId.values()]);
  return n;
}
