/**
 * Mark with the pen (0.15, UI-4 U4-2). With the S Pen on note text:
 * - drag = highlight, snapped to whole words; the stroke stays on the line it started on until the pen moves
 *   clearly (0.8 of a line) above or below it, then it runs like a normal selection;
 * - a stroke that starts on marked text, or one drawn with the side button held, removes the highlight;
 * - one Undo step per stroke (nothing changes until the pen lifts; a cancelled stroke changes nothing);
 * - tap = caret, long-press (500 ms) = select the word.
 * A finger is never touched. Sketches, pictures, charts and other blocks drawn by their own views keep their
 * own pen handling. Settings → Pen & touch → "Mark text with the S Pen" switches it off (the pen then acts as before).
 */
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode, MarkType } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { penMarkOn } from '../lib/prefs';
import { buzz } from '../lib/haptics';

const MOVE_PX = 6;
const LONG_MS = 500;
const LOCK = 0.8;
/** A stroke never leaves the table cell or callout it started in, and never runs into one from outside. */
const FENCES = new Set(['tableCell', 'tableHeader', 'callout']);
const WALLS = new Set(['table', 'tableRow', ...FENCES]);

type Preview = { from: number; to: number; remove: boolean } | null;
export const penMarkKey = new PluginKey<DecorationSet>('penMark');

/** The S Pen's side button (barrel = buttons 2, eraser = 32; on contact Chrome reports button 2 or 5). */
const side = (e: PointerEvent) => (e.buttons & 2) !== 0 || (e.buttons & 32) !== 0 || e.button === 2 || e.button === 5;

const core = (c: string) => /[\p{L}\p{N}\p{M}]/u.test(c);
const join = (c: string) => c === "'" || c === '’' || c === '-' || c === '_';

/** The character after `p` inside its textblock ('' at a block edge or outside text). */
function charAt(doc: PMNode, p: number): string {
  if (p < 0 || p >= doc.content.size) return '';
  const $p = doc.resolve(p);
  if (!$p.parent.isTextblock || p >= $p.end()) return '';
  return doc.textBetween(p, p + 1, '', '￼');
}

/** Whole words only: drops spaces and punctuation at the ends, then grows each end to its word's edge. */
export function snapWords(doc: PMNode, from: number, to: number): { from: number; to: number } {
  while (from < to && !core(charAt(doc, from))) from++;
  while (to > from && !core(charAt(doc, to - 1))) to--;
  if (from === to && !core(charAt(doc, from))) return { from, to };
  for (;;) {
    const c = charAt(doc, from - 1);
    if (core(c) || (join(c) && core(charAt(doc, from - 2)))) from--;
    else break;
  }
  for (;;) {
    const c = charAt(doc, to);
    if (core(c) || (join(c) && core(charAt(doc, to + 1)))) to++;
    else break;
  }
  return { from, to };
}

/** Inside a table (any part of it) or a callout. */
function walled(doc: PMNode, pos: number): boolean {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if (WALLS.has($p.node(d).type.name)) return true;
  return false;
}

function fenceOf(doc: PMNode, pos: number): { start: number; end: number } | null {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    if (FENCES.has($p.node(d).type.name)) return { start: $p.start(d), end: $p.end(d) };
  }
  return null;
}

/** Keeps the range from `anchor` to `head` inside the anchor's fence and out of any other. */
function fenced(doc: PMNode, anchor: number, head: number): number {
  const a = fenceOf(doc, anchor);
  if (a) return Math.min(Math.max(head, a.start), a.end);
  if (!walled(doc, head)) return head;
  // Stop before the whole block (table, callout) the stroke would run into, not just the cell.
  const $h = doc.resolve(head);
  const d = $h.sharedDepth(anchor) + 1;
  return head > anchor ? $h.before(d) : $h.after(d);
}

function allMarked(doc: PMNode, from: number, to: number, type: MarkType): boolean {
  let any = false;
  let all = true;
  doc.nodesBetween(from, to, (n) => {
    if (!n.isText) return;
    any = true;
    if (!type.isInSet(n.marks)) all = false;
  });
  return any && all;
}

function previewOf(state: EditorState, p: Preview): DecorationSet {
  if (!p || p.from >= p.to) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [Decoration.inline(p.from, p.to, { class: p.remove ? 'pen-unmark' : 'pen-mark' })]);
}

class PenMarkView {
  private down: { id: number; x: number; y: number; mid: number; lineH: number; pos: number } | null = null;
  private phase: 'pending' | 'stroke' | 'word' = 'pending';
  private remove: boolean | null = null;
  private range: { from: number; to: number } | null = null;
  private longTimer = 0;
  private nearTimer = 0;
  private penDownAt = -Infinity;
  private penUpAt = -Infinity;

  constructor(private view: EditorView) {
    const d = view.dom;
    d.addEventListener('pointerdown', this.onDown);
    d.addEventListener('pointermove', this.onHover);
    d.addEventListener('pointerleave', this.onLeave);
    d.addEventListener('touchstart', this.onTouchStart, { passive: false });
    d.addEventListener('mousedown', this.onMouseDown, true);
    d.addEventListener('selectstart', this.onSelectStart, true);
    d.addEventListener('contextmenu', this.onContextMenu, true);
  }

  destroy() {
    const d = this.view.dom;
    d.removeEventListener('pointerdown', this.onDown);
    d.removeEventListener('pointermove', this.onHover);
    d.removeEventListener('pointerleave', this.onLeave);
    d.removeEventListener('touchstart', this.onTouchStart);
    d.removeEventListener('mousedown', this.onMouseDown, true);
    d.removeEventListener('selectstart', this.onSelectStart, true);
    d.removeEventListener('contextmenu', this.onContextMenu, true);
    this.end();
    this.clearNear();
  }

  private active() {
    return penMarkOn() && this.view.editable;
  }

  /** The pen's own scrolling is off while it is near the text (a finger still scrolls); cleared 1.5 s after it was last seen. */
  private near() {
    this.view.dom.classList.add('pen-near');
    window.clearTimeout(this.nearTimer);
    this.nearTimer = window.setTimeout(() => this.clearNear(), 1500);
  }
  private clearNear() {
    window.clearTimeout(this.nearTimer);
    this.view.dom.classList.remove('pen-near');
  }

  private onHover = (e: PointerEvent) => {
    if (e.pointerType === 'pen' && !this.down && this.active()) this.near();
  };
  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'pen' && !this.down) this.clearNear();
  };
  private onTouchStart = (e: TouchEvent) => {
    if (this.down || performance.now() - this.penDownAt < 300) e.preventDefault();
  };
  private onMouseDown = (e: MouseEvent) => {
    if (this.down) e.preventDefault();
  };
  private onSelectStart = (e: Event) => {
    if (this.down) e.preventDefault();
  };

  /** A side-button stroke must not end in the long-press / right-click menu. */
  private onContextMenu = (e: Event) => {
    if (this.down || performance.now() - this.penUpAt < 400) e.preventDefault();
  };

  private onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'pen' || !e.isPrimary || this.down || !this.active()) return;
    const t = e.target as HTMLElement | null;
    const off = t?.closest('[contenteditable="false"], button, input, textarea, select');
    if (off && this.view.dom.contains(off)) return;
    const hit = this.view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (!hit) return;
    let mid = e.clientY;
    let lineH = 20;
    try {
      const c = this.view.coordsAtPos(hit.pos);
      if (c.bottom > c.top) {
        mid = (c.top + c.bottom) / 2;
        lineH = Math.max(12, c.bottom - c.top);
      }
    } catch {
      /* keep the pen's own height */
    }
    e.preventDefault();
    this.near();
    this.penDownAt = performance.now();
    this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, mid, lineH, pos: hit.pos };
    this.phase = 'pending';
    this.remove = side(e) ? true : null;
    this.range = null;
    try {
      this.view.dom.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events can't be captured; window listeners below still see the stroke */
    }
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    this.longTimer = window.setTimeout(() => this.selectWord(), LONG_MS);
  };

  private onMove = (e: PointerEvent) => {
    const d = this.down;
    if (!d || e.pointerId !== d.id) return;
    this.near();
    if (this.phase === 'word') return;
    if (this.phase === 'pending') {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE_PX) return;
      window.clearTimeout(this.longTimer);
      this.phase = 'stroke';
    }
    if (side(e)) this.remove = true;
    // Line lock: within 0.8 of a line above or below where it started, the stroke stays on that line.
    const y = Math.abs(e.clientY - d.mid) < LOCK * d.lineH ? d.mid : e.clientY;
    const hit = this.view.posAtCoords({ left: e.clientX, top: y });
    if (!hit) return;
    const { doc } = this.view.state;
    const head = fenced(doc, d.pos, hit.pos);
    const r = snapWords(doc, Math.min(d.pos, head), Math.max(d.pos, head));
    if (r.from >= r.to) {
      this.range = null;
      this.show(null);
      return;
    }
    const type = this.view.state.schema.marks.highlight;
    if (!type) return;
    if (this.remove === null) {
      // Decided once, by the first word the stroke covers: already marked → this stroke removes.
      const w = head >= d.pos ? snapWords(doc, r.from, r.from) : snapWords(doc, r.to, r.to);
      this.remove = w.to > w.from ? allMarked(doc, w.from, w.to, type) : allMarked(doc, r.from, r.to, type);
    }
    this.range = r;
    this.show({ ...r, remove: this.remove });
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    if (!d || e.pointerId !== d.id) return;
    this.penUpAt = performance.now();
    if (this.phase === 'pending') this.caret(d.pos);
    else if (this.phase === 'stroke') this.commit();
    this.end();
  };

  private onCancel = (e: PointerEvent) => {
    if (this.down && e.pointerId === this.down.id) this.end();
  };

  private end() {
    window.clearTimeout(this.longTimer);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    if (this.down && penMarkKey.getState(this.view.state) !== DecorationSet.empty) this.show(null);
    this.down = null;
    this.range = null;
    this.remove = null;
  }

  private show(p: Preview) {
    if (!this.view.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta(penMarkKey, p).setMeta('addToHistory', false));
  }

  private caret(pos: number) {
    const { state } = this.view;
    this.view.focus();
    this.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(pos, state.doc.content.size)))).scrollIntoView());
  }

  private selectWord() {
    const d = this.down;
    if (!d || this.phase !== 'pending') return;
    this.phase = 'word';
    const { state } = this.view;
    const w = snapWords(state.doc, d.pos, d.pos);
    this.view.focus();
    if (w.from >= w.to) this.caret(d.pos);
    else this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, w.from, w.to)));
  }

  private commit() {
    const r = this.range;
    const { state } = this.view;
    const type = state.schema.marks.highlight;
    if (!r || !type) return;
    const tr = state.tr.setMeta(penMarkKey, null);
    if (this.remove) tr.removeMark(r.from, r.to, type);
    else tr.addMark(r.from, r.to, type.create());
    if (!tr.docChanged) {
      this.view.dispatch(tr.setMeta('addToHistory', false));
      return;
    }
    this.view.dispatch(closeHistory(tr));
    buzz('mark');
  }
}

export const PenMark = Extension.create({
  name: 'penMark',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: penMarkKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, _old, state) {
            const meta = tr.getMeta(penMarkKey) as Preview | undefined;
            if (meta !== undefined) return previewOf(state, meta);
            return set.map(tr.mapping, tr.doc);
          }
        },
        props: { decorations: (state) => penMarkKey.getState(state) },
        view: (view) => new PenMarkView(view)
      })
    ];
  }
});
