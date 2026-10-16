import type { Editor } from '@tiptap/core';
import { h } from '../lib/h';
import { CHART_KINDS, renderChart, sampleChart, type ChartKind } from '../lib/charts';
import { DIAGRAM_KINDS, renderDiagram, sampleDiagram, type DiagramKind } from '../lib/diagrams';
import { newId, renderMindMap, sampleMindMap, type MindMap, type MMNode } from '../lib/mindmap';
import { openSheet } from '../lib/sheet';
import { deskColours, screenInk } from '../lib/svg-ink';
import { newChartAttrs } from './chart-block';
import { newDiagramAttrs } from './diagram-block';
import { insertBlocks } from './insert';

/**
 * Insert → Chart (0.13): one gallery of 12 charts from numbers, and 8 diagrams plus the mind map from words.
 * Each tile is a small picture of the real thing with example data; a tap inserts it.
 */
type Pick = { group: 'numbers'; kind: ChartKind } | { group: 'words'; kind: DiagramKind | 'mindmap' };

/** A new mind map: a centre and three ideas, then straight into the editor. */
export function starterMindMap(): MindMap {
  const root = newId();
  const n = (text: string, parent: string | null): MMNode => ({ id: parent ? newId() : root, text, parent, color: null, shape: 'pill', x: 0, y: 0, pinned: false, folded: false, marked: false });
  return { layout: 'radial', nodes: [n('Main idea', null), n('Idea 1', root), n('Idea 2', root), n('Idea 3', root)] };
}

export function insertMindMap(e: Editor) {
  const m = starterMindMap();
  insertBlocks(e, { type: 'mindMap', attrs: m });
  // open the full-screen editor on the map just added
  requestAnimationFrame(() => {
    let at = -1;
    e.state.doc.descendants((node, pos) => {
      if (node.type.name === 'mindMap' && node.attrs.nodes?.[0]?.id === m.nodes[0].id) at = pos;
      return at < 0;
    });
    if (at >= 0) (e.view.nodeDOM(at) as HTMLElement | null)?.dispatchEvent(new Event('open-mindmap'));
  });
}

export function openChartGallery(e: Editor, focus: 'numbers' | 'words' = 'numbers') {
  const host = e.view.dom;
  const ink = screenInk(host);
  const desk = deskColours();
  let close = () => {};
  const tile = (p: Pick, name: string, hint: string, svg: string) => {
    const b = h('button', { type: 'button', class: 'gallery-tile', 'data-kind': p.kind, 'aria-label': `${name}: ${hint}` }, h('span', { class: 'gallery-pic', 'aria-hidden': 'true' }), h('span', { class: 'gallery-name' }, name));
    (b.firstChild as HTMLElement).innerHTML = svg;
    b.addEventListener('click', () => {
      close();
      if (p.group === 'numbers') insertBlocks(e, { type: 'chart', attrs: newChartAttrs(p.kind) });
      else if (p.kind === 'mindmap') insertMindMap(e);
      else insertBlocks(e, { type: 'diagram', attrs: newDiagramAttrs(p.kind) });
    });
    return b;
  };
  const charts = CHART_KINDS.map((c) => tile({ group: 'numbers', kind: c.kind }, c.name, c.hint, renderChart(sampleChart(c.kind), ink, { desk }).svg));
  const words = [
    ...DIAGRAM_KINDS.map((d) => tile({ group: 'words', kind: d.kind }, d.name, d.hint, renderDiagram(sampleDiagram(d.kind), ink, { desk }).svg)),
    tile({ group: 'words', kind: 'mindmap' }, 'Mind map', 'Ideas around a centre, as many as you like', renderMindMap(sampleMindMap(), ink).svg)
  ];
  const group = (id: string, title: string, note: string, tiles: HTMLElement[]) => h('section', { class: 'gallery-group', id }, h('h3', {}, `${title} · ${tiles.length}`), h('p', { class: 'meta' }, note), h('div', { class: 'gallery-grid' }, ...tiles));
  const body = [
    group('gallery-numbers', 'From numbers', 'A small table of values. Every number is example data until you change it.', charts),
    group('gallery-words', 'From words', 'Labels only: timelines, steps, cycles, comparisons and mind maps.', words)
  ];
  close = openSheet({ title: 'Insert a chart or diagram', id: 'chart-gallery', body, actions: [{ label: 'Cancel', id: 'gallery-cancel' }] });
  const first = document.querySelector<HTMLElement>(`#gallery-${focus} .gallery-tile`);
  if (focus === 'words') document.getElementById('gallery-words')?.scrollIntoView({ block: 'start' });
  first?.focus({ preventScroll: focus === 'numbers' });
}
