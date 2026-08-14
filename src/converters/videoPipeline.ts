import type { ParamControl, ParamValue, ParamValues } from './types';
import { asFile } from './types';
import type { Corner, VideoOp } from '../video/types';
import { VideoError } from '../video/types';
import { parseTimecode } from '../video/probe';

/**
 * Steps a person can stack up in one go.
 *
 * The engine already accepts a list of operations and compiles them into a
 * single filter graph, so a chain of five edits still costs one decode and one
 * encode. This is the vocabulary the UI offers for building that list, kept
 * separate from `VideoOp` so the screen can collect loose strings and numbers
 * and only turn them into typed operations when the job actually runs.
 */

export interface PipeStep {
  id: string;
  kind: string;
  values: ParamValues;
}

export interface Pipeline {
  steps: PipeStep[];
}

export function isPipeline(v: unknown): v is Pipeline {
  return !!v && typeof v === 'object' && Array.isArray((v as Pipeline).steps);
}

export function asPipeline(v: ParamValue | undefined): Pipeline {
  return isPipeline(v) ? v : { steps: [] };
}

export interface StepType {
  kind: string;
  label: string;
  /** Shown in the step list so a chain reads at a glance. */
  summary: (v: ParamValues) => string;
  controls: ParamControl[];
  toOp: (v: ParamValues) => VideoOp | null;
}

function time(v: ParamValue | undefined, fallback: number | null, field: string): number | null {
  const raw = String(v ?? '').trim();
  if (!raw) return fallback;
  const parsed = parseTimecode(raw);
  if (parsed === null) {
    throw new VideoError('invalid-range', `"${raw}" is not a time I can read for ${field}. Try 0:30 or 1:02:03.`);
  }
  return parsed;
}

const BACKDROP: ParamControl = {
  kind: 'select', key: 'backdrop', label: 'Behind the text', default: 'outline',
  options: [
    { value: 'outline', label: 'Dark outline' },
    { value: 'box', label: 'Solid band' },
    { value: 'none', label: 'Nothing' },
  ],
};

const POSITION: ParamControl = {
  kind: 'select', key: 'position', label: 'Position', default: 'bottom-center',
  options: [
    { value: 'top-left', label: 'Top left' }, { value: 'top-center', label: 'Top centre' }, { value: 'top-right', label: 'Top right' },
    { value: 'center', label: 'Middle' },
    { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-center', label: 'Bottom centre' }, { value: 'bottom-right', label: 'Bottom right' },
  ],
};

/**
 * Order matters and is the user's to choose, but the list is arranged so the
 * common chain (cut it down, reshape it, then decorate it) reads top to bottom.
 */
export const STEP_TYPES: StepType[] = [
  {
    kind: 'trim',
    label: 'Trim',
    summary: (v) => `Keep ${String(v.start || '0:00')} to ${String(v.end || 'the end')}`,
    controls: [
      { kind: 'text', key: 'start', label: 'Start at', default: '0:00', placeholder: '0:00' },
      { kind: 'text', key: 'end', label: 'End at', default: '', placeholder: 'blank = to the end' },
    ],
    toOp: (v) => ({ kind: 'trim', start: time(v.start, 0, 'the start') ?? 0, end: time(v.end, null, 'the end') ?? undefined }),
  },
  {
    kind: 'crop',
    label: 'Crop to a shape',
    summary: (v) => {
      const names: Record<string, string> = {
        '1': 'a square', '1.7778': '16:9', '0.5625': '9:16', '0.8': '4:5', '1.3333': '4:3',
      };
      return `Crop to ${names[String(v.ratio ?? '1')] ?? 'a shape'}`;
    },
    controls: [
      {
        kind: 'select', key: 'ratio', label: 'Shape', default: '1',
        options: [
          { value: '1', label: 'Square (1:1)' },
          { value: '1.7778', label: 'Widescreen (16:9)' },
          { value: '0.5625', label: 'Tall (9:16)' },
          { value: '0.8', label: 'Portrait (4:5)' },
          { value: '1.3333', label: 'Classic (4:3)' },
        ],
      },
    ],
    toOp: (v) => ({ kind: 'cropAspect', ratio: Number(v.ratio ?? 1) }),
  },
  {
    kind: 'resize',
    label: 'Resize',
    summary: (v) => `Resize to ${String(v.size ?? '1280x720')}`,
    controls: [
      {
        kind: 'select', key: 'size', label: 'Size', default: '1280x720',
        options: [
          { value: '1280x720', label: 'HD  1280 x 720' },
          { value: '1920x1080', label: 'Full HD  1920 x 1080' },
          { value: '1080x1920', label: 'Upright  1080 x 1920' },
          { value: '1080x1080', label: 'Square  1080 x 1080' },
          { value: '854x480', label: 'Small  854 x 480' },
        ],
      },
      {
        kind: 'select', key: 'fit', label: 'How to fit', default: 'contain',
        options: [
          { value: 'contain', label: 'Fit inside (adds bars)' },
          { value: 'cover', label: 'Fill and crop' },
          { value: 'stretch', label: 'Stretch (distorts)' },
        ],
      },
    ],
    toOp: (v) => {
      const [w, h] = String(v.size ?? '1280x720').split('x').map(Number);
      return { kind: 'resize', width: w, height: h, fit: String(v.fit ?? 'contain') as 'contain' | 'cover' | 'stretch', allowUpscale: false };
    },
  },
  {
    kind: 'rotate',
    label: 'Rotate',
    summary: (v) => `Rotate ${String(v.degrees ?? 90)}°`,
    controls: [
      {
        kind: 'select', key: 'degrees', label: 'Turn', default: '90',
        options: [{ value: '90', label: '90° right' }, { value: '270', label: '90° left' }, { value: '180', label: 'Upside down' }],
      },
    ],
    toOp: (v) => ({ kind: 'rotate', degrees: Number(v.degrees ?? 90) as 90 | 180 | 270 }),
  },
  {
    kind: 'flip',
    label: 'Flip',
    summary: (v) => (String(v.axis) === 'vertical' ? 'Flip top to bottom' : 'Flip left to right'),
    controls: [
      {
        kind: 'select', key: 'axis', label: 'Mirror', default: 'horizontal',
        options: [{ value: 'horizontal', label: 'Left to right' }, { value: 'vertical', label: 'Top to bottom' }],
      },
    ],
    toOp: (v) => ({ kind: 'flip', axis: String(v.axis ?? 'horizontal') as 'horizontal' | 'vertical' }),
  },
  {
    kind: 'speed',
    label: 'Change speed',
    summary: (v) => `${String(v.factor ?? 2)}x speed`,
    controls: [
      {
        kind: 'select', key: 'factor', label: 'Speed', default: '2',
        options: [
          { value: '0.25', label: 'Quarter speed' }, { value: '0.5', label: 'Half speed' },
          { value: '1.5', label: '1.5x' }, { value: '2', label: 'Double' }, { value: '4', label: '4x' },
        ],
      },
    ],
    toOp: (v) => ({ kind: 'speed', factor: Number(v.factor ?? 2), keepPitch: false }),
  },
  {
    kind: 'volume',
    label: 'Change volume',
    summary: (v) => `Volume ${String(v.gain ?? 150)}%`,
    controls: [{ kind: 'range', key: 'gain', label: 'Volume', default: 150, min: 10, max: 400, step: 10, unit: '%' }],
    toOp: (v) => ({ kind: 'volume', gain: Number(v.gain ?? 150) / 100 }),
  },
  {
    kind: 'mute',
    label: 'Remove the sound',
    summary: () => 'Remove the sound',
    controls: [],
    toOp: () => ({ kind: 'removeAudio' }),
  },
  {
    kind: 'watermark',
    label: 'Add a logo',
    summary: (v) => (asFile(v.image) ? `Logo, ${String(v.position ?? 'bottom-right')}` : 'Logo (none chosen yet)'),
    controls: [
      { kind: 'file', key: 'image', label: 'Logo image', default: null, accept: 'image/*', hint: 'A PNG with transparency works best.' },
      { ...POSITION, default: 'bottom-right' },
      { kind: 'range', key: 'size', label: 'Size', default: 18, min: 4, max: 60, step: 2, unit: '% of width' },
      { kind: 'range', key: 'opacity', label: 'Opacity', default: 70, min: 10, max: 100, step: 5, unit: '%' },
    ],
    toOp: (v) => {
      const image = asFile(v.image);
      if (!image) throw new VideoError('failed', 'Choose a logo image for the logo step, or remove that step.');
      return {
        kind: 'watermark', image,
        position: String(v.position ?? 'bottom-right') as Corner,
        scalePercent: Number(v.size ?? 18),
        opacity: Number(v.opacity ?? 70),
        margin: 16,
      };
    },
  },
  {
    kind: 'text',
    label: 'Add text',
    summary: (v) => (String(v.text || '').trim() ? `Text: "${String(v.text).slice(0, 24)}"` : 'Text (nothing typed yet)'),
    controls: [
      { kind: 'text', key: 'text', label: 'Text', default: '', placeholder: 'Anything, including हिंदी or emoji' },
      POSITION,
      { kind: 'range', key: 'size', label: 'Size', default: 30, min: 8, max: 80, step: 2, unit: '% of width' },
      { kind: 'text', key: 'color', label: 'Colour', default: '#ffffff', placeholder: '#ffffff' },
      BACKDROP,
    ],
    toOp: (v) => {
      const text = String(v.text ?? '').trim();
      if (!text) throw new VideoError('failed', 'Type the words for the text step, or remove that step.');
      const backdrop = String(v.backdrop ?? 'outline');
      return {
        kind: 'textOverlay', text,
        position: String(v.position ?? 'bottom-center') as Corner,
        sizePercent: Number(v.size ?? 30),
        color: String(v.color ?? '#ffffff'),
        opacity: 100,
        outline: backdrop === 'outline',
        background: backdrop === 'box',
        margin: 16,
      };
    },
  },
  {
    kind: 'subtitles',
    label: 'Burn in subtitles',
    summary: (v) => (asFile(v.subs) ? `Subtitles, ${String(v.position ?? 'bottom')}` : 'Subtitles (no file chosen yet)'),
    controls: [
      { kind: 'file', key: 'subs', label: 'Subtitle file', default: null, accept: '.srt,.vtt,text/plain', hint: 'An .srt or .vtt file.' },
      { kind: 'range', key: 'size', label: 'Text size', default: 6, min: 3, max: 14, step: 1, unit: '% of height' },
      {
        kind: 'select', key: 'position', label: 'Position', default: 'bottom',
        options: [{ value: 'bottom', label: 'Bottom' }, { value: 'center', label: 'Middle' }, { value: 'top', label: 'Top' }],
      },
      BACKDROP,
    ],
    toOp: (v) => {
      const subs = asFile(v.subs);
      if (!subs) throw new VideoError('bad-subtitle', 'Choose a subtitle file for the subtitles step, or remove that step.');
      const backdrop = String(v.backdrop ?? 'outline');
      return {
        kind: 'subtitles', file: subs,
        style: {
          fontSizePercent: Number(v.size ?? 6),
          color: '#ffffff',
          outline: backdrop === 'outline',
          background: backdrop === 'box',
          position: String(v.position ?? 'bottom') as 'top' | 'center' | 'bottom',
          marginPercent: 5,
        },
      };
    },
  },
];

export function stepType(kind: string): StepType | undefined {
  return STEP_TYPES.find((s) => s.kind === kind);
}

/** Seed a new step with its own defaults. */
export function newStep(kind: string): PipeStep {
  const t = stepType(kind);
  const values: ParamValues = {};
  for (const c of t?.controls ?? []) values[c.key] = c.default;
  return { id: `s${Math.random().toString(36).slice(2, 9)}`, kind, values };
}

/**
 * Turn the chain into operations.
 *
 * Compression is expressed through the output settings rather than as a step,
 * so it cannot be ordered wrongly: re-encoding is always the last thing that
 * happens whatever the user drags around.
 */
export function stepsToOps(pipeline: Pipeline): VideoOp[] {
  const ops: VideoOp[] = [];
  for (const step of pipeline.steps) {
    const t = stepType(step.kind);
    if (!t) continue;
    const op = t.toOp(step.values);
    if (op) ops.push(op);
  }
  return ops;
}
