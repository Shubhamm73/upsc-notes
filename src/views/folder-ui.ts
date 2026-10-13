import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { reducedMotion } from '../editor/tools';

/** One step of the breadcrumb (Notes › GS1 › History). */
export interface Crumb {
  label: string;
  href: string;
}

/** Breadcrumb with a ← that goes up one level. The last step is where you are. */
export function crumbs(path: Crumb[]): HTMLElement {
  const nav = h('nav', { class: 'crumbs', id: 'crumbs', 'aria-label': 'Where you are' });
  if (path.length > 1) {
    nav.append(h('a', { class: 'crumb-back', href: path[path.length - 2].href, 'aria-label': `Back to ${path[path.length - 2].label}` }, icon('back', 20)));
  }
  path.forEach((c, i) => {
    if (i) nav.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'));
    nav.append(i < path.length - 1 ? h('a', { class: 'crumb', href: c.href }, c.label) : h('span', { class: 'crumb here', 'aria-current': 'page' }, c.label));
  });
  return nav;
}

export interface CardSpec {
  id: string;
  href: string;
  name: string;
  /** CSS colour (the main subject's). */
  colour: string;
  badge: Node | string;
  sub: string;
  count: string;
  due: number;
  /** Bar: share on schedule, 0–100; null = no bar. */
  pct: number | null;
  deletable: boolean;
}

export interface GridOpts {
  cards: CardSpec[];
  editing: boolean;
  addLabel: string;
  onAdd(): void;
  onRename?(id: string, name: string): void;
  onDelete(id: string): void;
  /** Absent: no drag handles (months and dates sort themselves). */
  onReorder?(ids: string[]): void;
}

/** The grid of folder cards, with + Add at the end. In Edit mode: rename by the name, red − to delete, drag handle to reorder. */
export function folderGrid(o: GridOpts): HTMLElement {
  const grid = h('div', { class: `fgrid${o.editing ? ' editing' : ''}`, id: 'folder-grid' });
  for (const c of o.cards) {
    const top = h('div', { class: 'ftop' }, h('span', { class: 'fbadge' }, c.badge));
    const nameBox = h('div', { class: 'fnames' });
    if (o.editing && o.onRename) {
      const input = h('input', { class: 'rename', value: c.name, 'aria-label': `Rename ${c.name}`, 'data-rename': c.id, maxlength: 60, autocomplete: 'off' });
      const commit = () => {
        const v = input.value.trim();
        if (!v) input.value = c.name;
        else if (v !== c.name) o.onRename!(c.id, v);
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        } else if (e.key === 'Escape') {
          input.value = c.name;
          input.blur();
        }
      });
      nameBox.append(input);
    } else nameBox.append(h('strong', { class: 'fname' }, c.name));
    nameBox.append(h('span', { class: 'fsub' }, c.sub));
    top.append(nameBox);
    const body = [
      top,
      h('span', { class: 'fmeta' }, c.count, c.due ? h('span', { class: 'fdue' }, `${c.due} due`) : null),
      c.pct === null ? h('span', { class: 'fbar empty' }) : h('span', { class: 'fbar' }, h('i', { style: `width: ${c.pct}%` }))
    ];
    let card: HTMLElement;
    if (o.editing) {
      card = h('div', { class: 'fcard', 'data-id': c.id, style: `--c: ${c.colour}` }, ...body);
      if (c.deletable) {
        const del = h('button', { type: 'button', class: 'fdel', 'aria-label': `Delete ${c.name}`, 'data-del': c.id }, icon('minus', 22));
        del.addEventListener('click', () => o.onDelete(c.id));
        card.append(del);
      }
      if (o.onReorder) card.append(gripFor(card, grid, c.name, o.onReorder));
    } else {
      card = h('a', { class: 'fcard', href: c.href, 'data-id': c.id, style: `--c: ${c.colour}` }, ...body);
    }
    grid.append(card);
  }
  const add = h('button', { type: 'button', class: 'fcard fadd', id: 'folder-add' }, icon('plus', 28), o.addLabel);
  add.addEventListener('click', () => o.onAdd());
  grid.append(add);
  return grid;
}

const idsOf = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>('.fcard[data-id]')].map((c) => c.dataset.id!);

/** Slides cards from where they were to where they are now (160 ms, transform only). */
function flip(cards: HTMLElement[], before: Map<HTMLElement, DOMRect>) {
  if (reducedMotion()) return;
  for (const c of cards) {
    const a = before.get(c);
    if (!a) continue;
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (dx || dy) c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

/**
 * The drag handle. Pointer events, so a finger, the S Pen and a mouse all drag (the handle has
 * touch-action: none, so a drag on it never scrolls). Arrow keys move the card too.
 */
function gripFor(card: HTMLElement, grid: HTMLElement, name: string, onReorder: (ids: string[]) => void): HTMLElement {
  const grip = h('button', { type: 'button', class: 'fgrip', 'aria-label': `Move ${name}. Drag, or use the arrow keys.` }, icon('grip', 22));
  grip.addEventListener('keydown', (e) => {
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    if (!back && !fwd) return;
    e.preventDefault();
    const sibs = [...grid.querySelectorAll<HTMLElement>('.fcard[data-id]')];
    const i = sibs.indexOf(card);
    const j = back ? i - 1 : i + 1;
    if (j < 0 || j >= sibs.length) return;
    const before = new Map(sibs.map((c) => [c, c.getBoundingClientRect()]));
    grid.insertBefore(card, back ? sibs[j] : sibs[j].nextSibling);
    flip(sibs, before);
    grip.focus();
    onReorder(idsOf(grid));
  });
  grip.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events can't be captured; the window listeners below still follow the pointer */
    }
    const start = idsOf(grid).join();
    let ox = e.clientX;
    let oy = e.clientY;
    card.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      card.style.transform = `translate(${ev.clientX - ox}px, ${ev.clientY - oy}px)`;
      const sibs = [...grid.querySelectorAll<HTMLElement>('.fcard[data-id]')];
      const over = sibs.find((c) => {
        if (c === card) return false;
        const r = c.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (!over) return;
      const before = new Map(sibs.map((c) => [c, c.getBoundingClientRect()]));
      card.style.transform = '';
      const natural = card.getBoundingClientRect();
      grid.insertBefore(card, sibs.indexOf(over) < sibs.indexOf(card) ? over : over.nextSibling);
      const moved = card.getBoundingClientRect();
      // keep the lifted card under the pointer although its place in the grid changed
      ox += moved.left - natural.left;
      oy += moved.top - natural.top;
      card.style.transform = `translate(${ev.clientX - ox}px, ${ev.clientY - oy}px)`;
      flip(sibs.filter((c) => c !== card), before);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      card.classList.remove('dragging');
      card.style.transform = '';
      const now = idsOf(grid);
      if (now.join() !== start) onReorder(now);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  });
  return grip;
}

/** Text field for a dialog. */
export function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'sheet-field' }, h('span', {}, label), input);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Edited 2 days ago". */
export function ago(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
