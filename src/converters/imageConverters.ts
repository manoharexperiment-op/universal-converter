import { Capacitor } from '@capacitor/core';
import type { ConversionResult, ParamValues, ProgressFn } from './types';
import { addSuffix, formatBytes, pctSmaller, replaceExt, stripExt } from '../lib/strings';

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

const IMAGE_PRESETS: Record<string, { quality: number; maxDimension?: number }> = {
  high: { quality: 0.92 },
  balanced: { quality: 0.8, maxDimension: 2560 },
  small: { quality: 0.65, maxDimension: 1920 },
  tiny: { quality: 0.5, maxDimension: 1280 },
};

/** Scale (w,h) so the longer edge fits `maxDim`; never upscales. */
function fitWithin(w: number, h: number, maxDim?: number) {
  if (!maxDim || Math.max(w, h) <= maxDim) return { w, h };
  const s = maxDim / Math.max(w, h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/**
 * Compress an image: optionally downscale, then re-encode as JPEG or WebP at a
 * preset quality. Returns the original untouched if compression wouldn't help.
 */
export async function compressImage(
  file: File,
  _onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const level = String(params?.level ?? 'balanced');
  const format = String(params?.format ?? 'jpeg');
  const preset = IMAGE_PRESETS[level] ?? IMAGE_PRESETS.balanced;

  const img = await loadImage(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const downscaled = !!preset.maxDimension && longest > preset.maxDimension;
  const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, preset.maxDimension);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.fillStyle = '#ffffff'; // JPEG/flatten: avoid black transparency
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const useWebp = format === 'webp';
  const blob = await canvasToBlob(canvas, useWebp ? 'image/webp' : 'image/jpeg', preset.quality);
  const ext = useWebp ? 'webp' : 'jpg';

  // If we didn't downscale and the re-encode isn't smaller, keep the original.
  if (!downscaled && blob.size >= file.size) {
    return {
      blob: file,
      filename: file.name,
      note: `Already optimized — kept your original (${formatBytes(file.size)}). Re-compressing wouldn't shrink it.`,
    };
  }
  return {
    blob,
    filename: addSuffix(replaceExt(file.name, ext), '-compressed'),
    note: `Compressed ${formatBytes(file.size)} → ${formatBytes(blob.size)} (${pctSmaller(file.size, blob.size)}% smaller).`,
  };
}

/** Extract text from an image using on-device OCR (Tesseract.js / WASM). */
export async function imageToText(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const Tesseract = (await import('tesseract.js')).default;
  // Absolute URLs (with origin) so the blob worker can resolve them — root-
  // relative paths fail inside a blob: worker.
  const base = window.location.origin;
  // The language data ships as eng.traineddata.gz. On the web that .gz is served
  // as-is (gzip: true). But Android's APK packager (AAPT) auto-decompresses any
  // .gz asset and strips the extension, so inside the native app the file is
  // plain eng.traineddata — request it with gzip: false, or Tesseract fetches a
  // .gz that doesn't exist and hangs forever at "recognizing".
  const native = Capacitor.isNativePlatform();
  const { data } = await Tesseract.recognize(file, 'eng', {
    // Self-hosted worker / core / language data (in /public/tesseract) — OCR
    // never contacts a third-party CDN, so it works offline & fully private.
    workerPath: `${base}/tesseract/worker.min.js`,
    corePath: `${base}/tesseract`,
    langPath: `${base}/tesseract/lang`,
    gzip: !native,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  return {
    blob: new Blob([data.text], { type: 'text/plain;charset=utf-8' }),
    filename: replaceExt(file.name, 'txt'),
  };
}
