import type { ConversionResult } from './types';
import { replaceExt } from '../lib/strings';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel (.xlsx) -> CSV. Exports the first worksheet. */
export async function xlsxToCsv(file: File): Promise<ConversionResult> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) throw new Error('The spreadsheet has no sheets.');
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets[firstSheet]);
  return {
    blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    filename: replaceExt(file.name, 'csv'),
  };
}

/** CSV -> Excel (.xlsx). */
export async function csvToXlsx(file: File): Promise<ConversionResult> {
  const XLSX = await import('xlsx');
  // XLSX.read parses CSV text directly into a workbook.
  const wb = XLSX.read(await file.text(), { type: 'string' });
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return {
    blob: new Blob([out], { type: XLSX_MIME }),
    filename: replaceExt(file.name, 'xlsx'),
  };
}
