import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { CALLOUT_KINDS, PYQ_MARKS, PYQ_PAPERS } from '../lib/callouts';
import { addImage } from './images';
import { calloutAttrsAt, calloutKindAt, removeCallout, setCallout, setPyqDetails } from './callout';
import { addLineBy, besidePicture, isBelowPicture, setBelowPicture } from './flow';
import { CALLOUT_ITEMS, INSERT_ITEMS, cycleList, filterItems, insertBlocks, type InsertEnv, type InsertItem } from './insert';
import { sweepKey, type SlashHook } from './editor';
import type { PasteHooks } from './paste';
import { setSketchHooks } from './sketch-block';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Finger or pen? Android shows its own copy/paste menu ABOVE a touch selection,
 * so on touch the floating toolbar goes below it instead.
 */
let lastPointer: string | null = null;
document.addEventListener('pointerdown', (e) => (lastPointer = e.pointerType), true);
export function isTouchLike(): boolean {
  if (lastPointer) return lastPointer === 'touch' || lastPointer === 'pen';
  return window.matchMedia('(pointer: coarse)').matches;
}

/** The visible part of the page (the keyboard takes the rest), in page coordinates. */
function visibleBox() {
  const vv = window.visualViewport;
  return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: window.innerHeight };
}

function glyphEl(g: string) {
  return h('span', { class: 'ins-glyph', 'aria-hidden': 'true' }, g.startsWith('i:') ? icon(g.slice(2), 18) : g);
}

/** Highlighter sweep (200 ms) over the text that was just marked. Transform and opacity only. */
export function sweepMark(e: Editor) {
  if (reducedMotion()) return;
  const { from, to } = e.state.selection;
  if (from === to) return;
  try {
    const a = e.view.domAtPos(from);
    const b = e.view.domAtPos(to);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const rects = [...range.getClientRects()].filter((r) => r.width > 2).slice(0, 12);
    e.view.dispatch(e.state.tr.setMeta(sweepKey, { from, to }).setMeta('addToHistory', false));
    const layers = rects.map((r) =>
      h('div', { class: 'sweep', style: `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`, 'aria-hidden': 'true' })
    );
    document.body.append(...layers);
    window.setTimeout(() => {
      layers.forEach((l) => l.remove());
      if (!e.isDestroyed) e.view.dispatch(e.state.tr.setMeta(sweepKey, null).setMeta('addToHistory', false));
    }, 230);
  } catch {
    /* the sweep is decoration only */
  }
}

export function toggleMark(e: Editor) {
  const was = e.isActive('highlight');
  e.chain().focus().toggleHighlight().run();
  if (!was) sweepMark(e);
}

type Btn = HTMLButtonElement & { _active?: (e: Editor) => boolean; _enabled?: (e: Editor) => boolean };

export interface CanvasTools {
  slash: SlashHook;
  paste: PasteHooks;
  contextBar: HTMLElement;
  setEditor(e: Editor | null): void;
  detach(e: Editor): void;
  onBlur(e: Editor): void;
  openInsert(anchor: DOMRect): void;
  closeMenus(): boolean;
  /** Repaints the tools (after Undo / Redo changed what they can do). */
  refresh(): void;
  destroy(): void;
}

/** Note-wide Undo / Redo (text, sections, title …), owned by the note view. */
export interface UndoHooks {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export function createCanvasTools(opts: { noteId: () => string; toast: (t: string) => void; onDone: () => void; history: UndoHooks }): CanvasTools {
  let editor: Editor | null = null;
  const buttons: Btn[] = [];

  const btn = (label: string | Node, aria: string, run: (e: Editor) => void, cls = '', active?: (e: Editor) => boolean, enabled?: (e: Editor) => boolean): Btn => {
    const b = h('button', { type: 'button', class: cls, 'aria-label': aria, title: aria }, label) as Btn;
    b._active = active;
    b._enabled = enabled;
    b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep caret and keyboard in the editor
    b.addEventListener('click', () => {
      if (!editor) return;
      run(editor);
      sync();
    });
    buttons.push(b);
    return b;
  };

  // ---------- images ----------
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  let imageTarget: Editor | null = null;
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    const ed = imageTarget;
    if (!ed || !files.length) return;
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
  const env: InsertEnv = {
    pickImage: (e) => {
      imageTarget = e;
      fileInput.click();
    },
    toast: opts.toast
  };

  // ---------- insert menu (slash and +) ----------
  const menuList = h('div', { class: 'insert-list' });
  const menu = h('div', { class: 'insert-menu', role: 'listbox', 'aria-label': 'Insert', id: 'insert-menu', hidden: true }, menuList);
  let menuItems: InsertItem[] = [];
  let menuIndex = 0;
  let menuMode: 'slash' | 'pick' | null = null;
  let menuEditor: Editor | null = null;
  let slashRange: { from: number; to: number } | null = null;
  let dismissedAt: number | null = null;
  let lastQuery: string | null = null;

  function placeMenu(anchor: DOMRect, preferAbove: boolean) {
    const box = visibleBox();
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    let top = preferAbove ? anchor.top - mh - 8 : anchor.bottom + 8;
    if (!preferAbove && top + mh > box.bottom - 8) top = Math.max(box.top + 8, anchor.top - mh - 8);
    if (preferAbove && top < box.top + 8) top = anchor.bottom + 8;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - mw - 8));
    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function paintMenu() {
    menuList.replaceChildren();
    if (!menuItems.length) {
      menuList.append(h('div', { class: 'insert-empty' }, 'Nothing matches. Keep typing, or press Esc.'));
      return;
    }
    menuItems.forEach((it, i) => {
      const opt = h(
        'button',
        { type: 'button', role: 'option', class: `insert-opt${it.soon ? ' soon' : ''}`, 'aria-selected': String(i === menuIndex), 'data-item': it.id, tabindex: '-1' },
        glyphEl(it.glyph),
        h('span', { class: 'ins-text' }, h('strong', {}, it.name), h('span', {}, it.hint))
      );
      opt.addEventListener('pointerdown', (ev) => ev.preventDefault());
      opt.addEventListener('click', () => choose(i));
      menuList.append(opt);
    });
    (menuList.children[menuIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  function showMenu(items: InsertItem[], mode: 'slash' | 'pick', ed: Editor, anchor: DOMRect, preferAbove = false) {
    const wasOpen = !menu.hidden;
    menuItems = items;
    menuIndex = 0;
    menuMode = mode;
    menuEditor = ed;
    paintMenu();
    menu.hidden = false;
    if (!wasOpen && !reducedMotion()) {
      menu.classList.remove('enter');
      void menu.offsetWidth;
      menu.classList.add('enter');
    }
    placeMenu(anchor, preferAbove);
    syncBubble();
  }

  function closeMenu() {
    if (menu.hidden) return false;
    menu.hidden = true;
    menuMode = null;
    menuEditor = null;
    slashRange = null;
    lastQuery = null;
    syncBubble();
    return true;
  }

  function caretRect(ed: Editor): DOMRect {
    const c = ed.view.coordsAtPos(ed.state.selection.from);
    return new DOMRect(c.left, c.top, 1, c.bottom - c.top);
  }

  function choose(i: number) {
    const it = menuItems[i];
    const ed = menuEditor;
    if (!it || !ed) return;
    if (menuMode === 'slash' && slashRange) {
      ed.chain().focus().deleteRange(slashRange).run();
      dismissedAt = null;
    }
    if (it.submenu) {
      slashRange = null;
      showMenu(CALLOUT_ITEMS, 'pick', ed, caretRect(ed));
      return;
    }
    closeMenu();
    it.run(ed, env);
    sync();
  }

  const slash: SlashHook = {
    update(ed) {
      if (menuMode === 'pick') return;
      const { selection } = ed.state;
      const $f = selection.$from;
      const match =
        selection.empty && ed.isEditable && $f.parent.type.name === 'paragraph' && $f.parentOffset === $f.parent.content.size
          ? /^\/([a-z ]{0,24})$/i.exec($f.parent.textContent)
          : null;
      if (!match) {
        dismissedAt = null;
        if (menuMode === 'slash' && menuEditor === ed) closeMenu();
        return;
      }
      const start = $f.start();
      if (dismissedAt === start) return;
      const query = match[1];
      if (menuMode === 'slash' && menuEditor === ed && query === lastQuery) return;
      const items = filterItems(query);
      if (!items.length && /\s$/.test(query)) {
        dismissedAt = start;
        closeMenu();
        return;
      }
      lastQuery = query;
      showMenu(items, 'slash', ed, caretRect(ed));
      slashRange = { from: start, to: $f.pos };
    },
    keydown(ed, e) {
      if (menu.hidden || menuEditor !== ed) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!menuItems.length) return false;
        menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
        paintMenu();
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!menuItems.length) {
          closeMenu();
          return false;
        }
        choose(menuIndex);
        return true;
      }
      if (e.key === 'Escape') {
        if (menuMode === 'slash') dismissedAt = ed.state.selection.$from.start();
        closeMenu();
        return true;
      }
      if (menuMode === 'pick') closeMenu(); // typing closes the + menu and writes as usual
      return false;
    }
  };

  // A paste always wins over the slash menu: the typed "/word" goes, the menu closes, and pasted
  // text that happens to start with "/" doesn't open it.
  const paste: PasteHooks = {
    noteId: opts.noteId,
    toast: opts.toast,
    beforePaste(ed) {
      if (menuMode === 'slash' && menuEditor === ed && slashRange) {
        ed.view.dispatch(ed.state.tr.delete(slashRange.from, slashRange.to));
      }
      if (menuMode) closeMenu();
      dismissedAt = ed.state.selection.$from.start();
    }
  };

  // ---------- floating toolbar on a text selection ----------
  const linkInput = h('input', { type: 'url', class: 'link-input', placeholder: 'https://…', 'aria-label': 'Link address', inputmode: 'url' });
  const linkApply = h('button', { type: 'button', class: 'primary' }, 'Apply');
  const linkRemove = h('button', { type: 'button', class: 'danger-outline' }, 'Remove link');
  const linkCancel = h('button', { type: 'button' }, 'Cancel');
  const linkRow = h('div', { class: 'link-row', role: 'group', 'aria-label': 'Link', hidden: true }, linkInput, linkApply, linkRemove, linkCancel);
  const bubbleBtns = h(
    'div',
    { class: 'bubble-btns' },
    btn('B', 'Bold', (e) => e.chain().focus().toggleBold().run(), 'fb b', (e) => e.isActive('bold')),
    btn('I', 'Italic', (e) => e.chain().focus().toggleItalic().run(), 'fb i', (e) => e.isActive('italic')),
    btn('U', 'Underline', (e) => e.chain().focus().toggleUnderline().run(), 'fb u', (e) => e.isActive('underline')),
    btn('Mark', 'Highlight', (e) => toggleMark(e), 'fb mark', (e) => e.isActive('highlight')),
    btn('Link', 'Add, edit or remove a link', () => openLinkRow(), 'fb', (e) => e.isActive('link'))
  );
  const bubble = h('div', { class: 'bubble', role: 'toolbar', 'aria-label': 'Format selection', id: 'bubble', hidden: true }, bubbleBtns, linkRow);
  let linkFor: Editor | null = null;

  function closeLinkRow(refocus = true) {
    linkRow.hidden = true;
    bubble.classList.remove('linking');
    const e = linkFor;
    linkFor = null;
    if (refocus) e?.commands.focus();
    sync();
  }
  function openLinkRow() {
    if (!editor) return;
    linkFor = editor;
    const href = editor.getAttributes('link').href as string | undefined;
    linkInput.value = href ?? '';
    linkRemove.hidden = !href;
    linkRow.hidden = false;
    bubble.classList.add('linking');
    bubble.hidden = false;
    placeBubble();
    linkInput.focus();
    linkInput.select();
  }
  function applyLink() {
    const e = linkFor;
    if (!e) return;
    let url = linkInput.value.trim();
    if (!url) return closeLinkRow();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    const { empty } = e.state.selection;
    if (empty && !e.isActive('link')) {
      e.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    } else {
      e.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    closeLinkRow(false);
  }
  linkApply.addEventListener('click', applyLink);
  linkInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      applyLink();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeLinkRow();
    }
  });
  linkRemove.addEventListener('click', () => {
    linkFor?.chain().focus().extendMarkRange('link').unsetLink().run();
    closeLinkRow(false);
  });
  linkCancel.addEventListener('click', () => closeLinkRow());

  function hasTextSelection(e: Editor) {
    const s = e.state.selection;
    return s instanceof TextSelection && !s.empty;
  }

  function placeBubble() {
    const e = linkFor ?? editor;
    if (!e || bubble.hidden) return;
    const { from, to, empty } = e.state.selection;
    const a = e.view.coordsAtPos(from);
    const b = empty ? a : e.view.coordsAtPos(to);
    const top = Math.min(a.top, b.top);
    const bottom = Math.max(a.bottom, b.bottom);
    const sameLine = Math.abs(a.top - b.top) < 4;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const box = visibleBox();
    const barH = touchbar.hidden || !touchbar.offsetParent ? 0 : touchbar.offsetHeight;
    const headBottom = (document.querySelector('.canvas-head') as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0;
    let y: number;
    let below: boolean;
    if (isTouchLike()) {
      // below the selection and clear of Android's selection handles
      y = bottom + 34;
      below = true;
      if (y + bh > box.bottom - barH - 8) {
        y = top - bh - 12;
        below = false;
      }
    } else {
      y = top - bh - 10;
      below = false;
      if (y < Math.max(box.top, headBottom) + 4) {
        y = bottom + 10;
        below = true;
      }
    }
    const cx = sameLine ? (a.left + b.left) / 2 : a.left + 60;
    const x = Math.max(8, Math.min(cx - bw / 2, window.innerWidth - bw - 8));
    bubble.dataset.place = below ? 'below' : 'above';
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function syncBubble() {
    if (linkFor) return; // the link box keeps the toolbar open while typing a link
    const e = editor;
    const show = !!e && e.isFocused && hasTextSelection(e) && menu.hidden;
    bubble.hidden = !show;
    if (show) placeBubble();
  }

  // ---------- context bar: table, image, chart, callout ----------
  const inTable = (e: Editor) => e.isActive('table');
  const selectedBlock = (e: Editor, name?: string) => {
    const s = e.state.selection;
    return s instanceof NodeSelection && (name ? s.node.type.name === name : ['imageBlock', 'chartBlock', 'sketchBlock'].includes(s.node.type.name));
  };
  /** A selected picture, sketch or chart (0.11): they float with text beside them. Pictures and sketches take a caption. */
  const FLOATS = ['imageBlock', 'sketchBlock', 'chartBlock'];
  const selectedFloat = (e: Editor) => {
    const s = e.state.selection;
    return s instanceof NodeSelection && FLOATS.includes(s.node.type.name) ? s : null;
  };
  const floatAlign = (e: Editor) => selectedFloat(e)?.node.attrs.align;
  const centerFloat = (e: Editor) => {
    const s = selectedFloat(e);
    if (s) e.view.dispatch(e.state.tr.setNodeMarkup(s.from, undefined, { ...s.node.attrs, align: 'center' }));
  };
  const tableOps = h(
    'div',
    { class: 'ctx-group tb-table', role: 'group', 'aria-label': 'Table' },
    h('span', { class: 'ctx-label' }, 'Table'),
    btn('+ Row', 'Add row below', (e) => e.chain().focus().addRowAfter().run(), 'tb'),
    btn('+ Column', 'Add column to the right', (e) => e.chain().focus().addColumnAfter().run(), 'tb'),
    btn('− Row', 'Delete row', (e) => e.chain().focus().deleteRow().run(), 'tb'),
    btn('− Column', 'Delete column', (e) => e.chain().focus().deleteColumn().run(), 'tb'),
    btn('Header row', 'Turn header row on or off', (e) => e.chain().focus().toggleHeaderRow().run(), 'tb'),
    btn('Fit width', 'Fit the table to the page width', (e) => fitTable(e), 'tb', undefined, (e) => !!tableAt(e) && hasColWidths(tableAt(e)!.node)),
    btn('Delete table', 'Delete table', (e) => e.chain().focus().deleteTable().run(), 'tb danger')
  );
  /** The table around the caret. */
  const tableAt = (e: Editor) => {
    const { $from } = e.state.selection;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return { pos: $from.before(d), node: $from.node(d) };
    return null;
  };
  const hasColWidths = (table: PMNode) => {
    let found = false;
    table.descendants((n) => {
      if (Array.isArray(n.attrs.colwidth) && n.attrs.colwidth.some(Boolean)) found = true;
      return !found;
    });
    return found;
  };
  /** Columns dragged to a width keep it; this hands them back to the page width (equal shares). */
  const fitTable = (e: Editor) => {
    const t = tableAt(e);
    if (!t) return;
    const tr = e.state.tr;
    t.node.descendants((n, pos) => {
      if (n.attrs.colwidth) tr.setNodeMarkup(t.pos + 1 + pos, undefined, { ...n.attrs, colwidth: null });
    });
    e.view.dispatch(tr);
  };

  /**
   * Left/right float the image so text sits beside it; a full-width image is narrowed to half so there's room.
   * A float only wraps what comes after it, so when an image first starts floating it moves up above the
   * paragraph or list just before it: the line typed before the picture ends up beside it.
   */
  const wrapImage = (e: Editor, align: 'left' | 'right') => {
    const sel = e.state.selection;
    if (!(sel instanceof NodeSelection) || !FLOATS.includes(sel.node.type.name)) return;
    const node = sel.node;
    const width = Number(node.attrs.width) || 100;
    const tr = e.state.tr.setNodeMarkup(sel.from, undefined, { ...node.attrs, align, width: width > 60 ? 50 : width });
    if (node.attrs.align === 'center') {
      const $pos = tr.doc.resolve(sel.from);
      const prev = $pos.index() > 0 ? $pos.parent.child($pos.index() - 1) : null;
      if (prev && ['paragraph', 'bulletList', 'orderedList'].includes(prev.type.name) && prev.textContent.trim()) {
        const moved = tr.doc.nodeAt(sel.from)!;
        const target = sel.from - prev.nodeSize;
        tr.delete(sel.from, sel.from + moved.nodeSize).insert(target, moved);
        // the line that now follows the picture sits beside it, even if it was set to start below
        if (prev.attrs.clear) tr.setNodeMarkup(target + moved.nodeSize, undefined, { ...prev.attrs, clear: null });
        tr.setSelection(NodeSelection.create(tr.doc, target));
      }
    }
    e.view.dispatch(tr.scrollIntoView());
  };
  const openCrop = (e: Editor) => {
    const sel = e.state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'imageBlock') return;
    (e.view.nodeDOM(sel.from) as HTMLElement | null)?.dispatchEvent(new CustomEvent('open-crop'));
  };
  // Caption: written when the box is left (or Enter), so one caption is one Undo step.
  const captionInput = h('input', { type: 'text', class: 'ctx-input caption-input', id: 'image-caption', placeholder: 'Caption', 'aria-label': 'Picture caption', maxlength: 200 });
  let captionFor: { e: Editor; pos: number; type: string; imageId: unknown } | null = null;
  captionInput.addEventListener('focus', () => {
    const e = editor;
    const sel = e?.state.selection;
    captionFor = e && sel instanceof NodeSelection && FLOATS.includes(sel.node.type.name) ? { e, pos: sel.from, type: sel.node.type.name, imageId: sel.node.attrs.imageId } : null;
  });
  const commitCaption = () => {
    const t = captionFor;
    if (!t || t.e.isDestroyed) return;
    const node = t.e.state.doc.nodeAt(t.pos);
    if (!node || node.type.name !== t.type || node.attrs.imageId !== t.imageId) return;
    const caption = captionInput.value.trim();
    if (caption === (node.attrs.caption ?? '')) return;
    t.e.view.dispatch(t.e.state.tr.setNodeMarkup(t.pos, undefined, { ...node.attrs, caption }));
  };
  captionInput.addEventListener('change', commitCaption);
  captionInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    commitCaption();
    const t = captionFor;
    if (t && !t.e.isDestroyed && t.e.state.doc.nodeAt(t.pos)?.type.name === t.type) {
      t.e.view.dispatch(t.e.state.tr.setSelection(NodeSelection.create(t.e.state.doc, t.pos)));
      t.e.commands.focus();
    }
  });

  const imageLabel = h('span', { class: 'ctx-label' }, 'Image');
  const cropBtn = btn(h('span', { class: 'tb-ic' }, icon('crop', 18), 'Crop & shape'), 'Crop and shape', (e) => openCrop(e), 'tb');
  const imageOps = h(
    'div',
    { class: 'ctx-group tb-align', role: 'group', 'aria-label': 'Image' },
    imageLabel,
    btn('Left · text beside', 'Align image left', (e) => wrapImage(e, 'left'), 'tb', (e) => floatAlign(e) === 'left'),
    btn('Center', 'Center image', (e) => centerFloat(e), 'tb', (e) => floatAlign(e) === 'center'),
    btn('Right · text beside', 'Align image right', (e) => wrapImage(e, 'right'), 'tb', (e) => floatAlign(e) === 'right'),
    cropBtn,
    btn('+ Line above', 'Add a line above the picture', (e) => addLineBy(e, 'above'), 'tb'),
    btn('+ Line below', 'Add a line below the picture', (e) => addLineBy(e, 'below'), 'tb'),
    captionInput
  );
  const removeBlock = btn('Remove', 'Remove selected image or chart', (e) => e.chain().focus().deleteSelection().run(), 'tb danger');
  const blockOps = h('div', { class: 'ctx-group', role: 'group', 'aria-label': 'Selected block' }, removeBlock);
  // PYQ details: year, paper, marks (written when chosen, or when the year box is left).
  const pyqYear = h('input', { type: 'text', class: 'ctx-input pyq-year', id: 'pyq-year', inputmode: 'numeric', maxlength: 4, placeholder: 'Year', 'aria-label': 'PYQ year' });
  const pyqPaper = h('select', { class: 'ctx-select', id: 'pyq-paper', 'aria-label': 'PYQ paper' }, h('option', { value: '' }, 'Paper'), ...PYQ_PAPERS.map((p) => h('option', { value: p }, p)));
  const pyqMarks = h('select', { class: 'ctx-select', id: 'pyq-marks', 'aria-label': 'PYQ marks' }, h('option', { value: '' }, 'Marks'), ...PYQ_MARKS.map((m) => h('option', { value: m }, `${m} marks`)));
  const pyqFields = h('span', { class: 'pyq-fields', hidden: true }, pyqYear, pyqPaper, pyqMarks);
  let pyqFor: Editor | null = null;
  for (const el of [pyqYear, pyqPaper, pyqMarks]) el.addEventListener('focus', () => (pyqFor = editor));
  const commitPyq = () => {
    const e = pyqFor ?? editor;
    if (!e || e.isDestroyed) return;
    const year = pyqYear.value.replace(/\D/g, '').slice(0, 4);
    pyqYear.value = year;
    const a = calloutAttrsAt(e);
    if (!a || a.kind !== 'pyq') return;
    if ((a.year ?? '') === year && (a.paper ?? '') === pyqPaper.value && (a.marks ?? '') === pyqMarks.value) return;
    setPyqDetails(e, { year, paper: pyqPaper.value, marks: pyqMarks.value });
  };
  pyqYear.addEventListener('change', commitPyq);
  pyqYear.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    commitPyq();
    (pyqFor ?? editor)?.commands.focus();
  });
  pyqPaper.addEventListener('change', commitPyq);
  pyqMarks.addEventListener('change', commitPyq);
  const calloutOps = h(
    'div',
    { class: 'ctx-group tb-callout', role: 'group', 'aria-label': 'Callout' },
    h('span', { class: 'ctx-label' }, 'Callout'),
    ...CALLOUT_KINDS.map((k) => btn(k.label, `${k.label} callout`, (e) => setCallout(e, k.id), 'tb', (e) => calloutKindAt(e) === k.id)),
    btn('Remove box', 'Remove callout box, keep the text', (e) => removeCallout(e), 'tb danger'),
    pyqFields
  );
  // A line beside a floated picture can start below it instead (and back).
  const belowBtn = btn('↓ Below picture', 'Start this line below the picture', (e) => setBelowPicture(e, true), 'tb');
  const besideBtn = btn('↑ Beside picture', 'Put this line back beside the picture', (e) => setBelowPicture(e, false), 'tb');
  const flowOps = h('div', { class: 'ctx-group tb-flow', role: 'group', 'aria-label': 'Text and picture' }, h('span', { class: 'ctx-label' }, 'Text'), belowBtn, besideBtn);
  const contextBar = h('div', { class: 'ctxbar', id: 'ctxbar', role: 'toolbar', 'aria-label': 'Block tools', hidden: true }, tableOps, imageOps, blockOps, flowOps, calloutOps);

  // ---------- touch bar (portrait, above the keyboard) ----------
  const insertBtn = h('button', { type: 'button', class: 'tbar-btn', 'aria-label': 'Insert', id: 'tbar-insert' }, icon('plus', 24));
  insertBtn.addEventListener('pointerdown', (ev) => ev.preventDefault());
  insertBtn.addEventListener('click', () => {
    if (!menu.hidden) return void closeMenu();
    openInsert(touchbar.getBoundingClientRect());
  });
  const doneBtn = h('button', { type: 'button', class: 'tbar-btn done', 'aria-label': 'Done writing', id: 'tbar-done' }, 'Done');
  doneBtn.addEventListener('pointerdown', (ev) => ev.preventDefault());
  doneBtn.addEventListener('click', () => {
    closeMenu();
    editor?.commands.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.classList.remove('writing');
    opts.onDone();
  });
  const touchbar = h(
    'div',
    { class: 'touchbar', role: 'toolbar', 'aria-label': 'Writing tools', id: 'touchbar' },
    insertBtn,
    btn(h('span', { class: 'mark-chip' }, 'Mark'), 'Mark (highlight)', (e) => toggleMark(e), 'tbar-btn', (e) => e.isActive('highlight')),
    btn(icon('list', 24), 'List: bullets, dashes, numbers, off', (e) => cycleList(e), 'tbar-btn', (e) => e.isActive('bulletList') || e.isActive('orderedList')),
    btn(icon('undo', 24), 'Undo', () => opts.history.undo(), 'tbar-btn', undefined, () => opts.history.canUndo()),
    btn(icon('redo', 24), 'Redo', () => opts.history.redo(), 'tbar-btn', undefined, () => opts.history.canRedo()),
    doneBtn
  );

  function placeTouchbar() {
    const vv = window.visualViewport;
    const kb = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
    touchbar.style.transform = kb ? `translateY(${-kb}px)` : '';
  }

  function openInsert(anchor: DOMRect) {
    const e = editor;
    if (!e) return;
    const items = [...INSERT_ITEMS.filter((i) => !i.plusOnly || i.plusOnly(e))];
    showMenu(items, 'pick', e, anchor, true);
  }

  // ---------- sync ----------
  function sync() {
    const e = editor;
    for (const b of buttons) {
      b.disabled = !e || (b._enabled ? !b._enabled(e) : false);
      if (b._active) b.setAttribute('aria-pressed', String(!!e && b._active(e)));
    }
    if (e) {
      tableOps.hidden = !inTable(e);
      const float = selectedFloat(e);
      imageOps.hidden = !float;
      const type = float?.node.type.name;
      const label = type === 'sketchBlock' ? 'Sketch' : type === 'chartBlock' ? 'Chart' : 'Image';
      imageLabel.textContent = label;
      imageOps.setAttribute('aria-label', label);
      cropBtn.hidden = type !== 'imageBlock';
      captionInput.hidden = type === 'chartBlock'; // a chart has its own title
      blockOps.hidden = !selectedBlock(e);
      const kind = calloutKindAt(e);
      calloutOps.hidden = !kind;
      pyqFields.hidden = kind !== 'pyq';
      if (kind === 'pyq') {
        const a = calloutAttrsAt(e)!;
        if (document.activeElement !== pyqYear) pyqYear.value = String(a.year ?? '');
        pyqPaper.value = String(a.paper ?? '');
        pyqMarks.value = String(a.marks ?? '');
      }
      if (float && document.activeElement !== captionInput) captionInput.value = String(float.node.attrs.caption ?? '');
      const below = isBelowPicture(e);
      const beside = !below && e.state.selection.empty && besidePicture(e);
      belowBtn.hidden = !beside;
      besideBtn.hidden = !below;
      flowOps.hidden = !below && !beside;
      contextBar.hidden = tableOps.hidden && imageOps.hidden && blockOps.hidden && calloutOps.hidden && flowOps.hidden;
    } else {
      contextBar.hidden = true;
    }
    syncBubble();
  }

  const onTx = () => sync();
  const onScroll = () => {
    if (!bubble.hidden) placeBubble();
    if (!menu.hidden && menuEditor && menuMode === 'slash') placeMenu(caretRect(menuEditor), false);
  };
  const onViewport = () => {
    placeTouchbar();
    onScroll();
  };
  const onDocPointer = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (!menu.hidden && !menu.contains(t) && !touchbar.contains(t)) closeMenu();
  };
  window.addEventListener('scroll', onScroll, true);
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', onViewport);
  document.addEventListener('pointerdown', onDocPointer);
  document.body.append(menu, bubble, touchbar, fileInput);
  setSketchHooks(opts.history);

  return {
    slash,
    paste,
    contextBar,
    setEditor(next) {
      if (editor !== next) {
        editor?.off('transaction', onTx);
        editor = next;
        editor?.on('transaction', onTx);
      }
      if (next) {
        document.body.classList.add('writing');
        placeTouchbar();
      } else {
        // the note closed under the caret: no touch bar without an editor
        closeMenu();
        document.body.classList.remove('writing');
      }
      sync();
    },
    detach(target) {
      if (menuEditor === target) closeMenu();
      if (linkFor === target) closeLinkRow(false);
      if (editor === target) this.setEditor(null);
    },
    onBlur(target) {
      // Let the focus land first: tapping the touch bar or the link box keeps writing mode.
      window.setTimeout(() => {
        const a = document.activeElement;
        const stillWriting = !!a && (a.closest('.ProseMirror') || bubble.contains(a) || touchbar.contains(a));
        if (!stillWriting) {
          document.body.classList.remove('writing');
          if (menuEditor === target) closeMenu();
        }
        if (editor === target) syncBubble();
      }, 0);
    },
    openInsert,
    refresh: () => sync(),
    closeMenus() {
      if (linkFor) {
        closeLinkRow();
        return true;
      }
      // Esc on the slash menu keeps the typed "/word" and does not reopen until the line changes.
      if (menuMode === 'slash' && menuEditor) dismissedAt = menuEditor.state.selection.$from.start();
      return closeMenu();
    },
    destroy() {
      editor?.off('transaction', onTx);
      editor = null;
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', onViewport);
      window.visualViewport?.removeEventListener('scroll', onViewport);
      document.removeEventListener('pointerdown', onDocPointer);
      setSketchHooks(null);
      menu.remove();
      bubble.remove();
      touchbar.remove();
      fileInput.remove();
      document.body.classList.remove('writing');
    }
  };
}
