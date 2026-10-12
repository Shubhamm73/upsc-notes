import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { imageUrl } from './images';

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
      src: { default: null, rendered: false }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-image-id]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return {
            imageId: e.dataset.imageId,
            width: Number(e.dataset.width) || 100,
            align: e.dataset.align || 'center'
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
        'data-align': node.attrs.align
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
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'resize-handle';
      handle.setAttribute('aria-label', 'Drag to resize image');
      handle.tabIndex = -1;
      const sizeTag = document.createElement('span');
      sizeTag.className = 'size-tag';
      frame.append(img, handle, sizeTag);
      fig.append(frame);

      let loadedId: string | null = null;
      // A floated image (left/right) is sized on the figure so text can sit beside it; a centred one on the frame.
      const setWidth = (pct: number, align: string) => {
        const floated = align === 'left' || align === 'right';
        fig.style.width = floated ? `${pct}%` : '';
        frame.style.width = floated ? '100%' : `${pct}%`;
      };
      const paint = (n: PMNode) => {
        fig.dataset.align = n.attrs.align;
        setWidth(n.attrs.width, n.attrs.align);
        sizeTag.textContent = `${n.attrs.width}%`;
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
      };
      paint(node);

      const commit = (attrs: Record<string, unknown>) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }));
      };

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
