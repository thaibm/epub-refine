import type { PdfExtractedPage, PdfLineItem, PdfTocItem, PdfTocStructure } from './types.js';

/**
 * Chuẩn hoá chuỗi để so khớp không phân biệt dấu và ký tự đặc biệt
 */
export function normalizeTextForMatching(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Bỏ dấu tiếng Việt
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ') // Bỏ ký tự đặc biệt
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tính toán độ tương đồng giữa hai chuỗi bằng Dice's Bigram Coefficient
 */
export function calculateTextSimilarity(str1: string, str2: string): number {
  const s1 = normalizeTextForMatching(str1);
  const s2 = normalizeTextForMatching(str2);

  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  if (s1.includes(s2) || s2.includes(s1)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    if (minLen / maxLen >= 0.7) return 0.95;
  }

  const getBigrams = (s: string) => {
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.slice(i, i + 2));
    }
    return bigrams;
  };

  const bg1 = getBigrams(s1);
  const bg2 = getBigrams(s2);

  let intersection = 0;
  for (const b of bg1) {
    if (bg2.has(b)) intersection++;
  }

  return (2 * intersection) / (bg1.size + bg2.size || 1);
}

const TOC_TITLE_REGEX = /^\s*(?:mục\s*lục|table\s+of\s+contents|danh\s*mục|m\s*ụ\s*c\s*l\s*ụ\s*c)\s*$/i;

const MAJOR_CHAPTER_START_REGEX =
  /^\s*(?:chương|phần|quyển|hồi|tiết|bài|tập|chapter|part)\s+(?:[0-9ivxlcdm]+|thứ\s+[0-9ivxlcdm\w]+|một|nhất|nhì|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|kết|cuối|mở\s*đầu)(?:[.:\-–\s].*)?$/iu;

const STANDALONE_SECTION_REGEX =
  /^\s*(?:lời\s*giới\s*thiệu|lời\s*nói\s*đầu|lời\s*mở\s*đầu|lời\s*tựa|tựa|dẫn\s*nhập|vĩ\s*thanh|kết\s*luận|phụ\s*lục|thay\s*lời\s*tựa)\s*$/iu;

const PAGE_NUMBER_ITEM_REGEX = /^[\.\s\-_~:]*(\d{1,4})[\.\s\-_~:]*$/;

/**
 * Tìm và bóc tách cấu trúc Mục Lục (TOC) từ danh sách các trang PDF
 */
export function detectAndParsePdfToc(pages: PdfExtractedPage[]): PdfTocStructure {
  const emptyResult: PdfTocStructure = {
    hasToc: false,
    tocPageNumbers: [],
    items: [],
    majorChapters: [],
    subSections: []
  };

  if (pages.length === 0) return emptyResult;

  // 1. Quét tìm trang có tiêu đề MỤC LỤC
  const total = pages.length;
  const candidateIndices: number[] = [];

  for (let i = 0; i < pages.length; i++) {
    const isHead = i < 25;
    const isTail = i >= total - 25;
    if (!isHead && !isTail) continue;

    const page = pages[i];
    const topLines = page.lines.slice(0, 5);
    const hasTocTitle = topLines.some((l) => TOC_TITLE_REGEX.test(l.text.trim()));

    if (hasTocTitle) {
      candidateIndices.push(i);
    }
  }

  if (candidateIndices.length === 0) {
    return emptyResult;
  }

  // 2. Thu thập các trang liên tiếp của Mục Lục bắt đầu từ trang tìm thấy đầu tiên
  const startIdx = candidateIndices[0];
  const tocIndices: number[] = [startIdx];

  for (let i = startIdx + 1; i < Math.min(startIdx + 8, pages.length); i++) {
    const page = pages[i];
    const pageText = page.lines.map((l) => l.text).join(' ');

    if (/chịu\s*trách\s*nhiệm\s*xuất\s*bản|nhà\s*xuất\s*bản|giấy\s*phép\s*xuất\s*bản|isbn/i.test(pageText)) {
      break;
    }

    const hasChapterOrNumbers = page.lines.some(
      (l) => MAJOR_CHAPTER_START_REGEX.test(l.text.trim()) || PAGE_NUMBER_ITEM_REGEX.test(l.text.trim())
    );

    if (hasChapterOrNumbers) {
      tocIndices.push(i);
    } else {
      break;
    }
  }

  const tocPages = tocIndices.map((idx) => pages[idx]);
  const tocPageNumbers = tocPages.map((p) => p.pageNumber);

  // 3. Phân tích nội dung các trang Mục Lục để trích xuất từng mục
  const allLines: string[] = [];
  for (const page of tocPages) {
    for (const l of page.lines) {
      const text = l.text.trim();
      if (!text || TOC_TITLE_REGEX.test(text)) continue;
      allLines.push(text);
    }
  }

  const items: PdfTocItem[] = [];

  for (let i = 0; i < allLines.length; i++) {
    let line = allLines[i];

    // Bỏ qua dòng chỉ là số trang in
    const pageNumMatch = line.match(PAGE_NUMBER_ITEM_REGEX);
    if (pageNumMatch) {
      const num = parseInt(pageNumMatch[1], 10);
      if (items.length > 0 && !items[items.length - 1].pageNumber) {
        items[items.length - 1].pageNumber = num;
      }
      continue;
    }

    // Tách số trang dính ở cuối dòng (ví dụ: "Lời giới thiệu ..7", "Buổi chia tay 15")
    // Nhưng nếu dòng kế tiếp là một số trang đứng riêng lẻ, thì số ở cuối dòng này là thuộc về tiêu đề (vd: "Lớp tập huấn nghiệp vụ 28")
    let extractedPageNumber: number | undefined;
    const nextIsStandalonePageNum = i + 1 < allLines.length && PAGE_NUMBER_ITEM_REGEX.test(allLines[i + 1].trim());

    if (!nextIsStandalonePageNum) {
      const inlinePageMatch = line.match(/^(.*?)(?:[\.\s\-_~:]{2,}|\s+)(\d{1,4})$/);
      if (inlinePageMatch) {
        line = inlinePageMatch[1].trim();
        extractedPageNumber = parseInt(inlinePageMatch[2], 10);
      }
    }

    if (!line) continue;

    // 1. Kiểm tra Tiêu đề Chương lớn (Level 1)
    if (MAJOR_CHAPTER_START_REGEX.test(line)) {
      let fullTitle = line;
      // Nếu dòng kế tiếp là tiêu đề phụ của chương (ví dụ: dòng 1 "Chương ba", dòng 2 "ÔNG BA VÀ ĐỒNG ĐỘI")
      if (i + 1 < allLines.length) {
        const nextLine = allLines[i + 1].trim();
        const nextIsPageNum = PAGE_NUMBER_ITEM_REGEX.test(nextLine);
        const nextIsMajor = MAJOR_CHAPTER_START_REGEX.test(nextLine) || STANDALONE_SECTION_REGEX.test(nextLine);

        if (!nextIsPageNum && !nextIsMajor) {
          const hasUpper = /\p{Lu}/u.test(nextLine);
          const hasLower = /\p{Ll}/u.test(nextLine);
          // Nếu dòng kế tiếp in hoa toàn bộ hoặc là phụ đề ngắn (< 80 ký tự)
          if (!hasLower && hasUpper && nextLine.length < 80) {
            fullTitle = `${line}: ${nextLine}`;
            i++; // Bỏ qua dòng phụ đề đã gộp

            // Kiểm tra xem dòng tiếp theo sau phụ đề có phải là số trang không
            if (i + 1 < allLines.length) {
              const afterNext = allLines[i + 1].trim();
              const pMatch = afterNext.match(PAGE_NUMBER_ITEM_REGEX);
              if (pMatch) {
                extractedPageNumber = parseInt(pMatch[1], 10);
                i++; // Bỏ qua dòng số trang
              }
            }
          }
        }
      }

      items.push({
        title: fullTitle,
        level: 1,
        pageNumber: extractedPageNumber,
        normalizedTitle: normalizeTextForMatching(fullTitle)
      });
      continue;
    }

    // 2. Kiểm tra Phần mở đầu độc lập (Level 1) như "Lời giới thiệu", "Lời nói đầu"
    if (STANDALONE_SECTION_REGEX.test(line)) {
      // Kiểm tra dòng sau có phải số trang không nếu dòng này chưa có
      if (!extractedPageNumber && i + 1 < allLines.length) {
        const nextLine = allLines[i + 1].trim();
        const pMatch = nextLine.match(PAGE_NUMBER_ITEM_REGEX);
        if (pMatch) {
          extractedPageNumber = parseInt(pMatch[1], 10);
          i++;
        }
      }

      items.push({
        title: line,
        level: 1,
        pageNumber: extractedPageNumber,
        normalizedTitle: normalizeTextForMatching(line)
      });
      continue;
    }

    // 3. Các tiểu mục cấp 2 (Level 2)
    // Nếu dòng tiếp theo là số trang
    if (!extractedPageNumber && i + 1 < allLines.length) {
      const nextLine = allLines[i + 1].trim();
      const pMatch = nextLine.match(PAGE_NUMBER_ITEM_REGEX);
      if (pMatch) {
        extractedPageNumber = parseInt(pMatch[1], 10);
        i++;
      }
    }

    if (line.length >= 3 && line.length <= 120) {
      items.push({
        title: line,
        level: 2,
        pageNumber: extractedPageNumber,
        normalizedTitle: normalizeTextForMatching(line)
      });
    }
  }

  const majorChapters = items.filter((it) => it.level === 1);
  const subSections = items.filter((it) => it.level === 2);

  return {
    hasToc: majorChapters.length > 0,
    tocPageNumbers,
    items,
    majorChapters,
    subSections
  };
}
