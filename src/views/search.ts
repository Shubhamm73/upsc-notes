import { db } from '../db';
import { calloutsIn, noteSearchText } from '../lib/doc';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
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
    const [notes, words] = await Promise.all([db.notes.toArray(), db.vocab.toArray()]);
    if (mine !== seq) return;
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
      .filter((n) => !n.deletedAt && noteSearchText(n).includes(q))
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
    if (noteHits.length) items.push(h('li', { class: 'list-divider' }, `Notes · ${noteHits.length}`));
    for (const { n, hint } of noteHits) {
      const a = h(
        'a',
        { href: `#/n/${n.id}`, class: 'search-hit' },
        h('strong', {}, n.title || 'Untitled note'),
        h('span', { class: 'meta' }, [n.subject, n.topic].filter(Boolean).join(' · ')),
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
