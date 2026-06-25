import type { ConversionResult, ParamValues, ProgressFn } from './types';
import { replaceExt } from '../lib/strings';

// Single-threaded ffmpeg core: no SharedArrayBuffer, so NO cross-origin
// isolation (COOP/COEP) is required — which keeps the in-browser OCR working.
// Pinned to a version compatible with @ffmpeg/ffmpeg 0.12.x.
const CORE_VERSION = '0.12.6';
// ESM build: @ffmpeg/ffmpeg's class worker is a module worker, so it loads the
// core via dynamic import() (not importScripts) — the UMD build fails there.
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

// In-browser transcoding loads the whole file into a 32-bit wasm heap; large
// inputs blow the ~2 GB ceiling and hard-crash the tab. Refuse them up front.
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

let ffmpegPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;

/** Load the ~30 MB ffmpeg core once and reuse it for every conversion. */
async function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL } = await import('@ffmpeg/util');
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

/** Optional warm-up (e.g. when the user picks a media file) to hide the load. */
export function preloadFFmpeg() {
  return getFFmpeg();
}

function assertSize(file: File, max: number) {
  if (file.size > max) {
    throw new Error(
      `This file is ${Math.round(file.size / 1048576)} MB — too large to process in the browser ` +
        `(limit ~${Math.round(max / 1048576)} MB). Try a shorter or smaller clip.`,
    );
  }
}

function extOf(name: string) {
  return (name.split('.').pop() || 'bin').toLowerCase();
}

/** Run a single ffmpeg command and return the named output as a blob. */
async function run(
  file: File,
  job: { outExt: string; mime: string; args: (input: string, output: string) => string[] },
  onProgress?: ProgressFn,
): Promise<ConversionResult> {
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await getFFmpeg();

  const input = `input.${extOf(file.name)}`;
  const output = `output.${job.outExt}`;

  const handleProgress = ({ progress }: { progress: number }) => {
    if (onProgress && progress >= 0 && progress <= 1) onProgress(progress);
  };
  ffmpeg.on('progress', handleProgress);
  try {
    await ffmpeg.writeFile(input, await fetchFile(file));
    const code = await ffmpeg.exec(job.args(input, output));
    if (code !== 0) throw new Error('ffmpeg could not process this file (unsupported codec or corrupt input).');

    const data = (await ffmpeg.readFile(output)) as Uint8Array;
    const blob = new Blob([data], { type: job.mime });
    try {
      await ffmpeg.deleteFile(input);
      await ffmpeg.deleteFile(output);
    } catch {
      /* non-fatal */
    }
    return { blob, filename: replaceExt(file.name, job.outExt) };
  } finally {
    ffmpeg.off('progress', handleProgress);
  }
}

/* ----------------------------- Audio ----------------------------- */

/** Extract / convert the audio track to MP3 at a chosen bitrate. */
export function toMp3(file: File, onProgress?: ProgressFn, params?: ParamValues) {
  const bitrate = String(params?.bitrate ?? '192k');
  return run(
    file,
    { outExt: 'mp3', mime: 'audio/mpeg', args: (i, o) => ['-i', i, '-vn', '-acodec', 'libmp3lame', '-b:a', bitrate, o] },
    onProgress,
  );
}

/** Extract / convert the audio track to WAV (uncompressed). */
export function toWav(file: File, onProgress?: ProgressFn) {
  return run(
    file,
    { outExt: 'wav', mime: 'audio/wav', args: (i, o) => ['-i', i, '-vn', '-acodec', 'pcm_s16le', o] },
    onProgress,
  );
}

/** Trim an audio file to [start, end] seconds (end 0 = to the end), output MP3. */
export function trimAudio(file: File, onProgress?: ProgressFn, params?: ParamValues) {
  const start = Math.max(0, Number(params?.start ?? 0));
  const end = Number(params?.end ?? 0);
  const bitrate = String(params?.bitrate ?? '192k');
  return run(
    file,
    {
      outExt: 'mp3',
      mime: 'audio/mpeg',
      // -ss AFTER -i = sample-accurate seek (re-encodes); right choice for audio.
      args: (i, o) => {
        const a = ['-i', i, '-vn'];
        if (start > 0) a.push('-ss', String(start));
        if (end > start) a.push('-to', String(end));
        a.push('-acodec', 'libmp3lame', '-b:a', bitrate, o);
        return a;
      },
    },
    onProgress,
  );
}

/* ----------------------------- Video ----------------------------- */

// `scale=min(W,iw):-2` keeps aspect ratio, never upscales, forces even dims.
// The comma inside min() must be escaped so the filtergraph parser keeps it.
const scaleDown = (maxW: number) => `scale=min(${maxW}\\,iw):-2`;

/** Video → GIF via a two-pass palette for clean color (small, good quality). */
export async function videoToGif(file: File, onProgress?: ProgressFn, params?: ParamValues): Promise<ConversionResult> {
  assertSize(file, MAX_VIDEO_BYTES);
  const fps = Math.min(Number(params?.fps ?? 12), 20);
  const width = Math.min(Number(params?.width ?? 480), 800);

  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await getFFmpeg();
  const input = `in.${extOf(file.name)}`;

  const handleProgress = ({ progress }: { progress: number }) => {
    if (onProgress && progress >= 0 && progress <= 1) onProgress(progress);
  };
  ffmpeg.on('progress', handleProgress);
  try {
    await ffmpeg.writeFile(input, await fetchFile(file));
    const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
    // Pass 1: build an optimal palette. Pass 2: apply it.
    await ffmpeg.exec(['-i', input, '-vf', `${vf},palettegen`, 'palette.png']);
    const code = await ffmpeg.exec(['-i', input, '-i', 'palette.png', '-filter_complex', `${vf}[x];[x][1:v]paletteuse`, 'out.gif']);
    if (code !== 0) throw new Error('Could not convert this video to GIF.');

    const data = (await ffmpeg.readFile('out.gif')) as Uint8Array;
    const blob = new Blob([data], { type: 'image/gif' });
    try {
      await ffmpeg.deleteFile(input);
      await ffmpeg.deleteFile('palette.png');
      await ffmpeg.deleteFile('out.gif');
    } catch {
      /* non-fatal */
    }
    return { blob, filename: replaceExt(file.name, 'gif') };
  } finally {
    ffmpeg.off('progress', handleProgress);
  }
}

/** Convert a video to WebM (VP8 + Vorbis — far faster than VP9 in wasm). */
export function videoToWebm(file: File, onProgress?: ProgressFn, params?: ParamValues) {
  assertSize(file, MAX_VIDEO_BYTES);
  const maxW = Number(params?.maxWidth ?? 1280);
  return run(
    file,
    {
      outExt: 'webm',
      mime: 'video/webm',
      args: (i, o) => [
        '-i', i, '-vf', scaleDown(maxW),
        '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '5',
        '-c:a', 'libvorbis', o, // WebM needs vorbis/opus, NOT aac
      ],
    },
    onProgress,
  );
}

/** Convert a video to MP4 (H.264 + AAC), fast preset. */
export function videoToMp4(file: File, onProgress?: ProgressFn, params?: ParamValues) {
  assertSize(file, MAX_VIDEO_BYTES);
  const maxW = Number(params?.maxWidth ?? 1280);
  return run(
    file,
    {
      outExt: 'mp4',
      mime: 'video/mp4',
      args: (i, o) => [
        '-i', i, '-vf', scaleDown(maxW),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k', o,
      ],
    },
    onProgress,
  );
}

const VIDEO_COMPRESS: Record<string, { crf: number; w: number }> = {
  light: { crf: 26, w: 1280 },
  balanced: { crf: 30, w: 960 },
  strong: { crf: 34, w: 640 },
};

/** Compress (re-encode smaller) a video to MP4 at a chosen level. */
export function compressVideo(file: File, onProgress?: ProgressFn, params?: ParamValues) {
  assertSize(file, MAX_VIDEO_BYTES);
  const { crf, w } = VIDEO_COMPRESS[String(params?.level ?? 'balanced')] ?? VIDEO_COMPRESS.balanced;
  return run(
    file,
    {
      outExt: 'mp4',
      mime: 'video/mp4',
      args: (i, o) => [
        '-i', i, '-vf', scaleDown(w),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf),
        '-c:a', 'aac', '-b:a', '128k', o,
      ],
    },
    onProgress,
  );
}
