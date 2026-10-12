import { Node, mergeAttributes } from '@tiptap/core';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  Tooltip,
  type ChartConfiguration
} from 'chart.js';

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  PieController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Legend,
  Tooltip
);

export type ChartKind = 'bar' | 'line' | 'pie';
export interface ChartSeries {
  name: string;
  values: number[];
}
export interface ChartData {
  kind: ChartKind;
  title: string;
  labels: string[];
  series: ChartSeries[];
}

export const DEFAULT_CHART: ChartData = {
  kind: 'bar',
  title: 'Untitled chart',
  labels: ['Item 1', 'Item 2', 'Item 3'],
  series: [{ name: 'Value', values: [3, 5, 2] }]
};

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function chartPalette(): string[] {
  return [1, 2, 3, 4, 5, 6].map((i) => cssVar(`--chart-${i}`) || '#2d5b4e');
}

/** Chart.js config shared by the editor view and the PDF export. */
export const PRINT_PALETTE = ['#2d5b4e', '#c27c2c', '#4f6fa8', '#a3475a', '#6b8f3a', '#7a5ea8'];

export function chartConfig(
  d: ChartData,
  opts: { animate?: boolean; text?: string; grid?: string; palette?: string[]; surface?: string } = {}
): ChartConfiguration {
  const colors = opts.palette ?? chartPalette();
  const text = opts.text ?? cssVar('--fg');
  const grid = opts.grid ?? cssVar('--line');
  const pie = d.kind === 'pie';
  const series = pie ? d.series.slice(0, 1) : d.series;
  return {
    type: d.kind,
    data: {
      labels: d.labels,
      datasets: series.map((s, i) => ({
        label: s.name,
        data: d.labels.map((_, j) => Number(s.values[j]) || 0),
        backgroundColor: pie ? d.labels.map((_, j) => colors[j % colors.length]) : colors[i % colors.length],
        borderColor: pie ? opts.surface ?? (cssVar('--surface') || '#fff') : colors[i % colors.length],
        borderWidth: pie ? 2 : d.kind === 'line' ? 2.5 : 0,
        borderRadius: d.kind === 'bar' ? 4 : 0,
        pointRadius: d.kind === 'line' ? 4 : 0,
        tension: 0
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: opts.animate === false ? false : { duration: 250 },
      color: text,
      plugins: {
        legend: { display: pie || series.length > 1, labels: { color: text, boxWidth: 14 } },
        tooltip: { enabled: true }
      },
      scales: pie
        ? {}
        : {
            x: { ticks: { color: text }, grid: { display: false }, border: { color: grid } },
            y: { beginAtZero: true, ticks: { color: text }, grid: { color: grid }, border: { display: false } }
          }
    }
  } as ChartConfiguration;
}

export function readChart(a: Partial<ChartData>): ChartData {
  return {
    kind: (a.kind as ChartKind) ?? 'bar',
    title: a.title ?? '',
    labels: Array.isArray(a.labels) ? [...a.labels] : [...DEFAULT_CHART.labels],
    series: Array.isArray(a.series) ? a.series.map((s) => ({ name: s.name, values: [...s.values] })) : structuredClone(DEFAULT_CHART.series)
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const ChartBlock = Node.create({
  name: 'chartBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: DEFAULT_CHART.kind },
      title: { default: DEFAULT_CHART.title },
      labels: { default: DEFAULT_CHART.labels },
      series: { default: DEFAULT_CHART.series }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-chart]',
        getAttrs: (e) => {
          try {
            return JSON.parse((e as HTMLElement).dataset.chart || '{}');
          } catch {
            return false;
          }
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-chart': JSON.stringify(node.attrs) })];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      let chart: Chart | null = null;
      const fig = el('figure', 'chart-block');
      const head = el('div', 'chart-head');
      const titleEl = el('strong', 'chart-title');
      const editBtn = el('button', 'chart-edit', 'Edit data');
      editBtn.type = 'button';
      head.append(titleEl, editBtn);
      const wrap = el('div', 'chart-canvas');
      const canvas = el('canvas');
      canvas.setAttribute('role', 'img');
      wrap.append(canvas);
      const panel = el('div', 'chart-panel');
      panel.hidden = true;
      fig.append(head, wrap, panel);

      const draw = (d: ChartData) => {
        titleEl.textContent = d.title || 'Chart';
        canvas.setAttribute('aria-label', `${d.kind} chart: ${d.title}`);
        chart?.destroy();
        chart = new Chart(canvas, chartConfig(d));
      };

      const commit = (d: ChartData) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...d }));
      };

      // ---------- inline data editor ----------
      const openPanel = () => {
        const d = readChart(current.attrs);
        const render = () => {
          panel.replaceChildren();
          const row1 = el('div', 'chart-row');
          const kind = el('select');
          kind.setAttribute('aria-label', 'Chart type');
          for (const [v, t] of [
            ['bar', 'Bar'],
            ['line', 'Line'],
            ['pie', 'Pie']
          ]) {
            const o = el('option', undefined, t);
            o.value = v;
            kind.append(o);
          }
          kind.value = d.kind;
          kind.addEventListener('change', () => {
            d.kind = kind.value as ChartKind;
            render();
          });
          const title = el('input');
          title.value = d.title;
          title.placeholder = 'Chart title';
          title.setAttribute('aria-label', 'Chart title');
          title.addEventListener('input', () => (d.title = title.value));
          row1.append(kind, title);

          const gridWrap = el('div', 'chart-grid-wrap');
          const table = el('table', 'chart-grid');
          const hr = el('tr');
          hr.append(el('th', undefined, 'Label'));
          d.series.forEach((s, si) => {
            const th = el('th');
            const inp = el('input');
            inp.value = s.name;
            inp.setAttribute('aria-label', `Series ${si + 1} name`);
            inp.addEventListener('input', () => (s.name = inp.value));
            th.append(inp);
            hr.append(th);
          });
          table.append(hr);
          d.labels.forEach((label, li) => {
            const tr = el('tr');
            const td = el('td');
            const inp = el('input');
            inp.value = label;
            inp.setAttribute('aria-label', `Row ${li + 1} label`);
            inp.addEventListener('input', () => (d.labels[li] = inp.value));
            td.append(inp);
            tr.append(td);
            d.series.forEach((s, si) => {
              const c = el('td');
              const v = el('input');
              v.type = 'number';
              v.inputMode = 'decimal';
              v.step = 'any';
              v.value = String(s.values[li] ?? 0);
              v.setAttribute('aria-label', `${label || 'Row ' + (li + 1)}, ${s.name || 'series ' + (si + 1)}`);
              v.addEventListener('input', () => (s.values[li] = Number(v.value) || 0));
              c.append(v);
              tr.append(c);
            });
            table.append(tr);
          });
          gridWrap.append(table);

          const btn = (t: string, fn: () => void, cls = '') => {
            const b = el('button', cls, t);
            b.type = 'button';
            b.addEventListener('click', fn);
            return b;
          };
          const actions = el('div', 'chart-actions');
          actions.append(
            btn('Add row', () => {
              d.labels.push(`Item ${d.labels.length + 1}`);
              d.series.forEach((s) => s.values.push(0));
              render();
            }),
            btn('Remove last row', () => {
              if (d.labels.length > 1) {
                d.labels.pop();
                d.series.forEach((s) => s.values.pop());
                render();
              }
            }),
            btn('Add series', () => {
              d.series.push({ name: `Series ${d.series.length + 1}`, values: d.labels.map(() => 0) });
              render();
            }),
            btn('Remove last series', () => {
              if (d.series.length > 1) {
                d.series.pop();
                render();
              }
            }),
            btn('Cancel', () => {
              panel.hidden = true;
              editBtn.hidden = false;
            }),
            btn(
              'Done',
              () => {
                panel.hidden = true;
                editBtn.hidden = false;
                commit(d);
              },
              'primary'
            )
          );
          const note = d.kind === 'pie' && d.series.length > 1 ? el('p', 'chart-note', 'A pie chart shows only the first series.') : null;
          panel.append(row1, gridWrap, ...(note ? [note] : []), actions);
        };
        render();
        panel.hidden = false;
        editBtn.hidden = true;
      };
      editBtn.addEventListener('click', openPanel);

      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onTheme = () => draw(readChart(current.attrs));
      media.addEventListener('change', onTheme);
      window.addEventListener('themechange', onTheme);
      // Draw after the node is in the document so the canvas has a size.
      requestAnimationFrame(() => draw(readChart(current.attrs)));

      return {
        dom: fig,
        update(n) {
          if (n.type.name !== 'chartBlock') return false;
          current = n;
          draw(readChart(n.attrs));
          return true;
        },
        selectNode() {
          fig.classList.add('is-selected');
        },
        deselectNode() {
          fig.classList.remove('is-selected');
        },
        stopEvent(e) {
          const t = e.target as HTMLElement | null;
          return !!t && (panel.contains(t) || t === editBtn);
        },
        ignoreMutation() {
          return true;
        },
        destroy() {
          media.removeEventListener('change', onTheme);
          window.removeEventListener('themechange', onTheme);
          chart?.destroy();
        }
      };
    };
  }
});
