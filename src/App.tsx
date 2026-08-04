import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { batchableFor, getSourceType, MERGE_REGISTRY, REGISTRY } from './converters/registry';
import type { ConversionResult, InspectFn, ParamControl, ParamValue, ParamValues, ProgressFn, ResultView } from './converters/types';
import { asPlacement, defaultsOf } from './converters/types';
import { onFFmpegStatus, terminateFFmpeg } from './converters/mediaConverters';
import { SignaturePad } from './SignaturePad';
import { PlacementPad } from './PlacementPad';
import { FileList } from './FileList';
import { UnitConverter } from './tools/UnitConverter';
import { QrMaker } from './tools/QrMaker';
import { runBatch, MAX_BATCH_FILES } from './converters/batchRunner';
import {
  isNativePlatform,
  isAndroidApp,
  downloadBlob,
  saveToDevice,
  shareFile,
  isShareDismissal,
} from './lib/download';
import './App.css';

/** A lazy-loaded chunk failed to load — usually a stale build after a redeploy. */
function isStaleChunkError(msg: string): boolean {
  return /dynamically imported module|module script failed/i.test(msg);
}
/** Reload once to pick up the current build; guarded against loops. Returns true if reloading. */
function reloadForStaleChunk(): boolean {
  const last = Number(sessionStorage.getItem('chunkReloadAt') || 0);
  if (Date.now() - last < 15000) return false;
  sessionStorage.setItem('chunkReloadAt', String(Date.now()));
  window.location.reload();
  return true;
}

const ICONS: Record<string, string> = {
  pdf: '📄', docx: '📝', txt: '📃', xlsx: '📊', csv: '📋', zip: '🗜️',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', bmp: '🖼️', gif: '🎞️',
  md: '📑', markdown: '📑', html: '🌐', htm: '🌐',
  mp4: '🎬', mov: '🎬', mkv: '🎬', webm: '🎬', avi: '🎬', m4v: '🎬', flv: '🎬', wmv: '🎬',
  mp3: '🎵', wav: '🎵', m4a: '🎵', aac: '🎵', ogg: '🎵', flac: '🎵', opus: '🎵', wma: '🎵',
};

interface Tool {
  icon: string;
  title: string;
  desc: string;
  tint: string;
  /** Jumps to another tab instead of asking for a file. */
  mode?: Mode;
}

// Grouped rather than one long grid: 24 identically-weighted cards read as a wall,
// and headings let someone scan to the section they want instead of every tile.
const TOOL_GROUPS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Photos & images',
    tools: [
      { icon: '🖼️', title: 'Convert', desc: 'PNG · JPG · WebP', tint: 'blue' },
      { icon: '🗜️', title: 'Compress', desc: 'Make the file smaller', tint: 'teal' },
      { icon: '📐', title: 'Resize', desc: 'Exact width & height', tint: 'teal' },
      { icon: '🪄', title: 'Remove BG', desc: 'AI cutout of the subject, on-device', tint: 'pink' },
      { icon: '💧', title: 'Watermark', desc: 'Stamp your text on top', tint: 'purple' },
      { icon: '🔤', title: 'Photo to text', desc: 'Reads the words out', tint: 'green' },
    ],
  },
  {
    title: 'PDF',
    tools: [
      { icon: '📝', title: 'PDF to Word', desc: 'Editable .docx', tint: 'blue' },
      { icon: '📊', title: 'PDF to Excel', desc: 'Tables into a sheet', tint: 'green' },
      { icon: '🖨️', title: 'PDF to image', desc: 'Every page as a picture', tint: 'orange' },
      { icon: '📄', title: 'Images to PDF', desc: 'Combine into one file', tint: 'orange' },
      { icon: '✂️', title: 'Organise pages', desc: 'Split, rotate or merge', tint: 'red' },
      { icon: '🗜️', title: 'Shrink PDF', desc: 'Best for scans', tint: 'teal' },
    ],
  },
  {
    title: 'Sign & secure',
    tools: [
      { icon: '✍️', title: 'Sign & date', desc: 'Drag it where you want', tint: 'blue' },
      { icon: '⌨️', title: 'Add text', desc: 'Type anywhere on a PDF, even scans', tint: 'blue' },
      { icon: '🧾', title: 'Fill a form', desc: 'For PDFs with fields', tint: 'amber' },
      { icon: '🔒', title: 'Add password', desc: 'Lock a PDF', tint: 'amber' },
      { icon: '🔓', title: 'Unlock PDF', desc: 'Remove a password you know', tint: 'green' },
      { icon: '🧽', title: 'Remove watermark', desc: 'Separate layers only', tint: 'teal' },
    ],
  },
  {
    title: 'Privacy',
    tools: [
      { icon: '📍', title: 'Hidden data', desc: 'See where a photo was taken', tint: 'red' },
      { icon: '🛡️', title: 'Strip data', desc: 'Remove it with no quality loss', tint: 'green' },
    ],
  },
  {
    title: 'Video, audio & documents',
    tools: [
      { icon: '🎬', title: 'Video', desc: 'MP4 · WebM · GIF', tint: 'pink' },
      { icon: '🎵', title: 'Audio', desc: 'MP3 · WAV · trim', tint: 'purple' },
      { icon: '📑', title: 'Docs to PDF', desc: 'Word · Markdown · text', tint: 'blue' },
      { icon: '📋', title: 'Excel ↔ CSV', desc: 'Spreadsheets', tint: 'green' },
    ],
  },
  {
    title: 'Everyday extras',
    tools: [
      { icon: '🔳', title: 'Make QR code', desc: 'Link, UPI or any text', tint: 'blue', mode: 'qr' },
      { icon: '📷', title: 'Read QR code', desc: 'From a photo of one', tint: 'purple' },
      { icon: '📏', title: 'Unit converter', desc: 'cm, kg, gaj, acre…', tint: 'amber', mode: 'units' },
    ],
  },
];

interface Action {
  key: string;
  label: string;
  note?: string;
  icon: string;
  params?: ParamControl[];
  /** ffmpeg-backed (video/audio) — can be cancelled mid-run. */
  media?: boolean;
  /** Which heading this sits under when several files are dropped. */
  group?: 'each' | 'combine';
  /** Runs across every dropped file and returns a zip. */
  batch?: boolean;
  /** Builds controls by reading the file (PDF form fields). */
  inspect?: InspectFn;
  run: (onProgress?: ProgressFn, params?: ParamValues) => Promise<ConversionResult>;
}

const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'files', label: 'Files', icon: '📁' },
  { id: 'qr', label: 'QR code', icon: '🔳' },
  { id: 'units', label: 'Units', icon: '📏' },
];
type Mode = 'files' | 'qr' | 'units';

function modeFromHash(): Mode {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h === 'qr' || h === 'units' ? h : 'files';
}

interface HistoryItem {
  id: number;
  filename: string;
  label: string;
  blob: Blob;
  at: number;
}

/** Keep recent results reachable without letting blobs pile up in memory. */
const HISTORY_MAX_ITEMS = 8;
const HISTORY_MAX_BYTES = 300 * 1024 * 1024;

function trimHistory(items: HistoryItem[]): HistoryItem[] {
  const kept: HistoryItem[] = [];
  let bytes = 0;
  for (const it of items.slice(0, HISTORY_MAX_ITEMS)) {
    bytes += it.blob.size;
    if (bytes > HISTORY_MAX_BYTES && kept.length) break;
    kept.push(it);
  }
  return kept;
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

/** Results worth reading on screen: OCR text, a decoded QR, photo metadata. */
function ResultPanel({ view }: { view: ResultView }) {
  const [copied, setCopied] = useState('');
  const copy = (text: string, tag: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(''), 1600);
    });
  };

  if (view.kind === 'text') {
    return (
      <div className="result-view">
        <div className="rv-head">
          <h4>Result</h4>
          <button className="rv-copy" onClick={() => copy(view.text, 'all')}>
            {copied === 'all' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="rv-text">{view.text}</pre>
      </div>
    );
  }

  return (
    <div className="result-view">
      {view.groups.map((g) => (
        <div className="rv-group" key={g.title}>
          <h4>{g.title}</h4>
          {g.rows.map((r, i) => (
            <div className={`rv-row ${r.level ? `rv-${r.level}` : ''}`} key={`${r.label}-${i}`}>
              <span className="rv-label">{r.label}</span>
              <span className="rv-value">{r.value}</span>
              <button className="rv-copy" onClick={() => copy(r.value, `${g.title}-${i}`)}>
                {copied === `${g.title}-${i}` ? '✓' : '⧉'}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Controls rendered under a selected action. */
function ActionParams({
  params,
  values,
  onChange,
  file,
}: {
  params: ParamControl[];
  values: ParamValues;
  onChange: (key: string, value: ParamValue) => void;
  file: File | null;
}) {
  return (
    <div className="params">
      {params.map((c) => {
        const v = values[c.key] ?? c.default;
        if (c.kind === 'signature') {
          return (
            <div className="param-row param-full" key={c.key}>
              <span className="param-label">{c.label}</span>
              <SignaturePad value={String(v)} onChange={(val) => onChange(c.key, val)} />
            </div>
          );
        }
        if (c.kind === 'placement') {
          if (!file) return null;
          return (
            <div className="param-row param-full" key={c.key}>
              <span className="param-label">{c.label}</span>
              <PlacementPad
                file={file}
                image={String(values[c.imageKey] ?? '')}
                value={asPlacement(v)}
                onChange={(p) => onChange(c.key, p)}
              />
            </div>
          );
        }
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
            ) : c.kind === 'text' ? (
              <input
                type={c.password ? 'password' : 'text'}
                value={String(v)}
                placeholder={c.placeholder}
                onChange={(e) => onChange(c.key, e.target.value)}
              />
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
  // Store the KEY, not the Action. An Action closes over `files`, so holding the
  // object would silently run against a stale file list once the list can change
  // (reorder, batch, per-file remove) while an action is already selected.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [paramState, setParamState] = useState<Record<string, ParamValues>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1, 0 means "indeterminate"
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [status, setStatus] = useState('');
  // On the native app, the converted file waits here for a Save/Share choice.
  const [pending, setPending] = useState<{ blob: Blob; filename: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  // Recent results, held in memory ONLY. Writing them to IndexedDB would leave a
  // readable copy of every converted payslip or ID scan on a shared computer,
  // which is exactly what this app promises not to do. They vanish on reload.
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [inspected, setInspected] = useState<{ key: string; params: ParamControl[]; message?: string } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [view, setView] = useState<ResultView | null>(null);
  // Hash routing, not a router library: the Electron and Capacitor builds serve
  // from origins where real path routes would 404.
  const [mode, setMode] = useState<Mode>(() => modeFromHash());
  const canceledRef = useRef(false);

  const reset = () => {
    setFiles([]);
    setNotice('');
    setSelectedKey(null);
    setParamState({});
    setError('');
    setDone('');
    setProgress(0);
    setPending(null);
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted.length) {
      setFiles(accepted.slice(0, MAX_BATCH_FILES));
      setNotice(
        accepted.length > MAX_BATCH_FILES
          ? `Taking the first ${MAX_BATCH_FILES} files — that's the most we process at once.`
          : '',
      );
      setSelectedKey(null);
      // Params are keyed by action, and actions are keyed by target+label, so a
      // new file would otherwise inherit the previous file's settings (a page
      // number past the end of a shorter PDF, for instance).
      setParamState({});
      setError('');
      setDone('');
      setProgress(0);
      setPending(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({ onDrop });

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
        inspect: opt.inspect,
        media,
        run: (p?: ProgressFn, pv?: ParamValues) => opt.run(file, p, pv),
      }));
    }
    if (files.length > 1) {
      // Every file must be the same kind, or "do this to each" is meaningless.
      const types = new Set(files.map((f) => getSourceType(f.name)));
      const type = types.size === 1 ? [...types][0] : null;
      if (!type) return [];
      const media = type === 'video' || type === 'audio';

      const each: Action[] = batchableFor(type).map((opt) => ({
        key: `each:${opt.target}:${opt.label}`,
        label: opt.label,
        note: opt.note,
        icon: ICONS[opt.target] ?? '📁',
        params: opt.params,
        media,
        group: 'each' as const,
        batch: true,
        run: (p?: ProgressFn, pv?: ParamValues) => runBatch(files, opt, p, pv),
      }));

      const combine: Action[] = (MERGE_REGISTRY[type] ?? []).map((opt) => ({
        key: `merge:${opt.target}:${opt.label}`,
        label: opt.label,
        note: opt.note,
        icon: ICONS[opt.target] ?? '📁',
        media: opt.media,
        group: 'combine' as const,
        run: (p?: ProgressFn) => opt.run(files, p),
      }));

      return [...combine, ...each];
    }
    return [];
  }, [files]);

  const selected = useMemo(() => actions.find((a) => a.key === selectedKey) ?? null, [actions, selectedKey]);

  // Tools whose controls come from inside the file (PDF form fields) look at it
  // once the tool is picked, rather than the registry knowing them up front.
  useEffect(() => {
    if (!selected?.inspect || !files[0]) {
      setInspected(null);
      return;
    }
    let dead = false;
    const key = selected.key;
    setInspecting(true);
    setInspected(null);
    selected
      .inspect(files[0])
      .then((r) => !dead && setInspected({ key, ...r }))
      .catch((e) => !dead && setInspected({ key, params: [], message: e instanceof Error ? e.message : 'Could not read this file.' }))
      .finally(() => !dead && setInspecting(false));
    return () => {
      dead = true;
    };
  }, [selected, files]);

  const activeParams = inspected?.key === selected?.key ? inspected?.params : selected?.params;
  const combineActions = useMemo(() => actions.filter((a) => a.group === 'combine'), [actions]);
  const eachActions = useMemo(() => actions.filter((a) => a.group === 'each'), [actions]);

  const paramValues = activeParams?.length ? paramState[selected!.key] ?? defaultsOf(activeParams) : undefined;

  const setParam = (key: string, value: ParamValue) => {
    if (!selected) return;
    const current = paramState[selected.key] ?? defaultsOf(activeParams);
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
    setView(null);
    if (selected.media) onFFmpegStatus(setStatus);
    try {
      const result = await selected.run((f) => setProgress(f), paramValues);
      setView(result.view ?? null);
      setHistory((h) =>
        trimHistory([
          { id: Date.now(), filename: result.filename, label: selected.label, blob: result.blob, at: Date.now() },
          ...h,
        ]),
      );
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
      if (!canceledRef.current && isStaleChunkError(msg) && reloadForStaleChunk()) return;
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
        <p className="tagline">Convert PDF, Word, Excel, images, audio &amp; video — right on your device.</p>
        <ul className="badges">
          <li>🔒 Private</li>
          <li>💯 Free</li>
          <li>⚡ No login</li>
        </ul>
      </header>

      <main className="main">
        <nav className="modes">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-btn ${mode === m.id ? 'active' : ''}`}
              onClick={() => { setMode(m.id); window.location.hash = m.id === 'files' ? '' : `/${m.id}`; }}
            >
              <span aria-hidden="true">{m.icon}</span> {m.label}
            </button>
          ))}
        </nav>

        {mode === 'qr' && (
          <section className="panel"><QrMaker /></section>
        )}
        {mode === 'units' && (
          <section className="panel"><UnitConverter /></section>
        )}

        <section className="panel" hidden={mode !== 'files'}>
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
                <p className="file-size">{formatSize(files.reduce((n, f) => n + f.size, 0))} in total</p>
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

        {multiple && (
          <FileList
            files={files}
            onChange={(next) => {
              setFiles(next);
              if (!next.length) reset();
            }}
            ordered={combineActions.length > 0}
          />
        )}

        {actions.length > 0 && (
          <section className="format-section">
            {multiple ? (
              <>
                {combineActions.length > 0 && (
                  <>
                    <h3>Combine them into one file:</h3>
                    <div className="format-grid">
                      {combineActions.map((a) => (
                        <button key={a.key} className={`format-btn ${selected?.key === a.key ? 'selected' : ''}`} onClick={() => setSelectedKey(a.key)} title={a.note}>
                          {a.icon} {a.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {eachActions.length > 0 && (
                  <>
                    <h3 className={combineActions.length ? 'group-gap' : undefined}>
                      Or do this to all {files.length} files:
                    </h3>
                    <div className="format-grid">
                      {eachActions.map((a) => (
                        <button key={a.key} className={`format-btn ${selected?.key === a.key ? 'selected' : ''}`} onClick={() => setSelectedKey(a.key)} title={a.note}>
                          {a.icon} {a.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <h3>Convert to:</h3>
                <div className="format-grid">
                  {actions.map((a) => (
                    <button key={a.key} className={`format-btn ${selected?.key === a.key ? 'selected' : ''}`} onClick={() => setSelectedKey(a.key)} title={a.note}>
                      {a.icon} {a.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {selected?.note && <p className="note">ⓘ {selected.note}</p>}
            {selected?.batch && <p className="note">📦 Each file is converted separately and you get one zip back.</p>}
            {inspecting && <p className="note">Reading the file…</p>}
            {inspected?.key === selected?.key && inspected?.message && (
              <p className="note">ⓘ {inspected.message}</p>
            )}
            {activeParams && activeParams.length > 0 && paramValues && (
              <ActionParams params={activeParams} values={paramValues} onChange={setParam} file={files[0] ?? null} />
            )}
          </section>
        )}

        {unsupported && (
          <div className="message error">
            {multiple
              ? 'Drop files of the same kind together — all PDFs, all images, or all audio. Mixed types can’t be combined or batch-converted.'
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

        {notice && <div className="message notice">{notice}</div>}
        {error && <div className="message error">{error}</div>}
        {done && <div className="message success">{done}</div>}
        {view && <ResultPanel view={view} />}

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

        {history.length > 0 && (
          <section className="history">
            <div className="history-head">
              <h3>Recent conversions</h3>
              <button className="history-clear" onClick={() => setHistory([])}>Clear</button>
            </div>
            <ul className="history-list">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="fl-meta">
                    <span className="fl-name">{h.filename}</span>
                    <span className="fl-size">{h.label} · {formatSize(h.blob.size)}</span>
                  </span>
                  <button
                    className="fl-btn history-get"
                    onClick={() =>
                      isNativePlatform() ? void shareFile(h.blob, h.filename) : downloadBlob(h.blob, h.filename)
                    }
                  >
                    {isNativePlatform() ? '↗' : '⬇'}
                  </button>
                </li>
              ))}
            </ul>
            <p className="history-note">
              Kept in memory for this visit only. Nothing is written to disk, and closing the tab clears it.
            </p>
          </section>
        )}

        </section>

        <section className="tools">
          <h3>Everything it can do</h3>
          <p className="tools-sub">Drop a file above and only the tools that fit it are offered.</p>
          {TOOL_GROUPS.map((g) => (
            <div className="tool-group" key={g.title}>
              <h4 className="tool-group-title">{g.title}</h4>
              <div className="tools-grid">
                {g.tools.map((t) => (
                  <button
                    className="tool-card"
                    key={t.title}
                    onClick={() => {
                      if (t.mode) {
                        setMode(t.mode);
                        window.location.hash = `/${t.mode}`;
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      } else {
                        open();
                      }
                    }}
                    title={`${t.title}: ${t.desc}`}
                  >
                    <span className={`tool-icon tint-${t.tint}`}>{t.icon}</span>
                    <span className="tool-title">{t.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>

      <footer className="footer">
        🔒 100% in your browser. Your files never leave your device — nothing is uploaded.
      </footer>
    </div>
  );
}
