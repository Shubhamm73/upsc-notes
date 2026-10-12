import type { AppContext } from '../app';
import { downloadFile } from '../lib/backup';
import type { PdfScope } from './export';

let busy = false;

/** Saves first, builds the PDF (the PDF engine loads on first use), then downloads it. */
export async function runPdfExport(scope: PdfScope, ctx: AppContext, button?: HTMLButtonElement) {
  if (busy) return;
  busy = true;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Making PDF…';
  }
  try {
    await ctx.flush();
    const { buildPdf } = await import('./export');
    const { blob, filename } = await buildPdf(scope);
    downloadFile(blob, filename);
    ctx.toast(`PDF saved to Downloads: ${filename}`);
  } catch (e) {
    console.error(e);
    ctx.toast("The PDF couldn't be made. Try again; if it keeps failing, export one section at a time.");
  } finally {
    busy = false;
    if (button) {
      button.disabled = false;
      button.textContent = label ?? 'PDF';
    }
  }
}
