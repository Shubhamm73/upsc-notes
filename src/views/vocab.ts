import { liveQuery, type Subscription } from 'dexie';
import { db, newId, type Folder, type Vocab, type VocabUse } from '../db';
import { addDate, addMonth, dateId, deleteFolder, folderContents, FolderIndex, renameFolder, todayFolder } from '../lib/folders';
import { dateName } from '../lib/folder-plan';
import { openSheet } from '../lib/sheet';
import { icon } from '../lib/icons';
import { crumbs, field, folderGrid, plural, type CardSpec } from './folder-ui';
import { prettyDate, ymd } from '../lib/dates';
import { rateRecord } from '../lib/schedule';
import { celebrationsOn } from '../lib/prefs';
import { h } from '../lib/h';
import type { AppContext, View } from '../app';
import { logReviewDay, milestoneText } from '../lib/activity';
import { buzz } from '../lib/haptics';
import { bigChange } from '../lib/changes';

const CONTEXTS: VocabUse['context'][] = ['Essay', 'GS answer', 'Interview', 'Other'];

function blankWord(folderId: string): Vocab {
  const now = Date.now();
  return {
    id: newId(),
    folderId,
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
  const filter = { q: '' };
  let words: Vocab[] = [];
  let draft: Vocab | null = null;
  let isNew = false;
  let dirty = false;
  let timer: number | undefined;
  let retry: number | undefined;
  let chain: Promise<void> = Promise.resolve();
  let dupNotice: HTMLElement | null = null;

  // ---------- browsing: Vocabulary › month › date ----------
  const listEl = h('ul', { class: 'note-list', id: 'vocab-list' });
  const search = h('input', { id: 'vocab-search', type: 'search', placeholder: 'Search words, meanings, synonyms', 'aria-label': 'Search vocabulary' });
  const side = h('aside', { class: 'pane-list browse', 'aria-label': 'Vocabulary' });
  const editorEl = h('section', { class: 'pane-editor', 'aria-label': 'Word' });
  root.replaceChildren(h('div', { class: 'notes-layout is-folders' }, side, editorEl));

  let index = new FolderIndex([]);
  let where: { level: 'root' } | { level: 'folder'; id: string } | { level: 'due' } = { level: 'root' };
  let editMode = false;
  /** The date folder a new word goes in (Add word to today, or Add word inside a date). */
  let newTarget: string | null = null;

  search.addEventListener('input', () => {
    filter.q = search.value.trim().toLowerCase();
    renderList();
  });

  const sub: Subscription = liveQuery(() => db.vocab.toArray()).subscribe({
    next: (rows) => {
      words = rows.filter((w) => !w.deletedAt);
      renderList();
      paintDuplicate();
    },
    error: () => ctx.toast("Couldn't read your vocabulary. Reload the app.")
  });
  const folderSub: Subscription = liveQuery(() => db.folders.toArray()).subscribe({
    next: (rows) => {
      index = new FolderIndex(rows);
      renderList();
      paintPlace?.();
    }
  });

  const folderHref = (id: string) => `#/vocab/f/${encodeURIComponent(id)}`;
  const todayLabel = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  /** New word: filed under today, made if missing. */
  async function newWordIn(dateFolder: string | null) {
    newTarget = dateFolder ?? (await todayFolder()).id;
    if (location.hash === '#/v/new') {
      // already on a fresh one: just file it here
      if (draft && isNew) {
        draft.folderId = newTarget;
        paintPlace?.();
      }
      return;
    }
    editorEl.replaceChildren(); // the previous word's form leaves at once; its unsaved text is still saved from memory
    ctx.go('#/v/new');
  }

  function wordCard(w: Vocab, today: string) {
    const isDue = w.nextReview <= today;
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'note-card', href: `#/v/${w.id}`, 'aria-current': draft?.id === w.id ? 'true' : undefined },
        h('strong', {}, w.word || 'Untitled word'),
        h('span', { class: 'meta' }, w.meaning || '—'),
        h('span', { class: isDue ? 'meta due' : 'meta' }, isDue ? 'Review today' : `Next review ${prettyDate(w.nextReview)}`)
      )
    );
  }

  const inFolders = (ids: Set<string>) => words.filter((w) => ids.has(index.wordFolder(w)));

  function renderList() {
    const today = ymd();
    const due = words.filter((w) => w.nextReview <= today);
    let folder = where.level === 'folder' ? index.get(where.id) : undefined;
    if (folder && (folder.deletedAt || folder.kind !== 'words')) folder = undefined;
    const month = folder ? (folder.parent ? index.get(folder.parent) : folder) : undefined;
    const isDate = !!folder?.parent;

    const path = [{ label: 'Vocabulary', href: '#/vocab' }];
    if (where.level === 'due') path.push({ label: 'Due today', href: '#/vocab/due' });
    if (month) path.push({ label: month.name, href: folderHref(month.id) });
    if (folder && isDate) path.push({ label: folder.name, href: folderHref(folder.id) });
    const head = h('div', { class: 'browse-head' }, h('h1', {}, where.level === 'due' ? 'Due today' : folder ? folder.name : 'Vocabulary'), h('span', { class: 'spacer' }));
    if (where.level === 'root') head.append(h('a', { class: `due-count${due.length ? ' is-due' : ''}`, href: '#/vocab/due', id: 'vocab-due-link' }, due.length ? `${due.length} due today` : 'Nothing due today'));
    if (where.level === 'root' || (folder && !isDate)) {
      const editBtn = h('button', { type: 'button', id: 'folder-edit', 'aria-pressed': String(editMode) }, icon(editMode ? 'check' : 'edit', 20), editMode ? 'Done' : 'Edit');
      editBtn.addEventListener('click', () => {
        editMode = !editMode;
        renderList();
      });
      head.append(editBtn);
    }
    if (folder && isDate) {
      const add = h('button', { type: 'button', class: 'primary big', id: 'add-word-here' }, icon('plus', 20), 'Add word');
      add.addEventListener('click', () => void newWordIn(folder!.id));
      head.append(add);
    } else {
      const add = h('button', { type: 'button', class: 'primary', id: 'new-word' }, icon('plus', 20), `Add word to today (${todayLabel()})`);
      add.addEventListener('click', () => void newWordIn(null));
      head.append(add);
    }
    const parts: HTMLElement[] = [crumbs(path), head];
    listEl.replaceChildren();

    if (where.level === 'folder' && !folder) {
      parts.push(h('p', { class: 'empty-row' }, index.byId.size ? "This folder isn't here any more. " : 'Loading… ', h('a', { href: '#/vocab' }, 'All months')));
    } else if (where.level === 'root') {
      parts.push(search);
      if (filter.q) {
        const items = words
          .filter((w) => [w.word, w.meaning, ...w.synonyms, ...w.antonyms, ...w.uses.map((u) => u.sentence)].join(' ').toLowerCase().includes(filter.q))
          .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
        for (const w of items) listEl.append(wordCard(w, today));
        if (!items.length) listEl.append(h('li', { class: 'empty-row' }, 'No words match this search.'));
        parts.push(listEl);
      } else {
        if (!words.length) parts.push(h('p', { class: 'empty-row' }, 'No words yet. Tap Add word to today and add one you met in today’s reading.'));
        parts.push(monthGrid(today));
      }
    } else if (where.level === 'due') {
      for (const w of [...due].sort((a, b) => a.nextReview.localeCompare(b.nextReview))) listEl.append(wordCard(w, today));
      if (!due.length) listEl.append(h('li', { class: 'empty-row' }, 'Nothing due for review today.'));
      parts.push(listEl);
    } else if (folder && !isDate) {
      parts.push(dateGrid(folder, today));
    } else if (folder) {
      const list = inFolders(new Set([folder.id])).sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
      parts.push(h('p', { class: 'meta browse-meta' }, `${plural(list.length, 'word')} · ${month?.name ?? ''}${folder.date && folder.name !== dateName(folder.date) ? ` · ${prettyDate(folder.date)}` : ''}`));
      for (const w of list) listEl.append(wordCard(w, today));
      if (!list.length) listEl.append(h('li', { class: 'empty-row' }, `No words on ${folder.name} yet. Tap Add word.`));
      parts.push(listEl);
    }
    side.replaceChildren(...parts);
  }

  function monthGrid(today: string) {
    const cards: CardSpec[] = index.roots('words').map((m) => {
      const dates = index.children(m.id);
      const list = inFolders(new Set(dates.map((d) => d.id)));
      return {
        id: m.id,
        href: folderHref(m.id),
        name: m.name,
        colour: 'var(--sub-blue)',
        badge: icon('calendar', 22),
        sub: plural(dates.length, 'date'),
        count: plural(list.length, 'word'),
        due: list.filter((w) => w.nextReview <= today).length,
        pct: null,
        deletable: true
      };
    });
    return folderGrid({
      cards,
      editing: editMode,
      addLabel: 'Add month',
      onAdd: addMonthDialog,
      onRename: (id, name) => void renameFolder(id, name),
      onDelete: (id) => void deleteDialog(id)
    });
  }

  function dateGrid(month: Folder, today: string) {
    const cards: CardSpec[] = index.children(month.id).map((d) => {
      const list = inFolders(new Set([d.id])).sort((a, b) => a.createdAt - b.createdAt);
      return {
        id: d.id,
        href: folderHref(d.id),
        name: d.name,
        colour: 'var(--sub-blue)',
        badge: String(Number((d.date ?? '').slice(8)) || ''),
        sub: list.slice(0, 3).map((w) => w.word).join(', ') || 'No words yet',
        count: plural(list.length, 'word'),
        due: list.filter((w) => w.nextReview <= today).length,
        pct: null,
        deletable: true
      };
    });
    return folderGrid({
      cards,
      editing: editMode,
      addLabel: 'Add date',
      onAdd: () => addDateDialog(month),
      onRename: (id, name) => void renameFolder(id, name),
      onDelete: (id) => void deleteDialog(id)
    });
  }

  function addMonthDialog() {
    const input = h('input', { type: 'month', id: 'folder-month', value: ymd().slice(0, 7) });
    openSheet({
      title: 'Add month',
      id: 'folder-dialog',
      body: [field('Month', input), h('p', { class: 'meta' }, 'Add word to today makes the month for you; this is for filing words from another month.')],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Add',
          id: 'folder-save',
          primary: true,
          run: async () => {
            if (!/^\d{4}-\d{2}$/.test(input.value)) return false;
            await addMonth(input.value);
          }
        }
      ]
    });
  }

  function addDateDialog(month: Folder) {
    const m = month.date ?? ymd().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(y, mo, 0).getDate();
    const today = ymd();
    const input = h('input', { type: 'date', id: 'folder-date', min: `${m}-01`, max: `${m}-${String(last).padStart(2, '0')}`, value: today.startsWith(m) ? today : `${m}-01` });
    openSheet({
      title: `Add date to ${month.name}`,
      id: 'folder-dialog',
      body: [field('Date', input)],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Add',
          id: 'folder-save',
          primary: true,
          run: async () => {
            if (!input.value.startsWith(m)) return false;
            await addDate(input.value);
          }
        }
      ]
    });
  }

  async function deleteDialog(id: string) {
    const f = index.get(id);
    if (!f) return;
    const c = await folderContents(id);
    const what = [c.subfolders ? plural(c.subfolders, 'date') : '', plural(c.words, 'word')].filter(Boolean).join(' and ');
    const one = c.subfolders + c.words === 1;
    openSheet({
      title: `Delete “${f.name}”?`,
      id: 'folder-delete',
      body: [h('p', {}, c.words || c.subfolders ? `Its ${what} ${one ? 'goes' : 'go'} to Trash. You can restore ${one ? 'it' : 'them'} for 30 days. Nothing is deleted for good from here.` : 'It has no words. You can make it again any time.')],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Move to Trash',
          id: 'folder-delete-confirm',
          danger: true,
          run: async () => {
            const r = await deleteFolder(id);
            ctx.toast(r.words ? `Deleted “${f.name}”. ${plural(r.words, 'word')} ${r.words === 1 ? 'is' : 'are'} in Trash for 30 days.` : `Deleted “${f.name}”.`);
          }
        }
      ]
    });
  }

  /** Repaints where the open word is filed (set while a word is open). */
  let paintPlace: (() => void) | null = null;

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
        // a new word's date (and month) folder is there before the word is
        if (isNew && snap.folderId?.startsWith('wd:')) await addDate(snap.folderId.slice(3));
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
      rateRecord(d, 'easy'); // the same as Easy in a review session
      buzz('reviewed');
      paintReview();
      dirty = true;
      void save();
      ctx.toast(`Next review ${prettyDate(d.nextReview)}`);
      void logReviewDay().then((day) => {
        if (day.milestone) buzz('milestone');
        if (day.milestone && celebrationsOn()) ctx.toast(`Next review ${prettyDate(d.nextReview)}. ${milestoneText(day.milestone)}`);
      });
    });

    const trashBtn = h('button', { type: 'button', class: 'danger-outline', id: 'word-trash' }, 'Move to trash');
    trashBtn.addEventListener('click', async () => {
      d.deletedAt = Date.now();
      dirty = true;
      await save();
      bigChange('word to trash');
      ctx.toast(`Moved “${d.word || 'Untitled word'}” to Trash.`);
      ctx.go(backLink.getAttribute('href') ?? '#/vocab');
    });

    // Where the word is filed (a date), and Move to another date.
    const backText = h('span', {}, 'Vocabulary');
    const backLink = h('a', { class: 'back-link', id: 'word-back', href: '#/vocab' }, icon('back', 18), backText);
    const placeText = h('span', {});
    const moveBtn = h('button', { type: 'button', class: 'chip-btn', id: 'word-move' }, icon('calendar', 18), 'Move to another date');
    paintPlace = () => {
      const f = index.get(index.wordFolder(d));
      const m = index.get(f?.parent);
      const label = f ? (m ? `${m.name} › ${f.name}` : f.name) : prettyDate(d.folderId?.startsWith('wd:') ? d.folderId.slice(3) : ymd(new Date(d.createdAt)));
      placeText.textContent = `Filed under ${label}`;
      backText.textContent = f?.name ?? 'Vocabulary';
      backLink.href = f && !f.deletedAt ? folderHref(f.id) : '#/vocab';
    };
    moveBtn.addEventListener('click', () => {
      const current = index.get(index.wordFolder(d))?.date ?? ymd();
      const input = h('input', { type: 'date', id: 'word-date', value: current, max: '9999-12-31' });
      openSheet({
        title: 'Move to another date',
        id: 'word-move-sheet',
        body: [field('Date', input)],
        actions: [
          { label: 'Cancel' },
          {
            label: 'Move',
            id: 'word-move-save',
            primary: true,
            run: async () => {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return false;
              await addDate(input.value);
              d.folderId = dateId(input.value);
              paintPlace?.();
              dirty = true;
              await save();
              ctx.toast(`Moved to ${dateName(input.value)}.`);
            }
          }
        ]
      });
    });

    editorEl.replaceChildren(
      h(
        'div',
        { class: 'editor' },
        backLink,
        h('div', { class: 'word-place' }, h('span', { class: 'meta', id: 'word-place' }, placeText), moveBtn),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Word'), word),
        dupNotice,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Meaning'), meaning),
        usesField(d),
        h('div', { class: 'grid2' }, chipField('Synonyms', 'v-syn', d.synonyms), chipField('Antonyms', 'v-ant', d.antonyms)),
        h('div', { class: 'review' }, reviewInfo, reviewBtn),
        h('div', { class: 'danger-zone' }, trashBtn)
      )
    );
    paintPlace();
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
      paintPlace = null;
      editorEl.replaceChildren();
      renderList();
      return;
    }
    if (id === 'new') {
      isNew = true;
      renderEditor(blankWord(newTarget ?? dateId(ymd())));
      newTarget = null;
      ctx.status('New word');
      return;
    }
    isNew = false;
    const v = await db.vocab.get(id);
    if (!v || v.deletedAt) {
      draft = null;
      editorEl.replaceChildren(
        h('div', { class: 'editor-empty' }, h('h2', {}, 'Word not found'), h('p', {}, "This word isn't on this tablet."), h('a', { href: '#/vocab' }, 'Back to Vocabulary'))
      );
      return;
    }
    renderEditor(v);
    ctx.status('Saved on this tablet');
  }

  return {
    route(parts) {
      if (parts[0] === 'vocab') {
        const next: typeof where =
          parts[1] === 'due' ? { level: 'due' } : parts[1] === 'f' && parts[2] ? { level: 'folder', id: decodeURIComponent(parts[2]) } : { level: 'root' };
        if (JSON.stringify(next) !== JSON.stringify(where)) {
          where = next;
          editMode = false;
          window.scrollTo(0, 0);
          if (search.value) {
            search.value = '';
            filter.q = '';
          }
        }
      }
      void open(parts[0] === 'v' && parts[1] ? parts[1] : null);
    },
    async flush() {
      if (dirty) await save();
    },
    async destroy() {
      if (dirty) await save();
      clearTimeout(retry);
      sub.unsubscribe();
      folderSub.unsubscribe();
      document.body.classList.remove('editing');
    }
  };
}
