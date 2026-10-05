import path from 'node:path';
import * as cheerio from 'cheerio';
import type { UnpackedEpub } from './epubArchive.js';
import type { OpfManager } from './opfManager.js';

export const CHAPTER_REGEX = /^\s*(chương|hồi|tiết|phần|quyển|tập|chapter|part|book)\s+([0-9]+|[ivxlcdm]+|thứ\s+\w+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|nhất|nhì|tam|tứ|ngũ|lục|thất|bát|cửu|thập)\b/i;

export interface ChapterBoundary {
  elementIndex: number;
  title: string;
  anchorId?: string;
}

/**
 * Kiểm tra xem một file XHTML có phải là trang Mục Lục (TOC) hay không
 */
export function isTableOfContentsFile(htmlContent: string, relativeHref: string, ncxTocLabel?: string): boolean {
  const lowerName = relativeHref.toLowerCase();
  if (lowerName.includes('toc') || lowerName.includes('mục_lục') || lowerName.includes('muc_luc')) {
    return true;
  }

  if (ncxTocLabel && /^\s*(mục\s*lục|table\s*of\s*contents|contents|danh\s*mục)\s*$/i.test(ncxTocLabel.trim())) {
    return true;
  }

  const $ = cheerio.load(htmlContent, { xml: { decodeEntities: false } });

  // 1. Kiểm tra tiêu đề hoặc heading đầu tiên
  const title = $('title').text().trim().toLowerCase();
  const firstHeading = $('h1, h2, h3').first().text().trim().toLowerCase();
  const isTitleToc =
    /^\s*(mục\s*lục|table\s*of\s*contents|contents|danh\s*mục)\s*$/i.test(title) ||
    /^\s*(mục\s*lục|table\s*of\s*contents|contents|danh\s*mục)\s*$/i.test(firstHeading) ||
    firstHeading.includes('mục lục') ||
    firstHeading.includes('table of contents');

  // 2. Kiểm tra tỉ lệ liên kết nội bộ
  const links = $('a[href]');
  const internalLinks = links.filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.endsWith('.html') || href.endsWith('.xhtml') || href.includes('.html#') || href.includes('.xhtml#') || href.startsWith('#');
  });

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const linkText = internalLinks.text().replace(/\s+/g, ' ').trim();

  // Nếu có từ 3 liên kết nội bộ trở lên và phần lớn văn bản là các liên kết
  if (internalLinks.length >= 3) {
    if (isTitleToc) return true;
    if (bodyText.length > 0 && linkText.length / bodyText.length > 0.4) {
      return true;
    }
  }

  if (isTitleToc && (internalLinks.length >= 2 || bodyText.length < 2000)) {
    return true;
  }

  return false;
}

/**
 * Phát hiện các mốc phân chia chương (chapter boundaries) bên trong một file XHTML
 */
export function detectChapterBoundaries(
  htmlContent: string,
  relativeHref: string,
  knownAnchorIds: string[] = []
): { containerSelector: string; boundaries: ChapterBoundary[] } {
  // Bỏ qua các file quá ngắn (< 3000 byte) vì không thể chứa nhiều chương nội dung
  if (htmlContent.length < 3000) {
    return { containerSelector: 'body', boundaries: [] };
  }

  const $ = cheerio.load(htmlContent, { xml: { decodeEntities: false } });

  // Xác định container chứa nội dung chính
  let containerSelector = 'body';
  if ($('body > div.calibre1').length > 0) {
    containerSelector = 'body > div.calibre1';
  } else if ($('body > div').length === 1 && $('body > *').length === 1) {
    containerSelector = 'body > div';
  }

  const container = $(containerSelector);
  const children = container.children().toArray();
  if (children.length === 0) {
    return { containerSelector: 'body', boundaries: [] };
  }

  const rawBoundaries: ChapterBoundary[] = [];

  children.forEach((el, idx) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Tìm anchor id trong phần tử hoặc con của nó
    const directId = $el.attr('id');
    const childId = $el.find('a[id], [id]').attr('id');
    const anchorId = directId || childId;

    const isHeadingTag = $el.is('h1, h2, h3, h4, h5, h6');
    const isH1 = $el.is('h1');
    const isExplicitHeadingClass = /\b(title|heading|chapter|part)\b/i.test($el.attr('class') || '');
    const matchesChapterRegex = CHAPTER_REGEX.test(text);

    // Tiêu chí 1: Thẻ heading rõ ràng hoặc class heading khớp với "Chương X", "Chapter X"
    if (matchesChapterRegex && (isHeadingTag || isExplicitHeadingClass)) {
      rawBoundaries.push({
        elementIndex: idx,
        title: text.slice(0, 80),
        anchorId
      });
      return;
    }

    // Tiêu chí 2: Có anchor ID trùng với anchor cấp cao (top-level) trong toc.ncx VÀ (khớp regex chương hoặc là H1/H2)
    if (anchorId && knownAnchorIds.includes(anchorId) && (matchesChapterRegex || isH1 || $el.is('h2'))) {
      rawBoundaries.push({
        elementIndex: idx,
        title: text.slice(0, 80),
        anchorId
      });
    }
  });

  // Lọc lại các boundary để đảm bảo giữa các chương có nội dung văn bản đáng kể (>= 300 ký tự)
  const validBoundaries: ChapterBoundary[] = [];
  for (let i = 0; i < rawBoundaries.length; i++) {
    const current = rawBoundaries[i];
    const next = rawBoundaries[i + 1];

    if (!next) {
      // Đoạn từ current đến hết file
      const sliceChildren = children.slice(current.elementIndex);
      const sliceText = sliceChildren.map((c) => $(c).text().trim()).join(' ');
      if (sliceText.length >= 300) {
        validBoundaries.push(current);
      }
    } else {
      // Đoạn từ current đến next
      const sliceChildren = children.slice(current.elementIndex, next.elementIndex);
      const sliceText = sliceChildren.map((c) => $(c).text().trim()).join(' ');
      if (sliceText.length >= 300) {
        validBoundaries.push(current);
      }
    }
  }

  return { containerSelector, boundaries: validBoundaries };
}

/**
 * Tách một file HTML chứa nhiều chương thành các file HTML riêng biệt
 */
export function splitMultiChapterFiles(
  unpacked: UnpackedEpub,
  opfManager: OpfManager
): { splitFilesCount: number; newChaptersCount: number } {
  const pkg = opfManager.getPackageInfo();
  const spineChapterFiles = opfManager.getSpineChapterFiles();

  // Đọc toc.ncx nếu có để lấy các anchor đã biết trỏ vào từng file
  const knownAnchorsByFile = new Map<string, string[]>();
  let ncxTocMap = new Map<string, string>(); // relativeHref -> label

  if (pkg.tocHref) {
    const ncxZipPath = opfManager.resolvePathInZip(pkg.tocHref);
    if (unpacked.hasFile(ncxZipPath)) {
      try {
        const ncxXml = unpacked.getFileString(ncxZipPath);
        const $ncx = cheerio.load(ncxXml, { xmlMode: true });
        // Chỉ lấy các navPoint cấp cao nhất (con trực tiếp của navMap), tuyệt đối không lấy navPoint lồng nhau (tiểu mục H2/H3)
        $ncx('navMap > navPoint').each((_, np) => {
          const $np = $ncx(np);
          const src = $np.find('> content').attr('src') || $np.children('content').attr('src');
          const label = $np.find('> navLabel > text').text().trim() || $np.children('navLabel').children('text').text().trim();
          if (src) {
            const [filePart, hashPart] = src.split('#');
            if (filePart) {
              if (hashPart) {
                const list = knownAnchorsByFile.get(filePart) || [];
                list.push(hashPart);
                knownAnchorsByFile.set(filePart, list);
              }
              if (label && !hashPart) {
                ncxTocMap.set(filePart, label);
              }
            }
          }
        });
      } catch {
        // ignore
      }
    }
  }

  let splitFilesCount = 0;
  let newChaptersCount = 0;

  // Bản đồ ánh xạ anchor cũ sang file mới: [oldFile#anchor] -> [newFile#anchor]
  const anchorHrefRemap = new Map<string, string>();

  for (const ch of spineChapterFiles) {
    if (!unpacked.hasFile(ch.zipPath)) continue;

    const lowerHref = ch.relativeHref.toLowerCase();
    if (lowerHref.includes('titlepage') || lowerHref.includes('cover')) continue;

    // Không bao giờ tách các file đã được phân tách thành part trước đó để tránh vòng lặp tách vô hạn
    if (/_part\d+\./i.test(ch.relativeHref)) continue;

    const html = unpacked.getFileString(ch.zipPath);

    // Bỏ qua trang mục lục
    if (isTableOfContentsFile(html, ch.relativeHref, ncxTocMap.get(ch.relativeHref))) {
      continue;
    }

    const knownAnchors = knownAnchorsByFile.get(ch.relativeHref) || [];

    // Nếu sách đã có cấu trúc nhiều file (>= 3 file trong spine)
    // thì tuyệt đối không tự động tách một file riêng lẻ trừ khi toc.ncx chỉ định rõ có >= 2 anchor cấp cao trong file đó
    if (spineChapterFiles.length >= 3 && knownAnchors.length < 2) {
      continue;
    }

    const { containerSelector, boundaries } = detectChapterBoundaries(html, ch.relativeHref, knownAnchors);

    // Nếu chỉ có 0 hoặc 1 chương thì không cần tách file
    if (boundaries.length < 2) {
      continue;
    }

    console.log(`\n✂️ Phát hiện file "${ch.relativeHref}" chứa ${boundaries.length} chương nằm chung:`);
    for (const b of boundaries) {
      console.log(`   - [${b.title}] (vị trí phần tử: ${b.elementIndex}${b.anchorId ? `, id: #${b.anchorId}` : ''})`);
    }

    const $ = cheerio.load(html, { xml: { decodeEntities: false } });
    const headHtml = $('head').html() || '';
    const bodyAttrs = $('body').attr() || {};
    const container = $(containerSelector);
    const containerAttrs = container.attr() || {};
    const children = container.children().toArray();

    const baseExt = path.extname(ch.relativeHref);
    const baseNameWithoutExt = ch.relativeHref.slice(0, -baseExt.length);

    // Chuẩn bị các lát cắt (slices)
    const slices: Array<{
      startIdx: number;
      endIdx: number;
      boundary: ChapterBoundary;
      fileName: string;
      isOriginalFile: boolean;
    }> = [];

    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      const startIdx = (i === 0) ? 0 : b.elementIndex;
      const endIdx = (i === boundaries.length - 1) ? children.length : boundaries[i + 1].elementIndex;
      const isOriginalFile = (i === 0);
      const fileName = isOriginalFile
        ? ch.relativeHref
        : `${baseNameWithoutExt}_part${i + 1}${baseExt}`;

      slices.push({
        startIdx,
        endIdx,
        boundary: b,
        fileName,
        isOriginalFile
      });
    }

    // Tạo nội dung cho từng file con
    const newItemsToRegister: Array<{ id: string; href: string }> = [];

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const sliceChildren = children.slice(slice.startIdx, slice.endIdx);
      const sliceHtml = sliceChildren.map((el) => $.html(el)).join('\n');

      // Thu thập tất cả các id/anchor trong slice này để cập nhật remapping
      const $sliceDom = cheerio.load(`<div>${sliceHtml}</div>`, { xml: { decodeEntities: false } });
      $sliceDom('[id]').each((_, el) => {
        const id = $sliceDom(el).attr('id');
        if (id) {
          anchorHrefRemap.set(`${ch.relativeHref}#${id}`, `${slice.fileName}#${id}`);
        }
      });

      // Tạo cấu trúc XHTML hoàn chỉnh
      let sliceDoc = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"\n  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n  <title>${escapeXml(slice.boundary.title)}</title>\n  ${headHtml.replace(/<title>[^<]*<\/title>/i, '')}\n</head>\n<body`;

      for (const [k, v] of Object.entries(bodyAttrs)) {
        sliceDoc += ` ${k}="${v}"`;
      }
      sliceDoc += `>\n`;

      if (containerSelector !== 'body') {
        const tag = (container[0] as any).tagName?.toLowerCase() || 'div';
        sliceDoc += `<${tag}`;
        for (const [k, v] of Object.entries(containerAttrs)) {
          sliceDoc += ` ${k}="${v}"`;
        }
        sliceDoc += `>\n${sliceHtml}\n</${tag}>\n`;
      } else {
        sliceDoc += `${sliceHtml}\n`;
      }

      sliceDoc += `</body>\n</html>`;

      // Ghi file
      const zipPath = opfManager.resolvePathInZip(slice.fileName);
      unpacked.setFileString(zipPath, sliceDoc);

      if (!slice.isOriginalFile) {
        const newId = `${ch.idref}_part${i + 1}`;
        newItemsToRegister.push({ id: newId, href: slice.fileName });
      }
    }

    // Cập nhật content.opf: Thêm manifest items và spine itemrefs qua OpfManager
    let lastRefId = ch.idref;
    for (const item of newItemsToRegister) {
      opfManager.ensureManifestItem(item.id, item.href, 'application/xhtml+xml');
      opfManager.addSpineItemAfter(lastRefId, item.id);
      lastRefId = item.id;
    }

    splitFilesCount++;
    newChaptersCount += newItemsToRegister.length;
    console.log(`   ✅ Đã tách thành công "${ch.relativeHref}" thành ${slices.length} file riêng biệt.`);
  }

  // Cập nhật liên kết anchor trên toàn bộ các file XHTML trong sách
  if (anchorHrefRemap.size > 0) {
    console.log(`\n🔗 Đang đồng bộ cập nhật ${anchorHrefRemap.size} liên kết chương đến các file mới...`);
    const allFiles = unpacked.listFiles();
    for (const f of allFiles) {
      if (!f.endsWith('.html') && !f.endsWith('.xhtml') && !f.endsWith('.ncx')) continue;
      let content = unpacked.getFileString(f);
      let changed = false;

      for (const [oldTarget, newTarget] of anchorHrefRemap.entries()) {
        if (content.includes(oldTarget)) {
          content = content.split(oldTarget).join(newTarget);
          changed = true;
        }
      }

      if (changed) {
        unpacked.setFileString(f, content);
      }
    }
  }

  if (splitFilesCount > 0) {
    opfManager.save();
  }

  return { splitFilesCount, newChaptersCount };
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
