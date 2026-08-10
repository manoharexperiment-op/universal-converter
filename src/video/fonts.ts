/**
 * Fonts for burned-in subtitles.
 *
 * libass and freetype are compiled into the ffmpeg build, but the wasm
 * filesystem ships no fonts at all. Without one, `subtitles` exits 0 and draws
 * absolutely nothing: a silent failure that looks like success. So the font has
 * to be written into the filesystem before any subtitle burn.
 *
 * Only the fonts a given subtitle file actually needs are loaded, because each
 * one is a few hundred KB of wasm heap that stays resident for the session.
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg';

export const FONT_DIR = '/fonts';

interface FontSpec {
  /** File in /public/fonts. */
  file: string;
  /** Family name libass matches against `FontName=`. */
  family: string;
  /** Does this font cover the character? */
  covers: (code: number) => boolean;
}

const LATIN: FontSpec = {
  file: 'NotoSans-Regular.ttf',
  family: 'Noto Sans',
  // Latin, Greek, Cyrillic and general punctuation.
  covers: (c) => c < 0x0530 || (c >= 0x1e00 && c <= 0x20cf),
};

/** Ordered by how likely they are to be needed by this app's users. */
const SCRIPTS: FontSpec[] = [
  { file: 'NotoSansDevanagari-Regular.ttf', family: 'Noto Sans Devanagari', covers: (c) => (c >= 0x0900 && c <= 0x097f) || (c >= 0xa8e0 && c <= 0xa8ff) },
  { file: 'NotoSansBengali-Regular.ttf', family: 'Noto Sans Bengali', covers: (c) => c >= 0x0980 && c <= 0x09ff },
  { file: 'NotoSansTamil-Regular.ttf', family: 'Noto Sans Tamil', covers: (c) => c >= 0x0b80 && c <= 0x0bff },
  { file: 'NotoSansTelugu-Regular.ttf', family: 'Noto Sans Telugu', covers: (c) => c >= 0x0c00 && c <= 0x0c7f },
  { file: 'NotoSansArabic-Regular.ttf', family: 'Noto Sans Arabic', covers: (c) => (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) },
];

/** Scripts we deliberately do not ship, so the user can be told plainly. */
const UNSHIPPED: { name: string; test: (c: number) => boolean }[] = [
  { name: 'Chinese', test: (c) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) },
  { name: 'Japanese', test: (c) => (c >= 0x3040 && c <= 0x30ff) },
  { name: 'Korean', test: (c) => (c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) },
  { name: 'Thai', test: (c) => c >= 0x0e00 && c <= 0x0e7f },
  { name: 'Hebrew', test: (c) => c >= 0x0590 && c <= 0x05ff },
];

export interface FontChoice {
  /** Value for libass `FontName=`. */
  family: string;
  /** Families loaded into the filesystem for this render. */
  loaded: string[];
  /** Scripts present in the text that we have no font for. */
  missingScripts: string[];
}

const written = new Set<string>();

async function writeFont(ffmpeg: FFmpeg, spec: FontSpec): Promise<boolean> {
  if (written.has(spec.file)) return true;
  try {
    const res = await fetch(`${window.location.origin}/fonts/${spec.file}`);
    if (!res.ok) return false;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // writeFile TRANSFERS the buffer, so a shared array would be detached for
    // any later write. Always hand it its own copy.
    await ffmpeg.writeFile(`${FONT_DIR}/${spec.file}`, bytes.slice());
    written.add(spec.file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the fonts `text` needs and return the family to render with.
 *
 * libass picks one family per style, so for mixed-script subtitles the dominant
 * non-Latin script wins: it will still fall back for characters that family
 * lacks, which is better than the reverse.
 */
export async function ensureFontsFor(ffmpeg: FFmpeg, text: string): Promise<FontChoice> {
  try {
    await ffmpeg.createDir(FONT_DIR);
  } catch {
    /* already there */
  }

  const counts = new Map<FontSpec, number>();
  const missing = new Set<string>();
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x0100) continue; // plain ASCII tells us nothing
    const spec = SCRIPTS.find((s) => s.covers(c));
    if (spec) {
      counts.set(spec, (counts.get(spec) ?? 0) + 1);
      continue;
    }
    const gap = UNSHIPPED.find((u) => u.test(c));
    if (gap) missing.add(gap.name);
  }

  const loaded: string[] = [];
  if (await writeFont(ffmpeg, LATIN)) loaded.push(LATIN.family);

  // Load every script present, so mixed subtitles are not silently dropped.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [spec] of ranked) {
    if (await writeFont(ffmpeg, spec)) loaded.push(spec.family);
  }

  return {
    family: ranked.length ? ranked[0][0].family : LATIN.family,
    loaded,
    missingScripts: [...missing],
  };
}

/** Forget the cache after the worker is terminated, since its FS went with it. */
export function resetFontCache(): void {
  written.clear();
}
