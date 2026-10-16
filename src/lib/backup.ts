import { db, getMeta, RENAMED_SUBJECTS, SCHEMA_VERSION, setMeta, type Folder, type ImageRec, type Note, type ReviewCard, type Vocab } from '../db';
import { planFolders } from './folder-plan';
import { ymd } from './dates';
import { syncNoteCards } from './review';
import { applySettings, collectSettings, type SettingsOut } from './prefs';
import { bigChange } from './changes';
import { allStyles, mergeStyles, type SavedStyle } from './my-styles';

const APP = 'upsc-notes';
/**
 * 1 = 0.1–0.7 (notes, words, images); 2 = 0.8 (adds review cards and the streak's review days);
 * 3 = 0.9 (notes may hold sketch blocks); 4 = 0.10 (adds folders; notes and words may name their folder);
 * 5 = 0.11 (adds settings: theme, font, width, outline, streak moments, sketch tools, last subject, Drive schedule);
 * 6 = 0.12 (adds his saved heading and container styles; notes may hold containers and styled tables / headings);
 * 7 = 0.13+ (notes may hold the new charts, diagrams and mind maps).
 * An older app refuses a newer format instead of opening sections it can't show as blank pages
 * (format 3), dropping the folders (format 4), the settings (format 5) or the saved styles (format 6),
 * or importing notes whose charts, diagrams and mind maps it can only show read-only (format 7).
 */
export const FORMAT = 7;

interface ImageOut extends Omit<ImageRec, 'blob'> {
  type: string;
  data: string; // base64
}

export interface BackupFile {
  app: typeof APP;
  format: number;
  schemaVersion: number;
  exportedAt: string;
  counts: { notes: number; vocab: number; images: number; cards?: number; folders?: number };
  notes: Note[];
  vocab: Vocab[];
  images: ImageOut[];
  /** Format 2+. Absent in older backups: cards are then made from each note's quick insights. */
  cards?: ReviewCard[];
  /** Format 4+. Absent in older backups: folders are then made the way the 0.10 upgrade makes them. */
  folders?: Folder[];
  meta?: { reviewDays?: string[] };
  /** Format 5+. Each setting with the time it was chosen; absent in older backups (settings stay as they are). */
  settings?: SettingsOut;
  /** Format 6+. Saved heading and container styles, deleted ones as small records; absent in older backups. */
  styles?: SavedStyle[];
}

export interface ImportReport {
  added: number;
  updated: number;
  keptNewer: number;
  images: number;
  cards: number;
  folders: number;
  /** Settings taken from the file (newer than this device's). */
  settings: number;
  /** Saved styles taken from the file (new here, or newer in the file). */
  styles: number;
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
export async function buildBackup(): Promise<{ blob: Blob; filename: string; counts: BackupFile['counts']; exportedAt: string }> {
  const [notes, vocab, imgs, cards, folders, reviewDays] = await db.transaction('r', [db.notes, db.vocab, db.images, db.cards, db.folders, db.meta], () =>
    Promise.all([db.notes.toArray(), db.vocab.toArray(), db.images.toArray(), db.cards.toArray(), db.folders.toArray(), getMeta<string[]>('reviewDays', [])])
  );
  const images: ImageOut[] = [];
  for (const { blob, ...rest } of imgs) {
    images.push({ ...rest, type: blob.type || 'image/jpeg', data: await blobToBase64(blob) });
  }
  const counts = { notes: notes.length, vocab: vocab.length, images: images.length, cards: cards.length, folders: folders.length };
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
    folders,
    meta: { reviewDays },
    settings: collectSettings(),
    styles: allStyles()
  };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  return { blob, filename: `upsc-notes-backup-${ymd()}.json`, counts, exportedAt: file.exportedAt };
}

export async function markBackedUp() {
  await setMeta('lastBackupAt', Date.now());
}

export class BackupError extends Error {}

function validate(raw: unknown): BackupFile {
  const f = raw as Partial<BackupFile> | null;
  if (!f || typeof f !== 'object' || f.app !== APP) {
    throw new BackupError("This file isn't a UPSC Study Notes backup. Pick a file named upsc-notes-backup-….json (or ….json.txt).");
  }
  if (typeof f.format !== 'number' || f.format > FORMAT) {
    throw new BackupError('This backup was made by a newer version of the app. Update the app (reload it while online), then import again.');
  }
  if (
    !Array.isArray(f.notes) ||
    !Array.isArray(f.vocab) ||
    !Array.isArray(f.images) ||
    (f.cards !== undefined && !Array.isArray(f.cards)) ||
    (f.format >= 2 && !Array.isArray(f.cards)) ||
    (f.folders !== undefined && !Array.isArray(f.folders)) ||
    (f.format >= 4 && !Array.isArray(f.folders)) ||
    (f.settings !== undefined && (!f.settings || typeof f.settings !== 'object' || Array.isArray(f.settings))) ||
    (f.styles !== undefined && !Array.isArray(f.styles)) ||
    (f.format >= 6 && !Array.isArray(f.styles))
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
  // A folder too: one with a bad field would hide what is filed in it.
  const okFolder = (raw: unknown) => {
    const x = raw as Record<string, unknown>;
    return (
      okRecord(x) &&
      (x.kind === 'notes' || x.kind === 'words') &&
      (x.parent === null || str(x.parent)) &&
      str(x.name) &&
      (x.colour === null || str(x.colour)) &&
      num(x.order) &&
      num(x.createdAt) &&
      (x.date === undefined || str(x.date)) &&
      (x.deletedAt === null || num(x.deletedAt))
    );
  };
  const okFiled = (r: unknown) => (r as { folderId?: unknown }).folderId === undefined || str((r as { folderId?: unknown }).folderId);
  if (
    ![...f.notes, ...f.vocab, ...f.images].every(okRecord) ||
    ![...f.notes, ...f.vocab].every(okFiled) ||
    !(f.cards ?? []).every(okCard) ||
    !(f.folders ?? []).every(okFolder)
  ) {
    throw new BackupError('Some records in this backup are damaged, so nothing was imported. Try an older backup file.');
  }
  return f as BackupFile;
}

/**
 * Merge a backup into this device. Never deletes anything.
 * A record is written only when it is new here or newer in the file.
 */
export async function importBackup(file: File): Promise<ImportReport> {
  return importBackupText(await file.text());
}

/** The same import from the file's text: a file picked on the tablet, or a backup downloaded from Google Drive. */
export async function importBackupText(text: string): Promise<ImportReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError("This file couldn't be read as a backup. Pick the .json or .json.txt file the app saved.");
  }
  const data = validate(parsed);
  for (const n of data.notes) if (RENAMED_SUBJECTS[n.subject]) n.subject = RENAMED_SUBJECTS[n.subject];
  const report: ImportReport = { added: 0, updated: 0, keptNewer: 0, images: 0, cards: 0, folders: 0, settings: 0, styles: 0 };
  /** Notes written by this import: their cards are brought in step with their quick insights afterwards. */
  const written: Note[] = [];

  await db.transaction('rw', [db.notes, db.vocab, db.images, db.cards, db.folders, db.meta], async () => {
    for (const f of data.folders ?? []) {
      const here = await db.folders.get(f.id);
      if (!here || f.updatedAt > here.updatedAt) {
        await db.folders.put(f);
        report.folders++;
      }
    }
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
    // Folders the way the 0.10 upgrade makes them: a backup from before 0.10 has none, and a note or
    // word from any backup must have a live folder to show in. Fixed ids, so importing twice adds none.
    const [folders, notes, words] = await Promise.all([db.folders.toArray(), db.notes.toArray(), db.vocab.toArray()]);
    const put = planFolders(folders, notes, words, Date.now());
    if (put.length) await db.folders.bulkPut(put);
  });
  // Settings live in localStorage, outside the transaction: taken only once everything else is in.
  report.settings = applySettings(data.settings);
  // Saved styles live in meta, merged by id like notes (a damaged one is skipped, never half-made).
  report.styles = await mergeStyles(data.styles);
  if (report.added || report.updated) bigChange('import');
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

/**
 * Android share sheet with the file attached, e.g. straight to Google Drive.
 * Chrome shares only some file types (pictures, PDF, audio, video, plain text): a .json file is refused,
 * so the same backup goes out as plain text named ….json.txt. Import reads it like the .json file.
 */
function shareable(blob: Blob, filename: string): File {
  return new File([blob], filename.endsWith('.json') ? `${filename}.txt` : filename, { type: 'text/plain' });
}

export function canShareFiles(): boolean {
  try {
    return !!navigator.canShare?.({ files: [shareable(new Blob(['{}']), 'probe.json')] });
  } catch {
    return false;
  }
}

export async function shareFile(blob: Blob, filename: string): Promise<'shared' | 'cancelled'> {
  const file = shareable(blob, filename);
  try {
    await navigator.share({ files: [file], title: file.name });
    return 'shared';
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}
