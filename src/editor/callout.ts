import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { calloutKind, calloutLabel } from '../lib/callouts';
import { icon } from '../lib/icons';

/**
 * A UPSC callout (Article, Case, Data, Example, Way forward, PYQ): a tinted box with an
 * icon and a label, holding ordinary paragraphs, lists and pictures. Stored as
 * { type: 'callout', attrs: { kind }, content: [...] } inside a section's doc.
 * A PYQ also keeps year / paper / marks (shown in its label; null when not filled in).
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: '(paragraph | bulletList | orderedList | imageBlock)+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'article',
        parseHTML: (el: HTMLElement) => calloutKind(el.getAttribute('data-callout')).id,
        renderHTML: (attrs: { kind?: string }) => ({ 'data-callout': attrs.kind })
      },
      year: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-year'), renderHTML: (a: { year?: string | null }) => (a.year ? { 'data-year': a.year } : {}) },
      paper: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-paper'), renderHTML: (a: { paper?: string | null }) => (a.paper ? { 'data-paper': a.paper } : {}) },
      marks: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-marks'), renderHTML: (a: { marks?: string | null }) => (a.marks ? { 'data-marks': a.marks } : {}) }
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { class: 'callout' }), 0];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('aside');
      dom.className = 'callout';
      const ic = document.createElement('span');
      ic.className = 'callout-icon';
      ic.contentEditable = 'false';
      const main = document.createElement('div');
      main.className = 'callout-main';
      const label = document.createElement('div');
      label.className = 'callout-label';
      label.contentEditable = 'false';
      const body = document.createElement('div');
      body.className = 'callout-body';
      main.append(label, body);
      dom.append(ic, main);
      let kind = '';
      const paint = (n: PMNode) => {
        const k = calloutKind(n.attrs.kind);
        label.textContent = calloutLabel(n.attrs);
        if (n.attrs.clear) dom.dataset.clear = 'both';
        else delete dom.dataset.clear;
        if (k.id === kind) return;
        kind = k.id;
        dom.dataset.callout = k.id;
        dom.setAttribute('aria-label', `${k.label} callout`);
        ic.replaceChildren(icon(k.icon, 20));
      };
      paint(node);
      return {
        dom,
        contentDOM: body,
        update(n: PMNode) {
          if (n.type.name !== 'callout') return false;
          paint(n);
          return true;
        },
        ignoreMutation(m) {
          return m.type !== 'selection' && (ic.contains(m.target) || label.contains(m.target));
        }
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of a callout lifts that line out of it.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
        if ($from.node(-1).type.name !== 'callout' || $from.index(-1) !== 0) return false;
        return editor.commands.lift('callout');
      }
    };
  }
});

/** Depth and position of the callout around the cursor, if any. */
function calloutAt(editor: Editor): { pos: number; node: PMNode } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'callout') return { pos: $from.before(d), node: n };
  }
  return null;
}

/** Wraps the current block in a callout, or changes the kind of the callout already there. */
export function setCallout(editor: Editor, kind: string) {
  const here = calloutAt(editor);
  if (here) {
    editor.chain().focus().command(({ tr }) => {
      tr.setNodeMarkup(here.pos, undefined, { ...here.node.attrs, kind });
      return true;
    }).run();
    return;
  }
  if (editor.chain().focus().wrapIn('callout', { kind }).run()) return;
  // Not wrappable here (e.g. the first line of a list item): add a new callout after this block.
  const { $from } = editor.state.selection;
  const pos = $from.depth > 0 ? $from.after(1) : editor.state.doc.content.size;
  editor
    .chain()
    .focus()
    .insertContentAt(pos, { type: 'callout', attrs: { kind }, content: [{ type: 'paragraph' }] })
    .setTextSelection(pos + 2)
    .run();
}

/** Year / paper / marks of the PYQ callout around the cursor. */
export function setPyqDetails(editor: Editor, details: { year?: string | null; paper?: string | null; marks?: string | null }) {
  const here = calloutAt(editor);
  if (!here || here.node.attrs.kind !== 'pyq') return;
  const clean = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v && String(v).trim() ? String(v).trim() : null]));
  editor.view.dispatch(editor.state.tr.setNodeMarkup(here.pos, undefined, { ...here.node.attrs, ...clean }));
}

export function calloutAttrsAt(editor: Editor): Record<string, unknown> | null {
  return calloutAt(editor)?.node.attrs ?? null;
}

/** Keeps the text, drops the callout box around it. */
export function removeCallout(editor: Editor) {
  const here = calloutAt(editor);
  if (!here) return;
  editor.chain().focus().command(({ tr }) => {
    tr.replaceWith(here.pos, here.pos + here.node.nodeSize, here.node.content);
    return true;
  }).run();
}

export function calloutKindAt(editor: Editor): string | null {
  return calloutAt(editor)?.node.attrs.kind ?? null;
}
