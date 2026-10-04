import type { PdfExtractedPage, PdfLineItem, PdfBatchChunk } from './types.js';

/**
 * Phân tích và lọc bỏ running headers (tiêu đề đầu trang), running footers (chân trang),
 * và số trang lặp lại dựa trên toạ độ bounding box và tần suất xuất hiện.
 */
export function removeHeadersAndFooters(pages: PdfExtractedPage[]): PdfExtractedPage[] {
  if (pages.length === 0) return [];

  // 1. Thống kê tần suất các dòng văn bản ở vùng đỉnh (top y > 0.88) và vùng đáy (bottom y < 0.10)
  const topTextCounts = new Map<string, number>();
  const bottomTextCounts = new Map<string, number>();

  for (const page of pages) {
    for (const line of page.lines) {
      const textNorm = line.text.trim().toLowerCase();
      if (!textNorm) continue;

      if (line.bbox) {
        if (line.bbox.y >= 0.88) {
          topTextCounts.set(textNorm, (topTextCounts.get(textNorm) || 0) + 1);
        } else if (line.bbox.y <= 0.10) {
          bottomTextCounts.set(textNorm, (bottomTextCounts.get(textNorm) || 0) + 1);
        }
      }
    }
  }

  // Các cụm từ xuất hiện lặp lại trên >= 2 trang ở vùng mép trang
  const isRepeatedHeader = (text: string, y?: number) => {
    if (y === undefined) return false;
    const textNorm = text.trim().toLowerCase();
    const count = topTextCounts.get(textNorm) || 0;
    return y >= 0.88 && count >= 2;
  };

  const isRepeatedFooter = (text: string, y?: number) => {
    if (y === undefined) return false;
    const textNorm = text.trim().toLowerCase();
    const count = bottomTextCounts.get(textNorm) || 0;
    return y <= 0.10 && count >= 2;
  };

  // Pattern nhận diện số trang dạng: "Trang 12", "12", "- 12 -", "Page 12", "12 / 150"
  const PAGE_NUMBER_REGEX = /^(?:trang\s*|\-|\bpage\s*)?\d+(?:\s*\/\s*\d+)?(?:\s*\-)?$/i;

  return pages.map((page) => {
    const cleanedLines = page.lines.filter((line) => {
      const text = line.text.trim();
      if (!text) return false;

      const y = line.bbox?.y;

      // 1. Lọc số trang ở vùng đỉnh hoặc vùng đáy
      if (y !== undefined) {
        if ((y >= 0.90 || y <= 0.09) && PAGE_NUMBER_REGEX.test(text)) {
          return false;
        }

        // 2. Lọc running headers/footers lặp lại
        if (isRepeatedHeader(text, y) || isRepeatedFooter(text, y)) {
          return false;
        }

        // 3. Lọc các dòng quá sát mép trên hoặc mép dưới (< 0.05 hoặc > 0.94) nếu độ dài ngắn (< 35 ký tự)
        if ((y >= 0.935 || y <= 0.065) && text.length < 35 && !text.endsWith('.')) {
          return false;
        }
      } else {
        // Fallback nếu không có bbox
        if (PAGE_NUMBER_REGEX.test(text)) {
          return false;
        }
      }

      return true;
    });

    return {
      ...page,
      lines: cleanedLines,
      rawText: cleanedLines.map((l) => l.text).join('\n')
    };
  });
}

/**
 * Nối dòng văn bản thông minh (Smart Paragraph Reflow):
 * - Nối từ bị đứt quãng bởi dấu gạch nối cuối dòng: "nông-" + "nghiệp" -> "nông nghiệp"
 * - Nối các dòng thuộc cùng một đoạn văn thành một dòng liền mạch
 * - Giữ nguyên ngắt đoạn khi gặp dấu chấm câu hoặc dòng tiêu đề
 */
export function reflowPageLines(lines: PdfLineItem[]): string {
  if (lines.length === 0) return '';

  const paragraphs: string[] = [];
  let currentPara: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let text = line.text.trim();
    if (!text) continue;

    // Kiểm tra gạch nối cuối dòng
    const hasHyphen = text.endsWith('-') || text.endsWith('–');
    if (hasHyphen) {
      text = text.slice(0, -1).trim();
    }

    currentPara.push(text);

    // Xác định xem dòng này có phải kết thúc một đoạn văn / tiêu đề không:
    const isHeadingLike =
      text.length < 50 &&
      !text.endsWith(',') &&
      !text.endsWith(';') &&
      /^(?:chương|phần|bài|mục|tiết|\d+\.|\bquẻ\b|[A-ZÀ-Ỹ0-9\s]{4,}$)/i.test(text);

    const isSentenceEnd = /[.!?:…"”»]\s*$/.test(text);
    const isLastLine = i === lines.length - 1;

    // Nếu có dấu ngắt câu hoặc là tiêu đề hoặc có khoảng cách dòng lớn với dòng kế tiếp
    let isParagraphBreak = isHeadingLike || isSentenceEnd || isLastLine;

    // Nếu dòng kết thúc bằng dấu gạch nối, chắc chắn không phải ngắt đoạn
    if (hasHyphen) {
      isParagraphBreak = false;
    }

    if (isParagraphBreak) {
      paragraphs.push(currentPara.join(' '));
      currentPara = [];
    }
  }

  if (currentPara.length > 0) {
    paragraphs.push(currentPara.join(' '));
  }

  return paragraphs.join('\n\n');
}

/**
 * Gom các trang đã reflow thành các batch để gửi qua Gemini API
 */
export function chunkPagesIntoBatches(
  pages: PdfExtractedPage[],
  targetWordsPerBatch = 3500
): PdfBatchChunk[] {
  const batches: PdfBatchChunk[] = [];
  let currentPages: PdfExtractedPage[] = [];
  let currentWordCount = 0;
  let batchIndex = 1;

  for (const page of pages) {
    const pageReflowed = reflowPageLines(page.lines);
    const words = pageReflowed.split(/\s+/).filter(Boolean).length;

    currentPages.push({
      ...page,
      rawText: pageReflowed
    });
    currentWordCount += words;

    // Khi batch đạt khoảng 3500 từ hoặc đã gom được từ 10-15 trang
    if (currentWordCount >= targetWordsPerBatch || currentPages.length >= 15) {
      const startPage = currentPages[0].pageNumber;
      const endPage = currentPages[currentPages.length - 1].pageNumber;
      const content = currentPages
        .map((p) => `<!-- PAGE: ${p.pageNumber} -->\n${p.rawText}`)
        .join('\n\n');

      batches.push({
        batchIndex: batchIndex++,
        startPage,
        endPage,
        content
      });

      currentPages = [];
      currentWordCount = 0;
    }
  }

  if (currentPages.length > 0) {
    const startPage = currentPages[0].pageNumber;
    const endPage = currentPages[currentPages.length - 1].pageNumber;
    const content = currentPages
      .map((p) => `<!-- PAGE: ${p.pageNumber} -->\n${p.rawText}`)
      .join('\n\n');

    batches.push({
      batchIndex: batchIndex++,
      startPage,
      endPage,
      content
    });
  }

  return batches;
}
