import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BulletList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Document from '@tiptap/extension-document';
import Highlight from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extensions';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DocNode } from '../db';
import { ImageBlock } from './image-block';
import { ChartBlock, ChartNode } from './chart-block';
import { DiagramNode } from './diagram-block';
import { MindMapNode } from './mindmap-block';
import { SketchBlock } from './sketch-block';
import { Callout } from './callout';
import { pasteExtension, type PasteHooks } from './paste';
import { PictureFlow } from './flow';
import { LookHeading } from './heading-look';
import { Panel, PanelColumn } from './panel';
import { StyledTable, TableFigures } from './table';

/** The doc: blocks, and containers (0.12), which live only at the top level. */
const PanelDoc = Document.extend({ content: '(block | panel)+' });

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

/** Hides the real highlight under the 200 ms marker sweep, via a decoration (never by touching the editor's DOM).
 *  The sweep's end only flags it `over`; the next transaction drops it. Clearing it with a transaction of its own could
 *  write an older selection over a DOM selection ProseMirror has not read yet (selectionchange still pending). */
export interface SweepState { set: DecorationSet; over: { v: boolean } }
export const sweepKey = new PluginKey<SweepState>('markSweep');
const NO_SWEEP: SweepState = { set: DecorationSet.empty, over: { v: true } };
const MarkSweep = Extension.create({
  name: 'markSweep',
  addProseMirrorPlugins() {
    return [
      new Plugin<SweepState>({
        key: sweepKey,
        state: {
          init: () => NO_SWEEP,
          apply(tr, s) {
            const meta = tr.getMeta(sweepKey) as { from: number; to: number; over: { v: boolean } } | null | undefined;
            if (meta === null || (meta === undefined && s.over.v)) return NO_SWEEP;
            if (meta) return { set: DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'sweeping' })]), over: meta.over };
            return { set: s.set.map(tr.mapping, tr.doc), over: s.over };
          }
        },
        props: { decorations: (state) => sweepKey.getState(state)?.set }
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

/** Attributes added in 0.11 and 0.12 that are left out of the saved JSON while they hold their default (null). */
const QUIET: Record<string, string[]> = {
  table: ['tstyle', 'color', 'caption', 'firstCol'],
  heading: ['look'],
  callout: ['fill', 'corner']
};

/**
 * The editor's JSON without `clear: null` (PictureFlow's "start below the picture" attribute when off)
 * and without the 0.12 look attributes while unset, so blocks keep the shape older notes and backups have.
 */
function tidy(n: DocNode): DocNode {
  if (n.attrs) {
    const drop = (QUIET[n.type] ?? []).filter((k) => k in n.attrs! && n.attrs![k] == null);
    // `clear: false` matters only on a heading (it sits beside a picture, 0.11); null is the default everywhere.
    if ('clear' in n.attrs && (n.attrs.clear == null || (n.attrs.clear === false && n.type !== 'heading'))) drop.push('clear');
    if (drop.length) {
      const rest = { ...n.attrs };
      for (const k of drop) delete rest[k];
      n.attrs = rest;
      if (!Object.keys(rest).length) delete n.attrs;
    }
  }
  n.content?.forEach(tidy);
  return n;
}

/** Block and mark types in saved content that this version doesn't know (written by a newer version). */
function unknownTypes(n: DocNode, nodes: Record<string, unknown>, marks: Record<string, unknown>, out = new Set<string>()): Set<string> {
  if (n.type && !nodes[n.type]) out.add(n.type);
  for (const m of n.marks ?? []) if (!marks[m.type]) out.add(m.type);
  n.content?.forEach((c) => unknownTypes(c, nodes, marks, out));
  return out;
}

export function createEditor(opts: {
  element: HTMLElement;
  content: DocNode;
  onChange: (doc: DocNode) => void;
  onFocus: (editor: Editor) => void;
  onBlur?: (editor: Editor) => void;
  slash?: SlashHook;
  paste?: PasteHooks;
  placeholder?: string;
  /** false = read-only (the review session's whole-note card). */
  editable?: boolean;
}): Editor {
  const editor = new Editor({
    element: opts.element,
    editable: opts.editable ?? true,
    content: opts.content as object,
    extensions: [
      StarterKit.configure({
        document: false,
        heading: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }
      }),
      PanelDoc,
      LookHeading.configure({ levels: [2, 3, 4] }),
      StyledBulletList,
      Highlight,
      TableKit.configure({ table: false }),
      StyledTable,
      TableFigures,
      Panel,
      PanelColumn,
      ImageBlock,
      ChartBlock,
      ChartNode,
      DiagramNode,
      MindMapNode,
      SketchBlock,
      Callout,
      PictureFlow,
      ActiveBlock,
      MarkSweep,
      ...(opts.slash ? [slashExtension(opts.slash)] : []),
      ...(opts.paste ? [pasteExtension(opts.paste)] : []),
      Placeholder.configure({ placeholder: opts.placeholder ?? 'Write here. Type / to add a list, table, chart or callout.' })
    ],
    editorProps: { attributes: { class: 'rich', spellcheck: 'true' } },
    onUpdate: ({ editor }) => opts.onChange(tidy(editor.getJSON() as DocNode)),
    onFocus: ({ editor }) => opts.onFocus(editor),
    onBlur: ({ editor }) => opts.onBlur?.(editor)
  });
  // Never lose data: a section holding something this version can't show would open blank (the editor drops
  // what it doesn't know), and typing would save the blank over it. It opens read-only instead, untouched.
  if (unknownTypes(opts.content, editor.schema.nodes, editor.schema.marks).size) {
    editor.setEditable(false, false);
    opts.element.classList.add('is-unreadable');
    opts.element.prepend(
      Object.assign(document.createElement('p'), {
        className: 'unreadable-note',
        textContent: 'This section was written by a newer version of the app. Update the app (reload it while online) to see and edit it. Nothing in it has been changed.'
      })
    );
  }
  return editor;
}
