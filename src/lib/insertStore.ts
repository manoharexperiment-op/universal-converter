/**
 * Files the user has inserted into a page plan, held by id.
 *
 * The plan itself only carries ids. Keeping the actual File objects out of React
 * state matters: a data URL of a 5 MB PDF is ~6.7 MB of string that would be
 * copied on every keystroke elsewhere in the form.
 */
const files = new Map<string, File>();
let counter = 0;

export function putInsert(file: File): string {
  const id = `ins${++counter}`;
  files.set(id, file);
  return id;
}

export function getInsert(id: string): File | undefined {
  return files.get(id);
}

/** Drop anything no longer referenced by the plan. */
export function pruneInserts(keep: Iterable<string>): void {
  const live = new Set(keep);
  for (const id of [...files.keys()]) if (!live.has(id)) files.delete(id);
}

export function clearInserts(): void {
  files.clear();
}
