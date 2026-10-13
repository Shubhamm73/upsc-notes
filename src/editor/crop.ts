import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { SHAPES, normRotate, placeRotated, readCrop, shapeOf, svgPath, type Crop } from '../lib/shapes';

/** What Crop & shape changes on a picture. The stored picture itself is never changed. */
export interface CropState {
  crop: Crop | null;
  shape: string;
  rotate: number;
  flip: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';
const MIN = 0.04; // smallest crop, as a share of the picture
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const RATIOS: { id: string; label: string; r: number | null | 'original' }[] = [
  { id: 'free', label: 'Free', r: null },
  { id: 'square', label: 'Square', r: 1 },
  { id: '4:3', label: '4:3', r: 4 / 3 },
  { id: '3:4', label: '3:4', r: 3 / 4 },
  { id: '16:9', label: '16:9', r: 16 / 9 },
  { id: 'original', label: 'Original', r: 'original' }
];

function shapeIcon(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  const s = shapeOf(id);
  const w = s.ratio && s.ratio > 1.2 ? 20 : s.ratio && s.ratio < 0.9 ? 14 : 17;
  const hh = s.id === 'oval' ? 13 : s.id === 'rect' ? 14 : 17;
  p.setAttribute('d', svgPath(id, 12 - w / 2, 12 - hh / 2, w, hh));
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

/**
 * Full-screen Crop & shape editor. Drag the box to choose what shows, drag its corners or
 * edges to resize, pinch (or the Zoom slider) to zoom; pick a shape, a size, turn or mirror.
 * Resolves with the new settings, or null on Cancel / Esc.
 */
export function openCropEditor(o: { src: string; width: number; height: number } & CropState): Promise<CropState | null> {
  const W = o.width;
  const H = o.height;
  let rotate = normRotate(o.rotate);
  let flip = !!o.flip;
  let shape = shapeOf(o.shape).id;
  let crop: Crop = readCrop(o.crop) ?? { x: 0, y: 0, w: 1, h: 1 };
  /** Locked width ÷ height of the crop in picture pixels, or null for free. */
  let ratio: number | null = shapeOf(shape).lock ? 1 : null;
  /** Which Size chip is on ('shape' = the shape's own proportions, no chip). */
  let ratioId = ratio ? 'square' : 'free';

  const turnedW = () => (rotate % 180 ? H : W);
  const turnedH = () => (rotate % 180 ? W : H);
  /** Crop fractions → pixel ratio and back. */
  const pxRatio = (c: Crop) => (c.w * turnedW()) / (c.h * turnedH());
  const hFor = (w: number, r: number) => (w * turnedW()) / (r * turnedH());
  /** The widest crop with ratio r that fits the picture. */
  const maxW = (r: number) => Math.min(1, (r * turnedH()) / turnedW());

  return new Promise((resolve) => {
    const img = h('img', { src: o.src, alt: '', draggable: false });
    const picture = h('div', { class: 'crop-picture' }, img);
    const mask = document.createElementNS(SVG, 'svg');
    mask.setAttribute('class', 'crop-mask');
    mask.setAttribute('viewBox', '0 0 1000 1000');
    mask.setAttribute('preserveAspectRatio', 'none');
    const shade = document.createElementNS(SVG, 'path');
    shade.setAttribute('fill-rule', 'evenodd');
    shade.setAttribute('class', 'crop-shade');
    const outline = document.createElementNS(SVG, 'path');
    outline.setAttribute('class', 'crop-outline');
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    mask.append(shade, outline);
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) =>
      h('span', { class: `crop-handle h-${d}`, 'data-h': d, 'aria-hidden': 'true' })
    );
    const box = h('div', { class: 'crop-box', role: 'slider', tabindex: '0', 'aria-label': 'Crop area. Drag to move, arrow keys to nudge.' }, ...handles);
    const view = h('div', { class: 'crop-view' }, picture, mask, box);
    const area = h('div', { class: 'crop-area' }, view);

    const cancel = h('button', { type: 'button', id: 'crop-cancel' }, 'Cancel');
    const done = h('button', { type: 'button', class: 'primary', id: 'crop-done' }, 'Done');
    const head = h('header', { class: 'crop-head' }, cancel, h('h2', {}, 'Crop & shape'), done);

    const shapeRow = h('div', { class: 'crop-chips', role: 'radiogroup', 'aria-label': 'Shape' });
    const shapeBtns = SHAPES.map((s) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'crop-chip', 'data-shape': s.id, 'aria-label': s.label, title: s.label }, shapeIcon(s.id), h('span', {}, s.label));
      b.addEventListener('click', () => setShape(s.id));
      shapeRow.append(b);
      return b;
    });
    const ratioRow = h('div', { class: 'crop-chips', role: 'radiogroup', 'aria-label': 'Size' });
    const ratioBtns = RATIOS.map((r) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'crop-chip', 'data-ratio': r.id }, r.label);
      b.addEventListener('click', () => setRatio(r.id, r.r === 'original' ? turnedW() / turnedH() : r.r));
      ratioRow.append(b);
      return b;
    });
    const zoom = h('input', { type: 'range', min: '1', max: '6', step: '0.01', value: '1', id: 'crop-zoom', 'aria-label': 'Zoom' });
    const rotateBtn = h('button', { type: 'button', id: 'crop-rotate' }, icon('rotate', 20), 'Turn');
    const flipBtn = h('button', { type: 'button', id: 'crop-flip', 'aria-pressed': String(flip) }, icon('flip', 20), 'Mirror');
    const resetBtn = h('button', { type: 'button', id: 'crop-reset' }, 'Reset');
    const controls = h(
      'div',
      { class: 'crop-controls' },
      h('div', { class: 'crop-row' }, h('span', { class: 'crop-label' }, 'Shape'), shapeRow),
      h('div', { class: 'crop-row' }, h('span', { class: 'crop-label' }, 'Size'), ratioRow),
      h('div', { class: 'crop-row crop-tools' }, h('label', { class: 'crop-zoom' }, h('span', { class: 'crop-label' }, 'Zoom'), zoom), rotateBtn, flipBtn, resetBtn)
    );
    const overlay = h('div', { class: 'crop-overlay', id: 'crop-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Crop and shape picture' }, head, area, controls);
    document.body.append(overlay);
    document.body.classList.add('cropping');
    if (!reduced()) overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });

    // ---------- layout ----------
    let vw = 1;
    let vh = 1;
    function layout() {
      const a = area.getBoundingClientRect();
      const pad = 28;
      const s = Math.min((a.width - pad * 2) / turnedW(), (a.height - pad * 2) / turnedH());
      vw = Math.max(40, turnedW() * s);
      vh = Math.max(40, turnedH() * s);
      Object.assign(view.style, { width: `${vw}px`, height: `${vh}px` });
      placeRotated(img, W, H, rotate, flip);
      paint();
    }

    function paint() {
      const c = crop;
      Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
      const X = c.x * 1000;
      const Y = c.y * 1000;
      const CW = c.w * 1000;
      const CH = c.h * 1000;
      const inner = svgPath(shape, X, Y, CW, CH);
      shade.setAttribute('d', `M0 0H1000V1000H0Z ${inner}`);
      outline.setAttribute('d', inner);
      for (const b of shapeBtns) b.setAttribute('aria-checked', String(b.dataset.shape === shape));
      const locked = shapeOf(shape).lock;
      for (const b of ratioBtns) {
        b.setAttribute('aria-checked', String(ratioId === b.dataset.ratio));
        b.disabled = !!locked && b.dataset.ratio !== 'square';
      }
      const r = pxRatio(c);
      zoom.value = String(Math.min(6, Math.max(1, maxW(r) / c.w)));
      flipBtn.setAttribute('aria-pressed', String(flip));
    }

    // ---------- crop maths ----------
    /** Keeps a crop of ratio r (or the current shape) centred near cx, cy, inside the picture. */
    function placeAround(cx: number, cy: number, w: number, r: number): Crop {
      const cw = Math.min(Math.max(w, MIN), maxW(r));
      const ch = Math.min(1, hFor(cw, r));
      const x = Math.min(1 - cw, Math.max(0, cx - cw / 2));
      const y = Math.min(1 - ch, Math.max(0, cy - ch / 2));
      return { x, y, w: cw, h: ch };
    }

    function setShape(id: string) {
      shape = shapeOf(id).id;
      const s = shapeOf(id);
      if (s.lock) {
        ratio = 1;
        ratioId = 'square';
      } else if (s.ratio) {
        ratio = s.ratio;
        ratioId = 'shape';
      } else if (ratioId === 'shape') {
        ratio = null;
        ratioId = 'free';
      }
      if (ratio !== null) crop = placeAround(crop.x + crop.w / 2, crop.y + crop.h / 2, Math.max(crop.w, maxW(ratio) * 0.98), ratio);
      paint();
    }

    function setRatio(id: string, r: number | null) {
      if (shapeOf(shape).lock && r !== 1) return;
      ratio = r;
      ratioId = id;
      if (r !== null) crop = placeAround(crop.x + crop.w / 2, crop.y + crop.h / 2, maxW(r), r);
      paint();
    }

    function setZoom(z: number) {
      const r = ratio ?? pxRatio(crop);
      const w = maxW(r) / z;
      const cx = crop.x + crop.w / 2;
      const cy = crop.y + crop.h / 2;
      if (ratio === null) {
        const k = w / crop.w;
        const nw = Math.min(1, Math.max(MIN, crop.w * k));
        const nh = Math.min(1, Math.max(MIN, crop.h * k));
        crop = { x: Math.min(1 - nw, Math.max(0, cx - nw / 2)), y: Math.min(1 - nh, Math.max(0, cy - nh / 2)), w: nw, h: nh };
      } else {
        crop = placeAround(cx, cy, w, ratio);
      }
      paint();
    }

    function turn() {
      // the crop turns with the picture (a quarter turn clockwise)
      crop = { x: 1 - (crop.y + crop.h), y: crop.x, w: crop.h, h: crop.w };
      rotate = (rotate + 90) % 360;
      if (ratio !== null && !shapeOf(shape).lock) {
        ratio = 1 / ratio;
        ratioId = ratioId === '4:3' ? '3:4' : ratioId === '3:4' ? '4:3' : ratioId === '16:9' || ratioId === 'shape' ? 'shape' : ratioId;
      }
      layout();
    }

    function mirror() {
      flip = !flip;
      crop = { ...crop, x: 1 - (crop.x + crop.w) };
      placeRotated(img, W, H, rotate, flip);
      paint();
    }

    function reset() {
      rotate = 0;
      flip = false;
      shape = 'rect';
      ratio = null;
      ratioId = 'free';
      crop = { x: 0, y: 0, w: 1, h: 1 };
      layout();
    }

    // ---------- dragging: move, resize, pinch ----------
    type Drag = { mode: 'move' | 'resize'; handle: string; sx: number; sy: number; start: Crop; id: number };
    let drag: Drag | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; start: Crop } | null = null;

    function resize(d: Drag, dx: number, dy: number) {
      const s = d.start;
      const hd = d.handle;
      const L = hd.includes('w');
      const R = hd.includes('e');
      const T = hd.includes('n');
      const B = hd.includes('s');
      if (ratio === null) {
        let x0 = s.x;
        let x1 = s.x + s.w;
        let y0 = s.y;
        let y1 = s.y + s.h;
        if (L) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
        if (R) x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
        if (T) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
        if (B) y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
        crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        return;
      }
      // locked shape: one size, anchored on the opposite side
      const r = ratio;
      let w = L || R ? s.w + (R ? dx : -dx) : (s.h + (B ? dy : -dy)) * ((r * turnedH()) / turnedW());
      const ax = L ? s.x + s.w : R ? s.x : s.x + s.w / 2; // anchor x
      const ay = T ? s.y + s.h : B ? s.y : s.y + s.h / 2; // anchor y
      const roomX = L ? ax : R ? 1 - ax : 2 * Math.min(ax, 1 - ax);
      const roomY = T ? ay : B ? 1 - ay : 2 * Math.min(ay, 1 - ay);
      w = Math.max(MIN, Math.min(w, roomX, (roomY * r * turnedH()) / turnedW()));
      const hh = hFor(w, r);
      const x = L ? ax - w : R ? ax : ax - w / 2;
      const y = T ? ay - hh : B ? ay : ay - hh / 2;
      crop = { x, y, w, h: hh };
    }

    area.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      area.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), start: { ...crop } };
        drag = null;
        return;
      }
      const t = e.target as HTMLElement;
      const hd = t.closest<HTMLElement>('.crop-handle')?.dataset.h;
      if (hd) drag = { mode: 'resize', handle: hd, sx: e.clientX, sy: e.clientY, start: { ...crop }, id: e.pointerId };
      else if (t.closest('.crop-box')) drag = { mode: 'move', handle: '', sx: e.clientX, sy: e.clientY, start: { ...crop }, id: e.pointerId };
      else {
        // a tap outside the box centres it there
        const v = view.getBoundingClientRect();
        const px = (e.clientX - v.left) / v.width;
        const py = (e.clientY - v.top) / v.height;
        crop = { ...crop, x: Math.min(1 - crop.w, Math.max(0, px - crop.w / 2)), y: Math.min(1 - crop.h, Math.max(0, py - crop.h / 2)) };
        drag = { mode: 'move', handle: '', sx: e.clientX, sy: e.clientY, start: { ...crop }, id: e.pointerId };
        paint();
      }
      e.preventDefault();
    });
    area.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const k = pinch.d / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const s = pinch.start;
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        if (ratio === null) {
          const nw = Math.min(1, Math.max(MIN, s.w * k));
          const nh = Math.min(1, Math.max(MIN, s.h * k));
          crop = { x: Math.min(1 - nw, Math.max(0, cx - nw / 2)), y: Math.min(1 - nh, Math.max(0, cy - nh / 2)), w: nw, h: nh };
        } else {
          crop = placeAround(cx, cy, s.w * k, ratio);
        }
        paint();
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      const dx = (e.clientX - drag.sx) / vw;
      const dy = (e.clientY - drag.sy) / vh;
      if (drag.mode === 'move') {
        const s = drag.start;
        crop = { ...s, x: Math.min(1 - s.w, Math.max(0, s.x + dx)), y: Math.min(1 - s.h, Math.max(0, s.y + dy)) };
      } else {
        resize(drag, dx, dy);
      }
      paint();
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag?.id === e.pointerId) drag = null;
    };
    area.addEventListener('pointerup', up);
    area.addEventListener('pointercancel', up);
    // a mouse wheel or trackpad zooms too
    area.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        setZoom(Math.min(6, Math.max(1, Number(zoom.value) * (e.deltaY < 0 ? 1.08 : 1 / 1.08))));
      },
      { passive: false }
    );

    zoom.addEventListener('input', () => setZoom(Number(zoom.value)));
    rotateBtn.addEventListener('click', turn);
    flipBtn.addEventListener('click', mirror);
    resetBtn.addEventListener('click', reset);

    const ro = new ResizeObserver(() => layout());
    ro.observe(area);

    function close(result: CropState | null) {
      ro.disconnect();
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('cropping');
      overlay.remove();
      resolve(result);
    }
    function finish() {
      const full = crop.x < 0.002 && crop.y < 0.002 && crop.w > 0.996 && crop.h > 0.996;
      const r4 = (n: number) => Math.round(n * 10000) / 10000;
      close({ crop: full ? null : { x: r4(crop.x), y: r4(crop.y), w: r4(crop.w), h: r4(crop.h) }, shape, rotate, flip });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button, input')) {
        e.preventDefault();
        finish();
      } else if (e.target === box && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 0.05 : 0.01;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        crop = { ...crop, x: Math.min(1 - crop.w, Math.max(0, crop.x + dx)), y: Math.min(1 - crop.h, Math.max(0, crop.y + dy)) };
        paint();
      }
    };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => close(null));
    done.addEventListener('click', finish);

    layout();
    done.focus({ preventScroll: true });
  });
}
