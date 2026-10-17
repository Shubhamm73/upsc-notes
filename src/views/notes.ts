import { liveQuery, type Subscription } from 'dexie';
import type { Editor } from '@tiptap/core';
import { db, newId, type DocNode, type Folder, type Note, type Section, type Vocab } from '../db';
import { docToText, noteSearchText, textToDoc, wordCount } from '../lib/doc';
import { createEditor } from '../editor/editor';
import { setHeadingSet } from '../editor/heading-look';
import { COLOURS } from '../lib/looks';
import { allLooks, COVERS, defaultFor, HEADING_SET_INFO, HEADING_SETS, readLook, resolveLook, setLookDefault, type HeadingSet, type NoteLook } from '../lib/note-look';
import { createCanvasTools, reducedMotion } from '../editor/tools';
import { removeUnusedImages } from '../editor/images';
import { runPdfExport } from '../pdf/run';
import { extractInsights, groupInsights, sectionKeyLines } from '../lib/insights';
import { logReviewDay, milestoneText, setLastNote } from '../lib/activity';
import { buzz } from '../lib/haptics';
import { reviewNote } from '../lib/review';
import { ringOf } from '../lib/rings';
import { FOLDER_COLOURS, subjectKeyOf } from '../lib/folder-plan';
import { addMain, addSubject, canDelete, deleteFolder, folderContents, FolderIndex, homeFor, renameFolder, reorderFolders, setLastFolder } from '../lib/folders';
import { openSheet } from '../lib/sheet';
import { ago, crumbs, field, folderGrid, plural, type CardSpec } from './folder-ui';
import { celebrationsOn, FONT_STYLES, getPageWidth, outlineShown, setOutlineShown, setPageWidth } from '../lib/prefs';
import { NoteHistory } from '../editor/history';
import { allTemplates, isTemplateId, sectionDoc, TEMPLATE_GROUPS, templateOf, type NoteTemplate } from '../lib/templates';
import { deleteTemplate, liveSavedTemplates, nextTemplateName, renameTemplate, saveTemplate } from '../lib/my-templates';
import { closePopover, openPopover, type MenuItem } from '../lib/menu';
import { prettyDate, ymd } from '../lib/dates';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import type { AppContext, View } from '../app';
import { bigChange } from '../lib/changes';

/** GS answer meter: marks at 150 and 250 words; the bar is full at 300. */
const METER_MAX = 300;

/** Subjects offered when he adds one (a tap fills the name). */
const SUGGESTIONS: Record<string, string[]> = {
  'main:GS1': ['History', 'Art & Culture', 'Geography', 'Society'],
  'main:GS2': ['Polity', 'Governance', 'Social Justice', 'International Relations'],
  'main:GS3': ['Economy', 'Agriculture', 'Environment', 'Science & Tech', 'Security', 'Disaster Management'],
  'main:GS4': ['Ethics concepts', 'Thinkers', 'Case studies'],
  'main:Essay': ['Essay outlines', 'Quotes'],
  'main:Interview': ['DAF', 'Current issues'],
  'main:Current affairs': ['Schemes', 'Reports & indices'],
  'main:PSIR': ['Political theory', 'Indian politics', 'Comparative politics', 'International relations']
};

/** A small picture of a template: a bar per section, and a mark for what it starts with. */
function tplThumb(t: NoteTemplate): HTMLElement {
  const kind = (sec: NoteTemplate['sections'][number]): string | null => {
    const first = sec.make?.().content?.find((n) => n.type !== 'paragraph');
    if (!first) return null;
    if (first.type === 'table') return 'table';
    if (first.type === 'callout') return 'callout';
    if (first.type === 'panel') return first.attrs?.kind === 'columns' ? 'columns' : 'panel';
    if (first.type.endsWith('List')) return 'list';
    return 'figure';
  };
  return h(
    'span',
    { class: 'tpl-thumb', 'aria-hidden': 'true' },
    ...t.sections.slice(0, 6).map((sec) => {
      const k = kind(sec);
      return h('span', { class: 'tt-sec' }, h('i', {}), k ? h('b', { 'data-k': k }) : h('u', {}));
    })
  );
}

function blankNote(place: { folderId?: string; subject: string }, templateId: string): Note {
  const now = Date.now();
  const t = templateOf(templateId);
  const note: Note = {
    id: newId(),
    ...place,
    topic: '',
    title: '',
    sections: t.sections.map((sec) => ({ id: newId(), heading: sec.heading, doc: sectionDoc(sec) })),
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

export function mountNotes(root: HTMLElement, ctx: AppContext): View {
  const filter = { q: '' };
  let notes: Note[] = [];
  let index = new FolderIndex([]);
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
  /** Editors of the open note's sections, by section id. */
  const editors = new Map<string, Editor>();
  /** Each section's DOM and editor; kept while the note is open so moving a section keeps its Undo history. */
  interface SectionView {
    el: HTMLElement;
    editor: Editor;
    heading: HTMLInputElement;
    collapseBtn: HTMLElement;
    menuBtn: HTMLElement;
    count: HTMLElement;
    untrack: () => void;
  }
  const views = new Map<string, SectionView>();
  /** Deleted sections, kept until the note closes so Undo can bring them back as they were. */
  const parked = new Map<string, SectionView>();
  /** Note-wide Undo / Redo of the open note. */
  let hist: NoteHistory | null = null;
  const tools = createCanvasTools({
    noteId: () => draft?.id ?? '',
    toast: ctx.toast,
    onDone: () => void save(),
    history: {
      undo: () => hist?.undo(),
      redo: () => hist?.redo(),
      canUndo: () => !!hist?.canUndo(),
      canRedo: () => !!hist?.canRedo()
    }
  });
  /** Hooks into the open canvas; replaced each time a note opens. */
  let canvas: {
    setSave(state: 'editing' | 'saved' | 'error'): void;
    live(): void;
    setFocus(on: boolean): void;
    /** Repaints where the note is filed (folders renamed, recoloured or loaded). */
    place(): void;
  } | null = null;

  function destroyEditors() {
    for (const v of [...views.values(), ...parked.values()]) {
      v.untrack();
      tools.detach(v.editor);
      v.editor.destroy();
    }
    views.clear();
    parked.clear();
    editors.clear();
    hist = null;
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
    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: the note-wide Undo / Redo, wherever the caret is in the note.
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !t.closest('.canvas, #touchbar, #bubble')) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'y' || e.shiftKey) hist?.redo();
      else hist?.undo();
      return;
    }
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

  // ---------- layout: browsing folders (Notes › main subject › subject) ----------
  const listEl = h('ul', { class: 'note-list', id: 'note-list' });
  const search = h('input', { id: 'search', type: 'search', placeholder: 'Search notes and vocabulary', 'aria-label': 'Search notes and vocabulary' });
  const side = h('aside', { class: 'pane-list browse', 'aria-label': 'Notes' });
  const editorEl = h('section', { class: 'pane-editor', 'aria-label': 'Note' });
  // Remember where the tapped card was, so the note can grow out of it (240 ms).
  side.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest('a.note-card:not(.word-card)');
    openFrom = card ? card.getBoundingClientRect() : null;
  });
  const wrap = h('div', { class: 'notes-layout is-notes' }, side, editorEl);
  root.replaceChildren(wrap);

  /** Where the browser is: the main subjects, one folder (main subject or subject), or the due list. */
  let where: { level: 'root' } | { level: 'folder'; id: string } | { level: 'due' } = { level: 'root' };
  let editMode = false;
  /** A subject he just opened becomes "the last subject used" (where New note goes from elsewhere). */
  let visiting: string | null = null;
  search.addEventListener('input', () => {
    filter.q = search.value.trim().toLowerCase();
    renderList();
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
  const folderSub = liveQuery(() => db.folders.toArray()).subscribe({
    next: (rows) => {
      index = new FolderIndex(rows);
      renderList();
      canvas?.place();
    }
  });

  const folderHref = (id: string) => `#/notes/f/${encodeURIComponent(id)}`;
  const placeLabel = (id: string) => {
    const f = index.get(id);
    const m = index.get(f?.parent);
    return f && m ? `${m.name} › ${f.name}` : 'GS1 › General';
  };
  const notesIn = (ids: Set<string>) => notes.filter((n) => ids.has(index.noteFolder(n)));

  function noteCard(n: Note, today: string, extraClass = '') {
    const isDue = n.nextReview <= today;
    return h(
      'li',
      {},
      h(
        'a',
        { class: `note-card${extraClass}`, href: `#/n/${n.id}`, 'aria-current': draft?.id === n.id ? 'true' : undefined },
        h('strong', {}, n.title || 'Untitled note'),
        h('span', { class: 'meta' }, h('span', { class: 'dot', style: `background: ${index.noteColour(n)}` }), [index.label(n), n.topic].filter(Boolean).join(' · ')),
        h(
          'span',
          { class: isDue ? 'meta due' : 'meta' },
          (isDue ? 'Review today' : `Next review ${prettyDate(n.nextReview)}`) +
            (n.insights?.items.length ? ` · ${n.insights.items.length} quick ${n.insights.items.length === 1 ? 'insight' : 'insights'}` : '')
        )
      )
    );
  }

  // ---------- list ----------
  function renderList() {
    const today = ymd();
    const due = notes.filter((n) => n.nextReview <= today);
    let folder = where.level === 'folder' ? index.get(where.id) : undefined;
    if (where.level === 'folder' && folder && (folder.deletedAt || folder.kind !== 'notes')) folder = undefined;
    const main = folder ? (folder.parent ? index.get(folder.parent) : folder) : undefined;
    const isSubject = !!folder?.parent;
    const colour = folder ? index.colour(folder) : '';

    // breadcrumb and heading
    const path = [{ label: 'Notes', href: '#/notes' }];
    if (where.level === 'due') path.push({ label: 'Due today', href: '#/notes/due' });
    if (main) path.push({ label: main.name, href: folderHref(main.id) });
    if (folder && isSubject) path.push({ label: folder.name, href: folderHref(folder.id) });
    const title = h('h1', { style: folder ? `color: ${colour}` : undefined }, where.level === 'due' ? 'Due today' : folder ? folder.name : 'Notes');
    const head = h('div', { class: 'browse-head' }, title, h('span', { class: 'spacer' }));
    const canEdit = where.level === 'root' || (folder && !isSubject);
    if (where.level === 'root') {
      head.append(
        h('a', { class: `due-count${due.length ? ' is-due' : ''}`, href: '#/notes/due', id: 'due-link' }, due.length ? `${due.length} due today` : 'Nothing due today')
      );
    }
    if (canEdit) {
      const editBtn = h('button', { type: 'button', id: 'folder-edit', 'aria-pressed': String(editMode) }, icon(editMode ? 'check' : 'edit', 20), editMode ? 'Done' : 'Edit');
      editBtn.addEventListener('click', () => {
        editMode = !editMode;
        renderList();
      });
      head.append(editBtn);
    }
    const newBtn = h('button', { type: 'button', class: `primary${isSubject ? ' big' : ''}`, id: 'new-note' }, icon('plus', 20), 'New note');
    newBtn.addEventListener('click', () => {
      if (isSubject && folder) setLastFolder(folder.id);
      if (location.hash === '#/n/new') return; // already on a fresh one
      for (const ed of editors.values()) ed.setEditable(false, false); // false: no 'update' event, so leaving a note never re-saves it
      editorEl.replaceChildren(); // the previous note leaves at once; its unsaved text is still saved from memory
      ctx.go('#/n/new');
    });
    head.append(newBtn);
    const parts: HTMLElement[] = [crumbs(path), head];
    listEl.replaceChildren();

    if (where.level === 'folder' && !folder) {
      parts.push(h('p', { class: 'empty-row' }, index.byId.size ? "This folder isn't here any more. " : 'Loading… ', h('a', { href: '#/notes' }, 'All subjects')));
    } else if (where.level === 'root') {
      parts.push(search);
      if (filter.q) {
        renderSearch(today);
        parts.push(listEl);
      } else {
        const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
        if (recent.length) parts.push(h('section', { class: 'recent', 'aria-label': 'Recent notes' }, h('h2', { class: 'eyebrow' }, 'Recent'), h('ul', { class: 'recent-row', id: 'recent' }, ...recent.map((n) => noteCard(n, today, ' recent-card')))));
        parts.push(mainGrid(today));
      }
    } else if (where.level === 'due') {
      for (const n of [...due].sort((a, b) => a.nextReview.localeCompare(b.nextReview))) listEl.append(noteCard(n, today));
      if (!due.length) listEl.append(h('li', { class: 'empty-row' }, 'Nothing due for review today.'));
      parts.push(listEl);
    } else if (folder && !isSubject) {
      const subs = index.children(folder.id);
      parts.push(h('p', { class: 'meta browse-meta' }, `${plural(notesIn(new Set(subs.map((s) => s.id))).length, 'note')} in ${plural(subs.length, 'subject')}${editMode ? ' · drag the handle to reorder' : ''}`));
      parts.push(subjectGrid(folder, subs, today));
    } else if (folder) {
      if (visiting === folder.id) {
        setLastFolder(folder.id);
        visiting = null;
      }
      const list = notesIn(new Set([folder.id])).sort((a, b) => b.updatedAt - a.updatedAt);
      const start = h('div', { class: 'tpl-row' }, h('span', { class: 'meta' }, 'Start from:'));
      for (const id of ['gs-answer', 'topic-sheet', 'current-affairs', 'blank']) start.append(h('a', { class: 'chip-link', href: `#/n/new/${id}`, 'data-template': id }, templateOf(id).name));
      start.append(h('a', { class: 'tpl-more', href: '#/n/new', id: 'all-templates' }, 'All templates'));
      parts.push(start);
      for (const n of list) listEl.append(noteCard(n, today));
      if (!list.length) listEl.append(h('li', { class: 'empty-row' }, `No notes in ${folder.name} yet. Tap New note, or pick a template above.`));
      parts.push(listEl);
    }
    side.replaceChildren(...parts);
  }

  function renderSearch(today: string) {
    const items = notes.filter((n) => noteSearchText(n).includes(filter.q) || index.label(n).toLowerCase().includes(filter.q)).sort((a, b) => b.updatedAt - a.updatedAt);
    // Search also covers vocabulary, listed under the notes.
    const wordHits = words
      .filter((w) => [w.word, w.meaning, ...w.synonyms, ...w.antonyms, ...w.uses.map((u) => u.sentence)].join(' ').toLowerCase().includes(filter.q))
      .sort((a, b) => a.word.localeCompare(b.word));
    for (const n of items) listEl.append(noteCard(n, today));
    if (!items.length) listEl.append(h('li', { class: 'empty-row' }, wordHits.length ? 'No notes match. Matching words:' : 'No notes match this search.'));
    if (wordHits.length) {
      listEl.append(h('li', { class: 'list-divider' }, `Vocabulary · ${wordHits.length}`));
      for (const w of wordHits) {
        listEl.append(h('li', {}, h('a', { class: 'note-card word-card', href: `#/v/${w.id}` }, h('strong', {}, w.word || 'Untitled word'), h('span', { class: 'meta' }, w.meaning || '—'))));
      }
    }
  }

    /** Badge on a main subject's card: GS1, CA (Current affairs), ES (Essay). */
  const shortLabel = (name: string) => {
    if (name.length <= 3) return name;
    const words = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words.map((w) => w[0]).join('') : name).slice(0, 2).toUpperCase();
  };

  function mainGrid(today: string) {
    const cards: CardSpec[] = index.roots('notes').map((m) => {
      const subs = index.children(m.id);
      const list = notesIn(new Set(subs.map((s) => s.id)));
      return {
        id: m.id,
        href: folderHref(m.id),
        name: m.name,
        colour: index.colour(m),
        badge: shortLabel(m.name),
        sub: subs.map((s) => s.name).join(', ') || 'No subjects yet',
        count: plural(list.length, 'note'),
        due: list.filter((n) => n.nextReview <= today).length,
        pct: ringOf(list, today),
        deletable: canDelete(index, m)
      };
    });
    return folderGrid({
      cards,
      editing: editMode,
      addLabel: 'Add main subject',
      onAdd: addMainDialog,
      onRename: (id, name) => void renameFolder(id, name),
      onDelete: (id) => void deleteDialog(id),
      onReorder: (ids) => void reorderFolders(ids)
    });
  }

  function subjectGrid(main: Folder, subs: Folder[], today: string) {
    const cards: CardSpec[] = subs.map((s) => {
      const list = notesIn(new Set([s.id]));
      const last = list.reduce((m, n) => Math.max(m, n.updatedAt), 0);
      return {
        id: s.id,
        href: folderHref(s.id),
        name: s.name,
        colour: index.colour(main),
        badge: icon('folder', 22),
        sub: last ? `Last edited ${ago(last)}` : 'No notes yet',
        count: plural(list.length, 'note'),
        due: list.filter((n) => n.nextReview <= today).length,
        pct: ringOf(list, today),
        deletable: canDelete(index, s)
      };
    });
    return folderGrid({
      cards,
      editing: editMode,
      addLabel: 'Add subject',
      onAdd: () => addSubjectDialog(main),
      onRename: (id, name) => void renameFolder(id, name),
      onDelete: (id) => void deleteDialog(id),
      onReorder: (ids) => void reorderFolders(ids)
    });
  }

  function addMainDialog() {
    const name = h('input', { id: 'folder-name', placeholder: 'e.g. Prelims', maxlength: 60, autocomplete: 'off' });
    let colour = FOLDER_COLOURS.find((c) => !index.roots('notes').some((m) => m.colour === c)) ?? 'blue';
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' });
    const paint = () => {
      for (const b of swatches.children) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.colour === colour));
    };
    FOLDER_COLOURS.forEach((c, i) => {
      const b = h('button', { type: 'button', class: 'swatch', 'data-colour': c, style: `--c: var(--sub-${c})`, 'aria-label': `Colour ${i + 1}` });
      b.addEventListener('click', () => {
        colour = c;
        paint();
      });
      swatches.append(b);
    });
    paint();
    openSheet({
      title: 'Add main subject',
      id: 'folder-dialog',
      body: [field('Name', name), h('span', { class: 'sheet-label' }, 'Colour'), swatches, h('p', { class: 'meta' }, 'It starts with one subject, General. Add more inside it.')],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Add',
          id: 'folder-save',
          primary: true,
          run: async () => {
            const v = name.value.trim();
            if (!v) {
              name.focus();
              return false;
            }
            await addMain(v, colour);
          }
        }
      ]
    });
  }

  function addSubjectDialog(main: Folder) {
    const name = h('input', { id: 'folder-name', placeholder: 'e.g. History', maxlength: 60, autocomplete: 'off' });
    const have = new Set(index.children(main.id).map((s) => s.name.toLowerCase()));
    const ideas = (SUGGESTIONS[main.id] ?? []).filter((s) => !have.has(s.toLowerCase()));
    const chipsEl = h('div', { class: 'suggest' });
    for (const s of ideas) {
      const b = h('button', { type: 'button', class: 'chip-btn' }, s);
      b.addEventListener('click', () => {
        name.value = s;
        name.focus();
      });
      chipsEl.append(b);
    }
    openSheet({
      title: `Add subject to ${main.name}`,
      id: 'folder-dialog',
      body: [field('Name', name), ...(ideas.length ? [h('span', { class: 'sheet-label' }, 'Ideas'), chipsEl] : [])],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Add',
          id: 'folder-save',
          primary: true,
          run: async () => {
            const v = name.value.trim();
            if (!v) {
              name.focus();
              return false;
            }
            await addSubject(main.id, v);
          }
        }
      ]
    });
  }

  async function deleteDialog(id: string) {
    const f = index.get(id);
    if (!f) return;
    const c = await folderContents(id);
    const what = [c.subfolders ? plural(c.subfolders, 'subject') : '', plural(c.notes, 'note')].filter(Boolean).join(' and ');
    const one = c.subfolders + c.notes === 1;
    openSheet({
      title: `Delete “${f.name}”?`,
      id: 'folder-delete',
      body: [
        h(
          'p',
          {},
          c.notes || c.subfolders
            ? `Its ${what} ${one ? 'goes' : 'go'} to Trash. You can restore ${one ? 'it' : 'them'} for 30 days. Nothing is deleted for good from here.`
            : 'It has no notes. You can make it again any time.'
        )
      ],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Move to Trash',
          id: 'folder-delete-confirm',
          danger: true,
          run: async () => {
            const r = await deleteFolder(id);
            ctx.toast(r.notes ? `Deleted “${f.name}”. ${plural(r.notes, 'note')} ${r.notes === 1 ? 'is' : 'are'} in Trash for 30 days.` : `Deleted “${f.name}”.`);
          }
        }
      ]
    });
  }

  /** Move to…: every subject, grouped by main subject. */
  function moveSheet(current: string, pick: (id: string) => void) {
    const list = h('div', { class: 'sheet-list move-list' });
    for (const { main, subjects } of index.subjectsByMain()) {
      const row = h('div', { class: 'move-subs' });
      list.append(h('div', { class: 'move-group' }, h('h3', { class: 'move-main' }, h('span', { class: 'dot', style: `background: ${index.colour(main)}` }), main.name), row));
      for (const s of subjects) {
        const b = h('button', { type: 'button', class: 'move-opt', 'data-folder': s.id, 'aria-current': s.id === current ? 'true' : undefined }, s.name, s.id === current ? icon('check', 18) : null);
        b.addEventListener('click', () => {
          close();
          if (s.id !== current) pick(s.id);
        });
        row.append(b);
      }
    }
    const close = openSheet({ title: 'Move to…', id: 'move-sheet', body: [list], actions: [{ label: 'Cancel' }] });
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
          bigChange('new note');
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
    const pick = (t: NoteTemplate) => {
      history.replaceState(null, '', `#/n/new/${t.id}`);
      startNew(t.id);
    };
    const card = (t: NoteTemplate) => {
      const b = h(
        'button',
        { type: 'button', class: 'tpl-card', 'data-template': t.id, 'data-group': t.group },
        tplThumb(t),
        h('strong', {}, t.name),
        h('span', { class: 'tpl-hint' }, t.hint),
        h('span', { class: 'tpl-sections' }, t.sections.map((x) => x.heading).join(' · ')),
        t.blocks?.length ? h('span', { class: 'tpl-blocks' }, `Comes with: ${t.blocks.join(', ')}`) : null
      );
      b.addEventListener('click', () => pick(t));
      return b;
    };
    const mineHost = h('section', { class: 'tpl-group', id: 'my-templates' });
    const paintMine = () => {
      const mine = liveSavedTemplates();
      mineHost.hidden = !mine.length;
      mineHost.replaceChildren(
        h('h2', {}, 'My templates'),
        h(
          'div',
          { class: 'tpl-grid' },
          ...mine.map((x) => {
            const t = templateOf(x.id);
            const menu = h('button', { type: 'button', class: 'tpl-menu icon-btn', 'aria-label': `Options for ${x.name}`, 'data-template-menu': x.id }, icon('more', 18));
            menu.addEventListener('click', (e) => {
              e.stopPropagation();
              openPopover(
                menu,
                [
                  {
                    label: 'Rename',
                    run: () => {
                      const input = h('input', { id: 'tpl-name', 'aria-label': 'Template name', value: x.name, maxlength: 60 });
                      openSheet({
                        title: 'Rename template',
                        id: 'tpl-rename',
                        body: [input],
                        actions: [
                          { label: 'Cancel' },
                          {
                            label: 'Rename',
                            primary: true,
                            run: async () => {
                              await renameTemplate(x.id, input.value);
                              paintMine();
                            }
                          }
                        ]
                      });
                      requestAnimationFrame(() => input.select());
                    }
                  },
                  {
                    label: 'Delete',
                    danger: true,
                    run: () =>
                      openSheet({
                        title: `Delete “${x.name}”?`,
                        id: 'tpl-delete',
                        body: [h('p', {}, 'Notes made from it stay as they are. Only the template goes.')],
                        actions: [
                          { label: 'Keep it' },
                          {
                            label: 'Delete template',
                            danger: true,
                            run: async () => {
                              await deleteTemplate(x.id);
                              paintMine();
                              ctx.toast(`Deleted template “${x.name}”.`);
                            }
                          }
                        ]
                      })
                  }
                ],
                'Template options'
              );
            });
            return h('div', { class: 'tpl-mine' }, card(t), menu);
          })
        )
      );
    };
    paintMine();
    const saveTile = h(
      'div',
      { class: 'tpl-save-hint', id: 'tpl-save-hint' },
      h('strong', {}, 'Save this note as a template'),
      h('span', { class: 'meta' }, 'Open a note you like, then ⋯ → Save as template. Its sections, headings, containers and tables come back here, emptied.')
    );
    editorEl.replaceChildren(
      h(
        'div',
        { class: 'template-pick', id: 'template-pick' },
        h('a', { class: 'back-link', href: '#/notes' }, icon('back', 18), 'Notes'),
        h('h1', {}, 'New note'),
        h('p', { class: 'meta' }, 'Pick a shape for this note. You can change it later from the chip under the title.'),
        h('p', { class: 'meta', id: 'new-place' }, `It goes in ${placeLabel(homeFor(index))}. Move it any time from the chip under the title.`),
        ...TEMPLATE_GROUPS.map((g) => h('section', { class: 'tpl-group', 'data-group': g }, h('h2', {}, g), h('div', { class: 'tpl-grid' }, ...allTemplates().filter((t) => t.group === g).map(card)))),
        mineHost,
        saveTile
      )
    );
    editorEl.querySelector<HTMLElement>('.tpl-card')?.focus({ preventScroll: true });
  }

  function startNew(templateId: string) {
    isNew = true;
    const folderId = homeFor(index);
    const main = index.get(index.get(folderId)?.parent);
    renderEditor(blankNote(main ? { folderId, subject: subjectKeyOf(main) } : { subject: 'GS1' }, templateId));
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
    // ← goes up one level: to the note's subject
    const backText = h('span', {}, 'Notes');
    const backLink = h('a', { class: 'back-link', id: 'note-back', href: '#/notes' }, icon('back', 18), backText);
    const paintHeadMeta = () => (headMeta.textContent = d.topic.trim());
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
    const undoBtn = h('button', { type: 'button', class: 'icon-btn head-undo', id: 'note-undo', 'aria-label': 'Undo', title: 'Undo (Ctrl + Z)', disabled: true }, icon('undo', 22));
    const redoBtn = h('button', { type: 'button', class: 'icon-btn head-undo', id: 'note-redo', 'aria-label': 'Redo', title: 'Redo (Ctrl + Shift + Z)', disabled: true }, icon('redo', 22));
    // Undo / Redo keep the caret and the keyboard where they are.
    for (const b of [undoBtn, redoBtn]) b.addEventListener('pointerdown', (e) => e.preventDefault());
    undoBtn.addEventListener('click', () => hist?.undo());
    redoBtn.addEventListener('click', () => hist?.redo());
    const outlineBtn = h('button', { type: 'button', class: 'icon-btn head-outline', id: 'outline-toggle', 'aria-label': 'Outline', title: 'Show or hide the outline' }, icon('sidebar', 22));
    const paintOutlineBtn = () => outlineBtn.setAttribute('aria-pressed', String(outlineShown()));
    const toggleOutline = () => {
      setOutlineShown(!outlineShown());
      paintOutlineBtn();
    };
    outlineBtn.addEventListener('click', toggleOutline);
    paintOutlineBtn();
    const reviewBtn = h('button', { type: 'button', class: 'primary head-review', id: 'mark-reviewed' }, 'Mark reviewed');
    const moreBtn = h('button', { type: 'button', class: 'icon-btn head-more', id: 'note-more', 'aria-label': 'More actions for this note', 'aria-haspopup': 'menu' }, icon('more', 22));
    const header = h(
      'header',
      { class: 'canvas-head' },
      h(
        'div',
        { class: 'head-row' },
        backLink,
        headMeta,
        h('span', { class: 'spacer' }),
        keyPill,
        meter,
        saveEl,
        h('span', { class: 'undo-group', role: 'group', 'aria-label': 'Undo and redo' }, undoBtn, redoBtn),
        outlineBtn,
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
    const subjText = h('span', {});
    const subject = h('button', { type: 'button', id: 'f-subject', class: 'chip-select chip-place', 'aria-haspopup': 'dialog', title: 'Move to another subject' }, subjDot, subjText);
    const topic = h('input', { id: 'f-topic', class: 'chip-input', placeholder: 'Add topic', 'aria-label': 'Topic', value: d.topic });
    const sizeTopic = () => (topic.size = Math.max(9, Math.min(40, topic.value.length + 1)));
    const template = h(
      'select',
      { id: 'f-template', class: 'chip-select', 'aria-label': 'Template' },
      ...[...TEMPLATE_GROUPS, 'My templates' as const].map((g) => {
        const list = allTemplates().filter((t) => t.group === g);
        return list.length ? h('optgroup', { label: g }, ...list.map((t) => h('option', { value: t.id }, t.name))) : null;
      })
    );
    template.value = templateOf(d.template).id;
    const reviewInfo = h('p', { class: 'review-info' });
    const chips = h(
      'div',
      { class: 'canvas-chips' },
      h('span', { class: 'chip-wrap subject-wrap' }, subject),
      h('label', { class: 'chip-wrap' }, topic),
      h('label', { class: 'chip-wrap template-wrap' }, template),
      reviewInfo
    );
    const paintSubject = () => {
      const { sub, main } = index.placeOf(d);
      subjDot.style.background = index.noteColour(d);
      // headings, containers and tables that follow the subject colour (0.12); a Split heading shows the main subject
      canvasEl.style.setProperty('--subj', index.noteColour(d));
      canvasEl.style.setProperty('--subj-name', JSON.stringify(main?.name ?? 'Notes'));
      subjText.textContent = index.label(d);
      subject.setAttribute('aria-label', `Subject: ${index.label(d)}. Move to…`);
      backLink.href = sub ? folderHref(sub.id) : '#/notes';
      backText.textContent = sub ? index.label(d) : 'Notes';
      paintLook();
      // charts, diagrams and mind maps that follow the subject colour redraw (0.13)
      window.dispatchEvent(new Event('subjectchange'));
    };
    // note look (0.14): cover, heading set, accent and font; own look, else the subject's or everywhere default
    const cover = h('div', { class: 'note-cover', id: 'note-cover', 'aria-hidden': 'true', hidden: true });
    let curSet: HeadingSet = 'classic';
    const lookFolders = () => {
      const { sub, main } = index.placeOf(d);
      return [sub?.id ?? index.noteFolder(d), main?.id];
    };
    const paintLook = (preview?: { look: NoteLook; font: string | null }) => {
      const { look, font } = preview ?? resolveLook(d, lookFolders());
      const subj = index.noteColour(d);
      canvasEl.style.setProperty('--subj', look.accent ? `var(--sub-${look.accent})` : subj);
      if (look.headings === 'classic') delete canvasEl.dataset.hset;
      else canvasEl.dataset.hset = look.headings;
      cover.hidden = look.cover === 'none';
      cover.dataset.cover = look.cover;
      cover.style.setProperty('--cover', look.cover === 'subject' ? subj : look.accent ? `var(--sub-${look.accent})` : 'var(--accent)');
      curSet = look.headings;
      for (const ed of editors.values()) setHeadingSet(ed, curSet);
      for (const f of FONT_STYLES) canvasEl.classList.remove(`font-${f.id}`);
      if (font) canvasEl.classList.add(`font-${font}`);
    };

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
      h('div', { class: 'canvas-body' }, h('article', { class: 'canvas-col' }, cover, title, chips, insightsHost, sectionsHost, details), outline),
      focusExit
    );
    editorEl.replaceChildren(canvasEl);
    new ResizeObserver(() => canvasEl.style.setProperty('--head-h', `${header.offsetHeight}px`)).observe(header);

    // ----- Undo / Redo for the whole note -----
    const paintUndo = () => {
      undoBtn.disabled = !noteHist.canUndo();
      redoBtn.disabled = !noteHist.canRedo();
      tools.refresh();
    };
    /** Brings a section's change into view after Undo / Redo (without opening the keyboard). */
    const reveal = (id: string, ed: Editor) => {
      if (collapsed.has(id)) toggleCollapse(id);
      requestAnimationFrame(() => {
        try {
          const at = ed.view.domAtPos(ed.state.selection.head).node;
          const el = (at.nodeType === 3 ? at.parentElement : at) as HTMLElement | null;
          const r = el?.getBoundingClientRect();
          const top = header.getBoundingClientRect().bottom;
          if (el && r && (r.bottom < top + 8 || r.top > window.innerHeight - 8)) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        } catch {
          /* nothing to show */
        }
      });
    };
    const noteHist = new NoteHistory({ editor: (id) => editors.get(id), reveal, changed: paintUndo });
    hist = noteHist;

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
        meter.hidden = !templateOf(d.template).meter;
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
      if (state === 'editing' && saveEl.dataset.state === 'editing') return; // 0.17: called on every keystroke
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

    function toggleCollapse(id: string) {
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
    }

    /** Puts the note's sections in this order (Undo / Redo of adding, deleting, moving). */
    const setSections = (list: Section[]) => {
      const back = list.filter((s) => !d.sections.includes(s));
      d.sections = [...list];
      schedule();
      renderSections();
      if (back.length) jumpTo(back[0].id);
    };
    /** Adding, deleting and moving sections are each one Undo step. */
    const sectionChange = (change: () => void) => {
      const before = [...d.sections];
      change();
      const after = [...d.sections];
      noteHist.op(() => setSections(before), () => setSections(after));
      schedule();
      renderSections();
    };

    const moveSection = (from: number, to: number) => {
      if (from === to || to < 0 || to >= d.sections.length) return;
      sectionChange(() => {
        const [s] = d.sections.splice(from, 1);
        d.sections.splice(to, 0, s);
      });
    };

    const deleteSection = (i: number) => {
      if (d.sections.length < 2) return;
      sectionChange(() => d.sections.splice(i, 1));
      ctx.toast('Section deleted. Undo brings it back.');
    };

    const addSection = () => {
      const s: Section = { id: newId(), heading: '', doc: textToDoc('') };
      sectionChange(() => d.sections.push(s));
      views.get(s.id)?.heading.focus();
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

    const paintOutlineName = (s: Section) => {
      const row = outline.querySelector(`.outline-row[data-section-id="${s.id}"] .ol-name`);
      if (row) row.textContent = s.heading.trim() || 'Untitled section';
    };

    /** Builds one section: heading row and its editor. Built once per note; moving it keeps it. */
    function buildSection(s: Section): SectionView {
      const isC = collapsed.has(s.id);
      const heading = h('input', { class: 'section-heading', placeholder: 'Section heading', value: s.heading });
      heading.addEventListener('input', () => {
        const before = s.heading;
        s.heading = heading.value;
        noteHist.field(`heading:${s.id}`, before, s.heading, (v) => {
          s.heading = String(v);
          const input = views.get(s.id)?.heading;
          if (input) input.value = s.heading;
          paintOutlineName(s);
          schedule();
        });
        schedule();
        paintOutlineName(s);
        live();
      });
      const collapseBtn = h('button', { type: 'button', class: 'sec-collapse', 'aria-expanded': String(!isC) }, icon('chevron', 18));
      collapseBtn.addEventListener('click', () => toggleCollapse(s.id));
      const count = h('span', { class: 'sec-count' });
      const menuBtn = h('button', { type: 'button', class: 'sec-menu-btn', 'aria-haspopup': 'menu' }, icon('more', 20));
      menuBtn.addEventListener('click', () => {
        const i = d.sections.indexOf(s);
        if (i >= 0) openPopover(menuBtn, sectionMenu(i), `Section ${i + 1}`);
      });
      heading.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          editors.get(s.id)?.commands.focus('start');
        }
      });
      const bodyEl = h('div', { class: 'section-body', 'data-section': s.id, hidden: isC });
      const el = h(
        'section',
        { class: isC ? 'note-section collapsed' : 'note-section', 'data-section-id': s.id },
        h('div', { class: 'section-head' }, collapseBtn, heading, count, menuBtn),
        bodyEl
      );
      const ed = createEditor({
        element: bodyEl,
        content: s.doc,
        slash: tools.slash,
        paste: tools.paste,
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
      return { el, editor: ed, heading, collapseBtn, menuBtn, count, untrack: noteHist.track(s.id, ed) };
    }

    const addSectionBtn = h('button', { type: 'button', class: 'add-section', id: 'add-section' }, '+ Add section');
    addSectionBtn.addEventListener('click', addSection);

    function renderSections() {
      if (!d.sections.length) d.sections.push({ id: newId(), heading: 'Notes', doc: textToDoc('') });
      const keep = new Set(d.sections.map((s) => s.id));
      for (const [id, v] of views) {
        if (keep.has(id)) continue;
        // deleted: off the page, but kept (with its Undo history) until the note closes
        tools.detach(v.editor);
        v.el.remove();
        views.delete(id);
        editors.delete(id);
        parked.set(id, v);
      }
      countEls.clear();
      d.sections.forEach((s, i) => {
        const v = views.get(s.id) ?? parked.get(s.id) ?? buildSection(s);
        parked.delete(s.id);
        views.set(s.id, v);
        editors.set(s.id, v.editor);
        setHeadingSet(v.editor, curSet);
        const isC = collapsed.has(s.id);
        v.heading.setAttribute('aria-label', `Section ${i + 1} heading`);
        v.collapseBtn.setAttribute('aria-label', `${isC ? 'Expand' : 'Collapse'} section ${i + 1}`);
        v.menuBtn.setAttribute('aria-label', `Section ${i + 1} options`);
        countEls.set(s.id, [v.count]);
        sectionsHost.append(v.el); // in order; an existing section just moves
      });
      sectionsHost.append(addSectionBtn);
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
      const before = d.title;
      d.title = title.value.replace(/\s*\n\s*/g, ' ');
      noteHist.field('title', before, d.title, (v) => {
        d.title = String(v);
        title.value = d.title;
        growTitle();
        schedule();
      });
      growTitle();
      schedule();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editors.get(d.sections[0]?.id)?.commands.focus('start');
      }
    });
    // Move to…: files the note under another subject (one Undo step).
    const setPlace = (p: { folderId?: string; subject: string }) => {
      if (p.folderId) d.folderId = p.folderId;
      else delete d.folderId;
      d.subject = p.subject;
      paintSubject();
      paintHeadMeta();
      schedule();
    };
    const moveTo = () =>
      moveSheet(index.noteFolder(d), (id) => {
        const main = index.get(index.get(id)?.parent);
        if (!main) return;
        const was = { folderId: d.folderId, subject: d.subject };
        const now = { folderId: id, subject: subjectKeyOf(main) };
        setPlace(now);
        setLastFolder(id);
        noteHist.op(() => setPlace(was), () => setPlace(now));
        ctx.toast(`Moved to ${placeLabel(id)}.`);
      });
    subject.addEventListener('click', moveTo);
    topic.addEventListener('input', () => {
      const before = d.topic;
      d.topic = topic.value;
      noteHist.field('topic', before, d.topic, (v) => {
        d.topic = String(v);
        topic.value = d.topic;
        sizeTopic();
        paintHeadMeta();
        schedule();
      });
      sizeTopic();
      paintHeadMeta();
      schedule();
    });
    template.addEventListener('change', () => {
      // the template and the sections it added are one Undo step
      const was = { template: d.template, sections: [...d.sections] };
      const t = templateOf(template.value);
      if (t.id === 'blank') delete d.template;
      else d.template = t.id;
      let added: string[] = [];
      if (t.id !== 'blank') {
        const only = d.sections.length === 1 ? d.sections[0] : null;
        if (only && isEmptyDoc(only.doc) && ['', 'notes'].includes(only.heading.trim().toLowerCase())) {
          d.sections = t.sections.map((sec) => ({ id: newId(), heading: sec.heading, doc: sectionDoc(sec) }));
          added = t.sections.map((sec) => sec.heading);
        } else {
          const have = new Set(d.sections.map((s) => s.heading.trim().toLowerCase()));
          const fresh = t.sections.filter((sec) => !have.has(sec.heading.trim().toLowerCase()));
          added = fresh.map((sec) => sec.heading);
          for (const sec of fresh) d.sections.push({ id: newId(), heading: sec.heading, doc: sectionDoc(sec) });
        }
      }
      schedule();
      renderSections();
      const now = { template: d.template, sections: [...d.sections] };
      const put = (st: typeof was) => {
        if (st.template) d.template = st.template;
        else delete d.template;
        template.value = templateOf(d.template).id;
        setSections(st.sections);
        live();
      };
      noteHist.op(() => put(was), () => put(now));
      ctx.toast(added.length ? `${t.name}: added ${added.join(', ')}. Nothing was removed.` : `Template set to ${t.name}.`);
    });
    const reflectField = (el: HTMLTextAreaElement, key: 'explain' | 'connect') =>
      el.addEventListener('input', () => {
        const before = d[key];
        d[key] = el.value;
        noteHist.field(key, before, d[key], (v) => {
          d[key] = String(v);
          el.value = d[key];
          schedule();
          paintReflect();
        });
        schedule();
        paintReflect();
      });
    reflectField(explain, 'explain');
    reflectField(connect, 'connect');
    const setNoteFont = (v: unknown) => {
      if (v) d.fontStyle = String(v);
      else delete d.fontStyle;
      styleSelect.value = d.fontStyle ?? '';
      applyNoteFont();
      schedule();
    };
    styleSelect.addEventListener('change', () => {
      const before = d.fontStyle ?? '';
      setNoteFont(styleSelect.value);
      noteHist.field('font', before, d.fontStyle ?? '', setNoteFont);
    });
    const applyNoteFont = () => paintLook();
    notePdf.addEventListener('click', () => void runPdfExport({ kind: 'note', note: structuredClone(d) }, ctx, notePdf));
    const toTrash = async () => {
      d.deletedAt = Date.now();
      dirty = true;
      await save();
      bigChange('note to trash');
      ctx.toast(`Moved “${d.title || 'Untitled note'}” to Trash. Restore it from Trash if you need it.`);
      ctx.go(backLink.getAttribute('href') ?? '#/notes');
    };
    trashBtn.addEventListener('click', () => void toTrash());
    focusBtn.addEventListener('click', () => setFocusMode(!focusMode));
    focusExit.addEventListener('click', () => setFocusMode(false));
    moreBtn.addEventListener('click', () =>
      openPopover(
        moreBtn,
        [
          { label: 'Move to…', aria: 'Move to', run: moveTo },
          { label: 'Export note as PDF', run: () => void runPdfExport({ kind: 'note', note: structuredClone(d) }, ctx) },
          { label: 'Focus mode (Ctrl + .)', run: () => setFocusMode(true) },
          {
            label: getPageWidth() === 'full' ? 'Comfortable width' : 'Full width',
            aria: 'Note width',
            run: () => {
              setPageWidth(getPageWidth() === 'full' ? 'comfortable' : 'full');
              ctx.toast(getPageWidth() === 'full' ? 'Notes use the full screen width.' : 'Notes use a comfortable reading width.');
            }
          },
          ...(window.matchMedia('(min-width: 1000px)').matches ? [{ label: outlineShown() ? 'Hide outline' : 'Show outline', aria: 'Outline', run: toggleOutline }] : []),
          { label: 'Own words and connections', run: () => openDetails(explain) },
          { label: 'Note look', aria: 'Note look', run: openLookSheet },
          { label: 'Save as template', aria: 'Save as template', run: () => void saveAsTemplate() },
          { label: 'Font style for this note', run: () => openDetails(styleSelect) },
          { label: 'Move to trash', danger: true, run: () => void toTrash() }
        ],
        'Note actions'
      )
    );

    // ----- save as template (0.14) -----
    async function saveAsTemplate() {
      const input = h('input', { id: 'tpl-name', 'aria-label': 'Template name', value: nextTemplateName(d.title), maxlength: 60 });
      openSheet({
        title: 'Save as template',
        id: 'tpl-save',
        body: [
          h('p', { class: 'meta' }, 'Keeps the sections, headings and their looks, containers and callouts, and tables with their header row. Your writing, lists, pictures, sketches and figures stay out.'),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), input)
        ],
        actions: [
          { label: 'Cancel' },
          {
            label: 'Save template',
            id: 'tpl-save-go',
            primary: true,
            run: async () => {
              const x = await saveTemplate(input.value, d.sections.map((sec) => ({ heading: sec.heading, doc: sec.doc })), !!templateOf(d.template).meter);
              ctx.toast(`Saved “${x.name}”. Find it under My templates on New note.`);
            }
          }
        ]
      });
      requestAnimationFrame(() => input.select());
    }

    // ----- note look sheet (0.14) -----
    const setOwnLook = (st: { look: NoteLook | null; font: string | null }) => {
      if (st.look) d.look = { ...st.look };
      else delete d.look;
      if (st.font) d.fontStyle = st.font;
      else delete d.fontStyle;
      styleSelect.value = d.fontStyle ?? '';
      paintLook();
      schedule();
    };
    function openLookSheet() {
      const folders = lookFolders();
      const own = readLook(d.look);
      const start = resolveLook(d, folders);
      const p: { look: NoteLook; font: string | null } = { look: { ...start.look }, font: start.font };
      let scope: 'note' | 'subject' | 'everywhere' = 'note';
      let done = false;
      const seg = <T extends string>(id: string, label: string, opts: { id: T; name: string }[], cur: () => T, set: (v: T) => void) => {
        const box = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label, id });
        const paint = () =>
          box.replaceChildren(
            ...opts.map((o) => {
              const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur() === o.id), 'data-v': o.id }, o.name);
              b.addEventListener('click', () => {
                set(o.id);
                paint();
                paintLook(p);
              });
              return b;
            })
          );
        paint();
        return box;
      };
      const sets = h('div', { class: 'hset-grid', role: 'radiogroup', 'aria-label': 'Heading style', id: 'look-headings' });
      const paintSets = () =>
        sets.replaceChildren(
          ...HEADING_SETS.map((id) => {
            const b = h(
              'button',
              { type: 'button', role: 'radio', class: 'hset-tile', 'aria-checked': String(p.look.headings === id), 'data-set': id },
              h('span', { class: 'hset-demo', 'data-hset': id, 'aria-hidden': 'true' }, h('span', { class: 'hd' }, 'Heading')),
              h('strong', {}, HEADING_SET_INFO[id].name),
              h('span', { class: 'meta' }, HEADING_SET_INFO[id].hint)
            );
            b.addEventListener('click', () => {
              p.look.headings = id;
              paintSets();
              paintLook(p);
            });
            return b;
          })
        );
      paintSets();
      const font = h('select', { id: 'look-font', 'aria-label': 'Font' }, h('option', { value: '' }, 'App font'), ...FONT_STYLES.map((f) => h('option', { value: f.id }, f.name)));
      font.value = p.font ?? '';
      font.addEventListener('change', () => {
        p.font = font.value || null;
        paintLook(p);
      });
      const accents = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent colour', id: 'look-accent' });
      const paintAccents = () =>
        accents.replaceChildren(
          ...[null, ...COLOURS.map((c) => c.key)].map((k) => {
            const name = k ? COLOURS.find((c) => c.key === k)!.name : 'Subject colour';
            const b = h('button', { type: 'button', role: 'radio', class: k ? 'sw' : 'sw sw-default', 'aria-checked': String(p.look.accent === k), 'aria-label': name, title: name, 'data-accent': k ?? '', style: `--c:${k ? `var(--sub-${k})` : index.noteColour(d)}` });
            b.addEventListener('click', () => {
              p.look.accent = k;
              paintAccents();
              paintLook(p);
            });
            return b;
          })
        );
      paintAccents();
      const { sub } = index.placeOf(d);
      const scopeSeg = seg('look-scope', 'Apply to', [
        { id: 'note' as const, name: 'This note' },
        { id: 'subject' as const, name: sub ? `All of ${sub.name}` : 'This subject' },
        { id: 'everywhere' as const, name: 'Every note' }
      ], () => scope, (v) => (scope = v));
      const def = defaultFor(folders);
      const apply = () => {
        done = true;
        const was = { look: readLook(d.look), font: d.fontStyle ?? null };
        const next = { look: { ...p.look }, font: p.font };
        if (scope === 'note') {
          setOwnLook(next);
          noteHist.op(() => setOwnLook(was), () => setOwnLook(next));
          ctx.toast('Look set for this note.');
          return;
        }
        const key = scope === 'everywhere' ? '*' : folders[0];
        if (!key) return;
        const meta = allLooks();
        const prevRec = scope === 'everywhere' ? meta.everywhere : meta.subjects[key];
        const prev = prevRec && !prevRec.deleted ? { look: prevRec.look, font: prevRec.font } : null;
        const put = async (rec: typeof prev, own: typeof was) => {
          await setLookDefault(key, rec);
          setOwnLook(own);
        };
        void put(next, { look: null, font: null });
        noteHist.op(() => void put(prev, was), () => void put(next, { look: null, font: null }));
        ctx.toast(scope === 'everywhere' ? 'Look set for every note that has no look of its own.' : `Look set for ${sub?.name ?? 'this subject'}. Notes with their own look keep it.`);
      };
      const resetOwn = () => {
        done = true;
        const was = { look: own, font: d.fontStyle ?? null };
        const next = { look: null, font: null };
        setOwnLook(next);
        noteHist.op(() => setOwnLook(was), () => setOwnLook(next));
        ctx.toast(def.from ? `This note follows the ${def.from === 'subject' ? 'subject' : 'every-note'} look again.` : 'This note has the plain look again.');
      };
      openSheet({
        title: 'Note look',
        id: 'look-sheet',
        body: [
          h('p', { class: 'meta' }, own ? 'This note has its own look.' : def.from === 'subject' ? 'This note follows its subject’s look.' : def.from === 'everywhere' ? 'This note follows the look for every note.' : 'Background and text follow the app theme.'),
          h('div', { class: 'look-form' },
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Cover'), seg('look-cover', 'Cover', COVERS, () => p.look.cover, (v) => (p.look.cover = v))),
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Headings'), sets),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Font'), font),
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Accent'), accents),
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Apply to', h('small', { class: 'hint' }, 'A note’s own look always wins over its subject’s and every note’s.')), scopeSeg)
          )
        ],
        actions: [
          ...(own || d.fontStyle ? [{ label: 'Use default look', id: 'look-reset', run: resetOwn }] : []),
          { label: 'Cancel' },
          { label: 'Apply', id: 'look-apply', primary: true, run: apply }
        ],
        onClose: () => {
          if (!done) paintLook();
        }
      });
    }

    // ----- review -----
    const paintReview = () => {
      reviewInfo.textContent = d.reviewCount
        ? `Reviewed ${d.reviewCount} ${d.reviewCount === 1 ? 'time' : 'times'}. Next review ${prettyDate(d.nextReview)}.`
        : 'Not reviewed yet. Mark it once you can explain it without looking.';
    };
    // Mark reviewed = Easy in a review session: the same single transaction (lib/review.ts reviewNote).
    const markReviewed = async () => {
      // Remember where the highlighted lines are on screen, so they can fly up into Quick insights.
      const sources = reducedMotion()
        ? []
        : [...sectionsHost.querySelectorAll<HTMLElement>('.rich mark')]
            .map((m) => ({ text: (m.textContent ?? '').trim(), rect: m.getBoundingClientRect() }))
            .filter((s) => s.text && s.rect.bottom > 0 && s.rect.top < window.innerHeight)
            .slice(0, 10);
      reviewBtn.disabled = true;
      try {
        dirty = true; // store what is on screen first: the review reads the stored note
        await save();
        if (dirty) throw new Error('not saved');
        const { note } = await reviewNote(d.id, 'easy');
        d.reviewCount = note.reviewCount;
        d.reviewStep = note.reviewStep;
        d.nextReview = note.nextReview;
        d.lastReviewed = note.lastReviewed;
        d.updatedAt = note.updatedAt;
        if (note.insights) d.insights = note.insights;
        else delete d.insights;
      } catch {
        ctx.toast("Couldn't mark it reviewed. Nothing was changed, so you can try again.");
        return;
      } finally {
        reviewBtn.disabled = false;
      }
      buzz('reviewed');
      const count = d.insights?.items.length ?? 0;
      paintReview();
      paintInsights(true);
      const text = count
        ? `Next review ${prettyDate(d.nextReview)}. ${plural(count, 'quick insight')} added at the top and to your review cards.`
        : `Next review ${prettyDate(d.nextReview)}. Highlight key lines with Mark to get quick insights.`;
      ctx.toast(text);
      void logReviewDay().then((day) => {
        if (day.milestone) buzz('milestone');
        if (day.milestone && celebrationsOn()) ctx.toast(`${text} ${milestoneText(day.milestone)}`);
      });
      if (!count) return;
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
    };
    reviewBtn.addEventListener('click', () => void markReviewed());

    canvas = {
      setSave,
      live,
      setFocus(on) {
        focusBtn.setAttribute('aria-pressed', String(on));
        if (on) (editors.get(activeSection ?? '') ?? editors.values().next().value)?.commands.focus();
      },
      place() {
        paintSubject();
        paintHeadMeta();
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
      if (templateId && isTemplateId(templateId)) startNew(templateId);
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
          h('a', { href: '#/notes' }, 'Back to Notes')
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
      if (parts[0] === 'notes') {
        const next: typeof where =
          parts[1] === 'due'
            ? { level: 'due' }
            : parts[1] === 'f' && parts[2]
              ? { level: 'folder', id: decodeURIComponent(parts[2]) }
              : parts[1] === 's' && parts[2] // 0.6–0.9 links (Today's rings): a subject is now a main subject
                ? { level: 'folder', id: `main:${decodeURIComponent(parts[2])}` }
                : { level: 'root' };
        if (JSON.stringify(next) !== JSON.stringify(where)) {
          where = next;
          editMode = false;
          visiting = next.level === 'folder' ? next.id : null;
          window.scrollTo(0, 0);
          if (search.value) {
            search.value = '';
            filter.q = '';
          }
        }
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
      folderSub.unsubscribe();
      tools.destroy();
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('editing');
    }
  };
}
