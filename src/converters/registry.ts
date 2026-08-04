import type { InspectResult, MergeOption, ParamControl, TargetOption } from './types';
import * as img from './imageConverters';
import * as pdf from './pdfConverters';
import * as doc from './documentConverters';
import * as sheet from './spreadsheetConverters';
import * as media from './mediaConverters';
import { mergePdfs, imagesToPdf, mergeAudio } from './batchConverters';
import * as qr from './qrConverters';
import * as exif from './exifConverters';
import * as office from './pdfOffice';
import * as ptext from './pdfTextTools';
import { addTextControls } from './pdfTextTools';

/* ---- reusable parameter controls ---- */
const BITRATE_PARAM: ParamControl = {
  kind: 'select', key: 'bitrate', label: 'Bitrate', default: '192k',
  options: [
    { value: '96k', label: '96 kbps' },
    { value: '128k', label: '128 kbps' },
    { value: '192k', label: '192 kbps' },
    { value: '256k', label: '256 kbps' },
    { value: '320k', label: '320 kbps' },
  ],
};
const TRIM_PARAMS: ParamControl[] = [
  { kind: 'number', key: 'start', label: 'Start', default: 0, min: 0, step: 0.1, unit: 's' },
  { kind: 'number', key: 'end', label: 'End (0 = to end)', default: 0, min: 0, step: 0.1, unit: 's' },
  BITRATE_PARAM,
];
const IMG_COMPRESS_PARAMS: ParamControl[] = [
  {
    kind: 'select', key: 'level', label: 'Compression', default: 'balanced',
    options: [
      { value: 'high', label: 'Best quality' },
      { value: 'balanced', label: 'Recommended' },
      { value: 'small', label: 'Small file' },
      { value: 'tiny', label: 'Smallest' },
    ],
  },
  {
    kind: 'select', key: 'format', label: 'Output', default: 'jpeg',
    options: [
      { value: 'jpeg', label: 'JPG' },
      { value: 'webp', label: 'WebP (smaller)' },
    ],
  },
];
const LEVEL_PARAM: ParamControl = {
  kind: 'select', key: 'level', label: 'Compression', default: 'medium',
  options: [
    { value: 'light', label: 'Light (crisp)' },
    { value: 'medium', label: 'Balanced' },
    { value: 'strong', label: 'Strong (smallest)' },
  ],
};
const VIDEO_LEVEL_PARAM: ParamControl = {
  kind: 'select', key: 'level', label: 'Compression', default: 'balanced',
  options: [
    { value: 'light', label: 'Light' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'strong', label: 'Strong (smallest)' },
  ],
};
const MAXWIDTH_PARAM: ParamControl = { kind: 'number', key: 'maxWidth', label: 'Max width', default: 1280, min: 144, max: 3840, step: 1, unit: 'px' };
const GIF_PARAMS: ParamControl[] = [
  { kind: 'number', key: 'fps', label: 'Frame rate', default: 12, min: 5, max: 20, step: 1, unit: 'fps' },
  { kind: 'number', key: 'width', label: 'Width', default: 480, min: 120, max: 800, step: 1, unit: 'px' },
];
const RESIZE_PARAMS: ParamControl[] = [
  { kind: 'number', key: 'width', label: 'Width (0 = auto)', default: 1280, min: 0, max: 12000, step: 1, unit: 'px' },
  { kind: 'number', key: 'height', label: 'Height (0 = auto)', default: 0, min: 0, max: 12000, step: 1, unit: 'px' },
  {
    kind: 'select', key: 'mode', label: 'Mode', default: 'fit',
    options: [
      { value: 'fit', label: 'Keep aspect ratio' },
      { value: 'stretch', label: 'Stretch to exact' },
    ],
  },
  {
    kind: 'select', key: 'format', label: 'Output', default: 'jpeg',
    options: [
      { value: 'jpeg', label: 'JPG' },
      { value: 'png', label: 'PNG' },
      { value: 'webp', label: 'WebP' },
    ],
  },
];
const SIGN_PARAMS: ParamControl[] = [
  { kind: 'signature', key: 'signature', label: 'Your signature', default: '' },
  {
    kind: 'placement',
    key: 'placement',
    label: 'Place it',
    imageKey: 'signature',
    default: { x: 0.62, y: 0.78, w: 0.25, page: 1 },
  },
  {
    kind: 'select', key: 'date', label: 'Add date', default: 'today',
    options: [
      { value: 'today', label: "Today's date (under the signature)" },
      { value: 'none', label: 'No date' },
    ],
  },
];
const PROTECT_PARAMS: ParamControl[] = [
  { kind: 'text', key: 'password', label: 'New password', default: '', placeholder: 'Choose a password', password: true },
];
const UNLOCK_PARAMS: ParamControl[] = [
  { kind: 'text', key: 'password', label: 'Current password', default: '', placeholder: 'The PDF’s password', password: true },
];
const WATERMARK_PARAMS: ParamControl[] = [
  { kind: 'text', key: 'text', label: 'Watermark text', default: 'CONFIDENTIAL', placeholder: 'Your text' },
  {
    kind: 'select', key: 'position', label: 'Style', default: 'diagonal',
    options: [
      { value: 'diagonal', label: 'Diagonal' },
      { value: 'tile', label: 'Tiled' },
      { value: 'center', label: 'Center' },
      { value: 'bottom-right', label: 'Bottom-right' },
    ],
  },
  { kind: 'range', key: 'opacity', label: 'Opacity', default: 35, min: 5, max: 100, step: 5, unit: '%' },
  { kind: 'range', key: 'size', label: 'Size (images)', default: 6, min: 2, max: 20, step: 1, unit: '%' },
];

/** Turn the form fields found inside a PDF into controls the UI can render. */
async function inspectFormControls(file: File): Promise<InspectResult> {
  const { fields, message } = await ptext.inspectPdfForm(file);
  const params: ParamControl[] = fields.map((f) => {
    if (f.type === 'checkbox') {
      return {
        kind: 'select', key: f.name, label: f.name,
        default: f.value === 'yes' ? 'yes' : 'no',
        options: [{ value: 'yes', label: 'Ticked' }, { value: 'no', label: 'Not ticked' }],
      };
    }
    if (f.options?.length) {
      return {
        kind: 'select', key: f.name, label: f.name,
        default: f.value || f.options[0],
        options: f.options.map((o) => ({ value: o, label: o || '(blank)' })),
      };
    }
    return { kind: 'text', key: f.name, label: f.name, default: f.value ?? '', placeholder: 'Type here' };
  });
  if (params.length) {
    params.push({
      kind: 'select', key: '__flatten', label: 'Lock the answers in', default: 'yes',
      options: [
        { value: 'yes', label: 'Yes, make them permanent' },
        { value: 'no', label: 'No, keep the form editable' },
      ],
    });
  }
  return { params, message };
}

/** Image inputs the browser can reliably decode via <img>/Canvas. */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
/** Video inputs ffmpeg.wasm can read. */
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'wmv'];
/** Audio inputs ffmpeg.wasm can read. */
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma'];

/** Map a filename to an internal source type, or null if unsupported. */
export function getSourceType(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

/** All conversions available for each source type. */
export const REGISTRY: Record<string, TargetOption[]> = {
  image: [
    { target: 'png', label: 'PNG', run: (f) => img.convertImageFormat(f, 'png') },
    { target: 'jpg', label: 'JPG', run: (f) => img.convertImageFormat(f, 'jpg') },
    { target: 'webp', label: 'WebP', run: (f) => img.convertImageFormat(f, 'webp') },
    { target: 'jpg', label: 'Compress', note: 'Shrink photos by re-encoding (and optionally resizing)', params: IMG_COMPRESS_PARAMS, run: (f, p, pv) => img.compressImage(f, p, pv) },
    { target: 'jpg', label: 'Resize', note: 'Set an exact width/height — keep the aspect ratio or stretch', params: RESIZE_PARAMS, run: (f, p, pv) => img.resizeImage(f, p, pv) },
    { target: 'jpg', label: 'Watermark', note: 'Stamp your text over the image', params: WATERMARK_PARAMS, run: (f, p, pv) => img.watermarkImage(f, p, pv) },
    { target: 'png', label: 'Remove BG', note: 'AI cutout, on-device & offline. Best on clear subjects; can be slow on phones. Output is a transparent PNG.', run: (f, p) => img.removeImageBackground(f, p) },
    { target: 'jpg', batch: 'never', label: 'Sign & date', note: 'Draw your signature, then drag it anywhere on the photo', params: SIGN_PARAMS, run: (f, p, pv) => img.signPhoto(f, p, pv) },
    { target: 'pdf', label: 'PDF', run: (f) => img.imageToPdf(f) },
    { target: 'txt', label: 'Text (OCR)', note: 'Reads text out of the image on-device', run: (f, p) => img.imageToText(f, p) },
    { target: 'txt', label: 'Read QR', note: 'Finds a QR code in the picture and reads it out', run: (f, p) => qr.readQrCode(f, p) },
    { target: 'txt', batch: 'never', label: 'View metadata', note: 'See what is hidden inside the photo, including GPS location', run: (f) => exif.viewImageMetadata(f) },
    { target: 'jpg', label: 'Strip metadata', note: 'Removes GPS, camera and date without touching the picture quality', run: (f) => exif.stripImageMetadata(f) },
  ],
  pdf: [
    { target: 'png', batch: 'never', label: 'PNG', note: 'One image per page (zipped if multiple)', run: (f, p) => pdf.pdfToImages(f, 'png', p) },
    { target: 'jpg', batch: 'never', label: 'JPG', note: 'One image per page (zipped if multiple)', run: (f, p) => pdf.pdfToImages(f, 'jpg', p) },
    { target: 'txt', label: 'Text', run: (f, p) => pdf.pdfToText(f, p) },
    { target: 'docx', label: 'Word', note: 'Rebuilds headings and paragraphs; falls back to OCR for scans', run: (f, p) => office.pdfToDocxRich(f, p) },
    { target: 'xlsx', label: 'Excel', note: 'Ruled tables become rows and columns; otherwise one row per line', run: (f, p) => office.pdfToXlsx(f, p) },
    { target: 'pdf', label: 'Rotate 90°', note: 'Rotates every page 90° clockwise', run: (f) => pdf.pdfRotate(f, 90) },
    { target: 'zip', batch: 'never', label: 'Split pages', note: 'Each page as its own PDF (zipped)', run: (f, p) => pdf.pdfSplit(f, p) },
    { target: 'pdf', label: 'Compress', note: 'Best for scanned/image PDFs — flattens pages to images, so text is no longer selectable', params: [LEVEL_PARAM], run: (f, p, pv) => pdf.compressPdf(f, p, pv) },
    { target: 'pdf', label: 'Watermark', note: 'Stamp your text on every page', params: WATERMARK_PARAMS, run: (f, p, pv) => pdf.watermarkPdf(f, p, pv) },
    { target: 'pdf', label: 'Protect', note: 'Add a password (AES-256). It cannot be recovered if forgotten.', params: PROTECT_PARAMS, run: (f, p, pv) => pdf.protectPdf(f, p, pv) },
    { target: 'pdf', label: 'Unlock', note: 'Remove a password you already know', params: UNLOCK_PARAMS, run: (f, p, pv) => pdf.removePdfPassword(f, p, pv) },
    { target: 'pdf', label: 'Remove watermark', note: 'Only removes separate watermark layers/annotations — not marks drawn into the page', run: (f) => pdf.removePdfWatermark(f) },
    { target: 'pdf', batch: 'never', label: 'Add text', note: 'Type anything and drag it where you want, works on scans too', params: addTextControls, run: (f, p, pv) => ptext.addTextToPdf(f, p, pv) },
    { target: 'pdf', batch: 'never', label: 'Fill form', note: 'Fills a PDF that has real form fields', inspect: inspectFormControls, run: (f, p, pv) => ptext.fillPdfForm(f, p, pv) },
    { target: 'pdf', batch: 'never', label: 'Sign & date', note: 'Draw your signature, then drag it anywhere on the page', params: SIGN_PARAMS, run: (f, p, pv) => pdf.signPdf(f, p, pv) },
  ],
  docx: [
    { target: 'pdf', label: 'PDF', note: 'Text + headings; advanced styling simplified', run: (f) => doc.docxToPdf(f) },
    { target: 'txt', label: 'Text', run: (f) => doc.docxToText(f) },
    { target: 'html', label: 'HTML', run: (f) => doc.docxToHtml(f) },
  ],
  video: [
    { target: 'mp3', label: 'MP3 (audio)', note: 'Extracts the audio track as MP3', params: [BITRATE_PARAM], run: (f, p, pv) => media.toMp3(f, p, pv) },
    { target: 'wav', label: 'WAV (audio)', note: 'Extracts the audio track, uncompressed', run: (f, p) => media.toWav(f, p) },
    { target: 'gif', label: 'GIF', note: 'Best for short clips — keep it under ~15s', params: GIF_PARAMS, run: (f, p, pv) => media.videoToGif(f, p, pv) },
    { target: 'mp4', label: 'MP4', note: 'In-browser video encoding is slow (~5–10× real time)', params: [MAXWIDTH_PARAM], run: (f, p, pv) => media.videoToMp4(f, p, pv) },
    { target: 'webm', label: 'WebM', note: 'In-browser video encoding is slow (~5–10× real time)', params: [MAXWIDTH_PARAM], run: (f, p, pv) => media.videoToWebm(f, p, pv) },
    { target: 'mp4', label: 'Compress', note: 'Re-encodes smaller (slow in-browser)', params: [VIDEO_LEVEL_PARAM], run: (f, p, pv) => media.compressVideo(f, p, pv) },
  ],
  audio: [
    { target: 'mp3', label: 'MP3', params: [BITRATE_PARAM], run: (f, p, pv) => media.toMp3(f, p, pv) },
    { target: 'wav', label: 'WAV', note: 'Uncompressed', run: (f, p) => media.toWav(f, p) },
    { target: 'mp3', label: 'Trim', note: 'Cut to a start/end time, output MP3', params: TRIM_PARAMS, run: (f, p, pv) => media.trimAudio(f, p, pv) },
  ],
  xlsx: [{ target: 'csv', label: 'CSV', note: 'Exports the first sheet', run: (f) => sheet.xlsxToCsv(f) }],
  csv: [{ target: 'xlsx', label: 'Excel', run: (f) => sheet.csvToXlsx(f) }],
  txt: [{ target: 'pdf', label: 'PDF', run: (f) => doc.txtToPdf(f) }],
  md: [
    { target: 'pdf', label: 'PDF', run: (f) => doc.markdownToPdf(f) },
    { target: 'html', label: 'HTML', run: (f) => doc.markdownToHtml(f) },
  ],
  html: [{ target: 'pdf', label: 'PDF', note: 'Text + headings; CSS layout simplified', run: (f) => doc.htmlToPdf(f) }],
};

/** Actions offered when several files of the same kind are dropped together. */
export const MERGE_REGISTRY: Record<string, MergeOption[]> = {
  pdf: [{ target: 'pdf', label: 'Merge into one PDF', note: 'Joins every PDF, in the order shown above', run: mergePdfs }],
  image: [{ target: 'pdf', label: 'Combine into one PDF', note: 'One image per page, in the order shown above', run: imagesToPdf }],
  audio: [{ target: 'mp3', label: 'Join into one MP3', note: 'Plays end to end, in the order shown above', media: true, run: mergeAudio }],
};

/**
 * Tools that are pointless or punishing to run across many files at once.
 * Video encoding takes minutes per file, so a batch of ten would look frozen.
 */
const NO_BATCH_TYPES = new Set(['video']);

/** The per-file tools offered for a batch of `type` files. */
export function batchableFor(type: string): TargetOption[] {
  if (NO_BATCH_TYPES.has(type)) return [];
  return (REGISTRY[type] ?? []).filter((o) => o.batch !== 'never');
}
