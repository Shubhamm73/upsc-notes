import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { h } from '../lib/h';
import { CHART_KINDS, chartKindName, isXY, oneSeries, readChartData, renderChart, sampleChart, type ChartData, type ChartKind } from '../lib/charts';
import { deskColours, screenInk } from '../lib/svg-ink';
import { onInkChange, palettePicker, panelBtn, reducedMotion, segmented, tipper } from './figure-kit';

/**
 * Charts. Since 0.13 every chart is a `chart` node: twelve kinds, a palette, a subtitle and a source,
 * drawn as SVG (the same picture prints in the PDF). Charts from 0.12 stay `chartBlock` nodes and open
 * with the new look; the first edit turns one into a `chart` (one undo step). An older app opens a
 * section holding a `chart` read-only, untouched.
 */
export type { ChartData };

const CHART_ATTRS = ['kind', 'title', 'subtitle', 'source', 'labels', 'series', 'palette', 'values', 'unit'] as const;

/** Starting attributes of a new chart of a kind (the gallery inserts these). */
export function newChartAttrs(kind: ChartKind) {
  return { ...sampleChart(kind), align: 'center', width: 100 };
}

function chartView(legacy: boolean) {
  return ({ node, getPos, editor }: { node: PMNode; getPos: (() => number | undefined) | boolean; editor: Editor }) => {
    let current = node;
    let working: ChartData | null = null;
    const hidden = new Set<number>();
    let drawn = '';
    let first = true;
    const fig = h('figure', { class: 'chart-block' });
    const titleEl = h('strong', { class: 'chart-title' });
    const subEl = h('span', { class: 'chart-sub' });
    const editBtn = h('button', { type: 'button', class: 'chart-edit' }, 'Edit data');
    const head = h('div', { class: 'chart-head' }, h('div', { class: 'chart-titles' }, titleEl, subEl), editBtn);
    const canvas = h('div', { class: 'chart-canvas' });
    const legendEl = h('div', { class: 'chart-legend', role: 'group', 'aria-label': 'Series: tap to hide or show' });
    const foot = h('div', { class: 'chart-foot' });
    const panel = h('div', { class: 'chart-panel', hidden: true });
    fig.append(head, canvas, legendEl, foot, panel);
    const tips = tipper(fig, canvas);

    const place = (n: PMNode) => {
      const align = ['left', 'right'].includes(n.attrs.align) ? n.attrs.align : 'center';
      fig.dataset.align = align;
      fig.style.width = align === 'center' ? '' : `${Math.min(100, Math.max(20, Number(n.attrs.width) || 50))}%`;
    };
    place(node);
    const data = () => working ?? readChartData(current.attrs, legacy);

    const draw = (force = false) => {
      const d = data();
      const key = JSON.stringify([d, [...hidden], document.documentElement.dataset.ink ?? '', getComputedStyle(fig).getPropertyValue('--subj')]);
      if (!force && key === drawn) return;
      drawn = key;
      fig.dataset.kind = d.kind;
      titleEl.textContent = d.title || chartKindName(d.kind);
      subEl.textContent = d.subtitle;
      subEl.hidden = !d.subtitle;
      const out = renderChart(d, screenInk(fig), { hidden, animate: first && !reducedMotion(), desk: deskColours() });
      first = false;
      canvas.innerHTML = out.svg;
      tips.hide();
      // pie and donut name their slices inside the picture; scatter and polar need no chips
      const chips = d.kind === 'pie' || d.kind === 'donut' || d.kind === 'polar' || isXY(d.kind) || out.legend.length < 2 ? [] : out.legend;
      legendEl.replaceChildren(
        ...chips.map((c, i) => {
          const b = h('button', { type: 'button', class: 'chart-chip', 'aria-pressed': String(!hidden.has(i)) }, h('i', { style: `background:${c.colour}`, 'aria-hidden': 'true' }), c.name || `Series ${i + 1}`);
          b.addEventListener('click', () => {
            if (hidden.has(i)) hidden.delete(i);
            else if (hidden.size < chips.length - 1) hidden.add(i);
            draw();
          });
          return b;
        })
      );
      legendEl.hidden = !chips.length;
      foot.textContent = d.source ? (/^source\b/i.test(d.source) ? d.source : `Source: ${d.source}`) : '';
      foot.hidden = !d.source;
    };

    const commit = (d: ChartData) => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (pos === undefined) return;
      const attrs = { ...current.attrs, ...Object.fromEntries(CHART_ATTRS.map((k) => [k, structuredClone(d[k])])) };
      const tr = editor.state.tr;
      if (current.type.name === 'chartBlock') {
        // the first edit turns a 0.12 chart into a 0.13 one, in place, in one undo step
        tr.replaceWith(pos, pos + current.nodeSize, editor.schema.nodes.chart.create({ ...attrs, align: current.attrs.align, width: current.attrs.width }));
        tr.setSelection(NodeSelection.create(tr.doc, pos));
      } else tr.setNodeMarkup(pos, undefined, attrs);
      editor.view.dispatch(tr);
    };

    // ---------- inline data editor, with the chart redrawn as he types ----------
    const openPanel = () => {
      working = structuredClone(readChartData(current.attrs, legacy));
      const d = working;
      const live = () => draw();
      const input = (value: string, label: string, set: (v: string) => void, placeholder = '') => {
        const i = h('input', { value, placeholder, 'aria-label': label });
        i.value = value;
        i.addEventListener('input', () => {
          set(i.value);
          live();
        });
        return i;
      };
      const render = () => {
        panel.replaceChildren();
        const row1 = h('div', { class: 'chart-row' }, input(d.title, 'Chart title', (v) => (d.title = v), 'Chart title'));
        const kind = h('select', { 'aria-label': 'Chart type' });
        for (const k of CHART_KINDS) kind.append(h('option', { value: k.kind }, k.name));
        kind.value = d.kind;
        kind.addEventListener('change', () => {
          d.kind = kind.value as ChartKind;
          if (isXY(d.kind)) while (d.series.length < (d.kind === 'bubble' ? 3 : 2)) d.series.push({ name: d.series.length === 1 ? 'Y' : 'Size', values: d.labels.map(() => 1) });
          render();
          live();
        });
        const row2 = h(
          'div',
          { class: 'chart-row2' },
          h('label', { class: 'fig-field' }, h('span', {}, 'Type'), kind),
          h('label', { class: 'fig-field grow' }, h('span', {}, 'Subtitle'), input(d.subtitle, 'Subtitle', (v) => (d.subtitle = v), 'What the numbers are')),
          h('label', { class: 'fig-field grow' }, h('span', {}, 'Source'), input(d.source, 'Source', (v) => (d.source = v), 'e.g. Economic Survey 2024')),
          h('label', { class: 'fig-field small' }, h('span', {}, 'Unit'), input(d.unit, 'Unit', (v) => (d.unit = v), '%'))
        );
        const row3 = h(
          'div',
          { class: 'chart-row3' },
          palettePicker(fig, d.palette, (p) => {
            d.palette = p;
            live();
          }),
          segmented('Numbers', [
            { id: 'all', label: 'Numbers on chart' },
            { id: 'tap', label: 'Numbers on tap' }
          ], d.values, (v) => {
            d.values = v;
            live();
          })
        );

        const xy = isXY(d.kind);
        const table = h('table', { class: 'chart-grid' });
        const hr = h('tr', {}, h('th', {}, xy ? 'Point' : 'Label'));
        d.series.forEach((s, si) => {
          const label = xy ? ['Across (x) name', 'Up (y) name', 'Size name'][si] ?? `Series ${si + 1} name` : `Series ${si + 1} name`;
          hr.append(h('th', {}, input(s.name, label, (v) => (s.name = v))));
        });
        table.append(hr);
        d.labels.forEach((label, li) => {
          const tr = h('tr', {}, h('td', {}, input(label, `Row ${li + 1} label`, (v) => (d.labels[li] = v))));
          d.series.forEach((s, si) => {
            const v = h('input', { type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': `${label || 'Row ' + (li + 1)}, ${s.name || 'series ' + (si + 1)}` });
            v.value = String(s.values[li] ?? 0);
            v.addEventListener('input', () => {
              s.values[li] = Number(v.value) || 0;
              live();
            });
            tr.append(h('td', {}, v));
          });
          table.append(tr);
        });
        const note = oneSeries(d.kind) && d.series.length > 1 ? h('p', { class: 'chart-note' }, `A ${chartKindName(d.kind).toLowerCase()} chart shows only the first series.`) : d.kind === 'combo' ? h('p', { class: 'chart-note' }, 'The first series is drawn as bars, the others as lines with their own scale on the right.') : null;
        const actions = h(
          'div',
          { class: 'chart-actions' },
          panelBtn('Add row', () => {
            d.labels.push(xy ? `Point ${d.labels.length + 1}` : `Item ${d.labels.length + 1}`);
            d.series.forEach((s) => s.values.push(0));
            render();
            live();
          }),
          panelBtn('Remove last row', () => {
            if (d.labels.length > 1) {
              d.labels.pop();
              d.series.forEach((s) => s.values.pop());
              render();
              live();
            }
          }),
          ...(xy
            ? []
            : [
                panelBtn('Add series', () => {
                  d.series.push({ name: `Series ${d.series.length + 1}`, values: d.labels.map(() => 0) });
                  render();
                  live();
                }),
                panelBtn('Remove last series', () => {
                  if (d.series.length > 1) {
                    d.series.pop();
                    render();
                    live();
                  }
                })
              ]),
          panelBtn('Cancel', () => close(false)),
          panelBtn('Done', () => close(true), 'primary')
        );
        panel.append(row1, row2, row3, h('div', { class: 'chart-grid-wrap' }, table), ...(note ? [note] : []), actions);
      };
      render();
      panel.hidden = false;
      editBtn.hidden = true;
      fig.classList.add('is-editing');
    };
    const close = (save: boolean) => {
      const d = working;
      working = null;
      panel.hidden = true;
      editBtn.hidden = false;
      fig.classList.remove('is-editing');
      if (save && d) commit(d);
      else draw();
    };
    editBtn.addEventListener('click', openPanel);

    const offInk = onInkChange(() => draw(true));
    requestAnimationFrame(() => draw());

    return {
      dom: fig,
      update(n: PMNode) {
        if (n.type !== current.type) return false;
        current = n;
        place(n);
        draw();
        return true;
      },
      selectNode() {
        fig.classList.add('is-selected');
      },
      deselectNode() {
        fig.classList.remove('is-selected');
      },
      stopEvent(e: Event) {
        const t = e.target as HTMLElement | null;
        return !!t && (panel.contains(t) || t === editBtn || legendEl.contains(t));
      },
      ignoreMutation() {
        return true;
      },
      destroy() {
        offInk();
      }
    };
  };
}

const parseChart = (e: HTMLElement | string) => {
  try {
    return JSON.parse((e as HTMLElement).dataset.chart || '{}');
  } catch {
    return false;
  }
};

/** 0.13 charts. */
export const ChartNode = Node.create({
  name: 'chart',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    const d = sampleChart('column');
    return {
      kind: { default: d.kind },
      title: { default: '' },
      subtitle: { default: '' },
      source: { default: '' },
      labels: { default: d.labels },
      series: { default: d.series },
      palette: { default: 'desk' },
      values: { default: 'all' },
      unit: { default: '' },
      align: { default: 'center', rendered: false },
      width: { default: 100, rendered: false }
    };
  },
  parseHTML: () => [{ tag: 'figure[data-chart2]', getAttrs: (e) => parseChart(e) }],
  renderHTML: ({ node, HTMLAttributes }) => ['figure', mergeAttributes(HTMLAttributes, { 'data-chart2': '', 'data-chart': JSON.stringify(node.attrs) })],
  addNodeView() {
    return chartView(false);
  }
});

/** Charts written by 0.10 – 0.12 (bar, line, pie). Shown with the 0.13 look; saved unchanged until edited. */
export const ChartBlock = Node.create({
  name: 'chartBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'bar' },
      title: { default: 'Untitled chart' },
      labels: { default: ['Item 1', 'Item 2', 'Item 3'] },
      series: { default: [{ name: 'Value', values: [3, 5, 2] }] },
      // 0.11: left / right float the chart with text beside it, like a picture; width in % of the column.
      align: { default: 'center', rendered: false },
      width: { default: 100, rendered: false }
    };
  },
  parseHTML: () => [{ tag: 'figure[data-chart]:not([data-chart2])', getAttrs: (e) => parseChart(e) }],
  renderHTML: ({ node, HTMLAttributes }) => ['figure', mergeAttributes(HTMLAttributes, { 'data-chart': JSON.stringify(node.attrs) })],
  addNodeView() {
    return chartView(true);
  }
});
