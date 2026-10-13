import { Extension, type Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * Text on every side of a picture.
 * - Beside: a Left/Right picture floats; what follows sits beside it.
 * - Below: a block with `clear` starts under the picture (Enter on an empty line beside a
 *   picture, or "Below picture" in the tools). Headings always start below.
 * - Above / below: "+ Line above / below" on a selected picture.
 * - Typing while a picture is selected starts a new line after it instead of replacing it.
 */
const CLEARABLE = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'callout', 'horizontalRule'];
const PICTURES = ['imageBlock', 'chartBlock', 'sketchBlock'];
/** Pictures that can float with text beside them. */
const FLOATS = ['imageBlock', 'sketchBlock'];

/** The floated picture the top-level block at `index` sits after (until a heading, cleared block or centred picture), or null. */
function floatBefore(parent: PMNode, index: number): number | null {
  for (let j = index - 1; j >= 0; j--) {
    const n = parent.child(j);
    if (n.type.name === 'heading' || n.attrs.clear) return null;
    if (FLOATS.includes(n.type.name)) return n.attrs.align === 'left' || n.attrs.align === 'right' ? j : null;
  }
  return null;
}

/** The block holding the caret, one level below the doc or a callout (where floats live). */
function blockAt(state: EditorState): { pos: number; node: PMNode; parent: PMNode; index: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const parent = $from.node(d - 1);
    if (d - 1 === 0 || parent.type.name === 'callout') {
      const node = $from.node(d);
      if (!CLEARABLE.includes(node.type.name)) return null;
      return { pos: $from.before(d), node, parent, index: $from.index(d - 1) };
    }
  }
  return null;
}

/** True when the caret's block comes after a floated picture and is still beside it on screen. */
export function besidePicture(editor: Editor): boolean {
  const b = blockAt(editor.state);
  if (!b || b.node.attrs.clear || b.node.type.name === 'heading') return false;
  const j = floatBefore(b.parent, b.index);
  if (j === null) return false;
  try {
    const blockEl = editor.view.nodeDOM(b.pos) as HTMLElement | null;
    let picPos = b.pos;
    for (let k = b.index - 1; k >= j; k--) picPos -= b.parent.child(k).nodeSize;
    const picEl = editor.view.nodeDOM(picPos) as HTMLElement | null;
    if (!blockEl || !picEl) return true;
    return blockEl.getBoundingClientRect().top < picEl.getBoundingClientRect().bottom - 2;
  } catch {
    return true;
  }
}

/** True when the caret's block was told to start below pictures. */
export function isBelowPicture(editor: Editor): boolean {
  const b = blockAt(editor.state);
  return !!b && !!b.node.attrs.clear && b.node.type.name !== 'heading' && floatBefore(b.parent, b.index) !== null;
}

/** Starts the caret's block below the picture (on), or lets it sit beside it again (off). */
export function setBelowPicture(editor: Editor, on: boolean) {
  const b = blockAt(editor.state);
  if (!b) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, clear: on ? true : null }).scrollIntoView());
  editor.commands.focus();
}

/** "+ Line above / below" on a selected picture or chart: an empty line there, with the caret in it. */
export function addLineBy(editor: Editor, where: 'above' | 'below') {
  const sel = editor.state.selection;
  if (!(sel instanceof NodeSelection) || !PICTURES.includes(sel.node.type.name)) return;
  const at = where === 'above' ? sel.from : sel.to;
  const tr = editor.state.tr.insert(at, editor.state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
  editor.view.dispatch(tr);
  editor.commands.focus();
}

export const PictureFlow = Extension.create({
  name: 'pictureFlow',
  priority: 1000, // its Enter runs before the editor's own

  addGlobalAttributes() {
    return [
      {
        types: CLEARABLE,
        attributes: {
          clear: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute('data-clear') ? true : null),
            renderHTML: (attrs: { clear?: boolean | null }) => (attrs.clear ? { 'data-clear': 'both' } : {})
          }
        }
      }
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Enter on an empty line beside a picture moves that line below the picture.
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        const $f = selection.$from;
        if (!selection.empty || $f.parent.type.name !== 'paragraph' || $f.parent.content.size) return false;
        const b = blockAt(editor.state);
        if (!b || b.node !== $f.parent || !besidePicture(editor)) return false;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, clear: true }).scrollIntoView());
        return true;
      }
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pictureFlow'),
        props: {
          // Android keyboards type through composition, which skips handleTextInput: so on the key
          // itself (key 229 / 'Unidentified' there, a letter elsewhere) the caret first moves to a new
          // line after the picture, and the letter lands there.
          handleKeyDown: (view, e) => {
            const sel = view.state.selection;
            if (!(sel instanceof NodeSelection) || !PICTURES.includes(sel.node.type.name)) return false;
            if (e.ctrlKey || e.metaKey || e.altKey) return false;
            if (!(e.key.length === 1 || e.key === 'Unidentified' || e.keyCode === 229)) return false;
            const tr = view.state.tr.insert(sel.to, view.state.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, sel.to + 1)).scrollIntoView();
            view.dispatch(tr);
            return false; // the key goes on and types into the new line
          },
          // A selected picture is never replaced by typing: the text starts a new line after it.
          handleTextInput: (view, _from, _to, text) => {
            const sel = view.state.selection;
            if (!(sel instanceof NodeSelection) || !PICTURES.includes(sel.node.type.name)) return false;
            const { schema } = view.state;
            const tr = view.state.tr.insert(sel.to, schema.nodes.paragraph.create(null, schema.text(text)));
            tr.setSelection(TextSelection.create(tr.doc, sel.to + 1 + text.length)).scrollIntoView();
            view.dispatch(tr);
            return true;
          }
        }
      })
    ];
  }
});
