import { showReference } from '../workspace';
import { db, type Note } from '../db';
import { calloutsIn, docToText, noteSearchText } from '../lib/doc';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { FolderIndex } from '../lib/folders';
import type { AppContext } from '../app';

let open: HTMLElement | null = null;

/** Search everything (Ctrl + K): notes and words, from any screen. */
export function openSearch(ctx: AppContext) {
  if (open) return;
  const before = document.activeElement as HTMLElement | null;
  let selected = 0;
  const input = h('input', { type: 'search', id: 'global-search', role: 'combobox', 'aria-controls': 'search-results', 'aria-expanded': 'true', 'aria-autocomplete': 'list', placeholder: 'Search notes and words', 'aria-label': 'Search notes and words', autocomplete: 'off' });
  const results = h('ul', { class: 'search-results', id: 'search-results', role: 'listbox' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close search' }, icon('close', 20));
  const previews = new Map<HTMLAnchorElement, Note>();
  const preview = h('aside', { class: 'search-preview', 'aria-label': 'Note preview', hidden: true });
  const panel = h('div', { class: 'search-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, h('div', { class: 'search-row' }, icon('search', 20), input, closeBtn), h('div', { class: 'search-body' }, results, preview), h('p', { class: 'search-footer meta' }, '↑ ↓ to choose · Enter to open at the matching section · Esc to close'));
  const overlay = h('div', { class: 'search-overlay' }, panel);
  open = overlay;
  document.body.append(overlay);
  input.focus();

  const close = () => {
    seq++;
    overlay.remove();
    open = null;
    if (before?.isConnected) before.focus({ preventScroll: true });
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      const focusable = [...panel.querySelectorAll<HTMLElement>('input,button,a[href]')];
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
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
    selected = 0;
    previews.clear(); preview.hidden = true;
    input.removeAttribute('aria-activedescendant');
    if (!q) {
      results.replaceChildren(h('li', { class: 'search-hint', role: 'option', 'aria-disabled': 'true' }, 'Type a word, a case name, an article number…'));
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
      const section = n.sections.find(s => `${s.heading} ${docToText(s.doc)}`.toLowerCase().includes(q));
      const text = section ? docToText(section.doc).replace(/\s+/g, ' ') : '';
      const at = Math.max(0, text.toLowerCase().indexOf(q) - 45);
      const snippet = text ? `${at ? '…' : ''}${text.slice(at, at + 165)}${text.length > at + 165 ? '…' : ''}` : '';
      const target = `#/n/${n.id}${section ? `/section/${encodeURIComponent(section.id)}` : ''}`;
      const a = h(
        'a',
        { href: target, class: 'search-hit' },
        h('strong', {}, n.title || 'Untitled note'),
        h('span', { class: 'meta' }, [idx.label(n), n.topic].filter(Boolean).join(' · ')),
        hint ? h('span', { class: 'meta callout-hit' }, hint) : null,
        section ? h('span', { class: 'search-section' }, section.heading || 'Untitled section') : null,
        snippet ? h('span', { class: 'search-snippet' }, snippet) : null
      );
      previews.set(a, n);
      a.addEventListener('click', (e) => (e.preventDefault(), go(target)()));
      items.push(h('li', {}, a));
    }
    if (wordHits.length) items.push(h('li', { class: 'list-divider' }, `Words · ${wordHits.length}`));
    for (const w of wordHits) {
      const a = h('a', { href: `#/v/${w.id}`, class: 'search-hit' }, h('strong', {}, w.word || 'Untitled word'), h('span', { class: 'meta' }, w.meaning));
      a.addEventListener('click', (e) => (e.preventDefault(), go(`#/v/${w.id}`)()));
      items.push(h('li', {}, a));
    }
    if (!items.length) items.push(h('li', { class: 'search-hint', role: 'option', 'aria-disabled': 'true' }, `Nothing matches “${input.value.trim()}”.`));
    for (const item of items) if (!item.classList.contains('search-hint')) item.setAttribute('role', 'presentation');
    results.replaceChildren(...items);
    markSelected();
  };
  input.addEventListener('input', () => void run());
  function markSelected() {
    const links = [...results.querySelectorAll<HTMLAnchorElement>('a.search-hit')];
    links.forEach((link, i) => { link.onpointerenter = () => { if (selected !== i) { selected = i; markSelected(); } }; link.setAttribute('role', 'option'); link.setAttribute('aria-selected', String(i === selected)); link.classList.toggle('search-selected', i === selected); link.id = `search-hit-${i}`; });
    const active = links[selected];
    const note = active ? previews.get(active) : null;
    preview.hidden = !note;
    if (note) {
      const useReference = h('button', { type: 'button', class: 'search-reference' }, 'Use as reference');
      useReference.addEventListener('click', () => { close(); void showReference(note.id); });
      preview.replaceChildren(h('span', { class: 'eyebrow' }, 'Preview · read only'), h('h2', {}, note.title || 'Untitled note'),
        ...note.sections.map(section => h('section', {}, h('h3', {}, section.heading || 'Untitled section'), h('p', {}, docToText(section.doc)))),
        ...(document.body.classList.contains('editing') ? [useReference] : []));
    }

    if (active) input.setAttribute('aria-activedescendant', active.id);
    else input.removeAttribute('aria-activedescendant');
  }
  input.addEventListener('keydown', (e) => {
    const links = [...results.querySelectorAll<HTMLAnchorElement>('a.search-hit')];
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && links.length) {
      e.preventDefault();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      markSelected(); links[selected].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); links[selected]?.click(); }
  });
  void run();
}
