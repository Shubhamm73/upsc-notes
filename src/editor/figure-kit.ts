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
