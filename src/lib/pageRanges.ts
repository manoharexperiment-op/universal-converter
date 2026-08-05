/**
 * Parse a page-range string the way people actually write one: "2, 5-7, 11".
 * Clicking sixty thumbnails to drop a run of pages is slower than typing it, so
 * the organiser accepts both.
 *
 * Returns 0-based indices, sorted and de-duplicated. Page numbers the document
 * does not have are ignored rather than treated as an error, so a stray "99" on
 * a 10-page file trims the rest of the input instead of rejecting it.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const found = new Set<number>();
  for (const partRaw of input.split(/[,\s]+/)) {
    const part = partRaw.trim();
    if (!part) continue;

    // "5-" means 5 to the end, "-5" means the start to 5.
    const m = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(part);
    if (m) {
      const [, a, b] = m;
      if (!a && !b) continue;
      let start = a ? parseInt(a, 10) : 1;
      let end = b ? parseInt(b, 10) : pageCount;
      if (start > end) [start, end] = [end, start];
      for (let p = Math.max(1, start); p <= Math.min(pageCount, end); p++) found.add(p - 1);
      continue;
    }

    const single = /^\d+$/.test(part) ? parseInt(part, 10) : NaN;
    if (Number.isFinite(single) && single >= 1 && single <= pageCount) found.add(single - 1);
  }
  return [...found].sort((x, y) => x - y);
}

/** Human summary of a selection, e.g. "1-3, 7". Used in the on-screen notes. */
export function describePages(indices: number[]): string {
  if (!indices.length) return 'none';
  const sorted = [...indices].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== prev + 1) {
      runs.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
      start = cur;
    }
    prev = cur;
  }
  return runs.join(', ');
}
