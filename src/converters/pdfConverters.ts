import type { ConversionResult, ProgressFn } from './types';
import { replaceExt, stripExt } from '../lib/strings';

type ImgTarget = 'png' | 'jpg';

/** Render each PDF page to a raster image. Single page -> image; many -> zip. */
export async function pdfToImages(
  file: File,
  target: ImgTarget,
  onProgress?: ProgressFn,
): Promise<ConversionResult> {
  const pdfjsLib = (await import('../lib/pdfjs')).default;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const mime = target === 'jpg' ? 'image/jpeg' : 'image/png';

  const pages: { name: string; blob: Blob }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 }); // ~150 DPI
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser.');

    if (target === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // intent: 'print' makes pdf.js render synchronously instead of yielding via
    // requestAnimationFrame — so it also completes in background/hidden tabs
    // (rAF is throttled/paused there) and in headless environments.
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Page render failed.'))), mime, 0.92),
    );
    pages.push({ name: `page_${i}.${target}`, blob });
    onProgress?.(i / pdf.numPages);
  }

  const base = stripExt(file.name);
  if (pages.length === 1) {
    return { blob: pages[0].blob, filename: `${base}.${target}` };
  }

  // Multiple pages -> bundle into a correctly-named zip.
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const p of pages) zip.file(p.name, p.blob);
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return { blob: zipBlob, filename: `${base}_images.zip` };
}

/** Extract the embedded text layer of a PDF (digital PDFs only, not scans). */
export async function pdfToText(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const pdfjsLib = (await import('../lib/pdfjs')).default;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += linesFromItems(content.items).join('\n') + '\n\n';
    onProgress?.(i / pdf.numPages);
  }
  return {
    blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    filename: replaceExt(file.name, 'txt'),
  };
}

/**
 * PDF -> Word (.docx), text-level. Reconstructs lines from the text layer and
 * writes them as paragraphs. Complex layouts/tables/images are flattened — this
 * is the intentional fidelity tradeoff for staying 100% in-browser.
 */
export async function pdfToDocx(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const pdfjsLib = (await import('../lib/pdfjs')).default;
  const { Document, Packer, Paragraph, TextRun } = await import('docx');

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const paragraphs: InstanceType<typeof Paragraph>[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const line of linesFromItems(content.items)) {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
    }
    paragraphs.push(new Paragraph({})); // blank line between pages
    onProgress?.(i / pdf.numPages);
  }
  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({ children: [new TextRun('(No extractable text found.)')] }));
  }

  const doc = new Document({ sections: [{ children: paragraphs }] });
  const blob = await Packer.toBlob(doc);
  return { blob, filename: replaceExt(file.name, 'docx') };
}

/** Rotate every page of a PDF clockwise by `deg` degrees (90 / 180 / 270). */
export async function pdfRotate(file: File, deg: number): Promise<ConversionResult> {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const src = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
  for (const page of src.getPages()) {
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + deg) % 360));
  }
  const out = await src.save();
  return {
    blob: new Blob([out], { type: 'application/pdf' }),
    filename: `${stripExt(file.name)}_rotated.pdf`,
  };
}

/** Split a PDF into one single-page PDF per page, bundled into a zip. */
export async function pdfSplit(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const { PDFDocument } = await import('pdf-lib');
  const JSZip = (await import('jszip')).default;
  const src = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
  const count = src.getPageCount();

  const zip = new JSZip();
  for (let i = 0; i < count; i++) {
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);
    zip.file(`page_${i + 1}.pdf`, await out.save());
    onProgress?.((i + 1) / count);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, filename: `${stripExt(file.name)}_pages.zip` };
}

/** Group pdf.js text items into visual lines by their y-coordinate. */
function linesFromItems(items: unknown[]): string[] {
  const rows = new Map<number, { x: number; str: string }[]>();
  for (const raw of items) {
    const it = raw as { str?: string; transform?: number[] };
    if (!it.str || !it.transform) continue;
    const y = Math.round(it.transform[5]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y)!.push({ x: it.transform[4], str: it.str });
  }
  // pdf.js y grows upward, so sort descending for top-to-bottom reading order.
  const ys = Array.from(rows.keys()).sort((a, b) => b - a);
  return ys
    .map((y) =>
      rows
        .get(y)!
        .sort((a, b) => a.x - b.x)
        .map((s) => s.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0);
}
