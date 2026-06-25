import { useCallback, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { getSourceType, IMAGE_EXTS, REGISTRY } from './converters/registry';
import type { ConversionResult, ProgressFn } from './converters/types';
import { mergePdfs, imagesToPdf } from './converters/batchConverters';
import { downloadBlob } from './lib/download';
import './App.css';

const ICONS: Record<string, string> = {
  pdf: '📄', docx: '📝', txt: '📃', xlsx: '📊', csv: '📋', zip: '🗜️',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', bmp: '🖼️', gif: '🖼️',
  md: '📑', markdown: '📑', html: '🌐', htm: '🌐',
};

const SUPPORTED: { from: string; icon: string; to: string }[] = [
  { from: 'Images', icon: '🖼️', to: 'PNG, JPG, WebP, PDF, Text (OCR)' },
  { from: 'PDF', icon: '📄', to: 'PNG, JPG, Text, Word, Rotate, Split' },
  { from: 'Word', icon: '📝', to: 'PDF, Text, HTML' },
  { from: 'Excel', icon: '📊', to: 'CSV' },
  { from: 'CSV', icon: '📋', to: 'Excel' },
  { from: 'Markdown', icon: '📑', to: 'PDF, HTML' },
  { from: 'Text / HTML', icon: '📃', to: 'PDF' },
  { from: 'Multiple files', icon: '📚', to: 'Merge PDFs · Combine images → PDF' },
];

/** A unified, ready-to-run conversion choice shown as a button. */
interface Action {
  key: string;
  label: string;
  note?: string;
  icon: string;
  run: (onProgress?: ProgressFn) => Promise<ConversionResult>;
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

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1, 0 means "indeterminate"
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const reset = () => {
    setFiles([]);
    setSelected(null);
    setError('');
    setDone('');
    setProgress(0);
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted.length) {
      setFiles(accepted);
      setSelected(null);
      setError('');
      setDone('');
      setProgress(0);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  // Build the list of available actions from the current selection of files.
  const actions = useMemo<Action[]>(() => {
    if (files.length === 1) {
      const file = files[0];
      const type = getSourceType(file.name);
      if (!type) return [];
      return (REGISTRY[type] ?? []).map((opt) => ({
        key: `${opt.target}:${opt.label}`,
        label: opt.label,
        note: opt.note,
        icon: ICONS[opt.target] ?? '📁',
        run: (p?: ProgressFn) => opt.run(file, p),
      }));
    }
    if (files.length > 1) {
      const exts = files.map((f) => extOf(f.name));
      if (exts.every((e) => e === 'pdf')) {
        return [{ key: 'merge', label: 'Merge PDFs', note: 'Combine all PDFs into one, in order', icon: '📄', run: (p?: ProgressFn) => mergePdfs(files, p) }];
      }
      if (exts.every((e) => IMAGE_EXTS.includes(e))) {
        return [{ key: 'images-pdf', label: 'Combine into PDF', note: 'One image per page', icon: '📄', run: (p?: ProgressFn) => imagesToPdf(files, p) }];
      }
      return [];
    }
    return [];
  }, [files]);

  const convert = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setDone('');
    setProgress(0);
    try {
      const result = await selected.run((f) => setProgress(f));
      downloadBlob(result.blob, result.filename);
      setDone(`Done! Downloaded ${result.filename}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      setError(`Conversion failed: ${msg}`);
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const pct = Math.round(progress * 100);
  const multiple = files.length > 1;
  const unsupported = files.length > 0 && actions.length === 0;

  return (
    <div className="app">
      <header className="header">
        <h1>🔄 Universal File Converter</h1>
        <p>Convert PDF, Word, Excel, images &amp; more — free, no login, nothing uploaded.</p>
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
              <p className="upload-sub">or click to browse · drop several PDFs to merge, or images to combine</p>
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
          </section>
        )}

        {unsupported && (
          <div className="message error">
            {multiple
              ? 'For multiple files, drop all PDFs (to merge) or all images (to combine into a PDF).'
              : <>Sorry, <strong>.{extOf(files[0].name)}</strong> files aren&apos;t supported yet.</>}
          </div>
        )}

        {selected && (
          <button className="convert-btn" onClick={convert} disabled={busy}>
            {busy ? (
              <><span className="spinner" /> Working{progress > 0 ? ` ${pct}%` : '…'}</>
            ) : (
              <>🔄 {selected.label}</>
            )}
          </button>
        )}

        {busy && (
          <div className="progress-bar">
            <div
              className={`progress-fill ${progress > 0 ? '' : 'indeterminate'}`}
              style={progress > 0 ? { width: `${pct}%` } : undefined}
            />
          </div>
        )}

        {error && <div className="message error">{error}</div>}
        {done && <div className="message success">{done}</div>}

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
