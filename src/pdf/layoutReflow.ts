import type { PdfExtractedPage, PdfLineItem, PdfBatchChunk, PdfTocStructure, PdfTocItem } from './types.js';
import { calculateTextSimilarity, normalizeTextForMatching } from './tocParser.js';

export interface ReflowOptions {
  bookTitle?: string;
  toc?: PdfTocStructure;
}

export interface ReflowBlock {
  text: string;
  isHeading: boolean;
  headingTitle?: string;
  image?: {
    src: string;
    alt?: string;
  };
}

/**
 * Phân tích và lọc bỏ running headers (tiêu đề đầu trang), running footers (chân trang),
 * và số trang lặp lại dựa trên toạ độ bounding box, tần suất xuất hiện và đối chiếu ngữ nghĩa.
 */
export function removeHeadersAndFooters(
  pages: PdfExtractedPage[],
  options?: ReflowOptions
): PdfExtractedPage[] {
  if (pages.length === 0) return [];

  const bookTitleNorm = options?.bookTitle ? normalizeTextForMatching(options.bookTitle) : '';

  // 1. Thống kê tần suất các dòng văn bản ở vùng đỉnh (top y >= 0.85) và vùng đáy (bottom y <= 0.12)
  const topTextCounts = new Map<string, number>();
  const bottomTextCounts = new Map<string, number>();

  for (const page of pages) {
    for (const line of page.lines) {
      const textNorm = normalizeTextForMatching(line.text);
      if (!textNorm) continue;

      if (line.bbox) {
        if (line.bbox.y >= 0.85) {
          topTextCounts.set(textNorm, (topTextCounts.get(textNorm) || 0) + 1);
        } else if (line.bbox.y <= 0.12) {
          bottomTextCounts.set(textNorm, (bottomTextCounts.get(textNorm) || 0) + 1);
        }
      }
    }
  }

  // Các cụm từ xuất hiện lặp lại trên >= 2 trang ở vùng mép trang
  const isRepeatedHeader = (text: string, y?: number) => {
    if (y === undefined || y < 0.85) return false;
    const textNorm = normalizeTextForMatching(text);
    if (!textNorm) return false;

    // So khớp chính xác số lần đếm
    if ((topTextCounts.get(textNorm) || 0) >= 2) return true;

    // So khớp fuzzy với các running header đã thấy (độ tương đồng >= 0.82)
    for (const [savedNorm, count] of topTextCounts.entries()) {
      if (count >= 2 && calculateTextSimilarity(textNorm, savedNorm) >= 0.82) {
        return true;
      }
    }

    return false;
  };

  const isRepeatedFooter = (text: string, y?: number) => {
    if (y === undefined || y > 0.12) return false;
    const textNorm = normalizeTextForMatching(text);
    return (bottomTextCounts.get(textNorm) || 0) >= 2;
  };

  // Pattern nhận diện số trang độc lập dạng: "Trang 12", "12", "- 12 -", "Page 12", "12 / 150"
  const PAGE_NUMBER_REGEX = /^(?:trang\s*|\-|\bpage\s*)?\d+(?:\s*\/\s*\d+)?(?:\s*\-)?$/i;

  return pages.map((page) => {
    const cleanedLines: PdfLineItem[] = [];

    for (const line of page.lines) {
      let text = line.text.trim();
      if (!text) continue;

      const y = line.bbox?.y;

      // 1. Tách số trang dính ở đầu dòng ở vùng đỉnh trang (y >= 0.80)
      // Ví dụ: "155 CƠ CÁN ĐI SÂU..." -> "CƠ CÁN ĐI SÂU..."
      // Ví dụ: "159 Về tổ chức..." -> "Về tổ chức..."
      if (y !== undefined && y >= 0.80) {
        const prefixPageMatch = text.match(/^(\d{1,4})\s+([A-ZÀ-Ỹa-z\p{L}].*)$/u);
        if (prefixPageMatch) {
          text = prefixPageMatch[2].trim();
        }
      }

      if (y !== undefined) {
        // 2. Lọc số trang độc lập ở vùng đỉnh (y >= 0.85) hoặc vùng đáy (y <= 0.12)
        if ((y >= 0.85 || y <= 0.12) && PAGE_NUMBER_REGEX.test(text)) {
          continue;
        }

        // 3. Lọc running header theo ngữ nghĩa ở vùng đỉnh (y >= 0.85)
        if (y >= 0.85) {
          const lineNorm = normalizeTextForMatching(text);

          // a. Trùng/tương đồng cao với tên sách (ví dụ: "NGƯỜI THẦY", "NGƯỜI THẨY")
          if (bookTitleNorm && lineNorm) {
            if (
              lineNorm === bookTitleNorm ||
              lineNorm.includes(bookTitleNorm) ||
              bookTitleNorm.includes(lineNorm) ||
              calculateTextSimilarity(lineNorm, bookTitleNorm) >= 0.72
            ) {
              continue;
            }
          }

          // b. Dòng bắt đầu bằng "Chương..." ở vùng đỉnh trang (đây là running header của chương,
          // vì tiêu đề mở đầu chương thực thụ luôn bắt đầu ở khoảng y < 0.80)
          if (/^\s*(?:chương|phần)\s+(?:[0-9ivxlcdm]+|thứ\s+\w+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|nhất|nhì|kết)\b/iu.test(text)) {
            continue;
          }

          // c. Trùng với tiêu đề chương lớn trong TOC ở vùng đỉnh trang
          if (options?.toc?.hasToc) {
            let matchedChapterHeader = false;
            for (const ch of options.toc.majorChapters) {
              if (calculateTextSimilarity(lineNorm, ch.normalizedTitle) >= 0.75) {
                matchedChapterHeader = true;
                break;
              }
            }
            if (matchedChapterHeader) {
              continue;
            }
          }

          // d. Lọc header lặp lại (kể cả do lỗi OCR biến dạng)
          if (isRepeatedHeader(text, y)) {
            continue;
          }
        }

        // 4. Lọc running footer lặp lại
        if (y <= 0.12 && isRepeatedFooter(text, y)) {
          continue;
        }

        // 5. Lọc các dòng rác quá sát mép trên hoặc mép dưới (< 0.05 hoặc > 0.94) nếu độ dài ngắn (< 35 ký tự)
        if ((y >= 0.94 || y <= 0.05) && text.length < 35 && !text.endsWith('.')) {
          continue;
        }
      } else {
        // Fallback nếu không có bbox
        if (PAGE_NUMBER_REGEX.test(text)) {
          continue;
        }
      }

      cleanedLines.push({
        ...line,
        text
      });
    }

    return {
      ...page,
      lines: cleanedLines,
      rawText: cleanedLines.map((l) => l.text).join('\n')
    };
  });
}

/**
 * Kiểm tra xem một dòng văn bản có phải là dòng in hoa toàn bộ không (sử dụng Unicode tiếng Việt)
 */
export function isAllCapsHeading(text: string): boolean {
  if (text.length >= 80 || text.length < 3) return false;
  const hasLower = /\p{Ll}/u.test(text);
  const hasUpper = /\p{Lu}/u.test(text);
  return !hasLower && hasUpper;
}

/**
 * So khớp một dòng văn bản với danh sách tiểu mục trong Mục lục (TOC)
 */
export function matchSubSection(text: string, subSections?: PdfTocItem[]): PdfTocItem | null {
  if (!subSections || subSections.length === 0) return null;
  const t = text.trim();
  if (t.length < 3 || t.length > 80) return null;
  // Tiêu đề tiểu mục không bao giờ kết thúc bằng dấu chấm câu, phẩy, hai chấm hoặc chấm than
  if (/[.!?,;:]$/.test(t)) return null;
  // Tiêu đề tiểu mục không phải lời thoại gạch đầu dòng
  if (t.startsWith('-') || t.startsWith('–')) return null;

  const tNorm = normalizeTextForMatching(t);
  const w1 = tNorm.split(/\s+/).filter(Boolean);
  if (w1.length === 0) return null;

  const normalizeConfusables = (s: string) => s.replace(/\b2\b/g, 'z').replace(/\b0\b/g, 'o');
  const tNormConf = normalizeConfusables(tNorm);

  for (const sub of subSections) {
    const sNorm = sub.normalizedTitle;
    const w2 = sNorm.split(/\s+/).filter(Boolean);
    if (w2.length === 0) continue;

    // Khớp tuyệt đối sau khi chuẩn hoá
    if (tNorm === sNorm) return sub;

    // Khớp với ký tự dễ nhầm lẫn trong OCR (ví dụ '2' thay vì 'z')
    const sNormConf = normalizeConfusables(sNorm);
    if (tNormConf === sNormConf) return sub;

    // So khớp theo tỷ lệ từ vựng (Word-level similarity)
    const set1 = new Set(w1);
    const set2 = new Set(w2);
    let intersect = 0;
    for (const w of set1) {
      if (set2.has(w)) intersect++;
    }
    const dice = (2 * intersect) / (set1.size + set2.size);
    const lenRatio = Math.min(w1.length, w2.length) / Math.max(w1.length, w2.length);

    if (dice * lenRatio >= 0.78 && lenRatio >= 0.7) {
      return sub;
    }
  }

  return null;
}

/**
 * Nhận diện một dòng là Heading độc lập
 */
export function isHeadingLine(text: string, subSections?: PdfTocItem[]): boolean {
  if (text.length > 80 || text.length < 3) return false;
  if (text.endsWith(',') || text.endsWith(';')) return false;

  // 1. Nếu có Mục lục (TOC): CHỈ CHẤP NHẬN dòng khớp với tiểu mục trong Mục lục!
  if (subSections && subSections.length > 0) {
    return matchSubSection(text, subSections) !== null;
  }

  // 2. Nếu không có Mục lục (Fallback):
  // Chỉ chấp nhận tiêu đề có số hiệu rõ ràng (I., 1., Mục 1...)
  if (/^\s*(?:chương|phần|hồi|tiết|mục|quyển|tập|quẻ)\s+(?:[0-9]+|[IVXLCDM]+|thứ\s+\w+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|nhất|nhì|tam|tứ)\b(?:\s*[:.\-–]\s*|\s*$)/iu.test(text)) {
    return true;
  }
  if (/^\s*[IVXLCDM]+\.\s+[^\n]{3,60}$/i.test(text)) {
    return true;
  }
  if (/^\s*[0-9]{1,2}\.\s+[A-ZÀ-Ỹ\p{Lu}][^\n]{3,60}$/u.test(text)) {
    return true;
  }

  return false;
}

function isSentenceEnd(text: string): boolean {
  if (/(?:v\.v|nxb|gs|ts|ths|bs|tp|vn|đh|th|tt|trg|tr)\.\s*$/i.test(text)) return false;
  if (/\b[A-ZÀ-Ỹ]\.\s*$/.test(text)) return false;
  return /[.!?:…"”»)]\s*$/.test(text);
}

/**
 * Nối dòng văn bản thông minh (Smart Paragraph Reflow):
 * - Tách riêng Heading độc lập mà KHÔNG yêu cầu dấu chấm cuối câu
 * - Nối từ bị đứt quãng bởi dấu gạch nối cuối dòng: "nông-" + "nghiệp" -> "nông nghiệp"
 * - Nối các dòng trong cùng một câu/đoạn văn thành dòng chảy liên tục
 */
export function reflowLinesToBlocks(
  lines: PdfLineItem[],
  subSections?: PdfTocItem[]
): ReflowBlock[] {
  if (lines.length === 0) return [];

  const blocks: ReflowBlock[] = [];
  let cur: string[] = [];

  const flushCur = () => {
    if (cur.length > 0) {
      blocks.push({
        text: cur.join(' '),
        isHeading: false
      });
      cur = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].text.trim();
    if (!t) continue;

    const matchedSub = matchSubSection(t, subSections);
    const isHeading = matchedSub !== null || (!subSections && isHeadingLine(t));

    // Nếu dòng hiện tại là Heading: Ngắt đoạn trước đó và đẩy Heading thành block độc lập
    if (isHeading) {
      flushCur();
      blocks.push({
        text: t,
        isHeading: true,
        headingTitle: matchedSub?.title
      });
      continue;
    }

    let hasHyphen = false;
    if (t.endsWith('-') || t.endsWith('–')) {
      hasHyphen = true;
      t = t.slice(0, -1).trim();
    }

    cur.push(t);

    const nextLine = lines[i + 1] ? lines[i + 1].text.trim() : null;

    // Nếu dòng tiếp theo là Heading, lập tức kết thúc đoạn hiện tại để không bị nuốt dòng
    if (nextLine) {
      const nextMatched = matchSubSection(nextLine, subSections);
      if (nextMatched || (!subSections && isHeadingLine(nextLine))) {
        flushCur();
        continue;
      }
    }

    const nextIsLower = nextLine ? /\p{Ll}/u.test(nextLine[0]) : false;

    // Nếu dòng tiếp theo bắt đầu bằng chữ thường, tiếp nối câu hiện tại
    if (nextIsLower) {
      continue;
    }

    // Nếu dòng kết thúc bằng dấu gạch nối, tiếp nối từ
    if (hasHyphen) {
      continue;
    }

    // Nếu không có dấu kết thúc câu (. ! ? : …), tiếp tục nối với dòng sau
    if (!isSentenceEnd(t) && i < lines.length - 1) {
      continue;
    }

    flushCur();
  }

  flushCur();
  return blocks;
}

export function reflowLinesToParagraphs(
  lines: PdfLineItem[],
  subSections?: PdfTocItem[]
): string[] {
  return reflowLinesToBlocks(lines, subSections).map((b) => b.text);
}

export function reflowPageLines(lines: PdfLineItem[]): string {
  return reflowLinesToParagraphs(lines).join('\n\n');
}

const ROMAN_HEADING_START_REGEX = /^\s*([IVXLCDM]{1,6})\s*$/i;
const ROMAN_WITH_TITLE_REGEX = /^\s*([IVXLCDM]{1,6})\s*[\.\:\-\–]\s+([^\n]{3,80})$/i;
const NUMBERED_CHAPTER_REGEX =
  /^\s*(?:chương|phần|quyển|hồi|tiết|bài|tập|chapter|part)\s+(?:[0-9ivxlcdm]+|thứ\s+[0-9ivxlcdm\w]+|một|nhất|nhì|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|kết|cuối|mở\s*đầu)(?:[.:\-–\s].*)?$/iu;
const STANDALONE_CHAPTER_REGEX =
  /^\s*(?:tựa|lời\s*mở\s*đầu|lời\s*nói\s*đầu|lời\s*giới\s*thiệu|lời\s*tựa|dẫn\s*nhập|mở\s*đầu|vĩ\s*thanh|kết\s*luận|phụ\s*lục|nội\s*dung|họ\s*an\s*việt|triết\s*lý\s*an\s*vi)\s*$/iu;

/**
 * Nhận diện khối tiêu đề chương ở đầu trang sách (Fallback khi không có Mục lục)
 * Chỉ chấp nhận tiêu đề ở vị trí y < 0.85 để tránh nhận nhầm running header
 */
export function detectChapterHeaderOnPage(lines: PdfLineItem[]): { title: string; consumedCount: number } | null {
  const topLines = lines.slice(0, 8);
  if (topLines.length === 0) return null;

  // Bỏ qua nếu dòng đầu tiên nằm ở vùng đỉnh running header (y >= 0.85)
  const firstLine = topLines[0];
  if (firstLine.bbox && firstLine.bbox.y >= 0.85) {
    return null;
  }

  // 1. Số La Mã đứng đầu trang: 'I', 'II', 'III'
  const romanIdx = topLines.findIndex((l) => ROMAN_HEADING_START_REGEX.test(l.text.trim()));
  if (romanIdx !== -1 && (!topLines[romanIdx].bbox || topLines[romanIdx].bbox!.y < 0.85)) {
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
  if (romanLineIdx !== -1 && (!topLines[romanLineIdx].bbox || topLines[romanLineIdx].bbox!.y < 0.85)) {
    return {
      title: topLines[romanLineIdx].text.trim(),
      consumedCount: romanLineIdx + 1
    };
  }

  // 3. Từ khóa chương chuẩn kèm số: "Chương 1", "Chương một"
  const chapLineIdx = topLines.findIndex((l) => NUMBERED_CHAPTER_REGEX.test(l.text.trim()));
  if (chapLineIdx !== -1 && (!topLines[chapLineIdx].bbox || topLines[chapLineIdx].bbox!.y < 0.85)) {
    let title = topLines[chapLineIdx].text.trim();
    let consumed = chapLineIdx + 1;
    // Kiểm tra nếu dòng kế tiếp là phụ đề in hoa
    if (consumed < topLines.length) {
      const nextT = topLines[consumed].text.trim();
      if (isAllCapsHeading(nextT)) {
        title = `${title}: ${nextT}`;
        consumed++;
      }
    }
    return {
      title,
      consumedCount: consumed
    };
  }

  // 4. Từ khóa độc lập đứng riêng: "LỜI NÓI ĐẦU", "LỜI GIỚI THIỆU"
  const standaloneIdx = topLines.findIndex((l) => STANDALONE_CHAPTER_REGEX.test(l.text.trim()));
  if (standaloneIdx !== -1 && (!topLines[standaloneIdx].bbox || topLines[standaloneIdx].bbox!.y < 0.85)) {
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
 * - Sử dụng Mục lục (TOC Anchor) làm mốc nếu có để ngăn cắt vụn chương và chuẩn hoá H1/H2
 * - Fallback: Thuật toán Chapter Split Guard thông minh nếu không có Mục lục
 */
export function convertPagesToCleanHtml(
  pages: PdfExtractedPage[],
  bookTitle: string,
  toc?: PdfTocStructure
): string {
  interface ChapterItem {
    title: string;
    blocks: ReflowBlock[];
  }

  const chapters: ChapterItem[] = [];
  let currentTitle = `${bookTitle} - Thông tin sách`;
  let currentChapterBlocks: ReflowBlock[] = [];
  let bufferedLines: PdfLineItem[] = [];

  const tocPageSet = new Set(toc?.tocPageNumbers || []);
  const majorList = toc?.hasToc ? toc.majorChapters : [];
  let nextMajorIdx = 0;

  const flushBufferedLines = () => {
    if (bufferedLines.length === 0) return;
    const blocks = reflowLinesToBlocks(bufferedLines, toc?.subSections);
    currentChapterBlocks.push(...blocks);
    bufferedLines = [];
  };

  const finalizeChapter = () => {
    flushBufferedLines();
    if (currentChapterBlocks.length === 0) return;

    const textLen = currentChapterBlocks
      .filter((b) => !b.image)
      .map((b) => b.text)
      .join(' ')
      .trim().length;

    const hasImages = currentChapterBlocks.some((b) => !!b.image);
    // Nếu nội dung quá ngắn (< 150 ký tự), không có ảnh và đã có chương trước đó, gộp vào chương trước
    if (textLen < 150 && !hasImages && chapters.length > 0) {
      chapters[chapters.length - 1].blocks.push(...currentChapterBlocks);
    } else {
      chapters.push({
        title: currentTitle,
        blocks: currentChapterBlocks
      });
    }
    currentChapterBlocks = [];
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.lines.length === 0 && (!page.images || page.images.length === 0)) continue;

    // Bỏ qua các trang thuộc Mục Lục để không trích xuất trùng lặp vào sách
    if (tocPageSet.has(page.pageNumber)) {
      continue;
    }

    let detection: { title: string; consumedCount: number } | null = null;

    if (majorList.length > 0 && nextMajorIdx < majorList.length) {
      // CHẾ ĐỘ 1: Dùng TOC Anchor Engine
      const topLines = page.lines.slice(0, 6);
      let foundMajorIdx = -1;
      let matchedConsumed = 0;

      for (let k = nextMajorIdx; k < majorList.length; k++) {
        const targetChapter = majorList[k];

        for (let lineIdx = 0; lineIdx < topLines.length; lineIdx++) {
          const line = topLines[lineIdx];
          if (line.bbox && line.bbox.y >= 0.85) continue; // Bỏ qua running header mép trên

          const lText = line.text.trim();
          const lNorm = normalizeTextForMatching(lText);

          // a. So khớp trực tiếp dòng đơn
          if (calculateTextSimilarity(lNorm, targetChapter.normalizedTitle) >= 0.80) {
            foundMajorIdx = k;
            matchedConsumed = lineIdx + 1;
            break;
          }

          // b. So khớp dòng đôi (Dòng 1: "Chương ba", Dòng 2: "ÔNG BA VÀ ĐỒNG ĐỘI")
          if (lineIdx + 1 < topLines.length) {
            const combined = `${lText} ${topLines[lineIdx + 1].text.trim()}`;
            const cNorm = normalizeTextForMatching(combined);
            if (calculateTextSimilarity(cNorm, targetChapter.normalizedTitle) >= 0.80) {
              foundMajorIdx = k;
              matchedConsumed = lineIdx + 2;
              break;
            }
          }
        }

        if (foundMajorIdx !== -1) break;
      }

      if (foundMajorIdx !== -1) {
        detection = {
          title: majorList[foundMajorIdx].title,
          consumedCount: matchedConsumed
        };
        nextMajorIdx = foundMajorIdx + 1;
      }
    } else if (majorList.length === 0) {
      // CHẾ ĐỘ 2: Fallback (Không có Mục Lục)
      detection = detectChapterHeaderOnPage(page.lines);
    }

    if (detection) {
      flushBufferedLines();
      const currentTextLength = currentChapterBlocks
        .filter((b) => !b.image)
        .map((l) => l.text)
        .join(' ')
        .trim().length;
      if (currentTextLength >= 200 || currentChapterBlocks.some((b) => !!b.image)) {
        finalizeChapter();
      }
      currentTitle = detection.title;
    }

    const remainingLines = detection ? page.lines.slice(detection.consumedCount) : page.lines;

    if (page.isPhotoPlate) {
      // Đối với trang album ảnh (photo plate):
      flushBufferedLines();
      if (page.images && page.images.length > 0) {
        for (const img of page.images) {
          currentChapterBlocks.push({
            text: '',
            isHeading: false,
            image: {
              src: `images/${img.fileName}`,
              alt: img.alt || `Khoảnh khắc và cuộc đời (Trang ${page.pageNumber})`
            }
          });
        }
      }
      // Không nạp remainingLines từ photo plate để tránh nhiễu OCR trên áp phích/tường trong ảnh
    } else {
      bufferedLines.push(...remainingLines);

      // Nếu trang thông thường có hình ảnh chèn giữa nội dung
      if (page.images && page.images.length > 0) {
        flushBufferedLines();
        for (const img of page.images) {
          currentChapterBlocks.push({
            text: '',
            isHeading: false,
            image: {
              src: `images/${img.fileName}`,
              alt: img.alt || `Hình ảnh minh hoạ (Trang ${page.pageNumber})`
            }
          });
        }
      }
    }
  }

  finalizeChapter();

  // Dựng HTML từ danh sách chương đã phân tách
  const sectionsHtml = chapters.map((ch) => {
    const blocksHtml = ch.blocks
      .map((b) => {
        if (b.image) {
          const altAttr = b.image.alt ? ` alt="${escapeHtml(b.image.alt)}"` : '';
          return `<div class="photo-plate"><img src="${escapeHtml(b.image.src)}"${altAttr} /></div>`;
        }
        if (b.isHeading) {
          const title = b.headingTitle || b.text;
          return `<h2>${escapeHtml(title)}</h2>`;
        }
        if (!b.text.trim()) return '';
        return `<p>${escapeHtml(b.text)}</p>`;
      })
      .filter(Boolean)
      .join('\n');
    return `<section>\n<h1>${escapeHtml(ch.title)}</h1>\n${blocksHtml}\n</section>`;
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
