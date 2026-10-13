import { db, newId, type Folder, type Note, type Vocab } from '../db';
import { ymd } from './dates';
import {
  childrenOf,
  dateId,
  dateName,
  generalId,
  monthId,
  monthName,
  newFolder,
  noteFolderId,
  seededFolder,
  OTHERS,
  OTHERS_GENERAL,
  planFolders,
  sortFolders,
  wordFolderId
} from './folder-plan';

export { dateId, generalId, monthId, OTHERS, OTHERS_GENERAL } from './folder-plan';

/** Writes the folders that are missing (see planFolders). Runs on every launch and after a restore; normally writes nothing. */
export async function ensureFolders(): Promise<number> {
  return db.transaction('rw', db.folders, db.notes, db.vocab, async () => {
    const [folders, notes, words] = await Promise.all([db.folders.toArray(), db.notes.toArray(), db.vocab.toArray()]);
    const put = planFolders(folders, notes, words, Date.now());
    if (put.length) await db.folders.bulkPut(put);
    return put.length;
  });
}

/** A read-only view of the folders, for screens. */
export class FolderIndex {
  readonly byId: Map<string, Folder>;
  constructor(folders: Folder[]) {
    this.byId = new Map(folders.map((f) => [f.id, f]));
  }
  get(id: string | null | undefined): Folder | undefined {
    return id ? this.byId.get(id) : undefined;
  }
  /** Live top-level folders: main subjects (notes) or months (words). */
  roots(kind: Folder['kind']): Folder[] {
    return sortFolders([...this.byId.values()].filter((f) => f.kind === kind && f.parent === null && !f.deletedAt));
  }
  children(id: string): Folder[] {
    return childrenOf(this.byId, id);
  }
  /** Every live subject, grouped by main subject (for pickers). */
  subjectsByMain(): { main: Folder; subjects: Folder[] }[] {
    return this.roots('notes').map((main) => ({ main, subjects: this.children(main.id) }));
  }
  noteFolder(n: Pick<Note, 'folderId' | 'subject'>): string {
    return noteFolderId(n, this.byId);
  }
  wordFolder(w: Pick<Vocab, 'folderId' | 'createdAt'>): string {
    return wordFolderId(w, this.byId);
  }
  /** Main subject and subject of a note (either may be undefined before the folders have loaded). */
  placeOf(n: Pick<Note, 'folderId' | 'subject'>): { main?: Folder; sub?: Folder } {
    const sub = this.byId.get(this.noteFolder(n));
    return { sub, main: this.get(sub?.parent) };
  }
  /** "GS1 › History", or the old subject while the folders load. */
  label(n: Pick<Note, 'folderId' | 'subject'>): string {
    const { main, sub } = this.placeOf(n);
    return main && sub ? `${main.name} › ${sub.name}` : n.subject;
  }
  /** CSS colour of a folder: its own (main) or its main subject's. */
  colour(f: Folder | undefined): string {
    const own = f?.parent ? this.get(f.parent) : f;
    return own?.colour ? `var(--sub-${own.colour})` : 'var(--accent)';
  }
  noteColour(n: Pick<Note, 'folderId' | 'subject'>): string {
    return this.colour(this.placeOf(n).sub);
  }
  /** The folder and every folder under it. */
  subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const f of this.byId.values()) if (f.parent === out[i]) out.push(f.id);
    return out;
  }
}

// ---------- the last subject he worked in (per device): where a note made outside a folder goes ----------
const LAST = 'upsc.lastFolder';
export function lastFolder(): string {
  try {
    return localStorage.getItem(LAST) || generalId('main:GS1');
  } catch {
    return generalId('main:GS1');
  }
}
export function setLastFolder(id: string) {
  try {
    localStorage.setItem(LAST, id);
  } catch {
    /* private mode: the default is fine */
  }
}
/** A live subject for a new note: the one asked for, else the last one used, else the first there is. */
export function homeFor(index: FolderIndex, wanted?: string | null): string {
  for (const id of [wanted, lastFolder(), generalId('main:GS1')]) {
    const f = index.get(id);
    if (f && f.kind === 'notes' && f.parent && !f.deletedAt && !index.get(f.parent)?.deletedAt) return f.id;
  }
  return index.roots('notes').flatMap((m) => index.children(m.id))[0]?.id ?? OTHERS_GENERAL;
}

// ---------- changes ----------
async function nextOrder(parent: string | null, kind: Folder['kind']): Promise<number> {
  const sibs = await db.folders.where('parent').equals(parent ?? '').toArray();
  const list = parent === null ? (await db.folders.where('kind').equals(kind).toArray()).filter((f) => f.parent === null) : sibs;
  return list.reduce((m, f) => Math.max(m, f.order + 1), 0);
}

export async function addMain(name: string, colour: string): Promise<Folder> {
  const now = Date.now();
  const main = newFolder({ id: newId(), kind: 'notes', parent: null, name, colour, order: await nextOrder(null, 'notes') }, now);
  const gen = newFolder({ id: generalId(main.id), kind: 'notes', parent: main.id, name: 'General' }, now);
  await db.folders.bulkPut([main, gen]);
  return main;
}

export async function addSubject(main: string, name: string): Promise<Folder> {
  const f = newFolder({ id: newId(), kind: 'notes', parent: main, name, order: await nextOrder(main, 'notes') }, Date.now());
  await db.folders.put(f);
  return f;
}

/** The month folder (made, or brought back if deleted). */
export async function addMonth(month: string): Promise<Folder> {
  return db.transaction('rw', db.folders, async () => {
    const now = Date.now();
    const id = monthId(month);
    const here = await db.folders.get(id);
    const f = here ? { ...here, deletedAt: null, updatedAt: here.deletedAt ? now : here.updatedAt } : seededFolder({ id, kind: 'words', parent: null, name: monthName(month), date: month }, now);
    if (!here || here.deletedAt) await db.folders.put(f);
    return f;
  });
}

/** The date folder and its month (made, or brought back if deleted). */
export async function addDate(date: string): Promise<Folder> {
  return db.transaction('rw', db.folders, async () => {
    await addMonth(date.slice(0, 7));
    const now = Date.now();
    const id = dateId(date);
    const here = await db.folders.get(id);
    const f = here
      ? { ...here, deletedAt: null, updatedAt: here.deletedAt ? now : here.updatedAt }
      : seededFolder({ id, kind: 'words', parent: monthId(date.slice(0, 7)), name: dateName(date), date }, now);
    if (!here || here.deletedAt) await db.folders.put(f);
    return f;
  });
}

/** Today's date folder ("Add word to today"), made with its month when missing. */
export const todayFolder = () => addDate(ymd());

export async function renameFolder(id: string, name: string) {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) return;
  await db.folders.where('id').equals(id).modify((f) => {
    if (f.name === clean) return;
    f.name = clean;
    f.updatedAt = Date.now();
  });
}

/** Saves a new order for siblings (only the ones whose position changed are written). */
export async function reorderFolders(ids: string[]) {
  await db.transaction('rw', db.folders, async () => {
    const now = Date.now();
    const rows = await db.folders.bulkGet(ids);
    const put = rows.flatMap((f, i) => (f && f.order !== i ? [{ ...f, order: i, updatedAt: now }] : []));
    if (put.length) await db.folders.bulkPut(put);
  });
}

/** What deleting a folder would send to Trash (shown in the dialog first). */
export async function folderContents(id: string): Promise<{ subfolders: number; notes: number; words: number }> {
  const [folders, notes, words] = await Promise.all([db.folders.toArray(), db.notes.toArray(), db.vocab.toArray()]);
  const idx = new FolderIndex(folders);
  const tree = new Set(idx.subtree(id));
  return {
    subfolders: [...tree].filter((f) => f !== id && !idx.get(f)?.deletedAt).length,
    notes: notes.filter((n) => !n.deletedAt && tree.has(idx.noteFolder(n))).length,
    words: words.filter((w) => !w.deletedAt && tree.has(idx.wordFolder(w))).length
  };
}

/** Whether this folder can be deleted: never Others, never the last subject of a main subject. */
export function canDelete(idx: FolderIndex, f: Folder): boolean {
  if (f.id === OTHERS) return false;
  if (f.kind === 'notes' && f.parent) return idx.children(f.parent).length > 1;
  return true;
}

/**
 * Deletes a folder: it and its folders are marked deleted, and every note or word in them goes to
 * Trash (30 days, restorable) in the same step. Each trashed note or word keeps the folder it was in,
 * so restoring it brings that folder back. Nothing is deleted for good from here.
 */
export async function deleteFolder(id: string): Promise<{ notes: number; words: number }> {
  return db.transaction('rw', db.folders, db.notes, db.vocab, async () => {
    const [folders, notes, words] = await Promise.all([db.folders.toArray(), db.notes.toArray(), db.vocab.toArray()]);
    const idx = new FolderIndex(folders);
    const target = idx.get(id);
    if (!target || target.deletedAt || !canDelete(idx, target)) return { notes: 0, words: 0 };
    const tree = new Set(idx.subtree(id));
    const now = Date.now();
    const trashNotes = notes.filter((n) => !n.deletedAt && tree.has(idx.noteFolder(n)));
    const trashWords = words.filter((w) => !w.deletedAt && tree.has(idx.wordFolder(w)));
    await db.notes.bulkPut(trashNotes.map((n) => ({ ...n, folderId: idx.noteFolder(n), deletedAt: now, updatedAt: now })));
    await db.vocab.bulkPut(trashWords.map((w) => ({ ...w, folderId: idx.wordFolder(w), deletedAt: now, updatedAt: now })));
    await db.folders.bulkPut([...tree].flatMap((fid) => {
      const f = idx.get(fid);
      return f && !f.deletedAt ? [{ ...f, deletedAt: now, updatedAt: now }] : [];
    }));
    return { notes: trashNotes.length, words: trashWords.length };
  });
}
