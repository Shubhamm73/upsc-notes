import { liveQuery, type Subscription } from 'dexie';
import type { Editor } from '@tiptap/core';
import { db, newId, SUBJECTS, type DocNode, type Note, type Section, type Vocab } from '../db';
import { docToText, noteSearchText, textToDoc, wordCount } from '../lib/doc';
import { createEditor } from '../editor/editor';
import { createCanvasTools, reducedMotion } from '../editor/tools';
import { removeUnusedImages } from '../editor/images';
import { runPdfExport } from '../pdf/run';
import { extractInsights, groupInsights, sectionKeyLines } from '../lib/insights';
import { logReviewDay, setLastNote } from '../lib/activity';
import { subjectColor } from '../lib/subjects';
import { FONT_STYLES } from '../lib/prefs';
import { TEMPLATES, templateOf } from '../lib/templates';
import { closePopover, openPopover, type MenuItem } from '../lib/menu';
import { nextReviewAfter, prettyDate, ymd } from '../lib/dates';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import type { AppContext, View } from '../app';

type Mode = 'all' | 'due';

/** GS answer meter: marks at 150 and 250 words; the bar is full at 300. */
const METER_MAX = 300;

function blankNote(subject: string, templateId: string): Note {
  const now = Date.now();
  const t = templateOf(templateId);
  const note: Note = {
    id: newId(),
    subject,
    topic: '',
    title: '',
    sections: t.sections.map((heading) => ({ id: newId(), heading, doc: textToDoc('') })),
    explain: '',
    connect: '',
    nextReview: ymd(),
    reviewCount: 0,
    lastReviewed: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
  if (t.id !== 'blank') note.template = t.id;
  return note;
}

function isEmptyDoc(doc: DocNode): boolean {
  return !docToText(doc).trim() && (doc.content ?? []).every((n) => n.type === 'paragraph');
}

function saveErrorText(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'QuotaExceededError') {
    return 'Tablet storage is full, so this change is not saved. Free up space, then keep typing. Your text is still on screen.';
  }
  return "Couldn't save just now. Retrying in a few seconds. Your text is still on screen.";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  let openFrom: DOMRect | null = null;
  let focusMode = false;
  /** Collapsed sections of the open note (screen state only, not saved). */
  const collapsed = new Set<string>();
  const editors = new Map<string, Editor>();
  const tools = createCanvasTools({ noteId: () => draft?.id ?? '', toast: ctx.toast, onDone: () => void save() });
  /** Hooks into the open canvas; replaced each time a note opens. */
  let canvas: {
    setSave(state: 'editing' | 'saved' | 'error'): void;
    live(): void;
    setFocus(on: boolean): void;
  } | null = null;

  function destroyEditors() {
    for (const ed of editors.values()) {
      tools.detach(ed);
      ed.destroy();
    }
    editors.clear();
  }

  function setFocusMode(on: boolean) {
    focusMode = on;
    document.body.classList.toggle('focus-mode', on);
    canvas?.setFocus(on);
  }

  /** Called whenever a note is closed: saves, then clears out images nothing uses any more. */
  async function closeNote() {
    if (dirty) await save();
    const closing = draft;
    closePopover();
    setFocusMode(false);
    destroyEditors();
    canvas = null;
    // Only tidy up when everything is safely saved; a failed save keeps all images.
    if (closing && !dirty) void removeUnusedImages().catch(() => undefined);
  }

  // Ctrl + . focus mode; Esc closes a menu first, then leaves focus mode.
  const onKey = (e: KeyboardEvent) => {
    if (!draft || !canvas) return;
    if ((e.ctrlKey || e.metaKey) && e.key === '.') {
      e.preventDefault();
      setFocusMode(!focusMode);
      return;
    }
    if (e.key !== 'Escape') return;
    // One thing per press: an open menu first, then focus mode.
    if (tools.closeMenus() || closePopover()) {
      e.preventDefault();
      e.stopPropagation();
    } else if (focusMode) {
      e.preventDefault();
      e.stopPropagation();
      setFocusMode(false);
    }
  };
  // Capture phase: runs before the editor, which would otherwise swallow Esc.
  document.addEventListener('keydown', onKey, true);

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
  // Remember where the tapped card was, so the note can grow out of it (240 ms).
  listEl.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest('a.note-card:not(.word-card)');
    openFrom = card ? card.getBoundingClientRect() : null;
  });
  const wrap = h('div', { class: 'notes-layout is-notes' }, side, editorEl);
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
    for (const ed of editors.values()) ed.setEditable(false, false); // false: no 'update' event, so leaving a note never re-saves it
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
        noteSearchText(n).includes(filter.q)
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
    canvas?.setSave('editing');
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
        if (!dirty) {
          ctx.status('Saved on this tablet');
          canvas?.setSave('saved');
        }
      } catch (e) {
        dirty = true;
        ctx.status(saveErrorText(e), true);
        canvas?.setSave('error');
        clearTimeout(retry);
        retry = window.setTimeout(() => void save(), 5000);
      }
    });
    return chain;
  }

  // ---------- empty pane and template picker ----------
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

  function renderTemplatePicker() {
    draft = null;
    destroyEditors();
    const cards = TEMPLATES.map((t) => {
      const b = h(
        'button',
        { type: 'button', class: 'tpl-card', 'data-template': t.id },
        h('strong', {}, t.name),
        h('span', { class: 'tpl-hint' }, t.hint),
        h('span', { class: 'tpl-sections' }, t.sections.join(' · '))
      );
      b.addEventListener('click', () => {
        history.replaceState(null, '', `#/n/new/${t.id}`);
        startNew(t.id);
      });
      return b;
    });
    editorEl.replaceChildren(
      h(
        'div',
        { class: 'template-pick', id: 'template-pick' },
        h('a', { class: 'back-link', href: '#/notes' }, icon('back', 18), 'Notes'),
        h('h1', {}, 'New note'),
        h('p', { class: 'meta' }, 'Pick a shape for this note. You can change it later from the chip under the title.'),
        h('div', { class: 'tpl-grid' }, ...cards)
      )
    );
    cards[0].focus({ preventScroll: true });
  }

  function startNew(templateId: string) {
    isNew = true;
    renderEditor(blankNote(filter.subject !== 'All' ? filter.subject : SUBJECTS[0], templateId));
    ctx.status('New note');
  }

  // ---------- the writing canvas ----------
  function renderEditor(n: Note) {
    destroyEditors();
    closePopover();
    collapsed.clear();
    draft = structuredClone(n);
    const d = draft;
    let activeSection: string | null = null;

    // header
    const headMeta = h('span', { class: 'head-meta' });
    const paintHeadMeta = () => (headMeta.textContent = [d.subject, d.topic.trim()].filter(Boolean).join(' · '));
    const saveEl = h('span', { class: 'save-state', id: 'save-state', 'aria-hidden': 'true' }, h('span', { class: 'save-dot' }), h('span', { class: 'save-label' }));
    const keyPill = h('span', { class: 'key-pill', id: 'keyline-count' });
    const meterFill = h('span', { class: 'meter-fill' });
    const meterNum = h('span', { class: 'meter-num' });
    const meter = h(
      'div',
      { class: 'meter', id: 'answer-meter', role: 'meter', 'aria-label': 'Answer length in words', 'aria-valuemin': '0', 'aria-valuemax': '250', title: 'GS answers: aim for 150 or 250 words' },
      h('span', { class: 'meter-track' }, meterFill, h('span', { class: 'tick', style: `left: ${(150 / METER_MAX) * 100}%` }), h('span', { class: 'tick', style: `left: ${(250 / METER_MAX) * 100}%` })),
      meterNum
    );
    const focusBtn = h('button', { type: 'button', class: 'head-btn', id: 'focus-toggle', 'aria-pressed': 'false', title: 'Focus mode (Ctrl + .)' }, icon('focus', 18), h('span', { class: 'head-btn-text' }, 'Focus'));
    const reviewBtn = h('button', { type: 'button', class: 'primary head-review', id: 'mark-reviewed' }, 'Mark reviewed');
    const moreBtn = h('button', { type: 'button', class: 'icon-btn head-more', id: 'note-more', 'aria-label': 'More actions for this note', 'aria-haspopup': 'menu' }, icon('more', 22));
    const header = h(
      'header',
      { class: 'canvas-head' },
      h(
        'div',
        { class: 'head-row' },
        h('a', { class: 'back-link', href: '#/notes' }, icon('back', 18), 'Notes'),
        headMeta,
        h('span', { class: 'spacer' }),
        keyPill,
        meter,
        saveEl,
        focusBtn,
        reviewBtn,
        moreBtn
      ),
      tools.contextBar
    );
    const focusExit = h('button', { type: 'button', class: 'focus-exit', id: 'focus-exit' }, 'Exit focus');

    // title and chips
    const title = h('textarea', { id: 'f-title', class: 'canvas-title', rows: 1, placeholder: 'Title, e.g. Separation of powers', 'aria-label': 'Title', spellcheck: 'true' });
    title.value = d.title;
    const growTitle = () => {
      title.style.height = 'auto';
      title.style.height = `${title.scrollHeight}px`;
    };
    const subjDot = h('span', { class: 'dot' });
    const subject = h('select', { id: 'f-subject', class: 'chip-select', 'aria-label': 'Subject' }, ...SUBJECTS.map((s) => h('option', { value: s }, s)));
    if (!(SUBJECTS as readonly string[]).includes(d.subject)) subject.append(h('option', { value: d.subject }, d.subject));
    subject.value = d.subject;
    const topic = h('input', { id: 'f-topic', class: 'chip-input', placeholder: 'Add topic', 'aria-label': 'Topic', value: d.topic });
    const sizeTopic = () => (topic.size = Math.max(9, Math.min(40, topic.value.length + 1)));
    const template = h(
      'select',
      { id: 'f-template', class: 'chip-select', 'aria-label': 'Template' },
      ...TEMPLATES.map((t) => h('option', { value: t.id }, t.name))
    );
    template.value = templateOf(d.template).id;
    const reviewInfo = h('p', { class: 'review-info' });
    const chips = h(
      'div',
      { class: 'canvas-chips' },
      h('label', { class: 'chip-wrap subject-wrap' }, subjDot, subject),
      h('label', { class: 'chip-wrap' }, topic),
      h('label', { class: 'chip-wrap template-wrap' }, template),
      reviewInfo
    );
    const paintSubject = () => (subjDot.style.background = subjectColor(d.subject));

    // quick insights
    const insightsHost = h('div', { class: 'insights-host', id: 'insights' });
    const paintInsights = (fresh = false) => {
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
          { class: fresh ? 'insights fresh' : 'insights', open: true },
          h(
            'summary',
            {},
            h('span', { class: 'insights-title' }, 'Quick insights'),
            h('span', { class: 'insights-meta' }, `${plural(ins.items.length, 'point')} from your highlights · ${when}`)
          ),
          body
        )
      );
    };

    // sections and outline
    const sectionsHost = h('div', { class: 'sections', id: 'sections' });
    const outline = h('aside', { class: 'outline', id: 'outline', 'aria-label': 'Outline' });

    // details (tucked away)
    const explain = h('textarea', { id: 'f-explain', rows: 5 });
    explain.value = d.explain;
    const connect = h('textarea', { id: 'f-connect', rows: 4 });
    connect.value = d.connect;
    const styleSelect = h(
      'select',
      { id: 'note-style', class: 'style-select', 'aria-label': 'Font style for this note' },
      h('option', { value: '' }, 'App font style'),
      ...FONT_STYLES.map((f) => h('option', { value: f.id }, `${f.name} (this note)`))
    );
    styleSelect.value = d.fontStyle ?? '';
    const notePdf = h('button', { type: 'button', id: 'note-pdf' }, 'Export note as PDF');
    const trashBtn = h('button', { type: 'button', class: 'danger-outline', id: 'note-trash' }, 'Move to trash');
    const field = (label: string, hint: string | null, control: HTMLElement) =>
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, label, hint ? h('small', { class: 'hint' }, hint) : null), control);
    const details = h(
      'details',
      { class: 'note-details', id: 'details' },
      h('summary', {}, h('span', { class: 'details-title' }, 'Reflect and settings'), h('span', { class: 'meta' }, 'Own words · connections · font · PDF · trash')),
      h(
        'div',
        { class: 'details-body' },
        field('Explain it in your own words', 'Write it as if teaching a friend who has never heard of it.', explain),
        field('Connect it', 'Where else does this appear in the syllabus? How would it change an answer?', connect),
        h('div', { class: 'details-actions' }, styleSelect, notePdf, h('span', { class: 'spacer' }), trashBtn)
      )
    );
    const openDetails = (focus?: HTMLElement) => {
      details.open = true;
      (focus ?? details).scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      focus?.focus({ preventScroll: true });
    };

    const canvasEl = h(
      'div',
      { class: 'canvas editor' },
      header,
      h('div', { class: 'canvas-body' }, h('article', { class: 'canvas-col' }, title, chips, insightsHost, sectionsHost, details), outline),
      focusExit
    );
    editorEl.replaceChildren(canvasEl);
    new ResizeObserver(() => canvasEl.style.setProperty('--head-h', `${header.offsetHeight}px`)).observe(header);

    // ----- live numbers: key lines, words, meter, outline counts -----
    const countEls = new Map<string, HTMLElement[]>();
    const wordsEl = h('p', { class: 'ol-words', id: 'word-count' });
    let liveQueued = false;
    const live = () => {
      if (liveQueued) return;
      liveQueued = true;
      requestAnimationFrame(() => {
        liveQueued = false;
        const total = extractInsights(d).items.length;
        keyPill.textContent = plural(total, 'key line');
        keyPill.classList.toggle('has', total > 0);
        for (const s of d.sections) {
          const c = sectionKeyLines(s.doc).length;
          for (const el of countEls.get(s.id) ?? []) {
            el.textContent = c ? String(c) : '';
            el.title = plural(c, 'key line');
            el.setAttribute('aria-label', plural(c, 'key line'));
          }
        }
        const words = wordCount(d);
        wordsEl.textContent = plural(words, 'word');
        meter.hidden = d.template !== 'gs-answer';
        if (!meter.hidden) {
          meterNum.textContent = `${words} / 250`;
          meterFill.style.transform = `scaleX(${Math.min(words, METER_MAX) / METER_MAX})`;
          meter.dataset.zone = words > 250 ? 'over' : words >= 150 ? 'ok' : 'under';
          meter.setAttribute('aria-valuenow', String(words));
          meter.setAttribute('aria-valuetext', `${words} words${words > 250 ? ', over 250' : words >= 150 ? ', past 150' : ''}`);
        }
      });
    };

    // ----- save indicator: dot pulses while typing, ✓ when saved -----
    const setSave = (state: 'editing' | 'saved' | 'error') => {
      saveEl.dataset.state = state;
      (saveEl.lastElementChild as HTMLElement).textContent = state === 'editing' ? 'Saving' : state === 'saved' ? 'Saved' : 'Not saved';
      if (state === 'saved') {
        saveEl.firstElementChild!.replaceChildren(icon('check', 16));
      } else {
        saveEl.firstElementChild!.replaceChildren();
      }
    };

    // ----- sections -----
    const paintActive = () => {
      for (const row of outline.querySelectorAll<HTMLElement>('.outline-row')) row.classList.toggle('active', row.dataset.sectionId === activeSection);
    };

    const toggleCollapse = (id: string) => {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      const sec = sectionsHost.querySelector<HTMLElement>(`.note-section[data-section-id="${id}"]`);
      if (sec) {
        const isC = collapsed.has(id);
        sec.classList.toggle('collapsed', isC);
        (sec.querySelector('.section-body') as HTMLElement).hidden = isC;
        const b = sec.querySelector('.sec-collapse') as HTMLElement;
        b.setAttribute('aria-expanded', String(!isC));
        b.setAttribute('aria-label', `${isC ? 'Expand' : 'Collapse'} section ${d.sections.findIndex((s) => s.id === id) + 1}`);
      }
      renderOutline();
    };

    const moveSection = (from: number, to: number) => {
      if (from === to || to < 0 || to >= d.sections.length) return;
      const [s] = d.sections.splice(from, 1);
      d.sections.splice(to, 0, s);
      schedule();
      renderSections();
    };

    const deleteSection = (i: number) => {
      if (d.sections.length < 2) return;
      d.sections.splice(i, 1);
      schedule();
      renderSections();
      ctx.toast('Section deleted.');
    };

    const addSection = () => {
      const s: Section = { id: newId(), heading: '', doc: textToDoc('') };
      d.sections.push(s);
      schedule();
      renderSections();
      sectionsHost.querySelector<HTMLInputElement>(`.note-section[data-section-id="${s.id}"] .section-heading`)?.focus();
    };

    const sectionMenu = (i: number): MenuItem[] => {
      const s = d.sections[i];
      const isC = collapsed.has(s.id);
      return [
        { label: isC ? 'Expand section' : 'Collapse section', run: () => toggleCollapse(s.id) },
        { label: 'Move up', aria: `Move section ${i + 1} up`, disabled: i === 0, run: () => moveSection(i, i - 1) },
        { label: 'Move down', aria: `Move section ${i + 1} down`, disabled: i === d.sections.length - 1, run: () => moveSection(i, i + 1) },
        { label: 'Export section as PDF', aria: `Export section ${i + 1} as PDF`, run: () => void runPdfExport({ kind: 'section', note: structuredClone(d), sectionId: s.id }, ctx) },
        { label: 'Delete section', aria: `Delete section ${i + 1}`, danger: true, disabled: d.sections.length === 1, confirm: 'Tap again to delete', run: () => deleteSection(i) }
      ];
    };

    const jumpTo = (id: string) => {
      if (collapsed.has(id)) toggleCollapse(id);
      const sec = sectionsHost.querySelector<HTMLElement>(`.note-section[data-section-id="${id}"]`);
      sec?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      activeSection = id;
      paintActive();
    };

    function renderSections() {
      destroyEditors();
      if (!d.sections.length) d.sections.push({ id: newId(), heading: 'Notes', doc: textToDoc('') });
      countEls.clear();
      sectionsHost.replaceChildren();
      d.sections.forEach((s: Section, i: number) => {
        const isC = collapsed.has(s.id);
        const heading = h('input', { class: 'section-heading', 'aria-label': `Section ${i + 1} heading`, placeholder: 'Section heading', value: s.heading });
        heading.addEventListener('input', () => {
          s.heading = heading.value;
          schedule();
          const row = outline.querySelector(`.outline-row[data-section-id="${s.id}"] .ol-name`);
          if (row) row.textContent = s.heading.trim() || 'Untitled section';
          live();
        });
        const collapseBtn = h(
          'button',
          { type: 'button', class: 'sec-collapse', 'aria-expanded': String(!isC), 'aria-label': `${isC ? 'Expand' : 'Collapse'} section ${i + 1}` },
          icon('chevron', 18)
        );
        collapseBtn.addEventListener('click', () => toggleCollapse(s.id));
        const count = h('span', { class: 'sec-count' });
        countEls.set(s.id, [count]);
        const menuBtn = h('button', { type: 'button', class: 'sec-menu-btn', 'aria-label': `Section ${i + 1} options`, 'aria-haspopup': 'menu' }, icon('more', 20));
        menuBtn.addEventListener('click', () => openPopover(menuBtn, sectionMenu(i), `Section ${i + 1}`));
        heading.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            editors.get(s.id)?.commands.focus('start');
          }
        });
        const bodyEl = h('div', { class: 'section-body', 'data-section': s.id, hidden: isC });
        sectionsHost.append(
          h(
            'section',
            { class: isC ? 'note-section collapsed' : 'note-section', 'data-section-id': s.id },
            h('div', { class: 'section-head' }, collapseBtn, heading, count, menuBtn),
            bodyEl
          )
        );
        const ed = createEditor({
          element: bodyEl,
          content: s.doc,
          slash: tools.slash,
          onChange: (doc) => {
            s.doc = doc;
            schedule();
            live();
          },
          onFocus: (e) => {
            tools.setEditor(e);
            activeSection = s.id;
            paintActive();
          },
          onBlur: (e) => tools.onBlur(e)
        });
        editors.set(s.id, ed);
      });
      const add = h('button', { type: 'button', class: 'add-section', id: 'add-section' }, '+ Add section');
      add.addEventListener('click', addSection);
      sectionsHost.append(add);
      renderOutline();
      live();
    }

    function renderOutline() {
      const list = h('ol', { class: 'ol-list' });
      d.sections.forEach((s, i) => {
        const count = h('span', { class: 'ol-count' });
        const prev = countEls.get(s.id) ?? [];
        countEls.set(s.id, [prev[0], count].filter(Boolean) as HTMLElement[]);
        const jump = h(
          'button',
          { type: 'button', class: 'ol-jump', title: 'Tap to jump · long-press and drag to reorder' },
          h('span', { class: 'ol-grip', 'aria-hidden': 'true' }, icon('grip', 16)),
          h('span', { class: 'ol-name' }, s.heading.trim() || 'Untitled section'),
          collapsed.has(s.id) ? h('span', { class: 'ol-collapsed' }, 'folded') : null,
          count
        );
        const menuBtn = h('button', { type: 'button', class: 'ol-menu', 'aria-label': `Section ${i + 1} options`, 'aria-haspopup': 'menu' }, icon('more', 18));
        menuBtn.addEventListener('click', () => openPopover(menuBtn, sectionMenu(i), `Section ${i + 1}`));
        const row = h('li', { class: 'outline-row', 'data-section-id': s.id }, jump, menuBtn);
        attachDrag(list, row, jump, i, s.id);
        list.append(row);
      });
      const add = h('button', { type: 'button', class: 'ol-add' }, '+ Add section');
      add.addEventListener('click', addSection);
      const reflect = (label: string, target: HTMLTextAreaElement) => {
        const b = h('button', { type: 'button', class: 'ol-reflect', 'data-for': target.id }, h('span', { class: 'ol-reflect-icon' }), label);
        b.addEventListener('click', () => openDetails(target));
        return b;
      };
      outline.replaceChildren(
        h('p', { class: 'ol-title' }, 'Outline'),
        list,
        add,
        h('div', { class: 'spacer' }),
        h('p', { class: 'ol-title' }, 'Reflect'),
        reflect('In my own words', explain),
        reflect('Connect it to the syllabus', connect),
        wordsEl
      );
      paintActive();
      paintReflect();
      live();
    }

    /** ✓ next to "In my own words" / "Connect it" once they hold text. Updated in place, never re-rendered mid-tap. */
    function paintReflect() {
      for (const b of outline.querySelectorAll<HTMLElement>('.ol-reflect')) {
        const done = !!(b.dataset.for === 'f-explain' ? d.explain : d.connect).trim();
        if (b.classList.contains('done') === done && b.firstElementChild!.childElementCount) continue;
        b.classList.toggle('done', done);
        b.firstElementChild!.replaceChildren(icon(done ? 'check' : 'chevron', 16));
      }
    }

    /** Outline rows: tap jumps; long-press (450 ms) then drag reorders. */
    function attachDrag(list: HTMLElement, row: HTMLElement, jump: HTMLButtonElement, index: number, id: string) {
      let timer: number | undefined;
      let startY = 0;
      let dragging = false;
      let suppressClick = false;
      let rows: HTMLElement[] = [];
      let rects: DOMRect[] = [];
      let target = index;
      const begin = (pointerId: number) => {
        dragging = true;
        suppressClick = true;
        rows = [...list.children] as HTMLElement[];
        rects = rows.map((r) => r.getBoundingClientRect());
        try {
          jump.setPointerCapture(pointerId);
        } catch {
          /* pointer already gone */
        }
        row.classList.add('dragging');
        list.classList.add('sorting');
      };
      jump.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        startY = e.clientY;
        suppressClick = false;
        clearTimeout(timer);
        timer = window.setTimeout(() => begin(e.pointerId), 450);
      });
      jump.addEventListener('pointermove', (e) => {
        if (!dragging) {
          if (Math.abs(e.clientY - startY) > 8) clearTimeout(timer);
          return;
        }
        const dy = e.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        const me = rects[index];
        const center = me.top + me.height / 2 + dy;
        target = rects.filter((r, j) => j !== index && r.top + r.height / 2 < center).length;
        const step = me.height + (rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0);
        rows.forEach((r, j) => {
          if (j === index) return;
          const shift = index < target && j > index && j <= target ? -step : index > target && j < index && j >= target ? step : 0;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      });
      const end = () => {
        clearTimeout(timer);
        if (!dragging) return;
        dragging = false;
        list.classList.remove('sorting');
        rows.forEach((r) => (r.style.transform = ''));
        row.classList.remove('dragging');
        if (target !== index) {
          moveSection(index, target);
          ctx.toast('Section moved.');
        }
      };
      jump.addEventListener('pointerup', end);
      jump.addEventListener('pointercancel', end);
      jump.addEventListener('contextmenu', (e) => e.preventDefault());
      // Once dragging, the finger moves the row, not the page.
      row.addEventListener('touchmove', (e) => dragging && e.preventDefault(), { passive: false });
      jump.addEventListener('click', (e) => {
        if (suppressClick) {
          suppressClick = false;
          e.preventDefault();
          return;
        }
        jumpTo(id);
      });
    }

    // ----- field wiring -----
    title.addEventListener('input', () => {
      d.title = title.value.replace(/\s*\n\s*/g, ' ');
      growTitle();
      schedule();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editors.get(d.sections[0]?.id)?.commands.focus('start');
      }
    });
    subject.addEventListener('change', () => {
      d.subject = subject.value;
      paintSubject();
      paintHeadMeta();
      schedule();
    });
    topic.addEventListener('input', () => {
      d.topic = topic.value;
      sizeTopic();
      paintHeadMeta();
      schedule();
    });
    template.addEventListener('change', () => {
      const t = templateOf(template.value);
      if (t.id === 'blank') delete d.template;
      else d.template = t.id;
      let added: string[] = [];
      if (t.id !== 'blank') {
        const only = d.sections.length === 1 ? d.sections[0] : null;
        if (only && isEmptyDoc(only.doc) && ['', 'notes'].includes(only.heading.trim().toLowerCase())) {
          d.sections = t.sections.map((heading) => ({ id: newId(), heading, doc: textToDoc('') }));
          added = t.sections;
        } else {
          const have = new Set(d.sections.map((s) => s.heading.trim().toLowerCase()));
          added = t.sections.filter((x) => !have.has(x.toLowerCase()));
          for (const heading of added) d.sections.push({ id: newId(), heading, doc: textToDoc('') });
        }
      }
      schedule();
      renderSections();
      ctx.toast(added.length ? `${t.name}: added ${added.join(', ')}. Nothing was removed.` : `Template set to ${t.name}.`);
    });
    explain.addEventListener('input', () => {
      d.explain = explain.value;
      schedule();
      paintReflect();
    });
    connect.addEventListener('input', () => {
      d.connect = connect.value;
      schedule();
      paintReflect();
    });
    styleSelect.addEventListener('change', () => {
      if (styleSelect.value) d.fontStyle = styleSelect.value;
      else delete d.fontStyle;
      applyNoteFont();
      schedule();
    });
    const applyNoteFont = () => {
      for (const f of FONT_STYLES) canvasEl.classList.remove(`font-${f.id}`);
      if (d.fontStyle) canvasEl.classList.add(`font-${d.fontStyle}`);
    };
    notePdf.addEventListener('click', () => void runPdfExport({ kind: 'note', note: structuredClone(d) }, ctx, notePdf));
    const toTrash = async () => {
      d.deletedAt = Date.now();
      dirty = true;
      await save();
      ctx.toast(`Moved “${d.title || 'Untitled note'}” to Trash. Restore it from Trash if you need it.`);
      ctx.go('#/notes');
    };
    trashBtn.addEventListener('click', () => void toTrash());
    focusBtn.addEventListener('click', () => setFocusMode(!focusMode));
    focusExit.addEventListener('click', () => setFocusMode(false));
    moreBtn.addEventListener('click', () =>
      openPopover(
        moreBtn,
        [
          { label: 'Export note as PDF', run: () => void runPdfExport({ kind: 'note', note: structuredClone(d) }, ctx) },
          { label: 'Focus mode (Ctrl + .)', run: () => setFocusMode(true) },
          { label: 'Own words and connections', run: () => openDetails(explain) },
          { label: 'Font style for this note', run: () => openDetails(styleSelect) },
          { label: 'Move to trash', danger: true, run: () => void toTrash() }
        ],
        'Note actions'
      )
    );

    // ----- review -----
    const paintReview = () => {
      reviewInfo.textContent = d.reviewCount
        ? `Reviewed ${d.reviewCount} ${d.reviewCount === 1 ? 'time' : 'times'}. Next review ${prettyDate(d.nextReview)}.`
        : 'Not reviewed yet. Mark it once you can explain it without looking.';
    };
    reviewBtn.addEventListener('click', () => {
      // Remember where the highlighted lines are on screen, so they can fly up into Quick insights.
      const sources = reducedMotion()
        ? []
        : [...sectionsHost.querySelectorAll<HTMLElement>('.rich mark')]
            .map((m) => ({ text: (m.textContent ?? '').trim(), rect: m.getBoundingClientRect() }))
            .filter((s) => s.text && s.rect.bottom > 0 && s.rect.top < window.innerHeight)
            .slice(0, 10);
      void logReviewDay();
      d.reviewCount += 1;
      d.lastReviewed = Date.now();
      d.nextReview = nextReviewAfter(d.reviewCount);
      const ins = extractInsights(d);
      if (ins.items.length) d.insights = ins;
      else delete d.insights;
      paintReview();
      paintInsights(true);
      dirty = true;
      void save();
      ctx.toast(
        ins.items.length
          ? `Next review ${prettyDate(d.nextReview)}. ${plural(ins.items.length, 'quick insight')} added at the top.`
          : `Next review ${prettyDate(d.nextReview)}. Highlight key lines with Mark to get quick insights.`
      );
      if (!ins.items.length) return;
      const target = insightsHost.getBoundingClientRect();
      for (const s of sources) {
        const fly = h('div', { class: 'flyer', 'aria-hidden': 'true', style: `left:${s.rect.left}px;top:${s.rect.top}px;max-width:${Math.max(80, Math.min(s.rect.width, 420))}px` }, s.text);
        document.body.append(fly);
        const dx = target.left + 24 - s.rect.left;
        const dy = target.top + 20 - s.rect.top;
        fly
          .animate(
            [
              { transform: 'translate(0, 0) scale(1)', opacity: 1 },
              { transform: `translate(${dx}px, ${dy}px) scale(0.7)`, opacity: 0 }
            ],
            { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)' }
          )
          .finished.finally(() => fly.remove());
      }
      window.setTimeout(() => insightsHost.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }), sources.length ? 300 : 0);
    });

    canvas = {
      setSave,
      live,
      setFocus(on) {
        focusBtn.setAttribute('aria-pressed', String(on));
        if (on) (editors.get(activeSection ?? '') ?? editors.values().next().value)?.commands.focus();
      }
    };

    paintHeadMeta();
    paintSubject();
    sizeTopic();
    paintReview();
    paintInsights();
    applyNoteFont();
    renderSections();
    if (!isNew) setSave('saved');
    requestAnimationFrame(growTitle);
    if (isNew) title.focus();

    // The note grows out of the card that was tapped (240 ms).
    if (openFrom && !reducedMotion()) {
      const r = canvasEl.getBoundingClientRect();
      const s = Math.min(1, Math.max(0.25, openFrom.width / r.width));
      canvasEl.animate(
        [
          { transformOrigin: '0 0', transform: `translate(${openFrom.left - r.left}px, ${openFrom.top - r.top}px) scale(${s})`, opacity: 0.4 },
          { transformOrigin: '0 0', transform: 'none', opacity: 1 }
        ],
        { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
    openFrom = null;
    renderList();
  }

  async function open(id: string | null, templateId?: string) {
    document.body.classList.toggle('editing', !!id);
    if (id && id !== 'new' && draft?.id === id) return; // already open (e.g. after the first save renamed the URL)
    // Take the old note off screen first, so nothing typed during the save lands in it.
    for (const ed of editors.values()) ed.setEditable(false, false); // false: no 'update' event, so leaving a note never re-saves it
    editorEl.replaceChildren();
    // Leaving a new note: its last save must not rename the address of the page we are going to.
    // (An untouched new note is never saved, so it is simply dropped.)
    if (isNew && draft && id !== draft.id) isNew = false;
    await closeNote();
    if (!id) {
      renderEmptyEditor();
      renderList();
      return;
    }
    if (id === 'new') {
      if (templateId && TEMPLATES.some((t) => t.id === templateId)) startNew(templateId);
      else {
        isNew = false;
        renderTemplatePicker();
        ctx.status('');
      }
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
      void open(parts[0] === 'n' && parts[1] ? parts[1] : null, parts[2]);
    },
    async flush() {
      if (dirty) await save();
    },
    async destroy() {
      await closeNote();
      clearTimeout(retry);
      sub?.unsubscribe();
      vocabSub.unsubscribe();
      tools.destroy();
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('editing');
    }
  };
}
