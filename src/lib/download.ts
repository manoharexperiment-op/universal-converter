import { Capacitor } from '@capacitor/core';

/** True when running inside the native Android/iOS app (Capacitor WebView). */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Save a converted Blob.
 *
 * - **Web:** trigger a normal browser download (blob URL + a hidden <a download>).
 *   The blob lives only in memory and is released right after the click.
 * - **Native (Capacitor):** an <a download> click does NOTHING in an Android
 *   WebView — no download manager fires and the file is silently dropped. So we
 *   write the file to the app's cache directory and open the native Share/Save
 *   sheet, letting the user save it to Files / Downloads / Drive / etc. This
 *   needs no storage permission and works on every Android version.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (isNativePlatform()) {
    await saveNative(blob, filename);
    return;
  }
  saveWeb(blob, filename);
}

function saveWeb(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Write in 3 MiB slices. Capacitor's writeFile/appendFile are base64-only on
// native, so the whole file would otherwise become ONE ~1.33x-size base64
// string in the WebView heap (and a JS string is UTF-16, so ~2.66x the bytes) —
// a 150 MB video would balloon past 500 MB and OOM-crash the app even with
// largeHeap. Chunking caps the peak base64 string at ~4 MB no matter the size.
//
// The chunk size MUST be a multiple of 3 bytes: base64 encodes 3 bytes -> 4
// chars with NO padding, so concatenating per-chunk base64 is byte-exact. A
// non-multiple-of-3 chunk would emit '=' padding mid-stream and corrupt the file.
const CHUNK_BYTES = 3 * 1024 * 1024; // 3,145,728 — divisible by 3

async function saveNative(blob: Blob, filename: string): Promise<void> {
  // Lazy-import the native plugins so the web build never pulls them in.
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  // A filename is a path segment here — strip path separators and characters
  // that are illegal on the filesystem, or writeFile would fail/misbehave.
  const path = sanitizeFilename(filename);
  const directory = Directory.Cache;

  if (blob.size === 0) {
    await Filesystem.writeFile({ path, data: '', directory });
  } else {
    for (let offset = 0, first = true; offset < blob.size; offset += CHUNK_BYTES) {
      const data = await blobToBase64(blob.slice(offset, offset + CHUNK_BYTES));
      if (first) {
        // Create/truncate with the first chunk, then append the rest.
        await Filesystem.writeFile({ path, data, directory });
        first = false;
      } else {
        await Filesystem.appendFile({ path, data, directory });
      }
    }
  }

  const { uri } = await Filesystem.getUri({ path, directory });

  // Open Android's native share/save sheet so the user picks the destination.
  await Share.share({ title: path, text: path, url: uri });
}

// Characters illegal in a filesystem path segment: \ / : * ? " < > | and
// control chars. Spaces and hyphens are valid and kept.
const ILLEGAL_FILENAME_CHARS = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', 'g');

/** Replace path separators and filesystem-illegal characters (keeps spaces/hyphens). */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(ILLEGAL_FILENAME_CHARS, '_').trim();
  return cleaned.length ? cleaned : 'converted-file';
}

/**
 * Convert a Blob (or Blob slice) to a bare base64 string (no `data:...;base64,`
 * prefix), the format Capacitor Filesystem expects for binary data.
 * readAsDataURL avoids the call-stack limit of btoa(String.fromCharCode(...));
 * callers pass small slices so the peak string size stays bounded.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}
