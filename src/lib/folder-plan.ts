import type { Folder, Note, Vocab } from '../db';
import { ymd } from './dates';

/**
 * Folders (0.10). Pure: used by the Dexie v4 upgrade, by every launch and by backup import, so the
 * three always build the same folders.
 *
 * Notes: main subject (parent null) → subject → notes. Words: month (parent null) → date → words.
 * The folders the app makes itself have fixed ids, so an upgraded tablet, a fresh one that imports a
 * backup, and a second device all make the *same* records and a merge never doubles them:
 *   main:GS1 / gen:GS1 (its General) … main:Others / gen:Others; months wm:2026-10, dates wd:2026-10-13.
 * Folders he adds get random ids (a date he adds is still wd:<date>: one folder per date).
 *
 * A note or word never needs a folder id to be visible: an old note (no folderId) shows under its
 * subject's General, an old word under the day it was added. Nothing here ever rewrites a note or word.
 */

/** The main subjects every tablet starts with (the 8 subjects of 0.1–0.9, plus Others), with their colour keys. */
export const SEEDED_MAINS: { key: string; colour: string }[] = [
  { key: 'GS1', colour: 'gs1' },
  { key: 'GS2', colour: 'gs2' },
  { key: 'GS3', colour: 'gs3' },
  { key: 'GS4', colour: 'gs4' },
  { key: 'Essay', colour: 'essay' },
  { key: 'Interview', colour: 'interview' },
  { key: 'Current affairs', colour: 'ca' },
  { key: 'PSIR', colour: 'psir' },
  { key: 'Others', colour: 'other' }
];

/** Colours a main subject can have (CSS var --sub-<key>). Subjects use their main subject's colour. */
export const FOLDER_COLOURS = ['gs1', 'gs2', 'gs3', 'gs4', 'interview', 'ca', 'psir', 'essay', 'blue', 'violet', 'cyan', 'olive', 'other'];

export const OTHERS = 'main:Others';
export const OTHERS_GENERAL = 'gen:Others';

/** Old subject names, moved over on upgrade and import (CSAT became Interview in 0.5). Mirrors RENAMED_SUBJECTS in db.ts. */
const RENAMED: Record<string, string> = { CSAT: 'Interview' };

export const mainId = (key: string) => `main:${key}`;
/** The General subject of a main subject: gen:GS1 for a seeded one, gen:<id> for one he added. */
export const generalId = (main: string) => (main.startsWith('main:') ? `gen:${main.slice(5)}` : `gen:${main}`);
export const monthId = (month: string) => `wm:${month}`;
export const dateId = (date: string) => `wd:${date}`;

/** The subject key a note gets when it is filed under this main subject (GS1 for main:GS1, else the name). */
export const subjectKeyOf = (main: Folder) => (main.id.startsWith('main:') ? main.id.slice(5) : main.name);

export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** "Tue 13 Oct" (built from parts: browsers differ on the comma after the weekday). */
export function dateName(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return `${t.toLocaleDateString('en-GB', { weekday: 'short' })} ${d} ${t.toLocaleDateString('en-GB', { month: 'short' })}`;
}

export function newFolder(f: Pick<Folder, 'id' | 'kind' | 'parent' | 'name'> & Partial<Folder>, now: number): Folder {
  return { colour: null, order: 0, createdAt: now, updatedAt: now, deletedAt: null, ...f };
}

/**
 * A folder the app makes with a fixed id (main:GS1, gen:GS1, wm:…, wd:…) starts with updatedAt 0:
 * every tablet makes the same one, so it must never win a merge against one he renamed, recoloured,
 * moved or deleted on another tablet (a fresh tablet that imports his backup takes his version).
 */
export function seededFolder(f: Pick<Folder, 'id' | 'kind' | 'parent' | 'name'> & Partial<Folder>, now: number): Folder {
  return newFolder({ ...f, updatedAt: 0 }, now);
}

type ById = Map<string, Folder>;

const isNoteSubject = (f: Folder | undefined, byId: ById): f is Folder =>
  !!f && f.kind === 'notes' && f.parent !== null && byId.get(f.parent)?.parent === null && byId.get(f.parent)?.kind === 'notes';

const isWordDate = (f: Folder | undefined, byId: ById): f is Folder =>
  !!f && f.kind === 'words' && f.parent !== null && byId.get(f.parent)?.parent === null && byId.get(f.parent)?.kind === 'words';

/** Live children of a folder, in their order (notes: his order; words: newest first). */
export function childrenOf(byId: ById, parent: string, liveOnly = true): Folder[] {
  const list = [...byId.values()].filter((f) => f.parent === parent && (!liveOnly || !f.deletedAt));
  return sortFolders(list);
}

export function sortFolders(list: Folder[]): Folder[] {
  return list.sort((a, b) =>
    a.kind === 'words' ? (b.date ?? '').localeCompare(a.date ?? '') || a.name.localeCompare(b.name) : a.order - b.order || a.createdAt - b.createdAt || a.name.localeCompare(b.name)
  );
}

/**
 * The subject folder a note shows under. Its own folder when that is a real subject folder (even a
 * deleted one: the folder comes back with the note, see planFolders); otherwise its old subject's
 * General, or the first subject of that main subject; otherwise Others › General.
 */
export function noteFolderId(n: Pick<Note, 'folderId' | 'subject'>, byId: ById): string {
  if (n.folderId && isNoteSubject(byId.get(n.folderId), byId)) return n.folderId;
  const key = RENAMED[n.subject] ?? n.subject;
  const gen = byId.get(generalId(mainId(key)));
  if (isNoteSubject(gen, byId) && !gen.deletedAt) return gen.id;
  if (byId.has(mainId(key))) {
    const first = childrenOf(byId, mainId(key))[0];
    if (first) return first.id;
    if (isNoteSubject(gen, byId)) return gen.id;
  }
  return OTHERS_GENERAL;
}

/** The date folder a word shows under: its own, or the day it was added. */
export function wordFolderId(w: Pick<Vocab, 'folderId' | 'createdAt'>, byId: ById): string {
  if (w.folderId && isWordDate(byId.get(w.folderId), byId)) return w.folderId;
  return dateId(ymd(new Date(w.createdAt)));
}

/**
 * Folder records to write so that everything is in place: the seeded main subjects (each with its
 * General) exist once, every main subject has at least one subject, and every note and word that is
 * not in Trash has a live folder to show in (a deleted folder comes back; a missing date is made).
 * A folder he deleted stays deleted unless something live is filed in it.
 */
export function planFolders(folders: Folder[], notes: Note[], words: Vocab[], now: number): Folder[] {
  const byId: ById = new Map(folders.map((f) => [f.id, f]));
  const changed = new Map<string, Folder>();
  const put = (f: Folder) => {
    byId.set(f.id, f);
    changed.set(f.id, f);
  };
  const revive = (id: string) => {
    const f = byId.get(id);
    if (f?.deletedAt) put({ ...f, deletedAt: null, updatedAt: now });
  };

  SEEDED_MAINS.forEach(({ key, colour }, i) => {
    const id = mainId(key);
    if (byId.has(id)) return;
    put(seededFolder({ id, kind: 'notes', parent: null, name: key, colour, order: i }, now));
    if (!byId.has(generalId(id))) put(seededFolder({ id: generalId(id), kind: 'notes', parent: id, name: 'General' }, now));
  });
  // Others is where anything without a home goes, so it is always there.
  revive(OTHERS);

  for (const n of notes) {
    if (n.deletedAt) continue;
    const id = noteFolderId(n, byId);
    if (!byId.has(id)) put(seededFolder({ id, kind: 'notes', parent: OTHERS, name: 'General' }, now));
    revive(id);
    revive(byId.get(id)!.parent!);
  }

  // Every live main subject keeps at least one subject.
  for (const m of [...byId.values()]) {
    if (m.kind !== 'notes' || m.parent !== null || m.deletedAt) continue;
    if (childrenOf(byId, m.id).length) continue;
    const gid = generalId(m.id);
    const g = byId.get(gid);
    if (g && g.parent === m.id) revive(gid);
    else if (!g) put(seededFolder({ id: gid, kind: 'notes', parent: m.id, name: 'General' }, now));
    else {
      // the id is taken by something else (never made by the app): add a plain General
      put(newFolder({ id: `${gid}:${now}`, kind: 'notes', parent: m.id, name: 'General' }, now));
    }
  }

  for (const w of words) {
    if (w.deletedAt) continue;
    const id = wordFolderId(w, byId);
    if (!byId.has(id)) {
      const date = id.slice(3);
      const month = date.slice(0, 7);
      if (!byId.has(monthId(month))) put(seededFolder({ id: monthId(month), kind: 'words', parent: null, name: monthName(month), date: month }, now));
      put(seededFolder({ id, kind: 'words', parent: monthId(month), name: dateName(date), date }, now));
    }
    revive(id);
    revive(byId.get(id)!.parent!);
  }
  return [...changed.values()];
}
