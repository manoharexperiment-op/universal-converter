import type { ConversionResult, ParamValues, TargetOption } from './types';

/**
 * A visible processing queue.
 *
 * `runBatch` hands back a zip and nothing else, which is fine for twenty photos
 * that take a second each. Video is different: a handful of clips can run for
 * many minutes, so the queue has to show what it is doing, let a single stuck
 * file be abandoned without losing the rest, and let a failure be retried
 * without starting the whole set again.
 */

export type ItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  /** 0..1 for this file alone. */
  progress: number;
  result?: ConversionResult;
  error?: string;
  /** ffmpeg's own words, kept behind a disclosure rather than shown raw. */
  detail?: string;
  ms?: number;
}

export interface QueueSnapshot {
  items: QueueItem[];
  running: boolean;
  /** 0..1 across the whole set, counting the file in progress. */
  overall: number;
  doneCount: number;
  failedCount: number;
}

type Listener = (s: QueueSnapshot) => void;

/**
 * Files are processed one at a time on purpose. Decoding several videos at once
 * is what actually exhausts the wasm heap and kills the tab, and on a
 * single-threaded build there is no throughput to gain by overlapping them.
 */
export class BatchQueue {
  private items: QueueItem[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private stopAll = false;
  private skipCurrent = false;
  private seq = 0;

  constructor(
    private option: TargetOption,
    private params: ParamValues | undefined,
    /** Kills the in-flight engine. ffmpeg only stops by terminating its worker. */
    private abortCurrent: () => Promise<void>,
  ) {}

  add(files: File[]): void {
    for (const file of files) {
      this.items.push({ id: `q${++this.seq}`, file, status: 'queued', progress: 0 });
    }
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): QueueSnapshot {
    const done = this.items.filter((i) => i.status === 'done').length;
    const failed = this.items.filter((i) => i.status === 'failed').length;
    const settled = this.items.filter((i) => i.status !== 'queued' && i.status !== 'running').length;
    const inFlight = this.items.find((i) => i.status === 'running');
    const overall = this.items.length
      ? Math.min(1, (settled + (inFlight?.progress ?? 0)) / this.items.length)
      : 0;
    return {
      items: this.items.map((i) => ({ ...i })),
      running: this.running,
      overall,
      doneCount: done,
      failedCount: failed,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  /** Abandon the file being processed and carry on with the rest. */
  async skip(): Promise<void> {
    if (!this.running) return;
    this.skipCurrent = true;
    await this.abortCurrent();
  }

  /** Stop everything: the current file and everything still waiting. */
  async cancelAll(): Promise<void> {
    this.stopAll = true;
    for (const it of this.items) {
      if (it.status === 'queued') it.status = 'cancelled';
    }
    this.emit();
    if (this.running) await this.abortCurrent();
  }

  /** Put one failed or abandoned file back in the queue. */
  retry(id: string): void {
    const it = this.items.find((i) => i.id === id);
    if (!it || it.status === 'running' || it.status === 'done') return;
    it.status = 'queued';
    it.error = undefined;
    it.detail = undefined;
    it.progress = 0;
    this.emit();
    if (!this.running) void this.run();
  }

  retryAllFailed(): void {
    let any = false;
    for (const it of this.items) {
      if (it.status === 'failed' || it.status === 'cancelled') {
        it.status = 'queued';
        it.error = undefined;
        it.progress = 0;
        any = true;
      }
    }
    if (any) {
      this.emit();
      if (!this.running) void this.run();
    }
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopAll = false;
    this.emit();

    try {
      for (;;) {
        if (this.stopAll) break;
        const next = this.items.find((i) => i.status === 'queued');
        if (!next) break;

        next.status = 'running';
        next.progress = 0;
        this.skipCurrent = false;
        this.emit();
        const started = performance.now();

        try {
          const result = await this.option.run(
            next.file,
            (f) => {
              if (f >= 0 && f <= 1) {
                next.progress = f;
                this.emit();
              }
            },
            this.params,
          );
          next.result = result;
          next.status = 'done';
          next.progress = 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'This file could not be processed.';
          // Terminating the worker to skip or cancel surfaces as a generic
          // failure, so label it as the user's own doing rather than an error.
          if (this.skipCurrent || this.stopAll) {
            next.status = 'cancelled';
            next.error = this.stopAll ? 'Cancelled.' : 'Skipped.';
          } else {
            next.status = 'failed';
            next.error = msg;
            next.detail = (e as { detail?: string })?.detail;
          }
        }
        next.ms = Math.round(performance.now() - started);
        this.emit();
      }
    } finally {
      this.running = false;
      this.skipCurrent = false;
      this.emit();
    }
  }

  /** Everything that finished, bundled together. */
  async zipResults(): Promise<{ blob: Blob; filename: string; count: number } | null> {
    const done = this.items.filter((i) => i.status === 'done' && i.result);
    if (!done.length) return null;

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const used = new Set<string>();
    for (const it of done) {
      let name = it.result!.filename;
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let n = 2;
        while (used.has(`${stem} (${n})${ext}`)) n++;
        name = `${stem} (${n})${ext}`;
      }
      used.add(name);
      zip.file(name, it.result!.blob);
    }
    const failed = this.items.filter((i) => i.status === 'failed');
    if (failed.length) {
      zip.file(
        '_SKIPPED-FILES.txt',
        [`${failed.length} file(s) could not be processed:`, '', ...failed.map((f) => `${f.file.name} — ${f.error}`)].join('\n'),
      );
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    return { blob, filename: `${done.length}-files_${slug(this.option.label)}.zip`, count: done.length };
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'batch';
}

/** Rough guide so a long video batch does not look frozen. */
export function estimateBatchMinutes(files: File[], isVideo: boolean): number | null {
  if (!isVideo) return null;
  // In-browser encoding runs at roughly 5-10x real time; size is the only prox
  // for length available before probing, and this is deliberately pessimistic.
  const totalMb = files.reduce((s, f) => s + f.size, 0) / 1048576;
  return Math.max(1, Math.round(totalMb / 4));
}
