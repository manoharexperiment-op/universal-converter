import { useRef, useState } from 'react';

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
}

/**
 * The dropped files, in the order they will be merged.
 *
 * Reorder by dragging a row or with the arrow buttons. Both exist deliberately:
 * dragging is the obvious gesture, but the arrows are reliable on a small touch
 * screen and are the only route for keyboard users.
 */
export function FileList({
  files,
  onChange,
  ordered,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** Show position numbers, for actions where order changes the output. */
  ordered: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length || from === to) return;
    const next = files.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const remove = (i: number) => onChange(files.filter((_, n) => n !== i));

  const onPointerDown = (i: number) => (e: React.PointerEvent) => {
    if (!ordered) return;
    e.preventDefault();
    setDragIdx(i);
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable; pointermove still tracks */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragIdx == null || !listRef.current) return;
    const rows = Array.from(listRef.current.querySelectorAll('li'));
    const over = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY <= b.bottom;
    });
    if (over >= 0 && over !== dragIdx) {
      move(dragIdx, over);
      setDragIdx(over);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    setDragIdx(null);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <ul className="filelist" ref={listRef}>
      {files.map((f, i) => (
        <li key={`${f.name}-${f.size}-${f.lastModified}-${i}`} className={dragIdx === i ? 'dragging' : ''}>
          {ordered && (
            <span
              className="fl-grip"
              title="Drag to reorder"
              onPointerDown={onPointerDown(i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              ⠿
            </span>
          )}
          {ordered && <span className="fl-num">{i + 1}</span>}
          <span className="fl-meta">
            <span className="fl-name">{f.name}</span>
            <span className="fl-size">{formatSize(f.size)}</span>
          </span>
          {ordered && (
            <>
              <button type="button" className="fl-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">↑</button>
              <button type="button" className="fl-btn" onClick={() => move(i, i + 1)} disabled={i === files.length - 1} aria-label="Move down">↓</button>
            </>
          )}
          <button type="button" className="fl-btn fl-del" onClick={() => remove(i)} aria-label={`Remove ${f.name}`}>✕</button>
        </li>
      ))}
    </ul>
  );
}
