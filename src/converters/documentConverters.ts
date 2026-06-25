import type { ConversionResult } from './types';
import { replaceExt, wrapHtml } from '../lib/strings';

type BlockStyle = 'h1' | 'h2' | 'h3' | 'p';
interface Block {
  text: string;
  style: BlockStyle;
}

/* ----------------------------- DOCX ----------------------------- */
// We use mammoth's browser build directly; the package "main" pulls in Node's
// `fs` and won't bundle for the browser.

async function loadMammoth() {
  const mod: any = await import('mammoth/mammoth.browser');
  return mod.default ?? mod;
}

export async function docxToHtml(file: File): Promise<ConversionResult> {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.convertToHtml({ arrayBuffer });
  const html = wrapHtml(value, 'Converted from Word');
  return {
    blob: new Blob([html], { type: 'text/html;charset=utf-8' }),
    filename: replaceExt(file.name, 'html'),
  };
}

export async function docxToText(file: File): Promise<ConversionResult> {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return {
    blob: new Blob([value], { type: 'text/plain;charset=utf-8' }),
    filename: replaceExt(file.name, 'txt'),
  };
}

export async function docxToPdf(file: File): Promise<ConversionResult> {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  return blocksToPdf(htmlToBlocks(html), replaceExt(file.name, 'pdf'));
}

/* --------------------------- Markdown --------------------------- */

export async function markdownToHtml(file: File): Promise<ConversionResult> {
  const { marked } = await import('marked');
  const body = await marked.parse(await file.text());
  const html = wrapHtml(body as string, 'Converted from Markdown');
  return {
    blob: new Blob([html], { type: 'text/html;charset=utf-8' }),
    filename: replaceExt(file.name, 'html'),
  };
}

export async function markdownToPdf(file: File): Promise<ConversionResult> {
  const { marked } = await import('marked');
  const html = (await marked.parse(await file.text())) as string;
  return blocksToPdf(htmlToBlocks(html), replaceExt(file.name, 'pdf'));
}

/* ----------------------------- HTML ----------------------------- */

export async function htmlToPdf(file: File): Promise<ConversionResult> {
  const html = await file.text();
  return blocksToPdf(htmlToBlocks(html), replaceExt(file.name, 'pdf'));
}

/* ----------------------------- TXT ------------------------------ */

export async function txtToPdf(file: File): Promise<ConversionResult> {
  const text = await file.text();
  const blocks: Block[] = text.split(/\r?\n/).map((line) => ({ text: line || ' ', style: 'p' }));
  return blocksToPdf(blocks, replaceExt(file.name, 'pdf'));
}

/* -------------------------- shared core ------------------------- */

/** Turn an HTML string into an ordered list of heading/paragraph blocks. */
function htmlToBlocks(html: string): Block[] {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const blocks: Block[] = [];

  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();

      if (tag === 'h1') blocks.push({ text, style: 'h1' });
      else if (tag === 'h2') blocks.push({ text, style: 'h2' });
      else if (['h3', 'h4', 'h5', 'h6'].includes(tag)) blocks.push({ text, style: 'h3' });
      else if (tag === 'p' && text) blocks.push({ text, style: 'p' });
      else if (tag === 'li' && text) blocks.push({ text: `• ${text}`, style: 'p' });
      else if (tag === 'tr') {
        const cells = Array.from(child.querySelectorAll('td, th')).map((c) =>
          (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
        );
        if (cells.some(Boolean)) blocks.push({ text: cells.join('   |   '), style: 'p' });
      } else if (child.children.length > 0) {
        walk(child); // descend into containers (div, ul, table, etc.)
      } else if (text) {
        blocks.push({ text, style: 'p' });
      }
    }
  };

  walk(dom.body);
  if (blocks.length === 0) blocks.push({ text: '(Empty document)', style: 'p' });
  return blocks;
}

/** Render blocks into a paginated A4 PDF with selectable text via jsPDF. */
async function blocksToPdf(blocks: Block[], filename: string): Promise<ConversionResult> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const margin = 56;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;
  const sizes: Record<BlockStyle, number> = { h1: 22, h2: 17, h3: 14, p: 11 };

  let y = margin;
  for (const b of blocks) {
    const size = sizes[b.style];
    doc.setFontSize(size);
    doc.setFont('helvetica', b.style === 'p' ? 'normal' : 'bold');

    const lineHeight = size * 1.35;
    const lines = doc.splitTextToSize(b.text, maxW) as string[];
    for (const line of lines) {
      if (y + lineHeight > pageH - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    y += b.style === 'p' ? 4 : 8; // spacing after the block
  }

  return { blob: doc.output('blob'), filename };
}
