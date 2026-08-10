import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { VideoInfo } from './types';
import { VideoError } from './types';

/**
 * Read a file's properties.
 *
 * There is no ffprobe in the wasm build, so this runs `ffmpeg -i` (which exits
 * non-zero because no output was requested, that is expected) and reads the
 * metadata it prints while opening the file. Nothing is decoded or re-encoded,
 * so it is fast even on a large video.
 */
export async function probe(ffmpeg: FFmpeg, path: string, filename: string, sizeBytes: number): Promise<VideoInfo> {
  const lines: string[] = [];
  const collect = ({ message }: { message: string }) => lines.push(message);
  ffmpeg.on('log', collect);
  try {
    await ffmpeg.exec(['-hide_banner', '-i', path]);
  } catch {
    /* exiting non-zero here is normal: there is no output file */
  } finally {
    ffmpeg.off('log', collect);
  }
  return parseProbe(lines.join('\n'), filename, sizeBytes);
}

/** Split out from `probe` so the parsing can be tested without running ffmpeg. */
export function parseProbe(text: string, filename: string, sizeBytes: number): VideoInfo {
  const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  const durationSeconds = dur ? +dur[1] * 3600 + +dur[2] * 60 + parseFloat(dur[3]) : 0;

  const videoLine = /Stream #\d+:\d+.*?: Video: ([^\s,]+).*/.exec(text);
  const audioLine = /Stream #\d+:\d+.*?: Audio: ([^\s,]+).*/.exec(text);

  // Dimensions appear as "1920x1080" on the video stream line, but so can a
  // display-aspect hint, so read it from that line only.
  let width = 0;
  let height = 0;
  if (videoLine) {
    const dim = /(\d{2,5})x(\d{2,5})/.exec(videoLine[0]);
    if (dim) {
      width = +dim[1];
      height = +dim[2];
    }
  }

  const fpsMatch = videoLine ? /([\d.]+)\s+fps/.exec(videoLine[0]) : null;
  const bitrateMatch = /bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  const formatMatch = /Input #0,\s*([^,]+),/.exec(text);

  return {
    filename,
    sizeBytes,
    durationSeconds,
    width,
    height,
    fps: fpsMatch ? Math.round(parseFloat(fpsMatch[1]) * 100) / 100 : null,
    videoCodec: videoLine ? videoLine[1] : null,
    audioCodec: audioLine ? audioLine[1] : null,
    hasAudio: !!audioLine,
    bitrateKbps: bitrateMatch ? +bitrateMatch[1] : null,
    format: formatMatch ? formatMatch[1].trim() : null,
  };
}

/** Reject a file we know we cannot open, before spending minutes on it. */
export function assertUsable(info: VideoInfo): void {
  if (!info.width || !info.height) {
    throw new VideoError(
      'corrupt',
      'No video track was found in this file. It may be audio-only, incomplete, or damaged.',
    );
  }
  if (!info.durationSeconds) {
    throw new VideoError('corrupt', 'This video reports no duration, which usually means the file is incomplete.');
  }
}

/** "1:23" and "01:02:03.5" and "90" all mean something sensible to a person. */
export function parseTimecode(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);

  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p.trim()))) return null;

  const nums = parts.map((p) => parseFloat(p));
  const seconds = parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Seconds back to "1:05" or "1:02:03" for display. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
