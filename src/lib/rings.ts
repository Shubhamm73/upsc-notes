import type { Note } from '../db';
import { h } from './h';

const RING_R = 24;
const RING_C = 2 * Math.PI * RING_R;
const NS = 'http://www.w3.org/2000/svg';

/** Share of these notes (a main subject's, a subject's) that are reviewed and not overdue, 0–100; null = no notes. */
export function ringOf(notes: Note[], today: string): number | null {
  const list = notes.filter((n) => !n.deletedAt);
  if (!list.length) return null;
  const ok = list.filter((n) => n.reviewCount > 0 && n.nextReview >= today).length;
  return Math.round((ok / list.length) * 100);
}

function svgEl(tag: string, attrs: Record<string, string>) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const arc = (colour: string, pct: number, startPct = 0) =>
  svgEl('circle', {
    cx: '32',
    cy: '32',
    r: String(RING_R),
    fill: 'none',
    stroke: colour,
    'stroke-width': '7',
    'stroke-linecap': 'round',
    'stroke-dasharray': `${(pct / 100) * RING_C} ${RING_C}`,
    transform: `rotate(${-90 + startPct * 3.6} 32 32)`,
    class: 'ring-arc'
  });

/**
 * A subject ring. With `from` (session summary) the part gained since `from` is drawn as its own arc,
 * so it can sweep into place with a transform (see animateRingGain).
 */
export function subjectRing(name: string, value: number | null, opts: { colour: string; href?: string; from?: number | null }): HTMLElement {
  const svg = svgEl('svg', { width: '64', height: '64', viewBox: '0 0 64 64', role: 'img' });
  svg.setAttribute('aria-label', value === null ? `${name}: no notes yet` : `${name}: ${value} percent on schedule`);
  svg.append(svgEl('circle', { cx: '32', cy: '32', r: String(RING_R), fill: 'none', stroke: 'var(--chip)', 'stroke-width': '7' }));
  const v = value ?? 0;
  const from = Math.min(opts.from ?? v, v);
  if (from > 0) svg.append(arc(opts.colour, from));
  if (v > from) {
    const g = svgEl('g', { class: 'ring-gain', 'data-gain': String(v - from) });
    g.append(arc(opts.colour, v - from, from));
    svg.append(g);
  }
  const label = svgEl('text', { x: '32', y: '37', 'text-anchor': 'middle', 'font-size': '14', 'font-weight': '700', fill: 'var(--fg)' });
  label.textContent = value === null ? '' : `${value}%`;
  svg.append(label);
  return opts.href ? h('a', { class: 'ring', href: opts.href }, svg, h('span', {}, name)) : h('div', { class: 'ring' }, svg, h('span', {}, name));
}

/** Sweeps each gained arc forward into place (300 ms, transform and opacity only). */
export function animateRingGain(root: HTMLElement) {
  for (const g of root.querySelectorAll<SVGGElement>('.ring-gain')) {
    const deg = Number(g.dataset.gain) * 3.6;
    g.animate(
      [
        { transform: `rotate(${-deg}deg)`, opacity: 0 },
        { transform: 'rotate(0deg)', opacity: 1 }
      ],
      { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)' }
    );
  }
}
