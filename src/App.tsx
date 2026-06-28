import { useCallback, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { AUDIO_EXTS, getSourceType, IMAGE_EXTS, REGISTRY } from './converters/registry';
import type { ConversionResult, ParamControl, ParamValues, ProgressFn } from './converters/types';
import { defaultsOf } from './converters/types';
import { mergePdfs, imagesToPdf, mergeAudio } from './converters/batchConverters';
import { onFFmpegStatus, terminateFFmpeg } from './converters/mediaConverters';
import {
  isNativePlatform,
  isAndroidApp,
  downloadBlob,
  saveToDevice,
  shareFile,
  isShareDismissal,
} from './lib/download';
import './App.css';

const ICONS: Record<string, string> = {
  pdf: '📄', docx: '📝', txt: '📃', xlsx: '📊', csv: '📋', zip: '🗜️',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', bmp: '🖼️', gif: '🎞️',
  md: '📑', markdown: '📑', html: '🌐', htm: '🌐',
  mp4: '🎬', mov: '🎬', mkv: '🎬', webm: '🎬', avi: '🎬', m4v: '🎬', flv: '🎬', wmv: '🎬',
  mp3: '🎵', wav: '🎵', m4a: '🎵', aac: '🎵', ogg: '🎵', flac: '🎵', opus: '🎵', wma: '🎵',
};

const SUPPORTED: { from: string; icon: string; to: string }[] = [
  { from: 'Images', icon: '🖼️', to: 'PNG, JPG, WebP, PDF, Compress, OCR' },
  { from: 'PDF', icon: '📄', to: 'PNG, JPG, Text, Word, Rotate, Split, Compress' },
  { from: 'Word', icon: '📝', to: 'PDF, Text, HTML' },
  { from: 'Excel / CSV', icon: '📊', to: 'CSV ↔ Excel' },
  { from: 'Markdown / HTML / Text', icon: '📑', to: 'PDF, HTML' },
  { from: 'Video', icon: '🎬', to: 'MP3, WAV, GIF, MP4, WebM, Compress' },
  { from: 'Audio', icon: '🎵', to: 'MP3, WAV, Trim, Bitrate' },
  { from: 'Multiple files', icon: '📚', to: 'Merge PDFs · Images → PDF · Merge audio' },
];

interface Action {
  key: string;
  label: string;
  note?: string;
  icon: string;
  params?: ParamControl[];
  /** ffmpeg-backed (video/audio) — can be cancelled mid-run. */
  media?: boolean;
  run: (onProgress?: ProgressFn, params?: ParamValues) => Promise<ConversionResult>;
}

function extOf(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? '';
}
function formatSize(bytes: number) {
  if (!bytes) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
}

/** Controls rendered under a selected action. */
function ActionParams({
  params,
  values,
  onChange,
}: {
  params: ParamControl[];
  values: ParamValues;
  onChange: (key: string, value: string | number) => void;
}) {
  return (
    <div className="params">
      {params.map((c) => {
        const v = values[c.key] ?? c.default;
        return (
          <label className="param-row" key={c.key}>
            <span className="param-label">{c.label}</span>
            {c.kind === 'select' ? (
              <select
                value={String(v)}
                onChange={(e) => {
                  const opt = c.options.find((o) => String(o.value) === e.target.value);
                  onChange(c.key, opt ? opt.value : e.target.value);
                }}
              >
                {c.options.map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            ) : (
              <span className="param-num">
                <input
                  type={c.kind === 'range' ? 'range' : 'number'}
                  value={Number(v)}
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  onChange={(e) => onChange(c.key, Number(e.target.value))}
                />
                {c.unit && <span className="param-unit">{c.unit}</span>}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState<Action | null>(null);
  const [paramState, setParamState] = useState<Record<string, ParamValues>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1, 0 means "indeterminate"
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [status, setStatus] = useState('');
  // On the native app, the converted file waits here for a Save/Share choice.
  const [pending, setPending] = useState<{ blob: Blob; filename: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const canceledRef = useRef(false);

  const reset = () => {
    setFiles([]);
    setSelected(null);
    setError('');
    setDone('');
    setProgress(0);
    setPending(null);
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted.length) {
      setFiles(accepted);
      setSelected(null);
      setError('');
      setDone('');
      setProgress(0);
      setPending(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  const actions = useMemo<Action[]>(() => {
    if (files.length === 1) {
      const file = files[0];
      const type = getSourceType(file.name);
      if (!type) return [];
      const media = type === 'video' || type === 'audio';
      return (REGISTRY[type] ?? []).map((opt) => ({
        key: `${opt.target}:${opt.label}`,
        label: opt.label,
        note: opt.note,
        icon: ICONS[opt.target] ?? '📁',
        params: opt.params,
        media,
        run: (p?: ProgressFn, pv?: ParamValues) => opt.run(file, p, pv),
      }));
    }
    if (files.length > 1) {
      const exts = files.map((f) => extOf(f.name));
      if (exts.every((e) => e === 'pdf')) {
        return [{ key: 'merge-pdf', label: 'Merge PDFs', note: 'Combine all PDFs into one, in order', icon: '📄', run: (p?: ProgressFn) => mergePdfs(files, p) }];
      }
      if (exts.every((e) => IMAGE_EXTS.includes(e))) {
        return [{ key: 'images-pdf', label: 'Combine into PDF', note: 'One image per page', icon: '📄', run: (p?: ProgressFn) => imagesToPdf(files, p) }];
      }
      if (exts.every((e) => AUDIO_EXTS.includes(e))) {
        return [{ key: 'merge-audio', label: 'Merge audio', note: 'Join into one MP3, in order', icon: '🎵', media: true, run: (p?: ProgressFn) => mergeAudio(files, p) }];
      }
      return [];
    }
    return [];
  }, [files]);

  const paramValues = selected?.params ? paramState[selected.key] ?? defaultsOf(selected.params) : undefined;

  const setParam = (key: string, value: string | number) => {
    if (!selected) return;
    const current = paramState[selected.key] ?? defaultsOf(selected.params);
    setParamState((s) => ({ ...s, [selected.key]: { ...current, [key]: value } }));
  };

  const convert = async () => {
    if (!selected) return;
    canceledRef.current = false;
    setBusy(true);
    setError('');
    setDone('');
    setStatus('');
    setProgress(0);
    setPending(null);
    if (selected.media) onFFmpegStatus(setStatus);
    try {
      const result = await selected.run((f) => setProgress(f), paramValues);
      if (isNativePlatform()) {
        // Hold the file and let the user choose Save to device / Share.
        setPending({ blob: result.blob, filename: result.filename });
        setDone(result.note ?? `Converted ${result.filename}.`);
      } else {
        downloadBlob(result.blob, result.filename);
        setDone(result.note ?? `Done! Downloaded ${result.filename}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      setError(canceledRef.current ? 'Canceled.' : `Conversion failed: ${msg}`);
    } finally {
      onFFmpegStatus(null);
      setBusy(false);
      setProgress(0);
      setStatus('');
    }
  };

  const doSave = async () => {
    if (!pending) return;
    setSaving(true);
    setError('');
    try {
      const where = await saveToDevice(pending.blob, pending.filename);
      setDone(
        where === 'downloads'
          ? `Saved to Downloads › MunnX Convertor › ${pending.filename}`
          : `Saved ${pending.filename}.`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      if (!isShareDismissal(msg)) setError(`Couldn't save: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const doShare = async () => {
    if (!pending) return;
    setSaving(true);
    setError('');
    try {
      await shareFile(pending.blob, pending.filename);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      if (!isShareDismissal(msg)) setError(`Couldn't share: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    canceledRef.current = true;
    void terminateFFmpeg();
  };

  const pct = Math.round(progress * 100);
  const multiple = files.length > 1;
  const unsupported = files.length > 0 && actions.length === 0;

  return (
    <div className="app">
      <header className="header">
        <img className="logo" src="/logo.png" alt="MunnX" />
        <p className="brand-sub">Convertor</p>
        <p>Convert PDF, Word, Excel, images, audio &amp; video — free, no login, nothing uploaded.</p>
      </header>

      <main className="main">
        <div
          {...getRootProps()}
          className={`dropzone ${isDragActive ? 'active' : ''} ${files.length ? 'has-file' : ''}`}
        >
          <input {...getInputProps()} />
          {files.length === 0 ? (
            <div className="upload-prompt">
              <span className="upload-icon">📁</span>
              <p>Drag &amp; drop a file here</p>
              <p className="upload-sub">or click to browse · drop several PDFs / images / audio to combine</p>
            </div>
          ) : multiple ? (
            <div className="file-info">
              <span className="file-icon">📚</span>
              <div className="file-meta">
                <p className="file-name">{files.length} files selected</p>
                <p className="file-size">
                  {files.map((f) => f.name).slice(0, 3).join(', ')}
                  {files.length > 3 ? ` +${files.length - 3} more` : ''}
                </p>
              </div>
              <button className="remove-btn" onClick={(e) => { e.stopPropagation(); reset(); }} aria-label="Clear files">✕</button>
            </div>
          ) : (
            <div className="file-info">
              <span className="file-icon">{ICONS[extOf(files[0].name)] ?? '📁'}</span>
              <div className="file-meta">
                <p className="file-name">{files[0].name}</p>
                <p className="file-size">{formatSize(files[0].size)}</p>
              </div>
              <button className="remove-btn" onClick={(e) => { e.stopPropagation(); reset(); }} aria-label="Remove file">✕</button>
            </div>
          )}
        </div>

        {actions.length > 0 && (
          <section className="format-section">
            <h3>{multiple ? 'Action:' : 'Convert to:'}</h3>
            <div className="format-grid">
              {actions.map((a) => (
                <button
                  key={a.key}
                  className={`format-btn ${selected?.key === a.key ? 'selected' : ''}`}
                  onClick={() => setSelected(a)}
                  title={a.note}
                >
                  {a.icon} {a.label}
                </button>
              ))}
            </div>
            {selected?.note && <p className="note">ⓘ {selected.note}</p>}
            {selected?.params && paramValues && (
              <ActionParams params={selected.params} values={paramValues} onChange={setParam} />
            )}
          </section>
        )}

        {unsupported && (
          <div className="message error">
            {multiple
              ? 'For multiple files, drop all PDFs (merge), all images (combine to PDF), or all audio (merge).'
              : <>Sorry, <strong>.{extOf(files[0].name)}</strong> files aren&apos;t supported yet.</>}
          </div>
        )}

        {selected && (
          <div className="action-row">
            <button className="convert-btn" onClick={convert} disabled={busy}>
              {busy ? (
                <><span className="spinner" /> Working{progress > 0 ? ` ${pct}%` : '…'}</>
              ) : (
                <>🔄 {selected.label}</>
              )}
            </button>
            {busy && selected.media && (
              <button className="cancel-btn" onClick={cancel}>Cancel</button>
            )}
          </div>
        )}

        {busy && (
          <>
            <div className="progress-bar">
              <div
                className={`progress-fill ${progress > 0 ? '' : 'indeterminate'}`}
                style={progress > 0 ? { width: `${pct}%` } : undefined}
              />
            </div>
            {selected?.media && (
              <p className="status">{status || 'Encoding in your browser — this can take a while…'}</p>
            )}
          </>
        )}

        {error && <div className="message error">{error}</div>}
        {done && <div className="message success">{done}</div>}

        {pending && isAndroidApp() && (
          <div className="save-row">
            <button className="convert-btn" onClick={doSave} disabled={saving}>
              {saving ? <><span className="spinner" /> Working…</> : <>⬇️ Save to device</>}
            </button>
            <button className="share-btn" onClick={doShare} disabled={saving}>
              ↗️ Share
            </button>
          </div>
        )}
        {pending && isNativePlatform() && !isAndroidApp() && (
          <div className="save-row">
            <button className="convert-btn" onClick={doShare} disabled={saving}>
              {saving ? <><span className="spinner" /> Working…</> : <>↗️ Save / Share</>}
            </button>
          </div>
        )}

        <section className="supported">
          <h3>Supported conversions</h3>
          <div className="supported-list">
            {SUPPORTED.map((row) => (
              <div className="supported-row" key={row.from}>
                <span className="from">{row.icon} {row.from}</span>
                <span className="arrow">→</span>
                <span className="to">{row.to}</span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="footer">
        🔒 100% in your browser. Your files never leave your device — nothing is uploaded.
      </footer>
    </div>
  );
}
