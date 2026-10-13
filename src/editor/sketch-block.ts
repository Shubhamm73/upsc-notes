import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { getSketchPrefs, setSketchPrefs, type SketchPrefs } from '../lib/prefs';
import {
  decodeStroke,
  drawAll,
  drawStroke,
  encodeStroke,
  HL_COLORS,
  inkBottom,
  PEN_COLORS,
  readHeight,
  readStrokes,
  screenPalette,
  SIZES,
  SKETCH_GROW,
  SKETCH_H,
  SKETCH_MAX_H,
  SKETCH_MIN_H,
  SKETCH_W,
  touches,
  type Decoded,
  type Palette,
  type Stroke
} from '../lib/sketch';

/**
 * Sketch block (U4-1). The S Pen (or a mouse) draws on it anywhere in the note, at any time;
 * a finger scrolls past it and never draws, unless "Draw with finger" is on. Strokes live in the
 * block's `strokes` attribute, so every stroke, erase, clear and height change is an ordinary edit
 * of the section: it autosaves, goes in backups, and the note-wide Undo / Redo walks it in order.
 */

/** The note-wide Undo / Redo (history.ts), for the sketch tools' own ↶ ↷. Set while a note is open. */
export interface SketchHooks {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}
let hooks: SketchHooks | null = null;
export function setSketchHooks(next: SketchHooks | null) {
  hooks = next;
}

const views = new Set<SketchView>();
let active: SketchView | null = null;
let prefs: SketchPrefs = getSketchPrefs();

function setActive(v: SketchView | null) {
  if (active === v) return;
  const was = active;
  active = v;
  was?.showStrip(false);
  v?.showStrip(true);
}

function savePrefs() {
  setSketchPrefs(prefs);
  document.documentElement.toggleAttribute('data-sketch-finger', prefs.finger);
  views.forEach((v) => v.paintStrip());
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  document.documentElement.toggleAttribute('data-sketch-finger', prefs.finger);
  // A tap anywhere else puts the tools away (not on the note header or the touch bar: Undo lives there).
  // Only once the tap is over: hiding them moves the text below the sketch up, and the caret must land
  // where the finger was. A scroll (the browser cancels the pointer) leaves them out.
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (!active || !t || active.dom.contains(t) || t.closest('.canvas-head, .touchbar, .popover')) return;
      const was = active;
      const done = () => {
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', done, true);
      };
      const up = () => {
        done();
        let hidden = false;
        const hide = () => {
          if (hidden) return;
          hidden = true;
          window.removeEventListener('click', onClick, true);
          if (active === was) setActive(null);
        };
        const onClick = () => window.setTimeout(hide, 0);
        window.addEventListener('click', onClick, true);
        window.setTimeout(hide, 450); // a tap's click comes well within this; nothing is lost if it doesn't
      };
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', done, true);
    },
    true
  );
  window.addEventListener('themechange', () =>
    views.forEach((v) => {
      v.render();
      v.paintStrip(); // the swatches show the theme's ink too
    })
  );
}

/** Selects the sketch just before the caret (after "Sketch" was inserted), which shows its tools. */
export function selectSketchBefore(e: Editor) {
  const { from } = e.state.selection;
  let best = -1;
  e.state.doc.descendants((n, pos) => {
    if (n.type.name === 'sketchBlock' && pos < from) best = Math.max(best, pos);
    return true;
  });
  if (best >= 0) e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, best)).scrollIntoView());
}

interface Live {
  id: number;
  type: string;
  kind: 'pen' | 'hl' | 'erase';
  pts: number[];
  rect: DOMRect;
  hits: Set<number>;
  lx: number;
  ly: number;
}

const ERASER_R = 9;
const MAX_PIXELS = 8e6;

class SketchView {
  dom: HTMLElement;
  private frame: HTMLElement;
  private paper: HTMLElement;
  private base: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private handle: HTMLButtonElement;
  private sizeTag: HTMLElement;
  private grow: HTMLButtonElement;
  private caption: HTMLElement;
  private strip: HTMLElement;
  private codes: string[] = [];
  private items: (Decoded | null)[] = [];
  private cache = new Map<string, Decoded | null>();
  private height = SKETCH_H;
  private scale = 1;
  private drawing: Live | null = null;
  private lastPenDown = -1e9;
  /** True while the pointer that went down on the paper is drawing (the editor must not see its events). */
  private claim = false;
  private ro: ResizeObserver;
  private raf = 0;
  private palette: Palette | null = null;
  private clearArmed = 0;
  private nearTimer = 0;
  private stripBtns: Record<string, HTMLButtonElement> = {};
  private swatches: HTMLElement;
  private sizes: HTMLElement;
  private onTx = () => {
    if (active === this) this.paintStrip();
  };

  constructor(
    private node: PMNode,
    private editor: Editor,
    private getPos: () => number | undefined
  ) {
    listenOnce();
    this.base = h('canvas', { class: 'sketch-ink', 'aria-hidden': 'true' });
    this.live = h('canvas', { class: 'sketch-live', 'aria-hidden': 'true', width: 0, height: 0 });
    this.paper = h('div', { class: 'sketch-paper', role: 'img' }, this.base, this.live);
    this.handle = h('button', { type: 'button', class: 'resize-handle', 'aria-label': 'Drag to resize sketch', tabindex: '-1' });
    this.sizeTag = h('span', { class: 'size-tag' });
    this.grow = h('button', { type: 'button', class: 'sketch-grow', 'aria-label': 'Drag to make the sketch taller or shorter', tabindex: '-1' });
    this.frame = h('div', { class: 'img-frame sketch-frame' }, this.paper, this.handle, this.sizeTag, this.grow);
    this.caption = h('figcaption', { class: 'img-caption' });
    this.swatches = h('span', { class: 'sk-group sk-colors', role: 'group', 'aria-label': 'Colour' });
    this.sizes = h('span', { class: 'sk-group sk-sizes', role: 'group', 'aria-label': 'Size' });
    this.strip = this.buildStrip();
    this.dom = h('figure', { class: 'img-block sketch-block' }, this.frame, this.caption, this.strip);

    this.paper.addEventListener('pointerdown', this.onDown);
    this.paper.addEventListener('pointermove', this.onMove);
    this.paper.addEventListener('pointerup', this.onUp);
    this.paper.addEventListener('pointercancel', this.onCancel);
    this.paper.addEventListener('pointerleave', this.onLeave);
    // The S Pen scrolls the page like a finger unless stopped: no scrolling while it is near or on the paper.
    this.paper.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.paper.addEventListener('contextmenu', (e) => e.preventDefault());
    this.paper.addEventListener('dragstart', (e) => e.preventDefault());
    this.handle.addEventListener('pointerdown', this.onResize);
    this.grow.addEventListener('pointerdown', this.onGrow);
    editor.on('transaction', this.onTx);

    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.paper);
    views.add(this);
    this.apply(node);
  }

  // ---------------- attributes ----------------

  private apply(n: PMNode) {
    this.node = n;
    const a = n.attrs;
    this.dom.dataset.align = a.align;
    const floated = a.align === 'left' || a.align === 'right';
    this.dom.style.width = floated ? `${a.width}%` : '';
    this.frame.style.width = floated ? '100%' : `${a.width}%`;
    this.sizeTag.textContent = `${a.width}%`;
    this.caption.textContent = a.caption || '';
    this.caption.hidden = !a.caption;
    const count = readStrokes(a.strokes).length;
    this.paper.setAttribute('aria-label', `${a.caption ? a.caption + '. ' : ''}Sketch, ${count} ${count === 1 ? 'stroke' : 'strokes'}`);
    const height = readHeight(a.height);
    const resized = height !== this.height;
    this.height = height;
    this.paper.style.aspectRatio = `${SKETCH_W} / ${height}`;
    const codes = readStrokes(a.strokes);
    const appended = !resized && codes.length > this.codes.length && this.codes.every((c, i) => codes[i] === c);
    const same = !resized && codes.length === this.codes.length && this.codes.every((c, i) => codes[i] === c);
    const added = appended ? codes.slice(this.codes.length) : [];
    this.codes = codes;
    this.items = codes.map((c) => this.decoded(c));
    if (same) return;
    if (appended && this.base.width) {
      // just the new strokes on top: no full redraw for each stroke
      const g = this.base.getContext('2d')!;
      g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const pal = this.pal();
      for (const c of added) {
        const s = this.decoded(c);
        if (s) drawStroke(g, s, pal);
      }
      return;
    }
    this.render();
  }

  private decoded(code: string): Decoded | null {
    let d = this.cache.get(code);
    if (d === undefined) {
      d = decodeStroke(code);
      this.cache.set(code, d);
    }
    return d;
  }

  private pal(): Palette {
    return (this.palette ??= screenPalette());
  }

  /** Sizes the canvas to the paper (sharp on the tablet's screen, at most 8 million pixels) and draws every stroke. */
  render(skip?: Set<number>) {
    const w = this.paper.clientWidth;
    if (!w) return;
    let k = window.devicePixelRatio || 1;
    const cssH = (w * this.height) / SKETCH_W;
    if (w * k * cssH * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (w * cssH));
    const pw = Math.max(1, Math.round(w * k));
    const ph = Math.max(1, Math.round(cssH * k));
    if (this.base.width !== pw || this.base.height !== ph) {
      this.base.width = pw;
      this.base.height = ph;
    }
    this.scale = pw / SKETCH_W;
    this.palette = null; // the theme may have changed
    const g = this.base.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    drawAll(g, this.items.filter((s): s is Decoded => !!s), this.pal(), skip && this.mapSkip(skip));
  }

  /** Erased stroke indices (into codes) as indices into the readable strokes. */
  private mapSkip(skip: Set<number>): Set<number> {
    const out = new Set<number>();
    let j = 0;
    this.items.forEach((s, i) => {
      if (!s) return;
      if (skip.has(i)) out.add(j);
      j++;
    });
    return out;
  }

  private commit(attrs: Record<string, unknown>) {
    const pos = this.getPos();
    if (pos === undefined || this.editor.isDestroyed) return;
    const tr = this.editor.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs });
    this.editor.view.dispatch(tr);
  }

  // ---------------- drawing ----------------

  private point(e: PointerEvent, live: Live): [number, number, number] {
    const r = live.rect;
    const k = SKETCH_W / (r.width || 1);
    const x = Math.min(SKETCH_W, Math.max(0, (e.clientX - r.left) * k));
    const y = Math.min(this.height, Math.max(0, (e.clientY - r.top) * k));
    let p = 0.5;
    if (e.pointerType === 'pen') {
      p = e.pressure > 0 ? e.pressure : 0.5;
      const prev = live.pts.length ? live.pts[live.pts.length - 1] : p;
      p = prev * 0.4 + p * 0.6; // steadier width
    }
    return [x, y, p];
  }

  private canDraw() {
    return this.editor.isEditable;
  }

  private onDown = (e: PointerEvent) => {
    this.claim = false;
    if (!this.canDraw()) return;
    const t = e.pointerType;
    if (t === 'touch') {
      // a palm (or any finger) while the pen draws is ignored
      if (this.drawing && this.drawing.type !== 'touch') return;
      if (!prefs.finger) return; // the finger scrolls; a tap selects the sketch (the editor handles it)
      if (this.drawing) return void this.stop(false); // a second finger: no drawing
    } else {
      if (t === 'mouse' && e.button !== 0 && e.button !== 2) return;
      // palm first, then the pen: the palm's stroke is dropped
      if (this.drawing?.type === 'touch') this.stop(false);
      if (this.drawing) return;
      if (t === 'pen') {
        this.lastPenDown = performance.now();
        this.penNear(); // for the next stroke too, if this pen never hovers
      }
    }
    e.preventDefault();
    this.claim = true;
    setActive(this);
    const erase = (prefs.tool === 'eraser' && e.button !== 2) || (e.buttons & 2) !== 0 || (e.buttons & 32) !== 0 || e.button === 2 || e.button === 5;
    const kind: Live['kind'] = erase ? 'erase' : prefs.tool === 'hl' ? 'hl' : 'pen';
    const live: Live = { id: e.pointerId, type: t, kind, pts: [], rect: this.paper.getBoundingClientRect(), hits: new Set(), lx: -1, ly: -1 };
    this.drawing = live;
    try {
      this.paper.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer can't be captured; moves still arrive on the paper */
    }
    if (kind !== 'erase') {
      this.live.width = this.base.width;
      this.live.height = this.base.height;
    }
    this.add(e, live);
    this.paintLive();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'pen' && this.canDraw()) this.penNear();
    const live = this.drawing;
    if (!live || e.pointerId !== live.id) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) this.add(ev, live);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paintLive());
  };

  private add(e: PointerEvent, live: Live) {
    const [x, y, p] = this.point(e, live);
    if (live.kind === 'erase') {
      // along the path from the last point, so a quick swipe doesn't jump over a line
      const steps = live.lx < 0 ? 1 : Math.max(1, Math.ceil(Math.hypot(x - live.lx, y - live.ly) / ERASER_R));
      let hit = false;
      for (let k = 1; k <= steps; k++) {
        const ex = live.lx < 0 ? x : live.lx + ((x - live.lx) * k) / steps;
        const ey = live.ly < 0 ? y : live.ly + ((y - live.ly) * k) / steps;
        this.items.forEach((s, i) => {
          if (s && !live.hits.has(i) && touches(s, ex, ey, ERASER_R)) {
            live.hits.add(i);
            hit = true;
          }
        });
      }
      live.lx = x;
      live.ly = y;
      if (hit) this.render(live.hits);
      return;
    }
    const n = live.pts.length;
    if (n && Math.hypot(x - live.pts[n - 3], y - live.pts[n - 2]) < 0.6) {
      live.pts[n - 1] = Math.max(live.pts[n - 1], p);
      return;
    }
    live.pts.push(Math.round(x * 4) / 4, Math.round(y * 4) / 4, Math.round(p * 100) / 100);
  }

  private stroke(live: Live): Stroke {
    const tool = live.kind === 'hl' ? 'hl' : 'pen';
    const choice = tool === 'hl' ? prefs.hl : prefs.pen;
    return { tool, color: choice.color, size: choice.size, pts: live.pts };
  }

  private paintLive() {
    this.raf = 0;
    const live = this.drawing;
    if (!live || live.kind === 'erase' || !this.live.width) return;
    const g = this.live.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.live.width, this.live.height);
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    drawStroke(g, this.stroke(live), this.pal());
  }

  private onUp = (e: PointerEvent) => {
    if (this.drawing && e.pointerId === this.drawing.id) this.stop(true);
  };

  private onCancel = (e: PointerEvent) => {
    // The browser took the pointer (a scroll began): keep what the pen drew, drop a finger's.
    if (this.drawing && e.pointerId === this.drawing.id) this.stop(this.drawing.type !== 'touch' && this.drawing.pts.length >= 6);
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'pen' && !this.drawing) this.penGone();
  };

  /**
   * The pen is near (hovering) or on the paper: no scrolling here, so its stroke draws. A hovering pen keeps
   * sending moves; when they stop (or it leaves), a finger scrolls the sketch again, so this can never stick.
   */
  private penNear() {
    this.paper.classList.add('pen-near');
    window.clearTimeout(this.nearTimer);
    this.nearTimer = window.setTimeout(() => {
      if (!this.drawing) this.penGone();
    }, 1500);
  }

  private penGone() {
    window.clearTimeout(this.nearTimer);
    this.paper.classList.remove('pen-near');
  }

  private onTouchStart = (e: TouchEvent) => {
    // The pen's own touch (it arrives just after its pointerdown): never a scroll.
    if (this.drawing?.type === 'pen' || performance.now() - this.lastPenDown < 300) e.preventDefault();
  };

  /** Ends the stroke: saved (one edit) or dropped. */
  private stop(save: boolean) {
    const live = this.drawing;
    this.drawing = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      this.paper.releasePointerCapture(live?.id ?? 0);
    } catch {
      /* not captured */
    }
    this.live.width = 0;
    this.live.height = 0;
    if (!live) return;
    if (live.type === 'pen') this.penNear();
    if (live.kind === 'erase') {
      if (save && live.hits.size) this.commit({ strokes: this.codes.filter((_, i) => !live.hits.has(i)) });
      else this.render();
      return;
    }
    if (save && live.pts.length >= 3) this.commit({ strokes: [...this.codes, encodeStroke(this.stroke(live))] });
  }

  // ---------------- size ----------------

  private onResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      this.handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const startX = e.clientX;
    const startPx = this.frame.getBoundingClientRect().width;
    const columnPx = (this.dom.parentElement ?? this.dom).getBoundingClientRect().width || 1;
    const align = this.node.attrs.align;
    const factor = align === 'center' ? 2 : 1;
    const sign = align === 'right' ? -1 : 1;
    let pct = this.node.attrs.width as number;
    this.dom.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const px = startPx + sign * factor * (ev.clientX - startX);
      pct = Math.round(Math.min(100, Math.max(20, (px / columnPx) * 100)));
      const floated = align === 'left' || align === 'right';
      this.dom.style.width = floated ? `${pct}%` : '';
      this.frame.style.width = floated ? '100%' : `${pct}%`;
      this.sizeTag.textContent = `${pct}%`;
    };
    const up = () => {
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
      this.handle.removeEventListener('pointercancel', up);
      this.dom.classList.remove('resizing');
      if (pct !== this.node.attrs.width) this.commit({ width: pct });
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
  };

  /** The shortest the sketch may be: never cutting off ink. */
  private minHeight() {
    const items = this.items.filter((s): s is Decoded => !!s);
    return Math.min(SKETCH_MAX_H, Math.max(SKETCH_MIN_H, Math.ceil((inkBottom(items) + 10) / 10) * 10));
  }

  private onGrow = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.canDraw()) return;
    try {
      this.grow.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const startY = e.clientY;
    const startH = this.height;
    const k = SKETCH_W / (this.paper.clientWidth || 1);
    const min = this.minHeight();
    let next = startH;
    this.dom.classList.add('growing');
    const move = (ev: PointerEvent) => {
      next = Math.min(SKETCH_MAX_H, Math.max(min, Math.round((startH + (ev.clientY - startY) * k) / 10) * 10));
      this.paper.style.aspectRatio = `${SKETCH_W} / ${next}`;
    };
    const up = () => {
      this.grow.removeEventListener('pointermove', move);
      this.grow.removeEventListener('pointerup', up);
      this.grow.removeEventListener('pointercancel', up);
      this.dom.classList.remove('growing');
      if (next !== startH) this.commit({ height: next });
      else this.paper.style.aspectRatio = `${SKETCH_W} / ${startH}`;
    };
    this.grow.addEventListener('pointermove', move);
    this.grow.addEventListener('pointerup', up);
    this.grow.addEventListener('pointercancel', up);
  };

  // ---------------- tools strip ----------------

  private buildStrip(): HTMLElement {
    const b = (key: string, label: globalThis.Node | string, aria: string, run: () => void, cls = 'sk-btn') => {
      const el = h('button', { type: 'button', class: cls, 'aria-label': aria, title: aria, 'data-sk': key }, label);
      el.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep the caret where it was
      el.addEventListener('click', () => {
        run();
        this.paintStrip();
      });
      this.stripBtns[key] = el;
      return el;
    };
    const tool = (id: SketchPrefs['tool'], ic: string, name: string) =>
      b(`tool-${id}`, h('span', { class: 'sk-ic' }, icon(ic, 20), h('span', { class: 'sk-text' }, name)), name, () => {
        prefs.tool = id;
        savePrefs();
      });
    const strip = h(
      'div',
      { class: 'sketch-strip', role: 'toolbar', 'aria-label': 'Sketch tools', hidden: true },
      h('span', { class: 'sk-group', role: 'group', 'aria-label': 'Tool' }, tool('pen', 'pen', 'Pen'), tool('hl', 'highlighter', 'Highlighter'), tool('eraser', 'eraser', 'Eraser')),
      this.swatches,
      this.sizes,
      h(
        'span',
        { class: 'sk-group' },
        b('finger', h('span', { class: 'sk-ic' }, icon('hand', 20), h('span', { class: 'sk-text' }, 'Finger')), 'Draw with finger', () => {
          prefs.finger = !prefs.finger;
          savePrefs();
        }),
        b('undo', icon('undo', 20), 'Undo', () => hooks?.undo()),
        b('redo', icon('redo', 20), 'Redo', () => hooks?.redo())
      ),
      h(
        'span',
        { class: 'sk-group' },
        b('more', 'More room', 'Make the sketch taller', () => {
          if (this.height < SKETCH_MAX_H) this.commit({ height: Math.min(SKETCH_MAX_H, this.height + SKETCH_GROW) });
        }),
        b('clear', 'Clear', 'Clear the sketch', () => this.clear(), 'sk-btn danger'),
        b('done', 'Done', 'Done sketching', () => setActive(null), 'sk-btn sk-done')
      )
    );
    return strip;
  }

  private clear() {
    const btn = this.stripBtns.clear;
    if (!this.codes.length) return;
    if (Date.now() - this.clearArmed > 3000) {
      this.clearArmed = Date.now();
      btn.textContent = 'Tap again to clear';
      window.setTimeout(() => {
        if (Date.now() - this.clearArmed >= 3000) btn.textContent = 'Clear';
      }, 3100);
      return;
    }
    this.clearArmed = 0;
    btn.textContent = 'Clear';
    this.commit({ strokes: [] });
  }

  showStrip(on: boolean) {
    const show = on && this.editor.isEditable;
    this.strip.hidden = !show;
    this.dom.classList.toggle('is-sketching', show);
    if (show) this.paintStrip();
    else {
      this.clearArmed = 0;
      if (this.stripBtns.clear) this.stripBtns.clear.textContent = 'Clear';
    }
  }

  paintStrip() {
    if (this.strip.hidden) return;
    for (const id of ['pen', 'hl', 'eraser']) this.stripBtns[`tool-${id}`].setAttribute('aria-pressed', String(prefs.tool === id));
    this.stripBtns.finger.setAttribute('aria-pressed', String(prefs.finger));
    this.stripBtns.undo.disabled = !hooks?.canUndo();
    this.stripBtns.redo.disabled = !hooks?.canRedo();
    this.stripBtns.more.disabled = this.height >= SKETCH_MAX_H;
    this.stripBtns.clear.disabled = !this.codes.length;
    const erasing = prefs.tool === 'eraser';
    this.swatches.hidden = erasing;
    this.sizes.hidden = erasing;
    if (erasing) return;
    const tool = prefs.tool === 'hl' ? 'hl' : 'pen';
    const choice = prefs[tool];
    const colors = tool === 'hl' ? HL_COLORS : PEN_COLORS;
    const pal = this.pal();
    this.swatches.replaceChildren(
      ...colors.map((c) => {
        const el = h('button', { type: 'button', class: 'sk-swatch', 'aria-label': `${c.name}`, title: c.name, 'aria-pressed': String(choice.color === c.id), 'data-color': c.id }, h('span', { class: 'sk-dot' }));
        (el.firstElementChild as HTMLElement).style.background = pal(c.id);
        el.addEventListener('pointerdown', (ev) => ev.preventDefault());
        el.addEventListener('click', () => {
          prefs[tool].color = c.id;
          savePrefs();
        });
        return el;
      })
    );
    this.sizes.replaceChildren(
      ...SIZES.map((s, i) => {
        const el = h('button', { type: 'button', class: 'sk-size', 'aria-label': s.name, title: s.name, 'aria-pressed': String(choice.size === s.id), 'data-size': s.id }, h('span', { class: 'sk-bar' }));
        (el.firstElementChild as HTMLElement).style.height = `${[2, 4, 7][i]}px`;
        el.addEventListener('pointerdown', (ev) => ev.preventDefault());
        el.addEventListener('click', () => {
          prefs[tool].size = s.id;
          savePrefs();
        });
        return el;
      })
    );
  }

  // ---------------- node view ----------------

  update(n: PMNode): boolean {
    if (n.type.name !== 'sketchBlock') return false;
    this.apply(n);
    if (active === this) this.paintStrip();
    return true;
  }

  selectNode() {
    this.dom.classList.add('is-selected');
    setActive(this);
  }

  deselectNode() {
    this.dom.classList.remove('is-selected');
  }

  stopEvent(e: Event): boolean {
    const t = e.target as globalThis.Node | null;
    if (!t) return false;
    if (this.strip.contains(t) || t === this.handle || t === this.grow) return true;
    // a stroke's own events never reach the editor; a finger's tap does (it selects the sketch)
    if (this.paper.contains(t)) return this.claim || e.type.startsWith('drag');
    return false;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.ro.disconnect();
    this.editor.off('transaction', this.onTx);
    if (this.raf) cancelAnimationFrame(this.raf);
    window.clearTimeout(this.nearTimer);
    views.delete(this);
    if (active === this) active = null;
  }
}

export const SketchBlock = Node.create({
  name: 'sketchBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false, // a drag on it draws

  addAttributes() {
    return {
      // Written into the HTML by renderHTML (as one data-sketch value), not one attribute each.
      strokes: { default: [], rendered: false }, // stroke codes (lib/sketch.ts)
      height: { default: SKETCH_H, rendered: false }, // in sketch units; the width is always 1000
      width: { default: 100, rendered: false }, // percent of the text column
      align: { default: 'center', rendered: false }, // left / right: text beside it, like a picture
      caption: { default: '', rendered: false }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-sketch]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          let data: { s?: unknown; h?: unknown } = {};
          try {
            data = JSON.parse(e.dataset.sketch || '{}');
          } catch {
            return false;
          }
          return {
            strokes: readStrokes(data.s),
            height: readHeight(data.h),
            width: Number(e.dataset.width) || 100,
            align: ['left', 'right'].includes(e.dataset.align ?? '') ? e.dataset.align : 'center',
            caption: e.dataset.caption ?? ''
          };
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { strokes, height, width, align, caption } = node.attrs;
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        'data-sketch': JSON.stringify({ s: strokes, h: height }),
        'data-width': width,
        'data-align': align,
        'data-caption': caption || null
      })
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => new SketchView(node, editor, () => (typeof getPos === 'function' ? getPos() : undefined));
  }
});
