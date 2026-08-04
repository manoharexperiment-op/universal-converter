import { useCallback, useEffect, useRef, useState } from 'react';
import type { Placement } from './converters/types';

/** Keep preview canvases well under the WebView/Safari maximum canvas area. */
const MAX_CANVAS_PX = 4_000_000;

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/**
 * Live preview of the page with a draggable, resizable stamp on top.
 *
 * The stage element's box is exactly the media box (no letterboxing), so a
 * pointer position becomes a fraction with a single division and the output is
 * resolution-independent.
 */
export function PlacementPad({
  file,
  image,
  value,
  onChange,
}: {
  file: File;
  image: string;
  value: Placement;
  onChange: (p: Placement) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<{ getPage(n: number): Promise<unknown>; destroy(): void } | null>(null);
  const drag = useRef<{ mode: 'move' | 'size'; px: number; py: number; ox: number; oy: number; ow: number; rw: number; rh: number } | null>(null);

  const [pages, setPages] = useState(1);
  const [mediaAspect, setMediaAspect] = useState(1.414); // height / width
  const [imgUrl, setImgUrl] = useState('');
  const [sigAspect, setSigAspect] = useState(0.35); // height / width
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const pdf = isPdfFile(file);

  // Signature aspect ratio: the stamp's height always derives from this.
  useEffect(() => {
    if (!image) return;
    const im = new Image();
    im.onload = () => im.naturalWidth && setSigAspect(im.naturalHeight / im.naturalWidth);
    im.src = image;
  }, [image]);

  // Load the source: an object URL for images, a pdf.js document for PDFs.
  useEffect(() => {
    let dead = false;
    setError('');
    setLoading(true);

    if (!pdf) {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        if (dead) return;
        setMediaAspect(im.naturalHeight / Math.max(1, im.naturalWidth));
        setImgUrl(url);
        setPages(1);
        setLoading(false);
      };
      im.onerror = () => {
        if (dead) return;
        URL.revokeObjectURL(url);
        setError('Could not preview this image.');
        setLoading(false);
      };
      im.src = url;
      return () => {
        dead = true;
        URL.revokeObjectURL(url);
      };
    }

    (async () => {
      try {
        const pdfjs = (await import('./lib/pdfjs')).default;
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data }).promise;
        if (dead) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setPages(doc.numPages);
        const page = await doc.getPage(1);
        const vp = (page as { getViewport(o: { scale: number }): { width: number; height: number } }).getViewport({ scale: 1 });
        if (dead) return;
        setMediaAspect(vp.height / Math.max(1, vp.width));
        setLoading(false);
      } catch {
        if (!dead) {
          setError('Could not preview this PDF. It may be password protected.');
          setLoading(false);
        }
      }
    })();

    return () => {
      dead = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [file, pdf]);

  // Render the selected PDF page. Cancellable: StrictMode double-runs effects.
  useEffect(() => {
    if (!pdf || loading || error) return;
    let dead = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;

    (async () => {
      const doc = docRef.current;
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!doc || !canvas || !stage) return;
      const page = (await doc.getPage(Math.min(Math.max(1, value.page), pages))) as {
        getViewport(o: { scale: number }): { width: number; height: number };
        render(o: Record<string, unknown>): { cancel(): void; promise: Promise<void> };
      };
      if (dead) return;

      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let scale = (Math.max(240, stage.clientWidth) * dpr) / base.width;
      const px = base.width * base.height * scale * scale;
      if (px > MAX_CANVAS_PX) scale *= Math.sqrt(MAX_CANVAS_PX / px);

      const vp = page.getViewport({ scale });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // intent 'print' makes pdf.js render synchronously instead of yielding via
      // requestAnimationFrame, which is throttled in a backgrounded tab and would
      // otherwise leave the preview blank until the user came back. It also means
      // the preview is rasterized exactly like the exported page.
      task = page.render({ canvasContext: ctx, viewport: vp, intent: 'print' });
      try {
        await task.promise;
      } catch (e) {
        // cancel() rejects with RenderingCancelledException, which is expected.
        if ((e as { name?: string })?.name !== 'RenderingCancelledException') throw e;
      }
    })();

    return () => {
      dead = true;
      task?.cancel();
    };
  }, [pdf, loading, error, value.page, pages]);

  /** Stamp height as a fraction of page height (stage box === media box). */
  const hFrac = (value.w * sigAspect) / mediaAspect;

  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

  const start = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    // Record the gesture first: setPointerCapture can throw (the pointer may
    // already be gone), and losing the drag entirely is worse than losing capture.
    drag.current = { mode, px: e.clientX, py: e.clientY, ox: value.x, oy: value.y, ow: value.w, rw: r.width, rh: r.height };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable; the drag still tracks via pointermove */
    }
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / d.rw;
    const dy = (e.clientY - d.py) / d.rh;
    if (d.mode === 'move') {
      onChange({ ...value, x: clamp(d.ox + dx, 0, 1 - value.w), y: clamp(d.oy + dy, 0, Math.max(0, 1 - hFrac)) });
    } else {
      const w = clamp(d.ow + dx, 0.04, 1 - value.x);
      onChange({ ...value, w });
    }
  };

  const end = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.02 : 0.005;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    onChange({ ...value, x: clamp(value.x + d[0], 0, 1 - value.w), y: clamp(value.y + d[1], 0, Math.max(0, 1 - hFrac)) });
  };

  const setPage = useCallback(
    (n: number) => onChange({ ...value, page: Math.min(Math.max(1, n), pages) }),
    [onChange, value, pages],
  );

  if (error) return <p className="place-error">{error}</p>;

  return (
    <div className="place-wrap">
      {pdf && pages > 1 && (
        <div className="place-pager">
          <button type="button" onClick={() => setPage(value.page - 1)} disabled={value.page <= 1}>‹</button>
          <span>Page {Math.min(value.page, pages)} of {pages}</span>
          <button type="button" onClick={() => setPage(value.page + 1)} disabled={value.page >= pages}>›</button>
        </div>
      )}

      <div className="place-stage" ref={stageRef} style={{ aspectRatio: `1 / ${mediaAspect}` }}>
        {loading && <div className="place-loading">Loading preview…</div>}
        {pdf ? <canvas ref={canvasRef} className="place-media" /> : imgUrl && <img src={imgUrl} className="place-media" alt="" />}

        {image && !loading && (
          <div
            className="place-box"
            style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.w * 100}%` }}
            tabIndex={0}
            role="application"
            aria-label="Drag to position your signature, arrow keys to nudge"
            onKeyDown={nudge}
            onPointerDown={start('move')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <img src={image} alt="" draggable={false} />
            <span
              className="place-handle"
              onPointerDown={start('size')}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            />
          </div>
        )}
      </div>

      <p className="place-hint">
        {image ? 'Drag the signature where you want it. Drag the corner to resize.' : 'Draw your signature above, then place it here.'}
      </p>
    </div>
  );
}
