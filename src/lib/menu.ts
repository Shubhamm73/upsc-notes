import { h } from './h';

export interface MenuItem {
  label: string;
  /** Accessible name when it should differ from the label (kept stable for tests and screen readers). */
  aria?: string;
  run: (button: HTMLButtonElement) => void;
  disabled?: boolean;
  danger?: boolean;
  /** Two-tap confirm: the first tap changes the label to this and arms it for 4 seconds. */
  confirm?: string;
}

let current: { el: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

export function closePopover(): boolean {
  if (!current) return false;
  current.close();
  return true;
}

/** A small menu under (or above) a button. Closes on outside tap, Esc, or after a choice. */
export function openPopover(anchor: HTMLElement, items: MenuItem[], label = 'Options') {
  const again = current?.anchor === anchor;
  closePopover();
  if (again) return; // a second tap on the same button closes it
  const list = h('div', { class: 'popover', role: 'menu', 'aria-label': label });
  for (const it of items) {
    const b = h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', disabled: !!it.disabled, 'aria-label': it.aria }, it.label);
    let armed: number | undefined;
    b.addEventListener('click', () => {
      if (it.confirm && !armed) {
        b.textContent = it.confirm;
        b.classList.add('armed');
        armed = window.setTimeout(() => {
          armed = undefined;
          b.textContent = it.label;
          b.classList.remove('armed');
        }, 4000);
        return;
      }
      clearTimeout(armed);
      close();
      it.run(b);
    });
    list.append(b);
  }
  document.body.append(list);
  const r = anchor.getBoundingClientRect();
  const vv = window.visualViewport;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const w = list.offsetWidth;
  const ht = list.offsetHeight;
  let top = r.bottom + 6;
  if (top + ht > bottom - 8) top = Math.max(8, r.top - ht - 6);
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  list.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  anchor.setAttribute('aria-expanded', 'true');
  (list.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus({ preventScroll: true });

  const onDown = (e: PointerEvent) => {
    if (!list.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  function close() {
    list.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (current?.el === list) current = null;
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  current = { el: list, anchor, close };
}
