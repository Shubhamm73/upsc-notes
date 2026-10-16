import { Extension, mergeAttributes, type Editor } from '@tiptap/core';
import Heading from '@tiptap/extension-heading';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { readHeadingLook, type HeadingLook } from '../lib/looks';
import { SET_LOOKS, type HeadingSet } from '../lib/note-look';

/**
 * Headings with a look (0.12): { type: 'heading', attrs: { level, look: { style, color, fill, corner,
 * icon, width, align } } }. look null (the default, and every heading written before 0.12) is a plain
 * heading. The text sits in an inner span so a look can draw a tab, a pill or a banner round the words
 * while the heading's own box keeps the line (styles.css). The number of a Numbered heading, the
 * subject label of a Split one and the icon are drawn by CSS, so they are never part of the text.
 */
export const LookHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      look: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          el.dataset.look
            ? readHeadingLook({ style: el.dataset.look, color: el.dataset.color, fill: el.dataset.fill, corner: el.dataset.corner, icon: el.dataset.icon, width: el.dataset.width, align: el.dataset.align })
            : null,
        renderHTML: (attrs: { look?: unknown }) => lookAttrs(readHeadingLook(attrs.look))
      }
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const level = this.options.levels.includes(node.attrs.level) ? node.attrs.level : this.options.levels[0];
    return [`h${level}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ['span', { class: 'h-text' }, 0]];
  }
});

export function lookAttrs(l: HeadingLook | null): Record<string, string> {
  if (!l) return {};
  const out: Record<string, string> = { 'data-look': l.style, 'data-fill': l.fill, 'data-corner': l.corner, 'data-width': l.width, 'data-align': l.align };
  if (l.color) {
    out['data-color'] = l.color;
    out.style = `--c: var(--sub-${l.color})`;
  }
  if (l.icon) out['data-icon'] = l.icon;
  return out;
}

/**
 * The note's heading style set (0.14): plain headings (look null) are drawn with the set's look through
 * a node decoration, so nothing is written into the doc and a heading with its own look keeps it.
 */
const setKey = new PluginKey('headingSet');
export const HeadingSetExt = Extension.create<Record<string, never>, { set: HeadingSet }>({
  name: 'headingSet',
  addStorage() {
    return { set: 'classic' };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: setKey,
        props: {
          decorations(state) {
            const looks = SET_LOOKS[storage.set];
            if (!looks) return null;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'heading') return true;
              if (!readHeadingLook(node.attrs.look)) decos.push(Decoration.node(pos, pos + node.nodeSize, lookAttrs(node.attrs.level === 2 ? looks.h2 : looks.h3)));
              return false;
            });
            return DecorationSet.create(state.doc, decos);
          }
        }
      })
    ];
  }
});

/** Show a note's headings in a set (redraws at once; the doc is not changed). */
export function setHeadingSet(editor: Editor, set: HeadingSet) {
  const st = editor.storage as unknown as { headingSet?: { set: HeadingSet } };
  if (!st.headingSet || st.headingSet.set === set) return;
  st.headingSet.set = set;
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(setKey, set).setMeta('addToHistory', false));
}

/** The heading holding the caret, if any. */
export function headingAt(editor: Editor): { pos: number; node: PMNode } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'heading') return { pos: $from.before(d), node: $from.node(d) };
  return null;
}

export const headingLookAt = (editor: Editor): HeadingLook | null => {
  const h = headingAt(editor);
  return h ? readHeadingLook(h.node.attrs.look) : null;
};

/** Gives the caret's heading a look (null: plain). One Undo step. */
export function setHeadingLook(editor: Editor, look: HeadingLook | null): boolean {
  const h = headingAt(editor);
  if (!h) return false;
  const clean = readHeadingLook(look);
  editor.view.dispatch(closeHistory(editor.state.tr.setNodeMarkup(h.pos, undefined, { ...h.node.attrs, look: clean })));
  return true;
}

/** Turns the caret's line into a level-2 heading with this look (a saved style picked from the slash menu). */
export function applyHeadingStyle(editor: Editor, look: HeadingLook) {
  if (!headingAt(editor)) editor.chain().focus().setHeading({ level: 2 }).run();
  setHeadingLook(editor, look);
}
