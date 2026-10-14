/**
 * Google Drive backup (0.11): the schedule, a backup run, keeping the last 10, and restore.
 *
 * A web app can't run while it's closed, so a due backup is made the next time the app is open and
 * online, and never while a note, a word or a review is open (building a backup reads every picture).
 * The Google token lasts about an hour: when it has run out, his next tap outside a note renews it
 * (Google's window flashes and closes by itself); with the full-page sign-in it is renewed at launch.
 */
import { buildBackup, importBackupText, markBackedUp, type ImportReport } from './backup';
import { BIG_CHANGE } from './changes';
import { DriveError, folderInfo, gisReady, hasToken, listBackups, loadGis, ourFolder, trashFile, upload, download, type DriveFile, signInPopup, signInRedirect } from './drive';
import { FOLDER_NAME, KEEP_BACKUPS } from './drive-config';
import { writeSetting } from './prefs';

export const DAY = 86_400_000;
const HOUR = 3_600_000;
const RETRY = 15 * 60_000;

/** Chosen by him; travels in the backup (format 5 settings) so a restored tablet backs up the same way. */
export interface DriveCfg {
  every: 1 | 2 | 7;
  onChange: boolean;
  folderId: string | null;
  folderName: string | null;
  /** The folder the app made ("UPSC Notes backups"), not one he picked. */
  folderMine: boolean;
}
/** This device only. */
export interface DriveState {
  on: boolean;
  email?: string;
  name?: string;
  since?: number;
  lastAt?: number;
  last?: { notes: number; words: number; images: number; bytes: number };
  /** Backups in the folder after the last run. */
  kept?: number;
  lastTryAt?: number;
  /** Why the last try failed, in words for him; null when it worked. */
  error?: string | null;
  /** A sign-in is needed before the next backup (silent renewal failed or access was taken back). */
  needsSignIn?: boolean;
  dirtyAt?: number;
  /** 'redirect' once the popup could not open on this device. */
  signin?: 'popup' | 'redirect';
}

const CFG_KEY = 'upsc.drive';
const STATE_KEY = 'upsc.driveState';
export const DRIVE_EVENT = 'upsc:drive';
export const DEFAULT_CFG: DriveCfg = { every: 2, onChange: true, folderId: null, folderName: null, folderMine: true };

export function getCfg(): DriveCfg {
  try {
    const v = JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null') as Partial<DriveCfg> | null;
    return {
      every: v?.every === 1 || v?.every === 7 ? v.every : 2,
      onChange: v?.onChange !== false,
      folderId: typeof v?.folderId === 'string' ? v.folderId : null,
      folderName: typeof v?.folderName === 'string' ? v.folderName : null,
      folderMine: v?.folderMine !== false
    };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

export function saveCfg(patch: Partial<DriveCfg>) {
  writeSetting(CFG_KEY, JSON.stringify({ ...getCfg(), ...patch }));
  window.dispatchEvent(new Event(DRIVE_EVENT));
}

export function getState(): DriveState {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
    return v && typeof v === 'object' ? (v as DriveState) : { on: false };
  } catch {
    return { on: false };
  }
}

export function saveState(patch: Partial<DriveState>) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...getState(), ...patch }));
  } catch {
    /* blocked storage */
  }
  window.dispatchEvent(new Event(DRIVE_EVENT));
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** When the next scheduled backup is due: the start of the day `every` days after the last one. */
export function nextDue(cfg = getCfg(), st = getState()): number | null {
  if (!st.on) return null;
  const last = st.lastAt;
  if (!last) return st.since ?? 0;
  const d = new Date(startOfDay(last));
  d.setDate(d.getDate() + cfg.every);
  return d.getTime();
}

/** True when a backup should be made now: on schedule, or after a big change (at most one an hour). */
export function isDue(now = Date.now(), cfg = getCfg(), st = getState()): boolean {
  if (!st.on) return false;
  const due = nextDue(cfg, st);
  if (due !== null && now >= due) return true;
  const last = st.lastAt ?? 0;
  return cfg.onChange && !!st.dirtyAt && st.dirtyAt > last && now - last >= HOUR && now - st.dirtyAt >= 60_000;
}

/** Days since the last Drive backup when it is more than twice the schedule behind, else null (More's warning). */
export function missedDays(now = Date.now(), cfg = getCfg(), st = getState()): number | null {
  if (!st.on) return null;
  const from = st.lastAt ?? st.since;
  if (!from || now - from <= 2 * cfg.every * DAY) return null;
  return Math.floor((now - from) / DAY);
}

/** Never while he is writing or reviewing. */
export function busyScreen(): boolean {
  return /^#\/(n|v|review)(\/|$)/.test(location.hash);
}

function device(): string {
  const ua = navigator.userAgent;
  const m = /;\s*(SM-[A-Z0-9]+)/.exec(ua)?.[1] ?? '';
  if (/^SM-X70/.test(m)) return 'Galaxy Tab S8';
  if (/^SM-X80/.test(m)) return 'Galaxy Tab S8+';
  if (/^SM-X90/.test(m)) return 'Galaxy Tab S8 Ultra';
  if (m) return m;
  return /Android/.test(ua) ? 'Android tablet' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Browser';
}

const pad = (n: number) => String(n).padStart(2, '0');
function fileName(d = new Date()) {
  return `upsc-notes-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** Words for him about a failed try. */
export function errorText(e: unknown): string {
  if (e instanceof DriveError) {
    if (e.kind === 'offline') return 'No internet. It will try again when the tablet is online.';
    if (e.kind === 'auth') return 'Google sign-in ran out. Tap Back up now, or it renews on your next tap.';
    return `${e.message} It will try again later.`;
  }
  return "The backup couldn't be made. It will try again later.";
}

/** The folder to write to: his choice if it's still there, else "UPSC Notes backups" (found or made). */
async function ensureFolder(): Promise<string> {
  const cfg = getCfg();
  if (cfg.folderId) {
    const f = await folderInfo(cfg.folderId);
    if (f) {
      if (f.name !== cfg.folderName) saveCfg({ folderName: f.name });
      return f.id;
    }
  }
  const f = await ourFolder();
  saveCfg({ folderId: f.id, folderName: f.name || FOLDER_NAME, folderMine: true });
  return f.id;
}

const holds = (f: DriveFile) => (Number(f.appProperties?.notes) || 0) + (Number(f.appProperties?.words) || 0);

/**
 * Keeps the newest 10 backups in the folder; older ones go to Drive's trash. One guard: the largest older
 * backup is kept too while it holds more notes and words than every one of the newest 10, so a wiped or
 * nearly empty tablet backing up on schedule can never rotate his real backups out.
 * Returns how many backups the folder holds now.
 */
export async function rotate(folderId: string, made: DriveFile): Promise<number> {
  const list = await listBackups(folderId);
  if (!list.some((f) => f.id === made.id)) list.unshift(made);
  const keep = list.slice(0, KEEP_BACKUPS);
  const rest = list.slice(KEEP_BACKUPS);
  if (!rest.length) return list.length;
  const top = Math.max(...keep.map(holds));
  const biggest = rest.reduce((a, b) => (holds(b) > holds(a) ? b : a));
  const spare = holds(biggest) > top ? biggest.id : null;
  for (const f of rest) if (f.id !== spare) await trashFile(f.id);
  return keep.length + (spare ? 1 : 0);
}

let running: Promise<'done' | 'empty'> | null = null;

/**
 * One backup to Drive (needs a token). `auto` backups skip an app with nothing in it.
 * Errors are recorded in the state (shown in Backup & storage) and thrown.
 */
export function backupToDrive(opts: { auto: boolean }): Promise<'done' | 'empty'> {
  running ??= (async () => {
    try {
      const { blob, counts } = await buildBackup();
      if (opts.auto && counts.notes + counts.vocab === 0) return 'empty' as const;
      const folder = await ensureFolder();
      const made = await upload(blob, fileName(), folder, {
        app: 'upsc-notes',
        format: '5',
        notes: String(counts.notes),
        words: String(counts.vocab),
        images: String(counts.images),
        device: device()
      });
      const kept = await rotate(folder, made).catch(() => undefined); // the backup is safe even if tidying fails
      await markBackedUp();
      saveState({
        lastAt: Date.now(),
        lastTryAt: Date.now(),
        error: null,
        needsSignIn: false,
        kept: kept ?? getState().kept,
        last: { notes: counts.notes, words: counts.vocab, images: counts.images, bytes: blob.size }
      });
      return 'done' as const;
    } catch (e) {
      saveState({ lastTryAt: Date.now(), error: errorText(e) });
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function backupRunning(): boolean {
  return !!running;
}

/** A backup in Drive, read like a file and merged the same way: newer copy of each record wins, nothing deleted. */
export async function restoreFromDrive(file: DriveFile): Promise<ImportReport> {
  const report = await importBackupText(await download(file.id));
  const st = getState();
  if (!st.on) {
    // Drive backup turns on for this device too, to the same folder (schedule from the restored settings).
    const parent = file.parents?.[0] ?? null;
    let name: string | null = null;
    if (parent) name = (await folderInfo(parent).catch(() => null))?.name ?? null;
    if (parent && name) saveCfg({ folderId: parent, folderName: name, folderMine: name === FOLDER_NAME });
    saveState({ on: true, since: Date.now(), error: null, needsSignIn: false });
  }
  return report;
}

// ---------- the schedule while the app is open ----------
let armed = false;
let renewedThisLaunch = false;
const launchedAt = Date.now();

/** Starts the checks: at launch, when the app comes back, goes online, changes screen, every 10 minutes. */
export function startDriveSchedule() {
  const check = () => void tick();
  window.addEventListener(BIG_CHANGE, () => {
    if (!getState().on) return;
    saveState({ dirtyAt: Date.now() });
    setTimeout(check, 61_000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('online', check);
  window.addEventListener('hashchange', check);
  setInterval(check, 10 * 60_000);
  check();
}

async function tick() {
  const st = getState();
  if (!st.on || running || !navigator.onLine || !isDue(Date.now(), getCfg(), st)) return;
  if (st.error && st.lastTryAt && Date.now() - st.lastTryAt < RETRY) return;
  if (busyScreen()) return;
  if (hasToken()) {
    await backupToDrive({ auto: true }).catch(() => undefined);
    return;
  }
  if (st.needsSignIn) return; // he signs in from Backup & storage (Back up now); no popup on every tap
  if (st.signin === 'redirect') {
    // Full-page sign-in: renewed once, right at launch, when nothing is open.
    if (!renewedThisLaunch && Date.now() - launchedAt < 30_000) {
      renewedThisLaunch = true;
      signInRedirect({ silent: true, hint: st.email, then: 'backup' });
    }
    return;
  }
  armTap();
}

/** The token has run out: his next tap outside a note asks Google for a new one, then backs up. */
function armTap() {
  if (armed) return;
  armed = true;
  void loadGis().catch(() => undefined);
  const onTap = (e: Event) => {
    // (not inside a note or a dialog; and only once Google's script is in, so the popup opens within this tap)
    if (busyScreen() || (e.target as HTMLElement | null)?.closest?.('.sheet-scrim') || !gisReady()) return;
    document.removeEventListener('click', onTap, true);
    armed = false;
    const st = getState();
    if (!st.on || hasToken()) return void tick();
    void signInPopup({ silent: true, hint: st.email }).then(async (r) => {
      if (r === 'ok') await backupToDrive({ auto: true }).catch(() => undefined);
      else if (r === 'popup-failed') saveState({ signin: 'redirect', lastTryAt: Date.now(), error: 'Google’s sign-in window could not open. It will sign in on a full page next time the app opens.' });
      else if (r !== 'offline') saveState({ needsSignIn: true, lastTryAt: Date.now(), error: 'Google needs you to sign in again. Tap Back up now.' });
    });
  };
  document.addEventListener('click', onTap, true);
}
