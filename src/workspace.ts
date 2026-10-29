import type { Editor } from '@tiptap/core';
import { db, type Note } from './db';
import { createEditor } from './editor/editor';
import { h } from './lib/h';
import { icon } from './lib/icons';
import { openSheet } from './lib/sheet';

// View state only: no note metadata, folders or saved preferences are changed.
const working = new Map<string, string>();
const positions = new Map<string, number>();
let currentId = '';
let jump: ((id: string) => void) | null = null;
let referenceClose: (() => void) | null = null;
export function jumpToSearchSection(noteId: string, sectionId: string) {
  if (currentId === noteId) jump?.(sectionId);
}

export function closeReference() { referenceClose?.(); }

export async function showReference(id: string) {
  const canvas = document.querySelector('.canvas-body');
  const note = await db.notes.get(id);
  if (!note || note.deletedAt || !canvas?.isConnected || canvas !== document.querySelector('.canvas-body')) return;
  closeReference();
  const before = document.activeElement as HTMLElement | null;
  const editors: Editor[] = [];
  const close = h('button', { type: 'button', class: 'icon-btn', id: 'reference-close', 'aria-label': 'Close reference' }, icon('close', 20));
  const sections = h('div', { class: 'reference-pages' });
  const pane = h('aside', { class: 'reference-pane', id: 'reference-pane', 'aria-label': 'Read-only reference' },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow' }, 'Reference · read only'), h('h2', {}, note.title || 'Untitled note')), close), sections);
  document.querySelector('.canvas-body')!.append(pane);
  document.body.classList.add('reference-open');
  for (const section of note.sections) {
    const el = h('div', { class: 'reference-content' });
    sections.append(h('section', {}, h('h3', {}, section.heading || 'Untitled section'), el));
    const editor = createEditor({ element: el, content: section.doc, editable: false, onChange: () => undefined, onFocus: () => undefined, placeholder: '' });
    editor.view.dom.setAttribute('aria-label', `${section.heading || 'Untitled section'} — read-only reference`);
    editor.view.dom.setAttribute('aria-readonly', 'true');
    editors.push(editor);
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); dispose(); }
  };
  function dispose() {
    editors.forEach(ed => ed.destroy());
    pane.remove();
    document.body.classList.remove('reference-open');
    document.removeEventListener('keydown', onKey, true);
    if (referenceClose === dispose) referenceClose = null;
    if (before?.isConnected) before.focus({ preventScroll: true });
  }
  referenceClose = dispose;
  close.addEventListener('click', dispose);
  document.addEventListener('keydown', onKey, true);
  // This is a non-modal reading companion. The writing page remains available.
  close.focus({ preventScroll: true });
}

export function mountWorkspace(note: Note, canvas: HTMLElement, go: (hash: string) => void, onJump: (id: string) => void) {
  currentId = note.id;
  jump = onJump;
  working.set(note.id, note.title || 'Untitled note');
  const tabs = h('nav', { class: 'working-tabs', 'aria-label': 'Open notes' });
  const reference = h('button', { type: 'button', id: 'reference-open', class: 'workspace-action' }, icon('sidebar', 18), 'Reference');
  reference.addEventListener('click', async () => {
    const notes = (await db.notes.toArray()).filter(n => !n.deletedAt && n.id !== note.id).sort((a,b) => b.updatedAt-a.updatedAt);
    const choices = h('div', { class: 'reference-choices' });
    let dismiss = () => {};
    for (const n of notes) {
      const button = h('button', { type: 'button' }, h('strong', {}, n.title || 'Untitled note'), h('span', { class: 'meta' }, n.topic || n.subject));
      button.addEventListener('click', () => { dismiss(); void showReference(n.id); });
      choices.append(button);
    }
    dismiss = openSheet({ title: 'Keep a reference beside your note', body: [h('p', { class: 'meta' }, 'Read another note while you write. Your reference cannot be edited here.'), notes.length ? choices : h('p', {}, 'Create another note first to use it as a reference.')], actions: [{ label: 'Cancel' }] });
    choices.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  });
  const strip = h('div', { class: 'workspace-strip' }, tabs, reference);
  function paint() {
    tabs.replaceChildren(...[...working].map(([id,title]) => {
      const link = h('a', { href: `#/n/${id}`, 'aria-current': id === note.id ? 'page' : undefined }, title);
      link.addEventListener('click', e => { e.preventDefault(); go(`#/n/${id}`); });
      const close = h('button', { type: 'button', 'aria-label': `Remove ${title} from open notes`, title: 'Remove from open notes; keeps the saved note' }, icon('close', 14));
      close.addEventListener('click', () => { working.delete(id); paint(); });
      return h('span', { class: `working-tab${id === note.id ? ' selected' : ''}` }, link, close);
    }));
  }
  paint();
  canvas.prepend(strip);
  let cancelled = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!cancelled && !note.id.startsWith('new')) window.scrollTo({ top: positions.get(note.id) ?? 0, behavior: 'instant' });
  }));
  return () => {
    cancelled = true;
    positions.set(note.id, window.scrollY);
    closeReference();
    if (currentId === note.id) { currentId = ''; jump = null; }
  };
}
