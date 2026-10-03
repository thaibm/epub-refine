import * as cheerio from 'cheerio';
import type { UnpackedEpub } from './epubArchive.js';

export interface FootnoteRef {
  file: string;
  id?: string;
  targetFile: string;
  targetId: string;
  markerText: string;
  parentTag?: string;
  parentId?: string;
  hasNoterefType: boolean;
}

export interface FootnoteDef {
  file: string;
  id: string;
  backlinkFile?: string;
  backlinkId?: string;
  text: string;
  hasFootnoteType: boolean;
}

export interface FootnoteIssue {
  type: 'broken_forward' | 'broken_backward' | 'orphan_ref' | 'orphan_def' | 'missing_backlink' | 'duplicate_id' | 'unlinked_plaintext';
  message: string;
  file: string;
  refId?: string;
  targetId?: string;
}

export interface PlaintextFootnoteSection {
  file: string;
  fnStartIdx: number;
  totalNotes: number;
  notes: { num: string; text: string }[];
}

export interface FootnoteReport {
  totalRefs: number;
  totalDefs: number;
  validPairs: number;
  unlinkedPlaintextCount: number;
  plaintextSections: PlaintextFootnoteSection[];
  issues: FootnoteIssue[];
  isEpub3PopupReady: boolean;
  footnoteFiles: string[];
}

export class FootnoteProcessor {
  /**
   * Nhận diện xem một file XHTML có phải là file Chú Thích (Footnote/Endnote) hay không
   */
  static isFootnoteFile(htmlContent: string, relativeHref: string): boolean {
    const lowerName = relativeHref.toLowerCase();
    if (
      lowerName.includes('chuthich') ||
      lowerName.includes('chu_thich') ||
      lowerName.includes('footnote') ||
      lowerName.includes('endnote') ||
      lowerName.includes('notes')
    ) {
      return true;
    }

    const $ = cheerio.load(htmlContent, { xml: { decodeEntities: false } });

    // 1. Kiểm tra tiêu đề trang
    const title = $('title').text().trim().toLowerCase();
    const firstH1 = $('h1, h2').first().text().trim().toLowerCase();
    if (
      title.includes('chú thích') ||
      title.includes('chu thich') ||
      title.includes('footnote') ||
      title.includes('endnote') ||
      firstH1.includes('chú thích') ||
      firstH1.includes('chu thich') ||
      firstH1.includes('footnote') ||
      firstH1.includes('endnote')
    ) {
      return true;
    }

    // 2. Kiểm tra thuộc tính EPUB 3 trên thẻ body hoặc section bao bọc toàn file
    if ($('body[epub\\:type*="footnote"], body[epub\\:type*="endnote"], body[role*="doc-endnotes"], section[epub\\:type*="endnotes"]').length > 0) {
      return true;
    }

    // 3. Kiểm tra nếu đa số các đoạn văn cấp 1 (direct paragraphs) là các mục chú thích có backlink
    const topParagraphs = $('body > p[id], body > div > p[id]');
    if (topParagraphs.length >= 3) {
      const footnoteParagraphs = topParagraphs.filter((_, el) => {
        const id = $(el).attr('id') || '';
        return /^(chuthich_|chuthich-|fn|footnote|note)/i.test(id);
      });
      if (footnoteParagraphs.length / topParagraphs.length >= 0.5) {
        return true;
      }
    }

    return false;
  }

  /**
   * Quét toàn bộ sách để thu thập tất cả các liên kết chú thích và định nghĩa chú thích
   */
  static scanFootnotes(unpacked: UnpackedEpub): {
    refs: FootnoteRef[];
    defs: FootnoteDef[];
    footnoteFiles: string[];
    htmlFiles: string[];
  } {
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));
    const refs: FootnoteRef[] = [];
    const defs: FootnoteDef[] = [];
    const footnoteFiles: string[] = [];

    // 1. Phân loại các file chú thích riêng biệt (như chuthich.html, notes.xhtml)
    for (const file of htmlFiles) {
      const content = unpacked.getFileString(file);
      if (this.isFootnoteFile(content, file)) {
        footnoteFiles.push(file);
      }
    }

    // 2. Quét định nghĩa chú thích trong các file chú thích riêng hoặc inline cuối chương
    for (const file of htmlFiles) {
      const content = unpacked.getFileString(file);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      const isFootnoteDoc = footnoteFiles.includes(file);

      if (isFootnoteDoc) {
        $('p[id], div[id], aside[id], li[id]').each((_, el) => {
          const $el = $(el);
          const id = $el.attr('id');
          if (!id || id === 'calibre_link' || id.startsWith('calibre_pb')) return;

          const link = $el.find('a[href*="#"]');
          let backlinkFile: string | undefined;
          let backlinkId: string | undefined;

          if (link.length > 0) {
            const rawHref = link.first().attr('href') || '';
            const [bFile, bId] = rawHref.split('#');
            backlinkFile = bFile ? bFile.replace(/^\.\//, '') : file;
            backlinkId = bId;
          }

          const hasFootnoteType =
            $el.attr('epub:type')?.includes('footnote') ||
            $el.attr('role')?.includes('doc-footnote') ||
            false;

          defs.push({
            file,
            id,
            backlinkFile,
            backlinkId,
            text: $el.text().replace(/\s+/g, ' ').trim(),
            hasFootnoteType
          });
        });
      } else {
        // Quét inline footnotes (như <aside id="fn_..." epub:type="footnote"> cuối chương)
        $('aside[id], div.chapter-footnote[id], p.chapter-footnote[id]').each((_, el) => {
          const $el = $(el);
          const id = $el.attr('id');
          if (!id) return;

          const link = $el.find('a[href*="#"]');
          let backlinkFile: string | undefined;
          let backlinkId: string | undefined;

          if (link.length > 0) {
            const rawHref = link.first().attr('href') || '';
            const [bFile, bId] = rawHref.split('#');
            backlinkFile = bFile ? bFile.replace(/^\.\//, '') : file;
            backlinkId = bId;
          }

          defs.push({
            file,
            id,
            backlinkFile,
            backlinkId,
            text: $el.text().replace(/\s+/g, ' ').trim(),
            hasFootnoteType: Boolean($el.attr('epub:type')?.includes('footnote')) || (el as any).tagName === 'aside'
          });
        });
      }

      // Quét các liên kết gọi chú thích (Refs) CHỈ từ các file nội dung (tránh nhận nhầm backlink trong file chú thích)
      if (!isFootnoteDoc) {
        $('a[href*="#"]').each((_, el) => {
          const $a = $(el);
          const href = $a.attr('href') || '';
          const [targetFileRaw, targetId] = href.split('#');
          if (!targetId) return;

          // Bỏ qua các backlink nằm trong thẻ định nghĩa chú thích (<aside>, class="footnote-backlink", v.v.)
          if ($a.closest('aside[epub\\:type="footnote"], aside.chapter-footnote, p.chapter-footnote, .footnote-backlink').length > 0) {
            return;
          }

          // Bỏ qua nếu targetId là fnref (trỏ về ref thay vì trỏ về def)
          if (/^fnref/i.test(targetId)) {
            return;
          }

          const targetFile = targetFileRaw ? targetFileRaw.replace(/^\.\//, '') : file;

          const isTargetInFootnoteFile = footnoteFiles.some((fnf) => fnf.endsWith(targetFile) || targetFile.endsWith(fnf));
          const isTargetIdFootnote = /^(chuthich_|chuthich-|fn_|fn-|fn[0-9]|footnote|note_|note-)/i.test(targetId);
          const hasSupChild = $a.find('sup').length > 0 || /^\s*(\[\*+|\*+|\[[0-9]+\]|[0-9]+)\s*$/.test($a.text().trim());
          const hasNoterefAttr = $a.attr('epub:type') === 'noteref' || $a.attr('role') === 'doc-noteref';

          if (isTargetInFootnoteFile || isTargetIdFootnote || (hasSupChild && isTargetIdFootnote) || (hasNoterefAttr && !targetId.startsWith('filepos') && !targetId.startsWith('ch-h1'))) {
            const parent = $a.parent();
            const parentId = $a.closest('[id]').attr('id');

            refs.push({
              file,
              id: $a.attr('id'),
              targetFile,
              targetId,
              markerText: $a.text().trim(),
              parentTag: parent.length ? (parent[0] as any).tagName : undefined,
              parentId,
              hasNoterefType: hasNoterefAttr
            });
          }
        });
      }
    }

    return { refs, defs, footnoteFiles, htmlFiles };
  }

  /**
   * Kiểm định tính toàn vẹn của hệ thống chú thích
   */
  static validate(unpacked: UnpackedEpub): FootnoteReport {
    const { refs, defs, footnoteFiles } = this.scanFootnotes(unpacked);
    const issues: FootnoteIssue[] = [];

    // Tạo bản đồ các ID tồn tại trong từng file
    const fileElementsMap = new Map<string, Set<string>>();
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));

    for (const f of htmlFiles) {
      const content = unpacked.getFileString(f);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      const ids = new Set<string>();
      $('[id]').each((_, el) => {
        const id = $(el).attr('id');
        if (id) ids.add(id);
      });
      fileElementsMap.set(f, ids);
      // Lưu cả basename để tra cứu tương đối
      fileElementsMap.set(f.split('/').pop() || f, ids);
    }

    const defsMap = new Map<string, FootnoteDef>();
    for (const def of defs) {
      defsMap.set(`${def.file}#${def.id}`, def);
      defsMap.set(`${def.file.split('/').pop()}#${def.id}`, def);
      defsMap.set(def.id, def);
    }

    let validPairs = 0;
    const matchedDefKeys = new Set<string>();

    // 1. Kiểm tra từng Reference gọi chú thích (Forward Link)
    for (const ref of refs) {
      const targetIds = fileElementsMap.get(ref.targetFile);
      if (!targetIds) {
        issues.push({
          type: 'broken_forward',
          message: `Link gọi chú thích trỏ tới file không tồn tại: "${ref.targetFile}"`,
          file: ref.file,
          refId: ref.id,
          targetId: ref.targetId
        });
        continue;
      }

      if (!targetIds.has(ref.targetId)) {
        issues.push({
          type: 'broken_forward',
          message: `Không tìm thấy ID đích "#${ref.targetId}" trong file "${ref.targetFile}"`,
          file: ref.file,
          refId: ref.id,
          targetId: ref.targetId
        });
        continue;
      }

      // Khớp thành công
      validPairs++;
      matchedDefKeys.add(`${ref.targetFile}#${ref.targetId}`);
      matchedDefKeys.add(ref.targetId);
    }

    // 2. Kiểm tra từng Định nghĩa chú thích (Def / Backlink)
    for (const def of defs) {
      if (!matchedDefKeys.has(def.id) && !matchedDefKeys.has(`${def.file}#${def.id}`)) {
        issues.push({
          type: 'orphan_def',
          message: `Chú thích mang ID "#${def.id}" không có đoạn văn nào trong sách gọi tới.`,
          file: def.file,
          targetId: def.id
        });
      }

      if (def.backlinkFile && def.backlinkId) {
        const backTargetIds = fileElementsMap.get(def.backlinkFile);
        if (!backTargetIds) {
          issues.push({
            type: 'broken_backward',
            message: `Backlink của chú thích "${def.id}" trỏ tới file không tồn tại: "${def.backlinkFile}"`,
            file: def.file,
            targetId: def.id
          });
        } else if (!backTargetIds.has(def.backlinkId)) {
          issues.push({
            type: 'broken_backward',
            message: `Backlink của chú thích "${def.id}" trỏ tới anchor không tồn tại: "${def.backlinkFile}#${def.backlinkId}"`,
            file: def.file,
            targetId: def.id
          });
        }
      } else {
        issues.push({
          type: 'missing_backlink',
          message: `Chú thích "${def.id}" thiếu đường link quay lại nội dung bài viết.`,
          file: def.file,
          targetId: def.id
        });
      }
    }

    // 3. Quét các chú thích dạng text thuần chưa được liên kết
    const plaintextScan = this.scanPlaintextFootnotes(unpacked);
    if (plaintextScan.totalPlaintextNotes > 0) {
      for (const sec of plaintextScan.sections) {
        issues.push({
          type: 'unlinked_plaintext',
          message: `Phát hiện ${sec.totalNotes} chú thích dạng văn bản thuần ([1], [2]...) ở cuối chương chưa được gắn thẻ siêu liên kết.`,
          file: sec.file
        });
      }
    }

    const isEpub3PopupReady =
      refs.length > 0 &&
      refs.every((r) => r.hasNoterefType) &&
      defs.length > 0 &&
      defs.every((d) => d.hasFootnoteType) &&
      plaintextScan.totalPlaintextNotes === 0;

    return {
      totalRefs: refs.length,
      totalDefs: defs.length,
      validPairs,
      unlinkedPlaintextCount: plaintextScan.totalPlaintextNotes,
      plaintextSections: plaintextScan.sections,
      issues,
      isEpub3PopupReady,
      footnoteFiles
    };
  }

  /**
   * Tự động sửa chữa các liên kết chú thích bị gãy và khôi phục anchor ID
   */
  static autoRepair(unpacked: UnpackedEpub): { repairedCount: number; report: FootnoteReport } {
    const { refs, defs, footnoteFiles } = this.scanFootnotes(unpacked);
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));
    let repairedCount = 0;

    // Tạo bản đồ vị trí ID trong các file nội dung (dành cho Backlink)
    const contentFiles = htmlFiles.filter((f) => !footnoteFiles.includes(f));
    const contentIdToFileMap = new Map<string, string>();
    for (const f of contentFiles) {
      const content = unpacked.getFileString(f);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      $('[id]').each((_, el) => {
        const id = $(el).attr('id');
        if (id) {
          contentIdToFileMap.set(id, f.split('/').pop() || f);
        }
      });
    }

    // Tạo bản đồ vị trí ID trong các file chú thích (dành cho Forward Link)
    const footnoteIdToFileMap = new Map<string, string>();
    for (const f of footnoteFiles) {
      const content = unpacked.getFileString(f);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      $('[id]').each((_, el) => {
        const id = $(el).attr('id');
        if (id) {
          footnoteIdToFileMap.set(id, f.split('/').pop() || f);
        }
      });
    }

    // 1. Sửa các file nội dung (cập nhật đường dẫn file gọi chú thích nếu file chú thích di chuyển)
    for (const f of contentFiles) {
      let changed = false;
      const content = unpacked.getFileString(f);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });

      $('a[href*="#"]').each((_, el) => {
        const $a = $(el);
        const href = $a.attr('href') || '';
        const [targetFileRaw, targetId] = href.split('#');
        if (!targetId) return;

        // Nếu targetId nằm ở file chú thích khác do di dời
        const actualFile = footnoteIdToFileMap.get(targetId);
        if (actualFile && actualFile !== targetFileRaw) {
          $a.attr('href', `${actualFile}#${targetId}`);
          changed = true;
          repairedCount++;
        }
      });

      if (changed) {
        unpacked.setFileString(f, $.xml());
      }
    }

    // 2. Sửa file chú thích (khôi phục backlink trỏ về đúng file nội dung và ID bài viết)
    for (const fnFile of footnoteFiles) {
      let changed = false;
      const content = unpacked.getFileString(fnFile);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });

      $('[id]').each((_, el) => {
        const $el = $(el);
        const noteId = $el.attr('id');
        if (!noteId) return;

        const link = $el.find('a[href*="#"]');
        if (link.length > 0) {
          const rawHref = link.attr('href') || '';
          const [bFile, bId] = rawHref.split('#');
          if (bId) {
            const actualFile = contentIdToFileMap.get(bId);
            if (actualFile && actualFile !== bFile) {
              link.attr('href', `${actualFile}#${bId}`);
              changed = true;
              repairedCount++;
            }
          }
        }
      });

      if (changed) {
        unpacked.setFileString(fnFile, $.xml());
      }
    }

    const report = this.validate(unpacked);
    return { repairedCount, report };
  }

  /**
   * Nâng cấp toàn bộ hệ thống chú thích sang chuẩn EPUB 3 Pop-up Footnote
   * Giúp Kindle, Apple Books, Kobo hiển thị popup nổi thay vì chuyển trang.
   */
  static convertToEpub3Popup(unpacked: UnpackedEpub): { convertedRefs: number; convertedDefs: number } {
    const { refs, defs, footnoteFiles } = this.scanFootnotes(unpacked);
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));
    let convertedRefs = 0;
    let convertedDefs = 0;

    // 1. Cập nhật các file nội dung văn bản chính
    for (const f of htmlFiles) {
      if (footnoteFiles.includes(f)) continue;

      const content = unpacked.getFileString(f);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });

      // Đảm bảo namespace xmlns:epub trên <html>
      const $html = $('html');
      if (!$html.attr('xmlns:epub')) {
        $html.attr('xmlns:epub', 'http://www.idpf.org/2007/ops');
      }

      $('a[href*="#"]').each((_, el) => {
        const $a = $(el);
        const href = $a.attr('href') || '';
        const [targetFileRaw, targetId] = href.split('#');
        if (!targetId) return;

        // Bỏ qua nếu là backlink trong aside hoặc trỏ về ref
        if ($a.closest('aside[epub\\:type="footnote"], aside.chapter-footnote, p.chapter-footnote').length > 0 || /^fnref/i.test(targetId)) {
          return;
        }

        const isTargetFootnote =
          footnoteFiles.some((fnf) => fnf.endsWith(targetFileRaw) || targetFileRaw.endsWith(fnf)) ||
          /^(chuthich_|chuthich-|fn_|fn-|fn[0-9]|footnote|note_|note-)/i.test(targetId);

        if (isTargetFootnote) {
          $a.attr('epub:type', 'noteref');
          $a.attr('role', 'doc-noteref');
          convertedRefs++;
        }
      });

      unpacked.setFileString(f, $.xml());
    }

    // 2. Cập nhật file chú thích (chuthich.html / notes.xhtml)
    for (const fnFile of footnoteFiles) {
      const content = unpacked.getFileString(fnFile);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });

      const $html = $('html');
      if (!$html.attr('xmlns:epub')) {
        $html.attr('xmlns:epub', 'http://www.idpf.org/2007/ops');
      }

      $('p[id], div[id], aside[id], li[id]').each((_, el) => {
        const $el = $(el);
        const id = $el.attr('id');
        if (!id || id.startsWith('calibre_pb')) return;

        // Gắn thuộc tính epub:type="footnote" và role="doc-footnote"
        $el.attr('epub:type', 'footnote');
        $el.attr('role', 'doc-footnote');
        convertedDefs++;
      });

      unpacked.setFileString(fnFile, $.xml());
    }

    return { convertedRefs, convertedDefs };
  }

  /**
   * Đánh số lại thứ tự chú thích liên tục và đồng bộ giữa bài viết và file chú thích
   */
  static renumberFootnotes(
    unpacked: UnpackedEpub,
    style: 'star' | 'number' | 'bracket-number' = 'bracket-number'
  ): { totalRenumbered: number } {
    const { refs, footnoteFiles } = this.scanFootnotes(unpacked);
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));
    let totalRenumbered = 0;

    // Tạo bản đồ đánh số mới theo thứ tự xuất hiện trong bài
    const oldIdToNewMap = new Map<
      string,
      { newId: string; newLabel: string; newNumber: number; oldBacklinkId?: string }
    >();

    refs.forEach((ref, index) => {
      const num = index + 1;
      let newLabel = `[${num}]`;
      if (style === 'star') newLabel = '[*]';
      else if (style === 'number') newLabel = `${num}`;

      const newId = `chuthich_${num}`;
      oldIdToNewMap.set(ref.targetId, {
        newId,
        newLabel,
        newNumber: num,
        oldBacklinkId: ref.parentId || ref.id
      });
    });

    // 1. Cập nhật các liên kết trong nội dung bài viết
    for (const f of htmlFiles) {
      if (footnoteFiles.includes(f)) continue;

      let changed = false;
      const content = unpacked.getFileString(f);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });

      $('a[href*="#"]').each((_, el) => {
        const $a = $(el);
        const href = $a.attr('href') || '';
        const [targetFile, targetId] = href.split('#');
        if (!targetId) return;

        const info = oldIdToNewMap.get(targetId);
        if (info) {
          $a.attr('href', `${targetFile}#${info.newId}`);
          $a.attr('id', info.newId);

          const sup = $a.find('sup');
          if (sup.length > 0) {
            sup.text(info.newLabel);
          } else {
            $a.html(`<sup>${info.newLabel}</sup>`);
          }

          changed = true;
          totalRenumbered++;
        }
      });

      if (changed) {
        unpacked.setFileString(f, $.xml());
      }
    }

    // 2. Cập nhật các định nghĩa trong file chú thích
    for (const fnFile of footnoteFiles) {
      let changed = false;
      const content = unpacked.getFileString(fnFile);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });

      $('[id]').each((_, el) => {
        const $el = $(el);
        const oldId = $el.attr('id');
        if (!oldId) return;

        const info = oldIdToNewMap.get(oldId);
        if (info) {
          $el.attr('id', info.newId);

          const link = $el.find('a[href*="#"]');
          if (link.length > 0) {
            const sup = link.find('sup');
            if (sup.length > 0) {
              sup.text(info.newLabel);
            } else {
              link.html(`<sup>${info.newLabel}</sup>`);
            }
          }
          changed = true;
        }
      });

      if (changed) {
        unpacked.setFileString(fnFile, $.xml());
      }
    }

    return { totalRenumbered };
  }

  /**
   * Quét toàn bộ sách để phát hiện các chú thích dạng văn bản thuần ở cuối chương chưa được gắn thẻ siêu liên kết
   * (Ví dụ: [1], [2] trong bài viết và danh sách [1]..., [2]... ở cuối chương)
   */
  static scanPlaintextFootnotes(unpacked: UnpackedEpub): {
    totalPlaintextNotes: number;
    sections: PlaintextFootnoteSection[];
  } {
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));
    const sections: PlaintextFootnoteSection[] = [];
    let totalPlaintextNotes = 0;

    for (const file of htmlFiles) {
      const content = unpacked.getFileString(file);
      if (this.isFootnoteFile(content, file)) continue;

      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      const paragraphs = $('body p').toArray();
      if (paragraphs.length < 5) continue;

      // Tìm vị trí bắt đầu của footnote section ở nửa sau của tài liệu
      let fnStartIdx = -1;
      for (let i = Math.floor(paragraphs.length / 2); i < paragraphs.length; i++) {
        const text = $(paragraphs[i]).text().trim();
        // Bỏ qua nếu đoạn này đã có thẻ <a> gọi link hoặc thẻ <aside>
        if ($(paragraphs[i]).find('a[href*="#"]').length > 0) continue;

        if (/^\s*(chú thích\s*:?|footnotes\s*:?|notes\s*:?)\s*$/i.test(text)) {
          fnStartIdx = i;
          break;
        }
        if (/^\s*\[([0-9]+|\*+)\]/.test(text) && $(paragraphs[i]).find('a').length === 0) {
          fnStartIdx = i;
          break;
        }
      }

      if (fnStartIdx === -1) continue;

      const notes: { num: string; text: string }[] = [];
      for (let i = fnStartIdx; i < paragraphs.length; i++) {
        const $p = $(paragraphs[i]);
        if ($p.find('a[href*="#"]').length > 0) continue;

        const text = $p.text().trim();
        if (/^\s*(chú thích\s*:?|footnotes\s*:?|notes\s*:?)\s*$/i.test(text)) continue;
        if (/^\s*(hết|the end|february|january|march|april|may|june|july|august|september|october|november|december)\b/i.test(text) && i === paragraphs.length - 1) continue;

        const defMatch = text.match(/^\s*\[([0-9]+|\*+)\]\s*(.*)/) || text.match(/^\s*([0-9]+)\s+([A-ZÀ-Ỹ].*)/);
        if (defMatch) {
          const num = (parseInt(defMatch[1], 10) > 10 && notes.length === 0) ? '1' : defMatch[1];
          notes.push({ num, text });
        }
      }

      if (notes.length > 0) {
        sections.push({
          file,
          fnStartIdx,
          totalNotes: notes.length,
          notes
        });
        totalPlaintextNotes += notes.length;
      }
    }

    return { totalPlaintextNotes, sections };
  }

  /**
   * Tự động chuyển đổi các chú thích dạng văn bản thuần thành liên kết 2 chiều chuẩn EPUB 3 Pop-up
   */
  static convertPlaintextFootnotes(unpacked: UnpackedEpub): { totalConverted: number } {
    const htmlFiles = unpacked.listFiles().filter((f) => f.endsWith('.html') || f.endsWith('.xhtml'));
    let totalConverted = 0;

    for (const file of htmlFiles) {
      const content = unpacked.getFileString(file);
      if (this.isFootnoteFile(content, file)) continue;

      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      const paragraphs = $('body p').toArray();
      if (paragraphs.length < 5) continue;

      let fnStartIdx = -1;
      for (let i = Math.floor(paragraphs.length / 2); i < paragraphs.length; i++) {
        const text = $(paragraphs[i]).text().trim();
        if ($(paragraphs[i]).find('a[href*="#"]').length > 0) continue;

        if (/^\s*(chú thích\s*:?|footnotes\s*:?|notes\s*:?)\s*$/i.test(text)) {
          fnStartIdx = i;
          break;
        }
        if (/^\s*\[([0-9]+|\*+)\]/.test(text) && $(paragraphs[i]).find('a').length === 0) {
          fnStartIdx = i;
          break;
        }
      }

      if (fnStartIdx === -1) continue;

      interface NoteDefItem {
        num: string;
        elements: any[];
      }
      const noteDefs: NoteDefItem[] = [];
      let currentNote: NoteDefItem | null = null;
      let headerEl: any = null;

      for (let i = fnStartIdx; i < paragraphs.length; i++) {
        const pEl = paragraphs[i];
        const $p = $(pEl);
        const text = $p.text().trim();

        if (/^\s*(chú thích\s*:?|footnotes\s*:?|notes\s*:?)\s*$/i.test(text)) {
          headerEl = pEl;
          continue;
        }

        if (/^\s*(hết|the end|february|january|march|april|may|june|july|august|september|october|november|december)\b/i.test(text) && i === paragraphs.length - 1) {
          continue;
        }

        const defMatch = text.match(/^\s*\[([0-9]+|\*+)\]\s*(.*)/) || text.match(/^\s*([0-9]+)\s+([A-ZÀ-Ỹ].*)/);
        if (defMatch) {
          const num = (parseInt(defMatch[1], 10) > 10 && noteDefs.length === 0) ? '1' : defMatch[1];
          currentNote = {
            num,
            elements: [pEl]
          };
          noteDefs.push(currentNote);
        } else if (currentNote) {
          currentNote.elements.push(pEl);
        }
      }

      if (noteDefs.length === 0) continue;

      const fileSlug = file.replace(/[^a-zA-Z0-9]/g, '_');

      // 1. Thay thế in-text markers trong các đoạn văn trước fnStartIdx
      for (let i = 0; i < fnStartIdx; i++) {
        const pEl = paragraphs[i];
        const $p = $(pEl);
        let pHtml = $p.html() || '';
        let pChanged = false;

        for (const def of noteDefs) {
          // Khớp marker [num] chưa được bọc thẻ <a>
          const markerRegex = new RegExp(`(?<!<a[^>]*>)\\[${def.num}\\]`, 'g');
          if (markerRegex.test(pHtml)) {
            const refId = `fnref_${fileSlug}_${def.num}`;
            const targetId = `fn_${fileSlug}_${def.num}`;
            const linkHtml = `<a id="${refId}" href="#${targetId}" epub:type="noteref" role="doc-noteref" class="noteref"><sup>[${def.num}]</sup></a>`;
            pHtml = pHtml.replace(markerRegex, linkHtml);
            pChanged = true;
          }
        }

        if (pChanged) {
          $p.html(pHtml);
        }
      }

      // 2. Thay thế các định nghĩa ở cuối chương thành thẻ <aside epub:type="footnote">
      for (const def of noteDefs) {
        const refId = `fnref_${fileSlug}_${def.num}`;
        const noteId = `fn_${fileSlug}_${def.num}`;

        const noteLines: string[] = [];
        def.elements.forEach((el, elIdx) => {
          let t = $(el).html() || '';
          if (elIdx === 0) {
            t = t.replace(/^\s*\[?([0-9]+|\*+)\]?\s*\]?\s*/, '').replace(/^\s*[0-9]+\s*\]?\s*(?=[A-ZÀ-Ỹ])/, '');
          }
          if (t.trim()) {
            noteLines.push(t.trim());
          }
        });

        const noteBodyHtml = noteLines.join(' ');
        const asideHtml = `<aside id="${noteId}" class="chapter-footnote" epub:type="footnote" role="doc-footnote">\n  <p><a href="#${refId}" class="footnote-backlink"><sup>[${def.num}]</sup></a> ${noteBodyHtml}</p>\n</aside>`;

        $(def.elements[0]).replaceWith(asideHtml);
        for (let k = 1; k < def.elements.length; k++) {
          $(def.elements[k]).remove();
        }
        totalConverted++;
      }

      // 3. Xử lý header "Chú thích:" nếu có
      if (headerEl) {
        $(headerEl).replaceWith('<p class="footnotes-heading"><strong>Chú thích:</strong></p>');
      }

      // Đảm bảo namespace xmlns:epub trên <html>
      const $html = $('html');
      if (!$html.attr('xmlns:epub')) {
        $html.attr('xmlns:epub', 'http://www.idpf.org/2007/ops');
      }

      unpacked.setFileString(file, $.xml());
    }

    return { totalConverted };
  }
}
