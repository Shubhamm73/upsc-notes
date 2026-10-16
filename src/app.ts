import { h } from './lib/h';
import { ensurePersistence } from './lib/storage';
import { mountNotes } from './views/notes';
import { mountVocab } from './views/vocab';
import { mountTrash } from './views/trash';
import { purgeOldTrash } from './lib/trash';
import { ensureFolders } from './lib/folders';
import { mountSettings } from './views/settings';
import { mountToday } from './views/today';
import { mountMore } from './views/more';
import { mountAppearance } from './views/appearance';
import { mountReview } from './views/review';
import { openSearch } from './views/search';
import { icon } from './lib/icons';
import { takeRedirectResult } from './lib/drive';
import { startDriveSchedule } from './lib/drive-backup';
import { resumeAfterRedirect } from './views/drive-ui';
import { loadStyles } from './lib/my-styles';

export interface View {
  route(parts: string[]): void;
  flush(): Promise<void>;
  destroy(): Promise<void>;
}

export interface AppContext {
  go(hash: string): void;
  /** Opens the browser's install prompt when it is available; false if not. */
  install(): Promise<boolean>;
  canInstall(): boolean;
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
  const navItem = (href: string, label: string, ic: string) => h('a', { class: 'nav-item', href }, icon(ic), label);
  const navToday = navItem('#/', 'Today', 'today');
  const navNotes = navItem('#/notes', 'Notes', 'notes');
  const navVocab = navItem('#/vocab', 'Words', 'words');
  const navMore = navItem('#/more', 'More', 'more');
  const searchBtn = h('button', { type: 'button', class: 'icon-btn rail-search', 'aria-label': 'Search notes and words (Ctrl K)', title: 'Search (Ctrl K)' }, icon('search'));
  const searchTop = h('button', { type: 'button', class: 'icon-btn search-top', 'aria-label': 'Search notes and words' }, icon('search'));
  const newBtn = h('button', { type: 'button', class: 'rail-new', 'aria-label': 'New note (Ctrl N)', title: 'New note (Ctrl N)' }, icon('plus', 24));
  const banners = h('div', { class: 'banners' });
  const main = h('main', { id: 'view' });
  const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });

  root.replaceChildren(
    h(
      'div',
      { class: 'app' },
      h('nav', { class: 'rail', 'aria-label': 'Main' }, searchBtn, h('div', { style: 'height: 8px' }), navToday, navNotes, navVocab, navMore, h('div', { class: 'spacer' }), newBtn),
      h('div', { class: 'content' }, h('div', { class: 'topline' }, statusEl, installBtn, searchTop), banners, main)
    ),
    toastEl
  );

  // Sticky toolbars sit just under the top line, whatever its height on this screen.
  const header = root.querySelector('.topline') as HTMLElement;
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${header.offsetHeight}px`)).observe(header);

  let deferredInstall: BeforeInstallPromptEvent | null = null;
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
    refreshBanners: () => paintBanners(),
    install: async () => {
      if (!deferredInstall) return false;
      installBtn.click();
      return true;
    },
    canInstall: () => !!deferredInstall
  };

  function paintBanners() {
    const list: HTMLElement[] = [];
    if (updateReady) {
      const btn = h('button', { type: 'button', class: 'primary' }, 'Reload now');
      btn.addEventListener('click', async () => {
        await ctx.flush();
        opts.applyUpdate();
      });
      list.push(h('div', { class: 'banner' }, h('span', {}, 'A new version of the app is ready. Your notes are saved.'), btn));
    }
    // Backup and install reminders live in More → Backup & storage, not over every screen (owner, 0.8.1).
    banners.replaceChildren(...list);
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const p0 = parts[0] ?? '';
    const name =
      p0 === '' || p0 === 'today'
        ? 'today'
        : p0 === 'notes' || p0 === 'n'
          ? 'notes'
          : p0 === 'vocab' || p0 === 'v'
            ? 'vocab'
            : ['settings', 'trash', 'more', 'prefs', 'review'].includes(p0)
              ? p0
              : 'today';
    const section = name === 'settings' || name === 'trash' || name === 'prefs' ? 'more' : name === 'review' ? 'today' : name;
    navToday.setAttribute('aria-current', String(section === 'today'));
    navNotes.setAttribute('aria-current', String(section === 'notes'));
    navVocab.setAttribute('aria-current', String(section === 'vocab'));
    navMore.setAttribute('aria-current', String(section === 'more'));
    if (current?.name !== name) {
      await current?.view.destroy();
      const mounts: Record<string, (r: HTMLElement, c: AppContext) => View> = {
        today: mountToday,
        notes: mountNotes,
        vocab: mountVocab,
        settings: mountSettings,
        trash: mountTrash,
        more: mountMore,
        prefs: mountAppearance,
        review: mountReview
      };
      const view = mounts[name](main, ctx);
      current = { name, view };
      ctx.status(name === 'notes' || name === 'vocab' ? 'Saved on this tablet' : '');
      window.scrollTo(0, 0);
    }
    current.view.route(parts);
    paintBanners();
  }

  // Save before the app is hidden or closed (Android may kill it in the background).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void ctx.flush();
  });
  window.addEventListener('pagehide', () => void ctx.flush());

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
      paintBanners();
    }
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    void ensurePersistence().then(() => paintBanners());
  });

  opts.onUpdate(() => {
    updateReady = true;
    paintBanners();
  });

  searchBtn.addEventListener('click', () => openSearch(ctx));
  searchTop.addEventListener('click', () => openSearch(ctx));
  newBtn.addEventListener('click', () => ctx.go('#/n/new'));
  // Keyboard cover shortcuts: Ctrl+K search, Ctrl+N new note.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'k') {
      e.preventDefault();
      openSearch(ctx);
    } else if (k === 'n' && !e.shiftKey) {
      e.preventDefault();
      ctx.go('#/n/new');
    }
  });

  window.addEventListener('hashchange', () => void route());
  // A full-page Google sign-in that just came back: the token leaves the address before the first screen.
  const signedIn = takeRedirectResult();
  void ensurePersistence()
    .then(() => purgeOldTrash())
    .catch(() => 0)
    .then(() => ensureFolders())
    .catch(() => 0)
    .then(() => loadStyles())
    .catch(() => 0)
    .finally(() => {
      void route();
      if (signedIn) resumeAfterRedirect(signedIn, ctx);
      startDriveSchedule();
    });
}
