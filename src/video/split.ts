import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { ConversionResult, ProgressFn } from '../converters/types';
import type { VideoInfo } from './types';
import { VideoError, describeFailure } from './types';
import { probe } from './probe';
import { MAX_VIDEO_BYTES } from './engine';
import { replaceExt } from '../lib/strings';

/**
 * Cutting a video into parts.
 *
 * Copying streams is near-instant but can only cut on a keyframe, and keyframes
 * are typically seconds apart, so the cuts land wherever the nearest one is
 * rather than where they were asked for. Re-encoding puts them exactly on the
 * mark but costs a full encode. Both are offered, and the result says which
 * happened rather than quietly delivering approximate cuts.
 */

export type SplitMode = 'fast' | 'accurate';

export type SplitPlan =
  | { kind: 'every'; seconds: number }
  | { kind: 'at'; times: number[] };

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** Turn a plan into the cut points, in seconds from the start. */
export function cutPoints(plan: SplitPlan, duration: number): number[] {
  if (plan.kind === 'every') {
    if (!(plan.seconds > 0)) throw new VideoError('invalid-range', 'The chunk length has to be more than zero.');
    if (plan.seconds >= duration) {
      throw new VideoError(
        'invalid-range',
        `Each part would be ${plan.seconds}s but the video is only ${Math.round(duration)}s, so there is nothing to split.`,
      );
    }
    const out: number[] = [];
    for (let t = plan.seconds; t < duration - 0.05; t += plan.seconds) out.push(Math.round(t * 1000) / 1000);
    return out;
  }
  const times = [...new Set(plan.times.filter((t) => t > 0 && t < duration))].sort((a, b) => a - b);
  if (!times.length) {
    throw new VideoError('invalid-range', 'None of those timestamps fall inside the video.');
  }
  return times;
}

/** Ranges [start, end) covering the whole video, derived from the cut points. */
export function segmentsFor(cuts: number[], duration: number): { start: number; end: number }[] {
  const bounds = [0, ...cuts, duration];
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 0.05) out.push({ start: bounds[i], end: bounds[i + 1] });
  }
  return out;
}

export interface SplitResult extends ConversionResult {
  partCount: number;
}

export async function splitVideo(
  file: File,
  plan: SplitPlan,
  mode: SplitMode,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<SplitResult> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new VideoError(
      'too-large',
      `This video is ${Math.round(file.size / 1048576)} MB, past what the browser can hold. Try a shorter clip.`,
    );
  }

  const { sharedFFmpeg } = await import('../converters/mediaConverters');
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg: FFmpeg = await sharedFFmpeg();

  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    lines.push(message);
    if (lines.length > 300) lines.shift();
  };
  ffmpeg.on('log', onLog);

  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inPath = `sp_in.${ext}`;
  const temps: string[] = [inPath];

  try {
    await ffmpeg.writeFile(inPath, await fetchFile(file));
    const info: VideoInfo = await probe(ffmpeg, inPath, file.name, file.size);
    if (!info.durationSeconds) throw new VideoError('corrupt', 'This video reports no duration, so it cannot be split.');

    const cuts = cutPoints(plan, info.durationSeconds);
    const segments = segmentsFor(cuts, info.durationSeconds);
    if (segments.length > 60) {
      throw new VideoError(
        'invalid-range',
        `That would make ${segments.length} files. Keep it to 60 or fewer, or use longer chunks.`,
      );
    }

    const base = replaceExt(file.name, '').replace(/\.$/, '');
    const parts: { name: string; data: Uint8Array }[] = [];

    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) throw new VideoError('cancelled', 'Cancelled.');
      const { start, end } = segments[i];
      const outName = `${base}_part_${pad3(i + 1)}.mp4`;
      const outPath = `sp_out_${i}.mp4`;
      temps.push(outPath);

      const args = ['-hide_banner', '-ss', String(start), '-i', inPath, '-t', String(end - start)];
      if (mode === 'fast') {
        // -c copy cannot cut between keyframes, so the boundary moves to the
        // nearest one. Fast, and fine when the exact frame does not matter.
        //
        // -reset_timestamps is load-bearing: without it each part keeps its
        // position on the original timeline, so part two of a 4s split reports
        // itself as 8s long and every player shows a wrong scrubber.
        //
        // Do not add -avoid_negative_ts make_zero here. It overrides the reset
        // whichever order the two are given in, and the cumulative durations
        // come straight back.
        args.push('-c', 'copy', '-reset_timestamps', '1');
      } else {
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p');
        if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
      }
      args.push('-movflags', '+faststart', '-y', outPath);

      const code = await ffmpeg.exec(args);
      if (code !== 0) throw describeFailure(new Error('split failed'), lines.slice(-20).join('\n'));
      const data = (await ffmpeg.readFile(outPath)) as Uint8Array;
      if (data && data.length > 0) parts.push({ name: outName, data: data.slice() });
      onProgress?.((i + 1) / segments.length);
    }

    if (!parts.length) throw new VideoError('failed', 'Splitting produced no usable parts.');

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const p of parts) zip.file(p.name, p.data);
    const blob = await zip.generateAsync({ type: 'blob' });

    const note =
      mode === 'fast'
        ? `${parts.length} parts. Cuts land on the nearest keyframe, so they can be a second or so off. ` +
          'Choose exact cutting if the timing has to be precise.'
        : `${parts.length} parts, cut exactly where you asked.`;

    return {
      blob,
      filename: `${base}_parts.zip`,
      note,
      partCount: parts.length,
    };
  } catch (e) {
    throw describeFailure(e, lines.slice(-20).join('\n'));
  } finally {
    ffmpeg.off('log', onLog);
    for (const p of temps) {
      try {
        await ffmpeg.deleteFile(p);
      } catch {
        /* fine */
      }
    }
  }
}
