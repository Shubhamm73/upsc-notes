import { db, getMeta } from '../db';
import { daysSince } from '../lib/dates';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { isInstalled } from '../lib/storage';
import type { AppContext, View } from '../app';

export function mountMore(root: HTMLElement, ctx: AppContext): View {
  const trashCount = h('span', { class: 'meta' });
  const backupSub = h('span', { class: 'meta', id: 'more-backup' }, 'Back up, restore, PDF of everything');
  const row = (href: string, ic: string, title: string, sub: string | HTMLElement) =>
    h('li', {}, h('a', { class: 'more-row', href }, h('span', { class: 'more-icon' }, icon(ic)), h('span', { class: 'more-text' }, h('strong', {}, title), typeof sub === 'string' ? h('span', { class: 'meta' }, sub) : sub), icon('arrow', 18)));

  const installBtn = h('button', { type: 'button', class: 'primary', id: 'more-install' }, 'Install app');
  installBtn.addEventListener('click', async () => {
    if (!(await ctx.install())) ctx.toast('Use the Chrome ⋮ menu, then Install app.');
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'settings' },
      h('h1', {}, 'More'),
      h(
        'ul',
        { class: 'more-list' },
        row('#/prefs', 'gear', 'Settings', 'Theme and note font style'),
        row('#/settings', 'box', 'Backup & storage', backupSub),
        row('#/trash', 'trash', 'Trash', trashCount)
      ),
      isInstalled()
        ? null
        : h(
            'section',
            { class: 'card-block' },
            h('h2', {}, 'Install the app'),
            h('p', {}, 'The installed app opens from the home screen, works without internet, and keeps your notes safer.'),
            h('div', { class: 'actions' }, installBtn)
          ),
      h('p', { class: 'version' }, `UPSC Study Notes · version ${__APP_VERSION__}`)
    )
  );

  // The backup reminder lives here (not as a banner over every screen): only once there are notes.
  void Promise.all([db.notes.count(), getMeta<number | null>('lastBackupAt', null)]).then(([notes, last]) => {
    const days = daysSince(last);
    if (!notes || (days !== null && days <= 7)) return;
    backupSub.textContent = days === null ? 'No backup yet. Back up now.' : `Last backup ${days} days ago. Back up now.`;
    backupSub.classList.add('warn');
  });

  void Promise.all([db.notes.filter((n) => !!n.deletedAt).count(), db.vocab.filter((w) => !!w.deletedAt).count()]).then(([a, b]) => {
    const n = a + b;
    trashCount.textContent = n ? `${n} ${n === 1 ? 'item' : 'items'} waiting` : 'Empty';
  });

  return { route() {}, async flush() {}, async destroy() {} };
}
