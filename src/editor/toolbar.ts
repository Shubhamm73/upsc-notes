import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { h } from '../lib/h';
import { addImage } from './images';
import { DEFAULT_CHART } from './chart-block';

type Btn = HTMLButtonElement & { _active?: (e: Editor) => boolean; _enabled?: (e: Editor) => boolean };

/**
 * One sticky toolbar per open note. It acts on whichever section editor
 * was focused last. Buttons keep the editor's selection (no focus steal).
 */
export function createToolbar(opts: { noteId: () => string; toast: (t: string) => void }) {
  let editor: Editor | null = null;
  const buttons: Btn[] = [];

  const btn = (
    label: string,
    aria: string,
    run: (e: Editor) => void,
    active?: (e: Editor) => boolean,
    enabled?: (e: Editor) => boolean,
    cls = ''
  ): Btn => {
    const b = h('button', { type: 'button', class: `tb ${cls}`, 'aria-label': aria, title: aria }, label) as Btn;
    b._active = active;
    b._enabled = enabled;
    b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep caret in the editor
    b.addEventListener('click', () => {
      if (!editor) return;
      run(editor);
      sync();
    });
    buttons.push(b);
    return b;
  };

  const blockSelect = h(
    'select',
    { class: 'tb-select', 'aria-label': 'Text style' },
    h('option', { value: 'p' }, 'Text'),
    h('option', { value: '2' }, 'Heading 1'),
    h('option', { value: '3' }, 'Heading 2'),
    h('option', { value: '4' }, 'Heading 3')
  );
  blockSelect.addEventListener('change', () => {
    if (!editor) return;
    const v = blockSelect.value;
    if (v === 'p') editor.chain().focus().setParagraph().run();
    else editor.chain().focus().setHeading({ level: Number(v) as 2 | 3 | 4 }).run();
  });

  const inList = (e: Editor) => e.isActive('bulletList') || e.isActive('orderedList');
  const inTable = (e: Editor) => e.isActive('table');
  const blockSelected = (e: Editor) => {
    const s = e.state.selection;
    return s instanceof NodeSelection && ['imageBlock', 'chartBlock'].includes(s.node.type.name);
  };
  const imageSelected = (e: Editor) => {
    const s = e.state.selection;
    return s instanceof NodeSelection && s.node.type.name === 'imageBlock';
  };

  const setList = (e: Editor, style: 'disc' | 'dash') => {
    const isBullet = e.isActive('bulletList');
    const current = e.getAttributes('bulletList').listStyle ?? 'disc';
    if (isBullet && current === style) e.chain().focus().toggleBulletList().run();
    else if (isBullet) e.chain().focus().updateAttributes('bulletList', { listStyle: style }).run();
    else e.chain().focus().toggleBulletList().updateAttributes('bulletList', { listStyle: style }).run();
  };

  /** Inserts blocks after a selected image or chart instead of replacing it. */
  const insertBlocks = (e: Editor, content: object | object[]) => {
    const s = e.state.selection;
    if (s instanceof NodeSelection) e.chain().focus().insertContentAt(s.to, content).run();
    else e.chain().focus().insertContent(content).run();
  };

  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (!editor || !files.length) return;
    const ed = editor;
    const blocks: object[] = [];
    for (const f of files) {
      try {
        const { id, width, height } = await addImage(f, opts.noteId());
        blocks.push({ type: 'imageBlock', attrs: { imageId: id, width: height > width ? 50 : 100, align: 'center' } });
      } catch {
        opts.toast(`"${f.name}" couldn't be added. Try a JPG or PNG photo.`);
      }
    }
    if (blocks.length && !ed.isDestroyed) insertBlocks(ed, blocks);
  });

  const tableOps = h(
    'div',
    { class: 'tb-group tb-table', role: 'group', 'aria-label': 'Table' },
    btn('+ Row', 'Add row below', (e) => e.chain().focus().addRowAfter().run()),
    btn('+ Column', 'Add column to the right', (e) => e.chain().focus().addColumnAfter().run()),
    btn('− Row', 'Delete row', (e) => e.chain().focus().deleteRow().run()),
    btn('− Column', 'Delete column', (e) => e.chain().focus().deleteColumn().run()),
    btn('Header row', 'Turn header row on or off', (e) => e.chain().focus().toggleHeaderRow().run()),
    btn('Delete table', 'Delete table', (e) => e.chain().focus().deleteTable().run(), undefined, undefined, 'danger')
  );

  const alignOps = h(
    'div',
    { class: 'tb-group tb-align', role: 'group', 'aria-label': 'Image' },
    btn('Left', 'Align image left', (e) => e.chain().updateAttributes('imageBlock', { align: 'left' }).run(), (e) => imageSelected(e) && e.getAttributes('imageBlock').align === 'left', imageSelected),
    btn('Center', 'Center image', (e) => e.chain().updateAttributes('imageBlock', { align: 'center' }).run(), (e) => imageSelected(e) && e.getAttributes('imageBlock').align === 'center', imageSelected),
    btn('Right', 'Align image right', (e) => e.chain().updateAttributes('imageBlock', { align: 'right' }).run(), (e) => imageSelected(e) && e.getAttributes('imageBlock').align === 'right', imageSelected),
    btn('Remove', 'Remove selected image or chart', (e) => e.chain().focus().deleteSelection().run(), undefined, blockSelected, 'danger')
  );

  const el = h(
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    h('div', { class: 'tb-group' }, blockSelect),
    h(
      'div',
      { class: 'tb-group', role: 'group', 'aria-label': 'Text' },
      btn('B', 'Bold', (e) => e.chain().focus().toggleBold().run(), (e) => e.isActive('bold'), undefined, 'b'),
      btn('I', 'Italic', (e) => e.chain().focus().toggleItalic().run(), (e) => e.isActive('italic'), undefined, 'i'),
      btn('U', 'Underline', (e) => e.chain().focus().toggleUnderline().run(), (e) => e.isActive('underline'), undefined, 'u'),
      btn('Mark', 'Highlight', (e) => e.chain().focus().toggleHighlight().run(), (e) => e.isActive('highlight'), undefined, 'mark'),
      btn(
        'Link',
        'Add or remove link',
        (e) => {
          if (e.isActive('link')) {
            e.chain().focus().unsetLink().run();
            return;
          }
          const url = window.prompt('Link address (https://…)');
          if (url) e.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        },
        (e) => e.isActive('link')
      )
    ),
    h(
      'div',
      { class: 'tb-group', role: 'group', 'aria-label': 'Lists' },
      btn('• List', 'Bullet list', (e) => setList(e, 'disc'), (e) => e.isActive('bulletList') && e.getAttributes('bulletList').listStyle !== 'dash'),
      btn('– List', 'Dash list', (e) => setList(e, 'dash'), (e) => e.isActive('bulletList') && e.getAttributes('bulletList').listStyle === 'dash'),
      btn('1. List', 'Numbered list', (e) => e.chain().focus().toggleOrderedList().run(), (e) => e.isActive('orderedList')),
      btn('Indent', 'Indent list item', (e) => e.chain().focus().sinkListItem('listItem').run(), undefined, (e) => inList(e) && e.can().sinkListItem('listItem')),
      btn('Outdent', 'Outdent list item', (e) => e.chain().focus().liftListItem('listItem').run(), undefined, (e) => inList(e) && e.can().liftListItem('listItem'))
    ),
    h(
      'div',
      { class: 'tb-group', role: 'group', 'aria-label': 'Insert' },
      btn('Table', 'Insert table', (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), undefined, (e) => !inTable(e)),
      btn('Image', 'Insert image from this device', () => fileInput.click()),
      btn('Chart', 'Insert chart', (e) => insertBlocks(e, { type: 'chartBlock', attrs: structuredClone(DEFAULT_CHART) }))
    ),
    tableOps,
    alignOps,
    h(
      'div',
      { class: 'tb-group', role: 'group', 'aria-label': 'History' },
      btn('Undo', 'Undo', (e) => e.chain().focus().undo().run(), undefined, (e) => e.can().undo()),
      btn('Redo', 'Redo', (e) => e.chain().focus().redo().run(), undefined, (e) => e.can().redo())
    ),
    fileInput
  );

  function sync() {
    const e = editor;
    el.classList.toggle('no-editor', !e);
    for (const b of buttons) {
      b.disabled = !e || (b._enabled ? !b._enabled(e) : false);
      b.setAttribute('aria-pressed', String(!!e && !!b._active?.(e)));
      if (!b._active) b.removeAttribute('aria-pressed');
    }
    if (e) {
      const level = [2, 3, 4].find((l) => e.isActive('heading', { level: l }));
      blockSelect.value = level ? String(level) : 'p';
      tableOps.hidden = !inTable(e);
      alignOps.hidden = !blockSelected(e);
    } else {
      tableOps.hidden = true;
      alignOps.hidden = true;
    }
  }

  const onTx = () => sync();
  return {
    el,
    setEditor(next: Editor | null) {
      if (editor === next) return;
      editor?.off('transaction', onTx);
      editor = next;
      editor?.on('transaction', onTx);
      sync();
    },
    detach(target: Editor) {
      if (editor === target) this.setEditor(null);
    }
  };
}
