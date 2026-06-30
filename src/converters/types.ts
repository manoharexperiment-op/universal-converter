/** Progress callback: receives a fraction from 0..1. */
export type ProgressFn = (fraction: number) => void;

/** The output of a conversion: an in-memory blob plus a suggested filename. */
export interface ConversionResult {
  blob: Blob;
  filename: string;
  /** Optional message to show instead of the generic success text. */
  note?: string;
}

/** Values collected from an action's parameter controls, keyed by control key. */
export type ParamValues = Record<string, string | number>;

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
  | { kind: 'text'; key: string; label: string; default: string; placeholder?: string; password?: boolean };

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
  /** The actual conversion routine. */
  run: ConvertFn;
}

/** Build the default ParamValues for a control list (seeds UI state + run fallbacks). */
export function defaultsOf(params?: ParamControl[]): ParamValues {
  return Object.fromEntries((params ?? []).map((c) => [c.key, c.default]));
}
