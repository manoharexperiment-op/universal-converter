/**
 * The typed description of a video edit.
 *
 * Nothing outside `src/video/` builds ffmpeg arguments. The UI describes *what*
 * it wants as a list of operations and the engine decides how to express that,
 * which is what lets several operations run as one pass instead of writing an
 * intermediate file between every step.
 */

/** Seconds from the start of the clip. */
export type Seconds = number;

export type Fit = 'contain' | 'cover' | 'stretch';

export type Corner =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** A single edit. Operations are applied in the order given. */
export type VideoOp =
  | { kind: 'trim'; start: Seconds; end?: Seconds }
  | { kind: 'crop'; x: number; y: number; width: number; height: number }
  /** Crop to an aspect ratio, centred, without stretching. */
  | { kind: 'cropAspect'; ratio: number }
  | { kind: 'resize'; width?: number; height?: number; fit: Fit; allowUpscale: boolean }
  | { kind: 'rotate'; degrees: 90 | 180 | 270 }
  | { kind: 'flip'; axis: 'horizontal' | 'vertical' }
  | { kind: 'speed'; factor: number; keepPitch: boolean }
  | { kind: 'reverse'; audio: 'reverse' | 'drop' | 'keep' }
  | { kind: 'fps'; value: number }
  | { kind: 'volume'; gain: number }
  | { kind: 'audioFade'; inSeconds?: number; outSeconds?: number }
  | { kind: 'normalizeAudio' }
  | { kind: 'removeAudio' }
  /** Replace or supply the audio track from another file. */
  | { kind: 'setAudio'; file: File; mode: 'replace' | 'mix' }
  | { kind: 'subtitles'; file: File; style: SubtitleStyle }
  | { kind: 'watermark'; image: File; position: Corner; scalePercent: number; opacity: number; margin: number; start?: Seconds; end?: Seconds }
  | { kind: 'textOverlay'; text: string; position: Corner; sizePercent: number; color: string; opacity: number; outline: boolean; background: boolean; margin: number; start?: Seconds; end?: Seconds };

export interface SubtitleStyle {
  fontSizePercent: number;
  color: string;
  outline: boolean;
  background: boolean;
  position: 'top' | 'center' | 'bottom';
  marginPercent: number;
}

export type VideoContainer = 'mp4' | 'webm' | 'mov' | 'mkv' | 'avi' | 'gif';

export interface VideoOutput {
  container: VideoContainer;
  /** Constant Rate Factor. Lower is better quality. Ignored for GIF. */
  crf?: number;
  videoBitrate?: string;
  audioBitrate?: string;
  fps?: number;
  /** GIF only. */
  gifWidth?: number;
}

export interface VideoJob {
  input: File;
  /** Extra inputs for operations that need them (merge sources). */
  extraInputs?: File[];
  ops: VideoOp[];
  output: VideoOutput;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What the UI renders while a batch runs. */
export interface JobState {
  id: string;
  name: string;
  status: JobStatus;
  /** 0..1 for the individual job. */
  progress: number;
  message?: string;
  error?: string;
  /** Raw ffmpeg tail, shown only behind a "technical details" disclosure. */
  detail?: string;
  result?: { blob: Blob; filename: string };
  startedAt?: number;
  finishedAt?: number;
}

/** Everything the engine knows about a source file before touching it. */
export interface VideoInfo {
  filename: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  bitrateKbps: number | null;
  format: string | null;
}

/** Failures the UI can explain in plain words instead of an exit code. */
export type VideoErrorKind =
  | 'unsupported'
  | 'corrupt'
  | 'no-audio'
  | 'too-large'
  | 'out-of-memory'
  | 'invalid-range'
  | 'invalid-crop'
  | 'bad-subtitle'
  | 'cancelled'
  | 'failed';

export class VideoError extends Error {
  kind: VideoErrorKind;
  /** ffmpeg's own output, for the expandable technical section. */
  detail?: string;
  constructor(kind: VideoErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'VideoError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Turn any thrown value into something worth showing a person. */
export function describeFailure(e: unknown, detail?: string): VideoError {
  if (e instanceof VideoError) return e;
  const raw = e instanceof Error ? e.message : String(e);
  const hay = `${raw}\n${detail ?? ''}`.toLowerCase();

  if (/out of memory|allocation failed|maximum call stack|oom/.test(hay)) {
    return new VideoError(
      'out-of-memory',
      'The browser ran out of memory on this video. Try a shorter clip, or reduce the output size first.',
      detail,
    );
  }
  if (/no such file|invalid data found|moov atom not found|header/.test(hay)) {
    return new VideoError(
      'corrupt',
      'This file could not be read. It may be incomplete or damaged.',
      detail,
    );
  }
  if (/decoder .* not found|unknown encoder|codec not currently supported|unsupported/.test(hay)) {
    return new VideoError(
      'unsupported',
      'This video uses a format the app cannot process. Converting it to MP4 first usually works.',
      detail,
    );
  }
  if (/does not contain any stream|stream map .* matches no streams/.test(hay)) {
    return new VideoError('no-audio', 'This video has no audio track, so that step was skipped.', detail);
  }
  return new VideoError(
    'failed',
    'This video could not be processed. It may use an unsupported codec, or the file may be damaged.',
    detail,
  );
}
