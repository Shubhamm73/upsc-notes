import { Extension, type Editor } from '@tiptap/core';
import { Table, TableView } from '@tiptap/extension-table';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { addColumn, addRow, removeColumn, removeRow, TableMap } from '@tiptap/pm/tables';
import { closeHistory } from '@tiptap/pm/history';
import { Transform } from '@tiptap/pm/transform';
import { colourKey, figureColumns, tableStyle, TABLE_MAX_COLS, TABLE_MAX_ROWS, type TableStyle } from '../lib/looks';
import { figAlign, figWidth, placeFigure, sizeGrip, type FigAlign } from './figure-kit';

/**
 * Tables (0.12) sit on a raised card with a style (Clean, Banded, Lined, Boxed, Minimal), a colour (null
 * follows the subject), an optional caption and an optional bold first column:
 * { type: 'table', attrs: { tstyle, color, caption, firstCol }, content: [rows] }. The style attribute is
 * `tstyle`, not `style`: TipTap writes a table's `style` attribute straight into the table's CSS.
 * Tables from before 0.12 have none of these and show in Clean, first column as it was (not bold).
 */
const text = (name: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) || null,
  renderHTML: (a: Record<string, unknown>) => (a[name] ? { [`data-${name}`]: String(a[name]) } : {})
});

/** The table's card: caption above, the table (scrolling sideways in its own box) below. */
class CardTableView extends TableView {
  card: HTMLDivElement;
  cap: HTMLDivElement;
  grip: HTMLButtonElement;
  constructor(node: PMNode, cellMinWidth: number, view?: EditorView) {
    super(node, cellMinWidth, view);
    this.card = document.createElement('div');
    this.card.className = 'table-card';
    this.cap = document.createElement('div');
    this.cap.className = 'table-cap';
    this.cap.contentEditable = 'false';
    // 0.16: drag the corner to any width; left / right put text beside the table
    const grip = sizeGrip(this.card, 'Drag to resize table', () => ({ align: this.node.attrs.align, width: this.node.attrs.width }), (pct) => {
      const v = view;
      if (!v) return;
      let at = -1;
      v.state.doc.descendants((n, pos) => {
        if (at >= 0) return false;
        if (n === this.node) at = pos;
        return at < 0;
      });
      if (at >= 0 && pct !== this.node.attrs.width) v.dispatch(v.state.tr.setNodeMarkup(at, undefined, { ...this.node.attrs, width: pct >= 100 ? null : pct }));
      else this.paint(this.node);
    });
    this.grip = grip.handle;
    this.card.append(this.cap, this.dom, grip.handle, grip.tag);
    this.dom = this.card;
    this.paint(node);
  }
  ignoreMutation(record: Parameters<TableView['ignoreMutation']>[0]) {
    if ((record.target as Node) === this.grip || this.grip.contains(record.target as Node) || (record.target as HTMLElement).classList?.contains('fig-size')) return true;
    if (record.type === 'attributes' && record.target === this.card) return true;
    return super.ignoreMutation(record);
  }
  stopEvent(e: Event) {
    return e.target === this.grip;
  }
  paint(node: PMNode) {
    const a = node.attrs;
    placeFigure(this.card, a.align, a.width);
    this.card.dataset.tstyle = tableStyle(a.tstyle);
    const c = colourKey(a.color);
    if (c) this.card.style.setProperty('--tc', `var(--sub-${c})`);
    else this.card.style.removeProperty('--tc');
    if (a.firstCol) this.card.dataset.firstCol = 'bold';
    else delete this.card.dataset.firstCol;
    if (a.clear) this.card.dataset.clear = 'both';
    else delete this.card.dataset.clear;
    const caption = typeof a.caption === 'string' ? a.caption.trim() : '';
    this.cap.textContent = caption;
    this.cap.hidden = !caption;
  }
  update(node: PMNode) {
    if (!super.update(node)) return false;
    this.paint(node);
    return true;
  }
}

export const StyledTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tstyle: text('tstyle'),
      color: text('color'),
      caption: text('caption'),
      // 0.16: left / right float the table with text beside it; width in % of the column (null: full)
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => (['left', 'right'].includes(el.getAttribute('data-align') ?? '') ? el.getAttribute('data-align') : null),
        renderHTML: (a: { align?: string | null }) => (a.align === 'left' || a.align === 'right' ? { 'data-align': a.align } : {})
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-width')) || null,
        renderHTML: (a: { width?: number | null }) => (a.width ? { 'data-width': String(a.width) } : {})
      },
      firstCol: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-first-col') === 'bold' ? true : null),
        renderHTML: (a: { firstCol?: boolean | null }) => (a.firstCol ? { 'data-first-col': 'bold' } : {})
      }
    };
  }
}).configure({ resizable: true, cellMinWidth: 80, View: CardTableView as unknown as typeof TableView });

/** The cells of a table with their columns (TableMap), for working out which columns hold figures. */
function figureCols(table: PMNode): Set<number> {
  const map = TableMap.get(table);
  const cells: { header: boolean; col: number; span: number; text: string }[] = [];
  const seen = new Set<number>();
  for (const pos of map.map) {
    if (seen.has(pos)) continue;
    seen.add(pos);
    const cell = table.nodeAt(pos)!;
    const r = map.findCell(pos);
    cells.push({ header: cell.type.name === 'tableHeader', col: r.left, span: r.right - r.left, text: cell.textContent });
  }
  return figureColumns(cells);
}

function figureDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    // 0.17: no table lives inside a paragraph or heading, so their text is not walked on every keystroke
    if (node.type.name !== 'table') return !node.isTextblock;
    const cols = figureCols(node);
    if (cols.size) {
      const map = TableMap.get(node);
      const seen = new Set<number>();
      for (const rel of map.map) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const r = map.findCell(rel);
        if (r.right - r.left !== 1 || !cols.has(r.left)) continue;
        const cell = node.nodeAt(rel)!;
        const from = pos + 1 + rel;
        decos.push(Decoration.node(from, from + cell.nodeSize, { class: cell.type.name === 'tableHeader' ? 'num-head' : 'num' }));
      }
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** Right-aligns figure columns (decorations: worked out on screen, never stored). */
export const TableFigures = Extension.create({
  name: 'tableFigures',
  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>('tableFigures');
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_c, state) => figureDecorations(state.doc),
          apply: (tr, set, _old, state) => (tr.docChanged ? figureDecorations(state.doc) : set)
        },
        props: { decorations: (state) => key.getState(state) }
      })
    ];
  }
});

// ---------- commands ----------

/** The table round the caret. */
export function tableAt(e: Editor | EditorState): { pos: number; node: PMNode } | null {
  const state = 'state' in e ? e.state : e;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return { pos: $from.before(d), node: $from.node(d) };
  return null;
}

export function tableSize(table: PMNode): { rows: number; cols: number } {
  const map = TableMap.get(table);
  return { rows: map.height, cols: map.width };
}

/** Cells that would go if the table became rows × cols and that hold something (text, a picture …). */
export function cellsLost(table: PMNode, rows: number, cols: number): number {
  const map = TableMap.get(table);
  const seen = new Set<number>();
  let n = 0;
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const rel = map.map[r * map.width + c];
      if (seen.has(rel)) continue;
      seen.add(rel);
      const rect = map.findCell(rel);
      // a cell goes only when all of it lies outside the new size
      if (rect.top < rows && rect.left < cols) continue;
      const cell = table.nodeAt(rel)!;
      if (cell.textContent.trim() || hasNonText(cell)) n++;
    }
  }
  return n;
}

const hasNonText = (cell: PMNode) => {
  let found = false;
  cell.descendants((n) => {
    if (n.isAtom && !n.isText && n.type.name !== 'hardBreak') found = true;
    return !found;
  });
  return found;
};

/** Sets a table's rows and columns in one go: one transaction, so one Undo puts it all back. */
export function resizeTable(editor: Editor, rows: number, cols: number): boolean {
  const t = tableAt(editor);
  if (!t) return false;
  rows = Math.max(1, Math.min(TABLE_MAX_ROWS, Math.round(rows)));
  cols = Math.max(1, Math.min(TABLE_MAX_COLS, Math.round(cols)));
  const tr = closeHistory(editor.state.tr);
  const pos = t.pos;
  const size = () => TableMap.get(tr.doc.nodeAt(pos)!);
  // addRow / addColumn map their positions through the whole transaction they get, so each one
  // runs on a fresh Transform of the table as it is now and its steps are copied over.
  const step = (fn: (t: Transform, rect: { map: TableMap; table: PMNode; tableStart: number; left: number; top: number; right: number; bottom: number }) => void) => {
    const t = new Transform(tr.doc);
    const table = t.doc.nodeAt(pos)!;
    const map = TableMap.get(table);
    fn(t, { map, table, tableStart: pos + 1, left: 0, top: 0, right: map.width, bottom: map.height });
    for (const s of t.steps) tr.step(s);
  };
  // a caret in a cell that goes moves to the first cell first (table > row > cell > its first line)
  const { rows: r0, cols: c0 } = tableSize(t.node);
  if (r0 > rows || c0 > cols) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)));
  while (size().height < rows) step((t, r) => addRow(t as Transaction, r, r.map.height));
  while (size().height > rows) step((t, r) => removeRow(t as Transaction, r, r.map.height - 1));
  while (size().width < cols) step((t, r) => addColumn(t as Transaction, r, r.map.width));
  while (size().width > cols) step((t, r) => removeColumn(t as Transaction, r, r.map.width - 1));
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export interface TableLook {
  tstyle: TableStyle;
  color: string | null;
  caption: string | null;
  firstCol: boolean;
}

/** Changes the caret's table style, colour, caption or first column. One Undo step. */
export function setTableLook(editor: Editor, look: Partial<TableLook>, at?: number): boolean {
  const pos = at ?? tableAt(editor)?.pos;
  if (pos === undefined) return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'table') return false;
  const next: Record<string, unknown> = { ...node.attrs };
  if ('tstyle' in look) next.tstyle = look.tstyle === 'clean' ? null : look.tstyle;
  if ('color' in look) next.color = colourKey(look.color);
  if ('caption' in look) next.caption = look.caption?.trim() ? look.caption.trim().slice(0, 160) : null;
  if ('firstCol' in look) next.firstCol = look.firstCol ? true : null;
  editor.view.dispatch(closeHistory(editor.state.tr.setNodeMarkup(pos, undefined, next)));
  return true;
}

/** Inserts a rows × cols table with its look, as one Undo step, with an empty line after it. */
export function insertStyledTable(editor: Editor, opts: { rows: number; cols: number; header: boolean } & TableLook) {
  const rows = Math.max(1, Math.min(TABLE_MAX_ROWS, opts.rows));
  const cols = Math.max(1, Math.min(TABLE_MAX_COLS, opts.cols));
  editor
    .chain()
    .focus()
    .command(({ tr }: { tr: Transaction }) => (closeHistory(tr), true))
    .insertTable({ rows, cols, withHeaderRow: opts.header })
    .command(({ tr }: { tr: Transaction }) => {
      const t = findTableBefore(tr);
      if (!t) return true;
      tr.setNodeMarkup(t.pos, undefined, {
        ...t.node.attrs,
        tstyle: opts.tstyle === 'clean' ? null : opts.tstyle,
        color: colourKey(opts.color),
        caption: opts.caption?.trim() || null,
        firstCol: opts.firstCol ? true : null
      });
      // and an empty line after it, so writing can go on
      const after = t.pos + tr.doc.nodeAt(t.pos)!.nodeSize;
      const next = tr.doc.resolve(after).nodeAfter;
      if (!next && tr.doc.resolve(after).parent.type.name === 'doc') tr.insert(after, tr.doc.type.schema.nodes.paragraph.create());
      return true;
    })
    .run();
}

function findTableBefore(tr: Transaction): { pos: number; node: PMNode } | null {
  const $p = tr.selection.$from;
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'table') return { pos: $p.before(d), node: $p.node(d) };
  return null;
}

/** Puts the caret's table on the left or right with text beside it, or back in the middle. One Undo step. */
export function setTableAlign(editor: Editor, align: FigAlign): boolean {
  const t = tableAt(editor);
  if (!t) return false;
  const a = t.node.attrs;
  const width = align === 'center' ? (a.width ?? null) : Math.min(figWidth(a.width, figAlign(a.align)), 60);
  editor.view.dispatch(closeHistory(editor.state.tr.setNodeMarkup(t.pos, undefined, { ...a, align: align === 'center' ? null : align, width: align !== 'center' && width >= 100 ? 50 : width })));
  return true;
}
