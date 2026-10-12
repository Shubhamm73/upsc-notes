import { db, getMeta } from '../db';
import { collectImageIds, removeUnusedImages } from '../editor/images';
import { deleteCardsOf } from './review';

export type TrashKind = 'note' | 'word';
export const TRASH_DAYS_DEFAULT = 30;

export async function trashDays(): Promise<number> {
  return getMeta<number>('trashDays', TRASH_DAYS_DEFAULT);
}

async function setDeleted(kind: TrashKind, id: string, deletedAt: number | null) {
  const apply = (r: { deletedAt: number | null; updatedAt: number }) => {
    r.deletedAt = deletedAt;
    r.updatedAt = Date.now();
  };
  if (kind === 'note') await db.notes.where('id').equals(id).modify(apply);
  else await db.vocab.where('id').equals(id).modify(apply);
}

export const moveToTrash = (kind: TrashKind, id: string) => setDeleted(kind, id, Date.now());
export const restoreFromTrash = (kind: TrashKind, id: string) => setDeleted(kind, id, null);

/** How many stored images go with a trashed note (shown before a permanent delete). */
export async function imageCountFor(noteId: string): Promise<number> {
  const n = await db.notes.get(noteId);
  if (!n) return 0;
  const ids = new Set<string>();
  n.sections.forEach((s) => collectImageIds(s.doc, ids));
  return ids.size;
}

/** Removes an item for good, plus any images nothing else uses. Cannot be undone. */
export async function deleteForever(kind: TrashKind, id: string) {
  if (kind === 'note') {
    await db.transaction('rw', db.notes, db.cards, async () => {
      await db.notes.delete(id);
      await deleteCardsOf([id]);
    });
    await removeUnusedImages();
  } else await db.vocab.delete(id);
}

export async function emptyTrash(): Promise<number> {
  const [notes, words] = await Promise.all([
    db.notes.filter((n) => !!n.deletedAt).primaryKeys(),
    db.vocab.filter((w) => !!w.deletedAt).primaryKeys()
  ]);
  await db.transaction('rw', db.notes, db.vocab, db.cards, async () => {
    await db.notes.bulkDelete(notes);
    await db.vocab.bulkDelete(words);
    await deleteCardsOf(notes);
  });
  if (notes.length) await removeUnusedImages();
  return notes.length + words.length;
}

/** Runs on launch: items in Trash longer than the limit are deleted for good. */
export async function purgeOldTrash(): Promise<number> {
  const days = await trashDays();
  if (!days || days <= 0) return 0; // 0 = keep forever
  const cutoff = Date.now() - days * 86_400_000;
  const [notes, words] = await Promise.all([
    db.notes.filter((n) => !!n.deletedAt && n.deletedAt < cutoff).primaryKeys(),
    db.vocab.filter((w) => !!w.deletedAt && w.deletedAt < cutoff).primaryKeys()
  ]);
  if (!notes.length && !words.length) return 0;
  await db.transaction('rw', db.notes, db.vocab, db.cards, async () => {
    await db.notes.bulkDelete(notes);
    await db.vocab.bulkDelete(words);
    await deleteCardsOf(notes);
  });
  if (notes.length) await removeUnusedImages();
  return notes.length + words.length;
}
