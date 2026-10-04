import fs from 'node:fs';
import type { PdfClassificationResult, PdfType } from './types.js';

/**
 * Phân loại file PDF là dạng Scan (ảnh) hay Docs (văn bản số có text layer)
 */
export async function classifyPdf(pdfPath: string): Promise<PdfClassificationResult> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const totalPages = doc.numPages;
  if (totalPages === 0) {
    return {
      type: 'scanned',
      totalPages: 0,
      sampleAvgCharsPerPage: 0,
      sampleDetails: 'Tài liệu PDF không có trang nào.'
    };
  }

  // Chọn mẫu 5-8 trang phân bổ đều trong tài liệu (tránh trang bìa 1 vì bìa thường ít chữ)
  const samplePageIndices: number[] = [];
  const maxSamples = Math.min(6, totalPages);
  
  if (totalPages <= 6) {
    for (let i = 1; i <= totalPages; i++) samplePageIndices.push(i);
  } else {
    // Phân bổ đều giữa trang 2 và trang (totalPages - 1)
    const step = Math.max(1, Math.floor((totalPages - 2) / maxSamples));
    for (let p = 2; p < totalPages && samplePageIndices.length < maxSamples; p += step) {
      samplePageIndices.push(p);
    }
    if (samplePageIndices.length === 0) samplePageIndices.push(1);
  }

  let totalChars = 0;
  let totalItems = 0;

  for (const pageNum of samplePageIndices) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageChars = textContent.items
      .map((item: any) => item.str || '')
      .join(' ')
      .trim().length;

    totalChars += pageChars;
    totalItems += textContent.items.length;
  }

  const avgCharsPerPage = totalChars / samplePageIndices.length;
  const isDigital = avgCharsPerPage >= 60;
  const type: PdfType = isDigital ? 'digital' : 'scanned';

  return {
    type,
    totalPages,
    sampleAvgCharsPerPage: Math.round(avgCharsPerPage),
    sampleDetails: `Kiểm tra ${samplePageIndices.length} trang mẫu (Trang: ${samplePageIndices.join(', ')}): Trung bình ${Math.round(avgCharsPerPage)} ký tự/trang (${totalItems} text objects).`
  };
}
