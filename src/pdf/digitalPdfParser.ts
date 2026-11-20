import fs from 'node:fs';
import path from 'node:path';
import type {
  PdfDigitalExtraction,
  PdfDigitalLine,
  PdfDigitalPage,
  PdfLinkAnnotation,
  PdfOutlineNode,
  PdfTextSpan
} from './types.js';

export interface DigitalPdfParserOptions {
  onProgress?: (current: number, total: number) => void;
}

const LINE_TOLERANCE = 3.5;
const WORD_GAP_RATIO = 0.18;

interface RawItem extends PdfTextSpan {
  y: number;
}

/**
 * Đọc toàn bộ tài liệu PDF số: text kèm font và toạ độ, bookmark, link nội bộ và metadata.
 * Luôn đọc đủ mọi trang vì mục lục có thể nằm ngoài khoảng trang người dùng chọn.
 */
export async function parseDigitalPdf(
  pdfPath: string,
  options: DigitalPdfParserOptions = {}
): Promise<PdfDigitalExtraction> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const absPdfPath = path.resolve(pdfPath);
  const data = new Uint8Array(await fs.promises.readFile(absPdfPath));
  const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;

  const totalPages = doc.numPages;
  const imageOps = new Set<number>([
    pdfjsLib.OPS.paintImageXObject,
    pdfjsLib.OPS.paintInlineImageXObject,
    pdfjsLib.OPS.paintImageMaskXObject
  ]);

  const resolveDest = async (dest: unknown): Promise<{ page: number; y: number } | null> => {
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit[0]) return null;
      const page = (await doc.getPageIndex(explicit[0])) + 1;
      const fit = explicit[1]?.name;
      const rawY = fit === 'XYZ' ? explicit[3] : fit === 'FitH' || fit === 'FitBH' ? explicit[2] : null;
      return { page, y: typeof rawY === 'number' ? rawY : Number.POSITIVE_INFINITY };
    } catch {
      return null;
    }
  };

  const pages: PdfDigitalPage[] = [];
  const links: PdfLinkAnnotation[] = [];

  for (let p = 1; p <= totalPages; p++) {
    options.onProgress?.(p, totalPages);

    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    // getOperatorList nạp font vào commonObjs để đọc được tên font thật (đậm/nghiêng)
    const operators = await page.getOperatorList();
    const textContent = await page.getTextContent();
    const imageCount = operators.fnArray.filter((op: number) => imageOps.has(op)).length;

    const fontStyle = (fontName: string): { bold: boolean; italic: boolean } => {
      try {
        const font = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; italic?: boolean };
        const name = font.name || '';
        return {
          bold: Boolean(font.bold) || /bold|black|heavy/i.test(name),
          italic: Boolean(font.italic) || /italic|oblique/i.test(name)
        };
      } catch {
        return { bold: false, italic: false };
      }
    };

    const rawItems: RawItem[] = [];
    for (const item of textContent.items as any[]) {
      if (!item.str || item.str.trim() === '') continue;
      const fontSize = Math.hypot(item.transform[0], item.transform[1]) || item.height || 12;
      rawItems.push({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        fontSize: Math.round(fontSize * 10) / 10,
        ...fontStyle(item.fontName)
      });
    }

    const lines = groupIntoLines(rawItems, p, viewport.width, viewport.height);
    pages.push({
      pageNumber: p,
      lines,
      rawText: lines.map((l) => l.text).join('\n'),
      width: viewport.width,
      height: viewport.height,
      imageCount
    });

    for (const annotation of (await page.getAnnotations()) as any[]) {
      if (annotation.subtype !== 'Link' || !annotation.dest) continue;
      const target = await resolveDest(annotation.dest);
      if (!target) continue;
      links.push({
        page: p,
        rect: annotation.rect as [number, number, number, number],
        targetPage: target.page,
        targetY: target.y
      });
    }
  }

  const outline: PdfOutlineNode[] = [];
  const walkOutline = async (items: any[] | null, depth: number): Promise<void> => {
    for (const item of items || []) {
      const target = await resolveDest(item.dest);
      if (target && item.title?.trim()) {
        outline.push({ title: item.title.trim(), depth, page: target.page, y: target.y });
      }
      await walkOutline(item.items, depth + 1);
    }
  };
  await walkOutline(await doc.getOutline(), 0);

  const metadata = (await doc.getMetadata()).info as { Title?: string; Author?: string };
  const fileName = path.basename(absPdfPath);

  return {
    totalPages,
    pages,
    sourcePdfPath: absPdfPath,
    fileName,
    baseName: path.basename(fileName, path.extname(fileName)),
    pdfType: 'digital',
    outline,
    links,
    info: { title: metadata.Title?.trim() || undefined, author: metadata.Author?.trim() || undefined }
  };
}

function groupIntoLines(
  items: RawItem[],
  pageNumber: number,
  pageWidth: number,
  pageHeight: number
): PdfDigitalLine[] {
  const buckets: { y: number; items: RawItem[] }[] = [];
  for (const item of items) {
    const bucket = buckets.find((b) => Math.abs(b.y - item.y) < LINE_TOLERANCE);
    if (bucket) bucket.items.push(item);
    else buckets.push({ y: item.y, items: [item] });
  }
  buckets.sort((a, b) => b.y - a.y);

  const lines: PdfDigitalLine[] = [];
  for (const bucket of buckets) {
    bucket.items.sort((a, b) => a.x - b.x);
    const spans = joinSpans(bucket.items);
    const text = spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const first = bucket.items[0];
    const last = bucket.items[bucket.items.length - 1];
    const xEnd = last.x + last.width;
    const totalChars = spans.reduce((sum, s) => sum + s.text.length, 0);
    const boldChars = spans.filter((s) => s.bold).reduce((sum, s) => sum + s.text.length, 0);
    const fontSize = Math.max(...bucket.items.map((i) => i.fontSize));

    lines.push({
      text,
      pageNumber,
      x: first.x,
      xEnd,
      baseline: bucket.y,
      fontSize,
      spans,
      boldRatio: totalChars ? boldChars / totalChars : 0,
      confidence: 1,
      bbox: {
        x: Math.max(0, first.x / pageWidth),
        y: Math.max(0, bucket.y / pageHeight),
        w: Math.min(1, (xEnd - first.x) / pageWidth),
        h: Math.min(1, fontSize / pageHeight)
      }
    });
  }
  return lines;
}

/** Ghép các phần tử trên một dòng, chỉ thêm khoảng trắng khi trên trang thực sự có khoảng cách */
function joinSpans(items: RawItem[]): PdfTextSpan[] {
  const spans: PdfTextSpan[] = [];
  let previous: RawItem | null = null;

  for (const item of items) {
    let text = item.text;
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const hasSpace = /\s$/.test(previous.text) || /^\s/.test(text);
      if (!hasSpace && gap > item.fontSize * WORD_GAP_RATIO) text = ` ${text}`;
    }

    const last = spans[spans.length - 1];
    if (last && last.bold === item.bold && last.italic === item.italic) {
      last.text += text;
      last.width = item.x + item.width - last.x;
    } else {
      const { y: _y, ...span } = item;
      spans.push({ ...span, text });
    }
    previous = item;
  }
  return spans;
}
