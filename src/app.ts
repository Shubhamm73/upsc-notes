import { db, getMeta } from './db';
import { daysSince } from './lib/dates';
import { h } from './lib/h';
import { ensurePersistence, isInstalled, storageStatus } from './lib/storage';
import { mountNotes } from './views/notes';
import { mountVocab } from './views/vocab';
import { mountTrash } from './views/trash';
import { purgeOldTrash } from './lib/trash';
import { mountSettings } from './views/settings';

export interface View {
  route(parts: string[]): void;
  flush(): Promise<void>;
  destroy(): Promise<void>;
}

export interface AppContext {
  go(hash: string): void;
  status(text: string, isError?: boolean): void;
  toast(text: string): void;
  flush(): Promise<void>;
  refreshBanners(): void;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function startApp(root: HTMLElement, opts: { onUpdate: (cb: () => void) => void; applyUpdate: () => void }) {
  const statusEl = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
  const installBtn = h('button', { type: 'button', class: 'install', hidden: true }, 'Install app');
  const navNotes = h('a', { href: '#/' }, 'Notes');
  const navVocab = h('a', { href: '#/vocab' }, 'Vocabulary');
  const navTrash = h('a', { href: '#/trash' }, 'Trash');
  const navSettings = h('a', { href: '#/settings' }, 'Backup & storage');
  const banners = h('div', { class: 'banners' });
  const main = h('main', { id: 'view' });
  const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });

  root.replaceChildren(
    h(
      'header',
      { class: 'bar' },
      h('span', { class: 'brand' }, 'UPSC Study Notes'),
      h('nav', { 'aria-label': 'Sections' }, navNotes, navVocab, navTrash, navSettings),
      h('div', { class: 'bar-end' }, statusEl, installBtn)
    ),
    banners,
    main,
    toastEl
  );

  // Sticky toolbars sit just under the top bar, whatever its height on this screen.
  const header = root.querySelector('header')!;
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${header.offsetHeight}px`)).observe(header);

  let toastTimer: number | undefined;
  let updateReady = false;
  let current: { name: string; view: View } | null = null;

  const ctx: AppContext = {
    go: (hash) => {
      location.hash = hash;
    },
    status: (text, isError = false) => {
      statusEl.textContent = text;
      statusEl.classList.toggle('error', isError);
    },
    toast: (text) => {
      toastEl.textContent = text;
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
    },
    flush: async () => {
      await current?.view.flush();
    },
    refreshBanners: () => void paintBanners()
  };

  async function paintBanners() {
    const list: HTMLElement[] = [];
    if (updateReady) {
      const btn = h('button', { type: 'button', class: 'primary' }, 'Reload now');
      btn.addEventListener('click', async () => {
        await ctx.flush();
        opts.applyUpdate();
      });
      list.push(h('div', { class: 'banner' }, h('span', {}, 'A new version of the app is ready. Your notes are saved.'), btn));
    }
    const [count, last, s] = await Promise.all([
      db.notes.count(),
      getMeta<number | null>('lastBackupAt', null),
      storageStatus()
    ]);
    const days = daysSince(last);
    if (count > 0 && (days === null || days > 7)) {
      list.push(
        h(
          'div',
          { class: 'banner warn' },
          h('span', {}, days === null ? 'No backup yet. A backup is the only copy if this tablet is lost.' : `Last backup was ${days} days ago.`),
          h('a', { class: 'button', href: '#/settings' }, 'Back up now')
        )
      );
    }
    if (s.persisted === false && !isInstalled()) {
      list.push(
        h(
          'div',
          { class: 'banner warn' },
          h('span', {}, 'Install the app (Chrome ⋮ menu → Install app) so the browser keeps your notes safe.')
        )
      );
    }
    banners.replaceChildren(...list);
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const name =
      parts[0] === 'settings' ? 'settings' : parts[0] === 'trash' ? 'trash' : parts[0] === 'vocab' || parts[0] === 'v' ? 'vocab' : 'notes';
    navNotes.setAttribute('aria-current', String(name === 'notes'));
    navVocab.setAttribute('aria-current', String(name === 'vocab'));
    navTrash.setAttribute('aria-current', String(name === 'trash'));
    navSettings.setAttribute('aria-current', String(name === 'settings'));
    if (current?.name !== name) {
      await current?.view.destroy();
      const view =
        name === 'settings'
          ? mountSettings(main, ctx)
          : name === 'trash'
            ? mountTrash(main, ctx)
            : name === 'vocab'
              ? mountVocab(main, ctx)
              : mountNotes(main, ctx);
      current = { name, view };
      ctx.status(name === 'settings' || name === 'trash' ? '' : 'Saved on this tablet');
    }
    current.view.route(parts);
    void paintBanners();
  }

  // Save before the app is hidden or closed (Android may kill it in the background).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void ctx.flush();
  });
  window.addEventListener('pagehide', () => void ctx.flush());

  let deferredInstall: BeforeInstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    await deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    deferredInstall = null;
    installBtn.hidden = true;
    if (outcome === 'accepted') {
      ctx.toast('Installed. Open UPSC Notes from the home screen.');
      await ensurePersistence();
      void paintBanners();
    }
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    void ensurePersistence().then(() => paintBanners());
  });

  opts.onUpdate(() => {
    updateReady = true;
    void paintBanners();
  });

  window.addEventListener('hashchange', () => void route());
  void ensurePersistence()
    .then(() => purgeOldTrash())
    .catch(() => 0)
    .finally(() => void route());
}
