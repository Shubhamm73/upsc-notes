import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BulletList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extensions';
import type { DocNode } from '../db';
import { ImageBlock } from './image-block';
import { ChartBlock } from './chart-block';

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

export function createEditor(opts: {
  element: HTMLElement;
  content: DocNode;
  onChange: (doc: DocNode) => void;
  onFocus: (editor: Editor) => void;
}): Editor {
  return new Editor({
    element: opts.element,
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
      Placeholder.configure({ placeholder: 'Write here. The toolbar adds lists, tables, images and charts.' })
    ],
    editorProps: { attributes: { class: 'rich', spellcheck: 'true' } },
    onUpdate: ({ editor }) => opts.onChange(editor.getJSON() as DocNode),
    onFocus: ({ editor }) => opts.onFocus(editor)
  });
}
