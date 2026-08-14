import type { ConversionResult, PagePlan, ParamValues, ProgressFn } from './types';
import { asPagePlan } from './types';
import { addSuffix, replaceExt } from '../lib/strings';
import { getInsert } from '../lib/insertStore';
import { blobBytes } from '../lib/bytes';

/** How many pages the document has, so the UI can build its initial plan. */
export async function pdfPageCount(file: File): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  return doc.getPageCount();
}

/** Turn an inserted image into a one-page PDF so it can be copied like any other. */
async function imageToPdfDoc(file: File) {
  const { PDFDocument } = await import('pdf-lib');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await PDFDocument.create();
  const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
  let img;
  try {
    img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    // WebP/BMP and friends are not embeddable directly, so go via a canvas.
    const bmp = await createImageBitmap(new Blob([bytes]));
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    cv.getContext('2d')!.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
    if (!png) throw new Error(`Could not read the image "${file.name}".`);
    img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
  }
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return doc;
}

/**
 * Rebuild a PDF from an explicit list of pages: delete by leaving a page out,
 * reorder by moving it, insert by referencing another file, rotate per page.
 */
export async function organisePdf(
  file: File,
  onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const plan: PagePlan = asPagePlan(params?.plan);

  const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  const originalCount = source.getPageCount();

  if (!plan.pages.length) {
    throw new Error('That would delete every page. Keep at least one.');
  }

  // Load each inserted file once, whatever how many of its pages are used.
  const docs = new Map<string, Awaited<ReturnType<typeof PDFDocument.create>>>();
  docs.set('', source);
  for (const p of plan.pages) {
    if (!p.src || docs.has(p.src)) continue;
    const f = getInsert(p.src);
    if (!f) throw new Error('One of the inserted files is no longer available. Add it again.');
    const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    docs.set(p.src, isPdf ? await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true }) : await imageToPdfDoc(f));
  }

  const out = await PDFDocument.create();

  // Copy in contiguous runs from the same source. The common case is one run
  // covering the whole document, so this is a single copyPages call rather than
  // one per page, which matters on a document of a few hundred pages.
  let i = 0;
  let done = 0;
  while (i < plan.pages.length) {
    const src = plan.pages[i].src;
    const run: typeof plan.pages = [];
    while (i < plan.pages.length && plan.pages[i].src === src) {
      run.push(plan.pages[i]);
      i++;
    }
    const doc = docs.get(src)!;
    const max = doc.getPageCount();
    const indices = run.map((p) => Math.min(Math.max(0, p.index), max - 1));
    const copied = await out.copyPages(doc, indices);
    copied.forEach((page, k) => {
      const extra = run[k].rotate % 360;
      if (extra) {
        const current = page.getRotation().angle;
        page.setRotation(degrees((((current + extra) % 360) + 360) % 360));
      }
      out.addPage(page);
    });
    done += run.length;
    onProgress?.(Math.min(0.99, done / plan.pages.length));
  }

  const bytes = await out.save();
  const kept = plan.pages.filter((p) => !p.src).length;
  const inserted = plan.pages.length - kept;
  const removed = originalCount - new Set(plan.pages.filter((p) => !p.src).map((p) => p.index)).size;
  const rotated = plan.pages.filter((p) => p.rotate % 360 !== 0).length;

  const bits: string[] = [`${plan.pages.length} page${plan.pages.length === 1 ? '' : 's'} in the new file.`];
  if (removed > 0) bits.push(`${removed} removed.`);
  if (inserted > 0) bits.push(`${inserted} added from another file.`);
  if (rotated > 0) bits.push(`${rotated} rotated.`);

  return {
    blob: new Blob([blobBytes(bytes)], { type: 'application/pdf' }),
    filename: addSuffix(replaceExt(file.name, 'pdf'), '-organised'),
    note: bits.join(' '),
  };
}
