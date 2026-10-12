import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { addImage } from './images';
import { ensureParagraphAfter } from './insert';

/** What pasting needs from the note around the editor. */
export interface PasteHooks {
  noteId(): string;
  toast(text: string): void;
  /** Called first on every paste: closes the slash menu and drops a typed "/word". */
  beforePaste(editor: Editor): void;
}

const isImage = (f: File) => f.type.startsWith('image/');
const widthFor = (w: number, h: number) => (h > w ? 50 : 100);

/** Stores picked/pasted/dropped image files and returns image blocks for them. */
async function storeFiles(files: File[], hooks: PasteHooks): Promise<object[]> {
  const blocks: object[] = [];
  for (const f of files) {
    try {
      const { id, width, height } = await addImage(f, hooks.noteId());
      blocks.push({ type: 'imageBlock', attrs: { imageId: id, width: widthFor(width, height), align: 'center' } });
    } catch {
      hooks.toast(`"${f.name || 'Picture'}" couldn't be added. Try a JPG or PNG.`);
    }
  }
  return blocks;
}

/**
 * Pictures that arrived inside pasted HTML (<img src>) come in as image blocks with only `src`.
 * Each is downloaded and stored on the tablet like any other image, then linked by id; the web
 * address is never kept. A picture the website won't hand over (no CORS) is removed, with a hint.
 */
async function resolvePastedImages(editor: Editor, hooks: PasteHooks) {
  const srcs = new Set<string>();
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'imageBlock' && !n.attrs.imageId && n.attrs.src) srcs.add(n.attrs.src);
  });
  let failed = 0;
  for (const src of srcs) {
    let stored: { id: string; width: number; height: number } | null = null;
    try {
      const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
      const blob = res.ok ? await res.blob() : null;
      if (blob && blob.type.startsWith('image/')) stored = await addImage(blob, hooks.noteId());
    } catch {
      stored = null;
    }
    if (!stored) failed++;
    if (editor.isDestroyed) return;
    const hits: { pos: number; node: PMNode }[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'imageBlock' && !n.attrs.imageId && n.attrs.src === src) hits.push({ pos, node: n });
    });
    const tr = editor.state.tr;
    for (const { pos, node } of hits.reverse()) {
      if (stored) tr.setNodeMarkup(pos, undefined, { ...node.attrs, imageId: stored.id, src: null, width: widthFor(stored.width, stored.height) });
      else tr.delete(pos, pos + node.nodeSize);
    }
    if (hits.length) editor.view.dispatch(tr);
  }
  if (failed) {
    hooks.toast(
      `${failed === 1 ? '1 picture' : `${failed} pictures`} from the web couldn't be copied (the website doesn't allow it). ` +
        'Long-press the picture → Copy image, then paste it here.'
    );
  }
}

const BULLET = /^\s*([-–•*])\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/**
 * Plain text with "- point" / "• point" / "1. step" lines becomes real lists
 * (dash list for - and –, dots for • and *). Other text is left to the editor.
 */
function listsFromText(text: string, schema: Schema): Slice | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some((l) => BULLET.test(l) || NUMBER.test(l))) return null;
  const { paragraph, bulletList, orderedList, listItem } = schema.nodes;
  const para = (t: string) => paragraph.create(null, t ? schema.text(t) : null);
  const blocks: PMNode[] = [];
  let items: PMNode[] = [];
  let kind: 'dash' | 'disc' | 'ordered' | null = null;
  let start = 1;
  const flush = () => {
    if (!items.length || !kind) return;
    blocks.push(kind === 'ordered' ? orderedList.create({ start }, items) : bulletList.create({ listStyle: kind }, items));
    items = [];
    kind = null;
  };
  for (const line of lines) {
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    const k = b ? (b[1] === '-' || b[1] === '–' ? 'dash' : 'disc') : n ? 'ordered' : null;
    if (k !== kind) flush();
    if (k) {
      if (!kind) start = n ? Number(n[1]) : 1;
      kind = k;
      items.push(listItem.create(null, para((b ?? n)![2])));
    } else if (line.trim()) {
      blocks.push(para(line));
    }
  }
  flush();
  return blocks.length ? new Slice(Fragment.from(blocks), 0, 0) : null;
}

/**
 * Paste and drop: text, rich text from the web / Word / Google Docs, screenshots, copied pictures,
 * image files. A paste always wins over the slash menu (it closes it and replaces the "/word").
 */
export function pasteExtension(hooks: PasteHooks) {
  return Extension.create({
    name: 'smartPaste',
    addProseMirrorPlugins() {
      const editor = this.editor;
      let pending = false;
      const insertFiles = async (files: File[], at?: number) => {
        const blocks = await storeFiles(files, hooks);
        if (!blocks.length || editor.isDestroyed) return;
        if (at !== undefined) editor.chain().focus().insertContentAt(at, blocks).run();
        else editor.chain().focus().insertContent(blocks).run();
        ensureParagraphAfter(editor);
      };
      return [
        new Plugin({
          key: new PluginKey('smartPaste'),
          props: {
            // Headings the note doesn't have map to the nearest one it does (h1 → Heading).
            transformPastedHTML: (html) =>
              html.replace(/<(\/?)h1(\s|>)/gi, '<$1h2$2').replace(/<(\/?)h[56](\s|>)/gi, '<$1h4$2'),
            clipboardTextParser: (text, _ctx, plain, view) => (plain ? null : listsFromText(text, view.state.schema)) as Slice,
            handlePaste: (_view, event) => {
              hooks.beforePaste(editor);
              const data = event.clipboardData;
              const files = [...(data?.files ?? [])].filter(isImage);
              const html = data?.getData('text/html') ?? '';
              const words = (html ? new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '' : data?.getData('text/plain') ?? '').trim();
              // A screenshot or "Copy image": the picture itself is on the clipboard (maybe with a bare <img> as HTML).
              if (files.length && !words) {
                event.preventDefault();
                void insertFiles(files);
                return true;
              }
              if (/<img\s/i.test(html)) pending = true;
              return false; // the editor pastes text and HTML as usual
            },
            handleDrop: (view, event, _slice, moved) => {
              const files = moved ? [] : [...(event.dataTransfer?.files ?? [])].filter(isImage);
              if (!files.length) return false;
              event.preventDefault();
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
              void insertFiles(files, at);
              return true;
            }
          },
          view: (v) => {
            // A note saved while a pasted picture was still being copied picks up where it stopped.
            let left = false;
            v.state.doc.descendants((n) => {
              if (n.type.name === 'imageBlock' && !n.attrs.imageId && n.attrs.src) left = true;
            });
            if (left && v.editable) setTimeout(() => void resolvePastedImages(editor, hooks), 0);
            return {
            update: () => {
              if (!pending) return;
              pending = false;
              void resolvePastedImages(editor, hooks);
            }
            };
          }
        })
      ];
    }
  });
}
