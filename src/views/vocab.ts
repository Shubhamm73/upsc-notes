import { liveQuery, type Subscription } from 'dexie';
import { db, newId, type Vocab, type VocabUse } from '../db';
import { nextReviewAfter, prettyDate, ymd } from '../lib/dates';
import { h } from '../lib/h';
import type { AppContext, View } from '../app';
import { logReviewDay } from '../lib/activity';

const CONTEXTS: VocabUse['context'][] = ['Essay', 'GS answer', 'Interview', 'Other'];
type Mode = 'all' | 'due';

function blankWord(): Vocab {
  const now = Date.now();
  return {
    id: newId(),
    word: '',
    meaning: '',
    uses: [{ sentence: '', context: 'Essay' }],
    synonyms: [],
    antonyms: [],
    nextReview: ymd(),
    reviewCount: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
}

const norm = (w: string) => w.trim().toLowerCase();

export function mountVocab(root: HTMLElement, ctx: AppContext): View {
  const filter = { q: '', mode: 'all' as Mode };
  let words: Vocab[] = [];
  let draft: Vocab | null = null;
  let isNew = false;
  let dirty = false;
  let timer: number | undefined;
  let retry: number | undefined;
  let chain: Promise<void> = Promise.resolve();
  let dupNotice: HTMLElement | null = null;

  const listEl = h('ul', { class: 'note-list', id: 'vocab-list' });
  const dueEl = h('span', { class: 'due-count' });
  const search = h('input', { id: 'vocab-search', type: 'search', placeholder: 'Search words, meanings, synonyms', 'aria-label': 'Search vocabulary' });
  const modeAll = h('button', { type: 'button', 'aria-pressed': 'true' }, 'All words');
  const modeDue = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Due today');
  const newBtn = h('button', { type: 'button', class: 'primary', id: 'new-word' }, 'New word');
  const editorEl = h('section', { class: 'pane-editor', 'aria-label': 'Word' });

  root.replaceChildren(
    h(
      'div',
      { class: 'notes-layout' },
      h(
        'aside',
        { class: 'pane-list' },
        h('div', { class: 'list-head' }, h('h1', {}, 'Vocabulary'), dueEl),
        search,
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, modeAll, modeDue),
        newBtn,
        listEl
      ),
      editorEl
    )
  );

  search.addEventListener('input', () => {
    filter.q = search.value.trim().toLowerCase();
    renderList();
  });
  const setMode = (m: Mode) => {
    filter.mode = m;
    modeAll.setAttribute('aria-pressed', String(m === 'all'));
    modeDue.setAttribute('aria-pressed', String(m === 'due'));
    renderList();
  };
  modeAll.addEventListener('click', () => setMode('all'));
  modeDue.addEventListener('click', () => setMode('due'));
  newBtn.addEventListener('click', () => {
    if (location.hash === '#/v/new') return; // already on a fresh one
    editorEl.replaceChildren(); // the previous word's form leaves at once; its unsaved text is still saved from memory
    ctx.go('#/v/new');
  });

  const sub: Subscription = liveQuery(() => db.vocab.toArray()).subscribe({
    next: (rows) => {
      words = rows.filter((w) => !w.deletedAt);
      renderList();
      paintDuplicate();
    },
    error: () => ctx.toast("Couldn't read your vocabulary. Reload the app.")
  });

  function renderList() {
    const today = ymd();
    let items = words;
    if (filter.mode === 'due') items = items.filter((w) => w.nextReview <= today);
    if (filter.q) {
      items = items.filter((w) =>
        [w.word, w.meaning, ...w.synonyms, ...w.antonyms, ...w.uses.map((u) => u.sentence)].join(' ').toLowerCase().includes(filter.q)
      );
    }
    items = [...items].sort((a, b) =>
      filter.mode === 'due' ? a.nextReview.localeCompare(b.nextReview) : a.word.localeCompare(b.word, undefined, { sensitivity: 'base' })
    );
    const due = words.filter((w) => w.nextReview <= today).length;
    dueEl.textContent = due ? `${due} due today` : 'Nothing due today';
    dueEl.classList.toggle('is-due', due > 0);

    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(
        h(
          'li',
          { class: 'empty-row' },
          !words.length
            ? 'No words yet. Tap New word and add one you met in today’s reading.'
            : filter.mode === 'due'
              ? 'Nothing due for review today.'
              : 'No words match this search.'
        )
      );
      return;
    }
    for (const w of items) {
      const isDue = w.nextReview <= today;
      listEl.append(
        h(
          'li',
          {},
          h(
            'a',
            { class: 'note-card', href: `#/v/${w.id}`, 'aria-current': draft?.id === w.id ? 'true' : undefined },
            h('strong', {}, w.word || 'Untitled word'),
            h('span', { class: 'meta' }, w.meaning || '—'),
            h('span', { class: isDue ? 'meta due' : 'meta' }, isDue ? 'Review today' : `Next review ${prettyDate(w.nextReview)}`)
          )
        )
      );
    }
  }

  function schedule() {
    dirty = true;
    ctx.status('Editing…');
    clearTimeout(timer);
    timer = window.setTimeout(() => void save(), 800);
  }

  function save(): Promise<void> {
    clearTimeout(timer);
    chain = chain.then(async () => {
      if (!draft || !dirty) return;
      dirty = false;
      draft.updatedAt = Date.now();
      const snap = structuredClone(draft);
      // keep the stored lists tidy: no blank examples, trimmed chips
      snap.uses = snap.uses.filter((u) => u.sentence.trim());
      try {
        await db.vocab.put(snap);
        if (isNew) {
          isNew = false;
          history.replaceState(null, '', `#/v/${snap.id}`);
        }
        if (!dirty) ctx.status('Saved on this tablet');
      } catch (e) {
        dirty = true;
        ctx.status(
          (e as DOMException)?.name === 'QuotaExceededError'
            ? 'Tablet storage is full, so this change is not saved. Free up space; your text is still on screen.'
            : "Couldn't save just now. Retrying in a few seconds.",
          true
        );
        clearTimeout(retry);
        retry = window.setTimeout(() => void save(), 5000);
      }
    });
    return chain;
  }

  function paintDuplicate() {
    if (!dupNotice || !draft) return;
    const d = draft;
    const other = norm(d.word) ? words.find((w) => w.id !== d.id && norm(w.word) === norm(d.word)) : undefined;
    dupNotice.replaceChildren();
    dupNotice.hidden = !other;
    if (other) dupNotice.append(`“${other.word}” is already in your list. `, h('a', { href: `#/v/${other.id}` }, 'Open it'));
  }

  /** A word-chip field: type a word, press Enter or comma to add it. */
  function chipField(label: string, id: string, list: string[]) {
    const chips = h('div', { class: 'chip-list' });
    const input = h('input', { id, placeholder: 'Type a word, then Enter', 'aria-label': `Add ${label.toLowerCase()}` });
    const paint = () => {
      chips.replaceChildren(
        ...list.map((w, i) => {
          const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${w}` }, '×');
          x.addEventListener('click', () => {
            list.splice(i, 1);
            paint();
            schedule();
          });
          return h('span', { class: 'chip' }, w, x);
        })
      );
    };
    const commit = () => {
      const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      let added = false;
      for (const p of parts) {
        if (!list.some((w) => norm(w) === norm(p))) {
          list.push(p);
          added = true;
        }
      }
      input.value = '';
      if (added) {
        paint();
        schedule();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    });
    input.addEventListener('input', () => {
      if (input.value.includes(',')) commit();
    });
    input.addEventListener('blur', commit);
    paint();
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), chips, input);
  }

  function usesField(d: Vocab) {
    const host = h('div', { class: 'uses' });
    const paint = () => {
      host.replaceChildren(
        ...d.uses.map((u, i) => {
          const s = h('textarea', { rows: 2, class: 'use-sentence', 'aria-label': `Example ${i + 1}`, placeholder: 'A sentence you could write in the exam' });
          s.value = u.sentence;
          s.addEventListener('input', () => ((u.sentence = s.value), schedule()));
          const c = h('select', { 'aria-label': `Example ${i + 1} used in` }, ...CONTEXTS.map((x) => h('option', { value: x }, x)));
          c.value = u.context;
          c.addEventListener('change', () => ((u.context = c.value as VocabUse['context']), schedule()));
          const rm = h('button', { type: 'button', class: 'sec-btn danger', 'aria-label': `Remove example ${i + 1}` }, 'Remove');
          rm.addEventListener('click', () => {
            d.uses.splice(i, 1);
            paint();
            schedule();
          });
          return h('div', { class: 'use-row' }, s, h('div', { class: 'use-meta' }, c, rm));
        })
      );
    };
    const add = h('button', { type: 'button', id: 'add-use' }, '+ Add example');
    add.addEventListener('click', () => {
      d.uses.push({ sentence: '', context: 'Essay' });
      paint();
      host.querySelectorAll('textarea')[d.uses.length - 1]?.focus();
    });
    paint();
    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Use cases', h('small', { class: 'hint' }, 'Write sentences you would actually use, and where.')),
      host,
      add
    );
  }

  function renderEditor(v: Vocab) {
    draft = structuredClone(v);
    const d = draft;
    if (!d.uses.length) d.uses.push({ sentence: '', context: 'Essay' });
    const word = h('input', { id: 'v-word', placeholder: 'e.g. Ameliorate', value: d.word, autocapitalize: 'none' });
    const meaning = h('textarea', { id: 'v-meaning', rows: 2, placeholder: 'e.g. To make something bad better' });
    meaning.value = d.meaning;
    dupNotice = h('p', { class: 'banner warn dup', role: 'status', hidden: true });
    word.addEventListener('input', () => {
      d.word = word.value;
      paintDuplicate();
      schedule();
    });
    meaning.addEventListener('input', () => ((d.meaning = meaning.value), schedule()));

    const reviewInfo = h('p', { class: 'review-info' });
    const paintReview = () => {
      reviewInfo.textContent = d.reviewCount
        ? `Reviewed ${d.reviewCount} ${d.reviewCount === 1 ? 'time' : 'times'}. Next review ${prettyDate(d.nextReview)}.`
        : 'Not reviewed yet. Mark it once you can use it in a sentence without looking.';
    };
    paintReview();
    const reviewBtn = h('button', { type: 'button', class: 'primary', id: 'v-reviewed' }, 'Mark reviewed');
    reviewBtn.addEventListener('click', () => {
      void logReviewDay();
      d.reviewCount += 1;
      d.nextReview = nextReviewAfter(d.reviewCount);
      paintReview();
      dirty = true;
      void save();
      ctx.toast(`Next review ${prettyDate(d.nextReview)}`);
    });

    const trashBtn = h('button', { type: 'button', class: 'danger-outline', id: 'word-trash' }, 'Move to trash');
    trashBtn.addEventListener('click', async () => {
      d.deletedAt = Date.now();
      dirty = true;
      await save();
      ctx.toast(`Moved “${d.word || 'Untitled word'}” to Trash.`);
      ctx.go('#/vocab');
    });

    editorEl.replaceChildren(
      h(
        'div',
        { class: 'editor' },
        h('a', { class: 'back-link', href: '#/vocab' }, '← All words'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Word'), word),
        dupNotice,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Meaning'), meaning),
        usesField(d),
        h('div', { class: 'grid2' }, chipField('Synonyms', 'v-syn', d.synonyms), chipField('Antonyms', 'v-ant', d.antonyms)),
        h('div', { class: 'review' }, reviewInfo, reviewBtn),
        h('div', { class: 'danger-zone' }, trashBtn)
      )
    );
    paintDuplicate();
    if (isNew) word.focus();
    renderList();
  }

  async function open(id: string | null) {
    document.body.classList.toggle('editing', !!id);
    if (id && id !== 'new' && draft?.id === id) return;
    // Take the old form off screen first, so nothing typed during the save lands in the previous word.
    editorEl.replaceChildren();
    if (dirty) await save();
    if (isNew && draft && id !== draft.id) isNew = false;
    if (!id) {
      draft = null;
      dupNotice = null;
      editorEl.replaceChildren(
        h(
          'div',
          { class: 'editor-empty' },
          h('h2', {}, 'Build your exam vocabulary'),
          h('p', {}, 'Save a word with its meaning, a sentence you would write in an answer, and its synonyms and antonyms.')
        )
      );
      renderList();
      return;
    }
    if (id === 'new') {
      isNew = true;
      renderEditor(blankWord());
      ctx.status('New word');
      return;
    }
    isNew = false;
    const v = await db.vocab.get(id);
    if (!v || v.deletedAt) {
      draft = null;
      editorEl.replaceChildren(
        h('div', { class: 'editor-empty' }, h('h2', {}, 'Word not found'), h('p', {}, "This word isn't on this tablet."), h('a', { href: '#/vocab' }, 'Back to all words'))
      );
      return;
    }
    renderEditor(v);
    ctx.status('Saved on this tablet');
  }

  return {
    route(parts) {
      if (parts[0] === 'vocab' && parts[1] === 'due') setMode('due');
      void open(parts[0] === 'v' && parts[1] ? parts[1] : null);
    },
    async flush() {
      if (dirty) await save();
    },
    async destroy() {
      if (dirty) await save();
      clearTimeout(retry);
      sub.unsubscribe();
      document.body.classList.remove('editing');
    }
  };
}
