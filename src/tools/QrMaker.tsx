import { useEffect, useRef, useState } from 'react';
import { downloadBlob, isNativePlatform, saveToDevice, shareFile, isShareDismissal } from '../lib/download';

export function QrMaker() {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!text.trim()) {
      setPreview('');
      return;
    }
    let dead = false;
    // Regenerating on every keystroke is cheap (~13ms), but the import is async
    // so a slow first load could still land after a newer one.
    const timer = setTimeout(async () => {
      const { qrPreviewDataUrl } = await import('../converters/qrConverters');
      const url = await qrPreviewDataUrl(text);
      if (!dead && mine === seq.current) setPreview(url);
    }, 120);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [text]);

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      const { makeQrCode } = await import('../converters/qrConverters');
      const r = await makeQrCode({ text });
      if (isNativePlatform()) {
        const where = await saveToDevice(r.blob, r.filename);
        setMsg(where === 'downloads' ? `Saved to Downloads › MunnX Convertor › ${r.filename}` : `Saved ${r.filename}.`);
      } else {
        downloadBlob(r.blob, r.filename);
        setMsg(`Downloaded ${r.filename}`);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Something went wrong.';
      if (!isShareDismissal(m)) setMsg(m);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    try {
      const { makeQrCode } = await import('../converters/qrConverters');
      const r = await makeQrCode({ text });
      await shareFile(r.blob, r.filename);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Something went wrong.';
      if (!isShareDismissal(m)) setMsg(m);
    }
  };

  return (
    <div className="qr-wrap">
      <label className="qr-field">
        <span className="param-label">Text or link</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="https://example.com, a UPI id, wifi details, or any text"
          rows={3}
        />
      </label>

      <div className="qr-stage">
        {preview ? (
          <img src={preview} alt="QR code preview" className="qr-img" />
        ) : (
          <p className="qr-empty">Your QR code appears here as you type</p>
        )}
      </div>

      {preview && (
        <div className="action-row">
          <button className="convert-btn" onClick={save} disabled={busy}>
            {busy ? <><span className="spinner" /> Working…</> : <>⬇️ Save PNG</>}
          </button>
          {isNativePlatform() && (
            <button className="share-btn" onClick={share}>↗️ Share</button>
          )}
        </div>
      )}

      {msg && <div className="message success">{msg}</div>}
      <p className="qr-note">
        The code holds your text directly. There is no redirect and no tracking, so it keeps working forever and nobody
        counts the scans.
      </p>
    </div>
  );
}
