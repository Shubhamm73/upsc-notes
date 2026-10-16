/**
 * Google Drive backup screens (0.11): Connect (sign in → folder → schedule → first backup), Back up now,
 * Change schedule, Restore (a list of his backups → merge), Disconnect. Shown in Backup & storage; Today
 * offers Restore when the app is empty; the app shell finishes a full-page sign-in that just came back.
 */
import { db } from '../db';
import { account, abandonSignIn, gisReady, hasToken, listBackups, loadGis, pickFolder, revokeAccess, signInPopup, signInRedirect, type DriveFile, type SignIn } from '../lib/drive';
import { FOLDER_NAME, KEEP_BACKUPS } from '../lib/drive-config';
import {
  backupRunning,
  backupToDrive,
  DRIVE_EVENT,
  errorText,
  getCfg,
  getState,
  nextDue,
  restoreFromDrive,
  saveCfg,
  saveState,
  type DriveCfg
} from '../lib/drive-backup';
import { closeSheet, openSheet } from '../lib/sheet';
import { h } from '../lib/h';
import { BackupError, type ImportReport } from '../lib/backup';
import type { AppContext } from '../app';

const EVERY: { v: DriveCfg['every']; label: string }[] = [
  { v: 1, label: 'Every day' },
  { v: 2, label: 'Every 2 days' },
  { v: 7, label: 'Every week' }
];
const everyText = (v: number) => EVERY.find((e) => e.v === v)?.label ?? 'Every 2 days';

const pad = (n: number) => String(n).padStart(2, '0');
function when(t: number): string {
  const d = new Date(t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  if (d.toDateString() === yest.toDateString()) return `yesterday at ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}
const dayText = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const num = (n: number) => n.toLocaleString('en-IN');
const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

export function reportText(r: ImportReport): string {
  return `Imported: ${r.added} added, ${r.updated} updated, ${r.keptNewer} already newer here, ${r.images} images, ${r.cards} review cards, ${r.folders} folders${r.settings ? `, ${r.settings} settings` : ''}${r.styles ? `, ${r.styles} saved ${r.styles === 1 ? 'style' : 'styles'}` : ''}${r.templates ? `, ${r.templates} ${r.templates === 1 ? 'template' : 'templates'}` : ''}.`;
}

// ---------- sign-in ----------
/**
 * Runs `after` with a Google token: at once if there is one, else after Google's popup (inside this tap),
 * or by leaving for the full-page sign-in (`then` says what to finish when the app opens again).
 */
async function withSignIn(ctx: AppContext, then: string, after: () => unknown): Promise<void> {
  if (!navigator.onLine) return void ctx.toast('Needs internet. Try again when the tablet is online.');
  if (hasToken()) return void (await after());
  const st = getState();
  if (st.signin === 'redirect') return fullPage(ctx, then);
  // Google's popup must open inside the tap: if its script isn't loaded yet, load it, then one more tap.
  if (!gisReady()) {
    const go = h('button', { type: 'button', class: 'primary', id: 'drive-continue', disabled: true }, 'Continue');
    go.addEventListener('click', () => {
      closeSheet();
      void withSignIn(ctx, then, after);
    });
    openSheet({ title: 'Getting Google’s sign-in ready…', id: 'drive-loading', body: [h('p', {}, 'One moment.'), go], actions: [{ label: 'Cancel' }] });
    loadGis().then(
      () => {
        go.disabled = false;
        go.focus();
      },
      () => {
        if (document.getElementById('drive-loading')) closeSheet();
        ctx.toast("Google couldn't be reached. Check the internet and try again.");
      }
    );
    return;
  }
  const fullBtn = h('button', { type: 'button', id: 'drive-fullpage' }, 'Sign in on a full page instead');
  fullBtn.addEventListener('click', () => {
    closeSheet();
    abandonSignIn();
    saveState({ signin: 'redirect' });
    void fullPage(ctx, then);
  });
  openSheet({
    title: 'Signing in with Google…',
    id: 'drive-wait',
    body: [h('p', {}, 'Google’s window is open: choose your account and allow Drive. Nothing else in your Drive is shared with the app.'), fullBtn],
    actions: [{ label: 'Cancel', id: 'drive-wait-cancel', run: () => abandonSignIn() }]
  });
  const r: SignIn = await signInPopup({ silent: !!st.email, hint: st.email });
  if (document.getElementById('drive-wait')) closeSheet();
  if (r === 'ok') {
    saveState({ needsSignIn: false, error: null });
    return void (await after());
  }
  if (r === 'popup-failed') {
    saveState({ signin: 'redirect' });
    openSheet({
      title: 'Google’s window didn’t open',
      id: 'drive-popup-failed',
      body: [h('p', {}, 'The sign-in can open on a full page instead. The app saves everything first and comes back here.')],
      actions: [{ label: 'Cancel' }, { label: 'Sign in on a full page', primary: true, id: 'drive-fullpage-go', run: () => void fullPage(ctx, then) }]
    });
  } else if (r === 'offline') ctx.toast("Google couldn't be reached. Check the internet and try again.");
  else if (r === 'denied') ctx.toast('Google Drive wasn’t allowed, so nothing was connected. Allow Drive to use Drive backup.');
  else ctx.toast('Sign-in cancelled.');
}

async function fullPage(ctx: AppContext, then: string) {
  await ctx.flush();
  signInRedirect({ silent: false, hint: getState().email, then });
}

async function rememberAccount(ctx: AppContext): Promise<boolean> {
  try {
    const a = await account();
    saveState({ email: a.email, name: a.name });
    return true;
  } catch (e) {
    ctx.toast(errorText(e));
    return false;
  }
}

// ---------- connect ----------
export function connectDrive(ctx: AppContext) {
  void withSignIn(ctx, 'connect', () => afterConnect(ctx));
}

async function afterConnect(ctx: AppContext) {
  if (!(await rememberAccount(ctx))) return;
  // An empty tablet with backups in Drive: those come first.
  const [notes, words] = await Promise.all([db.notes.count(), db.vocab.count()]);
  if (!notes && !words) {
    const list = await listBackups().catch(() => []);
    if (list.length) return restoreSheet(ctx, list, true);
  }
  folderSheet(ctx);
}

function option(id: string, title: string, sub: string) {
  return h('button', { type: 'button', class: 'drive-option', id }, h('strong', {}, title), h('span', {}, sub));
}

function folderSheet(ctx: AppContext) {
  const mine = option('drive-folder-new', `A new folder “${FOLDER_NAME}” in My Drive`, 'Recommended. The app makes it for you.');
  const pick = option('drive-folder-pick', 'Choose a folder…', 'Opens Google’s folder picker. Any folder in your Drive.');
  mine.addEventListener('click', () => {
    closeSheet();
    saveCfg({ folderId: null, folderName: FOLDER_NAME, folderMine: true });
    scheduleSheet(ctx, true);
  });
  pick.addEventListener('click', async () => {
    closeSheet();
    try {
      const f = await pickFolder();
      if (!f) return folderSheet(ctx);
      saveCfg({ folderId: f.id, folderName: f.name, folderMine: false });
      scheduleSheet(ctx, true);
    } catch (e) {
      ctx.toast(errorText(e));
      folderSheet(ctx);
    }
  });
  openSheet({ title: 'Where should backups go?', id: 'drive-folder-sheet', body: [h('div', { class: 'drive-options' }, mine, pick)], actions: [{ label: 'Cancel' }] });
}

export function scheduleSheet(ctx: AppContext, first: boolean) {
  const cfg = getCfg();
  let every = cfg.every;
  const chips = EVERY.map((e) => {
    const b = h('button', { type: 'button', class: 'chip-btn', 'data-every': String(e.v), 'aria-pressed': String(e.v === every) }, e.label);
    b.addEventListener('click', () => {
      every = e.v;
      for (const c of chips) c.setAttribute('aria-pressed', String(c === b));
    });
    return b;
  });
  const onChange = h('input', { type: 'checkbox', id: 'drive-onchange', checked: cfg.onChange });
  openSheet({
    title: 'How often?',
    id: 'drive-schedule-sheet',
    body: [
      h('div', { class: 'chip-row', role: 'group', 'aria-label': 'How often' }, ...chips),
      h('label', { class: 'check' }, onChange, ' Also back up right after a big change (a new note, something deleted, an import)'),
      h('p', {}, `Keeps the last ${KEEP_BACKUPS} backups in Drive; older ones go to Drive’s trash. The app backs up when it is open and online: a website can’t run while it’s closed.`)
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: first ? 'Turn on Drive backup' : 'Save',
        primary: true,
        id: 'drive-turn-on',
        run: () => {
          saveCfg({ every, onChange: onChange.checked });
          if (first) {
            saveState({ on: true, since: Date.now(), error: null, needsSignIn: false });
            void backUpNow(ctx);
          } else ctx.toast(`Drive backup: ${everyText(every).toLowerCase()}.`);
        }
      }
    ]
  });
}

// ---------- back up now ----------
export async function backUpNow(ctx: AppContext) {
  if (backupRunning()) return void ctx.toast('A backup is already on its way to Drive.');
  await withSignIn(ctx, 'backup', async () => {
    await ctx.flush();
    ctx.toast('Backing up to Google Drive…');
    try {
      await backupToDrive({ auto: false });
      const l = getState().last;
      ctx.toast(l ? `Backed up to Google Drive: ${num(l.notes)} notes, ${num(l.words)} words, ${num(l.images)} pictures.` : 'Backed up to Google Drive.');
    } catch (e) {
      ctx.toast(errorText(e));
    }
  });
}

// ---------- restore ----------
export function openRestore(ctx: AppContext) {
  void withSignIn(ctx, 'restore', () => showRestoreList(ctx));
}

async function showRestoreList(ctx: AppContext) {
  if (!getState().email && !(await rememberAccount(ctx))) return;
  try {
    restoreSheet(ctx, await listBackups(), false);
  } catch (e) {
    ctx.toast(errorText(e));
  }
}

function backupLine(f: DriveFile, newest: boolean) {
  const p = f.appProperties ?? {};
  const t = Date.parse(f.createdTime ?? '') || 0;
  const bits = [p.device, p.notes && `${num(Number(p.notes))} notes`, p.words && `${num(Number(p.words))} words`, p.images && `${num(Number(p.images))} pictures`, f.size && mb(Number(f.size))].filter(Boolean);
  const title = t ? when(t).replace(/^./, (c) => c.toUpperCase()) : f.name;
  return h(
    'button',
    { type: 'button', class: 'drive-pick', 'data-id': f.id, 'aria-pressed': String(newest) },
    h('strong', {}, title, newest ? h('span', { class: 'tag' }, 'newest') : null),
    h('span', {}, bits.join(' · '))
  );
}

function restoreSheet(ctx: AppContext, list: DriveFile[], fromConnect: boolean) {
  const st = getState();
  if (!list.length) {
    openSheet({
      title: 'No backups in Drive yet',
      id: 'drive-restore-sheet',
      body: [h('p', {}, `${st.email || 'This Google account'} has no backups made by this app.`)],
      actions: fromConnect ? [{ label: 'Set up Drive backup', primary: true, run: () => folderSheet(ctx) }] : [{ label: 'Close' }]
    });
    return;
  }
  let chosen = list[0];
  const rows = list.map((f, i) => {
    const b = backupLine(f, i === 0);
    b.addEventListener('click', () => {
      chosen = f;
      for (const r of rows) r.setAttribute('aria-pressed', String(r === b));
    });
    return b;
  });
  const status = h('p', { class: 'drive-restore-status', role: 'status' });
  openSheet({
    title: 'Choose a backup',
    id: 'drive-restore-sheet',
    body: [h('p', {}, st.email || ''), h('div', { class: 'drive-list' }, ...rows), h('p', {}, 'Restore merges: nothing already on this device is deleted. The newer copy of each note wins.'), status],
    actions: [
      fromConnect ? { label: 'Start fresh instead', id: 'drive-fresh', run: () => folderSheet(ctx) } : { label: 'Cancel' },
      {
        label: 'Restore this backup',
        primary: true,
        id: 'drive-restore-go',
        run: async () => {
          status.textContent = 'Restoring… keep the app open.';
          const wasOn = getState().on;
          try {
            const r = await restoreFromDrive(chosen);
            closeSheet();
            restoredSheet(ctx, r, !wasOn && getState().on);
          } catch (e) {
            status.textContent = e instanceof BackupError ? e.message : errorText(e);
          }
          return false;
        }
      }
    ]
  });
}

function restoredSheet(ctx: AppContext, r: ImportReport, turnedOn: boolean) {
  const cfg = getCfg();
  window.dispatchEvent(new Event(DRIVE_EVENT));
  openSheet({
    title: 'Everything is back',
    id: 'drive-restored',
    body: [
      h('p', { id: 'drive-restored-text' }, reportText(r)),
      turnedOn ? h('p', {}, `Drive backup is now on for this device too, ${everyText(cfg.every).toLowerCase()} to ${cfg.folderName ?? FOLDER_NAME}.`) : null
    ].filter(Boolean) as HTMLElement[],
    actions: [{ label: 'Close' }, { label: 'Go to Today', primary: true, id: 'drive-go-today', run: () => ctx.go('#/') }]
  });
}

// ---------- the Backup & storage section ----------
export function driveSection(ctx: AppContext): { el: HTMLElement; destroy(): void } {
  const status = h('p', { class: 'drive-status', id: 'drive-status' });
  const facts = h('dl', { class: 'facts', id: 'drive-facts' });
  const error = h('p', { class: 'warn', id: 'drive-error', role: 'status' });
  const intro = h(
    'p',
    { id: 'drive-intro' },
    'Backs up to your own Google Drive by itself, every 2 days by default, and brings everything back on a new tablet. Google asks for one permission: only the files this app makes. Nothing goes anywhere else.'
  );
  const btn = (id: string, label: string, primary = false) => h('button', { type: 'button', id, class: primary ? 'primary' : '' }, label);
  const connectBtn = btn('drive-connect', 'Connect Google Drive', true);
  const nowBtn = btn('drive-now', 'Back up now', true);
  const schedBtn = btn('drive-schedule', 'Change schedule');
  const restoreBtn = btn('drive-restore', 'Restore from Google Drive');
  const offBtn = btn('drive-disconnect', 'Disconnect');
  connectBtn.addEventListener('click', () => connectDrive(ctx));
  nowBtn.addEventListener('click', () => void backUpNow(ctx));
  schedBtn.addEventListener('click', () => scheduleSheet(ctx, false));
  restoreBtn.addEventListener('click', () => openRestore(ctx));
  offBtn.addEventListener('click', () =>
    openSheet({
      title: 'Disconnect Google Drive?',
      id: 'drive-disconnect-sheet',
      body: [h('p', {}, 'Backups already in Drive stay there. This tablet stops backing up to Drive until you connect again.')],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Disconnect',
          danger: true,
          id: 'drive-disconnect-go',
          run: () => {
            revokeAccess();
            const { signin } = getState();
            try {
              localStorage.setItem('upsc.driveState', JSON.stringify({ on: false, signin }));
            } catch {
              /* blocked storage */
            }
            window.dispatchEvent(new Event(DRIVE_EVENT));
            ctx.toast('Google Drive disconnected. Your backups in Drive are still there.');
          }
        }
      ]
    })
  );
  const el = h(
    'section',
    { class: 'card-block drive', id: 'drive' },
    h('h2', {}, 'Google Drive backup'),
    status,
    intro,
    facts,
    error,
    h('div', { class: 'actions' }, connectBtn, nowBtn, schedBtn, restoreBtn, offBtn)
  );

  function paint() {
    const st = getState();
    const cfg = getCfg();
    const on = st.on;
    intro.hidden = on;
    connectBtn.hidden = on;
    nowBtn.hidden = schedBtn.hidden = offBtn.hidden = !on;
    status.textContent = !on
      ? 'Off.'
      : st.lastAt
        ? `Google Drive backup is on. Backed up ${when(st.lastAt)}${st.last ? ` · ${num(st.last.notes)} notes, ${num(st.last.words)} words, ${num(st.last.images)} pictures` : ''}.`
        : 'Google Drive backup is on. No backup in Drive yet.';
    facts.replaceChildren();
    if (on) {
      const due = nextDue(cfg, st);
      const next = due === null ? '' : due <= Date.now() ? ' · due now' : ` · next on ${dayText(due)}`;
      const row = (k: string, v: string, id: string) => facts.append(h('dt', {}, k), h('dd', { id }, v));
      row('Account', st.email || 'Signed in', 'drive-account');
      row('Folder', `My Drive › ${cfg.folderName ?? FOLDER_NAME}`, 'drive-folder');
      row('Schedule', `${everyText(cfg.every)}${next}${cfg.onChange ? ' · also right after a big change' : ''}`, 'drive-when');
      row('Kept', `Last ${KEEP_BACKUPS} backups${st.kept !== undefined ? ` (${st.kept} so far)` : ''}`, 'drive-kept');
    }
    error.textContent = on && st.error ? st.error : '';
    error.hidden = !error.textContent;
  }
  const repaint = () => paint();
  window.addEventListener(DRIVE_EVENT, repaint);
  window.addEventListener('online', repaint);
  window.addEventListener('offline', repaint);
  if (navigator.onLine) void loadGis().catch(() => undefined); // so the popup opens within the tap
  paint();
  return {
    el,
    destroy: () => {
      window.removeEventListener(DRIVE_EVENT, repaint);
      window.removeEventListener('online', repaint);
      window.removeEventListener('offline', repaint);
    }
  };
}

/** After a full-page sign-in came back: finish what it was started for. */
export function resumeAfterRedirect(r: { result: SignIn; then: string; silent: boolean }, ctx: AppContext) {
  if (r.result === 'ok') {
    saveState({ needsSignIn: false, error: null, signin: 'redirect' });
    if (r.then === 'connect') void afterConnect(ctx);
    else if (r.then === 'restore') void showRestoreList(ctx);
    else if (r.then === 'backup') {
      if (r.silent) void backupToDrive({ auto: true }).catch(() => undefined);
      else void backUpNow(ctx);
    }
    return;
  }
  if (r.silent) saveState({ needsSignIn: true, lastTryAt: Date.now(), error: 'Google needs you to sign in again. Tap Back up now.' });
  else if (r.result === 'denied') ctx.toast('Google Drive wasn’t allowed, so nothing was connected.');
  else if (r.then) ctx.toast('Sign-in cancelled.');
}
