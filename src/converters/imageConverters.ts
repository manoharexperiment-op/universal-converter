import type { ConversionResult, ProgressFn } from './types';
import { replaceExt } from '../lib/strings';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Decode an image File into an <img> element using an object URL. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode this image. The format may be unsupported by your browser.'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed.'))),
      mime,
      quality,
    );
  });
}

/** Convert between raster image formats (PNG / JPG / WebP) via the Canvas API. */
export async function convertImageFormat(file: File, target: string): Promise<ConversionResult> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');

  // JPEG has no alpha channel — flatten transparency onto white first.
  if (target === 'jpg' || target === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);

  const mime = MIME[target] ?? 'image/png';
  const blob = await canvasToBlob(canvas, mime);
  return { blob, filename: replaceExt(file.name, target) };
}

/** Wrap an image in a single-page PDF sized exactly to the image. */
export async function imageToPdf(file: File): Promise<ConversionResult> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();

  let embedded;
  if (file.type === 'image/png') {
    embedded = await pdf.embedPng(new Uint8Array(await file.arrayBuffer()));
  } else if (file.type === 'image/jpeg') {
    embedded = await pdf.embedJpg(new Uint8Array(await file.arrayBuffer()));
  } else {
    // pdf-lib only embeds PNG/JPEG — normalize anything else (webp/bmp/gif) to PNG.
    const png = await convertImageFormat(file, 'png');
    embedded = await pdf.embedPng(new Uint8Array(await png.blob.arrayBuffer()));
  }

  const page = pdf.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });

  const bytes = await pdf.save();
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    filename: replaceExt(file.name, 'pdf'),
  };
}

/** Extract text from an image using on-device OCR (Tesseract.js / WASM). */
export async function imageToText(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const Tesseract = (await import('tesseract.js')).default;
  const { data } = await Tesseract.recognize(file, 'eng', {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  return {
    blob: new Blob([data.text], { type: 'text/plain;charset=utf-8' }),
    filename: replaceExt(file.name, 'txt'),
  };
}
