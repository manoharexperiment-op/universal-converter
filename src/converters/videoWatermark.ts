import type { ConversionResult, ParamControl, ParamValues, ProgressFn } from './types';
import { addSuffix, replaceExt } from '../lib/strings';

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/**
 * A watermark that never moves is the easy case to strip: the background changes
 * from frame to frame but the mark does not, so a temporal median across a few
 * seconds reconstructs whatever sat behind it. Moving the mark breaks that, since
 * no single pixel is covered for long enough to be averaged out.
 */
export const VIDEO_WATERMARK_PARAMS: ParamControl[] = [
  { kind: 'text', key: 'text', label: 'Watermark text', default: '', placeholder: 'Your name, brand or @handle' },
  { kind: 'image', key: 'logo', label: 'Or use a logo', default: '', hint: 'PNG with transparency works best. A logo replaces the text.' },
  {
    kind: 'select',
    key: 'motion',
    label: 'Movement',
    default: 'bounce',
    options: [
      { value: 'bounce', label: 'Bounce around (hardest to remove)' },
      { value: 'drift', label: 'Drift slowly' },
      { value: 'hop', label: 'Jump between the corners' },
      { value: 'diagonal', label: 'Sweep corner to corner' },
      { value: 'static', label: 'Stay in one corner' },
    ],
  },
  { kind: 'range', key: 'size', label: 'Size', default: 18, min: 6, max: 45, step: 1, unit: '% of width' },
  { kind: 'range', key: 'opacity', label: 'Opacity', default: 55, min: 10, max: 100, step: 5, unit: '%' },
  {
    kind: 'select',
    key: 'speed',
    label: 'Speed',
    default: 'medium',
    options: [
      { value: 'slow', label: 'Slow' },
      { value: 'medium', label: 'Medium' },
      { value: 'fast', label: 'Fast' },
    ],
  },
];

/**
 * Read the pixel size from the browser's own decoder. Sizing the stamp here rather
 * than with ffmpeg's scale2ref keeps the filtergraph to a single overlay, and the
 * stamp is rasterised once at the right resolution instead of being resampled.
 */
async function videoSize(file: File): Promise<{ w: number; h: number; duration: number; guessed: boolean }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.src = url;
    const ok = await new Promise<boolean>((resolve) => {
      const done = (r: boolean) => resolve(r);
      v.onloadedmetadata = () => done(true);
      v.onerror = () => done(false);
      setTimeout(() => done(false), 15000);
    });
    if (ok && v.videoWidth > 0) {
      return { w: v.videoWidth, h: v.videoHeight, duration: v.duration || 0, guessed: false };
    }
  } catch {
    /* fall through to the assumption below */
  } finally {
    URL.revokeObjectURL(url);
  }
  // Some codecs ffmpeg handles are not decodable by the browser. The stamp is
  // sized as a share of the frame, so an assumed width only shifts that share.
  return { w: 1280, h: 720, duration: 0, guessed: true };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That logo could not be read. Try a PNG or JPG.'));
    img.src = src;
  });
}

/** Rasterise the mark once, at the exact pixel size it will occupy in the frame. */
async function buildStamp(
  text: string,
  logo: string,
  videoW: number,
  sizePct: number,
  opacity: number,
): Promise<{ png: Uint8Array; w: number; h: number }> {
  // Wider than this and the motion expressions have almost no room to travel.
  const targetW = Math.max(32, Math.round((videoW * Math.min(sizePct, 45)) / 100));
  const cv = document.createElement('canvas');
  const alpha = Math.min(1, Math.max(0.05, opacity / 100));

  if (logo) {
    const img = await loadImage(logo);
    const ratio = img.naturalHeight / img.naturalWidth || 1;
    cv.width = targetW;
    cv.height = Math.max(1, Math.round(targetW * ratio));
    const g = cv.getContext('2d')!;
    g.globalAlpha = alpha;
    g.drawImage(img, 0, 0, cv.width, cv.height);
  } else {
    // Measure at a reference size, then scale, so the text lands on the requested
    // share of the frame whatever the script or font metrics.
    const font = (px: number) => `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font(100);
    const refW = probe.measureText(text).width || 1;
    const fontPx = Math.max(10, Math.round((100 * targetW) / refW));

    const g0 = document.createElement('canvas').getContext('2d')!;
    g0.font = font(fontPx);
    const m = g0.measureText(text);
    const ascent = m.actualBoundingBoxAscent || fontPx * 0.8;
    const descent = m.actualBoundingBoxDescent || fontPx * 0.25;
    const pad = Math.ceil(fontPx * 0.16); // room for the outline

    cv.width = Math.ceil(m.width) + pad * 2;
    cv.height = Math.ceil(ascent + descent) + pad * 2;
    const g = cv.getContext('2d')!;
    g.font = font(fontPx);
    g.textBaseline = 'alphabetic';
    g.globalAlpha = alpha;
    // Dark outline first so the mark stays legible over both light and dark video.
    g.lineWidth = Math.max(2, fontPx * 0.11);
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.strokeText(text, pad, pad + ascent);
    g.fillStyle = '#ffffff';
    g.fillText(text, pad, pad + ascent);
  }

  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not build the watermark.');
  return { png: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height };
}

/**
 * Position expressions evaluated per frame by ffmpeg. W/H are the frame, w/h the
 * stamp, t the timestamp in seconds. Commas inside a function call have to be
 * escaped or the filtergraph parser reads them as the next filter argument.
 */
function motionExpr(
  motion: string,
  speed: number,
  margin: number,
  speedName: string,
): { x: string; y: string } {
  const m = margin;
  const sx = speed;
  const sy = (speed * 0.63).toFixed(1); // different rate per axis, so it does not just orbit
  switch (motion) {
    case 'bounce':
      return {
        x: `abs(mod(t*${sx}\\,2*(W-w))-(W-w))`,
        y: `abs(mod(t*${sy}\\,2*(H-h))-(H-h))`,
      };
    case 'drift':
      return {
        x: `abs(mod(t*${(sx * 0.35).toFixed(1)}\\,2*(W-w))-(W-w))`,
        y: `abs(mod(t*${(speed * 0.21).toFixed(1)}\\,2*(H-h))-(H-h))`,
      };
    case 'diagonal':
      return {
        x: `abs(mod(t*${sx}\\,2*(W-w))-(W-w))`,
        y: `abs(mod(t*${sx}\\,2*(H-h))-(H-h))`,
      };
    case 'hop': {
      // Corner order TL, TR, BR, BL, holding each for `hold` seconds. Keyed off the
      // chosen speed, not the pixel rate: that scales with frame width, so a small
      // clip would sit in one corner for the whole video.
      const hold = { slow: 4, medium: 2, fast: 1 }[speedName] ?? 2;
      const k = `mod(floor(t/${hold})\\,4)`;
      return {
        x: `if(lt(${k}\\,1)\\,${m}\\,if(lt(${k}\\,3)\\,W-w-${m}\\,${m}))`,
        y: `if(lt(${k}\\,2)\\,${m}\\,H-h-${m})`,
      };
    }
    default:
      return { x: `W-w-${m}`, y: `H-h-${m}` };
  }
}

/** Stamp a moving text or logo watermark onto a video. */
export async function watermarkVideo(
  file: File,
  onProgress?: ProgressFn,
  params?: ParamValues,
): Promise<ConversionResult> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(
      `This video is ${Math.round(file.size / 1048576)} MB, too large to process in the browser ` +
        `(limit ~${Math.round(MAX_VIDEO_BYTES / 1048576)} MB). Try a shorter clip.`,
    );
  }

  const text = String(params?.text ?? '').trim();
  const logo = String(params?.logo ?? '');
  if (!text && !logo) throw new Error('Type some watermark text, or choose a logo image.');

  const motion = String(params?.motion ?? 'bounce');
  const sizePct = Number(params?.size ?? 18);
  const opacity = Number(params?.opacity ?? 55);
  const speedName = String(params?.speed ?? 'medium');

  const { w: vw, h: vh, guessed } = await videoSize(file);
  const stamp = await buildStamp(text, logo, vw, sizePct, opacity);

  // Travel rate in pixels per second, scaled to the frame so the motion looks the
  // same on a phone clip and on 4K rather than crawling on the larger one.
  const base = { slow: 0.05, medium: 0.11, fast: 0.22 }[speedName] ?? 0.11;
  const speed = Math.max(20, Math.round(vw * base));
  const margin = Math.max(8, Math.round(vw * 0.02));
  const { x, y } = motionExpr(motion, speed, margin, speedName);

  const { fetchFile } = await import('@ffmpeg/util');
  const { sharedFFmpeg } = await import('./mediaConverters');
  const ffmpeg = await sharedFFmpeg();

  const input = `wm-in.${(file.name.split('.').pop() || 'mp4').toLowerCase()}`;
  const output = 'wm-out.mp4';
  const handleProgress = ({ progress }: { progress: number }) => {
    if (onProgress && progress >= 0 && progress <= 1) onProgress(progress);
  };
  ffmpeg.on('progress', handleProgress);

  try {
    await ffmpeg.writeFile(input, await fetchFile(file));
    await ffmpeg.writeFile('wm-stamp.png', stamp.png);

    const filter = `[0:v][1:v]overlay=x='${x}':y='${y}':format=auto[v]`;
    const encode = (audio: string[]) => [
      '-i', input,
      '-i', 'wm-stamp.png',
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '0:a?',
      ...audio,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', output,
    ];

    // Copy the original audio when the container allows it; re-encode only if not.
    let code = await ffmpeg.exec(encode(['-c:a', 'copy']));
    let reencodedAudio = false;
    if (code !== 0) {
      code = await ffmpeg.exec(encode(['-c:a', 'aac', '-b:a', '192k']));
      reencodedAudio = true;
    }
    if (code !== 0) throw new Error('Could not watermark this video (unsupported codec or corrupt file).');

    const data = (await ffmpeg.readFile(output)) as Uint8Array;
    const blob = new Blob([data], { type: 'video/mp4' });
    try {
      await ffmpeg.deleteFile(input);
      await ffmpeg.deleteFile('wm-stamp.png');
      await ffmpeg.deleteFile(output);
    } catch {
      /* non-fatal */
    }

    const moves = motion !== 'static';
    const notes = [
      moves
        ? 'The mark moves through the clip, so it cannot be averaged out across frames the way a fixed one can.'
        : 'A mark that stays put can be removed by software that averages several frames together. Pick a moving option if that matters.',
    ];
    if (guessed) notes.push('Your browser could not report this video\'s size, so the mark was scaled against an assumed 1280px width.');
    if (reencodedAudio) notes.push('The audio was re-encoded to AAC because the original track could not go into an MP4 as-is.');

    return {
      blob,
      filename: addSuffix(replaceExt(file.name, 'mp4'), '-watermarked'),
      note: notes.join(' '),
    };
  } finally {
    ffmpeg.off('progress', handleProgress);
  }
}
