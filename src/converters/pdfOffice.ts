import type { ConversionResult, ProgressFn, ViewGroup, ViewRow } from './types';
import { replaceExt } from '../lib/strings';
import { imageToText } from './imageConverters';

/**
 * PDF -> Word / Excel with layout reconstruction.
 *
 * Three things make this better than dumping the text layer: lines are clustered
 * with a tolerance derived from the font size, hard-wrapped lines are rejoined
 * into real paragraphs, and runs keep their weight/style/size so headings survive.
 * Pages with no text layer are OCR'd instead of silently coming out empty.
 * Tables are only recognised where the PDF actually draws a ruled grid.
 */

type Mat = [number, number, number, number, number, number];

interface Piece {
  x0: number;
  x1: number;
  y: number;
  fs: number;
  bold: boolean;
  italic: boolean;
  str: string;
  /** pdf.js font id, resolved to a real weight/style only once the op list ran. */
  fk: string;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  fs: number;
}

interface Line {
  y: number;
  x0: number;
  x1: number;
  fs: number;
  boldShare: number;
  pieces: Piece[];
  text: string;
}

interface Grid {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: string[][];
}

interface PageInfo {
  index: number;
  width: number;
  height: number;
  lines: Line[];
  grids: Grid[];
  ocr: boolean;
  leftEdge: number;
  rightEdge: number;
}

interface DocStats {
  bodyFs: number;
  headingSizes: number[];
}

type Block =
  | { y: number; kind: 'para'; heading: 0 | 1 | 2 | 3; runs: Run[] }
  | { y: number; kind: 'table'; cells: string[][] };

function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function px(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/* ---------------------------------------------------------------- fonts --- */

/**
 * pdf.js only fills in font.bold / font.italic for fonts it had to substitute.
 * For embedded fonts the flags are undefined, so the PostScript name (which IS
 * exported) is the only remaining signal. Neither works for fully subsetted
 * fonts with opaque names, which is why heading detection also uses font size.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFontStyle(commonObjs: any, id: string): { bold: boolean; italic: boolean } {
  let bold = false;
  let italic = false;
  try {
    if (commonObjs?.has?.(id)) {
      const f = commonObjs.get(id);
      const name = String(f?.name ?? '');
      const weight = Number(f?.cssFontInfo?.fontWeight ?? 0);
      bold = !!f?.bold || !!f?.black || weight >= 600 || /bold|black|heavy|semib|demib/i.test(name);
      italic = !!f?.italic || /italic|oblique/i.test(name);
    }
  } catch {
    /* unresolved font: fall back to size-based detection */
  }
  return { bold, italic };
}

/* ----------------------------------------------------------- text layer --- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function piecesFromContent(content: any, vt: Mat): Piece[] {
  const out: Piece[] = [];
  for (const raw of content.items ?? []) {
    const it = raw as { str?: string; width?: number; transform?: number[]; fontName?: string };
    if (typeof it.str !== 'string' || it.str === '' || !it.transform) continue;
    const m = mul(vt, it.transform as Mat);
    const fs = Math.hypot(m[2], m[3]);
    if (!(fs > 0)) continue;
    // Skip rotated/vertical text: it would shred the line clustering, and in
    // practice it is a diagonal watermark or a side label, not body copy.
    if (Math.abs(m[1]) > Math.abs(m[0]) * 0.36) continue;

    const w = Math.abs((it.width ?? 0) * Math.hypot(vt[0], vt[1]));
    out.push({ x0: m[4], x1: m[4] + w, y: m[5], fs, bold: false, italic: false, str: it.str, fk: it.fontName ?? '' });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFontStyles(pieces: Piece[], commonObjs: any): void {
  const cache = new Map<string, { bold: boolean; italic: boolean }>();
  for (const p of pieces) {
    let st = cache.get(p.fk);
    if (!st) {
      st = readFontStyle(commonObjs, p.fk);
      cache.set(p.fk, st);
    }
    p.bold = st.bold;
    p.italic = st.italic;
  }
}

function runsFromPieces(ps: Piece[]): Run[] {
  const sorted = [...ps].sort((a, b) => a.x0 - b.x0);
  const runs: Run[] = [];
  let prev: Piece | null = null;
  for (const p of sorted) {
    let s = p.str;
    const tail = runs.length ? runs[runs.length - 1].text : '';
    if (prev && p.x0 - prev.x1 > 0.18 * Math.max(prev.fs, p.fs) && !/\s$/.test(tail) && !/^\s/.test(s)) {
      s = ' ' + s;
    }
    const last = runs[runs.length - 1];
    if (last && last.bold === p.bold && last.italic === p.italic && roundHalf(last.fs) === roundHalf(p.fs)) {
      last.text += s;
    } else {
      runs.push({ text: s, bold: p.bold, italic: p.italic, fs: p.fs });
    }
    prev = p;
  }
  return tidyRuns(runs);
}

function tidyRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') }));
  if (out.length) out[0].text = out[0].text.replace(/^\s+/, '');
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  return out.filter((r) => r.text.length > 0);
}

function groupLines(pieces: Piece[]): Line[] {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const out: Line[] = [];
  let cur: Piece[] = [];
  let anchorY = 0;
  let anchorFs = 0;

  const flush = () => {
    if (!cur.length) return;
    const runs = runsFromPieces(cur);
    const text = runs.map((r) => r.text).join('');
    if (text.trim()) {
      let chars = 0;
      let boldChars = 0;
      const sizes = new Map<number, number>();
      for (const p of cur) {
        const n = p.str.trim().length || 1;
        chars += n;
        if (p.bold) boldChars += n;
        sizes.set(roundHalf(p.fs), (sizes.get(roundHalf(p.fs)) ?? 0) + n);
      }
      let fs = anchorFs;
      let best = -1;
      for (const [s, n] of sizes) if (n > best) { best = n; fs = s; }
      out.push({
        y: anchorY,
        x0: Math.min(...cur.map((p) => p.x0)),
        x1: Math.max(...cur.map((p) => p.x1)),
        fs,
        boldShare: chars ? boldChars / chars : 0,
        pieces: cur,
        text: text.trim(),
      });
    }
    cur = [];
  };

  for (const p of sorted) {
    if (!cur.length) {
      cur = [p];
      anchorY = p.y;
      anchorFs = p.fs;
      continue;
    }
    // Tolerance scales with the font so 8pt footnotes and 28pt titles both
    // cluster correctly, and superscripts stay on their own line.
    const tol = Math.max(1, 0.45 * Math.max(anchorFs, p.fs));
    if (Math.abs(p.y - anchorY) <= tol) {
      cur.push(p);
      if (p.fs > anchorFs) {
        anchorFs = p.fs;
        anchorY = p.y;
      }
    } else {
      flush();
      cur = [p];
      anchorY = p.y;
      anchorFs = p.fs;
    }
  }
  flush();
  return out;
}

/* --------------------------------------------------------- ruled tables --- */

interface HLine { y: number; x0: number; x1: number }
interface VLine { x: number; y0: number; y1: number }

const THIN = 3;
const MIN_LEN = 10;
const SNAP = 3.5;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectRules(opList: any, OPS: any, vt: Mat): { hs: HLine[]; vs: VLine[] } {
  const hs: HLine[] = [];
  const vs: VLine[] = [];
  const stack: Mat[] = [];
  let ctm: Mat = vt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pending: { ops: any; args: any } | null = null;

  const addSeg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    if (dy <= THIN && dx >= MIN_LEN) hs.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
    else if (dx <= THIN && dy >= MIN_LEN) vs.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
  };

  const emit = (stroked: boolean) => {
    if (!pending) return;
    const ops = pending.ops as ArrayLike<number>;
    const args = pending.args as ArrayLike<number>;
    let cx = 0;
    let cy = 0;
    let j = 0;
    for (let i = 0; i < ops.length; i++) {
      switch (ops[i] | 0) {
        case OPS.rectangle: {
          const rx = args[j++];
          const ry = args[j++];
          const rw = args[j++];
          const rh = args[j++];
          const c = [
            px(ctm, rx, ry),
            px(ctm, rx + rw, ry),
            px(ctm, rx + rw, ry + rh),
            px(ctm, rx, ry + rh),
          ];
          const xs = c.map((p) => p[0]);
          const ys = c.map((p) => p[1]);
          const bx0 = Math.min(...xs);
          const bx1 = Math.max(...xs);
          const by0 = Math.min(...ys);
          const by1 = Math.max(...ys);
          const bw = bx1 - bx0;
          const bh = by1 - by0;
          if (bw <= THIN || bh <= THIN) {
            addSeg(bx0, (by0 + by1) / 2, bx1, (by0 + by1) / 2);
            addSeg((bx0 + bx1) / 2, by0, (bx0 + bx1) / 2, by1);
          } else if (stroked) {
            addSeg(bx0, by0, bx1, by0);
            addSeg(bx0, by1, bx1, by1);
            addSeg(bx0, by0, bx0, by1);
            addSeg(bx1, by0, bx1, by1);
          }
          cx = rx;
          cy = ry;
          break;
        }
        case OPS.moveTo: {
          const p = px(ctm, args[j++], args[j++]);
          cx = p[0];
          cy = p[1];
          break;
        }
        case OPS.lineTo: {
          const p = px(ctm, args[j++], args[j++]);
          addSeg(cx, cy, p[0], p[1]);
          cx = p[0];
          cy = p[1];
          break;
        }
        case OPS.curveTo: {
          const p = px(ctm, args[j + 4], args[j + 5]);
          cx = p[0];
          cy = p[1];
          j += 6;
          break;
        }
        case OPS.curveTo2:
        case OPS.curveTo3: {
          const p = px(ctm, args[j + 2], args[j + 3]);
          cx = p[0];
          cy = p[1];
          j += 4;
          break;
        }
        default:
          break;
      }
    }
    pending = null;
  };

  const fns = opList.fnArray as number[];
  const argv = opList.argsArray as unknown[][];
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? vt;
    else if (fn === OPS.transform) ctm = mul(ctm, argv[i] as unknown as Mat);
    else if (fn === OPS.constructPath) {
      const a = argv[i];
      pending = { ops: a[0], args: a[1] };
    } else if (fn === OPS.stroke || fn === OPS.closeStroke) emit(true);
    else if (fn === OPS.fillStroke || fn === OPS.eoFillStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) emit(true);
    else if (fn === OPS.fill || fn === OPS.eoFill) emit(false);
    else if (fn === OPS.endPath) pending = null;
  }
  return { hs, vs };
}

function mergeH(lines: HLine[]): HLine[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const out: HLine[] = [];
  for (const l of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.y - l.y) <= 2.5 && l.x0 <= prev.x1 + 4) {
      prev.x1 = Math.max(prev.x1, l.x1);
      prev.x0 = Math.min(prev.x0, l.x0);
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

function mergeV(lines: VLine[]): VLine[] {
  const sorted = [...lines].sort((a, b) => a.x - b.x || a.y0 - b.y0);
  const out: VLine[] = [];
  for (const l of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - l.x) <= 2.5 && l.y0 <= prev.y1 + 4) {
      prev.y1 = Math.max(prev.y1, l.y1);
      prev.y0 = Math.min(prev.y0, l.y0);
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

function dedupe(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  let bucket: number[] = [];
  for (const v of sorted) {
    if (bucket.length && v - bucket[bucket.length - 1] > tol) {
      out.push(bucket.reduce((s, n) => s + n, 0) / bucket.length);
      bucket = [];
    }
    bucket.push(v);
  }
  if (bucket.length) out.push(bucket.reduce((s, n) => s + n, 0) / bucket.length);
  return out;
}

/**
 * Only an actual ruled lattice counts as a table. Requiring at least 2x2 cells
 * throws out a page border (which is a 2x2 line set enclosing one cell), and the
 * near-full-page guard throws out a bordered page that also has a rule or two.
 */
function findGrids(hs: HLine[], vs: VLine[], pageW: number, pageH: number) {
  const H = mergeH(hs);
  const V = mergeV(vs);
  if (H.length < 2 || V.length < 2) return [];

  const n = H.length + V.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < H.length; i++) {
    for (let k = 0; k < V.length; k++) {
      const h = H[i];
      const v = V[k];
      if (v.x >= h.x0 - SNAP && v.x <= h.x1 + SNAP && h.y >= v.y0 - SNAP && h.y <= v.y1 + SNAP) {
        union(i, H.length + k);
      }
    }
  }

  const groups = new Map<number, { h: HLine[]; v: VLine[] }>();
  const bucket = (i: number) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { h: [], v: [] }));
    return g;
  };
  H.forEach((h, i) => bucket(i).h.push(h));
  V.forEach((v, k) => bucket(H.length + k).v.push(v));

  const out: { rows: number[]; cols: number[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const rows = dedupe(g.h.map((l) => l.y), 3);
    const cols = dedupe(g.v.map((l) => l.x), 3);
    if (rows.length < 2 || cols.length < 2) continue;
    if (rows.length < 3 && cols.length < 3) continue;
    const cells = (rows.length - 1) * (cols.length - 1);
    if (cells < 4) continue;
    const x0 = cols[0];
    const x1 = cols[cols.length - 1];
    const y0 = rows[0];
    const y1 = rows[rows.length - 1];
    if (x1 - x0 < 40 || y1 - y0 < 20) continue;
    if (x1 - x0 > pageW * 0.88 && y1 - y0 > pageH * 0.88 && cells < 12) continue;
    out.push({ rows, cols, x0, y0, x1, y1 });
  }
  return out;
}

function slot(bounds: number[], v: number): number {
  for (let i = 0; i < bounds.length - 1; i++) if (v >= bounds[i] && v < bounds[i + 1]) return i;
  return -1;
}

function fillGrid(
  g: { rows: number[]; cols: number[]; x0: number; y0: number; x1: number; y1: number },
  pieces: Piece[],
): { grid: Grid; used: Set<Piece> } {
  const nR = g.rows.length - 1;
  const nC = g.cols.length - 1;
  const buckets: Piece[][][] = Array.from({ length: nR }, () => Array.from({ length: nC }, () => [] as Piece[]));
  const used = new Set<Piece>();

  for (const p of pieces) {
    const cx = (p.x0 + p.x1) / 2;
    // The baseline sits near the bottom of the glyph box, so nudge up to keep a
    // cell's last line from falling into the row below it.
    const cy = p.y - 0.35 * p.fs;
    if (cx < g.x0 || cx > g.x1 || cy < g.y0 || cy > g.y1) continue;
    const r = slot(g.rows, cy);
    const c = slot(g.cols, cx);
    if (r < 0 || c < 0) continue;
    buckets[r][c].push(p);
    used.add(p);
  }

  const cells = buckets.map((row) =>
    row.map((ps) => (ps.length ? groupLines(ps).map((l) => l.text).join(' ').trim() : '')),
  );
  return { grid: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, cells }, used };
}

/* ------------------------------------------------------------------ OCR --- */

/** True once ~0.02% of sampled pixels are non-white, which no blank scan reaches. */
function hasInk(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  let dark = 0;
  const need = Math.max(12, Math.floor((w * h) / 5000));
  for (let i = 0; i < d.length; i += 64) {
    if (d[i] < 232 || d[i + 1] < 232 || d[i + 2] < 232) {
      if (++dark >= need) return true;
    }
  }
  return false;
}

async function ocrPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  onProgress?: ProgressFn,
): Promise<string[] | null> {
  const base = page.getViewport({ scale: 1 });
  // ~150 DPI is the sweet spot for Tesseract; cap the long edge so a poster-size
  // page cannot blow past the canvas limit or stall OCR for minutes.
  const scale = Math.max(1, Math.min(2.1, 2400 / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

  if (!hasInk(ctx, canvas.width, canvas.height)) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }

  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Page render failed.'))), 'image/png'),
  );
  canvas.width = 0;
  canvas.height = 0;

  const result = await imageToText(new File([blob], 'page.png', { type: 'image/png' }), onProgress);
  const text = result.view?.kind === 'text' ? result.view.text : await result.blob.text();
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
}

function ocrParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    if (!cur) cur = l;
    else if (/-$/.test(cur) && /^[a-z]/.test(l)) cur = cur.slice(0, -1) + l;
    else cur += ' ' + l;
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------------------------- analysis --- */

async function analyze(
  file: File,
  onProgress?: ProgressFn,
): Promise<{ pages: PageInfo[]; ocrPages: number }> {
  const pdfjsLib = (await import('../lib/pdfjs')).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OPS = (pdfjsLib as any).OPS;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pages: PageInfo[] = [];
  let ocrPages = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    const at = (f: number) => onProgress?.((i - 1 + f) / pdf.numPages);
    at(0);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const vt = viewport.transform as Mat;
    const content = await page.getTextContent();
    at(0.15);

    const rawPieces = piecesFromContent(content, vt);
    const charCount = rawPieces.reduce((n, p) => n + p.str.trim().length, 0);

    if (charCount < 6) {
      // No text layer: this is a scan. Skip getOperatorList entirely, since
      // decoding the page image on the main thread costs tens of MB and a raster
      // scan has no vector rules to find anyway.
      const lines = await ocrPage(page, (f) => at(0.15 + 0.8 * f));
      if (lines) ocrPages++;
      const synthetic: Line[] = (lines ?? []).map((t, k) => ({
        y: (k + 1) * 12,
        x0: 0,
        x1: 0,
        fs: 11,
        boldShare: 0,
        pieces: [],
        text: t.trim(),
      }));
      pages.push({
        index: i,
        width: viewport.width,
        height: viewport.height,
        lines: synthetic,
        grids: [],
        ocr: true,
        leftEdge: 0,
        rightEdge: 0,
      });
      try { await page.cleanup(); } catch { /* non-fatal */ }
      at(1);
      continue;
    }

    let grids: Grid[] = [];
    let free = rawPieces;
    try {
      const opList = await page.getOperatorList();
      at(0.6);
      // Fonts only land in commonObjs once the operator list has been parsed,
      // so weight and style cannot be resolved any earlier than this.
      applyFontStyles(rawPieces, page.commonObjs);
      const { hs, vs } = collectRules(opList, OPS, vt);
      const found = findGrids(hs, vs, viewport.width, viewport.height);
      const consumed = new Set<Piece>();
      for (const g of found) {
        const { grid, used } = fillGrid(g, rawPieces);
        const filled = grid.cells.reduce((n, row) => n + row.filter((c) => c).length, 0);
        if (filled < 2) continue;
        grids.push(grid);
        used.forEach((p) => consumed.add(p));
      }
      free = rawPieces.filter((p) => !consumed.has(p));
    } catch {
      grids = [];
      free = rawPieces;
    }

    const lines = groupLines(free);
    const sizes = new Map<number, number>();
    for (const l of lines) sizes.set(l.fs, (sizes.get(l.fs) ?? 0) + l.text.length);
    let pageBody = 0;
    let best = -1;
    for (const [s, n] of sizes) if (n > best) { best = n; pageBody = s; }
    const bodyLines = lines.filter((l) => Math.abs(l.fs - pageBody) <= pageBody * 0.12);
    const measured = bodyLines.length ? bodyLines : lines;
    const rightEdge = measured.reduce((m, l) => Math.max(m, l.x1), 0);
    const leftEdge = measured.reduce((m, l) => Math.min(m, l.x0), viewport.width);

    pages.push({ index: i, width: viewport.width, height: viewport.height, lines, grids, ocr: false, leftEdge, rightEdge });
    try { await page.cleanup(); } catch { /* non-fatal */ }
    at(1);
  }

  onProgress?.(1);
  return { pages, ocrPages };
}

function docStats(pages: PageInfo[]): DocStats {
  const sizes = new Map<number, number>();
  for (const p of pages) {
    if (p.ocr) continue;
    for (const l of p.lines) sizes.set(l.fs, (sizes.get(l.fs) ?? 0) + l.text.length);
  }
  let bodyFs = 11;
  let best = -1;
  for (const [s, n] of sizes) if (n > best) { best = n; bodyFs = s; }
  const headingSizes = [...sizes.keys()]
    .filter((s) => s >= bodyFs * 1.15)
    .sort((a, b) => b - a)
    .slice(0, 3);
  return { bodyFs, headingSizes };
}

/* ------------------------------------------------------------- blocking --- */

const BULLET = /^([•▪●◦‣·*+-]|\(?\d{1,3}[.)]|\(?[a-z][.)]|[IVXivx]{1,5}[.)])\s+/;

function headingOf(line: Line, next: Line | undefined, stats: DocStats): 0 | 1 | 2 | 3 {
  const idx = stats.headingSizes.indexOf(line.fs);
  if (idx >= 0) return (Math.min(idx, 2) + 1) as 1 | 2 | 3;
  // Size-only detection misses documents that mark headings with weight alone.
  const nearBody = Math.abs(line.fs - stats.bodyFs) <= stats.bodyFs * 0.1;
  if (
    nearBody &&
    line.boldShare > 0.85 &&
    line.text.length <= 80 &&
    !/[.,;:]$/.test(line.text) &&
    !BULLET.test(line.text) &&
    next &&
    next.boldShare < 0.5
  ) {
    return 3;
  }
  return 0;
}

function blocksForPage(page: PageInfo, stats: DocStats): Block[] {
  const blocks: Block[] = [];
  for (const g of page.grids) blocks.push({ y: g.y0, kind: 'table', cells: g.cells });

  if (page.ocr) {
    for (const t of ocrParagraphs(page.lines.map((l) => l.text))) {
      blocks.push({ y: blocks.length, kind: 'para', heading: 0, runs: [{ text: t, bold: false, italic: false, fs: 11 }] });
    }
    return blocks;
  }

  const lines = page.lines;
  let open: { y: number; heading: 0 | 1 | 2 | 3; runs: Run[]; start: Line; prev: Line } | null = null;
  const close = () => {
    if (open) blocks.push({ y: open.y, kind: 'para', heading: open.heading, runs: tidyRuns(open.runs) });
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const heading = headingOf(l, lines[i + 1], stats);
    const runs = runsFromPieces(l.pieces);
    if (!runs.length) continue;

    if (open && shouldJoin(open, l, heading, page)) {
      const prevText = open.runs.length ? open.runs[open.runs.length - 1].text : '';
      if (/[a-z]-$/.test(prevText) && /^[a-z]/.test(l.text)) {
        open.runs[open.runs.length - 1].text = prevText.slice(0, -1);
      } else if (prevText && !/\s$/.test(prevText)) {
        open.runs[open.runs.length - 1].text = prevText + ' ';
      }
      open.runs.push(...runs);
      open.prev = l;
      continue;
    }

    close();
    open = { y: l.y, heading, runs, start: l, prev: l };
    if (heading > 0) {
      // A wrapped title is still one heading, but never let a run of same-size
      // lines collapse a whole page into a single heading.
      let taken = 1;
      while (
        taken < 3 &&
        i + 1 < lines.length &&
        headingOf(lines[i + 1], lines[i + 2], stats) === heading &&
        lines[i + 1].y - lines[i].y <= lines[i].fs * 1.8 &&
        open.prev.x1 >= page.rightEdge - lines[i].fs * 2.2
      ) {
        i++;
        taken++;
        open.runs[open.runs.length - 1].text += ' ';
        open.runs.push(...runsFromPieces(lines[i].pieces));
        open.prev = lines[i];
      }
      close();
    }
  }
  close();
  return blocks;
}

function shouldJoin(
  open: { heading: 0 | 1 | 2 | 3; start: Line; prev: Line },
  l: Line,
  heading: 0 | 1 | 2 | 3,
  page: PageInfo,
): boolean {
  if (open.heading !== 0 || heading !== 0) return false;
  const p = open.prev;
  if (Math.abs(l.fs - p.fs) > p.fs * 0.12) return false;

  const gap = l.y - p.y;
  if (gap <= 0 || gap > p.fs * 2.0) return false;

  if (BULLET.test(l.text)) return false;
  if (/:$/.test(p.text)) return false;
  if (Math.abs(l.x0 - open.start.x0) > l.fs * 1.2 && l.x0 > open.start.x0) return false;
  if (open.start.x0 - l.x0 > l.fs * 1.2) return false;

  // Ragged-right text stops short of the margin by a word or two, so the slack
  // has to be a share of the column, not a fixed number of points.
  const slack = Math.max(p.fs * 2.5, (page.rightEdge - page.leftEdge) * 0.1);
  const wrapped = p.x1 >= page.rightEdge - slack;
  const runsOn = /^[a-z(“"]/.test(l.text) && !/[.!?]$/.test(p.text);
  return wrapped || runsOn;
}

/* -------------------------------------------------------------- exports --- */

export async function pdfToDocxRich(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const { pages, ocrPages } = await analyze(file, (f) => onProgress?.(f * 0.9));
  const stats = docStats(pages);
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType,
  } = await import('docx');
  const LEVELS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  let headingCount = 0;
  let paraCount = 0;
  let tableCount = 0;

  for (const page of pages) {
    const blocks = blocksForPage(page, stats).sort((a, b) => a.y - b.y);
    for (const b of blocks) {
      if (b.kind === 'table') {
        tableCount++;
        const width = { size: 100, type: WidthType.PERCENTAGE };
        children.push(
          new Table({
            width,
            rows: b.cells.map((row, r) =>
              new TableRow({
                children: row.map((text) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text, bold: r === 0, size: Math.round(stats.bodyFs * 2) })],
                      }),
                    ],
                  }),
                ),
              }),
            ),
          }),
        );
        // Word needs a paragraph between two tables, otherwise they merge.
        children.push(new Paragraph({}));
        continue;
      }
      if (!b.runs.length) continue;
      if (b.heading > 0) {
        headingCount++;
        children.push(
          new Paragraph({
            heading: LEVELS[b.heading - 1],
            children: [new TextRun({ text: b.runs.map((r) => r.text).join('') })],
          }),
        );
      } else {
        paraCount++;
        children.push(
          new Paragraph({
            spacing: { after: 120 },
            children: b.runs.map(
              (r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, size: Math.round(r.fs * 2) }),
            ),
          }),
        );
      }
    }
  }

  if (!children.length) {
    children.push(new Paragraph({ children: [new TextRun('(No extractable text found.)')] }));
  }

  const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
  onProgress?.(1);

  const bits = [`${pages.length} page${pages.length === 1 ? '' : 's'}`, `${headingCount} heading${headingCount === 1 ? '' : 's'}`, `${paraCount} paragraph${paraCount === 1 ? '' : 's'}`];
  if (tableCount) bits.push(`${tableCount} ruled table${tableCount === 1 ? '' : 's'}`);
  const note =
    `Rebuilt ${bits.join(', ')}. Headings, bold/italic and paragraph breaks are inferred from the PDF's own layout, ` +
    `so this is a close reconstruction, not a pixel-perfect copy: exact spacing, columns and images are not carried over.` +
    (ocrPages ? ` ${ocrPages} page${ocrPages === 1 ? ' had' : 's had'} no text layer and ${ocrPages === 1 ? 'was' : 'were'} read with on-device OCR, so expect some recognition errors there.` : '');

  return {
    blob,
    filename: replaceExt(file.name, 'docx'),
    note,
    view: summaryView(pages, stats, { headingCount, paraCount, tableCount, ocrPages }),
  };
}

export async function pdfToXlsx(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  const { pages, ocrPages } = await analyze(file, (f) => onProgress?.(f * 0.9));
  const stats = docStats(pages);
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const taken = new Set<string>();

  const addSheet = (rows: (string | number)[][], name: string) => {
    let clean = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
    let n = 2;
    while (taken.has(clean.toLowerCase())) {
      const suffix = ` (${n++})`;
      clean = `${name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    taken.add(clean.toLowerCase());
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), clean);
  };

  let tableCount = 0;
  for (const page of pages) {
    for (const g of page.grids) {
      tableCount++;
      addSheet(g.cells, `Page ${page.index} table ${page.grids.indexOf(g) + 1}`);
    }
  }

  const textRows: (string | number)[][] = [['Page', 'Text']];
  for (const page of pages) {
    for (const l of page.lines) {
      if (l.text.trim()) textRows.push([page.index, l.text]);
    }
  }
  const hasText = textRows.length > 1;
  if (!tableCount || hasText) {
    if (hasText) {
      addSheet(textRows, tableCount ? 'Remaining text' : 'Text');
    } else if (!tableCount) {
      addSheet([['Page', 'Text']], 'Text');
    }
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  onProgress?.(1);

  const note = tableCount
    ? `Found ${tableCount} ruled table${tableCount === 1 ? '' : 's'} and wrote ${tableCount === 1 ? 'it' : 'each'} to its own sheet` +
      (hasText ? ', with everything else as one row per line on a "Remaining text" sheet.' : '.') +
      ' Only tables the PDF actually draws with ruling lines can be detected, and merged cells land in their top-left cell.'
    : 'No ruled table grid was found in this PDF, so every text line became its own row instead. ' +
      'Tables are only detected where the PDF really draws ruling lines: a table laid out with spacing alone is indistinguishable from ordinary text.';

  return {
    blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename: replaceExt(file.name, 'xlsx'),
    note: note + (ocrPages ? ` ${ocrPages} scanned page${ocrPages === 1 ? ' was' : 's were'} read with on-device OCR.` : ''),
    view: summaryView(pages, stats, { headingCount: 0, paraCount: 0, tableCount, ocrPages }),
  };
}

function summaryView(
  pages: PageInfo[],
  stats: DocStats,
  counts: { headingCount: number; paraCount: number; tableCount: number; ocrPages: number },
): { kind: 'fields'; groups: ViewGroup[] } {
  const rows: ViewRow[] = [
    { label: 'Pages', value: String(pages.length) },
    { label: 'Body text size', value: `${stats.bodyFs} pt` },
    { label: 'Heading sizes found', value: stats.headingSizes.length ? stats.headingSizes.map((s) => `${s} pt`).join(', ') : 'none' },
    { label: 'Ruled tables', value: String(counts.tableCount) },
  ];
  if (counts.headingCount || counts.paraCount) {
    rows.splice(3, 0, { label: 'Headings', value: String(counts.headingCount) }, { label: 'Paragraphs', value: String(counts.paraCount) });
  }
  if (counts.ocrPages) {
    rows.push({ label: 'Scanned pages read by OCR', value: String(counts.ocrPages), level: 'warn' as const });
  }
  return { kind: 'fields', groups: [{ title: 'What was recovered', rows }] };
}
