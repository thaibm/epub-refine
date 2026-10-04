import fs from 'node:fs';
import path from 'node:path';
import type { PdfExtractedPage, PdfExtractionResult, PdfLineItem } from './types.js';

export interface DigitalPdfParserOptions {
  startPage?: number;
  endPage?: number;
  extractCoverPath?: string;
  onProgress?: (current: number, total: number) => void;
}

interface RawTextItem {
  str: string;
  x: number;
  y: number; // PDF coordinates: origin at bottom-left
  w: number;
  h: number;
  fontSize: number;
}

/**
 * Trích xuất text layer và toạ độ đối với tài liệu PDF kỹ thuật số (PDF Docs)
 */
export async function parseDigitalPdf(
  pdfPath: string,
  options: DigitalPdfParserOptions = {}
): Promise<PdfExtractionResult> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const absPdfPath = path.resolve(pdfPath);
  const data = new Uint8Array(await fs.promises.readFile(absPdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const totalPages = doc.numPages;
  const startPage = Math.max(1, options.startPage || 1);
  const endPage = Math.min(totalPages, options.endPage || totalPages);

  const pages: PdfExtractedPage[] = [];

  for (let p = startPage; p <= endPage; p++) {
    if (options.onProgress) {
      options.onProgress(p, totalPages);
    }

    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    const rawItems: RawTextItem[] = [];

    for (const item of textContent.items as any[]) {
      if (!item.str || item.str.trim() === '') continue;

      // item.transform: [scaleX, skewY, skewX, scaleY, tx, ty]
      const tx = item.transform[4];
      const ty = item.transform[5];
      const fontSize = Math.hypot(item.transform[0], item.transform[1]) || item.height || 12;

      rawItems.push({
        str: item.str,
        x: tx,
        y: ty,
        w: item.width || 0,
        h: item.height || fontSize,
        fontSize: Math.round(fontSize * 10) / 10
      });
    }

    // Nhóm các phần tử cùng dòng (chênh lệch y < 4pt)
    const lineBuckets: { y: number; items: RawTextItem[] }[] = [];
    for (const it of rawItems) {
      const bucket = lineBuckets.find((b) => Math.abs(b.y - it.y) < 3.5);
      if (bucket) {
        bucket.items.push(it);
      } else {
        lineBuckets.push({ y: it.y, items: [it] });
      }
    }

    // Sắp xếp các dòng từ trên xuống dưới (y lớn ở trên trong toạ độ PDF)
    lineBuckets.sort((a, b) => b.y - a.y);

    const lines: PdfLineItem[] = [];
    for (const b of lineBuckets) {
      // Sắp xếp từ trái sang phải
      b.items.sort((a, b) => a.x - b.x);
      const text = b.items.map((i) => i.str).join(' ').trim();
      if (!text) continue;

      const minX = Math.min(...b.items.map((i) => i.x));
      const maxX = Math.max(...b.items.map((i) => i.x + i.w));
      const avgFontSize = b.items.reduce((s, i) => s + i.fontSize, 0) / b.items.length;

      // Bounding box chuẩn hoá (0 -> 1)
      const normBbox = {
        x: Math.max(0, minX / viewport.width),
        y: Math.max(0, b.y / viewport.height),
        w: Math.min(1, (maxX - minX) / viewport.width),
        h: Math.min(1, avgFontSize / viewport.height)
      };

      lines.push({
        text,
        bbox: normBbox,
        fontSize: avgFontSize,
        confidence: 1.0
      });
    }

    pages.push({
      pageNumber: p,
      lines,
      rawText: lines.map((l) => l.text).join('\n')
    });
  }

  const fileName = path.basename(absPdfPath);
  const baseName = path.basename(fileName, path.extname(fileName));

  return {
    totalPages,
    pages,
    sourcePdfPath: absPdfPath,
    fileName,
    baseName,
    pdfType: 'digital'
  };
}
