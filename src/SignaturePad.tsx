import { useRef } from 'react';

/**
 * A small canvas where the user draws a signature with mouse/touch, or uploads
 * an image. Emits the result as a transparent PNG data URL (black strokes) via
 * onChange — empty string when cleared.
 */
export function SignaturePad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    last.current = point(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = point(e);
    ctx.strokeStyle = '#0a1228';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current!.toDataURL('image/png'));
  };

  const clear = () => {
    const c = canvasRef.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    onChange('');
  };

  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(f);
  };

  return (
    <div className="sigpad">
      <canvas
        ref={canvasRef}
        width={640}
        height={200}
        className="sigpad-canvas"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <div className="sigpad-actions">
        <button type="button" className="sigpad-btn" onClick={clear}>Clear</button>
        <label className="sigpad-btn">
          Upload image
          <input type="file" accept="image/*" onChange={upload} hidden />
        </label>
        <span className={value ? 'sigpad-ok' : 'sigpad-hint'}>
          {value ? '✓ signature ready' : 'draw your signature above'}
        </span>
      </div>
    </div>
  );
}
