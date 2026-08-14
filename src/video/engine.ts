import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { ConversionResult, ProgressFn } from '../converters/types';
import type { VideoInfo, VideoJob, VideoOp, VideoOutput } from './types';
import { VideoError, describeFailure } from './types';
import { buildGraph, cornerExpr, escapeFilterValue, outputArgs } from './graph';
import { assertUsable, probe } from './probe';
import { ensureFontsFor } from './fonts';
import { addSuffix, replaceExt } from '../lib/strings';

/**
 * Runs video jobs.
 *
 * All ffmpeg knowledge lives here and in `graph.ts`. Callers describe what they
 * want with typed operations and never see a command string.
 */

/** Loading the whole file into a 32-bit wasm heap caps how big it can be. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** `reverse` buffers every decoded frame, so it needs a much tighter limit. */
export const MAX_REVERSE_SECONDS = 60;

const MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', gif: 'image/gif',
};

async function shared(): Promise<FFmpeg> {
  const { sharedFFmpeg } = await import('../converters/mediaConverters');
  return sharedFFmpeg();
}

function extOf(name: string) {
  return (name.split('.').pop() || 'bin').toLowerCase();
}

export function assertSize(file: File): void {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new VideoError(
      'too-large',
      `This video is ${Math.round(file.size / 1048576)} MB. The browser can handle about ` +
        `${Math.round(MAX_VIDEO_BYTES / 1048576)} MB before it runs out of memory. Try a shorter clip.`,
    );
  }
}

/** Collects ffmpeg's output so a failure can show real detail on request. */
function tapLog(ffmpeg: FFmpeg): { tail: () => string; stop: () => void } {
  const lines: string[] = [];
  const on = ({ message }: { message: string }) => {
    lines.push(message);
    if (lines.length > 400) lines.shift();
  };
  ffmpeg.on('log', on);
  return {
    tail: () => lines.slice(-25).join('\n'),
    stop: () => ffmpeg.off('log', on),
  };
}

async function cleanup(ffmpeg: FFmpeg, paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await ffmpeg.deleteFile(p);
    } catch {
      /* already gone, or never written */
    }
  }
}

/** Read a video's properties without converting it. */
export async function getVideoInfo(file: File): Promise<VideoInfo> {
  assertSize(file);
  const ffmpeg = await shared();
  const { fetchFile } = await import('@ffmpeg/util');
  const path = `probe_in.${extOf(file.name)}`;
  try {
    await ffmpeg.writeFile(path, await fetchFile(file));
    const info = await probe(ffmpeg, path, file.name, file.size);
    assertUsable(info);
    return info;
  } finally {
    await cleanup(ffmpeg, [path]);
  }
}

/** Draw text to a transparent PNG using the device's own fonts. */
async function renderTextPng(
  text: string,
  frameWidth: number,
  sizePercent: number,
  color: string,
  opacity: number,
  outline: boolean,
  background: boolean,
): Promise<Uint8Array> {
  const target = Math.max(24, Math.round((frameWidth * Math.min(sizePercent, 90)) / 100));
  const font = (px: number) => `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const probeCtx = document.createElement('canvas').getContext('2d')!;
  probeCtx.font = font(100);
  const refW = probeCtx.measureText(text).width || 1;
  const fontPx = Math.max(12, Math.round((100 * target) / refW));

  const m0 = document.createElement('canvas').getContext('2d')!;
  m0.font = font(fontPx);
  const m = m0.measureText(text);
  const ascent = m.actualBoundingBoxAscent || fontPx * 0.8;
  const descent = m.actualBoundingBoxDescent || fontPx * 0.25;
  const pad = Math.ceil(fontPx * (background ? 0.3 : 0.18));

  const cv = document.createElement('canvas');
  cv.width = Math.ceil(m.width) + pad * 2;
  cv.height = Math.ceil(ascent + descent) + pad * 2;
  const g = cv.getContext('2d')!;
  g.globalAlpha = Math.min(1, Math.max(0.05, opacity / 100));
  if (background) {
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 0, cv.width, cv.height);
  }
  g.font = font(fontPx);
  g.textBaseline = 'alphabetic';
  if (outline) {
    g.lineWidth = Math.max(2, fontPx * 0.11);
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(text, pad, pad + ascent);
  }
  g.fillStyle = color || '#ffffff';
  g.fillText(text, pad, pad + ascent);

  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (!blob) throw new VideoError('failed', 'Could not draw that text.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Timed `enable=` guard for overlays that only appear for part of the clip. */
function enableWindow(start?: number, end?: number): string {
  if (start === undefined && end === undefined) return '';
  const lo = start ?? 0;
  const hi = end;
  const cond = hi !== undefined ? `between(t\\,${lo}\\,${hi})` : `gte(t\\,${lo})`;
  return `:enable='${cond}'`;
}

/**
 * Run a job: one decode and one encode, however many operations it carries.
 */
export async function runJob(
  job: VideoJob,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  assertSize(job.input);
  const ffmpeg = await shared();
  const { fetchFile } = await import('@ffmpeg/util');
  const log = tapLog(ffmpeg);
  const temps: string[] = [];

  const inPath = `job_in.${extOf(job.input.name)}`;
  const outPath = `job_out.${job.output.container}`;
  temps.push(inPath, outPath);

  const onTick = ({ progress }: { progress: number }) => {
    if (onProgress && progress >= 0 && progress <= 1) onProgress(progress);
  };
  ffmpeg.on('progress', onTick);

  try {
    await ffmpeg.writeFile(inPath, await fetchFile(job.input));
    const info = await probe(ffmpeg, inPath, job.input.name, job.input.size);
    assertUsable(info);

    const reverse = job.ops.find((o) => o.kind === 'reverse');
    if (reverse && info.durationSeconds > MAX_REVERSE_SECONDS) {
      throw new VideoError(
        'too-large',
        `Reversing has to hold every frame in memory, so it is limited to ${MAX_REVERSE_SECONDS} seconds. ` +
          `This clip is ${Math.round(info.durationSeconds)} seconds. Trim it first, then reverse.`,
      );
    }

    const graph = buildGraph(job.ops, info, job.output);
    const notes = [...graph.notes];

    // Frame size after the geometry filters, needed to size stamps correctly.
    let frameW = info.width;
    let frameH = info.height;
    for (const op of job.ops) {
      if (op.kind === 'resize' && op.width) frameW = op.width;
      if (op.kind === 'resize' && op.height) frameH = op.height;
      if (op.kind === 'rotate' && op.degrees !== 180) [frameW, frameH] = [frameH, frameW];
    }

    const args: string[] = ['-hide_banner'];
    // Both seek flags go BEFORE -i, so they bound how much source is read.
    // Putting -t after -i makes it an output-duration cap instead, which breaks
    // any trim combined with a speed change: the sped-up stream is shorter than
    // the cap, and ffmpeg holds the output open to the full trimmed length.
    // Verified: trim 1-5s plus 2x speed gives 4s with -t after -i, 2s before it.
    if (graph.seek?.start) args.push('-ss', String(graph.seek.start));
    if (graph.seek?.end !== undefined) {
      const dur = graph.seek.end - (graph.seek.start ?? 0);
      args.push('-t', String(dur));
    }
    args.push('-i', inPath);

    // Extra inputs: watermark images, replacement audio, rendered text.
    let inputIndex = 1;
    const overlays: { idx: number; op: Extract<VideoOp, { kind: 'watermark' | 'textOverlay' }> }[] = [];
    let audioReplaceIdx: number | null = null;

    for (const op of job.ops) {
      if (op.kind === 'watermark') {
        const p = `wm_${inputIndex}.png`;
        await ffmpeg.writeFile(p, await fetchFile(op.image));
        temps.push(p);
        args.push('-i', p);
        overlays.push({ idx: inputIndex, op });
        inputIndex++;
      } else if (op.kind === 'textOverlay') {
        const png = await renderTextPng(op.text, frameW, op.sizePercent, op.color, op.opacity, op.outline, op.background);
        const p = `txt_${inputIndex}.png`;
        await ffmpeg.writeFile(p, png);
        temps.push(p);
        args.push('-i', p);
        overlays.push({ idx: inputIndex, op });
        inputIndex++;
      } else if (op.kind === 'setAudio') {
        const p = `aud_${inputIndex}.${extOf(op.file.name)}`;
        await ffmpeg.writeFile(p, await fetchFile(op.file));
        temps.push(p);
        args.push('-i', p);
        audioReplaceIdx = inputIndex;
        inputIndex++;
      }
    }

    // Subtitles: the font has to exist in the filesystem or libass silently
    // renders nothing while still reporting success.
    const subOp = job.ops.find((o) => o.kind === 'subtitles') as Extract<VideoOp, { kind: 'subtitles' }> | undefined;
    let subtitleFilter = '';
    if (subOp) {
      const text = await subOp.file.text();
      if (!/-->/.test(text)) {
        throw new VideoError('bad-subtitle', 'That does not look like a subtitle file. Use a .srt or .vtt file.');
      }
      const subPath = `subs.${extOf(subOp.file.name) === 'vtt' ? 'vtt' : 'srt'}`;
      await ffmpeg.writeFile(subPath, new TextEncoder().encode(text));
      temps.push(subPath);

      const choice = await ensureFontsFor(ffmpeg, text);
      if (choice.missingScripts.length) {
        notes.push(
          `No bundled font covers ${choice.missingScripts.join(' or ')}, so those characters may not appear.`,
        );
      }
      const st = subOp.style;
      // This build numbers alignment the legacy SSA way, not ASS v4+: 1-3 sit at
      // the bottom, 5-7 at the top and 9-11 in the middle. Verified by rendering
      // every value and measuring where the text landed. The v4+ reading (top=8,
      // middle=5) puts top and centre in each other's places.
      const alignment = st.position === 'top' ? 6 : st.position === 'center' ? 10 : 2;
      const fontSize = Math.max(8, Math.round((frameH * st.fontSizePercent) / 100));
      const style = [
        `FontName=${choice.family}`,
        `FontSize=${fontSize}`,
        `PrimaryColour=${assColour(st.color)}`,
        `Alignment=${alignment}`,
        `Outline=${st.outline ? 2 : 0}`,
        `BorderStyle=${st.background ? 3 : 1}`,
        `MarginV=${Math.round((frameH * st.marginPercent) / 100)}`,
      ].join(',');
      subtitleFilter = `subtitles=${escapeFilterValue(subPath)}:fontsdir=${escapeFilterValue('/fonts')}:force_style='${style}'`;
    }

    // Assemble. filter_complex is only needed when other inputs are involved.
    const vChain = [...graph.videoChain];
    if (subtitleFilter) vChain.push(subtitleFilter);
    const wantsAudio = info.hasAudio && !graph.dropAudio;
    const isGif = job.output.container === 'gif';

    if (overlays.length || audioReplaceIdx !== null) {
      const parts: string[] = [];
      // Square brackets denote a filter output. A raw stream like 0:v must be
      // mapped without them, or ffmpeg rejects the whole command, which is what
      // happened when replacing audio on a clip that needed no video filters.
      let vLabel = '0:v';
      let vIsFilterOutput = false;
      if (vChain.length) {
        parts.push(`[0:v]${vChain.join(',')}[vbase]`);
        vLabel = 'vbase';
        vIsFilterOutput = true;
      }
      overlays.forEach(({ idx, op }, n) => {
        const scalePct = op.kind === 'watermark' ? op.scalePercent : 100;
        const alpha = op.kind === 'watermark' ? op.opacity / 100 : 1;
        const stampW = Math.max(16, Math.round((frameW * Math.min(scalePct, 80)) / 100));
        const prep =
          op.kind === 'watermark'
            ? `[${idx}:v]scale=${stampW}:-1,format=rgba,colorchannelmixer=aa=${alpha.toFixed(3)}[s${n}]`
            : `[${idx}:v]format=rgba[s${n}]`;
        parts.push(prep);
        const { x, y } = cornerExpr(op.position, op.margin);
        const win = enableWindow(op.start, op.end);
        const out = n === overlays.length - 1 ? 'vout' : `vo${n}`;
        parts.push(`[${vLabel}][s${n}]overlay=${x}:${y}${win}[${out}]`);
        vLabel = out;
        vIsFilterOutput = true;
      });

      let aLabel: string | null = null;
      if (audioReplaceIdx !== null) {
        const chain = graph.audioChain.length ? graph.audioChain.join(',') : 'anull';
        parts.push(`[${audioReplaceIdx}:a]${chain}[aout]`);
        aLabel = 'aout';
      } else if (wantsAudio && graph.audioChain.length) {
        parts.push(`[0:a]${graph.audioChain.join(',')}[aout]`);
        aLabel = 'aout';
      }

      args.push('-filter_complex', parts.join(';'));
      args.push('-map', vIsFilterOutput ? `[${vLabel}]` : vLabel);
      if (aLabel) args.push('-map', `[${aLabel}]`);
      else if (wantsAudio) args.push('-map', '0:a?');
    } else {
      if (vChain.length) args.push('-vf', vChain.join(','));
      if (wantsAudio && graph.audioChain.length) args.push('-af', graph.audioChain.join(','));
      if (!wantsAudio) args.push('-an');
    }
    if (graph.dropAudio) args.push('-an');

    if (isGif) {
      args.push('-y', outPath);
    } else {
      args.push(...outputArgs(job.output, wantsAudio && !graph.dropAudio), '-y', outPath);
    }

    if (signal?.aborted) throw new VideoError('cancelled', 'Cancelled.');

    let code = await ffmpeg.exec(args);
    // Copying the source audio is preferred, but some containers refuse it.
    if (code !== 0 && /could not (write header|find tag)/i.test(log.tail())) {
      const retry = args.map((a) => a);
      code = await ffmpeg.exec(retry);
    }
    if (code !== 0) {
      throw describeFailure(new Error('ffmpeg failed'), log.tail());
    }

    const data = (await ffmpeg.readFile(outPath)) as Uint8Array;
    if (!data || data.length === 0) {
      throw new VideoError('failed', 'Processing finished but produced an empty file.', log.tail());
    }

    return {
      blob: new Blob([data], { type: MIME[job.output.container] ?? 'video/mp4' }),
      filename: outputName(job.input.name, job.ops, job.output),
      note: notes.join(' ') || undefined,
    };
  } catch (e) {
    throw describeFailure(e, log.tail());
  } finally {
    ffmpeg.off('progress', onTick);
    log.stop();
    await cleanup(ffmpeg, temps);
  }
}

/** ASS wants &HBBGGRR, the reverse of CSS. */
function assColour(css: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return '&H00FFFFFF';
  const hex = m[1];
  return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
}

/** A name that says what happened, without ever matching the input. */
export function outputName(original: string, ops: VideoOp[], output: VideoOutput): string {
  const kinds = new Set(ops.map((o) => o.kind));
  let suffix = 'converted';
  if (kinds.has('trim')) suffix = 'trimmed';
  if (kinds.has('cropAspect') || kinds.has('crop')) suffix = 'cropped';
  if (kinds.has('resize')) {
    const r = ops.find((o) => o.kind === 'resize') as Extract<VideoOp, { kind: 'resize' }>;
    suffix = r.width && r.height ? `${r.width}x${r.height}` : 'resized';
  }
  if (kinds.has('rotate') || kinds.has('flip')) suffix = 'rotated';
  if (kinds.has('speed')) suffix = 'speed';
  if (kinds.has('reverse')) suffix = 'reversed';
  if (kinds.has('watermark')) suffix = 'watermarked';
  if (kinds.has('subtitles')) suffix = 'subtitled';
  if (kinds.has('textOverlay')) suffix = 'captioned';
  if (kinds.size > 2) suffix = 'edited';
  return addSuffix(replaceExt(original, output.container), `-${suffix}`);
}
