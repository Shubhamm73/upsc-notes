import { db, getMeta, SUBJECTS } from '../db';
import { runPdfExport } from '../pdf/run';
import {
  BackupError,
  buildBackup,
  canShareFiles,
  downloadFile,
  importBackup,
  markBackedUp,
  shareFile
} from '../lib/backup';
import { daysSince } from '../lib/dates';
import { h } from '../lib/h';
import { ensurePersistence, isInstalled, storageStatus } from '../lib/storage';
import type { AppContext, View } from '../app';

export function mountSettings(root: HTMLElement, ctx: AppContext): View {
  const statusList = h('dl', { class: 'facts' });
  const lastBackup = h('p', { class: 'last-backup' });
  const importResult = h('p', { class: 'import-result', role: 'status' });

  const saveBtn = h('button', { type: 'button', class: 'primary', id: 'backup-download' }, 'Save backup to Downloads');
  const shareBtn = h('button', { type: 'button', id: 'backup-share' }, 'Share backup (Drive, email…)');
  shareBtn.hidden = !canShareFiles();
  const fileInput = h('input', { type: 'file', id: 'import-file', accept: '.json,.txt,application/json,text/plain' });
  const importBtn = h('button', { type: 'button', id: 'backup-import' }, 'Import a backup file');
  const protectBtn = h('button', { type: 'button', id: 'protect' }, 'Ask the browser to protect my data');
  const pdfSubject = h('select', { id: 'pdf-subject', 'aria-label': 'Subject to export' }, h('option', { value: 'All' }, 'All subjects'), ...SUBJECTS.map((s) => h('option', { value: s }, s)));
  const pdfVocab = h('input', { type: 'checkbox', id: 'pdf-vocab', checked: true });
  const pdfBtn = h('button', { type: 'button', class: 'primary', id: 'pdf-all' }, 'Export PDF');
  pdfBtn.addEventListener('click', () =>
    void runPdfExport({ kind: 'all', subject: pdfSubject.value, includeVocab: pdfVocab.checked }, ctx, pdfBtn)
  );

  root.replaceChildren(
    h(
      'div',
      { class: 'settings' },
      h('h1', {}, 'Backup & storage'),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Your data stays on this tablet'),
        h(
          'p',
          {},
          'Notes are saved in this app on this tablet only. Nothing is uploaded. That also means a lost or reset tablet loses everything that is not in a backup file.'
        ),
        statusList,
        protectBtn
      ),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Back up'),
        lastBackup,
        h('p', {}, 'Make a backup at least once a week and copy it to Google Drive. The file holds every note, word and image, including trash.'),
        h('div', { class: 'actions' }, saveBtn, shareBtn)
      ),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'PDF of everything'),
        h('p', {}, 'One PDF with a contents page, notes grouped by subject, and your vocabulary as a table. For one note or one section, use the PDF buttons inside the note.'),
        h('div', { class: 'actions pdf-opts' }, pdfSubject, h('label', { class: 'check' }, pdfVocab, ' Include vocabulary')),
        h('div', { class: 'actions' }, pdfBtn)
      ),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Restore'),
        h(
          'p',
          {},
          'Import adds what is missing and updates notes that are newer in the file. It never deletes anything on this tablet.'
        ),
        h('div', { class: 'actions' }, importBtn),
        fileInput,
        importResult
      ),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Install'),
        h(
          'p',
          { id: 'install-text' },
          isInstalled()
            ? 'Installed. Open it from the home screen icon; it works without internet.'
            : 'In Chrome, open the ⋮ menu and choose Install app (or Add to Home screen). The installed app works offline and its data is better protected.'
        )
      ),
      h('p', { class: 'version' }, `Version ${__APP_VERSION__}`)
    )
  );
  fileInput.hidden = true;

  async function paint() {
    const [s, notes, vocab, images, last] = await Promise.all([
      storageStatus(),
      db.notes.count(),
      db.vocab.count(),
      db.images.count(),
      getMeta<number | null>('lastBackupAt', null)
    ]);
    const protectedText =
      s.persisted === null ? 'Unknown in this browser' : s.persisted ? 'Yes, the browser will not clear it on its own' : 'No, the browser may clear it if space runs low';
    statusList.replaceChildren(
      h('dt', {}, 'Protected storage'),
      h('dd', { class: s.persisted === false ? 'warn' : '' }, protectedText),
      h('dt', {}, 'Stored here'),
      h('dd', {}, `${notes} notes · ${vocab} words · ${images} images`),
      h('dt', {}, 'Space used'),
      h('dd', {}, s.usageMB == null ? 'Unknown' : `${s.usageMB.toFixed(1)} MB`)
    );
    protectBtn.hidden = s.persisted !== false;
    const days = daysSince(last);
    lastBackup.textContent =
      days === null ? 'Last backup: never.' : days === 0 ? 'Last backup: today.' : `Last backup: ${days} ${days === 1 ? 'day' : 'days'} ago.`;
    lastBackup.classList.toggle('warn', days === null || days > 7);
  }

  async function runBackup(mode: 'download' | 'share') {
    await ctx.flush();
    saveBtn.disabled = shareBtn.disabled = true;
    try {
      const { blob, filename, counts } = await buildBackup();
      if (mode === 'share') {
        const r = await shareFile(blob, filename);
        if (r === 'cancelled') {
          ctx.toast('Backup not shared.');
          return;
        }
      } else {
        downloadFile(blob, filename);
      }
      await markBackedUp();
      ctx.toast(`Backup saved: ${counts.notes} notes, ${counts.vocab} words, ${counts.images} images.`);
      ctx.refreshBanners();
    } catch {
      ctx.toast("Backup couldn't be made. Try again.");
    } finally {
      saveBtn.disabled = shareBtn.disabled = false;
      void paint();
    }
  }

  saveBtn.addEventListener('click', () => void runBackup('download'));
  shareBtn.addEventListener('click', () => void runBackup('share'));
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    importResult.textContent = 'Importing…';
    try {
      const r = await importBackup(file);
      importResult.textContent = `Imported: ${r.added} added, ${r.updated} updated, ${r.keptNewer} already newer here, ${r.images} images, ${r.cards} review cards.`;
      ctx.toast('Import finished.');
    } catch (e) {
      importResult.textContent =
        e instanceof BackupError ? e.message : "Import failed and nothing was changed. Try the file again, or an older backup.";
    }
    void paint();
  });
  protectBtn.addEventListener('click', async () => {
    const ok = await ensurePersistence();
    ctx.toast(
      ok
        ? 'Storage is now protected.'
        : 'The browser said no. Install the app from the Chrome menu, then try again.'
    );
    void paint();
  });

  void paint();
  return {
    route() {},
    async flush() {},
    async destroy() {}
  };
}
