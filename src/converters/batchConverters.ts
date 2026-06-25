import type { ConversionResult, ProgressFn } from './types';
import { convertImageFormat } from './imageConverters';

/** Merge several PDFs into one, in the order given. */
export async function mergePdfs(files: File[], onProgress?: ProgressFn): Promise<ConversionResult> {
  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const src = await PDFDocument.load(new Uint8Array(await files[i].arrayBuffer()));
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
    onProgress?.((i + 1) / files.length);
  }

  const out = await merged.save();
  return { blob: new Blob([out], { type: 'application/pdf' }), filename: 'merged.pdf' };
}

/** Combine several images into a single PDF, one image per page. */
export async function imagesToPdf(files: File[], onProgress?: ProgressFn): Promise<ConversionResult> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let embedded;
    if (f.type === 'image/png') {
      embedded = await pdf.embedPng(new Uint8Array(await f.arrayBuffer()));
    } else if (f.type === 'image/jpeg') {
      embedded = await pdf.embedJpg(new Uint8Array(await f.arrayBuffer()));
    } else {
      // pdf-lib only embeds PNG/JPEG — normalize webp/bmp/gif to PNG first.
      const png = await convertImageFormat(f, 'png');
      embedded = await pdf.embedPng(new Uint8Array(await png.blob.arrayBuffer()));
    }
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    onProgress?.((i + 1) / files.length);
  }

  const out = await pdf.save();
  return { blob: new Blob([out], { type: 'application/pdf' }), filename: 'combined.pdf' };
}
