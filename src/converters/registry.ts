import type { TargetOption } from './types';
import * as img from './imageConverters';
import * as pdf from './pdfConverters';
import * as doc from './documentConverters';
import * as sheet from './spreadsheetConverters';

/** Image inputs the browser can reliably decode via <img>/Canvas. */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

/** Map a filename to an internal source type, or null if unsupported. */
export function getSourceType(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

/** All conversions available for each source type. */
export const REGISTRY: Record<string, TargetOption[]> = {
  image: [
    { target: 'png', label: 'PNG', run: (f) => img.convertImageFormat(f, 'png') },
    { target: 'jpg', label: 'JPG', run: (f) => img.convertImageFormat(f, 'jpg') },
    { target: 'webp', label: 'WebP', run: (f) => img.convertImageFormat(f, 'webp') },
    { target: 'pdf', label: 'PDF', run: (f) => img.imageToPdf(f) },
    { target: 'txt', label: 'Text (OCR)', note: 'Reads text out of the image on-device', run: (f, p) => img.imageToText(f, p) },
  ],
  pdf: [
    { target: 'png', label: 'PNG', note: 'One image per page (zipped if multiple)', run: (f, p) => pdf.pdfToImages(f, 'png', p) },
    { target: 'jpg', label: 'JPG', note: 'One image per page (zipped if multiple)', run: (f, p) => pdf.pdfToImages(f, 'jpg', p) },
    { target: 'txt', label: 'Text', run: (f, p) => pdf.pdfToText(f, p) },
    { target: 'docx', label: 'Word', note: 'Text-level — complex layouts/tables are flattened', run: (f, p) => pdf.pdfToDocx(f, p) },
    { target: 'pdf', label: 'Rotate 90°', note: 'Rotates every page 90° clockwise', run: (f) => pdf.pdfRotate(f, 90) },
    { target: 'zip', label: 'Split pages', note: 'Each page as its own PDF (zipped)', run: (f, p) => pdf.pdfSplit(f, p) },
  ],
  docx: [
    { target: 'pdf', label: 'PDF', note: 'Text + headings; advanced styling simplified', run: (f) => doc.docxToPdf(f) },
    { target: 'txt', label: 'Text', run: (f) => doc.docxToText(f) },
    { target: 'html', label: 'HTML', run: (f) => doc.docxToHtml(f) },
  ],
  xlsx: [{ target: 'csv', label: 'CSV', note: 'Exports the first sheet', run: (f) => sheet.xlsxToCsv(f) }],
  csv: [{ target: 'xlsx', label: 'Excel', run: (f) => sheet.csvToXlsx(f) }],
  txt: [{ target: 'pdf', label: 'PDF', run: (f) => doc.txtToPdf(f) }],
  md: [
    { target: 'pdf', label: 'PDF', run: (f) => doc.markdownToPdf(f) },
    { target: 'html', label: 'HTML', run: (f) => doc.markdownToHtml(f) },
  ],
  html: [{ target: 'pdf', label: 'PDF', note: 'Text + headings; CSS layout simplified', run: (f) => doc.htmlToPdf(f) }],
};
