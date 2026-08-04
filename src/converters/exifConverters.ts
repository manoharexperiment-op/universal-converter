import type { ConversionResult, ViewGroup, ViewRow } from './types';
import { addSuffix, formatBytes, stripExt } from '../lib/strings';

type Blocks = Record<string, Record<string, unknown> | undefined>;
type Container = 'jpeg' | 'png' | 'webp' | 'other';

const CONTAINER_MIME: Record<Container, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  other: 'application/octet-stream',
};

const CONTAINER_NAME: Record<Container, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  other: 'file',
};

// The lite bundle only parses JPEG/HEIC and only TIFF+XMP. PNG eXIf and IPTC
// both need the full bundle, and this tool has to be honest about PNGs.
async function loadExifr() {
  return (await import('exifr')).default;
}

const READ_OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  interop: true,
  // ifd1 is the thumbnail IFD: its numeric keys collide with ifd0 under mergeOutput:false.
  ifd1: false,
  iptc: true,
  xmp: { parse: true },
  // icc is a colour profile and jfif is density/thumbnail housekeeping. Neither
  // identifies anyone, and both bury the fields that do.
  icc: false,
  jfif: false,
  ihdr: true,
  makerNote: false,
  userComment: true,
  mergeOutput: false,
  sanitize: true,
  translateKeys: true,
  translateValues: true,
  reviveValues: true,
  silentErrors: true,
};

const LOCATION_KEYS = [
  'latitude',
  'longitude',
  'GPSAltitude',
  'GPSAltitudeRef',
  'GPSHPositioningError',
  'GPSDateStamp',
  'GPSTimeStamp',
  'GPSSpeed',
  'GPSSpeedRef',
  'GPSImgDirection',
  'GPSImgDirectionRef',
  'GPSDestLatitude',
  'GPSDestLongitude',
  'GPSProcessingMethod',
  'GPSAreaInformation',
  'GPSMapDatum',
];

const CAMERA_KEYS = [
  'Make',
  'Model',
  'LensMake',
  'LensModel',
  'LensInfo',
  'Software',
  'HostComputer',
  'CameraOwnerName',
  'BodySerialNumber',
  'LensSerialNumber',
  'SerialNumber',
  'Artist',
  'Copyright',
];

const IDENTIFYING_KEYS = new Set([
  'HostComputer',
  'CameraOwnerName',
  'BodySerialNumber',
  'LensSerialNumber',
  'SerialNumber',
  'Artist',
  'Copyright',
  'OwnerName',
]);

const PHOTO_KEYS = [
  'DateTimeOriginal',
  'CreateDate',
  'ModifyDate',
  'OffsetTimeOriginal',
  'OffsetTime',
  'ExposureTime',
  'FNumber',
  'ISO',
  'ExposureProgram',
  'ExposureCompensation',
  'ShutterSpeedValue',
  'ApertureValue',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'Flash',
  'MeteringMode',
  'WhiteBalance',
  'ColorSpace',
  'Orientation',
  'ExifImageWidth',
  'ExifImageHeight',
  'ImageWidth',
  'ImageHeight',
  'XResolution',
  'YResolution',
  'ResolutionUnit',
  'SceneCaptureType',
  'DigitalZoomRatio',
  'Contrast',
  'Saturation',
  'Sharpness',
];

const DATE_KEYS = ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateCreated', 'GPSDateStamp'];

const PLACE_NAME_KEYS = new Set(['City', 'Country', 'CountryCode', 'State', 'Province-State', 'Sublocation', 'Location']);

const LABELS: Record<string, string> = {
  latitude: 'Latitude',
  longitude: 'Longitude',
  GPSAltitude: 'Altitude',
  GPSDateStamp: 'GPS date',
  GPSTimeStamp: 'GPS time',
  GPSSpeed: 'Speed',
  GPSImgDirection: 'Facing direction',
  GPSHPositioningError: 'Accuracy',
  Make: 'Camera make',
  Model: 'Camera model',
  LensModel: 'Lens',
  LensMake: 'Lens make',
  Software: 'Software',
  HostComputer: 'Computer',
  CameraOwnerName: 'Owner name',
  BodySerialNumber: 'Camera serial number',
  LensSerialNumber: 'Lens serial number',
  SerialNumber: 'Serial number',
  DateTimeOriginal: 'Date taken',
  CreateDate: 'Date created',
  ModifyDate: 'Date modified',
  ExposureTime: 'Shutter speed',
  FNumber: 'Aperture (f-number)',
  ISO: 'ISO',
  FocalLength: 'Focal length',
  FocalLengthIn35mmFormat: 'Focal length (35mm equivalent)',
  ExifImageWidth: 'Width',
  ExifImageHeight: 'Height',
  ImageWidth: 'Width',
  ImageHeight: 'Height',
};

function humanize(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const s = key
    .replace(/^GPS/, 'GPS ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatValue(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid date' : v.toLocaleString();
  if (v instanceof Uint8Array) return `binary data, ${v.length} bytes`;
  if (Array.isArray(v)) return v.map((x) => formatValue(x, depth + 1)).filter(Boolean).join(', ');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    if (depth > 2) return '(nested data)';
    const parts: string[] = [];
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = formatValue(val, depth + 1);
      if (s) parts.push(`${k}: ${s}`);
    }
    return truncate(parts.join('; '));
  }
  return truncate(String(v).replace(/\s+/g, ' ').trim());
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function coord(n: number): string {
  return n.toFixed(6);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pickRows(src: Record<string, unknown>, keys: string[], used: Set<string>, level?: ViewRow['level']): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const key of keys) {
    if (!(key in src)) continue;
    used.add(key);
    const value = formatValue(src[key]);
    if (!value) continue;
    const rowLevel = level ?? (IDENTIFYING_KEYS.has(key) ? 'warn' : undefined);
    rows.push(rowLevel ? { label: humanize(key), value, level: rowLevel } : { label: humanize(key), value });
  }
  return rows;
}

function leftoverRows(src: Record<string, unknown>, used: Set<string>, limit: number): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const [key, raw] of Object.entries(src)) {
    if (used.has(key)) continue;
    const value = formatValue(raw);
    if (!value) continue;
    rows.push({ label: humanize(key), value });
    if (rows.length >= limit) break;
  }
  return rows;
}

// With mergeOutput:false exifr returns each parsed XMP namespace (dc, photoshop, ...)
// as its own top-level block, sitting next to ifd0/exif/gps, not nested under `xmp`.
const KNOWN_BLOCKS = new Set(['ifd0', 'exif', 'gps', 'interop', 'ifd1', 'iptc', 'icc', 'jfif', 'ihdr', 'thumbnail', 'makerNote', 'userComment', 'errors']);

function xmpBlocksOf(blocks: Blocks): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(blocks)) {
    if (KNOWN_BLOCKS.has(key)) continue;
    const rec = asRecord(value);
    if (Object.keys(rec).length) out.push(rec);
  }
  return out;
}

function gpsCoords(blocks: Blocks): { lat: number; lon: number } | null {
  const gps = asRecord(blocks.gps);
  const lat = gps.latitude;
  const lon = gps.longitude;
  if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon };
  }
  return null;
}

function buildGroups(blocks: Blocks): { groups: ViewGroup[]; privacyRows: number } {
  const groups: ViewGroup[] = [];
  const gps = asRecord(blocks.gps);
  const tiff = { ...asRecord(blocks.ifd0), ...asRecord(blocks.exif) };
  const iptc = asRecord(blocks.iptc);
  const misc = { ...asRecord(blocks.jfif), ...asRecord(blocks.ihdr), ...asRecord(blocks.interop) };

  const here = gpsCoords(blocks);
  if (here) {
    const usedGps = new Set<string>();
    const rows: ViewRow[] = [
      { label: 'Coordinates', value: `${coord(here.lat)}, ${coord(here.lon)}`, level: 'alert' },
      ...pickRows(gps, LOCATION_KEYS, usedGps, 'alert'),
      ...leftoverRows(gps, usedGps, 10).map((r): ViewRow => ({ ...r, level: 'alert' })),
      { label: 'What this means', value: 'This photo records the exact spot where it was taken. Anyone you send it to can read it.', level: 'alert' },
    ];
    groups.push({ title: 'Location', rows });
  }

  const usedTiff = new Set<string>();
  const cameraRows = pickRows(tiff, CAMERA_KEYS, usedTiff);
  if (cameraRows.length) groups.push({ title: 'Camera', rows: cameraRows });

  const photoRows = pickRows(tiff, PHOTO_KEYS, usedTiff);
  if (photoRows.length) groups.push({ title: 'Photo', rows: photoRows });

  const descRows: ViewRow[] = [];
  for (const src of [iptc, ...xmpBlocksOf(blocks)]) {
    for (const [key, raw] of Object.entries(src)) {
      const value = formatValue(raw);
      if (!value) continue;
      const level: ViewRow['level'] | undefined = PLACE_NAME_KEYS.has(key) ? 'warn' : undefined;
      descRows.push(level ? { label: humanize(key), value, level } : { label: humanize(key), value });
      if (descRows.length >= 40) break;
    }
  }
  if (descRows.length) groups.push({ title: 'Description, rights and editing history', rows: descRows });

  const otherRows = leftoverRows(tiff, usedTiff, 40);
  if (otherRows.length) groups.push({ title: 'Other', rows: otherRows });

  const privacyRows = groups.reduce((n, g) => n + g.rows.length, 0);
  if (!privacyRows) {
    groups.push({
      title: 'No metadata found',
      rows: [
        { label: 'Result', value: 'This file carries no Exif, GPS, IPTC or XMP data.' },
        { label: 'Meaning', value: 'Nothing here identifies your camera, your location or when the photo was taken. That is a good result.' },
      ],
    });
  }

  // Container header fields are not tracking data, so they never count as "has metadata".
  const techRows = leftoverRows(misc, new Set<string>(), 20);
  if (techRows.length) groups.push({ title: 'Image details', rows: techRows });

  return { groups, privacyRows };
}

/** exifr has no WebP file parser, so hand it the raw TIFF block out of the EXIF chunk instead. */
function extractWebpExif(b: Uint8Array): Uint8Array | null {
  if (b.length < 20) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 12;
  while (i + 8 <= b.length) {
    const size = dv.getUint32(i + 4, true);
    if (i + 8 + size > b.length) return null;
    if (ascii(b, i, 4) === 'EXIF') {
      const data = b.slice(i + 8, i + 8 + size);
      return ascii(data, 0, 4) === 'Exif' ? data.slice(6) : data;
    }
    i += 8 + size + (size & 1);
  }
  return null;
}

async function readBlocks(file: File, preloaded?: Uint8Array): Promise<{ blocks: Blocks; error: string }> {
  try {
    const bytes = preloaded ?? new Uint8Array(await file.slice(0, 16).arrayBuffer());
    let input: File | Uint8Array = file;
    if (detect(bytes) === 'webp') {
      const tiff = extractWebpExif(preloaded ?? new Uint8Array(await file.arrayBuffer()));
      if (!tiff) return { blocks: {}, error: '' };
      input = tiff;
    }
    const exifr = await loadExifr();
    return { blocks: ((await exifr.parse(input, READ_OPTIONS)) as Blocks) ?? {}, error: '' };
  } catch (err) {
    return { blocks: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

function groupsToText(file: File, groups: ViewGroup[]): string {
  const lines: string[] = [
    'Photo metadata report',
    '',
    `File: ${file.name}`,
    `Size: ${formatBytes(file.size)} (${file.size} bytes)`,
    `Type: ${file.type || 'unknown'}`,
    `Read on: ${new Date().toLocaleString()}`,
    '',
    'Generated by MunnX Convertor. Everything was read on this device.',
    '',
  ];
  for (const group of groups) {
    lines.push(`== ${group.title} ==`);
    const pad = Math.min(32, Math.max(...group.rows.map((r) => r.label.length), 0));
    for (const row of group.rows) {
      lines.push(`${row.label.padEnd(pad)}  ${row.value}`);
    }
    lines.push('');
  }
  return lines.join('\r\n');
}

export async function viewImageMetadata(file: File): Promise<ConversionResult> {
  const { blocks, error: readError } = await readBlocks(file);
  const { groups, privacyRows } = buildGroups(blocks);
  if (readError && !privacyRows) {
    groups.push({ title: 'Reader note', rows: [{ label: 'Could not fully parse', value: readError }] });
  }

  const text = groupsToText(file, groups);
  const here = gpsCoords(blocks);
  const note = here
    ? `This photo records exactly where it was taken: ${coord(here.lat)}, ${coord(here.lon)}. Use "Remove metadata" to strip that out without touching the image.`
    : privacyRows
      ? `Read ${privacyRows} metadata fields. No GPS coordinates found.`
      : 'No Exif, GPS, IPTC or XMP metadata found in this file.';

  return {
    blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    filename: `${stripExt(file.name)}-metadata.txt`,
    note,
    view: { kind: 'fields', groups },
  };
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  const end = Math.min(off + len, b.length);
  for (let i = off; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function detect(b: Uint8Array): Container {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'png';
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return 'other';
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

interface TiffInfo {
  orientation: number;
  /** True when the block is exactly what this tool re-injects, so it is not worth stripping again. */
  onlyOrientation: boolean;
}

function inspectTiff(t: Uint8Array): TiffInfo {
  const none: TiffInfo = { orientation: 0, onlyOrientation: false };
  if (t.length < 14) return none;
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4d && t[1] === 0x4d;
  if (!le && !be) return none;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  if (dv.getUint16(2, le) !== 42) return none;
  const ifd0 = dv.getUint32(4, le);
  if (ifd0 + 6 > t.length) return none;
  const count = dv.getUint16(ifd0, le);
  let orientation = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > t.length) return none;
    if (dv.getUint16(entry, le) !== 0x0112) continue;
    const type = dv.getUint16(entry + 2, le);
    const value = type === 3 ? dv.getUint16(entry + 8, le) : dv.getUint32(entry + 8, le);
    if (value >= 1 && value <= 8) orientation = value;
  }
  const nextAt = ifd0 + 2 + count * 12;
  const nextIfd = nextAt + 4 <= t.length ? dv.getUint32(nextAt, le) : 1;
  return { orientation, onlyOrientation: count === 1 && orientation > 0 && nextIfd === 0 };
}

function makeOrientationTiff(orientation: number): Uint8Array {
  const t = new Uint8Array(26);
  const dv = new DataView(t.buffer);
  t[0] = 0x49;
  t[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 0x0112, true);
  dv.setUint16(12, 3, true);
  dv.setUint32(14, 1, true);
  dv.setUint16(18, orientation, true);
  dv.setUint32(22, 0, true);
  return t;
}

function makeExifApp1(tiff: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 6 + tiff.length);
  out[0] = 0xff;
  out[1] = 0xe1;
  const len = 2 + 6 + tiff.length;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  out.set(tiff, 10);
  return out;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

interface StripReport {
  bytes: Uint8Array | null;
  removed: string[];
  orientation: number;
  reinjected: boolean;
}

/** An Exif block holding nothing but Orientation is what this tool writes back, so re-stripping it is a no-op. */
function nothingWorthRemoving(removed: string[], exifLabel: string, trivialExif: boolean): boolean {
  if (!removed.length) return true;
  return removed.length === 1 && removed[0] === exifLabel && trivialExif;
}

function stripJpeg(b: Uint8Array): StripReport {
  const removed: string[] = [];
  const kept: Uint8Array[] = [];
  let orientation = 0;
  let trivialExif = false;
  let i = 2;
  // Everything from here on is copied verbatim. Set on every exit path, including
  // a desync, so a malformed header can never cost us the compressed scan.
  let tailStart = -1;

  while (i + 3 < b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    const end = Math.min(i + 2 + len, b.length);
    const payload = i + 4;

    let label = '';
    if (marker === 0xe1) {
      const id = ascii(b, payload, 34);
      if (id.startsWith('Exif')) {
        label = 'Exif (APP1)';
        const info = inspectTiff(b.subarray(payload + 6, end));
        orientation = info.orientation || orientation;
        trivialExif = info.onlyOrientation;
      } else if (id.startsWith('http://ns.adobe.com/xap/1.0/')) {
        label = 'XMP (APP1)';
      } else if (id.startsWith('http://ns.adobe.com/xmp/extension/')) {
        label = 'Extended XMP (APP1)';
      } else {
        label = 'APP1';
      }
    } else if (marker === 0xed) {
      label = 'IPTC and Photoshop data (APP13)';
    } else if (marker === 0xfe) {
      label = 'Comment (COM)';
    }

    if (label) {
      if (!removed.includes(label)) removed.push(label);
    } else {
      kept.push(b.subarray(i, end));
    }
    i = end;
  }
  if (tailStart < 0) tailStart = i;

  if (nothingWorthRemoving(removed, 'Exif (APP1)', trivialExif)) {
    return { bytes: null, removed: [], orientation, reinjected: false };
  }

  const reinjected = orientation > 1;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  if (reinjected) parts.push(makeExifApp1(makeOrientationTiff(orientation)));
  parts.push(...kept, b.subarray(tailStart));
  return { bytes: concat(parts), removed, orientation, reinjected };
}

const PNG_DROP: Record<string, string> = {
  eXIf: 'Exif (eXIf chunk)',
  tEXt: 'Text comments (tEXt)',
  iTXt: 'XMP and text comments (iTXt)',
  zTXt: 'Compressed text comments (zTXt)',
  tIME: 'Last-modified time (tIME)',
};

function stripPng(b: Uint8Array): StripReport {
  const removed: string[] = [];
  const kept: Uint8Array[] = [];
  let orientation = 0;
  let trivialExif = false;
  let i = 8;
  let ihdrEnd = 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  while (i + 8 <= b.length) {
    const len = dv.getUint32(i, false);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (len > b.length || end > b.length) break;
    const label = PNG_DROP[type];
    if (label) {
      if (!removed.includes(label)) removed.push(label);
      if (type === 'eXIf') {
        const info = inspectTiff(b.subarray(i + 8, i + 8 + len));
        orientation = info.orientation || orientation;
        trivialExif = info.onlyOrientation;
      }
    } else {
      kept.push(b.subarray(i, end));
      if (type === 'IHDR') ihdrEnd = kept.length;
    }
    i = end;
    if (type === 'IEND') break;
  }

  if (nothingWorthRemoving(removed, PNG_DROP.eXIf, trivialExif)) {
    return { bytes: null, removed: [], orientation, reinjected: false };
  }

  const reinjected = orientation > 1;
  const parts: Uint8Array[] = [b.subarray(0, 8), ...kept.slice(0, ihdrEnd)];
  if (reinjected) parts.push(makePngChunk('eXIf', makeOrientationTiff(orientation)));
  parts.push(...kept.slice(ihdrEnd));
  if (i < b.length) parts.push(b.subarray(i));
  return { bytes: concat(parts), removed, orientation, reinjected };
}

function stripWebp(b: Uint8Array): StripReport {
  const removed: string[] = [];
  const kept: Uint8Array[] = [];
  let orientation = 0;
  let trivialExif = false;
  let vp8xFlags = -1;
  let i = 12;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, 4);
    const size = dv.getUint32(i + 4, true);
    const padded = size + (size & 1);
    const end = i + 8 + padded;
    if (size > b.length || i + 8 + size > b.length) break;
    if (fourcc === 'EXIF') {
      if (!removed.includes('Exif (EXIF chunk)')) removed.push('Exif (EXIF chunk)');
      const data = b.subarray(i + 8, i + 8 + size);
      const info = inspectTiff(ascii(data, 0, 4) === 'Exif' ? data.subarray(6) : data);
      orientation = info.orientation || orientation;
      trivialExif = info.onlyOrientation;
    } else if (fourcc === 'XMP ') {
      if (!removed.includes('XMP (XMP chunk)')) removed.push('XMP (XMP chunk)');
    } else {
      if (fourcc === 'VP8X' && size >= 1) vp8xFlags = kept.length;
      kept.push(b.subarray(i, Math.min(end, b.length)));
    }
    i = end;
  }

  if (nothingWorthRemoving(removed, 'Exif (EXIF chunk)', trivialExif)) {
    return { bytes: null, removed: [], orientation, reinjected: false };
  }

  const reinjected = orientation > 1;
  if (vp8xFlags >= 0) {
    const copy = new Uint8Array(kept[vp8xFlags]);
    copy[8] = (copy[8] & ~0x0c) | (reinjected ? 0x08 : 0);
    kept[vp8xFlags] = copy;
  }

  const parts: Uint8Array[] = [b.subarray(0, 12), ...kept];
  if (reinjected) {
    const tiff = makeOrientationTiff(orientation);
    const chunk = new Uint8Array(8 + tiff.length);
    const cdv = new DataView(chunk.buffer);
    chunk.set([0x45, 0x58, 0x49, 0x46], 0);
    cdv.setUint32(4, tiff.length, true);
    chunk.set(tiff, 8);
    parts.push(chunk);
  }
  if (i < b.length) parts.push(b.subarray(i));

  const out = concat(parts);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { bytes: out, removed, orientation, reinjected };
}

function describeRemoved(blocks: Blocks): string[] {
  const tiff = { ...asRecord(blocks.ifd0), ...asRecord(blocks.exif) };
  const iptc = asRecord(blocks.iptc);
  const xmp = xmpBlocksOf(blocks);
  const what: string[] = [];
  if (gpsCoords(blocks) || Object.keys(asRecord(blocks.gps)).length) what.push('GPS location');
  if (tiff.Make || tiff.Model || tiff.LensModel || tiff.LensMake) what.push('camera details');
  if (DATE_KEYS.some((k) => tiff[k] || iptc[k] || xmp.some((x) => x[k]))) what.push('date taken');
  if (tiff.Software || tiff.HostComputer) what.push('software');
  if (CAMERA_KEYS.some((k) => IDENTIFYING_KEYS.has(k) && tiff[k])) what.push('owner and serial number');
  if (Object.keys(iptc).length || xmp.length) what.push('IPTC and XMP tags');
  return what;
}

export async function stripImageMetadata(file: File): Promise<ConversionResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detect(bytes);
  const ext = (file.name.split('.').pop() ?? '').toUpperCase() || 'this';

  if (kind === 'other') {
    return {
      blob: file,
      filename: file.name,
      note: `Lossless metadata removal is not supported for ${ext} files, so the original is returned untouched. Only JPEG, PNG and WebP can be stripped without re-encoding the image.`,
      view: {
        kind: 'fields',
        groups: [
          {
            title: 'Not supported for this format',
            rows: [
              { label: 'File', value: file.name },
              { label: 'Reason', value: 'Metadata can only be cut out byte-for-byte from JPEG, PNG and WebP containers.', level: 'warn' },
              { label: 'Alternative', value: 'Convert the file to JPEG or PNG first, then remove metadata.' },
            ],
          },
        ],
      },
    };
  }

  const { blocks } = await readBlocks(file, bytes);
  const here = gpsCoords(blocks);

  const report = kind === 'jpeg' ? stripJpeg(bytes) : kind === 'png' ? stripPng(bytes) : stripWebp(bytes);

  if (!report.bytes) {
    return {
      blob: file,
      filename: file.name,
      note: `No metadata to remove. This ${CONTAINER_NAME[kind]} carries no Exif, GPS, IPTC or XMP data, so it is returned unchanged.`,
      view: {
        kind: 'fields',
        groups: [
          {
            title: 'Already clean',
            rows: [
              { label: 'File', value: file.name },
              { label: 'Metadata found', value: 'None' },
              { label: 'Action taken', value: 'None. The file was not modified.' },
            ],
          },
        ],
      },
    };
  }

  const out = report.bytes;
  const saved = bytes.length - out.length;
  const what = describeRemoved(blocks);
  const headline = what.length ? `Removed ${joinList(what)}.` : `Removed ${joinList(report.removed)}.`;
  const orientationLine = report.reinjected
    ? ` Orientation ${report.orientation} was kept so the photo still displays the right way up.`
    : '';
  const note = `${headline} Image data is byte-for-byte identical, nothing was re-encoded.${orientationLine} ${formatBytes(bytes.length)} to ${formatBytes(out.length)}.`;

  const removedRows: ViewRow[] = [];
  if (here) {
    removedRows.push({ label: 'GPS location', value: `${coord(here.lat)}, ${coord(here.lon)} (removed)`, level: 'alert' });
  }
  for (const item of what) {
    if (item === 'GPS location') continue;
    removedRows.push({ label: item.charAt(0).toUpperCase() + item.slice(1), value: 'Removed' });
  }
  if (here === null && what.includes('GPS location')) {
    removedRows.push({ label: 'GPS data', value: 'Removed', level: 'alert' });
  }
  removedRows.push({ label: 'Container blocks cut', value: report.removed.join(', ') });

  const resultRows: ViewRow[] = [
    { label: 'Image quality', value: 'Untouched. The compressed image data was copied byte-for-byte, not re-encoded.' },
    { label: 'Colour profile', value: 'Kept. Removing it would change how the photo looks.' },
    { label: 'Original size', value: `${formatBytes(bytes.length)} (${bytes.length} bytes)` },
    { label: 'New size', value: `${formatBytes(out.length)} (${out.length} bytes)` },
    { label: 'Bytes removed', value: `${saved} bytes` },
    {
      label: 'Orientation',
      value: report.reinjected
        ? `Kept (${report.orientation}). A minimal Exif block holding only the orientation tag was written back.`
        : report.orientation === 1
          ? 'Already upright, nothing to keep.'
          : 'Not present in the original.',
    },
  ];

  return {
    blob: new Blob([out.buffer as ArrayBuffer], { type: file.type || CONTAINER_MIME[kind] }),
    filename: addSuffix(file.name, '-clean'),
    note,
    view: {
      kind: 'fields',
      groups: [
        { title: 'Removed', rows: removedRows },
        { title: 'Result', rows: resultRows },
      ],
    },
  };
}

async function slice(file: File, start: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, start + len).arrayBuffer());
}

export async function hasMetadata(file: File): Promise<boolean> {
  if (file.size < 12) return false;
  const head = await slice(file, 0, 16);
  const kind = detect(head);

  if (kind === 'jpeg') {
    let i = 2;
    for (let guard = 0; guard < 128 && i + 4 <= file.size; guard++) {
      const h = await slice(file, i, 4);
      if (h[0] !== 0xff) return false;
      const marker = h[1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (h[2] << 8) | h[3];
      if (len < 2) return false;
      if (marker === 0xed || marker === 0xfe) return true;
      if (marker === 0xe1) {
        const seg = await slice(file, i + 4, Math.min(len - 2, 4096));
        if (ascii(seg, 0, 4) !== 'Exif') return true;
        if (!inspectTiff(seg.subarray(6)).onlyOrientation) return true;
      }
      i += 2 + len;
    }
    return false;
  }

  if (kind === 'png') {
    let i = 8;
    for (let guard = 0; guard < 512 && i + 8 <= file.size; guard++) {
      const h = await slice(file, i, 8);
      const len = new DataView(h.buffer).getUint32(0, false);
      const type = ascii(h, 4, 4);
      if (type === 'eXIf') {
        if (!inspectTiff(await slice(file, i + 8, Math.min(len, 4096))).onlyOrientation) return true;
      } else if (PNG_DROP[type]) {
        return true;
      }
      if (type === 'IEND') return false;
      i += 12 + len;
    }
    return false;
  }

  if (kind === 'webp') {
    let i = 12;
    for (let guard = 0; guard < 512 && i + 8 <= file.size; guard++) {
      const h = await slice(file, i, 8);
      const fourcc = ascii(h, 0, 4);
      const size = new DataView(h.buffer).getUint32(4, true);
      if (fourcc === 'XMP ') return true;
      if (fourcc === 'EXIF') {
        const data = await slice(file, i + 8, Math.min(size, 4096));
        const tiff = ascii(data, 0, 4) === 'Exif' ? data.subarray(6) : data;
        if (!inspectTiff(tiff).onlyOrientation) return true;
      }
      i += 8 + size + (size & 1);
    }
    return false;
  }

  return false;
}
