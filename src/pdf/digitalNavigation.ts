import { calculateTextSimilarity, normalizeTextForMatching } from './tocParser.js';
import type {
  PdfDigitalExtraction,
  PdfDigitalLine,
  PdfDigitalNavigation,
  PdfDigitalPage,
  PdfLinkAnnotation,
  PdfNavEntry,
  PdfTocRegion
} from './types.js';

const TOC_TITLE_REGEX = /^\s*(?:mục\s*lục|table\s+of\s+contents|contents)\s*$/iu;
const LEADER_WITH_NUMBER_REGEX = /[.…·_]{3,}\s*(\d{1,4})?\s*$/u;
const NEW_ITEM_REGEX = /^\s*(?:\d+\.|[IVXLCDM]+\.|(?:phần|chương|tiết|mục)\s+\S|lời\s+\S)/iu;
const MIN_LINKS_PER_TOC_PAGE = 3;
const MIN_ENTRIES = 3;
const MAX_TOC_LEVEL = 3;

/**
 * Xác định cấu trúc mục lục của PDF số theo độ tin cậy giảm dần:
 * bookmark -> link trong trang mục lục -> mục lục dạng text.
 */
export function buildDigitalNavigation(extraction: PdfDigitalExtraction): PdfDigitalNavigation {
  const fromLinks = navigationFromLinks(extraction);
  const fromText = fromLinks ? null : navigationFromText(extraction.pages);
  const tocRegion = fromLinks?.tocRegion ?? fromText?.tocRegion;

  if (extraction.outline.length >= MIN_ENTRIES) {
    return {
      source: 'outline',
      tocRegion,
      entries: extraction.outline.map((node) => ({
        title: tidyTitle(node.title),
        level: Math.min(node.depth + 1, MAX_TOC_LEVEL),
        page: node.page,
        y: node.y
      }))
    };
  }
  if (fromLinks) return fromLinks;
  if (fromText) return fromText;
  return { source: 'none', entries: [] };
}

function tidyTitle(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .replace(/\s+:/g, ':')
    .replace(/:(?=\p{L})/gu, ': ')
    .trim();
}

/** Bỏ dải dấu chấm và số trang ở cuối dòng mục lục */
function stripPageReference(line: PdfDigitalLine): { text: string; hadReference: boolean } {
  if (LEADER_WITH_NUMBER_REGEX.test(line.text)) {
    return { text: line.text.replace(LEADER_WITH_NUMBER_REGEX, '').trim(), hadReference: true };
  }
  const { spans } = line;
  if (spans.length >= 2) {
    const last = spans[spans.length - 1];
    const previous = spans[spans.length - 2];
    const isDetachedNumber = /^\s*\d{1,4}\s*$/.test(last.text) && last.x - (previous.x + previous.width) >= 15;
    if (isDetachedNumber) {
      return { text: line.text.replace(/\s*\d{1,4}\s*$/, '').trim(), hadReference: true };
    }
  }
  return { text: line.text.trim(), hadReference: false };
}

/** Quy đổi toạ độ thụt lề của các mục thành cấp mục lục (lề trái nhất = cấp 1) */
function levelsFromIndents(indents: number[]): number[] {
  const clusters: number[] = [];
  for (const x of [...indents].sort((a, b) => a - b)) {
    if (clusters.length === 0 || x - clusters[clusters.length - 1] > 4) clusters.push(x);
  }
  return indents.map((x) => {
    let index = 0;
    while (index + 1 < clusters.length && x - clusters[index + 1] > -4) index++;
    return Math.min(index + 1, MAX_TOC_LEVEL);
  });
}

function findTocRun(links: PdfLinkAnnotation[]): number[] {
  const counts = new Map<number, number>();
  for (const link of links) counts.set(link.page, (counts.get(link.page) || 0) + 1);

  const candidates = [...counts.entries()]
    .filter(([, count]) => count >= MIN_LINKS_PER_TOC_PAGE)
    .map(([page]) => page)
    .sort((a, b) => a - b);

  let best: number[] = [];
  let run: number[] = [];
  const total = (pages: number[]) => pages.reduce((sum, p) => sum + (counts.get(p) || 0), 0);
  for (const page of candidates) {
    run = run.length > 0 && page === run[run.length - 1] + 1 ? [...run, page] : [page];
    if (total(run) > total(best)) best = run;
  }
  return best;
}

function navigationFromLinks(extraction: PdfDigitalExtraction): PdfDigitalNavigation | null {
  const tocPages = findTocRun(extraction.links);
  if (tocPages.length === 0) return null;

  const tocPageSet = new Set(tocPages);
  const links = extraction.links
    .filter((link) => tocPageSet.has(link.page))
    .sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3]);

  interface Draft {
    text: string;
    x: number;
    page: number;
    y: number;
    hadReference: boolean;
    lineKey: string;
  }
  const drafts: Draft[] = [];

  for (const link of links) {
    const page = extraction.pages[link.page - 1];
    const line = page.lines.find(
      (candidate) => candidate.baseline >= link.rect[1] - 1 && candidate.baseline <= link.rect[3]
    );
    if (!line) continue;

    const { text, hadReference } = stripPageReference(line);
    const lineKey = `${link.page}:${Math.round(line.baseline)}`;
    const previous = drafts[drafts.length - 1];
    const sameTarget = previous && previous.page === link.targetPage && previous.y === link.targetY;

    // Một dòng mục lục có thể gồm nhiều link liền nhau
    if (previous && previous.lineKey === lineKey) continue;

    // Tiêu đề dài xuống dòng tạo thêm link cùng đích đến
    if (sameTarget && !previous.hadReference && !NEW_ITEM_REGEX.test(text)) {
      previous.text = `${previous.text} ${text}`;
      previous.hadReference = hadReference;
      previous.lineKey = lineKey;
      continue;
    }
    if (!text) continue;

    drafts.push({ text, x: line.x, page: link.targetPage, y: link.targetY, hadReference, lineKey });
  }

  if (drafts.length < MIN_ENTRIES) return null;

  const levels = levelsFromIndents(drafts.map((d) => d.x));
  const entries: PdfNavEntry[] = drafts.map((d, index) => ({
    title: tidyTitle(d.text),
    level: levels[index],
    page: d.page,
    y: d.y
  }));

  return { source: 'links', entries, tocRegion: tocRegionFromLinks(extraction.pages, links, tocPages) };
}

function tocRegionFromLinks(
  pages: PdfDigitalPage[],
  links: PdfLinkAnnotation[],
  tocPages: number[]
): PdfTocRegion {
  const firstPage = tocPages[0];
  const lastPage = tocPages[tocPages.length - 1];
  const firstLinkTop = Math.max(...links.filter((l) => l.page === firstPage).map((l) => l.rect[3]));
  const lastLinkBottom = Math.min(...links.filter((l) => l.page === lastPage).map((l) => l.rect[1]));

  const titleLine = pages[firstPage - 1].lines.find((line) => TOC_TITLE_REGEX.test(line.text));
  return {
    startPage: firstPage,
    startY: titleLine ? titleLine.baseline : firstLinkTop,
    endPage: lastPage,
    endY: lastLinkBottom
  };
}

/** Mục lục chỉ có chữ: mỗi mục kết thúc bằng dải chấm hoặc số trang tách xa tiêu đề */
function navigationFromText(pages: PdfDigitalPage[]): PdfDigitalNavigation | null {
  const titlePageIndex = pages.findIndex((page) =>
    page.lines.slice(0, 5).some((line) => TOC_TITLE_REGEX.test(line.text))
  );
  if (titlePageIndex === -1) return null;

  interface Draft {
    title: string;
    x: number;
    printedPage: number;
  }
  const drafts: Draft[] = [];
  let endPage = titlePageIndex;
  let endY = 0;

  for (let index = titlePageIndex; index < pages.length; index++) {
    const lines = pages[index].lines.filter((line) => !TOC_TITLE_REGEX.test(line.text));
    const parsed = lines.map(stripPageReference);
    const referenceCount = parsed.filter((item) => item.hadReference).length;
    if (referenceCount < 3) break;

    let pending = '';
    let pendingX: number | null = null;
    lines.forEach((line, lineIndex) => {
      const { text, hadReference } = parsed[lineIndex];
      if (!hadReference) {
        if (/^\d{1,4}$/.test(text)) return;
        pending = pending ? `${pending} ${text}` : text;
        pendingX ??= line.x;
        return;
      }
      const printedPage = parseInt(line.text.match(/(\d{1,4})\s*$/)?.[1] || '', 10);
      if (Number.isFinite(printedPage)) {
        drafts.push({
          title: tidyTitle(pending ? `${pending} ${text}` : text),
          x: pendingX ?? line.x,
          printedPage
        });
      }
      pending = '';
      pendingX = null;
      endPage = index;
      endY = line.baseline;
    });
  }

  if (drafts.length < MIN_ENTRIES) return null;

  const offset = bestPageOffset(pages, drafts);
  const levels = levelsFromIndents(drafts.map((d) => d.x));
  const titleLine = pages[titlePageIndex].lines.find((line) => TOC_TITLE_REGEX.test(line.text))!;

  return {
    source: 'text',
    entries: drafts.map((d, index) => ({
      title: d.title,
      level: levels[index],
      page: Math.min(pages.length, Math.max(1, d.printedPage + offset)),
      y: Number.POSITIVE_INFINITY
    })),
    tocRegion: {
      startPage: titlePageIndex + 1,
      startY: titleLine.baseline,
      endPage: endPage + 1,
      endY
    }
  };
}

/** Tìm độ lệch giữa số trang in và số trang PDF sao cho nhiều tiêu đề khớp nhất */
function bestPageOffset(pages: PdfDigitalPage[], drafts: { title: string; printedPage: number }[]): number {
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = -10; offset <= 30; offset++) {
    let score = 0;
    for (const draft of drafts) {
      const page = pages[draft.printedPage + offset - 1];
      if (!page) continue;
      const title = normalizeTextForMatching(draft.title);
      if (page.lines.some((line) => calculateTextSimilarity(line.text, title) >= 0.8)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}
