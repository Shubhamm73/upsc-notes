import { h } from '../lib/h';
import { COLOURS } from '../lib/looks';
import { deskColours, PALETTES, paletteColours, screenInk, type PaletteId } from '../lib/svg-ink';

/** Shared bits of the chart, diagram and mind-map blocks (0.13). */
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Calls `fn` when the theme, the system colour scheme or the note's subject colour changes. Returns the cleanup. */
export function onInkChange(fn: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', fn);
  window.addEventListener('themechange', fn);
  window.addEventListener('subjectchange', fn);
  return () => {
    media.removeEventListener('change', fn);
    window.removeEventListener('themechange', fn);
    window.removeEventListener('subjectchange', fn);
  };
}

/** The six palettes (and the subject's family) as a row of swatch buttons. */
export function palettePicker(el: Element, now: PaletteId, pick: (p: PaletteId) => void): HTMLElement {
  const ink = screenInk(el);
  const desk = deskColours();
  const row = h('div', { class: 'fig-palettes', role: 'radiogroup', 'aria-label': 'Colours' });
  for (const p of PALETTES) {
    const cols = paletteColours(p.id, ink, desk).slice(0, 4);
    const b = h('button', { type: 'button', class: 'fig-pal', role: 'radio', 'aria-checked': String(p.id === now), 'aria-label': `${p.name} colours`, 'data-palette': p.id }, h('span', { class: 'fig-pal-dots', 'aria-hidden': 'true' }, ...cols.map((c) => h('i', { style: `background:${c}` }))), h('span', {}, p.name));
    b.addEventListener('click', () => {
      row.querySelectorAll('.fig-pal').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      pick(p.id);
    });
    row.append(b);
  }
  return row;
}

/** A colour menu: Auto (the palette's / branch's) and the 13 colours. */
export function colourSelect(now: string | null, label: string, pick: (k: string | null) => void): HTMLSelectElement {
  const sel = h('select', { 'aria-label': label, class: 'fig-colour' });
  sel.append(h('option', { value: '' }, 'Auto colour'), ...COLOURS.map((c) => h('option', { value: c.key }, c.name)));
  sel.value = now ?? '';
  sel.addEventListener('change', () => pick(sel.value || null));
  return sel;
}

/** A segmented two- to four-way switch. */
export function segmented<T extends string>(label: string, options: { id: T; label: string }[], now: T, pick: (v: T) => void, cls = ''): HTMLElement {
  const seg = h('div', { class: `fig-seg ${cls}`, role: 'radiogroup', 'aria-label': label });
  for (const o of options) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(o.id === now), 'data-v': o.id }, o.label);
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      pick(o.id);
    });
    seg.append(b);
  }
  return seg;
}

/** Shows what a tapped part holds (data-tip) in a small bubble over the figure. */
export function tipper(fig: HTMLElement, host: HTMLElement) {
  const tip = h('div', { class: 'fig-tip', role: 'status', hidden: true });
  fig.append(tip);
  let timer = 0;
  const show = (t: Element, x: number, y: number) => {
    tip.textContent = t.getAttribute('data-tip') ?? '';
    tip.hidden = false;
    const r = fig.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(r.width - w - 4, x - r.left - w / 2))}px`;
    tip.style.top = `${Math.max(4, y - r.top - tip.offsetHeight - 14)}px`;
    host.querySelectorAll('.is-tipped').forEach((e) => e.classList.remove('is-tipped'));
    t.classList.add('is-tipped');
    clearTimeout(timer);
    timer = window.setTimeout(hide, 4000);
  };
  const hide = () => {
    tip.hidden = true;
    host.querySelectorAll('.is-tipped').forEach((e) => e.classList.remove('is-tipped'));
  };
  host.addEventListener('click', (e) => {
    const t = (e.target as Element).closest('[data-tip]');
    if (t) show(t, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    else hide();
  });
  host.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType !== 'mouse') return;
    const t = (e.target as Element).closest('[data-tip]');
    if (t) show(t, (e as PointerEvent).clientX, (e as PointerEvent).clientY);
  });
  host.addEventListener('pointerleave', (e) => {
    if ((e as PointerEvent).pointerType === 'mouse') hide();
  });
  return { hide };
}

/** A button for an inline editing panel. */
export function panelBtn(text: string, fn: () => void, cls = '', aria?: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, 'aria-label': aria }, text);
  b.addEventListener('click', fn);
  return b;
}

export type FigAlign = 'left' | 'center' | 'right';
export const figAlign = (v: unknown): FigAlign => (v === 'left' || v === 'right' ? v : 'center');
/** Width in % of the text column (10–100); a float with no width starts at half. */
export const figWidth = (v: unknown, align: FigAlign): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return align === 'center' ? 100 : 50;
  return Math.round(Math.min(100, Math.max(10, n)));
};

/**
 * Places a chart, diagram, mind map or table card (0.16): left/right float with text beside them, centre
 * sits on its own row; any of them can be narrower than the column (width in %).
 */
export function placeFigure(el: HTMLElement, alignRaw: unknown, widthRaw: unknown) {
  const align = figAlign(alignRaw);
  const pct = figWidth(widthRaw, align);
  el.dataset.align = align;
  el.style.width = pct < 100 ? `${pct}%` : '';
  const tag = el.querySelector(':scope > .fig-size');
  if (tag) tag.textContent = `${pct}%`;
}

/**
 * A drag handle that resizes a figure (finger, pen or mouse), like a picture's. Shows the width while
 * dragging; `commit` gets the final whole percent. Returns the handle and its size tag.
 */
export function sizeGrip(el: HTMLElement, label: string, now: () => Record<string, unknown>, commit: (pct: number) => void) {
  const handle = h('button', { type: 'button', class: 'resize-handle fig-grip', 'aria-label': label, tabindex: -1, contenteditable: 'false' });
  const tag = h('span', { class: 'size-tag fig-size', 'aria-hidden': 'true', contenteditable: 'false' });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const { align: a, width: w } = now();
    const align = figAlign(a);
    const startX = e.clientX;
    const startPx = el.getBoundingClientRect().width;
    const columnPx = (el.parentElement ?? el).getBoundingClientRect().width || 1;
    const factor = align === 'center' ? 2 : 1;
    const sign = align === 'right' ? -1 : 1;
    let pct = figWidth(w, align);
    tag.textContent = `${pct}%`;
    el.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const px = startPx + sign * factor * (ev.clientX - startX);
      pct = Math.round(Math.min(100, Math.max(20, (px / columnPx) * 100)));
      el.style.width = pct < 100 ? `${pct}%` : '';
      tag.textContent = `${pct}%`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      el.classList.remove('resizing');
      commit(pct);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  return { handle, tag };
}
