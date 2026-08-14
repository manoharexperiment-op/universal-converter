import type { Corner, VideoInfo, VideoOp, VideoOutput } from './types';
import { VideoError } from './types';

/**
 * Turns a list of operations into one ffmpeg filter graph.
 *
 * Building a single graph rather than running a pass per operation is the whole
 * point: trimming, cropping, resizing and stamping a watermark all happen in one
 * decode/encode instead of four, which on a single-threaded wasm build is the
 * difference between a minute and four.
 *
 * A comma inside a filter argument separates arguments to the *next* filter
 * unless escaped, so anything containing one is written `\\,`.
 */

export interface BuiltGraph {
  /** Filters applied to the video stream, in order. */
  videoChain: string[];
  /** Filters applied to the audio stream, in order. */
  audioChain: string[];
  /** Extra `-i` inputs the graph refers to, in the order they are added. */
  extraInputs: { path: string; source: File | 'silence' }[];
  /** Set when an operation removes the audio track entirely. */
  dropAudio: boolean;
  /** Trim is expressed as seek flags, not filters, because it is far faster. */
  seek?: { start?: number; end?: number };
  /** Warnings worth surfacing without failing the job. */
  notes: string[];
}

/** Where a stamp sits, as an x/y expression pair for `overlay`. */
export function cornerExpr(position: Corner, margin: number): { x: string; y: string } {
  const m = Math.max(0, Math.round(margin));
  const left = `${m}`;
  const right = `W-w-${m}`;
  const centerX = '(W-w)/2';
  const top = `${m}`;
  const bottom = `H-h-${m}`;
  const centerY = '(H-h)/2';
  switch (position) {
    case 'top-left': return { x: left, y: top };
    case 'top-center': return { x: centerX, y: top };
    case 'top-right': return { x: right, y: top };
    case 'center': return { x: centerX, y: centerY };
    case 'bottom-left': return { x: left, y: bottom };
    case 'bottom-center': return { x: centerX, y: bottom };
    default: return { x: right, y: bottom };
  }
}

/** Even dimensions, because H.264 cannot encode odd ones. */
function even(n: number): number {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v - 1;
}

function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

/**
 * How long the result will actually run.
 *
 * Trimming and speed both change it, and a fade-out has to be placed against
 * the final length rather than the source's. Positioning it from the original
 * duration puts the fade past the end of a trimmed clip, where it silently does
 * nothing at all.
 */
export function effectiveDuration(ops: VideoOp[], sourceDuration: number): number {
  let d = sourceDuration;
  for (const op of ops) {
    if (op.kind === 'trim') {
      const start = Math.max(0, op.start);
      const end = op.end === undefined ? d : Math.min(op.end, d);
      d = Math.max(0, end - start);
    } else if (op.kind === 'speed' && op.factor > 0) {
      d = d / op.factor;
    }
  }
  return d;
}

export function buildGraph(ops: VideoOp[], info: VideoInfo, output: VideoOutput): BuiltGraph {
  // Fades are placed against the finished length, so this is needed up front
  // rather than as the operations are walked.
  const finalDuration = effectiveDuration(ops, info.durationSeconds);
  const g: BuiltGraph = { videoChain: [], audioChain: [], extraInputs: [], dropAudio: false, notes: [] };

  // Track the frame size as filters change it, so later operations that depend
  // on it (a percentage-sized watermark, a centre crop) use the real numbers.
  let w = info.width;
  let h = info.height;

  for (const op of ops) {
    switch (op.kind) {
      case 'trim': {
        const start = Math.max(0, op.start);
        const end = op.end;
        if (end !== undefined && end <= start) {
          throw new VideoError('invalid-range', 'The end time has to be after the start time.');
        }
        if (start >= info.durationSeconds) {
          throw new VideoError(
            'invalid-range',
            `The start time is past the end of this video, which is ${Math.floor(info.durationSeconds)} seconds long.`,
          );
        }
        g.seek = { start: start > 0 ? start : undefined, end };
        break;
      }

      case 'crop': {
        const cw = even(op.width);
        const ch = even(op.height);
        if (cw <= 0 || ch <= 0) throw new VideoError('invalid-crop', 'The crop size has to be bigger than zero.');
        if (op.x < 0 || op.y < 0 || op.x + cw > w || op.y + ch > h) {
          throw new VideoError('invalid-crop', 'That crop falls outside the video.');
        }
        g.videoChain.push(`crop=${cw}:${ch}:${Math.round(op.x)}:${Math.round(op.y)}`);
        w = cw;
        h = ch;
        break;
      }

      case 'cropAspect': {
        // Centre crop to the target ratio, taking the largest rectangle that
        // fits. Never scales, so nothing is stretched.
        const current = w / h;
        let cw = w;
        let ch = h;
        if (current > op.ratio) cw = even(h * op.ratio);
        else ch = even(w / op.ratio);
        g.videoChain.push(`crop=${cw}:${ch}:${Math.round((w - cw) / 2)}:${Math.round((h - ch) / 2)}`);
        w = cw;
        h = ch;
        break;
      }

      case 'resize': {
        const tw = op.width ? even(op.width) : null;
        const th = op.height ? even(op.height) : null;
        if (!tw && !th) break;
        if (!op.allowUpscale && tw && th && tw >= w && th >= h) {
          g.notes.push('The video was already smaller than the target size, so it was left as it is.');
          break;
        }
        if (tw && th) {
          if (op.fit === 'stretch') {
            g.videoChain.push(`scale=${tw}:${th}`);
          } else if (op.fit === 'cover') {
            // Fill the frame, then trim the overflow: no bars, no distortion.
            g.videoChain.push(`scale=${tw}:${th}:force_original_aspect_ratio=increase`, `crop=${tw}:${th}`);
          } else {
            // Fit inside and pad, so the whole picture survives.
            g.videoChain.push(
              `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
              `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=black`,
            );
          }
          w = tw;
          h = th;
        } else if (tw) {
          g.videoChain.push(`scale=${tw}:-2`);
          h = even((h * tw) / w);
          w = tw;
        } else if (th) {
          g.videoChain.push(`scale=-2:${th}`);
          w = even((w * th) / h);
          h = th;
        }
        break;
      }

      case 'rotate': {
        if (op.degrees === 90) g.videoChain.push('transpose=1');
        else if (op.degrees === 270) g.videoChain.push('transpose=2');
        else g.videoChain.push('transpose=1', 'transpose=1');
        if (op.degrees !== 180) [w, h] = [h, w];
        break;
      }

      case 'flip':
        g.videoChain.push(op.axis === 'horizontal' ? 'hflip' : 'vflip');
        break;

      case 'fps':
        g.videoChain.push(`fps=${op.value}`);
        break;

      case 'speed': {
        const f = op.factor;
        if (!Number.isFinite(f) || f <= 0) throw new VideoError('failed', 'That speed is not a usable number.');
        g.videoChain.push(`setpts=${(1 / f).toFixed(6)}*PTS`);
        // atempo only accepts 0.5..2.0 per instance, so chain them for anything
        // beyond that rather than silently clamping the audio out of sync.
        let remaining = f;
        const steps: number[] = [];
        while (remaining > 2.0) {
          steps.push(2.0);
          remaining /= 2.0;
        }
        while (remaining < 0.5) {
          steps.push(0.5);
          remaining /= 0.5;
        }
        steps.push(remaining);
        g.audioChain.push(...steps.map((s) => `atempo=${s.toFixed(6)}`));
        break;
      }

      case 'reverse':
        g.videoChain.push('reverse');
        if (op.audio === 'reverse') g.audioChain.push('areverse');
        else if (op.audio === 'drop') g.dropAudio = true;
        break;

      case 'volume':
        g.audioChain.push(`volume=${op.gain.toFixed(3)}`);
        break;

      case 'audioFade': {
        if (op.inSeconds && op.inSeconds > 0) g.audioChain.push(`afade=t=in:st=0:d=${op.inSeconds}`);
        if (op.outSeconds && op.outSeconds > 0) {
          // Against the finished length, not the source's: a 6s clip trimmed to
          // 3s would otherwise put the fade at 5s, past the end, doing nothing.
          const fade = Math.min(op.outSeconds, finalDuration);
          const at = Math.max(0, finalDuration - fade);
          g.audioChain.push(`afade=t=out:st=${at.toFixed(3)}:d=${fade.toFixed(3)}`);
        }
        break;
      }

      case 'normalizeAudio':
        g.audioChain.push('loudnorm=I=-16:TP=-1.5:LRA=11');
        break;

      case 'removeAudio':
        g.dropAudio = true;
        break;

      case 'setAudio':
        g.extraInputs.push({ path: `extra_audio_${g.extraInputs.length}`, source: op.file });
        break;

      case 'subtitles':
        // Handled by the runner: it has to write the file and load fonts first.
        break;

      case 'watermark': {
        g.extraInputs.push({ path: `wm_${g.extraInputs.length}.png`, source: op.image });
        break;
      }

      case 'textOverlay':
        // Rendered to a PNG on a canvas by the runner, then overlaid. drawtext
        // is not used: it needs a font baked in and cannot reach device fonts,
        // so emoji and Indic scripts would come out blank.
        break;
    }
  }

  if (output.fps && !ops.some((o) => o.kind === 'fps')) g.videoChain.push(`fps=${output.fps}`);
  return g;
}

/** Codec and container flags for the requested output. */
export function outputArgs(output: VideoOutput, hasAudio: boolean): string[] {
  const a: string[] = [];
  switch (output.container) {
    case 'webm':
      // VP8 + Vorbis: VP9 is far slower in wasm for little gain at these sizes.
      a.push('-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '5');
      a.push('-b:v', output.videoBitrate ?? '1M');
      if (hasAudio) a.push('-c:a', 'libvorbis');
      break;
    case 'gif':
      break; // the runner handles GIF with its own palette pass
    default:
      a.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
      a.push('-crf', String(output.crf ?? 26));
      if (output.videoBitrate) a.push('-b:v', output.videoBitrate);
      if (hasAudio) a.push('-c:a', 'aac', '-b:a', output.audioBitrate ?? '160k');
      break;
  }
  if (['mp4', 'm4v', 'mov'].includes(output.container)) a.push('-movflags', '+faststart');
  return a;
}

export { escapeFilterValue };
