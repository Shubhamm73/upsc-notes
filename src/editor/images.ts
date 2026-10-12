import { db, newId, type DocNode, type Note } from '../db';

const MAX_EDGE = 1600;
const urls = new Map<string, string>();

/** Object URL for a stored image, cached for the page's lifetime. */
export async function imageUrl(id: string): Promise<string | null> {
  const cached = urls.get(id);
  if (cached) return cached;
  const rec = await db.images.get(id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(id, url);
  return url;
}

async function encode(canvas: OffscreenCanvas | HTMLCanvasElement, type: string): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality: 0.85 });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.85)
  );
}

/**
 * Shrinks a picked photo to at most 1600 px on its long edge, keeping its shape.
 * PNGs stay PNG (keeps transparent diagrams); everything else becomes JPEG.
 * Both formats are what the PDF export can embed.
 */
export async function compressImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const keepPng = file.type === 'image/png';
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (!keepPng) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await encode(canvas, keepPng ? 'image/png' : 'image/jpeg');
  return { blob, width, height };
}

export async function addImage(file: Blob, noteId: string) {
  const { blob, width, height } = await compressImage(file);
  const id = newId();
  await db.images.put({ id, noteId, blob, width, height, updatedAt: Date.now() });
  return { id, width, height };
}

export function collectImageIds(doc: DocNode | undefined, into = new Set<string>()): Set<string> {
  if (!doc) return into;
  if (doc.type === 'imageBlock' && typeof doc.attrs?.imageId === 'string') into.add(doc.attrs.imageId);
  doc.content?.forEach((c) => collectImageIds(c, into));
  return into;
}

/**
 * Deletes stored images that no note references any more (removed from a note
 * and the note closed). Images in trashed notes are kept: those notes still exist.
 */
export async function removeUnusedImages(openNote?: Note | null): Promise<number> {
  const startedAt = Date.now();
  const used = new Set<string>();
  await db.notes.each((n) => n.sections.forEach((s) => collectImageIds(s.doc, used)));
  openNote?.sections.forEach((s) => collectImageIds(s.doc, used));
  // Images added after this check started may belong to a note not saved yet: never touch them.
  const stale = await db.images
    .filter((img) => img.updatedAt < startedAt - 1000 && !used.has(img.id))
    .primaryKeys();
  if (stale.length) {
    await db.images.bulkDelete(stale);
    stale.forEach((id) => {
      const u = urls.get(id);
      if (u) URL.revokeObjectURL(u);
      urls.delete(id);
    });
  }
  return stale.length;
}
