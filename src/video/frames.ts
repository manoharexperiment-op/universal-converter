import type { ConversionResult, ProgressFn } from '../converters/types';
import { VideoError, describeFailure } from './types';
import { probe } from './probe';
import { addSuffix, replaceExt } from '../lib/strings';
import { assertSize } from './engine';
import { blobBytes } from '../lib/bytes';

/** Save a single moment from a video as a still image. */
export async function extractFrame(
  file: File,
  atSeconds: number,
  format: 'png' | 'jpg' | 'webp',
  onProgress?: ProgressFn,
): Promise<ConversionResult> {
  assertSize(file);
  const { sharedFFmpeg } = await import('../converters/mediaConverters');
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await sharedFFmpeg();

  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    lines.push(message);
    if (lines.length > 200) lines.shift();
  };
  ffmpeg.on('log', onLog);

  const inPath = `fr_in.${(file.name.split('.').pop() || 'mp4').toLowerCase()}`;
  const outPath = `fr_out.${format}`;
  try {
    await ffmpeg.writeFile(inPath, await fetchFile(file));
    const info = await probe(ffmpeg, inPath, file.name, file.size);
    if (!info.durationSeconds) throw new VideoError('corrupt', 'This video reports no duration.');
    if (atSeconds >= info.durationSeconds) {
      throw new VideoError(
        'invalid-range',
        `That moment is past the end. This video is ${Math.round(info.durationSeconds)} seconds long.`,
      );
    }
    onProgress?.(0.4);

    // -ss before -i seeks quickly; a single frame is all that gets decoded.
    const args = ['-hide_banner', '-ss', String(Math.max(0, atSeconds)), '-i', inPath, '-frames:v', '1'];
    if (format === 'jpg') args.push('-q:v', '3');
    // libwebp is in this build; without naming it explicitly ffmpeg picks the
    // muxer from the extension and can land on an animated-webp encoder.
    if (format === 'webp') args.push('-c:v', 'libwebp', '-lossless', '0', '-quality', '82');
    args.push('-y', outPath);

    const code = await ffmpeg.exec(args);
    if (code !== 0) throw describeFailure(new Error('frame failed'), lines.slice(-20).join('\n'));
    const data = (await ffmpeg.readFile(outPath)) as Uint8Array;
    if (!data || data.length === 0) {
      throw new VideoError('failed', 'No frame came back from that moment. Try a slightly different time.');
    }
    onProgress?.(1);
    return {
      blob: new Blob([blobBytes(data)], {
        type: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg',
      }),
      filename: addSuffix(replaceExt(file.name, format), `-frame`),
      note: `Frame taken at ${Math.round(atSeconds)}s, ${info.width} x ${info.height}.`,
    };
  } catch (e) {
    throw describeFailure(e, lines.slice(-20).join('\n'));
  } finally {
    ffmpeg.off('log', onLog);
    for (const p of [inPath, outPath]) {
      try {
        await ffmpeg.deleteFile(p);
      } catch {
        /* fine */
      }
    }
  }
}

/**
 * Pick a frame that represents the video.
 *
 * ffmpeg's `thumbnail` filter scores frames in a batch and returns the most
 * representative, which beats grabbing frame one: the opening of a clip is
 * often black, a fade, or a title card.
 */
export async function generateThumbnail(file: File, onProgress?: ProgressFn): Promise<ConversionResult> {
  assertSize(file);
  const { sharedFFmpeg } = await import('../converters/mediaConverters');
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await sharedFFmpeg();

  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    lines.push(message);
    if (lines.length > 200) lines.shift();
  };
  ffmpeg.on('log', onLog);

  const inPath = `th_in.${(file.name.split('.').pop() || 'mp4').toLowerCase()}`;
  const outPath = 'th_out.jpg';
  try {
    await ffmpeg.writeFile(inPath, await fetchFile(file));
    const info = await probe(ffmpeg, inPath, file.name, file.size);
    onProgress?.(0.3);

    // Skip the first moment, where fades and title cards live, then let the
    // filter choose. Only a short window is scanned so this stays quick.
    const skip = Math.min(2, Math.max(0, info.durationSeconds * 0.1));
    const code = await ffmpeg.exec([
      '-hide_banner', '-ss', String(skip), '-i', inPath,
      '-vf', 'thumbnail=100', '-frames:v', '1', '-q:v', '3', '-y', outPath,
    ]);
    if (code !== 0) throw describeFailure(new Error('thumbnail failed'), lines.slice(-20).join('\n'));
    const data = (await ffmpeg.readFile(outPath)) as Uint8Array;
    if (!data || data.length === 0) throw new VideoError('failed', 'No thumbnail could be taken from this video.');
    onProgress?.(1);
    return {
      blob: new Blob([blobBytes(data)], { type: 'image/jpeg' }),
      filename: addSuffix(replaceExt(file.name, 'jpg'), '-thumbnail'),
      note: `Chosen automatically from the clip, ${info.width} x ${info.height}.`,
    };
  } catch (e) {
    throw describeFailure(e, lines.slice(-20).join('\n'));
  } finally {
    ffmpeg.off('log', onLog);
    for (const p of [inPath, outPath]) {
      try {
        await ffmpeg.deleteFile(p);
      } catch {
        /* fine */
      }
    }
  }
}
