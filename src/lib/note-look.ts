/**
 * Note look (0.14): a cover band, a heading style set and an accent colour, on top of the note's font
 * (note.fontStyle, unchanged since 0.10). Background and text always follow the app theme.
 *
 * A note's own look is `note.look` (unindexed, so no Dexie change). A look for a whole subject or for
 * every note is a default kept in the `meta` table under `looks`: { everywhere?, subjects: { folderId } },
 * each { look, font, updatedAt, deleted? }. The note's own look wins, then its subject's, then
 * everywhere's, then the plain default. Applying at subject or everywhere scope never rewrites notes.
 * A reset keeps a small record (deleted) so merging an older backup can't bring the default back; an
 * import takes an entry only when the file's copy is newer (updatedAt), like notes.
 */
import { getMeta, setMeta } from '../db';
import { colourKey, type HeadingLook, type HeadingStyle } from './looks';

export type Cover = 'none' | 'accent' | 'subject';
export const COVERS: { id: Cover; name: string }[] = [
  { id: 'none', name: 'No cover' },
  { id: 'subject', name: 'Subject colour' },
  { id: 'accent', name: 'Accent colour' }
];

export const HEADING_SETS = ['classic', 'underline', 'marker', 'pill', 'banner', 'tab', 'boxed', 'numbered'] as const;
export type HeadingSet = (typeof HEADING_SETS)[number];
export const HEADING_SET_INFO: Record<HeadingSet, { name: string; hint: string }> = {
  classic: { name: 'Classic', hint: 'Plain headings in the note font' },
  underline: { name: 'Underline', hint: 'A coloured rule under each heading' },
  marker: { name: 'Marker', hint: 'A highlighter stroke behind the words' },
  pill: { name: 'Pill', hint: 'Section titles in a soft pill' },
  banner: { name: 'Banner', hint: 'A tinted strip with a bold edge' },
  tab: { name: 'Tab', hint: 'A coloured tab on a rule' },
  boxed: { name: 'Boxed', hint: 'A thin box round each heading' },
  numbered: { name: 'Numbered', hint: '1, 2, 3 before each section title' }
};

export interface NoteLook {
  cover: Cover;
  headings: HeadingSet;
  /** One of the 13 colour keys (looks.ts COLOURS); null = the subject's colour. */
  accent: string | null;
}

export const LOOK_DEFAULT: NoteLook = { cover: 'none', headings: 'classic', accent: null };

const pick = <T extends string>(v: unknown, ids: readonly T[], fallback: T): T => (ids.includes(v as T) ? (v as T) : fallback);

/** A stored look, checked field by field (a bad field falls back). Not an object: no look. */
export function readLook(raw: unknown): NoteLook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return { cover: pick(r.cover, ['none', 'accent', 'subject'] as const, 'none'), headings: pick(r.headings, HEADING_SETS, 'classic'), accent: colourKey(r.accent) };
}

export const sameLook = (a: NoteLook | null, b: NoteLook | null): boolean => JSON.stringify(a) === JSON.stringify(b);

const look = (style: HeadingStyle, fill: HeadingLook['fill'] = 'soft'): HeadingLook => ({ style, color: null, fill, corner: 'round', icon: null, width: 'fit', align: 'left' });
/** What plain (look-less) headings turn into under a set: h2, then h3 and h4. classic: unchanged. */
export const SET_LOOKS: Record<HeadingSet, { h2: HeadingLook; h3: HeadingLook } | null> = {
  classic: null,
  underline: { h2: look('underline'), h3: look('plain') },
  marker: { h2: look('marker'), h3: look('plain') },
  pill: { h2: look('pill'), h3: look('underline') },
  banner: { h2: look('banner'), h3: look('underline') },
  tab: { h2: look('tab'), h3: look('marker') },
  boxed: { h2: look('boxed'), h3: look('plain') },
  numbered: { h2: look('numbered'), h3: look('plain') }
};

// ---------- defaults for a subject or every note (meta 'looks') ----------
export interface LookRec {
  look: NoteLook | null;
  /** A FONT_STYLES id; null = the app font. */
  font: string | null;
  updatedAt: number;
  deleted?: boolean;
}
export interface LooksMeta {
  everywhere?: LookRec;
  subjects: Record<string, LookRec>;
}

const KEY = 'looks';
let cache: LooksMeta = { subjects: {} };
const listeners = new Set<() => void>();

function readRec(raw: unknown): LookRec | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
  const out: LookRec = { look: readLook(r.look), font: typeof r.font === 'string' && r.font ? r.font.slice(0, 40) : null, updatedAt: r.updatedAt };
  if (r.deleted === true) out.deleted = true;
  return out;
}

/** The stored defaults, checked entry by entry (a damaged entry is dropped). */
export function readLooksMeta(raw: unknown): LooksMeta {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: LooksMeta = { subjects: {} };
  const every = readRec(r.everywhere);
  if (every) out.everywhere = every;
  const subs = r.subjects && typeof r.subjects === 'object' && !Array.isArray(r.subjects) ? (r.subjects as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(subs)) {
    const rec = readRec(v);
    if (rec && id) out.subjects[id] = rec;
  }
  return out;
}

export async function loadLooks(): Promise<LooksMeta> {
  cache = readLooksMeta(await getMeta<unknown>(KEY, null));
  listeners.forEach((f) => f());
  return cache;
}
/** Every default, reset ones included (the backup carries both). */
export const allLooks = (): LooksMeta => cache;
export const onLooksChange = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

async function store(next: LooksMeta) {
  cache = next;
  await setMeta(KEY, next);
  listeners.forEach((f) => f());
}

const live = (r: LookRec | undefined): LookRec | null => (r && !r.deleted ? r : null);

/** Set (rec) or reset (null) the default for a subject (folder id) or every note ('*'). */
export async function setLookDefault(scope: string, rec: { look: NoteLook | null; font: string | null } | null): Promise<void> {
  const now = Date.now();
  const entry: LookRec = rec ? { look: rec.look ? { ...rec.look } : null, font: rec.font, updatedAt: now } : { look: null, font: null, updatedAt: now, deleted: true };
  const next: LooksMeta = { ...cache, subjects: { ...cache.subjects } };
  if (scope === '*') next.everywhere = entry;
  else next.subjects[scope] = entry;
  await store(next);
}

/** The default a note falls back to: its subject's (folder, then main subject), then everywhere's. */
export function defaultFor(folderIds: (string | undefined)[]): { look: NoteLook | null; font: string | null; from: 'subject' | 'everywhere' | null } {
  for (const id of folderIds) {
    const r = id ? live(cache.subjects[id]) : null;
    if (r) return { look: r.look, font: r.font, from: 'subject' };
  }
  const e = live(cache.everywhere);
  return e ? { look: e.look, font: e.font, from: 'everywhere' } : { look: null, font: null, from: null };
}

/** The look and font a note shows: its own, else the defaults. */
export function resolveLook(note: { look?: unknown; fontStyle?: string }, folderIds: (string | undefined)[]): { look: NoteLook; font: string | null } {
  const own = readLook(note.look);
  const def = defaultFor(folderIds);
  return { look: own ?? def.look ?? LOOK_DEFAULT, font: note.fontStyle ?? (own ? null : def.font) };
}

/** Backup import: each default from the file that is new here or newer in the file. Returns how many were taken. */
export async function mergeLooks(raw: unknown): Promise<number> {
  if (!raw || typeof raw !== 'object') return 0;
  await loadLooks();
  const inc = readLooksMeta(raw);
  const next: LooksMeta = { ...cache, subjects: { ...cache.subjects } };
  let n = 0;
  if (inc.everywhere && (!next.everywhere || inc.everywhere.updatedAt > next.everywhere.updatedAt)) {
    next.everywhere = inc.everywhere;
    n++;
  }
  for (const [id, r] of Object.entries(inc.subjects)) {
    const here = next.subjects[id];
    if (!here || r.updatedAt > here.updatedAt) {
      next.subjects[id] = r;
      n++;
    }
  }
  if (n) await store(next);
  return n;
}
