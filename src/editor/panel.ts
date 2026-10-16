import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { icon } from '../lib/icons';
import { panelTitle, readPanelLook, type PanelLook } from '../lib/looks';

/**
 * Containers (0.12): a soft panel, titled panel, sticky note, frame, quote or two columns round any
 * blocks. Stored as { type: 'panel', attrs: { kind, color, fill, corner, icon, title, author },
 * content: [...] } at the top level of a section's doc (never inside another panel, a list or a table).
 * Two columns hold exactly two { type: 'panelColumn' } children.
 * An older app (0.11) doesn't know these nodes: it opens such a section read-only, untouched.
 */
const INSIDE = 'paragraph | heading | bulletList | orderedList | blockquote | table | imageBlock | chartBlock | chart | diagram | mindMap | sketchBlock | callout | horizontalRule';

export const PanelColumn = Node.create({
  name: 'panelColumn',
  content: `(${INSIDE})+`,
  isolating: true,
  defining: true,
  parseHTML: () => [{ tag: 'div[data-panel-column]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-panel-column': '', class: 'panel-col' }), 0]
});

const attr = (name: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) || null,
  renderHTML: (a: Record<string, unknown>) => (a[name] ? { [`data-${name}`]: String(a[name]) } : {})
});

export const Panel = Node.create({
  name: 'panel',
  // Not in the "block" group: the doc names it (editor.ts), so a panel can't land in a list, a table or a callout.
  content: `panelColumn{2} | (${INSIDE})+`,
  defining: true,

  addAttributes() {
    return {
      kind: { default: 'soft', parseHTML: (el: HTMLElement) => readPanelLook({ kind: el.getAttribute('data-panel') }).kind, renderHTML: (a: { kind?: string }) => ({ 'data-panel': a.kind }) },
      color: attr('color'),
      fill: attr('fill'),
      corner: attr('corner'),
      icon: attr('icon'),
      title: attr('title'),
      author: attr('author')
    };
  },

  parseHTML: () => [{ tag: 'div[data-panel]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { class: 'panel' }), 0],

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'panel';
      const head = document.createElement('div');
      head.className = 'panel-head';
      head.contentEditable = 'false';
      const body = document.createElement('div');
      body.className = 'panel-body';
      const foot = document.createElement('div');
      foot.className = 'panel-foot';
      foot.contentEditable = 'false';
      dom.append(head, body, foot);
      // A tap on the title strip or the author line opens the container's style tools at that box.
      for (const [el, field] of [[head, 'title'], [foot, 'author']] as const) {
        el.addEventListener('mousedown', (e) => e.preventDefault());
        el.addEventListener('click', () => {
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (pos === undefined || !editor.isEditable) return;
          editor.chain().focus().setTextSelection(pos + (dom.dataset.columns === '2' ? 3 : 2)).run();
          dom.dispatchEvent(new CustomEvent('panel-edit', { bubbles: true, detail: { field } }));
        });
      }
      const paint = (n: PMNode) => {
        const l = readPanelLook(n.attrs);
        dom.dataset.panel = l.kind;
        dom.dataset.fill = l.fill;
        dom.dataset.corner = l.corner;
        dom.dataset.columns = n.firstChild?.type.name === 'panelColumn' ? '2' : '1';
        if (l.color) dom.style.setProperty('--c', `var(--sub-${l.color})`);
        else dom.style.removeProperty('--c');
        if (n.attrs.clear) dom.dataset.clear = 'both';
        else delete dom.dataset.clear;
        const title = panelTitle(l);
        head.hidden = !(l.kind === 'titled' || (l.kind === 'sticky' && title));
        head.replaceChildren(...(l.icon && l.kind === 'titled' ? [icon(l.icon, 16)] : []), document.createTextNode(title));
        foot.hidden = l.kind !== 'quote' || !l.author;
        foot.textContent = l.author ? `— ${l.author}` : '';
        dom.setAttribute('aria-label', l.kind === 'titled' || l.kind === 'sticky' ? `${title || 'Sticky note'} container` : `${l.kind === 'columns' ? 'Two-column' : l.kind} container`);
      };
      paint(node);
      return {
        dom,
        contentDOM: body,
        update(n: PMNode) {
          if (n.type.name !== 'panel') return false;
          paint(n);
          return true;
        },
        ignoreMutation(m) {
          return m.type !== 'selection' && (head.contains(m.target) || foot.contains(m.target));
        }
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of a container lifts that first line out of it (like a callout).
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
        if ($from.node(1).type.name !== 'panel' || $from.depth !== 2 || $from.index(1) !== 0) return false;
        return editor.commands.lift('panel');
      }
    };
  }
});

/** The container round the caret, if any. */
export function panelAt(editor: Editor | EditorState): { pos: number; node: PMNode } | null {
  const state = 'state' in editor ? editor.state : editor;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'panel') return { pos: $from.before(d), node: $from.node(d) };
  return null;
}

/** The top-level blocks the selection touches (what "Put in container" wraps), or null inside a container. */
export function blocksForPanel(state: EditorState): { from: number; to: number; nodes: PMNode[] } | null {
  const { $from, $to, from, to } = state.selection;
  if (panelAt(state)) return null;
  const doc = state.doc;
  const first = $from.index(0);
  let last = $to.depth === 0 ? Math.max(first, $to.index(0) - (to > from ? 1 : 0)) : $to.index(0);
  last = Math.min(last, doc.childCount - 1);
  if (first > last) return null;
  let start = 0;
  for (let i = 0; i < first; i++) start += doc.child(i).nodeSize;
  const nodes: PMNode[] = [];
  let end = start;
  for (let i = first; i <= last; i++) {
    nodes.push(doc.child(i));
    end += doc.child(i).nodeSize;
  }
  if (nodes.some((n) => n.type.name === 'panel')) return null;
  return { from: start, to: end, nodes };
}

function lookAttrs(l: PanelLook) {
  return { kind: l.kind, color: l.color, fill: l.fill === 'soft' ? null : l.fill, corner: l.corner === 'round' ? null : l.corner, icon: l.icon, title: l.title, author: l.author };
}

/** Blocks as a container's content: as they are, or split half and half into two columns. */
function panelContent(schema: Schema, nodes: PMNode[], columns: boolean): PMNode[] {
  if (!columns) return nodes.length ? nodes : [schema.nodes.paragraph.create()];
  const half = Math.ceil(nodes.length / 2);
  const left = nodes.slice(0, half);
  const right = nodes.slice(half);
  const col = (ns: PMNode[]) => schema.nodes.panelColumn.create(null, ns.length ? ns : [schema.nodes.paragraph.create()]);
  return [col(left.length ? left : []), col(right)];
}

/** Every block inside a container, columns flattened (in reading order). */
function flatBlocks(panel: PMNode): PMNode[] {
  const out: PMNode[] = [];
  panel.forEach((c) => (c.type.name === 'panelColumn' ? c.forEach((k) => out.push(k)) : out.push(c)));
  return out;
}

/** Puts the selected blocks (or the caret's block) in a container. One Undo step. */
export function wrapInPanel(editor: Editor, look: PanelLook): boolean {
  const { state } = editor;
  const range = blocksForPanel(state);
  if (!range) return false;
  const { schema } = state;
  let panel: PMNode;
  try {
    panel = schema.nodes.panel.createChecked(lookAttrs(look), panelContent(schema, range.nodes, look.kind === 'columns'));
  } catch {
    return false;
  }
  const tr = closeHistory(state.tr.replaceWith(range.from, range.to, panel));
  const inner = range.from + (look.kind === 'columns' ? 3 : 2);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(inner, tr.doc.content.size)))).scrollIntoView();
  editor.view.dispatch(tr);
  editor.commands.focus();
  return true;
}

/** Changes the look of the caret's container. Changing to or from two columns moves the blocks. */
export function setPanelLook(editor: Editor, look: PanelLook): boolean {
  const here = panelAt(editor);
  if (!here) return false;
  const { schema } = editor.state;
  const wasColumns = here.node.firstChild?.type.name === 'panelColumn';
  const columns = look.kind === 'columns';
  const tr = closeHistory(editor.state.tr);
  if (wasColumns === columns) {
    tr.setNodeMarkup(here.pos, undefined, { ...here.node.attrs, ...lookAttrs(look) });
  } else {
    const head = editor.state.selection.head - here.pos;
    const next = schema.nodes.panel.create({ ...here.node.attrs, ...lookAttrs(look) }, panelContent(schema, flatBlocks(here.node), columns));
    tr.replaceWith(here.pos, here.pos + here.node.nodeSize, next);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(here.pos + Math.max(2, head + (columns ? 1 : -1)), tr.doc.content.size))));
  }
  editor.view.dispatch(tr);
  return true;
}

/** Removes the container round the caret and keeps everything that was in it, in place. One Undo step. */
export function removePanel(editor: Editor): boolean {
  const here = panelAt(editor);
  if (!here) return false;
  const blocks = flatBlocks(here.node);
  const tr = closeHistory(editor.state.tr.replaceWith(here.pos, here.pos + here.node.nodeSize, blocks));
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(here.pos + 1, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

export const panelLookAt = (editor: Editor): PanelLook | null => {
  const here = panelAt(editor);
  return here ? readPanelLook(here.node.attrs) : null;
};
