import type { ConversionResult, ParamValues, ProgressFn } from './types';
import { addSuffix, formatBytes, pctSmaller, replaceExt, stripExt } from '../lib/strings';

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

const PDF_PRESETS: Record<string, { dpi: number; quality: number }> = {
  light: { dpi: 150, quality: 0.82 },
  medium: { dpi: 120, quality: 0.72 },
  strong: { dpi: 96, quality: 0.6 },
};

/**
 * Compress a PDF by rasterizing each page to a JPEG at a reduced DPI and
 * rebuilding the document. Great for scanned/image-heavy PDFs; it FLATTENS
 * pages to images (text becomes non-selectable). Returns the original untouched
 * if the result isn't meaningfully smaller (true of most text/vector PDFs).
 */
export async function compressPdf(
  file: File,
  onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const { dpi, quality } = PDF_PRESETS[String(params?.level ?? 'medium')] ?? PDF_PRESETS.medium;
  const original = new Uint8Array(await file.arrayBuffer());

  const pdfjsLib = (await import('../lib/pdfjs')).default;
  const { PDFDocument } = await import('pdf-lib');

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: original.slice() }).promise;
  } catch {
    throw new Error('Could not read this PDF — it may be password-protected.');
  }

  const out = await PDFDocument.create();
  const MAX_DIM = 4096;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 }); // points
    // Clamp so a large-format page can't exceed the canvas size limit.
    const scale = Math.min(dpi / 72, MAX_DIM / base.width, MAX_DIM / base.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas is not available in this browser.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

    const jpgBlob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Page encode failed.'))), 'image/jpeg', quality),
    );
    const jpg = await out.embedJpg(new Uint8Array(await jpgBlob.arrayBuffer()));
    // Output page keeps the ORIGINAL physical size (points), not pixels.
    const p = out.addPage([base.width, base.height]);
    p.drawImage(jpg, { x: 0, y: 0, width: base.width, height: base.height });

    canvas.width = 0; // release the backing store immediately
    canvas.height = 0;
    try { await page.cleanup(); } catch { /* non-fatal */ }
    onProgress?.(i / pdf.numPages);
  }

  const compressed = await out.save();
  // Guard: rasterizing a text/vector PDF usually makes it BIGGER. Keep original.
  if (compressed.byteLength >= original.byteLength * 0.97) {
    return {
      blob: file,
      filename: file.name,
      note: `Already efficient (mostly text/vector) — kept your original ${formatBytes(original.byteLength)} unchanged. Flattening it would have made it larger.`,
    };
  }
  return {
    blob: new Blob([compressed], { type: 'application/pdf' }),
    filename: addSuffix(file.name, '-compressed'),
    note: `Compressed ${formatBytes(original.byteLength)} → ${formatBytes(compressed.byteLength)} (${pctSmaller(original.byteLength, compressed.byteLength)}% smaller). Pages were flattened to images, so text is no longer selectable.`,
  };
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

/**
 * Run qpdf (compiled to WASM) over a single input → "/out.pdf". The .wasm is
 * self-hosted in /public (absolute URL via origin) so it also works inside the
 * native app. A fresh instance per call — Emscripten's runtime can't re-run main.
 */
async function runQpdf(input: ArrayBuffer, args: string[]): Promise<{ out: Uint8Array | null; err: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createModule = (await import('@neslinesli93/qpdf-wasm')).default as any;
  let err = '';
  const qpdf = await createModule({
    locateFile: () => `${window.location.origin}/qpdf.wasm`,
    noInitialRun: true,
    print: () => {},
    printErr: (s: string) => { err += s + '\n'; },
  });
  qpdf.FS.writeFile('/in.pdf', new Uint8Array(input));
  try {
    qpdf.callMain(args);
  } catch {
    /* qpdf may exit() on error — output presence is the real signal */
  }
  let out: Uint8Array | null = null;
  try {
    out = qpdf.FS.readFile('/out.pdf');
  } catch {
    out = null;
  }
  return { out, err };
}

/** Password-protect a PDF (AES-256) with qpdf. The password becomes user + owner. */
export async function protectPdf(
  file: File,
  _onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const password = String(params?.password ?? '').trim();
  if (!password) throw new Error('Enter a password to protect the PDF.');
  const { out } = await runQpdf(await file.arrayBuffer(), [
    '--encrypt', password, password, '256', '--', '/in.pdf', '/out.pdf',
  ]);
  if (!out) throw new Error('Could not protect this PDF — it may already be encrypted.');
  return {
    blob: new Blob([out], { type: 'application/pdf' }),
    filename: addSuffix(file.name, '-protected'),
    note: 'Protected with AES-256. Keep the password safe — it cannot be recovered.',
  };
}

/** Remove a password from a PDF you can open (qpdf --decrypt). */
export async function removePdfPassword(
  file: File,
  _onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const password = String(params?.password ?? '');
  const { out, err } = await runQpdf(await file.arrayBuffer(), [
    `--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf',
  ]);
  if (!out) {
    if (/password|invalid|incorrect/i.test(err)) throw new Error('Wrong password for this PDF.');
    throw new Error("Could not unlock — is this PDF actually password-protected?");
  }
  return {
    blob: new Blob([out], { type: 'application/pdf' }),
    filename: addSuffix(file.name, '-unlocked'),
  };
}

/** Stamp a text watermark across every page of a PDF (pdf-lib). */
export async function watermarkPdf(
  file: File,
  _onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');
  const text = String(params?.text ?? '').trim() || 'WATERMARK';
  const opacity = Math.max(0.03, Math.min(1, Number(params?.opacity ?? 35) / 100));
  const position = String(params?.position ?? 'diagonal');

  const doc = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const base = { font, color: rgb(0.5, 0.5, 0.5), opacity };

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const min = Math.min(width, height);
    if (position === 'center') {
      const size = Math.max(14, min * 0.07);
      page.drawText(text, { ...base, size, x: (width - font.widthOfTextAtSize(text, size)) / 2, y: height / 2 });
    } else if (position === 'bottom-right') {
      const size = Math.max(10, min * 0.035);
      page.drawText(text, { ...base, size, x: width - font.widthOfTextAtSize(text, size) - 24, y: 24 });
    } else if (position === 'tile') {
      const size = Math.max(10, min * 0.035);
      const tw = font.widthOfTextAtSize(text, size);
      const stepX = tw + size * 4;
      const stepY = size * 6;
      for (let y = 0; y < height + stepY; y += stepY) {
        for (let x = -tw; x < width; x += stepX) page.drawText(text, { ...base, size, x, y, rotate: degrees(35) });
      }
    } else {
      const size = Math.max(18, min * 0.08);
      page.drawText(text, { ...base, size, x: width * 0.12, y: height * 0.32, rotate: degrees(40) });
    }
  }

  const out = await doc.save();
  return {
    blob: new Blob([out], { type: 'application/pdf' }),
    filename: addSuffix(file.name, '-watermarked'),
  };
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
