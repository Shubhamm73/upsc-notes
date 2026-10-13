import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { imageUrl } from './images';
import { clipCss, isPlain, normRotate, placeRotated, readCrop, shapeOf } from '../lib/shapes';
import { openCropEditor } from './crop';

export type Align = 'left' | 'center' | 'right';

export const ImageBlock = Node.create({
  name: 'imageBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      imageId: { default: null },
      width: { default: 100 }, // percent of the text column, 10–100
      // left / right: the image floats and text, lists and other blocks flow beside it; center: its own row
      align: { default: 'center' },
      alt: { default: '' },
      // Only while a picture pasted from the web is being copied onto the tablet (see paste.ts); then null.
      src: { default: null, rendered: false },
      // Crop & shape (crop.ts). The stored picture is never changed: these say how to show it.
      crop: { default: null }, // { x, y, w, h } fractions of the turned picture; null = all of it
      shape: { default: 'rect' }, // lib/shapes.ts
      rotate: { default: 0 }, // 0 / 90 / 180 / 270, clockwise
      flip: { default: false }, // mirrored left to right
      caption: { default: '' }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-image-id]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          let crop = null;
          try {
            crop = readCrop(JSON.parse(e.dataset.crop ?? 'null'));
          } catch {
            crop = null;
          }
          return {
            imageId: e.dataset.imageId,
            width: Number(e.dataset.width) || 100,
            align: e.dataset.align || 'center',
            crop,
            shape: shapeOf(e.dataset.shape).id,
            rotate: normRotate(e.dataset.rotate),
            flip: e.dataset.flip === 'true',
            caption: e.dataset.caption ?? ''
          };
        }
      },
      {
        // Pictures inside pasted HTML (web pages, Word, Google Docs): copied into storage after the paste.
        tag: 'img[src]',
        getAttrs: (el) => {
          const src = (el as HTMLImageElement).getAttribute('src') ?? '';
          return /^(https?:|data:image\/)/i.test(src) ? { imageId: null, src, alt: (el as HTMLImageElement).alt || '' } : false;
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        'data-image-id': node.attrs.imageId,
        'data-width': node.attrs.width,
        'data-align': node.attrs.align,
        'data-crop': node.attrs.crop ? JSON.stringify(node.attrs.crop) : null,
        'data-shape': node.attrs.shape !== 'rect' ? node.attrs.shape : null,
        'data-rotate': node.attrs.rotate || null,
        'data-flip': node.attrs.flip ? 'true' : null,
        'data-caption': node.attrs.caption || null
      })
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current: PMNode = node;
      const fig = document.createElement('figure');
      fig.className = 'img-block';
      const frame = document.createElement('div');
      frame.className = 'img-frame';
      // clip (shape, crop window) > stage (the whole turned picture) > img
      const clip = document.createElement('div');
      clip.className = 'img-clip';
      const stage = document.createElement('div');
      stage.className = 'img-stage';
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      stage.append(img);
      clip.append(stage);
      const caption = document.createElement('figcaption');
      caption.className = 'img-caption';
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'resize-handle';
      handle.setAttribute('aria-label', 'Drag to resize image');
      handle.tabIndex = -1;
      const sizeTag = document.createElement('span');
      sizeTag.className = 'size-tag';
      frame.append(clip, handle, sizeTag);
      fig.append(frame, caption);

      let loadedId: string | null = null;
      // A floated image (left/right) is sized on the figure so text can sit beside it; a centred one on the frame.
      const setWidth = (pct: number, align: string) => {
        const floated = align === 'left' || align === 'right';
        fig.style.width = floated ? `${pct}%` : '';
        frame.style.width = floated ? '100%' : `${pct}%`;
      };
      /** Crop window, turn and mirror; needs the picture's natural size, so it runs again once loaded. */
      const paintGeometry = (n: PMNode) => {
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        const plain = isPlain(n.attrs);
        const shape = shapeOf(n.attrs.shape).id;
        fig.dataset.shape = shape;
        clip.style.clipPath = clipCss(shape);
        const floated = n.attrs.align === 'left' || n.attrs.align === 'right';
        // Text beside a floated picture follows its shape (not with a caption: the caption is part of the box).
        const follow = floated && shape !== 'rect' && shape !== 'rounded' && !n.attrs.caption;
        fig.style.shapeOutside = follow ? `${clipCss(shape)} border-box` : '';
        if (plain || !W || !H) {
          clip.style.aspectRatio = '';
          stage.removeAttribute('style');
          img.removeAttribute('style');
          fig.classList.toggle('is-cropped', false);
          if (W && H) fig.style.setProperty('--ratio', String(W / H));
          return;
        }
        const rot = normRotate(n.attrs.rotate);
        const tw = rot % 180 ? H : W;
        const th = rot % 180 ? W : H;
        const c = readCrop(n.attrs.crop) ?? { x: 0, y: 0, w: 1, h: 1 };
        clip.style.aspectRatio = `${c.w * tw} / ${c.h * th}`;
        fig.style.setProperty('--ratio', String((c.w * tw) / (c.h * th)));
        fig.classList.toggle('is-cropped', true);
        Object.assign(stage.style, {
          position: 'absolute',
          left: `${(-c.x / c.w) * 100}%`,
          top: `${(-c.y / c.h) * 100}%`,
          width: `${100 / c.w}%`,
          height: `${100 / c.h}%`
        });
        placeRotated(img, W, H, rot, !!n.attrs.flip);
      };
      img.addEventListener('load', () => paintGeometry(current));

      const paint = (n: PMNode) => {
        fig.dataset.align = n.attrs.align;
        setWidth(n.attrs.width, n.attrs.align);
        sizeTag.textContent = `${n.attrs.width}%`;
        caption.textContent = n.attrs.caption || '';
        caption.hidden = !n.attrs.caption;
        img.alt = n.attrs.caption || n.attrs.alt || '';
        frame.classList.toggle('loading', !n.attrs.imageId && !!n.attrs.src);
        if (n.attrs.imageId !== loadedId) {
          loadedId = n.attrs.imageId;
          img.removeAttribute('src');
          frame.classList.remove('missing');
          if (loadedId) {
            void imageUrl(loadedId).then((u) => {
              if (u && loadedId === n.attrs.imageId) img.src = u;
              else frame.classList.add('missing');
            });
          }
        }
        paintGeometry(n);
      };
      paint(node);

      const commit = (attrs: Record<string, unknown>) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }));
      };

      // Crop & shape: double-tap the picture, or the button in the image tools (which sends 'open-crop').
      let cropping = false;
      const openCrop = async () => {
        if (cropping || !editor.isEditable || !img.naturalWidth || !img.src) return;
        cropping = true;
        try {
          const a = current.attrs;
          const res = await openCropEditor({ src: img.src, width: img.naturalWidth, height: img.naturalHeight, crop: readCrop(a.crop), shape: a.shape, rotate: a.rotate, flip: !!a.flip });
          if (res && !editor.isDestroyed) {
            const same = JSON.stringify([readCrop(a.crop), shapeOf(a.shape).id, normRotate(a.rotate), !!a.flip]) === JSON.stringify([res.crop, res.shape, res.rotate, res.flip]);
            if (!same) commit({ crop: res.crop, shape: res.shape, rotate: res.rotate, flip: res.flip });
          }
        } finally {
          cropping = false;
        }
      };
      img.addEventListener('dblclick', () => void openCrop());
      fig.addEventListener('open-crop', () => void openCrop());

      // Drag-to-resize with finger, pen or mouse. Width snaps to whole percents.
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startPx = frame.getBoundingClientRect().width;
        const columnPx = (fig.parentElement ?? fig).getBoundingClientRect().width || 1;
        const align = current.attrs.align as Align;
        const factor = align === 'center' ? 2 : 1;
        const sign = align === 'right' ? -1 : 1;
        let pct = current.attrs.width as number;
        fig.classList.add('resizing');
        const move = (ev: PointerEvent) => {
          const px = startPx + sign * factor * (ev.clientX - startX);
          pct = Math.round(Math.min(100, Math.max(10, (px / columnPx) * 100)));
          setWidth(pct, align);
          sizeTag.textContent = `${pct}%`;
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          fig.classList.remove('resizing');
          commit({ width: pct });
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });

      return {
        dom: fig,
        update(n) {
          if (n.type.name !== 'imageBlock') return false;
          current = n;
          paint(n);
          return true;
        },
        selectNode() {
          fig.classList.add('is-selected');
        },
        deselectNode() {
          fig.classList.remove('is-selected');
        },
        stopEvent(e) {
          return e.target === handle;
        },
        ignoreMutation() {
          return true;
        }
      };
    };
  }
});
