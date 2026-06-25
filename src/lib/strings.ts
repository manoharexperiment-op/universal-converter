/** Strip the extension from a filename: "report.final.pdf" -> "report.final". */
export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Replace (or add) the extension: ("photo.jpg", "png") -> "photo.png". */
export function replaceExt(name: string, ext: string): string {
  return `${stripExt(name)}.${ext}`;
}

/** Add a suffix before the extension: ("a.pdf", "-compressed") -> "a-compressed.pdf". */
export function addSuffix(name: string, suffix: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? `${name.slice(0, i)}${suffix}${name.slice(i)}` : `${name}${suffix}`;
}

/** Human-readable byte size: 1536 -> "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
}

/** Percentage reduction from `before` to `after`, rounded: (1000, 700) -> 30. */
export function pctSmaller(before: number, after: number): number {
  return Math.round((1 - after / before) * 100);
}

/** Wrap an HTML body fragment in a minimal, self-contained HTML document. */
export function wrapHtml(body: string, title = 'Converted Document'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #222; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; }
  img { max-width: 100%; height: auto; }
  pre { background: #f4f4f4; padding: 1rem; overflow: auto; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
