import type { ConversionResult, ParamValues, ProgressFn, TargetOption } from './types';
import { stripExt } from '../lib/strings';

/**
 * Ceiling on the total size of the produced zip. Everything is held in memory,
 * so without this a phone runs out of heap and the tab dies with no explanation.
 * Hitting it stops the batch and returns the work already finished.
 */
const MAX_OUTPUT_BYTES = 400 * 1024 * 1024;

/** Most files anyone should push through one batch. */
export const MAX_BATCH_FILES = 50;

/** Make `name` unique within `used` by adding "(2)", "(3)", ... before the extension. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Run one conversion over many files and bundle the results into a zip.
 *
 * Files are processed one at a time on purpose: decoding twenty photos at once
 * is what actually exhausts memory on a phone. A file that fails does not
 * abandon the rest; the failures are listed inside the zip so the user can see
 * exactly what was skipped and why.
 */
export async function runBatch(
  files: File[],
  opt: TargetOption,
  onProgress?: ProgressFn,
  params?: ParamValues,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const used = new Set<string>();
  const failures: string[] = [];
  let done = 0;
  let bytes = 0;
  let stoppedEarly = '';

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) {
      stoppedEarly = 'Stopped early.';
      break;
    }
    try {
      const r = await opt.run(files[i], (f) => onProgress?.((i + Math.min(1, f)) / files.length), params);
      zip.file(uniqueName(r.filename, used), r.blob);
      bytes += r.blob.size;
      done++;
      if (bytes > MAX_OUTPUT_BYTES) {
        stoppedEarly = 'Stopped after 400 MB to stay within memory.';
        break;
      }
    } catch (e) {
      failures.push(`${files[i].name}, ${e instanceof Error ? e.message : 'failed'}`);
    }
    onProgress?.((i + 1) / files.length);
  }

  if (!done) {
    throw new Error(
      failures.length
        ? `None of the ${files.length} files could be converted. First problem: ${failures[0]}`
        : 'Nothing was converted.',
    );
  }

  if (failures.length) {
    zip.file(
      '_SKIPPED-FILES.txt',
      [`${failures.length} of ${files.length} file(s) could not be converted:`, '', ...failures].join('\n'),
    );
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const parts = [`Converted ${done} of ${files.length} files.`];
  if (failures.length) parts.push(`${failures.length} skipped (see _SKIPPED-FILES.txt inside the zip).`);
  if (stoppedEarly) parts.push(stoppedEarly);

  return {
    blob,
    filename: `${stripExt(files[0].name)}-and-${Math.max(1, done - 1)}-more_${opt.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.zip`,
    note: parts.join(' '),
  };
}
