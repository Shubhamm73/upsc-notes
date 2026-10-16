import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { h } from '../lib/h';
import { readMindMap, renderMindMap, sampleMindMap, Tree, type MindMap } from '../lib/mindmap';
import { screenInk } from '../lib/svg-ink';
import { onInkChange, placeFigure, reducedMotion, sizeGrip } from './figure-kit';
import { openMindMapEditor } from './mindmap-editor';

/**
 * Mind maps (0.13): { type: 'mindMap', attrs: { layout, nodes } }. The note shows the whole map as a picture;
 * "Edit mind map" opens the full-screen editor. Every label is searchable; a marked idea is a key line.
 * An older app opens a section holding one read-only, untouched.
 */
export const newMindMapAttrs = (): MindMap => sampleMindMap();

function mindMapView({ node, getPos, editor }: { node: PMNode; getPos: (() => number | undefined) | boolean; editor: Editor }) {
  let current = node;
  let drawn = '';
  let first = true;
  const fig = h('figure', { class: 'mindmap-block' });
  const titleEl = h('strong', { class: 'chart-title mindmap-title' });
  const countEl = h('span', { class: 'chart-sub mindmap-count' });
  const editBtn = h('button', { type: 'button', class: 'mindmap-edit' }, 'Edit mind map');
  const head = h('div', { class: 'chart-head' }, h('div', { class: 'chart-titles' }, titleEl, countEl), editBtn);
  const canvas = h('div', { class: 'chart-canvas mindmap-canvas' });
  fig.append(head, canvas);
  // 0.16: any width, left / right with text beside it, like a picture
  const place = (n: PMNode) => placeFigure(fig, n.attrs.align, n.attrs.width);
  place(node);
  const grip = sizeGrip(fig, 'Drag to resize mind map', () => current.attrs, (pct) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos !== undefined && pct !== current.attrs.width) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: pct }));
    else place(current);
  });
  fig.append(grip.handle, grip.tag);
  place(node);

  const draw = (force = false) => {
    const m = readMindMap(current.attrs);
    const key = JSON.stringify([m, document.documentElement.dataset.ink ?? '', getComputedStyle(fig).getPropertyValue('--subj')]);
    if (!force && key === drawn) return;
    drawn = key;
    const t = new Tree(m);
    const levels = Math.max(...m.nodes.map((n) => t.depth(n))) + 1;
    titleEl.textContent = m.nodes[0]?.text.trim() || 'Mind map';
    countEl.textContent = `${m.nodes.length} ${m.nodes.length === 1 ? 'idea' : 'ideas'} · ${levels} ${levels === 1 ? 'level' : 'levels'}`;
    canvas.innerHTML = renderMindMap(m, screenInk(fig), { animate: first && !reducedMotion() }).svg;
    first = false;
  };
  // The editor may save more than once (app hidden, then Done): only the first save is an undo step,
  // so one Undo in the note takes back the whole editing session.
  let sessionSaved = false;
  const save = (m: MindMap) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos === undefined || editor.isDestroyed) return;
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, layout: m.layout, nodes: m.nodes });
    if (sessionSaved) tr.setMeta('addToHistory', false);
    sessionSaved = true;
    editor.view.dispatch(tr);
  };
  const open = () => {
    if (!editor.isEditable) return;
    sessionSaved = false;
    openMindMapEditor({ map: readMindMap(current.attrs), host: fig, onSave: save, onClose: () => editBtn.focus({ preventScroll: true }) });
  };
  editBtn.addEventListener('click', open);
  canvas.addEventListener('dblclick', open);
  fig.addEventListener('open-mindmap', open);
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
      return e.target === editBtn || e.target === grip.handle;
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      offInk();
    }
  };
}

export const MindMapNode = Node.create({
  name: 'mindMap',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      layout: { default: 'radial' },
      nodes: { default: [] },
      // 0.16: left / right float it with text beside it; width in % of the column
      align: { default: 'center', rendered: false },
      width: { default: 100, rendered: false }
    };
  },
  parseHTML: () => [
    {
      tag: 'figure[data-mindmap]',
      getAttrs: (e) => {
        try {
          return JSON.parse((e as HTMLElement).dataset.mindmap || '{}');
        } catch {
          return false;
        }
      }
    }
  ],
  renderHTML: ({ node, HTMLAttributes }) => ['figure', mergeAttributes(HTMLAttributes, { 'data-mindmap': JSON.stringify(node.attrs) })],
  addNodeView() {
    return mindMapView;
  }
});
