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

function isAllCapsHeading(text: string): boolean {
  if (text.length >= 60 || text.length < 3) return false;
  const hasLower = /[a-zà-ỹ]/.test(text);
  const hasUpper = /[A-ZÀ-Ỹ]/.test(text);
  return !hasLower && hasUpper;
}

function isHeadingLine(text: string): boolean {
  if (text.length > 70) return false;
  if (text.endsWith(',') || text.endsWith(';')) return false;
  if (isAllCapsHeading(text)) return true;
  if (/^(?:chương|phần|hồi|tiết|mục|quyển|tập|quẻ)\s+([0-9]+|[ivxlcdm]+|thứ\s+\w+|một|hai|ba|nhất|nhì|tam|tứ)\b/i.test(text)) return true;
  if (/^[IVXLCDM]+\b(\s*[-:–—.]|\s*$)/i.test(text)) return true;
  return false;
}

function isSentenceEnd(text: string): boolean {
  if (/(?:v\.v|nxb|gs|ts|ths|bs|tp|vn|đh|th|tt|trg|tr)\.\s*$/i.test(text)) return false;
  if (/\b[A-ZÀ-Ỹ]\.\s*$/.test(text)) return false;
  return /[.!?:…"”»)]\s*$/.test(text);
}

/**
 * Nối dòng văn bản thông minh (Smart Paragraph Reflow):
 * - Chỉ những câu/đoạn kết thúc bằng dấu ngắt câu (. ! ? : …) mới thực sự là xuống dòng
 * - Nối từ bị đứt quãng bởi dấu gạch nối cuối dòng: "nông-" + "nghiệp" -> "nông nghiệp"
 * - Nối các dòng trong cùng một câu/đoạn văn thành dòng chảy liên tục
 */
export function reflowLinesToParagraphs(lines: PdfLineItem[]): string[] {
  if (lines.length === 0) return [];

  const paragraphs: string[] = [];
  let cur: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].text.trim();
    if (!t) continue;

    if (isHeadingLine(t)) {
      if (cur.length > 0) {
        paragraphs.push(cur.join(' '));
        cur = [];
      }
      paragraphs.push(t);
      continue;
    }

    let hasHyphen = false;
    if (t.endsWith('-') || t.endsWith('–')) {
      hasHyphen = true;
      t = t.slice(0, -1).trim();
    }

    cur.push(t);

    const nextLine = lines[i + 1] ? lines[i + 1].text.trim() : null;
    const nextIsLower = nextLine ? /^[a-zà-ỹ]/.test(nextLine) : false;

    // Nếu dòng tiếp theo bắt đầu bằng chữ thường, chắc chắn tiếp nối câu hiện tại
    if (nextIsLower) {
      continue;
    }

    // Nếu dòng kết thúc bằng dấu gạch nối, chắc chắn tiếp nối từ
    if (hasHyphen) {
      continue;
    }

    // Nếu không có dấu kết thúc câu (. ! ? : …), BẮT BUỘC tiếp tục nối với dòng sau
    if (!isSentenceEnd(t) && i < lines.length - 1) {
      continue;
    }

    paragraphs.push(cur.join(' '));
    cur = [];
  }

  if (cur.length > 0) {
    paragraphs.push(cur.join(' '));
  }

  return paragraphs;
}

export function reflowPageLines(lines: PdfLineItem[]): string {
  return reflowLinesToParagraphs(lines).join('\n\n');
}

const ROMAN_HEADING_START_REGEX = /^\s*([IVXLCDM]{1,6})\s*$/i;
const ROMAN_WITH_TITLE_REGEX = /^\s*([IVXLCDM]{1,6})\s*[\.\:\-\–]\s+([^\n]{3,80})$/i;
const NUMBERED_CHAPTER_REGEX =
  /^\s*(?:chương|phần|quyển|hồi|tiết|bài|tập|chapter|part)\s+(?:[0-9ivxlcdm]+|thứ\s+[0-9ivxlcdm\w]+|nhất|nhì|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|đầu)(?:[\.\:\-\–\s].*)?$/i;
const STANDALONE_CHAPTER_REGEX =
  /^\s*(?:tựa|lời\s*mở\s*đầu|lời\s*nói\s*đầu|lời\s*tựa|dẫn\s*nhập|mở\s*đầu|vĩ\s*thanh|kết\s*luận|phụ\s*lục|nội\s*dung|mục\s*lục|họ\s*an\s*việt|triết\s*lý\s*an\s*vi)\s*$/i;

/**
 * Nhận diện khối tiêu đề chương ở đầu mỗi trang sách
 * Hỗ trợ tiêu đề nhiều dòng (ví dụ số La Mã ở dòng 1, tiêu đề ở các dòng 2, 3)
 */
export function detectChapterHeaderOnPage(lines: PdfLineItem[]): { title: string; consumedCount: number } | null {
  const topLines = lines.slice(0, 8);
  if (topLines.length === 0) return null;

  // 1. Số La Mã đứng đầu trang: 'I', 'II', 'III', ... kèm các dòng tiêu đề ngắn liền kề
  const romanIdx = topLines.findIndex((l) => ROMAN_HEADING_START_REGEX.test(l.text.trim()));
  if (romanIdx !== -1) {
    const roman = topLines[romanIdx].text.trim().toUpperCase();
    const titleParts = [roman];
    let nextIdx = romanIdx + 1;
    while (
      nextIdx < topLines.length &&
      topLines[nextIdx].text.trim().length < 50 &&
      !topLines[nextIdx].text.trim().endsWith('.')
    ) {
      titleParts.push(topLines[nextIdx].text.trim());
      nextIdx++;
    }
    const fullTitle = titleParts[0] + '. ' + titleParts.slice(1).join(' ').replace(/\s+/g, ' ');
    return {
      title: fullTitle,
      consumedCount: nextIdx
    };
  }

  // 2. Tiêu đề có số La Mã cùng dòng: "I. Khi tổ tiên..."
  const romanLineIdx = topLines.findIndex((l) => ROMAN_WITH_TITLE_REGEX.test(l.text.trim()));
  if (romanLineIdx !== -1) {
    return {
      title: topLines[romanLineIdx].text.trim(),
      consumedCount: romanLineIdx + 1
    };
  }

  // 3. Từ khóa chương chuẩn kèm số: "Chương 1", "Phần I", "Chương thứ nhất"
  const chapLineIdx = topLines.findIndex((l) => NUMBERED_CHAPTER_REGEX.test(l.text.trim()));
  if (chapLineIdx !== -1) {
    return {
      title: topLines[chapLineIdx].text.trim(),
      consumedCount: chapLineIdx + 1
    };
  }

  // 4. Từ khóa độc lập đứng riêng: "TỰA", "NỘI DUNG", "LỜI NÓI ĐẦU", "HỌ AN VIỆT"
  const standaloneIdx = topLines.findIndex((l) => STANDALONE_CHAPTER_REGEX.test(l.text.trim()));
  if (standaloneIdx !== -1) {
    return {
      title: topLines[standaloneIdx].text.trim(),
      consumedCount: standaloneIdx + 1
    };
  }

  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Chuyển đổi toàn bộ các trang PDF đã lọc thành HTML có cấu trúc chương tự nhiên
 * - Bảo toàn 100% văn bản nguyên bản từ PDF
 * - KHÔNG sửa chính tả, KHÔNG chèn H2/H3
 * - Nhận diện tiêu đề chương thông minh, gom tiêu đề phân mảnh
 * - Chống cắt vụn: không bao giờ tạo các chương rỗng (< 200 ký tự)
 */
export function convertPagesToCleanHtml(
  pages: PdfExtractedPage[],
  bookTitle: string
): string {
  interface ChapterItem {
    title: string;
    paras: string[];
  }

  const chapters: ChapterItem[] = [];
  let currentTitle = `${bookTitle} - Thông tin sách`;
  let currentChapterLines: PdfLineItem[] = [];

  const finalizeChapter = () => {
    if (currentChapterLines.length === 0) return;
    const paras = reflowLinesToParagraphs(currentChapterLines);
    if (paras.length === 0) return;

    const textLen = paras.join(' ').trim().length;
    // Nếu nội dung quá ngắn (< 150 ký tự) và đã có chương trước đó, gộp vào chương trước
    if (textLen < 150 && chapters.length > 0) {
      chapters[chapters.length - 1].paras.push(...paras);
    } else {
      chapters.push({
        title: currentTitle,
        paras
      });
    }
    currentChapterLines = [];
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.lines.length === 0) continue;

    const detection = detectChapterHeaderOnPage(page.lines);

    if (detection) {
      const currentTextLength = currentChapterLines.map((l) => l.text).join(' ').trim().length;
      if (currentTextLength >= 200) {
        finalizeChapter();
      }
      currentTitle = detection.title;
    }

    const remainingLines = detection ? page.lines.slice(detection.consumedCount) : page.lines;
    currentChapterLines.push(...remainingLines);
  }

  finalizeChapter();

  // Dựng HTML từ danh sách chương đã phân tách
  const sectionsHtml = chapters.map((ch) => {
    const paragraphsHtml = ch.paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
    return `<section>\n<h1>${escapeHtml(ch.title)}</h1>\n${paragraphsHtml}\n</section>`;
  });

  return sectionsHtml.join('\n\n');
}


/**
 * Gom các trang đã reflow thành các batch để xử lý
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

