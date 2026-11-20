import { calculateTextSimilarity, normalizeTextForMatching } from './tocParser.js';
import type { ChapterDraft } from './pdfToWorkspace.js';
import type {
  PdfDigitalExtraction,
  PdfDigitalLine,
  PdfDigitalNavigation,
  PdfDigitalPage,
  PdfNavEntry,
  PdfTocRegion
} from './types.js';

export interface DigitalStructureOptions {
  startPage: number;
  endPage: number;
  fallbackTitle: string;
}

export interface DigitalBookMetadata {
  title: string;
  author?: string;
}

export interface DigitalStructureReport {
  navSource: string;
  tocEntries: number;
  matchedHeadings: number;
  unmatchedHeadings: { title: string; page: number }[];
  sourceWords: number;
  outputWords: number;
  matchedWords: number;
  coverage: number;
  topMissingWords: [string, number][];
  removedMarginLines: number;
  removedMarginSamples: string[];
  pagesWithInlineImages: number[];
}

export interface DigitalStructureResult {
  chapters: ChapterDraft[];
  metadata: DigitalBookMetadata;
  hasCoverPage: boolean;
  report: DigitalStructureReport;
}

interface Metrics {
  bodyFont: number;
  left: number;
  indent: number | null;
  right: number;
  leading: number;
  pageLeft: Map<number, number>;
}

interface Block {
  lines: PdfDigitalLine[];
  align?: 'center' | 'right';
}

interface LocatedEntry {
  entry: PdfNavEntry;
  start: number;
  bodyStart: number;
  matched: boolean;
}

type LineKind = 'continuation' | 'indented' | 'offset';

const SENTENCE_END_REGEX = /[.!?:…"”»)]\s*$/;
const ATTACHED_HYPHEN_REGEX = /\S[-‐]$/;
const HEADING_SEARCH_LINES = 90;
const MAX_SUBHEADING_LENGTH = 180;
const DISPLAY_PAGE_RATIO = 0.7;
const FRONT_MATTER_TITLE = 'Thông tin sách';
const BACK_MATTER_TITLE = 'Thông tin xuất bản';

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function modeOf(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function isInTocRegion(line: PdfDigitalLine, region?: PdfTocRegion): boolean {
  if (!region) return false;
  const { pageNumber: page, baseline: y } = line;
  if (page < region.startPage || page > region.endPage) return false;
  if (page === region.startPage && y > region.startY + 1) return false;
  if (page === region.endPage && y < region.endY - 1) return false;
  return true;
}

/**
 * Loại số trang và tiêu đề chạy dựa trên sự lặp lại thực tế ở dòng đầu/cuối trang,
 * không dùng vùng cố định vì thân sách có thể nằm sát mép trang.
 */
function findMarginLines(pages: PdfDigitalPage[], entries: PdfNavEntry[]): Set<PdfDigitalLine> {
  const edgeKey = (line: PdfDigitalLine) =>
    `${Math.round(line.baseline)}|${normalizeTextForMatching(line.text).replace(/\d+/g, '#')}`;

  const counts = new Map<string, number>();
  for (const page of pages) {
    const edges = new Set([page.lines[0], page.lines[page.lines.length - 1]].filter(Boolean));
    for (const line of edges) {
      const key = edgeKey(line);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.ceil(pages.length * 0.03));
  const isHeadingLine = (line: PdfDigitalLine) =>
    entries.some(
      (entry) =>
        entry.page === line.pageNumber &&
        line.baseline <= entry.y + 2 &&
        line.baseline >= Math.min(entry.y, line.baseline + 40) - 40
    );

  const margin = new Set<PdfDigitalLine>();
  for (const page of pages) {
    const edges = new Set([page.lines[0], page.lines[page.lines.length - 1]].filter(Boolean));
    for (const line of edges) {
      const isPageNumber = /^\d{1,4}$/.test(line.text) && parseInt(line.text, 10) === page.pageNumber;
      const repeats = (counts.get(edgeKey(line)) || 0) >= threshold;
      if (isPageNumber || (repeats && !isHeadingLine(line))) margin.add(line);
    }
  }
  return margin;
}

function computeMetrics(lines: PdfDigitalLine[]): Metrics {
  const fontChars = new Map<number, number>();
  for (const line of lines) fontChars.set(line.fontSize, (fontChars.get(line.fontSize) || 0) + line.text.length);
  const bodyFont = [...fontChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;

  const bodyLines = lines.filter((line) => Math.abs(line.fontSize - bodyFont) < 0.6);
  const starts = bodyLines.map((line) => Math.round(line.x));
  const left = modeOf(starts) ?? 0;

  const indentStarts = starts.filter((x) => x >= left + 8 && x <= left + 60);
  const indentMode = modeOf(indentStarts);
  const indentCount = indentStarts.filter((x) => x === indentMode).length;
  const indent = indentMode !== undefined && indentCount >= starts.length * 0.03 ? indentMode - left : null;

  const ends = bodyLines.map((line) => line.xEnd).sort((a, b) => a - b);
  const right = ends[Math.floor(ends.length * 0.9)] ?? 0;

  const gaps: number[] = [];
  for (let i = 1; i < bodyLines.length; i++) {
    const a = bodyLines[i - 1];
    const b = bodyLines[i];
    if (a.pageNumber === b.pageNumber) gaps.push(a.baseline - b.baseline);
  }
  gaps.sort((a, b) => a - b);
  const leading = gaps[gaps.length >> 1] ?? bodyFont * 1.2;

  // Lề trái riêng từng trang để chịu được lề chẵn/lẻ
  const byPage = new Map<number, number[]>();
  for (const line of bodyLines) {
    const list = byPage.get(line.pageNumber) || [];
    list.push(Math.round(line.x));
    byPage.set(line.pageNumber, list);
  }
  const pageLeft = new Map<number, number>();
  for (const [page, xs] of byPage) {
    const repeated = xs.filter((x) => xs.filter((other) => other === x).length >= 2);
    const candidate = repeated.length > 0 ? Math.min(...repeated) : left;
    pageLeft.set(page, Math.abs(candidate - left) <= 30 ? candidate : left);
  }

  return { bodyFont, left, indent, right, leading, pageLeft };
}

function classifyLine(line: PdfDigitalLine, metrics: Metrics): LineKind {
  const left = metrics.pageLeft.get(line.pageNumber) ?? metrics.left;
  const offset = line.x - left;
  if (metrics.indent === null) return offset < 12 ? 'continuation' : 'offset';
  if (offset < metrics.indent / 2) return 'continuation';
  return offset <= metrics.indent + 12 ? 'indented' : 'offset';
}

function alignmentOf(line: PdfDigitalLine, metrics: Metrics): 'center' | 'right' | undefined {
  const middle = (metrics.left + metrics.right) / 2;
  if (line.x > middle && line.xEnd >= metrics.right - 8) return 'right';
  if (Math.abs((line.x + line.xEnd) / 2 - middle) <= 14) return 'center';
  return undefined;
}

function startsNewBlock(previous: PdfDigitalLine, line: PdfDigitalLine, block: Block, metrics: Metrics): boolean {
  const kind = classifyLine(line, metrics);
  const lineBold = line.boldRatio >= 0.9;
  const previousBold = previous.boldRatio >= 0.9;
  const previousEnded = SENTENCE_END_REGEX.test(previous.text);
  const previousShort = previous.xEnd < metrics.right - metrics.bodyFont * 2;

  if (Math.abs(line.fontSize - previous.fontSize) > 0.8) return true;

  // Dòng lệch lề nhưng đang giữa câu không phải đoạn mới
  const continuesSentence = /^\p{Ll}/u.test(line.text) && !previousEnded && !/[,;]\s*$/.test(previous.text);
  if (block.align) return !continuesSentence && !(kind === 'offset' && lineBold && previousBold);
  if (kind === 'indented') return !continuesSentence;
  if (kind === 'offset') return previousEnded || lineBold !== previousBold;

  if (previousBold && !lineBold) return true;
  if (lineBold && !previousBold && (previousEnded || previousShort)) return true;
  if (previousShort && previousEnded) return true;

  // Tài liệu không thụt đầu dòng: dùng khoảng cách dòng để tách đoạn
  if (metrics.indent === null && previous.pageNumber === line.pageNumber) {
    return previous.baseline - line.baseline > metrics.leading * 1.4;
  }
  return false;
}

function buildBlocks(lines: PdfDigitalLine[], metrics: Metrics): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const line of lines) {
    const previous = current?.lines[current.lines.length - 1];
    if (!current || !previous || startsNewBlock(previous, line, current, metrics)) {
      const align = classifyLine(line, metrics) === 'offset' ? alignmentOf(line, metrics) : undefined;
      current = { lines: [line], align };
      blocks.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return blocks;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

function blockRuns(block: Block): Run[] {
  const runs: Run[] = [];
  block.lines.forEach((line, lineIndex) => {
    line.spans.forEach((span, spanIndex) => {
      let text = span.text;
      if (spanIndex === 0) {
        text = text.trimStart();
        const previousLine = block.lines[lineIndex - 1];
        if (previousLine && !ATTACHED_HYPHEN_REGEX.test(previousLine.text)) text = ` ${text}`;
      }
      if (spanIndex === line.spans.length - 1) text = text.trimEnd();

      const last = runs[runs.length - 1];
      if (last && last.bold === span.bold && last.italic === span.italic) last.text += text;
      else runs.push({ text, bold: span.bold, italic: span.italic });
    });
  });
  return runs;
}

function renderRuns(runs: Run[]): string {
  return runs
    .map((run) => {
      const text = run.text.replace(/\s+/g, ' ');
      const core = text.trim();
      if (!core) return text;
      let html = escapeXml(core);
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      const leading = /^\s/.test(text) ? ' ' : '';
      const trailing = /\s$/.test(text) ? ' ' : '';
      return `${leading}${html}${trailing}`;
    })
    .join('')
    .trim();
}

function plainText(runs: Run[]): string {
  return runs.map((run) => run.text).join('').replace(/\s+/g, ' ').trim();
}

function isSubHeading(block: Block, text: string, metrics: Metrics): boolean {
  if (block.align === 'right' || !/[\p{L}\p{N}]/u.test(text) || text.length > MAX_SUBHEADING_LENGTH) return false;
  const totalChars = block.lines.reduce((sum, line) => sum + line.text.length, 0);
  const boldChars = block.lines.reduce((sum, line) => sum + line.text.length * line.boldRatio, 0);
  return boldChars / totalChars >= 0.95 || (block.lines[0].fontSize > metrics.bodyFont + 1 && text.length <= 120);
}

function renderBlocks(blocks: Block[], metrics: Metrics): string {
  return blocks
    .map((block) => {
      const runs = blockRuns(block);
      const text = plainText(runs);
      if (!text) return '';
      const alignClass = block.align ? ` class="text-${block.align}"` : '';
      if (isSubHeading(block, text, metrics)) return `<h4${alignClass}>${escapeXml(text)}</h4>`;
      return `<p${alignClass}>${renderRuns(runs)}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

function isDisplayPage(lines: PdfDigitalLine[], metrics: Metrics): boolean {
  if (lines.length < 3) return false;
  const middle = (metrics.left + metrics.right) / 2;
  const centered = lines.filter((line) => Math.abs((line.x + line.xEnd) / 2 - middle) <= 16).length;
  return centered / lines.length >= DISPLAY_PAGE_RATIO;
}

function renderDisplayLines(lines: PdfDigitalLine[], metrics: Metrics): string {
  return lines
    .map((line) => {
      const className = line.fontSize >= metrics.bodyFont * 1.5 ? 'book-title' : 'text-center';
      return `<p class="${className}">${renderRuns(blockRuns({ lines: [line] }))}</p>`;
    })
    .join('\n');
}

function renderPages(lines: PdfDigitalLine[], metrics: Metrics): string {
  const pages = new Map<number, PdfDigitalLine[]>();
  for (const line of lines) {
    const list = pages.get(line.pageNumber) || [];
    list.push(line);
    pages.set(line.pageNumber, list);
  }
  return [...pages.values()]
    .map((pageLines) =>
      isDisplayPage(pageLines, metrics)
        ? renderDisplayLines(pageLines, metrics)
        : renderBlocks(buildBlocks(pageLines, metrics), metrics)
    )
    .join('\n');
}

/** Tách phần còn lại của dòng sau các đoạn chữ đầu dòng khớp đúng với tiêu đề */
function splitLineAfterPrefix(line: PdfDigitalLine, prefix: string): PdfDigitalLine | null {
  let text = '';
  for (let i = 0; i < line.spans.length - 1; i++) {
    text += line.spans[i].text;
    if (normalizeTextForMatching(text) !== prefix) continue;

    const spans = line.spans.slice(i + 1);
    const totalChars = spans.reduce((sum, span) => sum + span.text.length, 0);
    const boldChars = spans.filter((span) => span.bold).reduce((sum, span) => sum + span.text.length, 0);
    return {
      ...line,
      spans,
      x: spans[0].x,
      text: spans.map((span) => span.text).join('').replace(/\s+/g, ' ').trim(),
      boldRatio: totalChars ? boldChars / totalChars : 0
    };
  }
  return null;
}

/** Tìm dòng tiêu đề từ vị trí link trỏ tới (link có thể trỏ lệch lên phía trước tiêu đề) */
function locateHeading(
  lines: PdfDigitalLine[],
  entry: PdfNavEntry,
  from: number
): { start: number; bodyStart: number; matched: boolean } {
  let origin = from;
  while (
    origin < lines.length &&
    (lines[origin].pageNumber < entry.page ||
      (lines[origin].pageNumber === entry.page && lines[origin].baseline > entry.y + 2))
  ) {
    origin++;
  }

  const title = normalizeTextForMatching(entry.title);
  const limit = Math.min(lines.length, origin + HEADING_SEARCH_LINES);

  for (let start = origin; start < limit; start++) {
    if (lines[start].pageNumber > entry.page + 1) break;
    const first = normalizeTextForMatching(lines[start].text);
    if (!first) continue;

    // Tiêu đề và câu dẫn đầu chương có thể nằm chung một dòng
    if (first.startsWith(`${title} `)) {
      const remainder = splitLineAfterPrefix(lines[start], title);
      if (remainder) {
        lines[start] = remainder;
        return { start, bodyStart: start, matched: true };
      }
    }

    const isPrefix = title.startsWith(first) && first.length >= Math.min(3, title.length);
    if (!isPrefix && calculateTextSimilarity(first, title) < 0.85) continue;

    let accumulated = first;
    let bodyStart = start + 1;
    while (accumulated !== title && bodyStart < lines.length) {
      const next = normalizeTextForMatching(lines[bodyStart].text);
      const candidate = `${accumulated} ${next}`.trim();
      if (next && !title.startsWith(candidate)) {
        const rest = title.slice(accumulated.length).trim();
        const remainder = rest && next.startsWith(`${rest} `) ? splitLineAfterPrefix(lines[bodyStart], rest) : null;
        if (remainder) {
          lines[bodyStart] = remainder;
          accumulated = title;
        }
        break;
      }
      if (!next) break;
      accumulated = candidate;
      bodyStart++;
    }

    // Dòng mới chỉ là phần đầu của tiêu đề thì phải ghép được gần đủ mới tính là khớp
    if (calculateTextSimilarity(accumulated, title) >= 0.85) return { start, bodyStart, matched: true };
  }

  return { start: origin, bodyStart: origin, matched: false };
}

function toTitleCase(text: string): string {
  if (/\p{Ll}/u.test(text)) return text;
  return text
    .toLocaleLowerCase('vi')
    .replace(/(^|[\s(“"-])(\p{L})/gu, (_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('vi')}`);
}

function isUsableDocumentTitle(title?: string): title is string {
  return Boolean(title && title.length > 3 && !/\.(?:docx?|pdf|indd)$/i.test(title) && !/^untitled/i.test(title));
}

function extractMetadata(
  frontLines: PdfDigitalLine[],
  metrics: Metrics,
  extraction: PdfDigitalExtraction,
  fallbackTitle: string
): DigitalBookMetadata {
  const firstPage = frontLines[0]?.pageNumber;
  const titlePageLines = frontLines.filter(
    (line) => line.pageNumber === firstPage && /\p{L}/u.test(line.text)
  );

  let printedTitle: string | undefined;
  let author: string | undefined;

  if (titlePageLines.length > 0 && isDisplayPage(frontLines.filter((l) => l.pageNumber === firstPage), metrics)) {
    const largest = Math.max(...titlePageLines.map((line) => line.fontSize));
    if (largest >= metrics.bodyFont * 1.3) {
      const firstIndex = titlePageLines.findIndex((line) => line.fontSize === largest);
      let endIndex = firstIndex;
      while (endIndex + 1 < titlePageLines.length && titlePageLines[endIndex + 1].fontSize >= largest * 0.75) {
        endIndex++;
      }
      printedTitle = titlePageLines
        .slice(firstIndex, endIndex + 1)
        .map((line) => line.text)
        .join(' ');

      const authorLine = titlePageLines
        .slice(0, firstIndex)
        .find((line) => !/nhà\s*xuất\s*bản|dịch|^nxb/iu.test(line.text));
      if (authorLine) author = toTitleCase(authorLine.text).replace(/\s+-\s+/g, ', ');
    }
  }

  const title = isUsableDocumentTitle(extraction.info.title)
    ? extraction.info.title
    : printedTitle
      ? toTitleCase(printedTitle)
      : fallbackTitle;

  return { title, author };
}

function wordsOf(text: string): string[] {
  return normalizeTextForMatching(text).split(' ').filter(Boolean);
}

function buildReport(
  navigation: PdfDigitalNavigation,
  located: LocatedEntry[],
  sourceLines: PdfDigitalLine[],
  chapters: ChapterDraft[],
  margin: Set<PdfDigitalLine>,
  extraction: PdfDigitalExtraction,
  coverPage: number | null
): DigitalStructureReport {
  const sourceWords = wordsOf(sourceLines.map((line) => line.text).join(' '));
  const outputText = chapters.map((c) => c.htmlBody.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')).join(' ');
  const outputWords = wordsOf(outputText);

  const available = new Map<string, number>();
  for (const word of outputWords) available.set(word, (available.get(word) || 0) + 1);

  let matchedWords = 0;
  const missing = new Map<string, number>();
  for (const word of sourceWords) {
    const count = available.get(word) || 0;
    if (count > 0) {
      available.set(word, count - 1);
      matchedWords++;
    } else {
      missing.set(word, (missing.get(word) || 0) + 1);
    }
  }

  const marginLines = [...margin];
  return {
    navSource: navigation.source,
    tocEntries: located.length,
    matchedHeadings: located.filter((item) => item.matched).length,
    unmatchedHeadings: located
      .filter((item) => !item.matched)
      .map((item) => ({ title: item.entry.title, page: item.entry.page })),
    sourceWords: sourceWords.length,
    outputWords: outputWords.length,
    matchedWords,
    coverage: sourceWords.length ? matchedWords / sourceWords.length : 1,
    topMissingWords: [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    removedMarginLines: marginLines.length,
    removedMarginSamples: marginLines
      .filter((line) => !/^\d+$/.test(line.text))
      .slice(0, 15)
      .map((line) => `p${line.pageNumber}: ${line.text}`),
    pagesWithInlineImages: extraction.pages
      .filter((page) => page.imageCount > 0 && page.pageNumber !== coverPage)
      .map((page) => page.pageNumber)
  };
}

/**
 * Dựng danh sách file EPUB từ PDF số: mỗi mục lục là một file,
 * nội dung của mục được cắt theo vị trí từ tiêu đề của nó đến tiêu đề kế tiếp.
 */
export function structureDigitalBook(
  extraction: PdfDigitalExtraction,
  navigation: PdfDigitalNavigation,
  options: DigitalStructureOptions
): DigitalStructureResult {
  const { pages } = extraction;
  const margin = findMarginLines(pages, navigation.entries);

  const firstPage = pages[0];
  const textChars = firstPage?.lines.filter((l) => !margin.has(l)).reduce((n, l) => n + l.text.length, 0) ?? 0;
  const coverPage = firstPage && firstPage.imageCount > 0 && textChars <= 20 ? firstPage.pageNumber : null;

  const contentLines = pages
    .flatMap((page) => page.lines)
    .filter(
      (line) => !margin.has(line) && !isInTocRegion(line, navigation.tocRegion) && line.pageNumber !== coverPage
    );
  const metrics = computeMetrics(contentLines);

  const originalLines = [...contentLines]; // locateHeading có thể tách dòng trong contentLines
  const located: LocatedEntry[] = [];
  let cursor = 0;
  for (const entry of navigation.entries) {
    const { start, bodyStart, matched } = locateHeading(contentLines, entry, cursor);
    located.push({ entry, start, bodyStart, matched });
    cursor = bodyStart;
  }

  const inRange = (line: PdfDigitalLine) =>
    line.pageNumber >= options.startPage && line.pageNumber <= options.endPage;

  const frontLines = contentLines.slice(0, located[0]?.start ?? contentLines.length);
  const metadata = extractMetadata(frontLines, metrics, extraction, options.fallbackTitle);

  const chapters: ChapterDraft[] = [];
  const nextId = () => `part${String(chapters.length + 1).padStart(4, '0')}`;

  const frontInRange = frontLines.filter(inRange);
  if (frontInRange.length > 0) {
    chapters.push({
      id: nextId(),
      title: FRONT_MATTER_TITLE,
      level: 1,
      frontMatter: true,
      htmlBody: `<div class="pdf-front-matter">\n${renderPages(frontInRange, metrics)}\n</div>`
    });
  }

  let backLines: PdfDigitalLine[] = [];

  located.forEach((item, index) => {
    const end = located[index + 1]?.start ?? contentLines.length;
    let body = contentLines.slice(item.bodyStart, end);

    if (index === located.length - 1) {
      // Trang thông tin xuất bản ở cuối sách không thuộc mục cuối cùng
      const lastPage = body[body.length - 1]?.pageNumber;
      const tail = body.filter((line) => line.pageNumber === lastPage);
      if (lastPage && lastPage > item.entry.page && isDisplayPage(tail, metrics)) {
        backLines = tail;
        body = body.filter((line) => line.pageNumber !== lastPage);
      }
    }

    const bodyInRange = body.filter(inRange);
    const headingInRange = item.entry.page >= options.startPage && item.entry.page <= options.endPage;
    if (bodyInRange.length === 0 && !headingInRange) return;

    const level = item.entry.level;
    const heading = `<h${level} class="pdf-toc-heading">${escapeXml(item.entry.title)}</h${level}>`;
    chapters.push({
      id: nextId(),
      title: item.entry.title,
      level,
      htmlBody: `${heading}\n${renderBlocks(buildBlocks(bodyInRange, metrics), metrics)}`
    });
  });

  const backInRange = backLines.filter(inRange);
  if (backInRange.length > 0) {
    chapters.push({
      id: nextId(),
      title: BACK_MATTER_TITLE,
      level: 1,
      htmlBody: `<div class="pdf-front-matter">\n${renderDisplayLines(backInRange, metrics)}\n</div>`
    });
  }

  const sourceLines = originalLines.filter(inRange);
  const report = buildReport(navigation, located, sourceLines, chapters, margin, extraction, coverPage);

  return { chapters, metadata, hasCoverPage: coverPage !== null, report };
}
