import { db, RENAMED_SUBJECTS, SCHEMA_VERSION, setMeta, type ImageRec, type Note, type Vocab } from '../db';
import { ymd } from './dates';

const APP = 'upsc-notes';
const FORMAT = 1;

interface ImageOut extends Omit<ImageRec, 'blob'> {
  type: string;
  data: string; // base64
}

export interface BackupFile {
  app: typeof APP;
  format: number;
  schemaVersion: number;
  exportedAt: string;
  counts: { notes: number; vocab: number; images: number };
  notes: Note[];
  vocab: Vocab[];
  images: ImageOut[];
}

export interface ImportReport {
  added: number;
  updated: number;
  keptNewer: number;
  images: number;
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
  const [notes, vocab, imgs] = await db.transaction('r', db.notes, db.vocab, db.images, () =>
    Promise.all([db.notes.toArray(), db.vocab.toArray(), db.images.toArray()])
  );
  const images: ImageOut[] = [];
  for (const { blob, ...rest } of imgs) {
    images.push({ ...rest, type: blob.type || 'image/jpeg', data: await blobToBase64(blob) });
  }
  const counts = { notes: notes.length, vocab: vocab.length, images: images.length };
  const file: BackupFile = {
    app: APP,
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts,
    notes,
    vocab,
    images
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
  if (!Array.isArray(f.notes) || !Array.isArray(f.vocab) || !Array.isArray(f.images)) {
    throw new BackupError('This backup file is incomplete or damaged. Try an older backup file.');
  }
  const okRecord = (r: unknown) =>
    !!r && typeof (r as { id?: unknown }).id === 'string' && typeof (r as { updatedAt?: unknown }).updatedAt === 'number';
  if (![...f.notes, ...f.vocab, ...f.images].every(okRecord)) {
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
  const report: ImportReport = { added: 0, updated: 0, keptNewer: 0, images: 0 };

  await db.transaction('rw', db.notes, db.vocab, db.images, async () => {
    for (const [table, rows] of [
      [db.notes, data.notes],
      [db.vocab, data.vocab]
    ] as const) {
      for (const row of rows as (Note | Vocab)[]) {
        const here = await (table as typeof db.notes).get(row.id);
        if (!here) {
          await (table as typeof db.notes).put(row as Note);
          report.added++;
        } else if (row.updatedAt > here.updatedAt) {
          await (table as typeof db.notes).put(row as Note);
          report.updated++;
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
