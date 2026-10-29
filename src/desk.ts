import { liveQuery } from 'dexie';
import { db } from './db';
import { FolderIndex } from './lib/folders';
import { h } from './lib/h';
import { icon } from './lib/icons';
import { openSheet } from './lib/sheet';

export function writingGuide() {
  openSheet({ title: 'Your writing workspace', id: 'writing-guide', body: [
    h('p', {}, 'Give your notes the room they need. Hide navigation from the side panel or More, toggle the outline in the note header, or enter Focus for uninterrupted writing.'),
    h('h3', {}, 'Keep your place'), h('p', {}, 'Open-note tabs remember your position during this visit. Closing a tab only removes it from the strip; your saved note stays in its folder.'),
    h('h3', {}, 'Read beside your writing'), h('p', {}, 'Use Reference to consult another note without editing it. Search with Ctrl K to preview a note and open the matching section. Arrow keys choose a result; Enter opens it.'),
    h('h3', {}, 'Review with a plan'), h('p', {}, 'On Today, Plan a session previews the due items for your chosen subject and available time. Start review still opens your usual queue.'),
    h('h3', {}, 'Your notes, safely kept'), h('p', {}, 'Notes save on this device. In Backup & storage you can connect Google Drive for backups, download a backup file, or import and merge a backup. Drive is a backup, not automatic sync between devices.')
  ], actions: [{ label: 'Back to the desk', primary: false }] });
}

export function mountDesk() {
  document.documentElement.dataset.desk = 'true';
  const line = document.querySelector('.topline');
  const rail = document.querySelector('.rail');
  const tools = h('div', { class: 'desk-tools', 'aria-label': 'Workspace tools' });
  const guide = h('button', { type: 'button', class: 'pilot-guide-button', id: 'pilot-guide-open', 'aria-haspopup': 'dialog' }, icon('book', 18), h('span', {}, 'Writing guide'));
  guide.addEventListener('click', writingGuide);
  const navigation = h('button', { type: 'button', id: 'navigation-toggle', class: 'icon-btn', title: 'Show or hide navigation', 'aria-label': 'Hide navigation', 'aria-expanded': 'true' }, icon('sidebar', 20));
  navigation.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('navigation-hidden');
    if (collapsed) document.querySelector('.content')?.prepend(navigation);
    else tools.prepend(navigation);
    navigation.setAttribute('aria-expanded', String(!collapsed));
    navigation.setAttribute('aria-label', collapsed ? 'Show navigation' : 'Hide navigation');
    if (matchMedia('(min-width: 900px)').matches || collapsed) navigation.focus();
  });
  tools.append(navigation, guide);
  for (const control of line?.querySelectorAll('.save-status, .install') ?? []) tools.append(control);
  line?.querySelector('.search-top')?.remove();
  if (line instanceof HTMLElement) line.hidden = true;
  rail?.append(tools);
  rail?.prepend(h('a', { class: 'pilot-rail-brand', href: '#/', 'aria-label': 'u. Study Notes home' }, h('span', { class: 'pilot-monogram', 'aria-hidden': 'true' }, 'u.'), h('span', { class: 'pilot-rail-wordmark' }, 'Study Notes')));
  for (const item of rail?.querySelectorAll('.nav-item') ?? []) {
    const text = [...item.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (text) text.replaceWith(h('span', { class: 'pilot-nav-label' }, text.textContent ?? ''));
  }
  rail?.querySelector('.rail-search')?.append(h('span', { class: 'pilot-nav-label' }, 'Search'), h('kbd', { class: 'pilot-nav-key' }, 'Ctrl K'));
  rail?.querySelector('.rail-search')?.removeAttribute('aria-label');
  rail?.querySelector('.rail-new')?.append(h('span', { class: 'pilot-nav-label' }, 'New note'));
  const subjects = h('section', { class: 'pilot-subjects', 'aria-label': 'Subject shortcuts' });
  rail?.querySelector('.nav-item:last-of-type')?.after(subjects);
  const markPlace = () => {
    const hash = location.hash;
    for (const link of subjects.querySelectorAll('a')) {
      if (hash === link.getAttribute('href')) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };
  liveQuery(() => Promise.all([db.folders.toArray(), db.notes.toArray()])).subscribe({
    next: ([folders, notes]) => {
      const index = new FolderIndex(folders);
      const counts = new Map<string, number>();
      for (const note of notes) {
        if (note.deletedAt) continue;
        const main = index.placeOf(note).main?.id;
        if (main) counts.set(main, (counts.get(main) ?? 0) + 1);
      }
      subjects.replaceChildren(h('h2', {}, 'Your subjects'), ...index.roots('notes').map((folder) =>
        h('a', { href: `#/notes/f/${encodeURIComponent(folder.id)}`, style: `--c: ${index.colour(folder)}` }, icon('folder', 18), h('span', {}, folder.name), h('small', {}, String(counts.get(folder.id) ?? 0)))
      ));
      markPlace();
    },
    error: () => subjects.replaceChildren(h('a', { href: '#/notes' }, 'Open your subjects in Notes'))
  });
  window.addEventListener('hashchange', markPlace);
}
