/** Progress callback: receives a fraction from 0..1. */
export type ProgressFn = (fraction: number) => void;

/** A labelled row in a `fields` result view. */
export interface ViewRow {
  label: string;
  value: string;
  /** Draws attention to privacy-sensitive findings such as GPS coordinates. */
  level?: 'alert' | 'warn';
}

/** A group of rows in a `fields` result view. */
export interface ViewGroup {
  title: string;
  rows: ViewRow[];
}

/** Some results are meant to be read on screen, not just downloaded. */
export type ResultView =
  | { kind: 'text'; text: string }
  | { kind: 'fields'; groups: ViewGroup[] };

/** The output of a conversion: an in-memory blob plus a suggested filename. */
export interface ConversionResult {
  blob: Blob;
  filename: string;
  /** Optional message to show instead of the generic success text. */
  note?: string;
  /** Render this on screen alongside the download. */
  view?: ResultView;
}

/**
 * Where a stamp sits on a page, as FRACTIONS of the visible page (0..1, from the
 * top-left). Fractions rather than pixels or points on purpose: preview scale,
 * devicePixelRatio and canvas resolution then all cancel out, so what the user
 * drags is exactly what gets drawn at full resolution.
 *
 * Height is deliberately absent. It is always derived from the stamp image's own
 * aspect ratio, because storing width and height as fractions of a non-square
 * page uses a different denominator per axis and silently distorts the stamp.
 */
export interface Placement {
  /** Left edge, as a fraction of page width. */
  x: number;
  /** Top edge, as a fraction of page height. */
  y: number;
  /** Width, as a fraction of page width. */
  w: number;
  /** 1-based page number (PDFs only). */
  page: number;
}

/**
 * One page of the output. `src` is '' for the document being edited, or the id
 * of a file the user inserted. `index` is the 0-based page in that source, so a
 * page can appear twice (duplicated) or in any order.
 */
export interface PlanPage {
  src: string;
  index: number;
  /** Extra clockwise rotation in degrees, on top of whatever the page carries. */
  rotate: number;
}

/** The whole edit as an ordered list. Deleting a page just drops it from here. */
export interface PagePlan {
  pages: PlanPage[];
}

export function isPagePlan(v: unknown): v is PagePlan {
  return !!v && typeof v === 'object' && Array.isArray((v as PagePlan).pages);
}

/** Narrow a param value to a PagePlan, falling back to an empty one. */
export function asPagePlan(v: ParamValue | undefined): PagePlan {
  return isPagePlan(v) ? v : { pages: [] };
}

export type ParamValue = string | number | Placement | PagePlan;

/** Values collected from an action's parameter controls, keyed by control key. */
export type ParamValues = Record<string, ParamValue>;

/** Narrow a param value to a Placement, falling back to a sensible default. */
export function asPlacement(v: ParamValue | undefined): Placement {
  if (v && typeof v === 'object' && 'x' in v) return v;
  return { x: 0.62, y: 0.78, w: 0.25, page: 1 };
}

/** A declarative parameter control rendered under a selected action. */
export type ParamControl =
  | {
      kind: 'select';
      key: string;
      label: string;
      default: string | number;
      options: { value: string | number; label: string }[];
      unit?: string;
    }
  | { kind: 'number'; key: string; label: string; default: number; min?: number; max?: number; step?: number; unit?: string }
  | { kind: 'range'; key: string; label: string; default: number; min: number; max: number; step?: number; unit?: string }
  | { kind: 'text'; key: string; label: string; default: string; placeholder?: string; password?: boolean }
  | { kind: 'signature'; key: string; label: string; default: string }
  | { kind: 'image'; key: string; label: string; default: string; hint?: string }
  | { kind: 'pages'; key: string; label: string; default: PagePlan }
  | {
      kind: 'placement';
      key: string;
      label: string;
      default: Placement;
      /** Param key holding the data-URL image being positioned. */
      imageKey: string;
    };

/** A conversion function. Always async; may report progress; may take params. */
export type ConvertFn = (file: File, onProgress?: ProgressFn, params?: ParamValues) => Promise<ConversionResult>;

/** A single "convert to X" option offered for a given source file type. */
export interface TargetOption {
  /** Target extension, e.g. "png" (used for the button icon). */
  target: string;
  /** Human label for the button, e.g. "PNG", "Compress". */
  label: string;
  /** Optional caveat shown under the option (fidelity / trade-off notes). */
  note?: string;
  /** Optional parameter controls shown when this option is selected. */
  params?: ParamControl[];
  /**
   * Whether this tool is offered when several files are dropped. 'never' is for
   * tools that already fan one file out into a zip, where batching would nest
   * zips inside a zip.
   */
  batch?: 'each' | 'never';
  /**
   * Build the controls by looking inside the file, for tools whose inputs are
   * discovered at runtime rather than known up front (PDF form fields).
   */
  inspect?: InspectFn;
  /** The actual conversion routine. */
  run: ConvertFn;
}

/** Controls discovered by reading the file, plus a message when there are none. */
export interface InspectResult {
  params: ParamControl[];
  message?: string;
}

export type InspectFn = (file: File) => Promise<InspectResult>;

/** Combine several files into one output (merge, not per-file conversion). */
export type MergeFn = (files: File[], onProgress?: ProgressFn, params?: ParamValues) => Promise<ConversionResult>;

/** A "combine these files" action offered when several files are dropped. */
export interface MergeOption {
  target: string;
  label: string;
  note?: string;
  /** ffmpeg-backed, so it can be cancelled mid-run. */
  media?: boolean;
  run: MergeFn;
}

/** Build the default ParamValues for a control list (seeds UI state + run fallbacks). */
export function defaultsOf(params?: ParamControl[]): ParamValues {
  return Object.fromEntries((params ?? []).map((c) => [c.key, c.default]));
}
