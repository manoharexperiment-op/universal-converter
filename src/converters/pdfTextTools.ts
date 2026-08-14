import type { PDFDocument as PDFDocumentType, PDFField, PDFFont, PDFForm } from 'pdf-lib';
import type { ConversionResult, ParamControl, ParamValues, ProgressFn, ViewRow } from './types';
import { asPlacement } from './types';
import { addSuffix } from '../lib/strings';
import type { TextStamp } from './pdfStamp';
import { makeTextStamp, placeOnPage, visibleSize } from './pdfStamp';
import { blobBytes } from '../lib/bytes';

const COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  red: [0.78, 0.11, 0.11],
  blue: [0.09, 0.24, 0.7],
  green: [0.05, 0.42, 0.2],
  gray: [0.45, 0.45, 0.45],
  white: [1, 1, 1],
};

/** Controls for the "Add text" action. `size` of 'fit' scales the text to the box. */
export const addTextControls: ParamControl[] = [
  { kind: 'text', key: 'text', label: 'Text', default: '', placeholder: 'Type what to put on the page' },
  {
    kind: 'select',
    key: 'size',
    label: 'Size',
    default: 'fit',
    options: [
      { value: 'fit', label: 'Fit the box' },
      { value: '8', label: '8 pt' },
      { value: '10', label: '10 pt' },
      { value: '12', label: '12 pt' },
      { value: '14', label: '14 pt' },
      { value: '18', label: '18 pt' },
      { value: '24', label: '24 pt' },
      { value: '36', label: '36 pt' },
      { value: '48', label: '48 pt' },
    ],
  },
  {
    kind: 'select',
    key: 'color',
    label: 'Colour',
    default: 'black',
    options: [
      { value: 'black', label: 'Black' },
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
      { value: 'green', label: 'Green' },
      { value: 'gray', label: 'Grey' },
      { value: 'white', label: 'White' },
    ],
  },
  {
    kind: 'select',
    key: 'weight',
    label: 'Weight',
    default: 'regular',
    options: [
      { value: 'regular', label: 'Regular' },
      { value: 'bold', label: 'Bold' },
    ],
  },
  { kind: 'placement', key: 'placement', label: 'Position', default: { x: 0.1, y: 0.1, w: 0.4, page: 1 }, imageKey: 'text' },
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadPdf(file: File): Promise<PDFDocumentType> {
  const { PDFDocument } = await import('pdf-lib');
  try {
    return await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    if (/encrypted/i.test(errText(e))) throw new Error('This PDF is password protected. Remove the password first, then try again.');
    throw e;
  }
}

// Mirrors pdfStamp's rasterizer (96px em, 2px pad) so that for rasterized text the
// baseline we compute puts the image's top edge exactly on the box's top edge.
const PROBE_EM = 96;
const PROBE_PAD = 2;

async function probeFont(doc: PDFDocumentType, bold: boolean): Promise<PDFFont | null> {
  const { StandardFonts } = await import('pdf-lib');
  try {
    return doc.embedStandardFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  } catch {
    return null;
  }
}

/**
 * Width of one line at 1 pt. pdf-lib's widthOfTextAtSize subtracts AFM kerning
 * pairs, but drawText emits a plain Tj that never applies them, so a kerned
 * Latin string renders up to ~7% wider than the stamp reports. Measuring one
 * character at a time leaves no pairs to kern, which is what actually gets drawn.
 */
function widthPerPt(line: string, stamp: TextStamp, probe: PDFFont | null): number {
  if (stamp.rasterized || !probe) return stamp.widthAt(1);
  try {
    let w = 0;
    for (const ch of line) w += probe.widthOfTextAtSize(ch, 1);
    return w;
  } catch {
    return stamp.widthAt(1);
  }
}

function ascentEm(text: string, bold: boolean): number {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 0.75;
  ctx.font = `${bold ? 'bold ' : ''}${PROBE_EM}px sans-serif`;
  const a = Math.abs(ctx.measureText(text).actualBoundingBoxAscent || 0);
  if (!a) return 0.75;
  return (Math.ceil(a) + PROBE_PAD) / PROBE_EM;
}

/** Draw arbitrary text into a dragged box on one PDF page (pdf-lib). */
export async function addTextToPdf(file: File, onProgress?: ProgressFn, params?: ParamValues): Promise<ConversionResult> {
  const lines = String(params?.text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('Type the text you want to add first.');

  const place = asPlacement(params?.placement);
  const color = COLORS[String(params?.color ?? 'black')] ?? COLORS.black;
  const bold = String(params?.weight ?? 'regular') === 'bold';
  const wanted = Number(params?.size);

  onProgress?.(0.05);
  const doc = await loadPdf(file);
  const pages = doc.getPages();
  const pageNo = Math.min(Math.max(1, Math.round(place.page || 1)), pages.length);
  const page = pages[pageNo - 1];
  const { vw, vh } = visibleSize(page);

  const stamps: TextStamp[] = [];
  for (const line of lines) stamps.push(await makeTextStamp(doc, line, { color, bold }));
  onProgress?.(0.6);

  const probe = stamps.some((s) => !s.rasterized) ? await probeFont(doc, bold) : null;
  const unit = Math.max(...lines.map((l, i) => widthPerPt(l, stamps[i], probe)), 0.0001);
  const boxW = Math.max(0.01, place.w) * vw;
  const size = wanted > 0 ? wanted : Math.min(vh, Math.max(4, boxW / unit));
  const asc = Math.max(...lines.map((l) => ascentEm(l, bold)));

  let top = place.y * vh;
  for (const stamp of stamps) {
    const g = placeOnPage(page, { x: place.x, y: (top + asc * size) / vh, w: 0 }, 0);
    stamp.draw(page, { x: g.x, y: g.y, size, rotateDeg: g.rotateDeg });
    top += size * 1.25;
  }

  const out = await doc.save();
  onProgress?.(1);
  const raster = stamps.some((s) => s.rasterized);
  return {
    blob: new Blob([blobBytes(out)], { type: 'application/pdf' }),
    filename: addSuffix(file.name, '-text'),
    note: `Added text to page ${pageNo} at ${Math.round(size)} pt.${raster ? ' Non-Latin characters were drawn as an image, so that text will not be selectable or searchable.' : ''}`,
  };
}

export interface PdfFormField {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'options';
  value: string;
  options?: string[];
}

const XFA_MSG =
  'This is an XFA (dynamic LiveCycle) form. Its fields live in an XML layer that cannot be filled here, only in Adobe Acrobat Reader. Ask the sender for a standard AcroForm version, or use "Add text to PDF" to type onto the page.';
const XFA_HYBRID_MSG =
  'This PDF also carries an XFA layer, which has to be dropped to fill the fields. The values below will be saved, but Adobe Acrobat may lay the page out differently afterwards. Flatten the result to be safe.';
const NO_FIELDS_MSG = 'This PDF has no fillable form fields. Use "Add text to PDF" to type onto the page instead.';

// getForm() silently strips XFA in pdf-lib 1.17.1, so form.hasXFA() is always
// false by the time we could ask it. Read the catalog before touching the form.
async function hasXfa(doc: PDFDocumentType): Promise<boolean> {
  const { PDFName, PDFDict } = await import('pdf-lib');
  try {
    return !!doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'));
  } catch {
    return false;
  }
}

async function readFields(form: PDFForm): Promise<PdfFormField[]> {
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = await import('pdf-lib');
  const out: PdfFormField[] = [];
  for (const f of form.getFields()) {
    let name = '';
    try {
      name = f.getName();
    } catch {
      continue;
    }
    if (!name) continue;
    try {
      if (f instanceof PDFTextField) out.push({ name, type: 'text', value: f.getText() ?? '' });
      else if (f instanceof PDFCheckBox) out.push({ name, type: 'checkbox', value: f.isChecked() ? 'yes' : 'no' });
      else if (f instanceof PDFRadioGroup) out.push({ name, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions() });
      else if (f instanceof PDFDropdown) out.push({ name, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() });
      else if (f instanceof PDFOptionList) out.push({ name, type: 'options', value: f.getSelected().join(', '), options: f.getOptions() });
    } catch {
      /* one unreadable field must not hide the rest of the form */
    }
  }
  return out;
}

/** List a PDF's form fields with their current values, so the UI can prefill. */
export async function inspectPdfForm(file: File): Promise<{ fields: PdfFormField[]; message?: string }> {
  let doc: PDFDocumentType;
  try {
    doc = await loadPdf(file);
  } catch (e) {
    return { fields: [], message: errText(e) };
  }

  const xfa = await hasXfa(doc);

  let form: PDFForm;
  try {
    form = doc.getForm();
  } catch (e) {
    return { fields: [], message: xfa ? XFA_MSG : `The form in this PDF could not be read: ${errText(e)}` };
  }

  let fields: PdfFormField[];
  try {
    fields = await readFields(form);
  } catch (e) {
    return { fields: [], message: xfa ? XFA_MSG : `The form in this PDF could not be read: ${errText(e)}` };
  }

  if (!fields.length) return { fields: [], message: xfa ? XFA_MSG : NO_FIELDS_MSG };
  return xfa ? { fields, message: XFA_HYBRID_MSG } : { fields };
}

function truthy(v: string): boolean {
  return ['yes', 'true', 'on', '1', 'checked'].includes(v.trim().toLowerCase());
}

/** Regenerate one field's appearance so an encoding failure names the field that caused it. */
function refreshAppearance(field: PDFField, font: PDFFont): void {
  if (field.needsAppearancesUpdate()) field.defaultUpdateAppearances(font);
}

async function applyValues(
  form: PDFForm,
  params: ParamValues,
): Promise<{ filled: ViewRow[]; failed: string[]; unencodable: boolean }> {
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = await import('pdf-lib');
  const font = form.getDefaultFont();
  const filled: ViewRow[] = [];
  const failed: string[] = [];
  let unencodable = false;
  const reject = (name: string, e: unknown) => {
    if (/cannot encode/i.test(errText(e))) unencodable = true;
    failed.push(name);
    filled.push({ label: name, value: `not filled (${errText(e).slice(0, 80)})`, level: 'warn' });
  };

  for (const field of form.getFields()) {
    let name = '';
    try {
      name = field.getName();
    } catch {
      continue;
    }
    const supplied = params[name];
    if (supplied === undefined) {
      try {
        refreshAppearance(field, font);
      } catch {
        form.markFieldAsClean(field.ref);
      }
      continue;
    }
    const value = String(supplied);

    try {
      if (field instanceof PDFTextField) {
        const before = field.getText();
        try {
          field.setText(value || undefined);
          refreshAppearance(field, font);
        } catch (e) {
          field.setText(before);
          try {
            refreshAppearance(field, font);
          } catch {
            form.markFieldAsClean(field.ref);
          }
          reject(name, e);
          continue;
        }
        filled.push({ label: name, value: value || '(cleared)' });
      } else if (field instanceof PDFCheckBox) {
        if (truthy(value)) field.check();
        else field.uncheck();
        refreshAppearance(field, font);
        filled.push({ label: name, value: truthy(value) ? 'checked' : 'unchecked' });
      } else if (field instanceof PDFRadioGroup) {
        if (!value) field.clear();
        else field.select(value);
        refreshAppearance(field, font);
        filled.push({ label: name, value: value || '(cleared)' });
      } else if (field instanceof PDFDropdown) {
        if (!value) field.clear();
        else field.select(value);
        refreshAppearance(field, font);
        filled.push({ label: name, value: value || '(cleared)' });
      } else if (field instanceof PDFOptionList) {
        const picked = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!picked.length) field.clear();
        else field.select(picked);
        refreshAppearance(field, font);
        filled.push({ label: name, value: picked.join(', ') || '(cleared)' });
      }
    } catch (e) {
      reject(name, e);
      form.markFieldAsClean(field.ref);
    }
  }

  return { filled, failed, unencodable };
}

/**
 * Flatten a copy of the already-filled bytes rather than the live document:
 * flatten() rewrites pages as it goes, so a throw part-way through would leave
 * the document half-flattened and there would be nothing safe to fall back to.
 */
async function flattenBytes(bytes: Uint8Array): Promise<{ bytes: Uint8Array; problem?: string }> {
  const { PDFDocument } = await import('pdf-lib');
  try {
    const doc = await PDFDocument.load(bytes);
    doc.getForm().flatten();
    return { bytes: await doc.save({ updateFieldAppearances: false }) };
  } catch (e) {
    return { bytes, problem: errText(e) };
  }
}

/** Fill a PDF's form fields from params keyed by field name. `__flatten: 'yes'` locks them. */
export async function fillPdfForm(file: File, onProgress?: ProgressFn, params?: ParamValues): Promise<ConversionResult> {
  const p = params ?? {};
  onProgress?.(0.05);
  const doc = await loadPdf(file);

  const xfa = await hasXfa(doc);

  let form: PDFForm;
  try {
    form = doc.getForm();
  } catch (e) {
    throw new Error(`The form in this PDF could not be read: ${errText(e)}`);
  }
  if (!form.getFields().length) {
    return { blob: file, filename: file.name, note: xfa ? XFA_MSG : NO_FIELDS_MSG };
  }

  const { filled, failed, unencodable } = await applyValues(form, p);
  onProgress?.(0.6);

  let bytes = await doc.save({ updateFieldAppearances: false });
  const notes: string[] = [];

  if (String(p.__flatten ?? 'no') === 'yes') {
    const res = await flattenBytes(bytes);
    bytes = res.bytes;
    if (res.problem) notes.push(`The values are saved, but the form could not be flattened (${res.problem}), so the fields stay editable.`);
    else notes.push('Fields were flattened, so the values are now part of the page and can no longer be edited.');
  }

  if (failed.length) {
    notes.push(`${failed.length} field${failed.length === 1 ? '' : 's'} could not be filled (${failed.join(', ')}).`);
    if (unencodable) {
      notes.push(
        'PDF form fields can only use the built-in Helvetica font, which covers the Latin alphabet alone, so the rupee sign, Hindi and other non-Latin text cannot go into a form field. Use "Add text to PDF" for those.',
      );
    }
  }

  if (xfa) notes.push(XFA_HYBRID_MSG);

  const done = filled.filter((r) => r.level !== 'warn').length;
  notes.unshift(`Filled ${done} of ${filled.length} field${filled.length === 1 ? '' : 's'}.`);
  onProgress?.(1);

  return {
    blob: new Blob([blobBytes(bytes)], { type: 'application/pdf' }),
    filename: addSuffix(file.name, '-filled'),
    note: notes.join(' '),
    view: filled.length ? { kind: 'fields', groups: [{ title: 'Form fields', rows: filled }] } : undefined,
  };
}
