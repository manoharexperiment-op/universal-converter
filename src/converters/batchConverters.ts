import type { ConversionResult, ProgressFn } from './types';
import { convertImageFormat } from './imageConverters';
import { preloadFFmpeg } from './mediaConverters';

/** Merge several PDFs into one, in the order given. */
export async function mergePdfs(files: File[], onProgress?: ProgressFn): Promise<ConversionResult> {
  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const src = await PDFDocument.load(new Uint8Array(await files[i].arrayBuffer()));
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
    onProgress?.((i + 1) / files.length);
  }

  const out = await merged.save();
  return { blob: new Blob([out], { type: 'application/pdf' }), filename: 'merged.pdf' };
}

/** Combine several images into a single PDF, one image per page. */
export async function imagesToPdf(files: File[], onProgress?: ProgressFn): Promise<ConversionResult> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let embedded;
    if (f.type === 'image/png') {
      embedded = await pdf.embedPng(new Uint8Array(await f.arrayBuffer()));
    } else if (f.type === 'image/jpeg') {
      embedded = await pdf.embedJpg(new Uint8Array(await f.arrayBuffer()));
    } else {
      // pdf-lib only embeds PNG/JPEG — normalize webp/bmp/gif to PNG first.
      const png = await convertImageFormat(f, 'png');
      embedded = await pdf.embedPng(new Uint8Array(await png.blob.arrayBuffer()));
    }
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    onProgress?.((i + 1) / files.length);
  }

  const out = await pdf.save();
  return { blob: new Blob([out], { type: 'application/pdf' }), filename: 'combined.pdf' };
}

/** Merge several audio files into one MP3, in the order given. */
export async function mergeAudio(files: File[], onProgress?: ProgressFn): Promise<ConversionResult> {
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await preloadFFmpeg();

  const names: string[] = [];
  for (let k = 0; k < files.length; k++) {
    const name = `a${k}.${(files[k].name.split('.').pop() || 'mp3').toLowerCase()}`;
    await ffmpeg.writeFile(name, await fetchFile(files[k]));
    names.push(name);
  }

  // Normalize every input to a common rate/layout, then concat — this survives
  // mixed codecs/sample-rates (stream-copy concat would corrupt those).
  const norm = names.map((_, k) => `[${k}:a]aresample=44100,aformat=channel_layouts=stereo[a${k}]`).join(';');
  const concatIn = names.map((_, k) => `[a${k}]`).join('');
  const filter = `${norm};${concatIn}concat=n=${names.length}:v=0:a=1[out]`;

  const args: string[] = [];
  names.forEach((n) => args.push('-i', n));
  args.push('-filter_complex', filter, '-map', '[out]', '-acodec', 'libmp3lame', '-b:a', '192k', 'merged.mp3');

  const handleProgress = ({ progress }: { progress: number }) => {
    if (onProgress && progress >= 0 && progress <= 1) onProgress(progress);
  };
  ffmpeg.on('progress', handleProgress);
  try {
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error('Could not merge these audio files.');
    const data = (await ffmpeg.readFile('merged.mp3')) as Uint8Array;
    const blob = new Blob([data], { type: 'audio/mpeg' });
    try {
      for (const n of names) await ffmpeg.deleteFile(n);
      await ffmpeg.deleteFile('merged.mp3');
    } catch {
      /* non-fatal */
    }
    return { blob, filename: 'merged.mp3' };
  } finally {
    ffmpeg.off('progress', handleProgress);
  }
}
