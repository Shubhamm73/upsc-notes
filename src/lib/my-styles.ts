/**
 * "Save as my style" (0.12): heading and container looks kept for every note. They live in the `meta`
 * table under `styles` and travel in the backup (format 6). A deleted style stays as a small record
 * (deletedAt) so merging an older backup can't bring it back; an import takes a style only when the
 * file's copy is newer (updatedAt), like notes.
 *
 * "Same as last" is per device (localStorage): the look applied last, one tap away.
 */
import { getMeta, setMeta } from '../db';
import { readHeadingLook, readPanelLook, type HeadingLook, type PanelLook } from './looks';

export type StyleKind = 'heading' | 'panel';

export interface SavedStyle {
  id: string;
  kind: StyleKind;
  name: string;
  look: HeadingLook | PanelLook;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

const KEY = 'styles';
let cache: SavedStyle[] = [];
const listeners = new Set<() => void>();

/** A saved style, checked field by field (a damaged one is skipped, never shown half-made). */
export function readSavedStyle(raw: unknown): SavedStyle | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (typeof s.id !== 'string' || !s.id || (s.kind !== 'heading' && s.kind !== 'panel')) return null;
  if (typeof s.name !== 'string' || !num(s.createdAt) || !num(s.updatedAt) || !(s.deletedAt === null || num(s.deletedAt))) return null;
  if (!s.look || typeof s.look !== 'object' || Array.isArray(s.look)) return null;
  const look = s.kind === 'heading' ? readHeadingLook(s.look) : readPanelLook(s.look);
  if (!look) return null;
  return { id: s.id, kind: s.kind, name: s.name.trim().slice(0, 40) || 'My style', look, createdAt: s.createdAt as number, updatedAt: s.updatedAt as number, deletedAt: s.deletedAt as number | null };
}

export async function loadStyles(): Promise<SavedStyle[]> {
  const raw = await getMeta<unknown[]>(KEY, []);
  cache = (Array.isArray(raw) ? raw : []).map(readSavedStyle).filter((s): s is SavedStyle => !!s);
  listeners.forEach((f) => f());
  return cache;
}

/** Every saved style record, deleted ones included (the backup carries both). */
export const allStyles = (): SavedStyle[] => cache;
/** Live saved styles, oldest first (the order they were made). */
export const savedStyles = (kind?: StyleKind): SavedStyle[] => cache.filter((s) => !s.deletedAt && (!kind || s.kind === kind)).sort((a, b) => a.createdAt - b.createdAt);
export const onStylesChange = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

async function store(next: SavedStyle[]) {
  cache = next;
  await setMeta(KEY, next);
  listeners.forEach((f) => f());
}

/** A name not yet used: "My style 1", "My style 2" … */
export function nextStyleName(): string {
  const used = new Set(savedStyles().map((s) => s.name.toLowerCase()));
  for (let i = 1; ; i++) if (!used.has(`my style ${i}`)) return `My style ${i}`;
}

export async function saveStyle(kind: StyleKind, name: string, look: HeadingLook | PanelLook): Promise<SavedStyle> {
  const now = Date.now();
  const s: SavedStyle = { id: `st-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind, name: name.trim().slice(0, 40) || nextStyleName(), look: structuredClone(look), createdAt: now, updatedAt: now, deletedAt: null };
  await store([...cache, s]);
  return s;
}

export async function deleteStyle(id: string) {
  const now = Date.now();
  await store(cache.map((s) => (s.id === id ? { ...s, deletedAt: now, updatedAt: now } : s)));
}

/** Backup import: each style from the file that is new here or newer in the file. Returns how many were taken. */
export async function mergeStyles(raw: unknown): Promise<number> {
  if (!Array.isArray(raw) || !raw.length) return 0;
  await loadStyles();
  const byId = new Map(cache.map((s) => [s.id, s]));
  let n = 0;
  for (const r of raw) {
    const s = readSavedStyle(r);
    if (!s) continue;
    const here = byId.get(s.id);
    if (!here || s.updatedAt > here.updatedAt) {
      byId.set(s.id, s);
      n++;
    }
  }
  if (n) await store([...byId.values()]);
  return n;
}

// ---------- Same as last (per device) ----------
const LAST: Record<StyleKind, string> = { heading: 'upsc.lastLook.heading', panel: 'upsc.lastLook.panel' };

export function rememberLook(kind: StyleKind, look: HeadingLook | PanelLook | null) {
  if (!look) return;
  try {
    localStorage.setItem(LAST[kind], JSON.stringify(look));
  } catch {
    /* blocked storage: Same as last just stays empty */
  }
}

export function lastLook(kind: 'heading'): HeadingLook | null;
export function lastLook(kind: 'panel'): PanelLook | null;
export function lastLook(kind: StyleKind): HeadingLook | PanelLook | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST[kind]) ?? 'null');
    if (!raw) return null;
    return kind === 'heading' ? readHeadingLook(raw) : readPanelLook(raw);
  } catch {
    return null;
  }
}
