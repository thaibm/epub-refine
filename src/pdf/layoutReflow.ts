import type { PdfExtractedPage, PdfExtractedImage, PdfLineItem, PdfBatchChunk, PdfTocStructure, PdfTocItem } from './types.js';
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
  const PAGE_NUMBER_REGEX = /^(?:trang\s*|\-|\bpage\s*)?\d+(?:\s*\/\s*\d+)?(?:\s*\-)?\.?$/i;

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

// Token tạm đánh dấu vị trí tham chiếu chú thích trong text (Private Use Area, không đụng chạm escapeHtml)
const FN_TOKEN_OPEN = '\uE000';
const FN_TOKEN_CLOSE = '\uE001';
const FN_TOKEN_REGEX = /\uE000(\d+)\uE001/g;

// Dòng mở đầu một chú thích cuối trang: "(1) Nội dung..."
const FOOTNOTE_START_REGEX = /^\(\s*\d{1,2}\s*\)\s*(?=\S)/;

// Dấu tham chiếu (chỉ số trên) trong thân bài sau OCR, luôn dính liền sau chữ/dấu câu. Ba dạng:
//  - "(1)"            : nhóm 1
//  - "1", "12", "234" : chữ số dính liền (chỉ số trên bị OCR thành chữ thường); nhóm 2
//  - "(\"", "('"       : chỉ số trên bị OCR hỏng, chỉ còn dấu ngoặc + ký tự lạ; nhóm 3
const BODY_MARKER_REGEX =
  /(?<=[\p{L}.,;:!?…”"'’)\]*])(?:\(\s*(\d{1,2})\s*\)|(\d{1,3})|(\(\s*["'”“’`!|lI]\s*\)?))(?=[\s.,;:!?…”"')\]]|$)/gu;

export interface PageFootnote {
  num: string;
  text: string;
}

export interface PageFootnoteSplit {
  body: PdfLineItem[];
  notes: PageFootnote[];
}

/**
 * Tách khối chú thích ở đáy trang (đánh số lại từ (1) trên mỗi trang) khỏi thân bài.
 * Khối chú thích bắt đầu ở dòng "(N) ..." nằm ở nửa dưới trang, chữ nhỏ hơn thân bài.
 */
export function splitPageFootnotes(lines: PdfLineItem[]): PageFootnoteSplit {
  const heights = lines
    .filter((l) => l.bbox && l.bbox.y > 0.1 && l.bbox.y < 0.9 && l.text.length > 20)
    .map((l) => l.bbox!.h)
    .sort((a, b) => a - b);
  const medianH = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 0;

  let start = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.bbox || l.bbox.y >= 0.4) continue;
    if (!FOOTNOTE_START_REGEX.test(l.text.trim())) continue;
    // Chữ cỡ thân bài: chỉ nhận nếu nằm thấp trang và tách khỏi thân bài bằng khoảng trống rõ rệt
    // (tránh nhầm với liệt kê "(1)..." trong nội dung)
    if (medianH > 0 && l.bbox.h >= medianH * 0.95) {
      const prev = lines[i - 1].bbox;
      const gap = prev ? prev.y - (l.bbox.y + l.bbox.h) : 0;
      if (!(l.bbox.y < 0.3 && gap >= 0.03)) continue;
    }
    start = i;
    break;
  }
  if (start === -1) return { body: lines, notes: [] };

  const notes: PageFootnote[] = [];
  for (const l of lines.slice(start)) {
    const t = l.text.trim();
    if (!t) continue;
    if (FOOTNOTE_START_REGEX.test(t)) {
      const num = t.match(/\d+/)![0];
      notes.push({ num, text: t.replace(FOOTNOTE_START_REGEX, '').trim() });
    } else if (notes.length > 0) {
      const prev = notes[notes.length - 1];
      prev.text = /[-–]$/.test(prev.text) ? prev.text.slice(0, -1) + t : `${prev.text} ${t}`;
    }
  }
  return { body: lines.slice(0, start), notes };
}

/**
 * Gắn mỗi chú thích của trang vào dấu tham chiếu trong thân bài (theo thứ tự xuất hiện).
 * Dấu nào OCR làm mất thì chú thích được gắn vào cuối dòng thân bài cuối cùng của trang.
 */
export function linkFootnotesIntoBody(
  body: PdfLineItem[],
  notes: { id: number; num: string }[]
): { lines: PdfLineItem[]; matched: number } {
  const lines = body.map((l) => ({ ...l }));
  const token = (id: number) => `${FN_TOKEN_OPEN}${id}${FN_TOKEN_CLOSE}`;
  let next = 0;

  for (const line of lines) {
    if (next >= notes.length) break;
    line.text = line.text.replace(BODY_MARKER_REGEX, (m, paren?: string, digits?: string, garbled?: string) => {
      if (next >= notes.length) return m;
      if (garbled) return token(notes[next++].id);
      if (paren !== undefined) {
        return paren === notes[next].num ? token(notes[next++].id) : m;
      }
      // Chuỗi chữ số dính liền: tách tuần tự theo số thứ tự chú thích đang chờ ("12" -> chú thích 1 rồi 2)
      let rest = digits || '';
      let out = '';
      let cursor = next;
      while (rest.length > 0 && cursor < notes.length && rest.startsWith(notes[cursor].num)) {
        rest = rest.slice(notes[cursor].num.length);
        out += token(notes[cursor++].id);
      }
      if (rest.length > 0 || cursor === next) return m; // không khớp trọn vẹn: không phải dấu chú thích
      next = cursor;
      return out;
    });
  }

  const matched = next;
  if (next < notes.length && lines.length > 0) {
    // Dấu bị mất hẳn khi OCR (Vision thường bỏ chỉ số trên nhỏ): gắn vào cuối câu hoàn chỉnh cuối cùng
    // của trang để không mất chú thích và không rơi giữa câu. Không có thì dùng dòng cuối.
    const plain = (t: string) => t.replace(FN_TOKEN_REGEX, '').trim();
    let target = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/[.!?…”"»)]$/.test(plain(lines[i].text))) {
        target = i;
        break;
      }
    }
    if (target === -1) {
      // Tránh dính vào dòng tiêu đề ngắn (token trên tiêu đề sẽ bị loại khi dựng <h2>)
      target = lines.length - 1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (plain(lines[i].text).length >= 40) {
          target = i;
          break;
        }
      }
    }
    lines[target].text += notes.slice(next).map((n) => token(n.id)).join('');
  }
  return { lines, matched };
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

  const footnoteStore = new Map<number, string>();
  let footnoteSeq = 0;

  for (let i = 0; i < pages.length; i++) {
    let page = pages[i];
    if (page.lines.length === 0 && (!page.images || page.images.length === 0)) continue;

    // Bỏ qua các trang thuộc Mục Lục để không trích xuất trùng lặp vào sách
    if (tocPageSet.has(page.pageNumber)) {
      continue;
    }

    // Tách chú thích cuối trang ra khỏi thân bài để đoạn văn nối liền qua ngắt trang
    if (!tocPageSet.has(page.pageNumber)) {
      const split = splitPageFootnotes(page.lines);
      if (split.notes.length > 0) {
        const withIds = split.notes.map((n) => {
          footnoteStore.set(++footnoteSeq, n.text);
          return { id: footnoteSeq, num: n.num };
        });
        page = { ...page, lines: linkFootnotesIntoBody(split.body, withIds).lines };
      }
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

    // Trộn dòng chữ và ảnh theo toạ độ y (từ trên xuống) để ảnh nằm đúng chỗ giữa các đoạn.
    // Ảnh dùng cạnh trên làm khoá: dòng nằm trên ảnh có tâm cao hơn cạnh trên đó.
    const pageImages = page.images || [];
    if (pageImages.length === 0) {
      bufferedLines.push(...remainingLines);
    } else {
      type Item = { key: number; line?: PdfLineItem; image?: PdfExtractedImage };
      const items: Item[] = [
        ...remainingLines.map((line, i) => ({
          key: line.bbox ? line.bbox.y + line.bbox.h / 2 : 1 - i / Math.max(1, remainingLines.length),
          line
        })),
        ...pageImages.map((image) => ({
          key: image.bbox ? image.bbox.y + image.bbox.h : 0,
          image
        }))
      ];
      items.sort((a, b) => b.key - a.key);
      for (const it of items) {
        if (it.line) {
          bufferedLines.push(it.line);
        } else if (it.image) {
          flushBufferedLines();
          currentChapterBlocks.push({
            text: '',
            isHeading: false,
            image: {
              src: `images/${it.image.fileName}`,
              alt: it.image.alt || `Hình minh hoạ (Trang ${page.pageNumber})`
            }
          });
        }
      }
    }
  }

  finalizeChapter();

  // Dựng HTML từ danh sách chương đã phân tách
  const renderedNotes = new Set<number>();
  const sectionsHtml = chapters.map((ch) => {
    // Đánh số chú thích liên tục theo chương, theo thứ tự xuất hiện trong thân bài
    const chapterNotes: { id: number; num: number }[] = [];
    const renderText = (text: string) =>
      escapeHtml(text).replace(FN_TOKEN_REGEX, (_m, idStr: string) => {
        const id = Number(idStr);
        if (!footnoteStore.has(id)) return '';
        const num = chapterNotes.length + 1;
        chapterNotes.push({ id, num });
        renderedNotes.add(id);
        return `<a id="fnref_${id}" href="#fn_${id}" epub:type="noteref" role="doc-noteref" class="noteref"><sup>[${num}]</sup></a>`;
      });

    const blocksHtml = ch.blocks
      .map((b) => {
        if (b.image) {
          const altAttr = b.image.alt ? ` alt="${escapeHtml(b.image.alt)}"` : '';
          return `<div class="photo-plate"><img src="${escapeHtml(b.image.src)}"${altAttr} /></div>`;
        }
        if (b.isHeading) {
          const title = b.headingTitle || b.text;
          return `<h2>${escapeHtml(title.replace(FN_TOKEN_REGEX, ''))}</h2>`;
        }
        if (!b.text.trim()) return '';
        return `<p>${renderText(b.text)}</p>`;
      })
      .filter(Boolean)
      .join('\n');

    const asidesHtml = chapterNotes
      .map(({ id, num }) =>
        `<aside id="fn_${id}" class="chapter-footnote" epub:type="footnote" role="doc-footnote">\n  <p><a href="#fnref_${id}" class="footnote-backlink"><sup>[${num}]</sup></a> ${escapeHtml(footnoteStore.get(id) || '')}</p>\n</aside>`
      )
      .join('\n');
    const notesSection = asidesHtml ? `\n<div class="chapter-footnotes-section">\n${asidesHtml}\n</div>` : '';

    return `<section>\n<h1>${escapeHtml(ch.title)}</h1>\n${blocksHtml}${notesSection}\n</section>`;
  });

  if (renderedNotes.size !== footnoteStore.size) {
    console.warn(`⚠️ Chú thích: phát hiện ${footnoteStore.size}, xuất ra ${renderedNotes.size} (${footnoteStore.size - renderedNotes.size} chú thích không có vị trí tham chiếu)`);
  }
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
