import { useCallback, useEffect, useRef, useState } from 'react';
import type { PagePlan, PlanPage } from './converters/types';
import { parsePageRanges, describePages } from './lib/pageRanges';
import { putInsert, pruneInserts } from './lib/insertStore';

interface Thumb {
  key: string;
  url: string;
}

/** Render page thumbnails once per source file and reuse them as pages move. */
async function renderThumbs(file: File, prefix: string, max = 200): Promise<Thumb[]> {
  const pdfjs = (await import('./lib/pdfjs')).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: Thumb[] = [];
  const count = Math.min(doc.numPages, max);
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = 118 / base.width;
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width);
    cv.height = Math.ceil(vp.height);
    const g = cv.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    // 'print' avoids the rAF-driven display path, which stalls in a background tab.
    await page.render({ canvasContext: g, viewport: vp, intent: 'print' }).promise;
    out.push({ key: `${prefix}:${n - 1}`, url: cv.toDataURL('image/jpeg', 0.72) });
  }
  return out;
}

async function imageThumb(file: File, prefix: string): Promise<Thumb[]> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ''));
    r.onerror = () => rej(new Error('Could not read that image.'));
    r.readAsDataURL(file);
  });
  return [{ key: `${prefix}:0`, url }];
}

export function PageOrganiser({
  file,
  value,
  onChange,
}: {
  file: File;
  value: PagePlan;
  onChange: (v: PagePlan) => void;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ranges, setRanges] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const insertAt = useRef<number>(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const pages = value.pages;

  // Build the starting plan (every page, in order) and render its thumbnails.
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError('');
    renderThumbs(file, '')
      .then((list) => {
        if (dead) return;
        setThumbs(Object.fromEntries(list.map((t) => [t.key, t.url])));
        onChange({ pages: list.map((_, i) => ({ src: '', index: i, rotate: 0 })) });
      })
      .catch((e) => !dead && setError(e instanceof Error ? e.message : 'Could not open this PDF.'))
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
    };
    // Rebuilding the plan whenever onChange changes identity would wipe the
    // user's edits, so this deliberately keys on the file alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const update = useCallback(
    (next: PlanPage[]) => {
      pruneInserts(next.map((p) => p.src).filter(Boolean));
      onChange({ pages: next });
    },
    [onChange],
  );

  const remove = (i: number) => update(pages.filter((_, k) => k !== i));
  const rotate = (i: number) =>
    update(pages.map((p, k) => (k === i ? { ...p, rotate: (p.rotate + 90) % 360 } : p)));
  const duplicate = (i: number) => update([...pages.slice(0, i + 1), { ...pages[i] }, ...pages.slice(i + 1)]);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= pages.length) return;
    const next = [...pages];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    update(next);
  };

  const applyRanges = (keepInstead: boolean) => {
    const originals = pages.filter((p) => !p.src);
    const hit = new Set(parsePageRanges(ranges, Math.max(originals.length, pages.length)));
    if (!hit.size) {
      setError('Type something like 2, 5-7 first.');
      return;
    }
    setError('');
    // Positions here are what the user sees on screen, which is the current order.
    const next = pages.filter((_, i) => (keepInstead ? hit.has(i) : !hit.has(i)));
    if (!next.length) {
      setError('That would remove every page.');
      return;
    }
    update(next);
    setRanges('');
  };

  const onPickInsert = async (f: File | undefined) => {
    if (!f) return;
    const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    const isImg = f.type.startsWith('image/');
    if (!isPdf && !isImg) {
      setError('Insert a PDF or an image.');
      return;
    }
    if (f.size > 60 * 1024 * 1024) {
      setError('That file is too big to insert (over 60 MB).');
      return;
    }
    setError('');
    try {
      const id = putInsert(f);
      const list = isPdf ? await renderThumbs(f, id) : await imageThumb(f, id);
      setThumbs((t) => ({ ...t, ...Object.fromEntries(list.map((x) => [x.key, x.url])) }));
      const added: PlanPage[] = list.map((_, i) => ({ src: id, index: i, rotate: 0 }));
      const at = Math.min(insertAt.current, pages.length);
      update([...pages.slice(0, at), ...added, ...pages.slice(at)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  };

  const openInsert = (at: number) => {
    insertAt.current = at;
    fileInput.current?.click();
  };

  if (loading) return <p className="note">Opening the document…</p>;

  return (
    <div className="org">
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,image/*"
        hidden
        onChange={(e) => {
          void onPickInsert(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      <div className="org-bar">
        <input
          className="org-range"
          value={ranges}
          placeholder="Pages, e.g. 2, 5-7"
          onChange={(e) => setRanges(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyRanges(false))}
        />
        <button type="button" onClick={() => applyRanges(false)}>Delete those</button>
        <button type="button" onClick={() => applyRanges(true)}>Keep only those</button>
      </div>
      {ranges.trim() && (
        <p className="org-hint">
          Matches page {describePages(parsePageRanges(ranges, pages.length))} of what is shown below.
        </p>
      )}
      {error && <p className="org-err">{error}</p>}

      <div className="org-grid">
        {pages.map((p, i) => (
          <div
            key={`${p.src}:${p.index}:${i}`}
            className={`org-page ${dragFrom === i ? 'dragging' : ''}`}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null) move(dragFrom, i);
              setDragFrom(null);
            }}
          >
            <button
              type="button"
              className="org-insert"
              title="Insert a PDF or image here"
              onClick={() => openInsert(i)}
            >
              +
            </button>
            <div className="org-thumb">
              <img
                src={thumbs[`${p.src}:${p.index}`]}
                alt={`Page ${i + 1}`}
                style={{ transform: `rotate(${p.rotate}deg)` }}
              />
              {p.src && <span className="org-badge">added</span>}
            </div>
            <div className="org-tools">
              <span className="org-num">{i + 1}</span>
              <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} title="Move left">‹</button>
              <button type="button" onClick={() => rotate(i)} title="Rotate">↻</button>
              <button type="button" onClick={() => duplicate(i)} title="Duplicate">⧉</button>
              <button type="button" onClick={() => remove(i)} title="Remove this page" className="org-del">✕</button>
              <button type="button" onClick={() => move(i, i + 1)} disabled={i === pages.length - 1} title="Move right">›</button>
            </div>
          </div>
        ))}
        <button type="button" className="org-end" onClick={() => openInsert(pages.length)}>
          ＋<span>Add a file<br />at the end</span>
        </button>
      </div>

      <p className="org-hint">
        Drag a page to move it. {pages.length} page{pages.length === 1 ? '' : 's'} will be saved.
      </p>
    </div>
  );
}
