import { db, getMeta, RENAMED_SUBJECTS, SCHEMA_VERSION, setMeta, type ImageRec, type Note, type ReviewCard, type Vocab } from '../db';
import { ymd } from './dates';
import { syncNoteCards } from './review';

const APP = 'upsc-notes';
/**
 * 1 = 0.1–0.7 (notes, words, images); 2 = 0.8 (adds review cards and the streak's review days);
 * 3 = 0.9+ (notes may hold sketch blocks). An older app refuses a newer format instead of opening
 * sections it can't show as blank pages.
 */
const FORMAT = 3;

interface ImageOut extends Omit<ImageRec, 'blob'> {
  type: string;
  data: string; // base64
}

export interface BackupFile {
  app: typeof APP;
  format: number;
  schemaVersion: number;
  exportedAt: string;
  counts: { notes: number; vocab: number; images: number; cards?: number };
  notes: Note[];
  vocab: Vocab[];
  images: ImageOut[];
  /** Format 2+. Absent in older backups: cards are then made from each note's quick insights. */
  cards?: ReviewCard[];
  meta?: { reviewDays?: string[] };
}

export interface ImportReport {
  added: number;
  updated: number;
  keptNewer: number;
  images: number;
  cards: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Everything on this device, trash included, as one JSON file. */
export async function buildBackup(): Promise<{ blob: Blob; filename: string; counts: BackupFile['counts'] }> {
  const [notes, vocab, imgs, cards, reviewDays] = await db.transaction('r', db.notes, db.vocab, db.images, db.cards, db.meta, () =>
    Promise.all([db.notes.toArray(), db.vocab.toArray(), db.images.toArray(), db.cards.toArray(), getMeta<string[]>('reviewDays', [])])
  );
  const images: ImageOut[] = [];
  for (const { blob, ...rest } of imgs) {
    images.push({ ...rest, type: blob.type || 'image/jpeg', data: await blobToBase64(blob) });
  }
  const counts = { notes: notes.length, vocab: vocab.length, images: images.length, cards: cards.length };
  const file: BackupFile = {
    app: APP,
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts,
    notes,
    vocab,
    images,
    cards,
    meta: { reviewDays }
  };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  return { blob, filename: `upsc-notes-backup-${ymd()}.json`, counts };
}

export async function markBackedUp() {
  await setMeta('lastBackupAt', Date.now());
}

export class BackupError extends Error {}

function validate(raw: unknown): BackupFile {
  const f = raw as Partial<BackupFile> | null;
  if (!f || typeof f !== 'object' || f.app !== APP) {
    throw new BackupError("This file isn't a UPSC Study Notes backup. Pick a file named upsc-notes-backup-….json.");
  }
  if (typeof f.format !== 'number' || f.format > FORMAT) {
    throw new BackupError('This backup was made by a newer version of the app. Update the app (reload it while online), then import again.');
  }
  if (
    !Array.isArray(f.notes) ||
    !Array.isArray(f.vocab) ||
    !Array.isArray(f.images) ||
    (f.cards !== undefined && !Array.isArray(f.cards)) ||
    (f.format >= 2 && !Array.isArray(f.cards))
  ) {
    throw new BackupError('This backup file is incomplete or damaged. Try an older backup file.');
  }
  const okRecord = (r: unknown) =>
    !!r && typeof (r as { id?: unknown }).id === 'string' && typeof (r as { updatedAt?: unknown }).updatedAt === 'number';
  // A card is checked field by field: one with a missing field would stop the review session.
  const str = (v: unknown) => typeof v === 'string';
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const okCard = (raw: unknown) => {
    const c = raw as Record<string, unknown>;
    return (
      okRecord(c) &&
      c.kind === 'insight' &&
      ['noteId', 'key', 'text', 'section', 'before', 'after'].every((k) => str(c[k])) &&
      ['step', 'pos', 'reps', 'lapses', 'createdAt'].every((k) => num(c[k])) &&
      str(c.due) &&
      /^\d{4}-\d{2}-\d{2}$/.test(c.due as string) &&
      (c.retiredAt === null || num(c.retiredAt)) &&
      (c.lastReviewed === null || num(c.lastReviewed))
    );
  };
  if (![...f.notes, ...f.vocab, ...f.images].every(okRecord) || !(f.cards ?? []).every(okCard)) {
    throw new BackupError('Some records in this backup are damaged, so nothing was imported. Try an older backup file.');
  }
  return f as BackupFile;
}

/**
 * Merge a backup into this device. Never deletes anything.
 * A record is written only when it is new here or newer in the file.
 */
export async function importBackup(file: File): Promise<ImportReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new BackupError("This file couldn't be read as a backup. Pick the .json file the app saved.");
  }
  const data = validate(parsed);
  for (const n of data.notes) if (RENAMED_SUBJECTS[n.subject]) n.subject = RENAMED_SUBJECTS[n.subject];
  const report: ImportReport = { added: 0, updated: 0, keptNewer: 0, images: 0, cards: 0 };
  /** Notes written by this import: their cards are brought in step with their quick insights afterwards. */
  const written: Note[] = [];

  await db.transaction('rw', [db.notes, db.vocab, db.images, db.cards, db.meta], async () => {
    for (const [table, rows] of [
      [db.notes, data.notes],
      [db.vocab, data.vocab]
    ] as const) {
      for (const row of rows as (Note | Vocab)[]) {
        const here = await (table as typeof db.notes).get(row.id);
        if (!here || row.updatedAt > here.updatedAt) {
          await (table as typeof db.notes).put(row as Note);
          if (here) report.updated++;
          else report.added++;
          if (table === db.notes) written.push(row as Note);
        } else {
          report.keptNewer++;
        }
      }
    }
    for (const { data: b64, type, ...rest } of data.images) {
      const here = await db.images.get(rest.id);
      if (!here || rest.updatedAt > here.updatedAt) {
        await db.images.put({ ...rest, blob: base64ToBlob(b64, type) });
        report.images++;
      }
    }
    for (const c of data.cards ?? []) {
      const here = await db.cards.get(c.id);
      if (!here || c.updatedAt > here.updatedAt) {
        await db.cards.put(c);
        report.cards++;
      }
    }
    // The streak: every review day from either side.
    const days = data.meta?.reviewDays;
    if (Array.isArray(days) && days.length) {
      const here = await getMeta<string[]>('reviewDays', []);
      const all = [...new Set([...here, ...days.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))])].sort().slice(-400);
      if (all.length !== here.length || all.some((d, i) => d !== here[i])) await setMeta('reviewDays', all);
    }
    // Backups from before 0.8 carry no cards: make them from each imported note's quick insights,
    // on the note's own schedule. A line that already has a card keeps it, so importing twice adds nothing.
    for (const n of written) report.cards += (await syncNoteCards(n, { seed: true })).created;
  });
  return report;
}

/** Saves a file to the device's Downloads folder (normal browser download). */
export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Android share sheet with the file attached, e.g. straight to Google Drive. */
export function canShareFiles(): boolean {
  try {
    const probe = new File(['{}'], 'probe.json', { type: 'application/json' });
    return !!navigator.canShare?.({ files: [probe] });
  } catch {
    return false;
  }
}

export async function shareFile(blob: Blob, filename: string): Promise<'shared' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type || 'application/json' });
  try {
    await navigator.share({ files: [file], title: filename });
    return 'shared';
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}
