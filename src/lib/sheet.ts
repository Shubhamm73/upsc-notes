import { h } from './h';

export interface SheetAction {
  label: string;
  id?: string;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the sheet open (e.g. an empty name). */
  run?: () => boolean | void | Promise<boolean | void>;
}

let open: (() => void) | null = null;

export function closeSheet(): boolean {
  if (!open) return false;
  open();
  return true;
}

/**
 * A centred dialog over a dimmed screen: Add, Rename, Delete, Move to…. Esc or a tap on the dim area
 * cancels. The first field (or the primary button) gets focus.
 */
export function openSheet(opts: { title: string; id?: string; body?: (Node | string)[]; actions: SheetAction[]; onClose?: () => void }): () => void {
  closeSheet();
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, id: opts.id }, h('h2', {}, opts.title));
  if (opts.body) panel.append(...opts.body);
  const acts = h('div', { class: 'sheet-actions' });
  for (const a of opts.actions) {
    const b = h('button', { type: 'button', id: a.id, class: a.danger ? 'danger-btn' : a.primary ? 'primary' : '' }, a.label);
    b.addEventListener('click', async () => {
      const keep = (await a.run?.()) === false;
      if (!keep) close();
    });
    acts.append(b);
  }
  if (opts.actions.length) panel.append(acts);
  const scrim = h('div', { class: 'sheet-scrim' }, panel);
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && (e.target as HTMLElement).matches('.sheet input:not([type=date]):not([type=month])')) {
      e.preventDefault();
      (acts.querySelector('button.primary, button.danger-btn') as HTMLButtonElement | null)?.click();
    }
  };
  const before = document.activeElement as HTMLElement | null;
  function close() {
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    if (open === close) open = null;
    opts.onClose?.();
    before?.focus?.({ preventScroll: true });
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(scrim);
  open = close;
  const first = panel.querySelector<HTMLElement>('input, select, textarea') ?? panel.querySelector<HTMLElement>('button.primary, .sheet-list button');
  first?.focus({ preventScroll: true });
  return close;
}
