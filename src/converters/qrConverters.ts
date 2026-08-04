import type { Encoded } from '@nuintun/qrcode';
import type { ConversionResult, ParamValues, ProgressFn } from './types';
import { replaceExt } from '../lib/strings';

type QrModule = typeof import('@nuintun/qrcode');

const PNG_SIZE = 1024;
const PREVIEW_SIZE = 256;
const QUIET_ZONE = 4;
const MAX_CANDIDATES = 16;
const READ_BUDGET_MS = 6000;

let qrModule: Promise<QrModule> | null = null;

function loadQr(): Promise<QrModule> {
  if (!qrModule) {
    // Caching the promise would also cache a rejection, so one flaky chunk fetch would
    // break every later call for the life of the page. Drop the cache and let it retry.
    qrModule = import('@nuintun/qrcode').catch((error) => {
      qrModule = null;
      throw error;
    });
  }
  return qrModule;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

async function encodeText(text: string): Promise<Encoded> {
  const { Byte, Charset, Encoder } = await loadQr();
  // ISO-8859-1 is the QR byte-mode default, so ASCII needs no ECI header and stays
  // readable on the oldest scanners. Anything else must declare ECI 26 (UTF-8).
  const segment = isAscii(text) ? new Byte(text) : new Byte(text, Charset.UTF_8);
  return new Encoder({ level: 'M' }).encode(segment);
}

function drawQr(encoded: Encoded, pixels: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixels;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pixels, pixels);
  ctx.fillStyle = '#000000';

  const size = encoded.size;
  const scale = pixels / (size + QUIET_ZONE * 2);
  for (let y = 0; y < size; y++) {
    const top = Math.round((y + QUIET_ZONE) * scale);
    const bottom = Math.round((y + QUIET_ZONE + 1) * scale);
    for (let x = 0; x < size; x++) {
      if (!encoded.get(x, y)) continue;
      // Rounding both edges keeps neighbouring modules flush at fractional scales.
      const left = Math.round((x + QUIET_ZONE) * scale);
      const right = Math.round((x + QUIET_ZONE + 1) * scale);
      ctx.fillRect(left, top, right - left, bottom - top);
    }
  }
  return canvas;
}

// canvas.toBlob fires its callback through the throttled task queue, so it costs about
// a second once the page is backgrounded (measured), which is exactly what happens when
// someone taps Generate and switches apps. toDataURL is synchronous and immune.
function canvasToPng(canvas: HTMLCanvasElement): Blob {
  const dataUrl = canvas.toDataURL('image/png');
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export async function makeQrCode(params?: ParamValues): Promise<ConversionResult> {
  const raw = params?.text;
  const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  if (!text.trim()) {
    throw new Error('Type something to turn into a QR code: a link, a UPI id, a phone number, any text.');
  }

  let encoded: Encoded;
  try {
    encoded = await encodeText(text);
  } catch {
    throw new Error('That is too much text for one QR code. Try shortening it to a link or a few lines.');
  }

  const blob = canvasToPng(drawQr(encoded, PNG_SIZE));
  return {
    blob,
    filename: 'qr-code.png',
    note: `Made on your device. The code holds your text directly, so there is no short link, no redirect and no tracking: ${PNG_SIZE}x${PNG_SIZE} PNG, error correction M.`,
  };
}

export async function qrPreviewDataUrl(text: string): Promise<string> {
  if (typeof text !== 'string' || !text.trim()) return '';
  try {
    const encoded = await encodeText(text);
    return drawQr(encoded, PREVIEW_SIZE).toDataURL('image/png');
  } catch {
    return '';
  }
}

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
      reject(new Error('Could not open this image. The format may be unsupported by your browser.'));
    };
    img.src = url;
  });
}

interface Raster {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  w: number;
  h: number;
}

function decodePlans(w: number, h: number): Raster[] {
  const plans: Raster[] = [];
  const longest = Math.max(w, h);

  const whole = (targetLongEdge: number) => {
    const s = targetLongEdge / longest;
    plans.push({ sx: 0, sy: 0, sw: w, sh: h, w: Math.round(w * s), h: Math.round(h * s) });
  };

  // Downscales run BEFORE the native raster on purpose. Averaging pixels suppresses
  // camera noise, and a noisy full-size photo sends the detector chasing dozens of
  // false finder patterns for seconds, while the same photo at 1000px decodes at once.
  if (longest > 1150) whole(1000);
  if (longest > 1840) whole(1600);
  whole(longest);
  if (longest > 736) whole(640);
  if (longest < 500) whole(longest * 2);
  if (longest < 250) whole(longest * 3);

  const cw = Math.round(w * 0.6);
  const ch = Math.round(h * 0.6);
  const cs = Math.min(3, Math.max(1, 1000 / Math.max(cw, ch)));
  plans.push({
    sx: Math.round((w - cw) / 2),
    sy: Math.round((h - ch) / 2),
    sw: cw,
    sh: ch,
    w: Math.round(cw * cs),
    h: Math.round(ch * cs),
  });

  const seen = new Set<string>();
  return plans.filter((p) => {
    if (p.w < 40 || p.h < 40 || p.w > 4200 || p.h > 4200) return false;
    const key = `${p.sx},${p.sy},${p.sw},${p.sh},${p.w},${p.h}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rasterize(img: HTMLImageElement, p: Raster): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = p.w;
  canvas.height = p.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  // Transparent PNGs otherwise grayscale to solid black and never binarize.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, p.w, p.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.w, p.h);
  return ctx.getImageData(0, 0, p.w, p.h);
}

function invert(luminances: Uint8Array): Uint8Array {
  const out = new Uint8Array(luminances.length);
  for (let i = 0; i < luminances.length; i++) out[i] = 255 - luminances[i];
  return out;
}

function scan(mod: QrModule, luminances: Uint8Array, w: number, h: number, deadline: number): string | null {
  let matrix;
  try {
    matrix = mod.binarize(luminances, w, h);
  } catch {
    return null;
  }

  const detected = new mod.Detector().detect(matrix);
  const decoder = new mod.Decoder();
  let step = detected.next();
  let seen = 0;

  while (!step.done && seen++ < MAX_CANDIDATES) {
    let succeed = false;
    try {
      const content = decoder.decode(step.value.matrix).content;
      if (content) return content;
      succeed = true;
    } catch {
      succeed = false;
    }
    // Real codes land on the detector's first candidate or two. Grinding through a
    // noisy image's false finder patterns costs seconds and never pays off.
    if (performance.now() > deadline) break;
    // The generator prunes its search when told the last candidate decoded.
    step = detected.next(succeed);
  }
  return null;
}

// setTimeout is clamped to >=1s (and can be frozen outright) once the page is
// backgrounded, which on Android happens the moment the user switches apps mid-read.
// A MessageChannel message is a macrotask that no throttling applies to.
function tick(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

export async function readQrCode(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  onProgress?.(0.02);
  const img = await loadImage(file);
  const mod = await loadQr();
  onProgress?.(0.08);

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('This image appears to be empty.');

  const plans = decodePlans(w, h);
  const deadline = performance.now() + READ_BUDGET_MS;
  let text: string | null = null;

  for (let i = 0; i < plans.length && text === null; i++) {
    const plan = plans[i];
    const luminances = mod.grayscale(rasterize(img, plan));
    text = scan(mod, luminances, plan.w, plan.h, deadline);
    if (text === null) text = scan(mod, invert(luminances), plan.w, plan.h, deadline);
    onProgress?.(0.08 + (0.87 * (i + 1)) / plans.length);
    if (text === null) {
      if (performance.now() > deadline) break;
      await tick();
    }
  }

  if (text === null) {
    throw new Error(
      'No QR code found in this image. Try a sharper, closer photo with the whole code in frame and even lighting.',
    );
  }

  onProgress?.(1);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  return {
    blob,
    filename: replaceExt(file.name, 'txt'),
    note: `Read on your device: ${text.length} character${text.length === 1 ? '' : 's'}. Nothing was opened or visited.`,
    view: { kind: 'text', text },
  };
}
