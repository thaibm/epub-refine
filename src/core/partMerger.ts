import path from 'node:path';
import * as cheerio from 'cheerio';
import type { UnpackedEpub } from './epubArchive.js';
import type { OpfManager } from './opfManager.js';
import { isTableOfContentsFile } from './chapterSplitter.js';
import { FootnoteProcessor } from './footnoteProcessor.js';
import { ensureStandardStyles } from './styleManager.js';

/**
 * Regex phát hiện tiêu đề Phần / Quyển / Tập / Book / Part
 * Ví dụ: "Phần 1", "Phần I", "Phần thứ nhất", "Phần một", "Quyển 2", "Tập 3", "Book 1", "Part IV"
 */
export const PART_REGEX = /^\s*(phần|quyển|tập|book|part)\s+([0-9ivxlcdm]+|thứ\s+\w+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|nhất|nhì|tam|tứ|ngũ|lục|thất|bát|cửu|thập)\b/i;

/**
 * Regex phát hiện tiêu đề kết hợp Phần và Chương trong 1 dòng
 * Ví dụ: "Phần 1 - Chương 1", "Phần 2: Chương 1", "Part 1 - Chapter 1"
 */
export const COMBINED_PART_CHAPTER_REGEX = /^\s*(phần|quyển|tập|book|part)\s+([0-9ivxlcdm]+|\w+)\s*[-:–—]\s*(chương|hồi|tiết|chapter)\s+([0-9ivxlcdm]+|\w+)/i;

/**
 * Regex phát hiện tiêu đề Chương thuần túy
 * Ví dụ: "Chương 1", "Chương 2", "Hồi 3", "Chapter 4"
 */
export const CHAPTER_REGEX_STRICT = /^\s*(chương|hồi|tiết|chapter)\s+([0-9ivxlcdm]+|thứ\s+\w+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|nhất|nhì|tam|tứ|ngũ|lục|thất|bát|cửu|thập)\b/i;

export interface PartInfo {
  partTitle: string;
  files: string[];
  idrefs: string[];
}

export interface MergePartsResult {
  mergedPartsCount: number;
  totalChaptersMerged: number;
  partDetails: Array<{
    partTitle: string;
    targetFile: string;
    chaptersCount: number;
  }>;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Lấy container chứa nội dung chính trong DOM (tránh can thiệp nhầm vào cấu trúc calibre)
 */
function getContentContainer($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  if ($('body > div.calibre1').length > 0) {
    return $('body > div.calibre1');
  }
  if ($('body > div').length === 1 && $('body > *').length === 1) {
    return $('body > div');
  }
  return $('body');
}

/**
 * Kiểm tra xem một phần tử có phải là tiêu đề Phần hay không
 */
function detectPartInElement($el: cheerio.Cheerio<any>): {
  isPart: boolean;
  partTitle?: string;
  chapterTitle?: string;
} {
  const text = $el.text().replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80) {
    return { isPart: false };
  }

  // 1. Kiểm tra tiêu đề kết hợp: "Phần 3 - Chương 1"
  const combinedMatch = text.match(COMBINED_PART_CHAPTER_REGEX);
  if (combinedMatch) {
    const partNum = combinedMatch[2].trim();
    const chapNum = combinedMatch[4].trim();
    return {
      isPart: true,
      partTitle: `Phần ${partNum}`,
      chapterTitle: `Chương ${chapNum}`
    };
  }

  // 2. Kiểm tra tiêu đề Phần thuần túy: "Phần 1", "Phần 5", "Phần thứ nhất"
  if (PART_REGEX.test(text)) {
    return {
      isPart: true,
      partTitle: text
    };
  }

  return { isPart: false };
}

/**
 * Kiểm tra xem một file XHTML có chứa tiêu đề Phần hay không, và vị trí của nó
 */
function inspectFileForPart(
  htmlContent: string
): {
  hasPart: boolean;
  partTitle?: string;
  chapterTitle?: string;
  partElementIndex: number;
  totalElements: number;
  precedingTextLength: number;
  precedingParagraphsCount: number;
} {
  const $ = cheerio.load(htmlContent, { xml: { decodeEntities: false } });
  const container = getContentContainer($);
  const children = container.children().toArray();

  let precedingTextLength = 0;
  let precedingParagraphsCount = 0;

  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const $el = $(el);
    const tagName = (el as any).tagName?.toLowerCase() || '';

    // Bỏ qua div rỗng
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (tagName === 'div' && (!text || text === ' ' || text === '&#160;')) {
      continue;
    }

    const partCheck = detectPartInElement($el);
    if (partCheck.isPart) {
      return {
        hasPart: true,
        partTitle: partCheck.partTitle,
        chapterTitle: partCheck.chapterTitle,
        partElementIndex: i,
        totalElements: children.length,
        precedingTextLength,
        precedingParagraphsCount
      };
    }

    precedingTextLength += text.length;
    if (tagName === 'p') {
      precedingParagraphsCount++;
    }
  }

  return {
    hasPart: false,
    partElementIndex: -1,
    totalElements: children.length,
    precedingTextLength,
    precedingParagraphsCount
  };
}

/**
 * Tự động gộp các chương trong cùng một Phần (Phần => Chương) thành 1 file XHTML duy nhất.
 * Giảm số lượng file cần xử lý qua Gemini từ hàng trăm file xuống còn vài file (1 file/phần).
 */
export function mergePartChapters(
  unpacked: UnpackedEpub,
  opfManager: OpfManager
): MergePartsResult {
  const spineChapterFiles = opfManager.getSpineChapterFiles();

  // 1. Lọc các file nội dung thực tế (bỏ qua bìa, mục lục, chú thích)
  interface ContentFileInfo {
    idref: string;
    relativeHref: string;
    zipPath: string;
  }

  const contentFiles: ContentFileInfo[] = [];
  for (const ch of spineChapterFiles) {
    if (!unpacked.hasFile(ch.zipPath)) continue;
    const lowerHref = ch.relativeHref.toLowerCase();
    if (lowerHref.includes('titlepage') || lowerHref.includes('cover')) continue;

    const html = unpacked.getFileString(ch.zipPath);
    if (isTableOfContentsFile(html, ch.relativeHref)) continue;
    if (FootnoteProcessor.isFootnoteFile(html, ch.relativeHref)) continue;

    contentFiles.push(ch);
  }

  if (contentFiles.length < 3) {
    return { mergedPartsCount: 0, totalChaptersMerged: 0, partDetails: [] };
  }

  // 2. Quét để phát hiện các Phần và tách Lời mở đầu nếu nằm chung với Phần đầu tiên
  // Ví dụ: Chapter0001.html có "Lời giới thiệu" ở đầu, sau đó mới đến "Phần 1 - Chương 1"
  for (let i = 0; i < contentFiles.length; i++) {
    const ch = contentFiles[i];
    const html = unpacked.getFileString(ch.zipPath);
    const info = inspectFileForPart(html);

    if (info.hasPart && info.partElementIndex > 0 && (info.precedingParagraphsCount >= 2 || info.precedingTextLength >= 300)) {
      // Tách phần Lời giới thiệu / Mở đầu ra thành một file độc lập trước khi gộp
      console.log(`\n✂️ Phát hiện file "${ch.relativeHref}" chứa Lời mở đầu trước "${info.partTitle}", đang tách riêng...`);

      const $ = cheerio.load(html, { xml: { decodeEntities: false } });
      const container = getContentContainer($);
      const containerSelector = container[0] === $('body')[0] ? 'body' : 'body > div.calibre1';
      const containerAttrs = container.attr() || {};
      const bodyAttrs = $('body').attr() || {};
      const headHtml = $('head').html() || '';
      const children = container.children().toArray();

      const ext = path.extname(ch.relativeHref);
      const baseName = ch.relativeHref.slice(0, -ext.length);
      const introFileName = `${baseName}_intro${ext}`;
      const introZipPath = opfManager.resolvePathInZip(introFileName);

      // File Mở đầu (các phần tử trước Part)
      const introChildren = children.slice(0, info.partElementIndex);
      const $introFrag = cheerio.load(`<div>${introChildren.map((el) => $.html(el)).join('\n')}</div>`, { xml: { decodeEntities: false } });
      let introTitle = 'Lời mở đầu';
      const firstIntroHeading = $introFrag('h1, h2, h3, h4').first();
      if (firstIntroHeading.length > 0 && firstIntroHeading.text().trim()) {
        introTitle = firstIntroHeading.text().trim();
        firstIntroHeading.replaceWith(`<h1 id="intro-h1" class="chapter-h1">${escapeXml(introTitle)}</h1>`);
      } else {
        $introFrag('div').prepend(`<h1 id="intro-h1" class="chapter-h1">${escapeXml(introTitle)}</h1>`);
      }
      const introHtml = $introFrag('div').html() || '';

      let introDoc = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"\n  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n  <title>${escapeXml(introTitle)}</title>\n  ${headHtml.replace(/<title>[^<]*<\/title>/i, '')}\n</head>\n<body`;
      for (const [k, v] of Object.entries(bodyAttrs)) introDoc += ` ${k}="${v}"`;
      introDoc += `>\n`;
      if (containerSelector !== 'body') {
        const tag = (container[0] as any).tagName?.toLowerCase() || 'div';
        introDoc += `<${tag}`;
        for (const [k, v] of Object.entries(containerAttrs)) introDoc += ` ${k}="${v}"`;
        introDoc += `>\n${introHtml}\n</${tag}>\n`;
      } else {
        introDoc += `${introHtml}\n`;
      }
      introDoc += `</body>\n</html>`;

      unpacked.setFileString(introZipPath, introDoc);

      // File gốc: chỉ giữ lại từ Part trở đi
      for (let k = 0; k < info.partElementIndex; k++) {
        $(children[k]).remove();
      }
      unpacked.setFileString(ch.zipPath, $.xml());

      // Đăng ký file intro vào OPF ngay trước file gốc
      const introId = `${ch.idref}_intro`;
      opfManager.ensureManifestItem(introId, introFileName, 'application/xhtml+xml');
      opfManager.addSpineItemBefore(ch.idref, introId);
      opfManager.save();

      // Cập nhật lại danh sách contentFiles
      contentFiles.splice(i, 0, {
        idref: introId,
        relativeHref: introFileName,
        zipPath: introZipPath
      });
      i++; // Bỏ qua file gốc vừa tách
      console.log(`   ✅ Đã tạo file riêng "${introFileName}" cho phần mở đầu.`);
      break;
    }
  }

  // 3. Phân nhóm các file theo từng Phần
  const partsList: PartInfo[] = [];
  let currentPart: PartInfo | null = null;

  for (const ch of contentFiles) {
    const html = unpacked.getFileString(ch.zipPath);
    const info = inspectFileForPart(html);

    if (info.hasPart) {
      currentPart = {
        partTitle: info.partTitle || `Phần ${partsList.length + 1}`,
        files: [ch.relativeHref],
        idrefs: [ch.idref]
      };
      partsList.push(currentPart);
    } else if (currentPart) {
      currentPart.files.push(ch.relativeHref);
      currentPart.idrefs.push(ch.idref);
    }
  }

  // Điều kiện để gộp:
  // - Sách phải có từ 2 Phần trở lên
  // - Ít nhất 1 phần phải có từ 2 chương trở lên
  const hasMultipleParts = partsList.length >= 2;
  const hasMultiChapterParts = partsList.some((p) => p.files.length > 1);

  if (!hasMultipleParts || !hasMultiChapterParts) {
    return { mergedPartsCount: 0, totalChaptersMerged: 0, partDetails: [] };
  }

  const totalBeforeFiles = partsList.reduce((acc, p) => acc + p.files.length, 0);

  console.log(`\n======================================================`);
  console.log(`📚 PHÁT HIỆN SÁCH CÓ ${partsList.length} PHẦN VỚI ${totalBeforeFiles} CHƯƠNG`);
  console.log(`⚡ Bắt đầu tự động gộp các chương trong từng phần vào 1 file...`);
  console.log(`======================================================\n`);

  // Bản đồ ánh xạ liên kết anchor cũ -> file mới và id mới:
  // "Chapter0002.html" -> "Chapter0001.html#ch-2"
  // "Chapter0002.html#anchor1" -> "Chapter0001.html#anchor1"
  const anchorHrefRemap = new Map<string, string>();

  let totalChaptersMerged = 0;
  const partDetails: Array<{ partTitle: string; targetFile: string; chaptersCount: number }> = [];

  // 4. Tiến hành gộp từng phần
  for (let pIdx = 0; pIdx < partsList.length; pIdx++) {
    const part = partsList[pIdx];
    if (part.files.length <= 1) {
      partDetails.push({
        partTitle: part.partTitle,
        targetFile: part.files[0],
        chaptersCount: 1
      });
      continue;
    }

    const targetFile = part.files[0];
    const targetZipPath = opfManager.resolvePathInZip(targetFile);
    const targetHtml = unpacked.getFileString(targetZipPath);

    const $target = cheerio.load(targetHtml, { xml: { decodeEntities: false } });
    const targetContainer = getContentContainer($target);

    // Chuẩn hoá tiêu đề Phần ở đầu file thành H1
    const partSlug = `part-${pIdx + 1}`;
    let partH1 = targetContainer.find('h1, h2, h3, h4, p').filter((_, el) => {
      return detectPartInElement($target(el)).isPart;
    }).first();

    // Tìm xem chương đầu tiên trong file target có tiêu đề không
    let ch1Title = 'Chương 1';
    let ch1Id = `ch-1-${Math.random().toString(36).substring(2, 7)}`;
    let ch1Element: cheerio.Cheerio<any> | null = null;

    targetContainer.find('h1, h2, h3, h4, p').each((_, el) => {
      const $el = $target(el);
      if ($el.is(partH1)) return;
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (CHAPTER_REGEX_STRICT.test(text) && text.length < 60) {
        ch1Title = text;
        ch1Id = $el.attr('id') || ch1Id;
        ch1Element = $el;
        return false;
      }
    });

    // Thay thế tiêu đề Phần thành <h1 class="chapter-h1">
    const h1Html = `<h1 id="${partSlug}" class="chapter-h1">${escapeXml(part.partTitle)}</h1>`;
    if (partH1 && partH1.length > 0) {
      partH1.replaceWith(h1Html);
    } else {
      targetContainer.prepend(h1Html);
    }

    // Đảm bảo chương đầu tiên có thẻ H2 chuẩn
    const h2Html = `<h2 id="${ch1Id}" class="chapter-h2">${escapeXml(ch1Title)}</h2>`;
    if (ch1Element && (ch1Element as any).length > 0) {
      (ch1Element as any).replaceWith(h2Html);
    } else {
      // Nếu là tiêu đề gộp ("Phần 1 - Chương 1"), chèn H2 ngay sau H1
      targetContainer.find(`h1#${partSlug}`).after(h2Html);
    }

    anchorHrefRemap.set(targetFile, `${targetFile}#${partSlug}`);

    // Gộp lần lượt các file chương con vào targetContainer
    const subFiles = part.files.slice(1);
    for (let cIdx = 0; cIdx < subFiles.length; cIdx++) {
      const subFile = subFiles[cIdx];
      const subZipPath = opfManager.resolvePathInZip(subFile);
      const subHtml = unpacked.getFileString(subZipPath);

      const $sub = cheerio.load(subHtml, { xml: { decodeEntities: false } });
      const subContainer = getContentContainer($sub);

      // Tìm tiêu đề chương trong file con
      let subChapTitle = `Chương ${cIdx + 2}`;
      let subChapId = `ch-${cIdx + 2}-${Math.random().toString(36).substring(2, 7)}`;
      let subHeadingEl: cheerio.Cheerio<any> | null = null;

      subContainer.find('h1, h2, h3, h4, p').each((_, el) => {
        const $el = $sub(el);
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if ((CHAPTER_REGEX_STRICT.test(text) || text.startsWith('Chương')) && text.length < 60) {
          subChapTitle = text;
          subChapId = $el.attr('id') || subChapId;
          subHeadingEl = $el;
          return false;
        }
      });

      // Remap link từ file cũ sang file gộp
      anchorHrefRemap.set(subFile, `${targetFile}#${subChapId}`);
      anchorHrefRemap.set(`${subFile}#${subChapId}`, `${targetFile}#${subChapId}`);

      // Remap tất cả các id/anchor trong subFile
      $sub('[id]').each((_, el) => {
        const oldId = $sub(el).attr('id');
        if (oldId && oldId !== subChapId) {
          // Tránh xung đột ID nếu id đã tồn tại trong target
          if ($target(`[id="${oldId}"]`).length > 0) {
            const uniqueId = `sub_${cIdx + 2}_${oldId}`;
            $sub(el).attr('id', uniqueId);
            $sub(`a[href="#${oldId}"]`).attr('href', `#${uniqueId}`);
            anchorHrefRemap.set(`${subFile}#${oldId}`, `${targetFile}#${uniqueId}`);
          } else {
            anchorHrefRemap.set(`${subFile}#${oldId}`, `${targetFile}#${oldId}`);
          }
        }
      });

      // Xoá tiêu đề cũ trong subContainer để thay bằng H2 chuẩn có ngắt trang
      if (subHeadingEl && (subHeadingEl as any).length > 0) {
        (subHeadingEl as any).remove();
      }

      // Thêm ngắt trang và tiêu đề chương H2
      targetContainer.append(`\n<div class="chapter-break" style="page-break-before: always; break-before: page;"></div>\n`);
      targetContainer.append(`<h2 id="${subChapId}" class="chapter-h2">${escapeXml(subChapTitle)}</h2>\n`);

      // Chuyển toàn bộ nội dung còn lại của subContainer sang targetContainer
      subContainer.children().each((_, child) => {
        targetContainer.append($sub.html(child));
      });

      // Xoá file con khỏi unpacked và đĩa
      unpacked.deleteFile(subZipPath);

      // Xoá manifest item và spine itemref trong OPF
      const subManifestId = opfManager.findManifestIdByHref(subFile);
      if (subManifestId) {
        opfManager.removeManifestItem(subManifestId);
        opfManager.removeSpineItem(subManifestId);
      }
    }

    // Cập nhật thẻ <title> trong target
    $target('head title').text(part.partTitle);

    // Lưu lại file target đã gộp
    unpacked.setFileString(targetZipPath, $target.xml());

    totalChaptersMerged += part.files.length;
    partDetails.push({
      partTitle: part.partTitle,
      targetFile,
      chaptersCount: part.files.length
    });

    console.log(`   ✅ [${part.partTitle}]: Đã gộp ${part.files.length} chương vào "${targetFile}"`);
  }

  // 5. Cập nhật stylesheet: Đảm bảo có CSS cho .chapter-break và quy chuẩn Typography cho Headings
  ensureStandardStyles(unpacked);

  // 6. Cập nhật các liên kết anchor trên toàn bộ các file còn lại (HTML, NCX)
  if (anchorHrefRemap.size > 0) {
    console.log(`\n🔗 Đang đồng bộ cập nhật ${anchorHrefRemap.size} liên kết đến các file phần mới...`);
    const allRemainingFiles = unpacked.listFiles();
    for (const f of allRemainingFiles) {
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

  // 7. Lưu lại OPF
  opfManager.save();

  const finalPartsCount = partDetails.filter((p) => p.chaptersCount > 1).length;
  console.log(`\n🎉 ĐÃ GỘP THÀNH CÔNG ${partsList.length} PHẦN (${totalChaptersMerged} chương ban đầu)!`);
  console.log(`   Tiết kiệm được ${totalChaptersMerged - partsList.length} lượt gọi Gemini API.\n`);

  return {
    mergedPartsCount: finalPartsCount,
    totalChaptersMerged,
    partDetails
  };
}
