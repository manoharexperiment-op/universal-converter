/** Progress callback: receives a fraction from 0..1. */
export type ProgressFn = (fraction: number) => void;

/** The output of a conversion: an in-memory blob plus a suggested filename. */
export interface ConversionResult {
  blob: Blob;
  filename: string;
}

/** A conversion function. Always async; may report progress. */
export type ConvertFn = (file: File, onProgress?: ProgressFn) => Promise<ConversionResult>;

/** A single "convert to X" option offered for a given source file type. */
export interface TargetOption {
  /** Target extension, e.g. "png". */
  target: string;
  /** Human label for the button, e.g. "PNG" or "Word". */
  label: string;
  /** Optional caveat shown under the option (e.g. fidelity notes). */
  note?: string;
  /** The actual conversion routine. */
  run: ConvertFn;
}
