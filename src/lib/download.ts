import { Capacitor } from '@capacitor/core';

/** True when running inside the native Android/iOS app (Capacitor WebView). */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/** True only on the native Android app, where "Save to device" is available. */
export function isAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/**
 * WEB: trigger a normal browser download (blob URL + a hidden <a download>).
 * The blob lives only in memory and is released right after the click.
 * (On native an <a download> click does nothing — use saveToDevice/shareFile.)
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type SaveOutcome = 'downloads' | 'shared';

/**
 * NATIVE "Save to device". Writes the file into the public Downloads collection
 * via MediaStore (visible in Files, no permission on Android 10+). If that's
 * unavailable (Android 9-, or any failure), falls back to the share sheet.
 * Returns where it ended up so the UI can message accurately.
 */
export async function saveToDevice(blob: Blob, filename: string): Promise<SaveOutcome> {
  const name = sanitizeFilename(filename);
  const { uri } = await writeToCache(blob, name);

  if (Capacitor.getPlatform() === 'android') {
    try {
      const { DownloadsSaver } = await import('./downloads-saver');
      await DownloadsSaver.saveToDownloads({
        sourceUri: uri,
        fileName: name,
        mimeType: mimeFor(name),
        subDirectory: 'MunnX Convertor',
      });
      return 'downloads';
    } catch {
      // Android 9-, or the save failed for some reason — fall back to sharing.
    }
  }

  await shareUri(uri, name);
  return 'shared';
}

/** NATIVE "Share": write to cache then open the system share sheet. */
export async function shareFile(blob: Blob, filename: string): Promise<void> {
  const name = sanitizeFilename(filename);
  const { uri } = await writeToCache(blob, name);
  await shareUri(uri, name);
}

async function shareUri(uri: string, name: string): Promise<void> {
  const { Share } = await import('@capacitor/share');
  await Share.share({ title: name, text: name, url: uri });
}

/** A thrown share error that is really just the user dismissing the sheet. */
export function isShareDismissal(message: string): boolean {
  return /cancel/i.test(message);
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

/** Write the blob into the app cache dir (chunked) and return its file:// URI. */
async function writeToCache(blob: Blob, name: string): Promise<{ uri: string }> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const directory = Directory.Cache;
  const path = `exports/${name}`;

  if (blob.size === 0) {
    await Filesystem.writeFile({ path, data: '', directory, recursive: true });
  } else {
    for (let offset = 0, first = true; offset < blob.size; offset += CHUNK_BYTES) {
      const data = await blobToBase64(blob.slice(offset, offset + CHUNK_BYTES));
      if (first) {
        await Filesystem.writeFile({ path, data, directory, recursive: true });
        first = false;
      } else {
        await Filesystem.appendFile({ path, data, directory });
      }
    }
  }

  return Filesystem.getUri({ path, directory });
}

// Characters illegal in a filesystem path segment: \ / : * ? " < > | and
// control chars. Spaces and hyphens are valid and kept.
const ILLEGAL_FILENAME_CHARS = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', 'g');

/** Replace path separators and filesystem-illegal characters (keeps spaces/hyphens). */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(ILLEGAL_FILENAME_CHARS, '_').trim();
  return cleaned.length ? cleaned : 'converted-file';
}

/** Minimal extension -> MIME map for MediaStore; falls back to octet-stream. */
function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    zip: 'application/zip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
  };
  return map[ext] ?? 'application/octet-stream';
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
