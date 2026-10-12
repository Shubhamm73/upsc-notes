import { liveQuery, type Subscription } from 'dexie';
import type { Editor } from '@tiptap/core';
import { db, newId, SUBJECTS, type Note, type Section, type Vocab } from '../db';
import { docToText, textToDoc } from '../lib/doc';
import { createEditor } from '../editor/editor';
import { createToolbar } from '../editor/toolbar';
import { removeUnusedImages } from '../editor/images';
import { runPdfExport } from '../pdf/run';
import { extractInsights, groupInsights } from '../lib/insights';
import { logReviewDay, setLastNote } from '../lib/activity';
import { subjectColor } from '../lib/subjects';
import { FONT_STYLES } from '../lib/prefs';
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
  const editors = new Map<string, Editor>();
  const toolbar = createToolbar({ noteId: () => draft?.id ?? '', toast: ctx.toast });

  function destroyEditors() {
    for (const ed of editors.values()) {
      toolbar.detach(ed);
      ed.destroy();
    }
    editors.clear();
  }

  /** Called whenever a note is closed: saves, then clears out images nothing uses any more. */
  async function closeNote() {
    if (dirty) await save();
    const closing = draft;
    destroyEditors();
    // Only tidy up when everything is safely saved; a failed save keeps all images.
    if (closing && !dirty) void removeUnusedImages().catch(() => undefined);
  }

  // ---------- layout ----------
  const listEl = h('ul', { class: 'note-list', id: 'note-list' });
  const dueEl = h('span', { class: 'due-count' });
  const search = h('input', { id: 'search', type: 'search', placeholder: 'Search notes and vocabulary', 'aria-label': 'Search notes and vocabulary' });
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
    const b = h(
      'button',
      { type: 'button', class: 'subject-chip', 'data-s': s, 'aria-pressed': String(s === 'All') },
      s === 'All' ? null : h('span', { class: 'dot', style: `background: ${subjectColor(s)}` }),
      s === 'All' ? 'All subjects' : s
    );
    b.addEventListener('click', () => setSubject(s));
    chips.append(b);
  }
  function setSubject(s: string) {
    filter.subject = s;
    for (const c of chips.children) c.setAttribute('aria-pressed', String((c as HTMLElement).dataset.s === s));
    renderList();
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
  newBtn.addEventListener('click', () => {
    if (location.hash === '#/n/new') return; // already on a fresh one
    for (const ed of editors.values()) ed.setEditable(false);
    editorEl.replaceChildren(); // the previous note leaves at once; its unsaved text is still saved from memory
    ctx.go('#/n/new');
  });

  let words: Vocab[] = [];
  const vocabSub = liveQuery(() => db.vocab.toArray()).subscribe({
    next: (rows) => {
      words = rows.filter((w) => !w.deletedAt);
      if (filter.q) renderList();
    }
  });

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
    // Search also covers vocabulary, listed under the notes.
    const wordHits = filter.q
      ? words
          .filter((w) => [w.word, w.meaning, ...w.synonyms, ...w.antonyms, ...w.uses.map((u) => u.sentence)].join(' ').toLowerCase().includes(filter.q))
          .sort((a, b) => a.word.localeCompare(b.word))
      : [];
    const appendWords = () => {
      if (!wordHits.length) return;
      listEl.append(h('li', { class: 'list-divider' }, `Vocabulary · ${wordHits.length}`));
      for (const w of wordHits) {
        listEl.append(
          h('li', {}, h('a', { class: 'note-card word-card', href: `#/v/${w.id}` }, h('strong', {}, w.word || 'Untitled word'), h('span', { class: 'meta' }, w.meaning || '—')))
        );
      }
    };
    if (!items.length) {
      if (wordHits.length) {
        listEl.append(h('li', { class: 'empty-row' }, 'No notes match. Matching words:'));
        appendWords();
        return;
      }
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
            h('span', { class: 'meta' }, h('span', { class: 'dot', style: `background: ${subjectColor(n.subject)}` }), [n.subject, n.topic].filter(Boolean).join(' · ')),
            h(
              'span',
              { class: isDue ? 'meta due' : 'meta' },
              (isDue ? 'Review today' : `Next review ${prettyDate(n.nextReview)}`) +
                (n.insights?.items.length ? ` · ${n.insights.items.length} quick ${n.insights.items.length === 1 ? 'insight' : 'insights'}` : '')
            )
          )
        )
      );
    }
    appendWords();
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
    destroyEditors();
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

  function renderSections(d: Note, host: HTMLElement) {
    destroyEditors();
    if (!d.sections.length) d.sections.push({ id: newId(), heading: 'Notes', doc: textToDoc('') });
    host.replaceChildren();
    d.sections.forEach((s: Section, i: number) => {
      const heading = h('input', {
        class: 'section-heading',
        'aria-label': `Section ${i + 1} heading`,
        placeholder: 'Section heading',
        value: s.heading
      });
      heading.addEventListener('input', () => ((s.heading = heading.value), schedule()));

      const move = (dir: -1 | 1) => {
        const j = i + dir;
        [d.sections[i], d.sections[j]] = [d.sections[j], d.sections[i]];
        schedule();
        renderSections(d, host);
      };
      const up = h('button', { type: 'button', class: 'sec-btn', 'aria-label': 'Move section up', disabled: i === 0 }, '↑');
      const down = h('button', { type: 'button', class: 'sec-btn', 'aria-label': 'Move section down', disabled: i === d.sections.length - 1 }, '↓');
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));

      // Two-tap delete: the first tap arms it for 4 seconds.
      const pdf = h('button', { type: 'button', class: 'sec-btn', 'aria-label': `Export section ${i + 1} as PDF` }, 'PDF');
      pdf.addEventListener('click', () => void runPdfExport({ kind: 'section', note: structuredClone(d), sectionId: s.id }, ctx, pdf));
      const del = h('button', { type: 'button', class: 'sec-btn danger', disabled: d.sections.length === 1 }, 'Delete section');
      let armed: number | undefined;
      del.addEventListener('click', () => {
        if (!armed) {
          del.textContent = 'Tap again to delete';
          del.classList.add('armed');
          armed = window.setTimeout(() => {
            armed = undefined;
            del.textContent = 'Delete section';
            del.classList.remove('armed');
          }, 4000);
          return;
        }
        clearTimeout(armed);
        d.sections.splice(i, 1);
        schedule();
        renderSections(d, host);
        ctx.toast('Section deleted.');
      });

      const bodyEl = h('div', { class: 'section-body', 'data-section': s.id });
      host.append(
        h(
          'section',
          { class: 'note-section' },
          h('div', { class: 'section-head' }, heading, h('div', { class: 'sec-actions' }, up, down, pdf, del)),
          bodyEl
        )
      );
      const ed = createEditor({
        element: bodyEl,
        content: s.doc,
        onChange: (doc) => {
          s.doc = doc;
          schedule();
        },
        onFocus: (e) => toolbar.setEditor(e)
      });
      editors.set(s.id, ed);
      if (i === 0) toolbar.setEditor(ed);
    });

    const add = h('button', { type: 'button', class: 'add-section', id: 'add-section' }, '+ Add section');
    add.addEventListener('click', () => {
      const s: Section = { id: newId(), heading: '', doc: textToDoc('') };
      d.sections.push(s);
      schedule();
      renderSections(d, host);
      const inputs = host.querySelectorAll<HTMLInputElement>('.section-heading');
      inputs[inputs.length - 1]?.focus();
    });
    host.append(add);
  }

  function renderEditor(n: Note) {
    destroyEditors();
    draft = structuredClone(n);
    const d = draft;
    const title = h('input', { id: 'f-title', placeholder: 'e.g. Separation of powers', value: d.title });
    const subject = h('select', { id: 'f-subject' }, ...SUBJECTS.map((s) => h('option', { value: s }, s)));
    subject.value = d.subject;
    const topic = h('input', { id: 'f-topic', placeholder: 'e.g. Judiciary', value: d.topic });
    const sectionsHost = h('div', { class: 'sections', id: 'sections' });
    const explain = h('textarea', { id: 'f-explain', rows: 6 });
    explain.value = d.explain;
    const connect = h('textarea', { id: 'f-connect', rows: 5 });
    connect.value = d.connect;

    title.addEventListener('input', () => ((d.title = title.value), schedule()));
    subject.addEventListener('change', () => ((d.subject = subject.value), schedule()));
    topic.addEventListener('input', () => ((d.topic = topic.value), schedule()));
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
    // Quick insights: highlighted lines, gathered when the note is marked reviewed.
    const insightsHost = h('div', { class: 'insights-host', id: 'insights' });
    const paintInsights = () => {
      const ins = d.insights;
      insightsHost.replaceChildren();
      if (!ins?.items.length) return;
      const groups = groupInsights(ins);
      const when = new Date(ins.generatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const body = h(
        'div',
        { class: 'insights-body' },
        ...groups.map((g) =>
          h(
            'div',
            { class: 'insight-group' },
            groups.length > 1 ? h('span', { class: 'insight-section' }, g.section) : null,
            h('ul', { class: 'insight-list' }, ...g.texts.map((t) => h('li', {}, t)))
          )
        )
      );
      insightsHost.append(
        h(
          'details',
          { class: 'insights', open: true },
          h(
            'summary',
            {},
            h('span', { class: 'insights-title' }, 'Quick insights'),
            h('span', { class: 'insights-meta' }, `${ins.items.length} ${ins.items.length === 1 ? 'point' : 'points'} from your highlights · ${when}`)
          ),
          body
        )
      );
    };
    paintInsights();

    reviewBtn.addEventListener('click', () => {
      void logReviewDay();
      d.reviewCount += 1;
      d.lastReviewed = Date.now();
      d.nextReview = nextReviewAfter(d.reviewCount);
      const ins = extractInsights(d);
      if (ins.items.length) d.insights = ins;
      else delete d.insights;
      paintReview();
      paintInsights();
      dirty = true;
      void save();
      ctx.toast(
        ins.items.length
          ? `Next review ${prettyDate(d.nextReview)}. ${ins.items.length} quick ${ins.items.length === 1 ? 'insight' : 'insights'} added at the top.`
          : `Next review ${prettyDate(d.nextReview)}. Highlight key lines with Mark to get quick insights.`
      );
      if (ins.items.length) insightsHost.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    const trashBtn = h('button', { type: 'button', class: 'danger-outline', id: 'note-trash' }, 'Move to trash');
    trashBtn.addEventListener('click', async () => {
      d.deletedAt = Date.now();
      dirty = true;
      await save();
      ctx.toast(`Moved “${d.title || 'Untitled note'}” to Trash. Restore it from Trash if you need it.`);
      ctx.go('#/notes');
    });

    const back = h('a', { class: 'back-link', href: '#/notes' }, '← All notes');
    const styleSelect = h(
      'select',
      { id: 'note-style', class: 'style-select', 'aria-label': 'Font style for this note' },
      h('option', { value: '' }, 'App font style'),
      ...FONT_STYLES.map((f) => h('option', { value: f.id }, `${f.name} (this note)`))
    );
    styleSelect.value = d.fontStyle ?? '';
    styleSelect.addEventListener('change', () => {
      if (styleSelect.value) d.fontStyle = styleSelect.value;
      else delete d.fontStyle;
      applyNoteFont();
      schedule();
    });
    const notePdf = h('button', { type: 'button', id: 'note-pdf' }, 'Export note as PDF');
    notePdf.addEventListener('click', () => void runPdfExport({ kind: 'note', note: structuredClone(d) }, ctx, notePdf));

    editorEl.replaceChildren(
      h(
        'div',
        { class: 'editor' },
        h('div', { class: 'editor-top' }, back, styleSelect, notePdf),
        field('Title', null, title),
        insightsHost,
        h('div', { class: 'grid2' }, field('Subject', null, subject), field('Topic', null, topic)),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Notes'), toolbar.el, sectionsHost),
        field('Explain it in your own words', 'Write it as if teaching a friend who has never heard of it.', explain),
        field('Connect it', 'Where else does this appear in the syllabus? How would it change an answer?', connect),
        h('div', { class: 'review' }, reviewInfo, reviewBtn),
        h('div', { class: 'danger-zone' }, trashBtn)
      )
    );
    const editorBox = editorEl.firstElementChild as HTMLElement;
    const applyNoteFont = () => {
      for (const f of FONT_STYLES) editorBox.classList.remove(`font-${f.id}`);
      if (d.fontStyle) editorBox.classList.add(`font-${d.fontStyle}`);
    };
    applyNoteFont();
    renderSections(d, sectionsHost);
    if (isNew) title.focus();
    renderList();
  }

  async function open(id: string | null) {
    document.body.classList.toggle('editing', !!id);
    if (id && id !== 'new' && draft?.id === id) return; // already open (e.g. after the first save renamed the URL)
    // Take the old note off screen first, so nothing typed during the save lands in it.
    for (const ed of editors.values()) ed.setEditable(false);
    editorEl.replaceChildren();
    await closeNote();
    if (isNew && draft && id !== draft.id) isNew = false; // an untouched new note is simply dropped
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
    isNew = false;
    const n = await db.notes.get(id);
    if (!n || n.deletedAt) {
      draft = null;
      editorEl.replaceChildren(
        h(
          'div',
          { class: 'editor-empty' },
          h('h2', {}, 'Note not found'),
          h('p', {}, "This note isn't on this tablet."),
          h('a', { href: '#/notes' }, 'Back to all notes')
        )
      );
      return;
    }
    renderEditor(n);
    void setLastNote(n.id);
    ctx.status('Saved on this tablet');
  }

  return {
    route(parts) {
      if (parts[0] === 'notes' && parts[1] === 'due') setMode('due');
      if (parts[0] === 'notes' && parts[1] === 's' && parts[2]) {
        setMode('all');
        setSubject(decodeURIComponent(parts[2]));
      }
      void open(parts[0] === 'n' && parts[1] ? parts[1] : null);
    },
    async flush() {
      if (dirty) await save();
    },
    async destroy() {
      await closeNote();
      clearTimeout(retry);
      sub?.unsubscribe();
      vocabSub.unsubscribe();
      document.body.classList.remove('editing');
    }
  };
}
