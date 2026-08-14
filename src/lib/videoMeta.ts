/**
 * Quick metadata and a poster frame for a video, read by the browser itself.
 *
 * Deliberately not ffmpeg: the file list wants this for every dropped clip the
 * moment it lands, and spinning up a 31 MB wasm core to read a duration would
 * make dropping four files feel broken. The browser's own decoder answers in
 * milliseconds from the file header.
 *
 * Formats the browser cannot decode (some MKV, some codecs ffmpeg handles fine)
 * simply return nothing, and the row falls back to name and size.
 */

export interface QuickMeta {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  /** Data URL of a frame from early in the clip. */
  poster: string | null;
}

const cache = new Map<string, QuickMeta>();

function keyOf(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export async function readVideoMeta(file: File): Promise<QuickMeta> {
  const key = keyOf(file);
  const hit = cache.get(key);
  if (hit) return hit;

  const empty: QuickMeta = { durationSeconds: null, width: null, height: null, poster: null };
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  // Some browsers refuse to decode a frame until the element is "playing", and
  // an off-DOM muted element is enough to satisfy that without anything showing.
  video.playsInline = true;
  video.src = url;

  try {
    const ok = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => resolve(v);
      video.onloadedmetadata = () => done(true);
      video.onerror = () => done(false);
      setTimeout(() => done(false), 8000);
    });
    if (!ok || !video.videoWidth) {
      cache.set(key, empty);
      return empty;
    }

    const meta: QuickMeta = {
      durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth,
      height: video.videoHeight,
      poster: null,
    };

    // A frame slightly in, since the very first is often black or a fade.
    const at = Math.min(1, (meta.durationSeconds ?? 1) * 0.1);
    const seeked = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => resolve(v);
      video.onseeked = () => done(true);
      video.onerror = () => done(false);
      setTimeout(() => done(false), 5000);
      try {
        video.currentTime = at;
      } catch {
        done(false);
      }
    });

    if (seeked) {
      try {
        const w = 96;
        const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d')!.drawImage(video, 0, 0, w, h);
        meta.poster = cv.toDataURL('image/jpeg', 0.6);
      } catch {
        /* tainted or undecodable; the row still shows size and duration */
      }
    }

    cache.set(key, meta);
    return meta;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
