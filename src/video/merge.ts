import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { ConversionResult, ProgressFn } from '../converters/types';
import type { VideoInfo, VideoOutput } from './types';
import { VideoError, describeFailure } from './types';
import { outputArgs } from './graph';
import { probe } from './probe';
import { MAX_VIDEO_BYTES } from './engine';

/**
 * Joining videos.
 *
 * The obvious approach, listing the files for the concat demuxer and copying
 * streams, is a trap. Given a 320x240 clip followed by a 640x360 one it exits 0
 * and reports the correct total duration, but the container header keeps the
 * first clip's size while later frames carry the second's. Players show the
 * first clip and then garbage, or stop early. Verified in this build.
 *
 * So every input is normalised to a common size, aspect, frame rate and sample
 * rate first, and clips with no audio get silence, because `concat` refuses to
 * run when its inputs disagree about how many streams they have.
 */

export interface MergeSource {
  file: File;
  info: VideoInfo;
}

export interface MergeSettings {
  /** Target frame size. 'auto' uses the largest input, so nothing is upscaled. */
  width?: number;
  height?: number;
  fps?: number;
  output: VideoOutput;
}

function even(n: number): number {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v - 1;
}

/** Pick a frame size that suits the whole set rather than only the first clip. */
export function chooseTargetSize(infos: VideoInfo[]): { width: number; height: number; fps: number } {
  const width = even(Math.max(...infos.map((i) => i.width)));
  const height = even(Math.max(...infos.map((i) => i.height)));
  const fpsValues = infos.map((i) => i.fps ?? 30).filter((f) => f > 0);
  // The highest frame rate, so no clip is decimated, capped at something the
  // browser can actually encode in reasonable time.
  const fps = Math.min(60, Math.max(...fpsValues, 24));
  return { width: Math.max(2, width), height: Math.max(2, height), fps: Math.round(fps) };
}

/** Total running time of the merge, for the UI to show before committing. */
export function estimatedDuration(infos: VideoInfo[]): number {
  return infos.reduce((sum, i) => sum + i.durationSeconds, 0);
}

function extOf(name: string) {
  return (name.split('.').pop() || 'bin').toLowerCase();
}

export async function mergeVideos(
  sources: MergeSource[],
  settings: MergeSettings,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  if (sources.length < 2) {
    throw new VideoError('failed', 'Pick at least two videos to join.');
  }
  const total = sources.reduce((s, x) => s + x.file.size, 0);
  if (total > MAX_VIDEO_BYTES) {
    throw new VideoError(
      'too-large',
      `Those videos come to ${Math.round(total / 1048576)} MB together. The browser can handle about ` +
        `${Math.round(MAX_VIDEO_BYTES / 1048576)} MB. Try joining fewer at a time.`,
    );
  }

  const { sharedFFmpeg } = await import('../converters/mediaConverters');
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg: FFmpeg = await sharedFFmpeg();

  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    lines.push(message);
    if (lines.length > 400) lines.shift();
  };
  ffmpeg.on('log', onLog);
  const onTick = ({ progress }: { progress: number }) => {
    if (onProgress && progress >= 0 && progress <= 1) onProgress(progress);
  };
  ffmpeg.on('progress', onTick);

  const temps: string[] = [];
  const target = {
    width: settings.width ?? chooseTargetSize(sources.map((s) => s.info)).width,
    height: settings.height ?? chooseTargetSize(sources.map((s) => s.info)).height,
    fps: settings.fps ?? chooseTargetSize(sources.map((s) => s.info)).fps,
  };
  const outPath = `merged.${settings.output.container}`;
  temps.push(outPath);

  try {
    const args: string[] = ['-hide_banner'];
    for (let i = 0; i < sources.length; i++) {
      const p = `m${i}.${extOf(sources[i].file.name)}`;
      await ffmpeg.writeFile(p, await fetchFile(sources[i].file));
      temps.push(p);
      args.push('-i', p);
      if (signal?.aborted) throw new VideoError('cancelled', 'Cancelled.');
    }

    // One silent source to stand in for any clip that has no audio, so every
    // branch of the concat has both a video and an audio stream.
    const anyMissingAudio = sources.some((s) => !s.info.hasAudio);
    const silenceIndex = sources.length;
    if (anyMissingAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }

    const parts: string[] = [];
    const labels: string[] = [];
    sources.forEach((s, i) => {
      // Fit inside the target and pad, so nothing is stretched or cropped away.
      parts.push(
        `[${i}:v]scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,` +
          `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `setsar=1,fps=${target.fps},format=yuv420p[v${i}]`,
      );
      if (s.info.hasAudio) {
        parts.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        // Trim the endless silence to this clip's length, or concat never ends.
        parts.push(
          `[${silenceIndex}:a]atrim=duration=${s.info.durationSeconds.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
        );
      }
      labels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${labels.join('')}concat=n=${sources.length}:v=1:a=1[vout][aout]`);

    args.push('-filter_complex', parts.join(';'));
    args.push('-map', '[vout]', '-map', '[aout]');
    args.push(...outputArgs(settings.output, true));
    args.push('-y', outPath);

    if (signal?.aborted) throw new VideoError('cancelled', 'Cancelled.');
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw describeFailure(new Error('merge failed'), lines.slice(-25).join('\n'));

    const data = (await ffmpeg.readFile(outPath)) as Uint8Array;
    if (!data || data.length === 0) {
      throw new VideoError('failed', 'The join finished but produced an empty file.', lines.slice(-25).join('\n'));
    }

    // Confirm the result is really one consistent video rather than a file that
    // merely opens, which is exactly how the naive approach fails.
    const check = await probe(ffmpeg, outPath, outPath, data.length);
    const expected = estimatedDuration(sources.map((s) => s.info));
    const drift = Math.abs(check.durationSeconds - expected);
    const notes: string[] = [];
    if (drift > Math.max(1, expected * 0.05)) {
      notes.push(
        `The joined video is ${Math.round(check.durationSeconds)}s but the clips add up to ${Math.round(expected)}s. ` +
          'One of them may be damaged.',
      );
    }
    if (check.width !== target.width || check.height !== target.height) {
      notes.push(`Output came out ${check.width}x${check.height} rather than ${target.width}x${target.height}.`);
    }

    const mime = settings.output.container === 'webm' ? 'video/webm' : 'video/mp4';
    return {
      blob: new Blob([data], { type: mime }),
      filename: `merged_video.${settings.output.container}`,
      note:
        `Joined ${sources.length} videos at ${target.width}x${target.height}, ${Math.round(check.durationSeconds)}s total. ` +
        (anyMissingAudio ? 'Clips without sound were given silence so the audio stays in step. ' : '') +
        notes.join(' '),
    };
  } catch (e) {
    throw describeFailure(e, lines.slice(-25).join('\n'));
  } finally {
    ffmpeg.off('progress', onTick);
    ffmpeg.off('log', onLog);
    for (const p of temps) {
      try {
        await ffmpeg.deleteFile(p);
      } catch {
        /* never written, or already gone */
      }
    }
  }
}
