import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BulletList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extensions';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DocNode } from '../db';
import { ImageBlock } from './image-block';
import { ChartBlock } from './chart-block';
import { Callout } from './callout';

/** Bullet list with a style switch: dots (default) or dashes. */
const StyledBulletList = BulletList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      listStyle: {
        default: 'disc',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-list-style') || 'disc',
        renderHTML: (attrs: { listStyle?: string }) => (attrs.listStyle === 'dash' ? { 'data-list-style': 'dash' } : {})
      }
    };
  }
});

/** Marks the top-level block holding the caret (focus mode dims every other block). */
const ActiveBlock = Extension.create({
  name: 'activeBlock',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('activeBlock'),
        props: {
          decorations(state) {
            const { $head } = state.selection;
            if ($head.depth < 1) return null;
            const from = $head.before(1);
            const node = state.doc.nodeAt(from);
            if (!node) return null;
            return DecorationSet.create(state.doc, [Decoration.node(from, from + node.nodeSize, { class: 'is-active' })]);
          }
        }
      })
    ];
  }
});

/** Hides the real highlight under the 200 ms marker sweep, via a decoration (never by touching the editor's DOM). */
export const sweepKey = new PluginKey<DecorationSet>('markSweep');
const MarkSweep = Extension.create({
  name: 'markSweep',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: sweepKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(sweepKey) as { from: number; to: number } | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) return DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'sweeping' })]);
            return set.map(tr.mapping, tr.doc);
          }
        },
        props: { decorations: (state) => sweepKey.getState(state) }
      })
    ];
  }
});

/** What the slash menu needs from each editor: a look after every update, and first say on keys. */
export interface SlashHook {
  update(editor: Editor): void;
  keydown(editor: Editor, e: KeyboardEvent): boolean;
}

function slashExtension(hook: SlashHook) {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin({
          key: new PluginKey('slashMenu'),
          view: () => ({ update: () => hook.update(editor) }),
          props: { handleKeyDown: (_view, e) => hook.keydown(editor, e) }
        })
      ];
    }
  });
}

export function createEditor(opts: {
  element: HTMLElement;
  content: DocNode;
  onChange: (doc: DocNode) => void;
  onFocus: (editor: Editor) => void;
  onBlur?: (editor: Editor) => void;
  slash?: SlashHook;
  placeholder?: string;
  /** false = read-only (the review session's whole-note card). */
  editable?: boolean;
}): Editor {
  return new Editor({
    element: opts.element,
    editable: opts.editable ?? true,
    content: opts.content as object,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        bulletList: false,
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }
      }),
      StyledBulletList,
      Highlight,
      TableKit.configure({ table: { resizable: true, cellMinWidth: 80 } }),
      ImageBlock,
      ChartBlock,
      Callout,
      ActiveBlock,
      MarkSweep,
      ...(opts.slash ? [slashExtension(opts.slash)] : []),
      Placeholder.configure({ placeholder: opts.placeholder ?? 'Write here. Type / to add a list, table, chart or callout.' })
    ],
    editorProps: { attributes: { class: 'rich', spellcheck: 'true' } },
    onUpdate: ({ editor }) => opts.onChange(editor.getJSON() as DocNode),
    onFocus: ({ editor }) => opts.onFocus(editor),
    onBlur: ({ editor }) => opts.onBlur?.(editor)
  });
}
