import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { h } from '../lib/h';
import { DIAGRAM_KINDS, diagramKindName, ITEM_WORDS, readDiagram, renderDiagram, sampleDiagram, treeLevels, type DiagramData, type DiagramItem, type DiagramKind } from '../lib/diagrams';
import { deskColours, screenInk } from '../lib/svg-ink';
import { colourSelect, onInkChange, palettePicker, panelBtn, reducedMotion } from './figure-kit';

/**
 * Diagrams "from words" (0.13): { type: 'diagram', attrs: { kind, title, items, heads, note, palette } }.
 * Searchable (every word), not markable. An older app opens a section holding one read-only, untouched.
 */
const ATTRS = ['kind', 'title', 'items', 'heads', 'note', 'palette'] as const;
export const newDiagramAttrs = (kind: DiagramKind) => sampleDiagram(kind);

const blank = (level = 0): DiagramItem => ({ text: '', detail: '', color: null, level, cells: [] });

function diagramView({ node, getPos, editor }: { node: PMNode; getPos: (() => number | undefined) | boolean; editor: Editor }) {
  let current = node;
  let working: DiagramData | null = null;
  let drawn = '';
  let first = true;
  const fig = h('figure', { class: 'diagram-block' });
  const titleEl = h('strong', { class: 'chart-title diagram-title' });
  const editBtn = h('button', { type: 'button', class: 'diagram-edit' }, 'Edit diagram');
  const head = h('div', { class: 'chart-head' }, h('div', { class: 'chart-titles' }, titleEl), editBtn);
  const canvas = h('div', { class: 'chart-canvas diagram-canvas' });
  const panel = h('div', { class: 'chart-panel diagram-panel', hidden: true });
  fig.append(head, canvas, panel);
  const data = () => working ?? readDiagram(current.attrs);

  const draw = (force = false) => {
    const d = data();
    const key = JSON.stringify([d, document.documentElement.dataset.theme ?? '', getComputedStyle(fig).getPropertyValue('--subj')]);
    if (!force && key === drawn) return;
    drawn = key;
    fig.dataset.kind = d.kind;
    titleEl.textContent = d.title || diagramKindName(d.kind);
    canvas.innerHTML = renderDiagram(d, screenInk(fig), { animate: first && !reducedMotion(), desk: deskColours() }).svg;
    first = false;
  };
  const commit = (d: DiagramData) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos === undefined) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...Object.fromEntries(ATTRS.map((k) => [k, structuredClone(d[k])])) }));
  };

  const openPanel = () => {
    working = structuredClone(readDiagram(current.attrs));
    const d = working;
    const live = () => draw();
    const input = (value: string, label: string, set: (v: string) => void, placeholder = '', multi = false) => {
      const i = multi ? h('textarea', { rows: 2, placeholder, 'aria-label': label }) : h('input', { placeholder, 'aria-label': label });
      i.value = value;
      i.addEventListener('input', () => {
        set(i.value);
        live();
      });
      return i;
    };
    const render = (focus?: number) => {
      panel.replaceChildren();
      const words = ITEM_WORDS[d.kind];
      const kind = h('select', { 'aria-label': 'Diagram type' });
      for (const k of DIAGRAM_KINDS) kind.append(h('option', { value: k.kind }, k.name));
      kind.value = d.kind;
      kind.addEventListener('change', () => {
        d.kind = kind.value as DiagramKind;
        if (d.kind === 'compare' && !d.heads.length) d.heads = ['A', 'B'];
        render();
        live();
      });
      panel.append(h('div', { class: 'chart-row' }, input(d.title, 'Diagram title', (v) => (d.title = v), 'Title')));
      const row2 = h('div', { class: 'chart-row2' }, h('label', { class: 'fig-field' }, h('span', {}, 'Type'), kind));
      if (d.kind === 'venn' || d.kind === 'cycle') row2.append(h('label', { class: 'fig-field grow' }, h('span', {}, d.kind === 'venn' ? 'Shared by all' : 'In the middle'), input(d.note, d.kind === 'venn' ? 'Shared by all' : 'In the middle', (v) => (d.note = v))));
      panel.append(row2, h('div', { class: 'chart-row3' }, palettePicker(fig, d.palette, (p) => ((d.palette = p), live()))));
      if (d.kind === 'compare') {
        const heads = h('div', { class: 'dg-heads' }, h('span', { class: 'fig-label' }, 'Columns'));
        d.heads.forEach((t, j) => heads.append(input(t, `Column ${j + 1} heading`, (v) => (d.heads[j] = v))));
        heads.append(
          panelBtn('Add column', () => {
            if (d.heads.length < 4) d.heads.push(`Column ${d.heads.length + 1}`), render(), live();
          }),
          panelBtn('Remove last column', () => {
            if (d.heads.length > 1) d.heads.pop(), d.items.forEach((r) => r.cells.splice(d.heads.length)), render(), live();
          })
        );
        panel.append(heads);
      }
      const list = h('ol', { class: 'dg-items', 'aria-label': `${words[0]}s` });
      const levels = d.kind === 'tree' ? treeLevels(d.items) : [];
      const cap = d.kind === 'venn' ? 3 : d.kind === 'matrix' ? 4 : 40;
      d.items.forEach((it, i) => {
        const move = (to: number) => {
          if (to < 0 || to >= d.items.length) return;
          const [x] = d.items.splice(i, 1);
          d.items.splice(to, 0, x);
          render(to);
          live();
        };
        const fields = h('div', { class: 'dg-fields' });
        if (d.kind === 'tree') fields.style.paddingLeft = `${levels[i] * 22}px`;
        fields.append(input(it.text, `${words[0]} ${i + 1}: ${words[1]}`, (v) => (it.text = v), words[1]));
        if (d.kind === 'compare') d.heads.forEach((hd, j) => fields.append(input(it.cells[j] ?? '', `${words[0]} ${i + 1}: ${hd || 'column ' + (j + 1)}`, (v) => (it.cells[j] = v), hd)));
        else fields.append(input(it.detail, `${words[0]} ${i + 1}: ${words[2]}`, (v) => (it.detail = v), words[2], d.kind === 'venn' || d.kind === 'matrix'));
        const tools = h('div', { class: 'dg-tools' });
        if (d.kind === 'tree' && i > 0)
          tools.append(
            panelBtn('←', () => ((it.level = Math.max(1, levels[i] - 1)), render(i), live()), '', `Move ${words[0].toLowerCase()} ${i + 1} out a level`),
            panelBtn('→', () => ((it.level = levels[i] + 1), render(i), live()), '', `Move ${words[0].toLowerCase()} ${i + 1} in a level`)
          );
        tools.append(
          colourSelect(it.color, `${words[0]} ${i + 1} colour`, (k) => ((it.color = k), live())),
          panelBtn('↑', () => move(i - 1), '', `Move ${words[0].toLowerCase()} ${i + 1} up`),
          panelBtn('↓', () => move(i + 1), '', `Move ${words[0].toLowerCase()} ${i + 1} down`),
          panelBtn('✕', () => {
            if (d.items.length > 1) d.items.splice(i, 1), render(Math.min(i, d.items.length - 1)), live();
          }, 'danger-quiet', `Delete ${words[0].toLowerCase()} ${i + 1}`)
        );
        list.append(h('li', {}, fields, tools));
      });
      panel.append(list);
      const actions = h(
        'div',
        { class: 'chart-actions' },
        panelBtn(`Add ${words[0].toLowerCase()}`, () => {
          if (d.items.length >= cap) return;
          const last = d.items[d.items.length - 1];
          d.items.push(blank(d.kind === 'tree' ? Math.max(1, last ? treeLevels(d.items)[d.items.length - 1] : 1) : 0));
          render(d.items.length - 1);
          live();
        }),
        panelBtn('Cancel', () => close(false)),
        panelBtn('Done', () => close(true), 'primary')
      );
      panel.append(actions);
      if (focus !== undefined) (list.children[focus]?.querySelector('input, textarea') as HTMLElement | null)?.focus({ preventScroll: true });
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
      return !!t && (panel.contains(t) || t === editBtn);
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      offInk();
    }
  };
}

export const DiagramNode = Node.create({
  name: 'diagram',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'timeline' },
      title: { default: '' },
      items: { default: [] },
      heads: { default: [] },
      note: { default: '' },
      palette: { default: 'desk' }
    };
  },
  parseHTML: () => [
    {
      tag: 'figure[data-diagram]',
      getAttrs: (e) => {
        try {
          return JSON.parse((e as HTMLElement).dataset.diagram || '{}');
        } catch {
          return false;
        }
      }
    }
  ],
  renderHTML: ({ node, HTMLAttributes }) => ['figure', mergeAttributes(HTMLAttributes, { 'data-diagram': JSON.stringify(node.attrs) })],
  addNodeView() {
    return diagramView;
  }
});
