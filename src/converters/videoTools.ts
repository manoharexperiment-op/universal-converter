import type { ConversionResult, ParamControl, ParamValues, ProgressFn, TargetOption } from './types';
import { asFile } from './types';
import type { VideoOp, VideoOutput } from '../video/types';
import { VideoError } from '../video/types';
import { formatTimecode, parseTimecode } from '../video/probe';
import { addSuffix, replaceExt } from '../lib/strings';
import { asPipeline, stepsToOps } from './videoPipeline';

/**
 * The registry's view of the video engine.
 *
 * Each entry turns the values a person typed into typed operations and hands
 * them to `runJob`. Nothing here builds an ffmpeg command; that stays inside
 * `src/video/`.
 */

const lazy = () => import('../video/engine');

function timecodeOr(value: unknown, fallback: number | null, field: string): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const parsed = parseTimecode(raw);
  if (parsed === null) {
    throw new VideoError(
      'invalid-range',
      `"${raw}" is not a time I can read for ${field}. Use seconds, or 1:30, or 1:02:03.`,
    );
  }
  return parsed;
}

/** MP4 unless asked otherwise, since it plays everywhere. */
function mp4(crf = 26): VideoOutput {
  return { container: 'mp4', crf, audioBitrate: '160k' };
}

async function run(
  file: File,
  ops: VideoOp[],
  output: VideoOutput,
  onProgress?: ProgressFn,
): Promise<ConversionResult> {
  const { runJob } = await lazy();
  return runJob({ input: file, ops, output }, onProgress);
}

/* ------------------------------- controls ------------------------------- */

const TRIM_PARAMS: ParamControl[] = [
  { kind: 'text', key: 'start', label: 'Start at', default: '0:00', placeholder: '0:00' },
  { kind: 'text', key: 'end', label: 'End at', default: '', placeholder: 'blank = to the end' },
];

const CROP_PARAMS: ParamControl[] = [
  {
    kind: 'select', key: 'ratio', label: 'Shape', default: '1',
    options: [
      { value: '1', label: 'Square (1:1)' },
      { value: '1.7778', label: 'Widescreen (16:9)' },
      { value: '0.5625', label: 'Tall (9:16)' },
      { value: '0.8', label: 'Portrait (4:5)' },
      { value: '1.3333', label: 'Classic (4:3)' },
      { value: '0.75', label: 'Upright (3:4)' },
    ],
  },
];

const RESIZE_PARAMS: ParamControl[] = [
  {
    kind: 'select', key: 'preset', label: 'Size', default: '1280x720',
    options: [
      { value: '1280x720', label: 'HD  1280 x 720' },
      { value: '1920x1080', label: 'Full HD  1920 x 1080' },
      { value: '1080x1920', label: 'Full HD upright  1080 x 1920' },
      { value: '1080x1080', label: 'Square  1080 x 1080' },
      { value: '1080x1350', label: 'Portrait  1080 x 1350' },
      { value: '854x480', label: 'Small  854 x 480' },
      { value: 'custom', label: 'Custom size…' },
    ],
  },
  { kind: 'number', key: 'width', label: 'Custom width', default: 1280, min: 16, max: 3840, step: 2, unit: 'px' },
  { kind: 'number', key: 'height', label: 'Custom height', default: 720, min: 16, max: 3840, step: 2, unit: 'px' },
  {
    kind: 'select', key: 'fit', label: 'How to fit', default: 'contain',
    options: [
      { value: 'contain', label: 'Fit inside (adds bars)' },
      { value: 'cover', label: 'Fill and crop the overflow' },
      { value: 'stretch', label: 'Stretch to fit (distorts)' },
    ],
  },
  {
    kind: 'select', key: 'upscale', label: 'Small videos', default: 'no',
    options: [
      { value: 'no', label: 'Leave them as they are' },
      { value: 'yes', label: 'Enlarge them anyway' },
    ],
  },
];

const SPLIT_PARAMS: ParamControl[] = [
  {
    kind: 'select', key: 'mode', label: 'Split', default: 'every',
    options: [
      { value: 'every', label: 'Into equal chunks' },
      { value: 'at', label: 'At times I choose' },
    ],
  },
  { kind: 'number', key: 'chunk', label: 'Each chunk', default: 30, min: 1, max: 3600, step: 1, unit: 'seconds' },
  { kind: 'text', key: 'times', label: 'Cut at', default: '', placeholder: '0:30, 1:15, 2:40' },
  {
    kind: 'select', key: 'precision', label: 'Cutting', default: 'accurate',
    options: [
      { value: 'accurate', label: 'Exactly on the mark (slower)' },
      { value: 'fast', label: 'Near the mark (much faster)' },
    ],
  },
];

const SUBTITLE_PARAMS: ParamControl[] = [
  { kind: 'file', key: 'subs', label: 'Subtitle file', default: null, accept: '.srt,.vtt,text/plain', hint: 'An .srt or .vtt file. Burned permanently into the picture.' },
  { kind: 'range', key: 'size', label: 'Text size', default: 6, min: 3, max: 14, step: 1, unit: '% of height' },
  {
    kind: 'select', key: 'position', label: 'Position', default: 'bottom',
    options: [{ value: 'bottom', label: 'Bottom' }, { value: 'center', label: 'Middle' }, { value: 'top', label: 'Top' }],
  },
  { kind: 'text', key: 'color', label: 'Text colour', default: '#ffffff', placeholder: '#ffffff' },
  {
    kind: 'select', key: 'backdrop', label: 'Behind the text', default: 'outline',
    options: [
      { value: 'outline', label: 'Dark outline' },
      { value: 'box', label: 'Solid band' },
      { value: 'none', label: 'Nothing' },
    ],
  },
];

const TEXT_PARAMS: ParamControl[] = [
  { kind: 'text', key: 'text', label: 'Text', default: '', placeholder: 'Anything, including हिंदी or emoji' },
  {
    kind: 'select', key: 'position', label: 'Position', default: 'bottom-center',
    options: [
      { value: 'top-left', label: 'Top left' }, { value: 'top-center', label: 'Top centre' }, { value: 'top-right', label: 'Top right' },
      { value: 'center', label: 'Middle' },
      { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-center', label: 'Bottom centre' }, { value: 'bottom-right', label: 'Bottom right' },
    ],
  },
  { kind: 'range', key: 'size', label: 'Size', default: 30, min: 8, max: 80, step: 2, unit: '% of width' },
  { kind: 'text', key: 'color', label: 'Colour', default: '#ffffff', placeholder: '#ffffff' },
  { kind: 'range', key: 'opacity', label: 'Opacity', default: 100, min: 20, max: 100, step: 5, unit: '%' },
  {
    kind: 'select', key: 'backdrop', label: 'Behind the text', default: 'outline',
    options: [
      { value: 'outline', label: 'Dark outline' },
      { value: 'box', label: 'Solid band' },
      { value: 'none', label: 'Nothing' },
    ],
  },
];

const COMPRESS_PARAMS: ParamControl[] = [
  {
    kind: 'select', key: 'level', label: 'How much', default: 'balanced',
    options: [
      { value: 'light', label: 'Light, keep the quality' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'strong', label: 'Strong, smallest file' },
    ],
  },
  {
    kind: 'select', key: 'shrink', label: 'Also reduce size', default: 'auto',
    options: [
      { value: 'auto', label: 'Match the level' },
      { value: 'keep', label: 'Keep the original size' },
    ],
  },
];

/* -------------------------------- tools -------------------------------- */

export const VIDEO_TOOLS: TargetOption[] = [
  // Convert
  { target: 'mp4', section: 'Convert', label: 'MP4', note: 'Plays almost everywhere', params: [
      { kind: 'select', key: 'quality', label: 'Quality', default: '26',
        options: [{ value: '22', label: 'High' }, { value: '26', label: 'Normal' }, { value: '30', label: 'Small file' }] },
    ],
    run: (f, p, pv) => run(f, [], mp4(Number(pv?.quality ?? 26)), p) },
  { target: 'webm', section: 'Convert', label: 'WebM', note: 'Open format, slower to encode',
    run: (f, p) => run(f, [], { container: 'webm', videoBitrate: '1M' }, p) },

  // Edit
  { target: 'mp4', section: 'Edit', label: 'Trim', note: 'Keep only part of the clip', params: TRIM_PARAMS,
    run: (f, p, pv) => {
      const start = timecodeOr(pv?.start, 0, 'the start') ?? 0;
      const end = timecodeOr(pv?.end, null, 'the end');
      return run(f, [{ kind: 'trim', start, end: end ?? undefined }], mp4(), p);
    } },
  { target: 'mp4', section: 'Edit', label: 'Crop', note: 'Cut to a shape without stretching', params: CROP_PARAMS,
    run: (f, p, pv) => run(f, [{ kind: 'cropAspect', ratio: Number(pv?.ratio ?? 1) }], mp4(), p) },
  { target: 'mp4', section: 'Edit', label: 'Resize', note: 'Common sizes, or your own', params: RESIZE_PARAMS,
    run: (f, p, pv) => {
      const preset = String(pv?.preset ?? '1280x720');
      let width: number;
      let height: number;
      if (preset === 'custom') {
        width = Number(pv?.width ?? 1280);
        height = Number(pv?.height ?? 720);
      } else {
        const [w, h] = preset.split('x').map(Number);
        width = w;
        height = h;
      }
      const fit = String(pv?.fit ?? 'contain') as 'contain' | 'cover' | 'stretch';
      return run(f, [{ kind: 'resize', width, height, fit, allowUpscale: String(pv?.upscale) === 'yes' }], mp4(), p);
    } },
  { target: 'mp4', section: 'Edit', label: 'Rotate', note: 'Turn the picture', params: [
      { kind: 'select', key: 'degrees', label: 'Turn', default: '90',
        options: [{ value: '90', label: '90° right' }, { value: '270', label: '90° left' }, { value: '180', label: 'Upside down' }] },
    ],
    run: (f, p, pv) => run(f, [{ kind: 'rotate', degrees: Number(pv?.degrees ?? 90) as 90 | 180 | 270 }], mp4(), p) },
  { target: 'mp4', section: 'Edit', label: 'Flip', note: 'Mirror the picture', params: [
      { kind: 'select', key: 'axis', label: 'Mirror', default: 'horizontal',
        options: [{ value: 'horizontal', label: 'Left to right' }, { value: 'vertical', label: 'Top to bottom' }] },
    ],
    run: (f, p, pv) => run(f, [{ kind: 'flip', axis: String(pv?.axis ?? 'horizontal') as 'horizontal' | 'vertical' }], mp4(), p) },
  { target: 'mp4', section: 'Edit', label: 'Speed', note: 'Faster or slower, with the audio kept in step', params: [
      { kind: 'select', key: 'factor', label: 'Speed', default: '2',
        options: [
          { value: '0.25', label: 'Quarter speed' }, { value: '0.5', label: 'Half speed' }, { value: '0.75', label: '0.75x' },
          { value: '1.25', label: '1.25x' }, { value: '1.5', label: '1.5x' }, { value: '2', label: 'Double speed' }, { value: '4', label: '4x' },
        ] },
    ],
    run: (f, p, pv) => run(f, [{ kind: 'speed', factor: Number(pv?.factor ?? 2), keepPitch: false }], mp4(), p) },
  { target: 'mp4', section: 'Edit', label: 'Reverse', note: 'Play backwards. Limited to a minute of video', params: [
      { kind: 'select', key: 'audio', label: 'The sound', default: 'reverse',
        options: [
          { value: 'reverse', label: 'Reverse it too' },
          { value: 'keep', label: 'Leave it playing forwards' },
          { value: 'drop', label: 'Remove it' },
        ] },
    ],
    run: (f, p, pv) => run(f, [{ kind: 'reverse', audio: String(pv?.audio ?? 'reverse') as 'reverse' | 'keep' | 'drop' }], mp4(), p) },
  { target: 'zip', section: 'Edit', batch: 'never', label: 'Split', note: 'Cut into numbered parts, delivered as a zip', params: SPLIT_PARAMS,
    run: async (f, p, pv) => {
      const { splitVideo } = await import('../video/split');
      const mode = String(pv?.precision ?? 'accurate') as 'fast' | 'accurate';
      if (String(pv?.mode ?? 'every') === 'at') {
        const raw = String(pv?.times ?? '');
        const times = raw.split(/[,\n]/).map((t) => parseTimecode(t.trim())).filter((t): t is number => t !== null);
        if (!times.length) {
          throw new VideoError('invalid-range', 'Add some times to cut at, like 0:30, 1:15.');
        }
        return splitVideo(f, { kind: 'at', times }, mode, p);
      }
      return splitVideo(f, { kind: 'every', seconds: Number(pv?.chunk ?? 30) }, mode, p);
    } },

  // Sound
  { target: 'mp4', section: 'Sound', label: 'Volume', note: 'Louder or quieter', params: [
      { kind: 'range', key: 'gain', label: 'Volume', default: 150, min: 10, max: 400, step: 10, unit: '%' },
    ],
    run: (f, p, pv) => run(f, [{ kind: 'volume', gain: Number(pv?.gain ?? 150) / 100 }], mp4(), p) },
  { target: 'mp4', section: 'Sound', label: 'Fade', note: 'Ease the sound in and out', params: [
      { kind: 'number', key: 'in', label: 'Fade in over', default: 1, min: 0, max: 30, step: 0.5, unit: 'seconds' },
      { kind: 'number', key: 'out', label: 'Fade out over', default: 1, min: 0, max: 30, step: 0.5, unit: 'seconds' },
    ],
    run: (f, p, pv) => run(f, [{ kind: 'audioFade', inSeconds: Number(pv?.in ?? 0), outSeconds: Number(pv?.out ?? 0) }], mp4(), p) },
  { target: 'mp4', section: 'Sound', label: 'Even out', note: 'Bring quiet and loud parts closer together',
    run: (f, p) => run(f, [{ kind: 'normalizeAudio' }], mp4(), p) },
  { target: 'mp4', section: 'Sound', label: 'Mute', note: 'Remove the sound entirely',
    run: (f, p) => run(f, [{ kind: 'removeAudio' }], mp4(), p) },
  { target: 'mp4', section: 'Sound', label: 'Replace sound', note: 'Swap in your own audio, or add some to a silent clip', params: [
      { kind: 'file', key: 'audio', label: 'Audio file', default: null, accept: 'audio/*', hint: 'MP3, WAV, M4A and similar.' },
    ],
    run: (f, p, pv) => {
      const audio = asFile(pv?.audio);
      if (!audio) throw new VideoError('failed', 'Choose an audio file to use.');
      return run(f, [{ kind: 'setAudio', file: audio, mode: 'replace' }], mp4(), p);
    } },

  // Finish
  { target: 'mp4', section: 'Finish', label: 'Compress', note: 'Make the file smaller', params: COMPRESS_PARAMS,
    run: (f, p, pv) => {
      const level = String(pv?.level ?? 'balanced');
      const crf = level === 'light' ? 24 : level === 'strong' ? 32 : 28;
      const width = String(pv?.shrink) === 'keep' ? undefined : level === 'strong' ? 640 : level === 'balanced' ? 960 : 1280;
      const ops: VideoOp[] = width ? [{ kind: 'resize', width, fit: 'contain', allowUpscale: false }] : [];
      return run(f, ops, mp4(crf), p);
    } },
  { target: 'mp4', section: 'Finish', batch: 'never', label: 'Subtitles', note: 'Burn an .srt or .vtt permanently into the picture', params: SUBTITLE_PARAMS,
    run: (f, p, pv) => {
      const subs = asFile(pv?.subs);
      if (!subs) throw new VideoError('bad-subtitle', 'Choose a .srt or .vtt subtitle file first.');
      const backdrop = String(pv?.backdrop ?? 'outline');
      return run(f, [{
        kind: 'subtitles', file: subs,
        style: {
          fontSizePercent: Number(pv?.size ?? 6),
          color: String(pv?.color ?? '#ffffff'),
          outline: backdrop === 'outline',
          background: backdrop === 'box',
          position: String(pv?.position ?? 'bottom') as 'top' | 'center' | 'bottom',
          marginPercent: 5,
        },
      }], mp4(), p);
    } },
  { target: 'mp4', section: 'Finish', batch: 'never', label: 'Add text', note: 'Put words on the picture', params: TEXT_PARAMS,
    run: (f, p, pv) => {
      const text = String(pv?.text ?? '').trim();
      if (!text) throw new VideoError('failed', 'Type the words you want on the video.');
      const backdrop = String(pv?.backdrop ?? 'outline');
      return run(f, [{
        kind: 'textOverlay', text,
        position: String(pv?.position ?? 'bottom-center') as never,
        sizePercent: Number(pv?.size ?? 30),
        color: String(pv?.color ?? '#ffffff'),
        opacity: Number(pv?.opacity ?? 100),
        outline: backdrop === 'outline',
        background: backdrop === 'box',
        margin: 16,
      }], mp4(), p);
    } },

  {
    target: 'mp4', section: 'Edit', batch: 'never', label: 'Several edits at once',
    note: 'Stack up trims, crops, text and more. They all run in one pass',
    params: [
      { kind: 'pipeline', key: 'chain', label: 'Steps', default: { steps: [] } },
      { kind: 'select', key: 'quality', label: 'Final quality', default: '26',
        options: [{ value: '22', label: 'High' }, { value: '26', label: 'Normal' }, { value: '30', label: 'Small file' }] },
    ],
    run: (f, p, pv) => {
      const chain = asPipeline(pv?.chain);
      if (!chain.steps.length) throw new VideoError('failed', 'Add at least one step first.');
      return run(f, stepsToOps(chain), mp4(Number(pv?.quality ?? 26)), p);
    },
  },

  // Utilities
  { target: 'png', section: 'Utilities', batch: 'never', label: 'Grab a frame', note: 'Save one moment as a picture', params: [
      { kind: 'text', key: 'at', label: 'Moment', default: '0:01', placeholder: '0:05' },
      { kind: 'select', key: 'format', label: 'Save as', default: 'png',
        options: [{ value: 'png', label: 'PNG (sharp)' }, { value: 'jpg', label: 'JPG (smaller)' }] },
    ],
    run: async (f, p, pv) => {
      const { extractFrame } = await import('../video/frames');
      const at = timecodeOr(pv?.at, 1, 'the moment') ?? 1;
      return extractFrame(f, at, String(pv?.format ?? 'png') as 'png' | 'jpg', p);
    } },
  { target: 'jpg', section: 'Utilities', batch: 'never', label: 'Thumbnail', note: 'Pick a representative frame automatically',
    run: async (f, p) => {
      const { generateThumbnail } = await import('../video/frames');
      return generateThumbnail(f, p);
    } },
  { target: 'txt', section: 'Utilities', batch: 'never', label: 'Video details', note: 'Size, length, frame rate and codecs',
    run: async (f) => {
      const { getVideoInfo } = await lazy();
      const i = await getVideoInfo(f);
      const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
      const g = i.width && i.height ? gcd(i.width, i.height) : 1;
      const rows = [
        { label: 'File', value: i.filename },
        { label: 'Size', value: `${(i.sizeBytes / 1048576).toFixed(1)} MB` },
        { label: 'Length', value: formatTimecode(i.durationSeconds) },
        { label: 'Dimensions', value: `${i.width} x ${i.height}` },
        { label: 'Shape', value: g ? `${Math.round(i.width / g)}:${Math.round(i.height / g)}` : 'unknown' },
        { label: 'Frame rate', value: i.fps ? `${i.fps} per second` : 'unknown' },
        { label: 'Video format', value: i.videoCodec ?? 'unknown' },
        { label: 'Sound', value: i.hasAudio ? `yes (${i.audioCodec})` : 'none' },
        { label: 'Bitrate', value: i.bitrateKbps ? `${i.bitrateKbps} kb/s` : 'unknown' },
        { label: 'Container', value: i.format ?? 'unknown' },
      ];
      const text = rows.map((r) => `${r.label}: ${r.value}`).join('\n');
      return {
        blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
        filename: addSuffix(replaceExt(f.name, 'txt'), '-details'),
        note: 'Read below. Nothing was converted.',
        view: { kind: 'fields', groups: [{ title: 'Video details', rows }] },
      };
    } },
];
