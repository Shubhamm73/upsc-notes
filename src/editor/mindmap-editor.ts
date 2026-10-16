import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { COLOURS } from '../lib/looks';
import { BRANCH_KEYS, mindMapBody, newId, SHAPES, Tree, type MindMap, type MMNode, type MMShape, type Pos } from '../lib/mindmap';
import { screenInk } from '../lib/svg-ink';

/**
 * Full-screen mind-map editor (0.13). Tap a node to select it, drag it to move it (what hangs under it
 * moves too), long-press to fold or unfold, double-tap to edit its label. One finger on empty space or two
 * fingers pan, pinch zooms (0.3× – 3×). Keys: Tab child, Enter sibling, F2 label, Delete, arrows, Ctrl+Z.
 * Done, Android back, leaving the note or the app going to the background save it. One note undo step a session.
 */
const SVGNS = 'http://www.w3.org/2000/svg';
const MIN_K = 0.3;
const MAX_K = 3;
const LONG_MS = 500;

export function openMindMapEditor(o: { map: MindMap; host: Element; onSave: (m: MindMap) => void; onClose?: () => void }) {
  const m: MindMap = structuredClone(o.map);
  let saved = JSON.stringify(m);
  let sel: string = m.nodes[0].id;
  let pos: Pos = new Map();
  let k = 1;
  let tx = 0;
  let ty = 0;
  const past: string[] = [];
  const future: string[] = [];
  const ink = () => screenInk(o.host);
  const tree = () => new Tree(m);
  const byId = (id: string) => m.nodes.find((n) => n.id === id);
  const snapshot = () => {
    past.push(JSON.stringify(m));
    if (past.length > 200) past.shift();
    future.length = 0;
  };
  const restore = (json: string) => {
    const x = JSON.parse(json) as MindMap;
    m.layout = x.layout;
    m.nodes = x.nodes;
    if (!byId(sel)) sel = m.nodes[0].id;
    render();
  };

  // ---------- chrome ----------
  const tb = (label: string, fn: () => void, opts: { id?: string; icon?: string; aria?: string; cls?: string } = {}) => {
    const b = h('button', { type: 'button', id: opts.id, class: opts.cls ?? '', 'aria-label': opts.aria }, ...(opts.icon ? [icon(opts.icon, 20)] : []), label);
    b.addEventListener('click', fn);
    return b;
  };
  const layoutSeg = h('div', { class: 'fig-seg', role: 'radiogroup', 'aria-label': 'Layout' });
  for (const [id, label] of [
    ['radial', 'Radial'],
    ['tree', 'Tree']
  ] as const) {
    const b = h('button', { type: 'button', role: 'radio', 'data-v': id, 'aria-checked': String(m.layout === id) }, label);
    b.addEventListener('click', () => {
      if (m.layout === id) return;
      snapshot();
      m.layout = id;
      m.nodes.forEach((n) => (n.pinned = false));
      render();
      fit();
    });
    layoutSeg.append(b);
  }
  const undoBtn = tb('', () => undo(), { icon: 'undo', aria: 'Undo', id: 'mm-undo' });
  const redoBtn = tb('', () => redo(), { icon: 'redo', aria: 'Redo', id: 'mm-redo' });
  const doneBtn = tb('Done', () => finish(), { id: 'mm-done', cls: 'primary' });
  const head = h('div', { class: 'mm-head' }, h('h2', {}, 'Mind map'), layoutSeg, tb('Tidy up', () => tidy(), { id: 'mm-tidy' }), undoBtn, redoBtn, doneBtn);

  const label = h('input', { id: 'mm-label', 'aria-label': 'Idea label', placeholder: 'Label', autocomplete: 'off' });
  const markBtn = tb('Mark', () => toggle('marked'), { id: 'mm-mark', icon: 'highlighter', aria: 'Mark as key line' });
  const foldBtn = tb('Fold', () => toggle('folded'), { id: 'mm-fold', icon: 'fold', aria: 'Fold branch' });
  const delBtn = tb('Delete', () => remove(), { id: 'mm-del', icon: 'trash', aria: 'Delete idea', cls: 'danger-quiet' });
  const bar = h('div', { class: 'mm-bar' }, tb('Child', () => addChild(), { id: 'mm-child', icon: 'plus', aria: 'Add child idea' }), tb('Sibling', () => addSibling(), { id: 'mm-sib', icon: 'plus', aria: 'Add sibling idea' }), label, markBtn, foldBtn, delBtn);

  const swatches = h('div', { class: 'mm-colours', role: 'radiogroup', 'aria-label': 'Branch colour' });
  const auto = h('button', { type: 'button', role: 'radio', class: 'sw auto', 'data-c': '', 'aria-label': 'Auto colour' }, 'A');
  swatches.append(auto, ...COLOURS.map((c) => h('button', { type: 'button', role: 'radio', class: 'sw', 'data-c': c.key, style: `--c:var(--sub-${c.key})`, 'aria-label': `${c.name} branch` })));
  swatches.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.sw');
    const n = byId(sel);
    if (!b || !n) return;
    snapshot();
    n.color = b.dataset.c || null;
    render();
  });
  const shapes = h('div', { class: 'fig-seg', role: 'radiogroup', 'aria-label': 'Shape' });
  for (const s of SHAPES) {
    const b = h('button', { type: 'button', role: 'radio', 'data-v': s.id }, s.label);
    b.addEventListener('click', () => {
      const n = byId(sel);
      if (!n || n.shape === s.id) return;
      snapshot();
      n.shape = s.id as MMShape;
      render();
    });
    shapes.append(b);
  }
  const bar2 = h('div', { class: 'mm-bar2' }, swatches, shapes);

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'mm-svg');
  const view = document.createElementNS(SVGNS, 'g');
  svg.append(view);
  const count = h('div', { class: 'mm-count', 'aria-live': 'polite' });
  const zoom = h('div', { class: 'mm-zoom' }, tb('−', () => zoomBy(1 / 1.25), { aria: 'Zoom out' }), tb('+', () => zoomBy(1.25), { aria: 'Zoom in' }), tb('Fit', () => fit(), { aria: 'Fit to screen' }));
  const area = h('div', { class: 'mm-canvas', tabindex: 0, role: 'application', 'aria-label': 'Mind map. Tab adds a child, Enter a sibling, F2 edits the label, arrows move between ideas.' });
  area.append(svg, count, zoom);
  const overlay = h('div', { class: 'mm-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Mind map editor' }, head, bar, bar2, area);
  document.body.append(overlay);
  document.body.classList.add('mm-open');

  // ---------- drawing ----------
  let raf = 0;
  const later = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()));
  };
  function render() {
    const out = mindMapBody(m, ink(), { selected: sel });
    pos = out.pos;
    view.innerHTML = out.body;
    applyView();
    const t = tree();
    const depth = Math.max(...m.nodes.map((n) => t.depth(n))) + 1;
    count.textContent = `${m.nodes.length} ${m.nodes.length === 1 ? 'idea' : 'ideas'} · ${depth} ${depth === 1 ? 'level' : 'levels'}`;
    const n = byId(sel)!;
    if (document.activeElement !== label) label.value = n.text;
    markBtn.setAttribute('aria-pressed', String(n.marked));
    const kids = t.childrenOf(n.id).length;
    foldBtn.disabled = !kids;
    foldBtn.setAttribute('aria-pressed', String(n.folded && !!kids));
    delBtn.disabled = n.parent === null;
    swatches.querySelectorAll<HTMLElement>('.sw').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.c || null) === n.color)));
    shapes.querySelectorAll<HTMLElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === n.shape)));
    layoutSeg.querySelectorAll<HTMLElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === m.layout)));
    undoBtn.disabled = !past.length;
    redoBtn.disabled = !future.length;
  }
  const applyView = () => view.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${k.toFixed(4)})`);
  function fit() {
    const r = area.getBoundingClientRect();
    const { box } = mindMapBody(m, ink());
    k = Math.max(MIN_K, Math.min(1.2, Math.min(r.width / box.w, r.height / box.h) * 0.94));
    tx = r.width / 2 - (box.x + box.w / 2) * k;
    ty = r.height / 2 - (box.y + box.h / 2) * k;
    applyView();
  }
  function zoomBy(f: number, cx?: number, cy?: number) {
    const r = area.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const nk = Math.max(MIN_K, Math.min(MAX_K, k * f));
    tx = px - ((px - tx) * nk) / k;
    ty = py - ((py - ty) * nk) / k;
    k = nk;
    applyView();
  }
  /** Keeps the selected node on screen. */
  function reveal() {
    const p = pos.get(sel);
    if (!p) return;
    const r = area.getBoundingClientRect();
    const x = p.x * k + tx;
    const y = p.y * k + ty;
    const pad = 80;
    if (x < pad) tx += pad - x;
    if (x > r.width - pad) tx -= x - (r.width - pad);
    if (y < pad) ty += pad - y;
    if (y > r.height - pad) ty -= y - (r.height - pad);
    applyView();
  }

  // ---------- edits ----------
  const select = (id: string) => {
    sel = id;
    render();
    reveal();
  };
  function addChild() {
    const s = byId(sel) ?? m.nodes[0];
    snapshot();
    s.folded = false;
    const t = tree();
    const d = t.depth(s);
    const n: MMNode = { id: newId(), text: 'New idea', parent: s.id, color: null, shape: d === 0 ? 'pill' : 'box', x: 0, y: 0, pinned: false, folded: false, marked: false };
    m.nodes.push(n);
    select(n.id);
    editLabel();
  }
  function addSibling() {
    const s = byId(sel);
    if (!s || s.parent === null) return addChild();
    snapshot();
    const n: MMNode = { id: newId(), text: 'New idea', parent: s.parent, color: null, shape: s.shape, x: 0, y: 0, pinned: false, folded: false, marked: false };
    m.nodes.splice(m.nodes.indexOf(s) + 1, 0, n);
    select(n.id);
    editLabel();
  }
  function remove() {
    const s = byId(sel);
    if (!s || s.parent === null) return;
    snapshot();
    const gone = new Set(tree().subtree(s.id).map((n) => n.id));
    m.nodes = m.nodes.filter((n) => !gone.has(n.id));
    select(s.parent);
  }
  function toggle(what: 'marked' | 'folded') {
    const s = byId(sel);
    if (!s) return;
    if (what === 'folded' && !tree().childrenOf(s.id).length) return;
    snapshot();
    s[what] = !s[what];
    render();
  }
  function tidy() {
    snapshot();
    m.nodes.forEach((n) => (n.pinned = false));
    render();
    fit();
  }
  function undo() {
    const j = past.pop();
    if (!j) return;
    future.push(JSON.stringify(m));
    restore(j);
  }
  function redo() {
    const j = future.pop();
    if (!j) return;
    past.push(JSON.stringify(m));
    restore(j);
  }
  function editLabel() {
    label.focus({ preventScroll: true });
    label.select();
  }
  // typing a label is one undo step
  let labelSnap = false;
  label.addEventListener('focus', () => (labelSnap = false));
  label.addEventListener('input', () => {
    const n = byId(sel);
    if (!n) return;
    if (!labelSnap) snapshot(), (labelSnap = true);
    n.text = label.value;
    later();
  });

  // ---------- gestures ----------
  const pts = new Map<number, { x: number; y: number }>();
  type G = { kind: 'node'; id: string; sx: number; sy: number; lx: number; ly: number; moved: boolean; fired: boolean } | { kind: 'pan'; sx: number; sy: number; tx0: number; ty0: number; moved: boolean } | { kind: 'pinch'; d0: number; cx0: number; cy0: number; k0: number; tx0: number; ty0: number };
  let g: G | null = null;
  let longTimer = 0;
  let lastTap = { id: '', t: 0 };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinchStart = () => {
    const [a, b] = [...pts.values()];
    clearTimeout(longTimer);
    g = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx0: (a.x + b.x) / 2, cy0: (a.y + b.y) / 2, k0: k, tx0: tx, ty0: ty };
  };
  svg.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    svg.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) return pinchStart();
    if (pts.size > 2) return;
    const p = local(e);
    const node = (e.target as Element).closest<SVGGElement>('.mm-node');
    if (node) {
      const id = node.dataset.id!;
      g = { kind: 'node', id, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, fired: false };
      longTimer = window.setTimeout(() => {
        if (g?.kind !== 'node' || g.moved) return;
        g.fired = true;
        sel = id;
        const n = byId(id)!;
        if (tree().childrenOf(id).length) {
          snapshot();
          n.folded = !n.folded;
          navigator.vibrate?.(12);
        }
        render();
      }, LONG_MS);
    } else g = { kind: 'pan', sx: p.x, sy: p.y, tx0: tx, ty0: ty, moved: false };
    area.focus({ preventScroll: true });
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const nk = Math.max(MIN_K, Math.min(MAX_K, (g.k0 * d) / g.d0));
      // the point under the fingers stays under them
      tx = cx - ((g.cx0 - g.tx0) / g.k0) * nk;
      ty = cy - ((g.cy0 - g.ty0) / g.k0) * nk;
      k = nk;
      applyView();
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 6) return;
    if (g.kind === 'pan') {
      g.moved = true;
      tx = g.tx0 + (p.x - g.sx);
      ty = g.ty0 + (p.y - g.sy);
      applyView();
      return;
    }
    if (g.fired) return;
    clearTimeout(longTimer);
    if (!g.moved) {
      g.moved = true;
      snapshot();
      sel = g.id;
      // the node and everything under it are pinned where they are now, then move together
      for (const n of tree().subtree(g.id)) {
        const q = pos.get(n.id);
        if (q && !n.pinned) (n.x = q.x), (n.y = q.y);
        n.pinned = true;
      }
    }
    const dx = (p.x - g.lx) / k;
    const dy = (p.y - g.ly) / k;
    g.lx = p.x;
    g.ly = p.y;
    for (const n of tree().subtree(g.id)) (n.x += dx), (n.y += dy);
    later();
  });
  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    clearTimeout(longTimer);
    const was = g;
    if (was?.kind === 'pinch') {
      // lifting one finger of a pinch carries on as a pan with the other
      if (pts.size === 1) {
        const [p] = [...pts.values()];
        g = { kind: 'pan', sx: p.x, sy: p.y, tx0: tx, ty0: ty, moved: true };
      } else g = null;
      return;
    }
    g = null;
    if (was?.kind === 'node' && !was.moved && !was.fired && e.type === 'pointerup') {
      const now = performance.now();
      const again = lastTap.id === was.id && now - lastTap.t < 350;
      lastTap = { id: was.id, t: now };
      select(was.id);
      if (again) editLabel();
      else area.focus({ preventScroll: true });
    }
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const p = local(e);
        zoomBy(Math.exp(-e.deltaY / 300), p.x, p.y);
      } else {
        tx -= e.deltaX;
        ty -= e.deltaY;
        applyView();
      }
    },
    { passive: false }
  );

  // ---------- keys ----------
  const nearest = (dir: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => {
    const a = pos.get(sel);
    if (!a) return null;
    const vx = dir === 'ArrowLeft' ? -1 : dir === 'ArrowRight' ? 1 : 0;
    const vy = dir === 'ArrowUp' ? -1 : dir === 'ArrowDown' ? 1 : 0;
    let best: string | null = null;
    let score = Infinity;
    for (const [id, p] of pos) {
      if (id === sel) continue;
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      const along = dx * vx + dy * vy;
      if (along <= 4) continue;
      const across = Math.abs(dx * vy - dy * vx);
      const sc = along + across * 2;
      if (sc < score) (score = sc), (best = id);
    }
    return best;
  };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const inLabel = t === label;
    const onMap = t === area || overlay.contains(t) && !t.closest('input, select, textarea, button');
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (inLabel) area.focus({ preventScroll: true });
      else finish();
      return;
    }
    if (mod && !inLabel && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'y' || e.shiftKey) redo();
      else undo();
      return;
    }
    if (!inLabel && !onMap) return;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      addChild();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (inLabel && e.isComposing) return;
      addSibling();
    } else if (onMap && e.key === 'F2') {
      e.preventDefault();
      editLabel();
    } else if (onMap && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      remove();
    } else if (onMap && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const id = nearest(e.key as 'ArrowLeft');
      if (id) select(id);
    } else if (onMap && e.key === ' ') {
      e.preventDefault();
      toggle('folded');
    }
  };
  document.addEventListener('keydown', onKey, true);

  // ---------- saving and closing ----------
  const save = () => {
    const j = JSON.stringify(m);
    if (j === saved) return;
    saved = j;
    o.onSave(structuredClone(m));
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden') save();
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    save();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('popstate', onBack);
    window.removeEventListener('hashchange', onLeave, true);
    ro.disconnect();
    overlay.remove();
    document.body.classList.remove('mm-open');
    o.onClose?.();
  };
  // Android back closes the editor (and saves) instead of leaving the note
  history.pushState({ mmEditor: true }, '');
  const onBack = () => close();
  const onLeave = () => close();
  function finish() {
    close();
    if (history.state?.mmEditor) history.back();
  }
  window.addEventListener('popstate', onBack);
  // capture: runs before the app's router, so the map is saved into the note before the note closes
  window.addEventListener('hashchange', onLeave, true);
  document.addEventListener('visibilitychange', onHide);
  const ro = new ResizeObserver(() => applyView());
  ro.observe(area);

  render();
  fit();
  area.focus({ preventScroll: true });
  return { close: finish };
}

/** Default colour key of a new main branch (for callers that want to show it). */
export const branchKeyAt = (i: number) => BRANCH_KEYS[i % BRANCH_KEYS.length];
