import type { ConversionResult, ParamControl, ParamValues, ProgressFn } from './types';
import { addSuffix, replaceExt } from '../lib/strings';
import { blobBytes } from '../lib/bytes';

/**
 * Make a clean digital document look like it came off a flatbed scanner.
 *
 * The giveaway of a "fake scan" is uniformity: the same tilt on every page, a
 * pure white background, perfectly even lighting. Real scans vary page to page,
 * sit on slightly grey paper, pick up sensor grain, and darken toward the edges
 * where the lid does not press flat. Each page here gets its own tilt and its
 * own noise, which is what sells it.
 */

export const SCAN_PARAMS: ParamControl[] = [
  {
    kind: 'select', key: 'level', label: 'How rough', default: 'medium',
    options: [
      { value: 'light', label: 'Light, a good office scanner' },
      { value: 'medium', label: 'Medium, an everyday scan' },
      { value: 'heavy', label: 'Heavy, an old or tired machine' },
    ],
  },
  {
    kind: 'select', key: 'colour', label: 'Colour', default: 'grey',
    options: [
      { value: 'grey', label: 'Greyscale (most scans look like this)' },
      { value: 'colour', label: 'Keep the colours' },
    ],
  },
  {
    kind: 'select', key: 'skew', label: 'Page tilt', default: 'slight',
    options: [
      { value: 'slight', label: 'Slightly crooked' },
      { value: 'none', label: 'Perfectly straight' },
      { value: 'wonky', label: 'Noticeably crooked' },
    ],
  },
];

interface ScanStyle {
  /** Peak tilt in degrees. */
  tilt: number;
  /** Grain strength, 0..255 of luminance wobble. */
  grain: number;
  contrast: number;
  brightness: number;
  blurPx: number;
  /** How dark the edges go, 0..1. */
  vignette: number;
  /** Paper tone. Real scans are never pure white. */
  paper: string;
  grey: boolean;
}

function styleFor(level: string, colour: string, skew: string): ScanStyle {
  const base: ScanStyle =
    level === 'light'
      ? { tilt: 0.4, grain: 6, contrast: 1.06, brightness: 1.02, blurPx: 0.2, vignette: 0.05, paper: '#fdfdfb', grey: false }
      : level === 'heavy'
        ? { tilt: 1.6, grain: 20, contrast: 1.28, brightness: 0.96, blurPx: 0.7, vignette: 0.20, paper: '#f4f1e8', grey: false }
        : { tilt: 0.9, grain: 12, contrast: 1.15, brightness: 0.99, blurPx: 0.4, vignette: 0.11, paper: '#faf8f2', grey: false };
  base.grey = colour !== 'colour';
  if (skew === 'none') base.tilt = 0;
  else if (skew === 'wonky') base.tilt = Math.max(base.tilt, 1.8);
  return base;
}

/** Sprinkle sensor grain and darken the edges, both of which a canvas filter cannot do. */
function grainAndVignette(ctx: CanvasRenderingContext2D, w: number, h: number, style: ScanStyle): void {
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const cx = w / 2;
  const cy = h / 2;
  const maxDist = Math.hypot(cx, cy);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Grain: one value per pixel so it reads as luminance noise, not colour
      // confetti, which is what a real sensor produces.
      const n = (Math.random() - 0.5) * style.grain * 2;
      // Edges fall off gently; the corners of a scan are always the darkest.
      const d = Math.hypot(x - cx, y - cy) / maxDist;
      const shade = 1 - style.vignette * Math.pow(d, 2.4);
      for (let c = 0; c < 3; c++) {
        px[i + c] = Math.max(0, Math.min(255, (px[i + c] + n) * shade));
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Draw `source` onto a fresh canvas as though it had been scanned. */
export function scanRender(
  source: CanvasImageSource,
  width: number,
  height: number,
  style: ScanStyle,
): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = style.paper;
  ctx.fillRect(0, 0, width, height);

  const filters: string[] = [];
  if (style.grey) filters.push('grayscale(1)');
  filters.push(`contrast(${style.contrast})`, `brightness(${style.brightness})`);
  if (style.blurPx > 0) filters.push(`blur(${style.blurPx}px)`);
  ctx.filter = filters.join(' ');

  // A real page never sits square on the glass. Rotating about the centre and
  // scaling down very slightly keeps the corners on the paper instead of
  // slicing them off.
  const angle = style.tilt ? ((Math.random() * 2 - 1) * style.tilt * Math.PI) / 180 : 0;
  const shrink = style.tilt ? 1 - Math.abs(Math.sin(angle)) * 1.6 - 0.004 : 1;
  ctx.translate(width / 2, height / 2);
  if (angle) ctx.rotate(angle);
  ctx.scale(shrink, shrink);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';

  if (style.grain > 0 || style.vignette > 0) grainAndVignette(ctx, width, height, style);
  return cv;
}

function styleFromParams(params?: ParamValues): ScanStyle {
  return styleFor(String(params?.level ?? 'medium'), String(params?.colour ?? 'grey'), String(params?.skew ?? 'slight'));
}

async function canvasToJpeg(cv: HTMLCanvasElement, quality: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not produce the scanned image.');
  return blob;
}

/** Give a photo or picture the look of a scanned page. */
export async function scanImage(
  file: File,
  onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const style = styleFromParams(params);
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('That image could not be read.');
  });
  onProgress?.(0.4);
  const cv = scanRender(bmp, bmp.width, bmp.height, style);
  onProgress?.(0.9);
  // Scanners hand back JPEGs, and the slight compression is part of the look.
  const blob = await canvasToJpeg(cv, 0.86);
  onProgress?.(1);
  return {
    blob,
    filename: addSuffix(replaceExt(file.name, 'jpg'), '-scanned'),
    note: `Made to look scanned${style.grey ? ' in greyscale' : ''}. The tilt and grain are random, so running it again gives a different result.`,
  };
}

/**
 * Rasterise every page and put them back into a PDF.
 *
 * The text layer necessarily goes: a scan has no selectable text, and keeping
 * it would give the trick away instantly to anyone who tried to select a word.
 */
export async function scanPdf(
  file: File,
  onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  const style = styleFromParams(params);
  const pdfjs = (await import('../lib/pdfjs')).default;
  const { PDFDocument } = await import('pdf-lib');

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = await PDFDocument.create();
  // 150 dpi is what a desktop scanner defaults to, and it keeps a long document
  // inside the memory a phone can spare.
  const scale = 150 / 72;

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale });
    const render = document.createElement('canvas');
    render.width = Math.ceil(vp.width);
    render.height = Math.ceil(vp.height);
    const rctx = render.getContext('2d')!;
    rctx.fillStyle = '#ffffff';
    rctx.fillRect(0, 0, render.width, render.height);
    // 'print' avoids the rAF-driven path, which stalls in a background tab.
    await page.render({ canvasContext: rctx, viewport: vp, intent: 'print' }).promise;

    const scanned = scanRender(render, render.width, render.height, style);
    const jpeg = await canvasToJpeg(scanned, 0.82);
    const img = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    // Back to the original point size, so the PDF measures the same as before.
    const pdfPage = out.addPage([vp.width / scale, vp.height / scale]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: pdfPage.getWidth(), height: pdfPage.getHeight() });
    onProgress?.(n / doc.numPages);
  }

  const bytes = await out.save();
  return {
    blob: new Blob([blobBytes(bytes)], { type: 'application/pdf' }),
    filename: addSuffix(replaceExt(file.name, 'pdf'), '-scanned'),
    note:
      `${doc.numPages} page${doc.numPages === 1 ? '' : 's'} made to look scanned. ` +
      'Each page is tilted differently, the way a real scan is. The text is now part of the picture, so it can no longer be selected or searched.',
  };
}
