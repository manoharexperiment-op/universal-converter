/**
 * Drawing text onto a PDF page in any language.
 *
 * PDF standard fonts are WinAnsi (CP1252) only, so pdf-lib throws
 * `WinAnsi cannot encode` on the rupee sign, Devanagari, Tamil, emoji and
 * everything else outside that set. Embedding a Unicode font would cost fontkit
 * (~1.2 MB) plus a multi-megabyte font file per script. Instead we fall back to
 * rendering the text to a transparent PNG using whatever fonts the device
 * already has, then stamping that image. Covers every language, adds nothing to
 * the bundle, and Latin text still goes through as real selectable text.
 */

type AnyPage = {
  drawText(text: string, opts: Record<string, unknown>): void;
  drawImage(img: unknown, opts: Record<string, unknown>): void;
};

type AnyDoc = {
  embedFont(font: unknown): Promise<{ widthOfTextAtSize(t: string, s: number): number }>;
  embedPng(bytes: Uint8Array): Promise<unknown>;
};

export interface TextStamp {
  /** Width in PDF points when drawn at `size`. */
  widthAt(size: number): number;
  /** Draw with the text's baseline-left corner at (x, y). */
  draw(page: AnyPage, o: { x: number; y: number; size: number; rotateDeg?: number; opacity?: number }): void;
  /** True when the text had to be rasterized because the font couldn't encode it. */
  rasterized: boolean;
}

/** Canvas pixel size used for the rasterized fallback; metrics are stored per-em. */
const RASTER_EM = 96;

/** True when a pdf-lib standard font can encode every character in `text`. */
function canEncode(font: { widthOfTextAtSize(t: string, s: number): number }, text: string): boolean {
  try {
    font.widthOfTextAtSize(text, 12);
    return true;
  } catch {
    return false;
  }
}

/** Render `text` tight to its ink box; metrics come back relative to the em size. */
function rasterizeText(text: string, cssColor: string, bold: boolean) {
  const spec = `${bold ? 'bold ' : ''}${RASTER_EM}px sans-serif`;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) throw new Error('Canvas is not available in this browser.');
  probe.font = spec;

  const m = probe.measureText(text);
  const pad = 2;
  const left = Math.ceil(Math.abs(m.actualBoundingBoxLeft ?? 0)) + pad;
  const right = Math.ceil(Math.abs(m.actualBoundingBoxRight ?? m.width)) + pad;
  const ascent = Math.ceil(Math.abs(m.actualBoundingBoxAscent ?? RASTER_EM)) + pad;
  const descent = Math.ceil(Math.abs(m.actualBoundingBoxDescent ?? 0)) + pad;
  const w = Math.max(1, left + right);
  const h = Math.max(1, ascent + descent);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.font = spec;
  ctx.fillStyle = cssColor;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, left, ascent);

  return { canvas, wEm: w / RASTER_EM, hEm: h / RASTER_EM, descentEm: descent / RASTER_EM };
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('Could not render the text.'))),
      'image/png',
    ),
  );
}

/** Build a stamp that draws `text`, transparently falling back to an image. */
export async function makeTextStamp(
  doc: unknown,
  text: string,
  style: { color: [number, number, number]; bold?: boolean },
): Promise<TextStamp> {
  const { StandardFonts, rgb, degrees } = await import('pdf-lib');
  const d = doc as AnyDoc;
  const [r, g, b] = style.color;
  const font = await d.embedFont(style.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);

  if (canEncode(font, text)) {
    return {
      rasterized: false,
      widthAt: (size) => font.widthOfTextAtSize(text, size),
      draw: (page, o) =>
        page.drawText(text, {
          x: o.x,
          y: o.y,
          size: o.size,
          font,
          color: rgb(r, g, b),
          opacity: o.opacity ?? 1,
          ...(o.rotateDeg ? { rotate: degrees(o.rotateDeg) } : {}),
        }),
    };
  }

  const css = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
  const { canvas, wEm, hEm, descentEm } = rasterizeText(text, css, !!style.bold);
  const png = await d.embedPng(await canvasPng(canvas));
  canvas.width = 0;
  canvas.height = 0;

  return {
    rasterized: true,
    widthAt: (size) => wEm * size,
    draw: (page, o) => {
      // pdf-lib anchors an image at its bottom-left and rotates about that point,
      // while drawText anchors at the baseline. Shift down by the descent so both
      // paths land identically, rotating the shift along with the stamp.
      const th = ((o.rotateDeg ?? 0) * Math.PI) / 180;
      const dy = descentEm * o.size;
      page.drawImage(png, {
        x: o.x + dy * Math.sin(th),
        y: o.y - dy * Math.cos(th),
        width: wEm * o.size,
        height: hEm * o.size,
        opacity: o.opacity ?? 1,
        ...(o.rotateDeg ? { rotate: degrees(o.rotateDeg) } : {}),
      });
    },
  };
}
