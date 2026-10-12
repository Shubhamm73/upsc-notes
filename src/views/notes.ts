import { liveQuery, type Subscription } from 'dexie';
import { db, newId, SUBJECTS, type Note } from '../db';
import { docToText, textToDoc } from '../lib/doc';
import { nextReviewAfter, prettyDate, ymd } from '../lib/dates';
import { h } from '../lib/h';
import type { AppContext, View } from '../app';

type Mode = 'all' | 'due';

function blankNote(subject: string): Note {
  const now = Date.now();
  return {
    id: newId(),
    subject,
    topic: '',
    title: '',
    sections: [{ id: newId(), heading: 'Notes', doc: textToDoc('') }],
    explain: '',
    connect: '',
    nextReview: ymd(),
    reviewCount: 0,
    lastReviewed: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
}

function saveErrorText(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'QuotaExceededError') {
    return 'Tablet storage is full, so this change is not saved. Free up space, then keep typing. Your text is still on screen.';
  }
  return "Couldn't save just now. Retrying in a few seconds. Your text is still on screen.";
}

export function mountNotes(root: HTMLElement, ctx: AppContext): View {
  const filter = { subject: 'All', q: '', mode: 'all' as Mode };
  let notes: Note[] = [];
  let draft: Note | null = null;
  let isNew = false;
  let dirty = false;
  let timer: number | undefined;
  let retry: number | undefined;
  let chain: Promise<void> = Promise.resolve();
  let sub: Subscription | null = null;

  // ---------- layout ----------
  const listEl = h('ul', { class: 'note-list', id: 'note-list' });
  const dueEl = h('span', { class: 'due-count' });
  const search = h('input', { id: 'search', type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Subject' });
  const modeAll = h('button', { type: 'button', 'aria-pressed': 'true' }, 'All notes');
  const modeDue = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Due today');
  const newBtn = h('button', { type: 'button', class: 'primary', id: 'new-note' }, 'New note');

  const side = h(
    'aside',
    { class: 'pane-list' },
    h('div', { class: 'list-head' }, h('h1', {}, 'Notes'), dueEl),
    search,
    chips,
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, modeAll, modeDue),
    newBtn,
    listEl
  );
  const editorEl = h('section', { class: 'pane-editor', 'aria-label': 'Note' });
  const wrap = h('div', { class: 'notes-layout' }, side, editorEl);
  root.replaceChildren(wrap);

  for (const s of ['All', ...SUBJECTS]) {
    const b = h('button', { type: 'button', 'data-s': s, 'aria-pressed': String(s === 'All') }, s === 'All' ? 'All subjects' : s);
    b.addEventListener('click', () => {
      filter.subject = s;
      for (const c of chips.children) c.setAttribute('aria-pressed', String((c as HTMLElement).dataset.s === s));
      renderList();
    });
    chips.append(b);
  }
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
  newBtn.addEventListener('click', () => ctx.go('#/n/new'));

  sub = liveQuery(() => db.notes.toArray()).subscribe({
    next: (rows) => {
      notes = rows.filter((n) => !n.deletedAt);
      renderList();
    },
    error: () => ctx.toast("Couldn't read your notes. Reload the app.")
  });

  // ---------- list ----------
  function renderList() {
    const today = ymd();
    let items = notes;
    if (filter.mode === 'due') items = items.filter((n) => n.nextReview <= today);
    if (filter.subject !== 'All') items = items.filter((n) => n.subject === filter.subject);
    if (filter.q) {
      items = items.filter((n) =>
        [n.title, n.topic, n.explain, n.connect, ...n.sections.map((s) => docToText(s.doc))]
          .join(' ')
          .toLowerCase()
          .includes(filter.q)
      );
    }
    items = [...items].sort((a, b) =>
      filter.mode === 'due' ? a.nextReview.localeCompare(b.nextReview) : b.updatedAt - a.updatedAt
    );

    const due = notes.filter((n) => n.nextReview <= today).length;
    dueEl.textContent = due ? `${due} due today` : 'Nothing due today';
    dueEl.classList.toggle('is-due', due > 0);

    listEl.replaceChildren();
    if (!items.length) {
      const msg = !notes.length
        ? 'No notes yet. Tap New note and write one concept you understood today.'
        : filter.mode === 'due'
          ? 'Nothing due for review today.'
          : 'No notes match this filter.';
      listEl.append(h('li', { class: 'empty-row' }, msg));
      return;
    }
    for (const n of items) {
      const isDue = n.nextReview <= today;
      listEl.append(
        h(
          'li',
          {},
          h(
            'a',
            { class: 'note-card', href: `#/n/${n.id}`, 'aria-current': draft?.id === n.id ? 'true' : undefined },
            h('strong', {}, n.title || 'Untitled note'),
            h('span', { class: 'meta' }, [n.subject, n.topic].filter(Boolean).join(' · ')),
            h('span', { class: isDue ? 'meta due' : 'meta' }, isDue ? 'Review today' : `Next review ${prettyDate(n.nextReview)}`)
          )
        )
      );
    }
  }

  // ---------- saving ----------
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
      const snapshot = structuredClone(draft);
      try {
        await db.notes.put(snapshot);
        if (isNew) {
          isNew = false;
          history.replaceState(null, '', `#/n/${snapshot.id}`);
        }
        if (!dirty) ctx.status('Saved on this tablet');
      } catch (e) {
        dirty = true;
        ctx.status(saveErrorText(e), true);
        clearTimeout(retry);
        retry = window.setTimeout(() => void save(), 5000);
      }
    });
    return chain;
  }

  // ---------- editor ----------
  function renderEmptyEditor() {
    draft = null;
    editorEl.replaceChildren(
      h(
        'div',
        { class: 'editor-empty' },
        h('h2', {}, 'Start with one idea'),
        h(
          'p',
          {},
          'Pick a note, or write down a concept you understood today in your own words. Then connect it to something you already know.'
        )
      )
    );
  }

  function field(label: string, hint: string | null, control: HTMLElement) {
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label, hint ? h('small', { class: 'hint' }, hint) : null),
      control
    );
  }

  function renderEditor(n: Note) {
    draft = structuredClone(n);
    const d = draft;
    const title = h('input', { id: 'f-title', placeholder: 'e.g. Separation of powers', value: d.title });
    const subject = h('select', { id: 'f-subject' }, ...SUBJECTS.map((s) => h('option', { value: s }, s)));
    subject.value = d.subject;
    const topic = h('input', { id: 'f-topic', placeholder: 'e.g. Judiciary', value: d.topic });
    const body = h('textarea', { id: 'f-body', rows: 12 });
    body.value = docToText(d.sections[0]?.doc);
    const explain = h('textarea', { id: 'f-explain', rows: 6 });
    explain.value = d.explain;
    const connect = h('textarea', { id: 'f-connect', rows: 5 });
    connect.value = d.connect;

    title.addEventListener('input', () => ((d.title = title.value), schedule()));
    subject.addEventListener('change', () => ((d.subject = subject.value), schedule()));
    topic.addEventListener('input', () => ((d.topic = topic.value), schedule()));
    body.addEventListener('input', () => {
      if (!d.sections.length) d.sections.push({ id: newId(), heading: 'Notes', doc: textToDoc('') });
      d.sections[0].doc = textToDoc(body.value);
      schedule();
    });
    explain.addEventListener('input', () => ((d.explain = explain.value), schedule()));
    connect.addEventListener('input', () => ((d.connect = connect.value), schedule()));

    const reviewInfo = h('p', { class: 'review-info' });
    const paintReview = () => {
      reviewInfo.textContent = d.reviewCount
        ? `Reviewed ${d.reviewCount} ${d.reviewCount === 1 ? 'time' : 'times'}. Next review ${prettyDate(d.nextReview)}.`
        : 'Not reviewed yet. Mark it once you can explain it without looking.';
    };
    paintReview();
    const reviewBtn = h('button', { type: 'button', class: 'primary', id: 'mark-reviewed' }, 'Mark reviewed');
    reviewBtn.addEventListener('click', () => {
      d.reviewCount += 1;
      d.lastReviewed = Date.now();
      d.nextReview = nextReviewAfter(d.reviewCount);
      paintReview();
      dirty = true;
      void save();
      ctx.toast(`Next review ${prettyDate(d.nextReview)}`);
    });

    const back = h('a', { class: 'back-link', href: '#/' }, '← All notes');

    editorEl.replaceChildren(
      h(
        'div',
        { class: 'editor' },
        back,
        field('Title', null, title),
        h('div', { class: 'grid2' }, field('Subject', null, subject), field('Topic', null, topic)),
        field('Notes', 'Rich formatting, tables, images and charts arrive in the next update.', body),
        field('Explain it in your own words', 'Write it as if teaching a friend who has never heard of it.', explain),
        field('Connect it', 'Where else does this appear in the syllabus? How would it change an answer?', connect),
        h('div', { class: 'review' }, reviewInfo, reviewBtn)
      )
    );
    if (isNew) title.focus();
    renderList();
  }

  async function open(id: string | null) {
    if (dirty) await save();
    else if (isNew && draft && id !== draft.id) isNew = false; // discard an untouched new note
    document.body.classList.toggle('editing', !!id);
    if (!id) {
      renderEmptyEditor();
      renderList();
      return;
    }
    if (id === 'new') {
      isNew = true;
      renderEditor(blankNote(filter.subject !== 'All' ? filter.subject : SUBJECTS[0]));
      ctx.status('New note');
      return;
    }
    if (draft?.id === id) return;
    isNew = false;
    const n = await db.notes.get(id);
    if (!n || n.deletedAt) {
      editorEl.replaceChildren(
        h(
          'div',
          { class: 'editor-empty' },
          h('h2', {}, 'Note not found'),
          h('p', {}, "This note isn't on this tablet."),
          h('a', { href: '#/' }, 'Back to all notes')
        )
      );
      return;
    }
    renderEditor(n);
    ctx.status('Saved on this tablet');
  }

  return {
    route(parts) {
      void open(parts[0] === 'n' && parts[1] ? parts[1] : null);
    },
    async flush() {
      if (dirty) await save();
    },
    async destroy() {
      if (dirty) await save();
      clearTimeout(retry);
      sub?.unsubscribe();
      document.body.classList.remove('editing');
    }
  };
}
