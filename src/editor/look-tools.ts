import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { openSheet } from '../lib/sheet';
import { CALLOUT_KINDS } from '../lib/callouts';
import {
  COLOURS,
  CORNERS,
  FILLS,
  HEADING_START,
  HEADING_STYLES,
  HEADING_STYLE_NAMES,
  ICONS,
  PANEL_DEFAULT,
  PANEL_INFO,
  PANEL_KINDS,
  readCorner,
  readFill,
  readHeadingLook,
  readPanelLook,
  tableStyle,
  TABLE_MAX_COLS,
  TABLE_MAX_ROWS,
  TABLE_STYLES,
  TABLE_STYLE_INFO,
  type Corner,
  type Fill,
  type HeadingLook,
  type PanelKind,
  type PanelLook,
  type TableStyle
} from '../lib/looks';
import { deleteStyle, lastLook, nextStyleName, rememberLook, saveStyle, savedStyles, type SavedStyle, type StyleKind } from '../lib/my-styles';
import { applyHeadingStyle, headingAt, setHeadingLook } from './heading-look';
import { blocksForPanel, panelAt, removePanel, setPanelLook, wrapInPanel } from './panel';
import { cellsLost, insertStyledTable, resizeTable, setTableLook, tableAt, tableSize } from './table';
import { calloutAttrsAt, canMakeCallout, setCallout, setCalloutLook } from './callout';

/** Buttons in these tools keep the caret (and the keyboard) in the note. */
const keep = <T extends HTMLElement>(el: T): T => {
  el.addEventListener('pointerdown', (ev) => ev.preventDefault());
  return el;
};

const button = (label: string | Node | (string | Node)[], attrs: Record<string, string | boolean | undefined>, run: () => void) => {
  const b = keep(h('button', { type: 'button', ...attrs }, label));
  b.addEventListener('click', run);
  return b;
};

function field(label: string, ...controls: Node[]) {
  return h('div', { class: 'lp-field' }, h('span', { class: 'lp-label' }, label), ...controls);
}

function seg<T extends string>(label: string, items: { id: T; label: string | Node; aria?: string }[], current: T | null, pick: (v: T) => void, id?: string) {
  const row = h('div', { class: 'seg', role: 'group', 'aria-label': label, id });
  for (const it of items) row.append(button(it.label, { 'aria-pressed': String(it.id === current), 'aria-label': it.aria, 'data-v': it.id }, () => pick(it.id)));
  return field(label, row);
}

/** Subject colour (follows the note) and the 13 colours. */
function swatches(current: string | null, pick: (key: string | null) => void, id?: string) {
  const row = h('div', { class: 'swatches lp-swatches', role: 'group', 'aria-label': 'Colour', id });
  row.append(button(h('span', { class: 'subj-mark' }, 'S'), { class: 'swatch subj', style: '--c: var(--subj, var(--accent))', 'aria-label': 'Subject colour', title: 'Follows the subject', 'aria-pressed': String(current === null), 'data-colour': 'subject' }, () => pick(null)));
  for (const c of COLOURS) row.append(button('', { class: 'swatch', style: `--c: var(--sub-${c.key})`, 'aria-label': c.name, title: c.name, 'aria-pressed': String(current === c.key), 'data-colour': c.key }, () => pick(c.key)));
  return field('Colour', row);
}

function stepper(label: string, id: string, get: () => number, set: (v: number) => void, min: number, max: number) {
  const out = h('output', { id, 'aria-live': 'polite' }, String(get()));
  const step = (d: number) => {
    set(Math.max(min, Math.min(max, get() + d)));
    out.textContent = String(get());
  };
  const el = h(
    'div',
    { class: 'stepper' },
    h('span', { class: 'lp-label' }, label),
    button(icon('minus', 18), { 'aria-label': `Fewer ${label.toLowerCase()}`, id: `${id}-minus` }, () => step(-1)),
    out,
    button(icon('plus', 18), { 'aria-label': `More ${label.toLowerCase()}`, id: `${id}-plus` }, () => step(1))
  );
  return { el, paint: () => (out.textContent = String(get())) };
}

const ICON_ITEMS = [{ id: 'none', label: 'None' }, ...ICONS.map((i) => ({ id: i.id, label: icon(i.id, 18) as Node, aria: i.label }))];
const FILL_ITEMS = FILLS.map((f) => ({ id: f.id, label: f.label }));
const CORNER_ITEMS = CORNERS.map((c) => ({ id: c.id, label: c.label }));

/** "Save as my style": asks for a name, then keeps the look for every note. */
export function askSaveStyle(kind: StyleKind, look: HeadingLook | PanelLook, toast: (t: string) => void) {
  const input = h('input', { type: 'text', id: 'style-name', class: 'sheet-input', value: nextStyleName(), maxlength: 40, 'aria-label': 'Style name' });
  openSheet({
    title: 'Save as my style',
    id: 'save-style',
    body: [h('p', { class: 'meta' }, kind === 'heading' ? 'Keeps this heading look for every note. Find it in Style, or type / and its name.' : 'Keeps this container look for every note. Find it in Put in container, or type / and its name.'), input],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        id: 'style-save',
        run: async () => {
          const s = await saveStyle(kind, input.value, look);
          toast(`Saved "${s.name}". It's in the slash menu too.`);
        }
      }
    ]
  });
  input.select();
}

/** Saved styles of one kind as chips: tap to use; × deletes after a second tap. */
function myStyles(kind: StyleKind, use: (s: SavedStyle) => void, repaint: () => void) {
  const list = savedStyles(kind);
  if (!list.length) return null;
  const row = h('div', { class: 'my-styles', role: 'group', 'aria-label': 'My styles' });
  for (const s of list) {
    const del = button('×', { class: 'my-style-del', 'aria-label': `Delete style ${s.name}`, title: 'Delete' }, () => {
      if (del.dataset.armed) {
        void deleteStyle(s.id).then(repaint);
        return;
      }
      del.dataset.armed = '1';
      del.textContent = 'Delete?';
      window.setTimeout(() => {
        delete del.dataset.armed;
        del.textContent = '×';
      }, 4000);
    });
    row.append(h('span', { class: 'my-style' }, button(s.name, { class: 'my-style-use', 'data-style-id': s.id }, () => use(s)), del));
  }
  return field('My styles', row);
}

// ---------------------------------------------------------------- style panel

export type LookTarget = 'heading' | 'panel' | 'table' | 'callout';

export interface LookPanel {
  el: HTMLElement;
  open(target: LookTarget, focus?: 'title' | 'author' | 'caption'): void;
  close(): boolean;
  /** Repaints after a transaction; closes when the caret has left what it styles. */
  sync(): void;
  isOpen(): boolean;
}

/**
 * The Style panel beside the note (a sheet at the bottom on a narrow screen). It is not modal: every
 * tap changes the heading, container, table or callout at the caret straight away, one Undo step each.
 */
export function createLookPanel(getEditor: () => Editor | null, toast: (t: string) => void): LookPanel {
  const title = h('h2', { class: 'lp-title' }, 'Style');
  const done = button('Done', { class: 'lp-done', id: 'look-done' }, () => close());
  const body = h('div', { class: 'lp-body' });
  const el = h('div', { class: 'look-panel', id: 'look-panel', role: 'dialog', 'aria-label': 'Style', hidden: true }, h('div', { class: 'lp-head' }, title, done), body);
  let target: LookTarget | null = null;
  let painted = '';

  const nodeOf = (e: Editor): { pos: number; node: PMNode } | null =>
    target === 'heading' ? headingAt(e) : target === 'panel' ? panelAt(e) : target === 'table' ? tableAt(e) : null;

  const signature = (e: Editor) => {
    const n = nodeOf(e);
    const attrs = target === 'callout' ? calloutAttrsAt(e) : n?.node.attrs;
    return `${target}|${n?.pos ?? ''}|${JSON.stringify(attrs ?? null)}|${savedStyles().map((s) => s.id).join(',')}|${target === 'table' && n ? n.node.firstChild?.firstChild?.type.name : ''}`;
  };

  /** A text box written when it is left (or Enter): one Undo step per edit. */
  function textBox(id: string, label: string, value: string, placeholder: string, commit: (v: string, at: number) => void, at: number) {
    const input = h('input', { type: 'text', id, class: 'lp-input', value, placeholder, maxlength: 160, 'aria-label': label });
    const write = () => {
      if (input.value.trim() !== value.trim()) commit(input.value, at);
      value = input.value;
    };
    input.addEventListener('change', write);
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      write();
      getEditor()?.commands.focus();
    });
    return field(label, input);
  }

  function setAttrAt(e: Editor, at: number, type: string, patch: Record<string, unknown>) {
    const node = e.state.doc.nodeAt(at);
    if (!node || node.type.name !== type) return;
    e.view.dispatch(e.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, ...patch }));
  }

  function headingBody(e: Editor, at: number, node: PMNode) {
    const look = readHeadingLook(node.attrs.look);
    const cur: HeadingLook = look ?? { ...HEADING_START, style: 'plain' };
    const apply = (patch: Partial<HeadingLook>) => {
      const base = readHeadingLook(headingAt(e)?.node.attrs.look) ?? { ...HEADING_START, style: 'plain' as const };
      const next = { ...base, ...patch };
      setHeadingLook(e, next);
      rememberLook('heading', readHeadingLook(next));
    };
    const grid = h('div', { class: 'lp-grid', role: 'group', 'aria-label': 'Look', id: 'look-grid' });
    for (const s of HEADING_STYLES) {
      const mini = h('span', { class: 'hl-mini', 'data-look': s, 'data-fill': cur.fill, 'data-corner': cur.corner, style: cur.color ? `--c: var(--sub-${cur.color})` : undefined }, h('span', { class: 'h-text' }, 'Aa heading'));
      grid.append(button([mini, h('span', { class: 'lp-tile-name' }, HEADING_STYLE_NAMES[s])], { class: 'lp-tile', 'data-style': s, 'aria-pressed': String(cur.style === s), 'aria-label': `${HEADING_STYLE_NAMES[s]} look` }, () => (s === 'plain' && !look?.color && !look?.icon ? setHeadingLook(e, null) : apply({ style: s }))));
    }
    const mine = myStyles('heading', (s) => {
      setHeadingLook(e, s.look as HeadingLook);
      rememberLook('heading', s.look as HeadingLook);
    }, repaint);
    return [
      field('Look', grid),
      swatches(cur.color, (c) => apply({ color: c }), 'look-colours'),
      seg('Fill', FILL_ITEMS, cur.fill, (v) => apply({ fill: v as Fill }), 'look-fill'),
      seg('Corners', CORNER_ITEMS, cur.corner, (v) => apply({ corner: v as Corner }), 'look-corner'),
      seg('Icon', ICON_ITEMS, cur.icon ?? 'none', (v) => apply({ icon: v === 'none' ? null : v }), 'look-icon'),
      h(
        'div',
        { class: 'lp-pair' },
        seg('Width', [{ id: 'fit', label: 'Fit text' }, { id: 'full', label: 'Full line' }], cur.width, (v) => apply({ width: v as 'fit' | 'full' }), 'look-width'),
        seg('Alignment', [{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }], cur.align, (v) => apply({ align: v as 'left' | 'center' }), 'look-align')
      ),
      mine,
      h(
        'div',
        { class: 'lp-actions' },
        button('Save as my style', { id: 'look-save', disabled: !look }, () => look && askSaveStyle('heading', look, toast)),
        button('Plain heading', { id: 'look-plain', disabled: !look }, () => setHeadingLook(e, null))
      ),
      void at
    ].filter(Boolean) as Node[];
  }

  function panelBody(e: Editor, at: number, node: PMNode) {
    const cur = readPanelLook(node.attrs);
    const apply = (patch: Partial<PanelLook>) => {
      const base = readPanelLook(panelAt(e)?.node.attrs);
      const next = { ...base, ...patch };
      setPanelLook(e, next);
      rememberLook('panel', next);
    };
    const kinds = h('div', { class: 'lp-grid kinds', role: 'group', 'aria-label': 'Container', id: 'panel-kinds' });
    for (const k of PANEL_KINDS) kinds.append(button([h('span', { class: 'pk-mini', 'data-panel': k }), h('span', { class: 'lp-tile-name' }, PANEL_INFO[k].name)], { class: 'lp-tile', 'data-kind': k, 'aria-pressed': String(cur.kind === k), 'aria-label': PANEL_INFO[k].name }, () => apply({ kind: k })));
    const out: (Node | null)[] = [field('Container', kinds), swatches(cur.color, (c) => apply({ color: c }), 'look-colours')];
    if (cur.kind !== 'sticky') out.push(seg('Fill', FILL_ITEMS, cur.fill, (v) => apply({ fill: v as Fill }), 'look-fill'));
    if (cur.kind !== 'sticky' && cur.kind !== 'framed') out.push(seg('Corners', CORNER_ITEMS, cur.corner, (v) => apply({ corner: v as Corner }), 'look-corner'));
    if (cur.kind === 'titled') out.push(seg('Icon', ICON_ITEMS, cur.icon ?? 'none', (v) => apply({ icon: v === 'none' ? null : v }), 'look-icon'));
    if (cur.kind === 'titled' || cur.kind === 'sticky') out.push(textBox('panel-title', 'Title', cur.title ?? '', cur.kind === 'titled' ? 'Key point' : 'Remember', (v, p) => setAttrAt(e, p, 'panel', { title: v.trim().slice(0, 80) || null }), at));
    if (cur.kind === 'quote') out.push(textBox('panel-author', 'Author', cur.author ?? '', 'Who said it (optional)', (v, p) => setAttrAt(e, p, 'panel', { author: v.trim().slice(0, 120) || null }), at));
    out.push(
      myStyles('panel', (s) => apply({ ...(s.look as PanelLook) }), repaint),
      h(
        'div',
        { class: 'lp-actions' },
        button('Save as my style', { id: 'look-save' }, () => askSaveStyle('panel', readPanelLook(panelAt(e)?.node.attrs), toast)),
        button('Remove container', { id: 'panel-remove', class: 'danger-outline' }, () => {
          removePanel(e);
          close();
        })
      )
    );
    return out.filter(Boolean) as Node[];
  }

  function tableBody(e: Editor, at: number, node: PMNode) {
    const style = tableStyle(node.attrs.tstyle);
    const tiles = h('div', { class: 'lp-grid tstyles', role: 'group', 'aria-label': 'Table style', id: 'table-styles' });
    for (const s of TABLE_STYLES) tiles.append(button([tableMini(s), h('span', { class: 'lp-tile-name' }, TABLE_STYLE_INFO[s].name)], { class: 'lp-tile', 'data-tstyle': s, 'aria-pressed': String(style === s), 'aria-label': `${TABLE_STYLE_INFO[s].name} table style`, title: TABLE_STYLE_INFO[s].hint }, () => setTableLook(e, { tstyle: s }, at)));
    const header = node.firstChild?.childCount ? [...Array(node.firstChild.childCount).keys()].every((i) => node.firstChild!.child(i).type.name === 'tableHeader') : false;
    return [
      field('Style', tiles),
      swatches((node.attrs.color as string | null) ?? null, (c) => setTableLook(e, { color: c }, at), 'look-colours'),
      h(
        'div',
        { class: 'lp-toggles' },
        button(`Header row${header ? ' ✓' : ''}`, { id: 'table-header-toggle', 'aria-pressed': String(header) }, () => e.chain().focus().toggleHeaderRow().run()),
        button(`Bold first column${node.attrs.firstCol ? ' ✓' : ''}`, { id: 'table-firstcol-toggle', 'aria-pressed': String(!!node.attrs.firstCol) }, () => setTableLook(e, { firstCol: !node.attrs.firstCol }, at))
      ),
      textBox('table-caption', 'Caption', String(node.attrs.caption ?? ''), 'e.g. Lok Sabha and Rajya Sabha', (v, p) => setTableLook(e, { caption: v }, p), at)
    ];
  }

  function calloutBody(e: Editor) {
    const a = calloutAttrsAt(e) ?? {};
    return [
      h('p', { class: 'meta' }, 'Change the kind (Article, Case …) in the callout bar.'),
      seg('Fill', FILL_ITEMS, readFill(a.fill) ?? 'soft', (v) => setCalloutLook(e, { fill: v as Fill }), 'look-fill'),
      seg('Corners', CORNER_ITEMS, readCorner(a.corner) ?? 'round', (v) => setCalloutLook(e, { corner: v as Corner }), 'look-corner')
    ];
  }

  function repaint() {
    painted = '';
    sync();
  }

  function paint(e: Editor) {
    const n = nodeOf(e);
    const names: Record<LookTarget, string> = { heading: 'Heading style', panel: 'Container style', table: 'Table style', callout: 'Callout style' };
    title.textContent = names[target!];
    el.dataset.target = target!;
    const parts = target === 'heading' ? headingBody(e, n!.pos, n!.node) : target === 'panel' ? panelBody(e, n!.pos, n!.node) : target === 'table' ? tableBody(e, n!.pos, n!.node) : calloutBody(e);
    body.replaceChildren(...parts);
    painted = signature(e);
  }

  function sync() {
    if (!target) return;
    const e = getEditor();
    const there = e && !e.isDestroyed && (target === 'callout' ? !!calloutAttrsAt(e) : !!nodeOf(e));
    if (!e || !there) {
      close();
      return;
    }
    // never rebuild under a text box he is typing in
    if (el.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    if (signature(e) !== painted) paint(e);
  }

  /** On a narrow screen the panel sits on top of the on-screen keyboard. */
  const place = () => {
    const vv = window.visualViewport;
    const kb = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
    el.style.setProperty('--kb', `${Math.round(kb)}px`);
  };

  function open(t: LookTarget, focus?: 'title' | 'author' | 'caption') {
    const e = getEditor();
    if (!e) return;
    target = t;
    painted = '';
    if (el.hidden) window.visualViewport?.addEventListener('resize', place);
    el.hidden = false;
    place();
    paint(e);
    if (focus) {
      const input = el.querySelector<HTMLInputElement>(focus === 'caption' ? '#table-caption' : `#panel-${focus}`);
      input?.focus();
      input?.select();
    }
  }

  function close() {
    if (el.hidden) return false;
    el.hidden = true;
    window.visualViewport?.removeEventListener('resize', place);
    target = null;
    body.replaceChildren();
    return true;
  }

  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      getEditor()?.commands.focus();
    }
  });

  return { el, open, close, sync, isOpen: () => !el.hidden };
}

/** A tiny drawing of a table style for its tile. */
function tableMini(s: TableStyle) {
  const t = h('span', { class: 'tm', 'data-tstyle': s, 'aria-hidden': 'true' });
  for (let r = 0; r < 4; r++) {
    const row = h('span', { class: `tm-row${r === 0 ? ' head' : ''}` });
    for (let c = 0; c < 3; c++) row.append(h('span', { class: 'tm-cell' }));
    t.append(row);
  }
  return t;
}

// ---------------------------------------------------------------- Insert → Table

const GRID_ROWS = 10;
const GRID_COLS = 8;

/** Insert → Table: rows × columns (drag across the grid or use the steppers), header, first column, style, colour. */
export function openTableDialog(e: Editor) {
  const st = { rows: 4, cols: 3, header: true, firstCol: true, tstyle: 'clean' as TableStyle, color: null as string | null };
  const grid = h('div', { class: 'grid-pick', id: 'grid-pick', role: 'group', 'aria-label': `Table size: drag across the grid, up to ${GRID_ROWS} rows by ${GRID_COLS} columns` });
  const cells: HTMLElement[] = [];
  for (let r = 1; r <= GRID_ROWS; r++) for (let c = 1; c <= GRID_COLS; c++) {
    const cell = h('span', { class: 'gp-cell', 'data-r': r, 'data-c': c });
    cells.push(cell);
    grid.append(cell);
  }
  const rowsStep = stepper('Rows', 'tbl-rows', () => st.rows, (v) => ((st.rows = v), paint()), 1, TABLE_MAX_ROWS);
  const colsStep = stepper('Columns', 'tbl-cols', () => st.cols, (v) => ((st.cols = v), paint()), 1, TABLE_MAX_COLS);
  const sizeText = h('p', { class: 'gp-size', id: 'grid-size', 'aria-live': 'polite' });
  const toggles = h('div', { class: 'lp-toggles' });
  const headBtn = button('', { id: 'tbl-header' }, () => ((st.header = !st.header), paint()));
  const firstBtn = button('', { id: 'tbl-firstcol' }, () => ((st.firstCol = !st.firstCol), paint()));
  toggles.append(headBtn, firstBtn);
  const styles = h('div', { class: 'lp-grid tstyles', role: 'group', 'aria-label': 'Table style', id: 'tbl-styles' });
  const styleBtns = TABLE_STYLES.map((s) => button([tableMini(s), h('span', { class: 'lp-tile-name' }, TABLE_STYLE_INFO[s].name)], { class: 'lp-tile', 'data-tstyle': s, 'aria-label': `${TABLE_STYLE_INFO[s].name} table style`, title: TABLE_STYLE_INFO[s].hint }, () => ((st.tstyle = s), paint())));
  styles.append(...styleBtns);
  const colourHost = h('div', {});

  function paint() {
    for (const c of cells) c.classList.toggle('on', Number(c.dataset.r) <= st.rows && Number(c.dataset.c) <= st.cols);
    rowsStep.paint();
    colsStep.paint();
    sizeText.textContent = `${st.rows} × ${st.cols}${st.rows > GRID_ROWS || st.cols > GRID_COLS ? ' (more than the grid shows)' : ''}`;
    headBtn.textContent = `Header row${st.header ? ' ✓' : ''}`;
    headBtn.setAttribute('aria-pressed', String(st.header));
    firstBtn.textContent = `Bold first column${st.firstCol ? ' ✓' : ''}`;
    firstBtn.setAttribute('aria-pressed', String(st.firstCol));
    styleBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tstyle === st.tstyle)));
    colourHost.replaceChildren(swatches(st.color, (c) => ((st.color = c), paint()), 'tbl-colours'));
    const go = document.getElementById('table-insert');
    if (go) go.textContent = `Insert ${st.rows} × ${st.cols} table`;
  }

  // drag (or tap) across the grid: the cell under the finger is the bottom-right corner
  const at = (ev: PointerEvent) => {
    const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    if (!t?.classList.contains('gp-cell')) return;
    st.rows = Number(t.dataset.r);
    st.cols = Number(t.dataset.c);
    paint();
  };
  grid.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    grid.setPointerCapture?.(ev.pointerId);
    at(ev);
  });
  grid.addEventListener('pointermove', (ev) => {
    if (ev.buttons || ev.pointerType !== 'mouse') at(ev);
  });

  // The sheet closes (and gives focus back to the note) before the table goes in, so the caret lands in its first cell.
  const close = openSheet({
    title: 'Insert table',
    id: 'table-dialog',
    body: [h('div', { class: 'tbl-dialog' }, h('div', { class: 'tbl-size' }, grid, sizeText, rowsStep.el, colsStep.el), h('div', { class: 'tbl-look' }, toggles, field('Style', styles), colourHost))],
    actions: [
      { label: 'Cancel', id: 'table-cancel' },
      { label: 'Insert 4 × 3 table', id: 'table-insert', primary: true, run: () => {
          close();
          insertStyledTable(e, { rows: st.rows, cols: st.cols, header: st.header, firstCol: st.firstCol, tstyle: st.tstyle, color: st.color, caption: null });
          return false;
        } }
    ]
  });
  paint();
}

// ---------------------------------------------------------------- the "4 × 3 ▾" size button

let sizePop: { el: HTMLElement; close: () => void } | null = null;

export function closeSizePopover(): boolean {
  if (!sizePop) return false;
  sizePop.close();
  return true;
}

/** Rows and columns together, for the table at the caret. Warns before cells with text go; one Undo step. */
export function openSizePopover(e: Editor, anchor: HTMLElement) {
  const again = sizePop?.el.dataset.for === 'size';
  closeSizePopover();
  if (again) return;
  const t = tableAt(e);
  if (!t) return;
  const start = tableSize(t.node);
  const st = { ...start };
  const warn = h('p', { class: 'size-warn', id: 'size-warn', hidden: true });
  const apply = button('Apply', { class: 'primary', id: 'size-apply' }, () => {
    resizeTable(e, st.rows, st.cols);
    close();
    e.commands.focus();
  });
  const paint = () => {
    const now = tableAt(e);
    const lost = now ? cellsLost(now.node, st.rows, st.cols) : 0;
    warn.hidden = !lost;
    warn.textContent = lost ? `This removes ${lost} ${lost === 1 ? 'cell that has' : 'cells that have'} text. Undo brings ${lost === 1 ? 'it' : 'them'} back.` : '';
    apply.textContent = lost ? `Delete ${lost} ${lost === 1 ? 'cell' : 'cells'} and resize` : 'Apply';
    apply.className = lost ? 'danger-btn' : 'primary';
    apply.disabled = st.rows === start.rows && st.cols === start.cols;
  };
  const rows = stepper('Rows', 'size-rows', () => st.rows, (v) => ((st.rows = v), paint()), 1, TABLE_MAX_ROWS);
  const cols = stepper('Columns', 'size-cols', () => st.cols, (v) => ((st.cols = v), paint()), 1, TABLE_MAX_COLS);
  const el = h('div', { class: 'size-pop', id: 'size-pop', role: 'dialog', 'aria-label': 'Table size', 'data-for': 'size' }, h('strong', {}, 'Table size'), rows.el, cols.el, warn, h('div', { class: 'size-actions' }, button('Cancel', { id: 'size-cancel' }, () => close()), apply));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8));
  let top = r.bottom + 6;
  const vv = window.visualViewport;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  if (top + el.offsetHeight > bottom - 8) top = Math.max(8, r.top - el.offsetHeight - 6);
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  anchor.setAttribute('aria-expanded', 'true');
  paint();
  const onDown = (ev: PointerEvent) => {
    if (!el.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  };
  function close() {
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (sizePop?.el === el) sizePop = null;
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  sizePop = { el, close };
}

// ---------------------------------------------------------------- Put in container

/** Applies a container look: changes the caret's container, or puts the selected blocks in a new one. */
export function applyPanelLook(e: Editor, look: PanelLook): boolean {
  const ok = panelAt(e) ? setPanelLook(e, look) : wrapInPanel(e, look);
  if (ok) rememberLook('panel', look);
  return ok;
}

export function applySavedStyle(e: Editor, s: SavedStyle) {
  if (s.kind === 'heading') {
    applyHeadingStyle(e, s.look as HeadingLook);
    rememberLook('heading', s.look as HeadingLook);
  } else applyPanelLook(e, readPanelLook(s.look));
}

/** Select blocks → Put in container: the six containers, the six callouts (as presets) and his saved styles. */
export function openContainerSheet(e: Editor, toast: (t: string) => void) {
  const here = panelAt(e);
  const canWrap = !!here || !!blocksForPanel(e.state);
  const callouts = canMakeCallout(e);
  let close = () => {};
  const opt = (label: string, hint: string, glyph: Node, id: string, run: () => void, disabled = false) => {
    const b = h('button', { type: 'button', class: 'ct-opt', 'data-container': id, disabled }, h('span', { class: 'ct-glyph', 'aria-hidden': 'true' }, glyph), h('span', { class: 'ct-text' }, h('strong', {}, label), h('span', {}, hint)));
    b.addEventListener('click', () => {
      close();
      run();
    });
    return b;
  };
  const kinds = PANEL_KINDS.map((k: PanelKind) =>
    opt(PANEL_INFO[k].name, PANEL_INFO[k].hint, h('span', { class: 'pk-mini', 'data-panel': k }), k, () => {
      const base = here ? readPanelLook(here.node.attrs) : { ...PANEL_DEFAULT };
      if (!applyPanelLook(e, { ...base, kind: k })) toast("These lines can't go in a container here.");
    }, !canWrap)
  );
  const last = lastLook('panel');
  const presets = CALLOUT_KINDS.map((k) => opt(`${k.label} callout`, k.hint, icon(k.icon, 20), `callout-${k.id}`, () => setCallout(e, k.id), !callouts));
  const mine = savedStyles('panel').map((s) => opt(s.name, `My style · ${PANEL_INFO[readPanelLook(s.look).kind].name}`, h('span', { class: 'pk-mini', 'data-panel': readPanelLook(s.look).kind }), `mine-${s.id}`, () => applySavedStyle(e, s), !canWrap));
  const body: Node[] = [];
  if (last) body.push(h('div', { class: 'sheet-list ct-list' }, opt('Same as last', PANEL_INFO[last.kind].name, icon('redo', 20), 'same-as-last', () => applyPanelLook(e, { ...last, title: here ? readPanelLook(here.node.attrs).title : last.title }), !canWrap)));
  body.push(h('div', { class: 'sheet-list ct-list', role: 'group', 'aria-label': 'Containers' }, ...kinds));
  if (mine.length) body.push(h('h3', { class: 'ct-sub' }, 'My styles'), h('div', { class: 'sheet-list ct-list' }, ...mine));
  body.push(h('h3', { class: 'ct-sub' }, 'Callouts'), h('p', { class: 'meta ct-note' }, callouts ? 'Callouts hold text, lists and pictures.' : 'Callouts hold text, lists and pictures only: this selection has a table, heading, chart or sketch.'), h('div', { class: 'sheet-list ct-list', role: 'group', 'aria-label': 'Callouts' }, ...presets));
  close = openSheet({ title: here ? 'Change container' : 'Put in container', id: 'container-sheet', body, actions: [{ label: 'Cancel', id: 'container-cancel' }] });
}

/** "Same as last" in the heading bar: the look used last on this device. */
export function sameAsLastHeading(e: Editor, toast: (t: string) => void) {
  const l = lastLook('heading');
  if (!l) return toast('Pick a look in Style first. Same as last then repeats it in one tap.');
  setHeadingLook(e, l);
}

export const hasLastHeading = () => !!lastLook('heading');
