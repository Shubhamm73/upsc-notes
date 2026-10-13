import { db } from '../db';
import { calloutsIn, noteSearchText } from '../lib/doc';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { FolderIndex } from '../lib/folders';
import type { AppContext } from '../app';

let open: HTMLElement | null = null;

/** Search everything (Ctrl + K): notes and words, from any screen. */
export function openSearch(ctx: AppContext) {
  if (open) return;
  const input = h('input', { type: 'search', id: 'global-search', placeholder: 'Search notes and words', 'aria-label': 'Search notes and words', autocomplete: 'off' });
  const results = h('ul', { class: 'search-results', id: 'search-results', role: 'listbox' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close search' }, icon('close', 20));
  const panel = h('div', { class: 'search-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, h('div', { class: 'search-row' }, icon('search', 20), input, closeBtn), results);
  const overlay = h('div', { class: 'search-overlay' }, panel);
  open = overlay;
  document.body.append(overlay);
  input.focus();

  const close = () => {
    overlay.remove();
    open = null;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);

  let seq = 0;
  const run = async () => {
    const q = input.value.trim().toLowerCase();
    const mine = ++seq;
    if (!q) {
      results.replaceChildren(h('li', { class: 'search-hint' }, 'Type a word, a case name, an article number…'));
      return;
    }
    const [notes, words, folders] = await Promise.all([db.notes.toArray(), db.vocab.toArray(), db.folders.toArray()]);
    if (mine !== seq) return;
    const idx = new FolderIndex(folders);
    // A note whose callouts match ("case" → its Case callouts) is listed first, with the callout as a hint.
    const calloutHint = (n: (typeof notes)[number]) => {
      for (const sec of n.sections) {
        for (const c of calloutsIn(sec.doc)) {
          const label = c.label;
          if (`${label} callout`.toLowerCase().includes(q) || c.text.toLowerCase().includes(q)) return `${label}: ${c.text.slice(0, 80)}${c.text.length > 80 ? '…' : ''}`;
        }
      }
      return null;
    };
    const noteHits = notes
      .filter((n) => !n.deletedAt && (noteSearchText(n).includes(q) || idx.label(n).toLowerCase().includes(q)))
      .map((n) => ({ n, hint: calloutHint(n) }))
      .sort((a, b) => Number(!!b.hint) - Number(!!a.hint) || b.n.updatedAt - a.n.updatedAt)
      .slice(0, 12);
    const wordHits = words
      .filter((w) => !w.deletedAt && [w.word, w.meaning, ...w.synonyms, ...w.antonyms, ...w.uses.map((u) => u.sentence)].join(' ').toLowerCase().includes(q))
      .slice(0, 8);
    const go = (hash: string) => () => {
      close();
      ctx.go(hash);
    };
    const items: HTMLElement[] = [];
    // Subjects and main subjects by name: one tap opens the folder.
    const folderHits = idx
      .subjectsByMain()
      .flatMap(({ main, subjects }) => [main, ...subjects.filter((s) => s.name !== 'General')])
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 6);
    if (folderHits.length) items.push(h('li', { class: 'list-divider' }, `Subjects · ${folderHits.length}`));
    for (const f of folderHits) {
      const href = `#/notes/f/${encodeURIComponent(f.id)}`;
      const main = idx.get(f.parent);
      const a = h(
        'a',
        { href, class: 'search-hit folder-hit' },
        h('strong', {}, h('span', { class: 'dot', style: `background: ${idx.colour(f)}` }), f.name),
        h('span', { class: 'meta' }, main ? `Subject in ${main.name}` : 'Main subject')
      );
      a.addEventListener('click', (e) => (e.preventDefault(), go(href)()));
      items.push(h('li', {}, a));
    }
    if (noteHits.length) items.push(h('li', { class: 'list-divider' }, `Notes · ${noteHits.length}`));
    for (const { n, hint } of noteHits) {
      const a = h(
        'a',
        { href: `#/n/${n.id}`, class: 'search-hit' },
        h('strong', {}, n.title || 'Untitled note'),
        h('span', { class: 'meta' }, [idx.label(n), n.topic].filter(Boolean).join(' · ')),
        hint ? h('span', { class: 'meta callout-hit' }, hint) : null
      );
      a.addEventListener('click', (e) => (e.preventDefault(), go(`#/n/${n.id}`)()));
      items.push(h('li', {}, a));
    }
    if (wordHits.length) items.push(h('li', { class: 'list-divider' }, `Words · ${wordHits.length}`));
    for (const w of wordHits) {
      const a = h('a', { href: `#/v/${w.id}`, class: 'search-hit' }, h('strong', {}, w.word || 'Untitled word'), h('span', { class: 'meta' }, w.meaning));
      a.addEventListener('click', (e) => (e.preventDefault(), go(`#/v/${w.id}`)()));
      items.push(h('li', {}, a));
    }
    if (!items.length) items.push(h('li', { class: 'search-hint' }, `Nothing matches “${input.value.trim()}”.`));
    results.replaceChildren(...items);
  };
  input.addEventListener('input', () => void run());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector<HTMLAnchorElement>('a.search-hit');
      first?.click();
    }
  });
  void run();
}
