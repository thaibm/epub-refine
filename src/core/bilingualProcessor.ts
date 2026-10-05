import * as cheerio from 'cheerio';
import type { ParagraphInfo } from './domProcessor.js';

export interface TranslatableParagraph {
  idx: number;
  text: string;
  originalHtml: string;
  tagName: string;
}

export interface BilingualFootnoteEntry {
  id: number;
  chapterFile: string;
  enText: string;
}

export interface ApplyBilingualResult {
  updatedHtml: string;
  footnotes: BilingualFootnoteEntry[];
  nextIndex: number;
}

export const BILINGUAL_CSS = `
/* ========================================================
   Quy chuẩn Hiển thị Chú thích Pop-up Modal EPUB
   ======================================================== */
a[id^="chuthich_"] {
  text-decoration: none !important;
  color: #1a73e8 !important;
  margin-left: 0.2em;
  font-weight: bold;
  cursor: pointer;
}

a[id^="chuthich_"] sup {
  font-size: 0.75em;
  line-height: 0;
  vertical-align: baseline;
  position: relative;
  top: -0.4em;
}

p[id^="chuthich_"] {
  margin: 0.8em 0;
  line-height: 1.5;
}

p[id^="chuthich_"] a[id^="p_"] {
  text-decoration: none !important;
  color: #1a73e8 !important;
  font-weight: bold;
  margin-right: 0.3em;
}
`;

export class BilingualProcessor {
  /**
   * Trích xuất danh sách các đoạn văn và khối văn bản cần dịch trong file XHTML
   */
  static extractParagraphs(htmlContent: string): {
    paragraphs: TranslatableParagraph[];
    h1Title?: string;
  } {
    const $ = cheerio.load(htmlContent, {
      xml: { decodeEntities: false }
    });

    const paragraphs: TranslatableParagraph[] = [];
    let idx = 0;

    // Lấy tiêu đề h1 nếu có
    const h1El = $('h1').first();
    const h1Title = h1El.length > 0 ? h1El.text().trim() : undefined;

    // Tìm các thẻ văn bản trong body
    $('body p, body blockquote, body li').each((_, el) => {
      const $el = $(el);

      // Bỏ qua các thẻ nằm trong chú thích cũ hoặc section footnote
      if (
        $el.closest(
          'aside[epub\\:type="footnote"], section[epub\\:type="footnotes"], .en-bilingual-notes, .chapter-footnotes-section, aside.chapter-footnote'
        ).length > 0
      ) {
        return;
      }

      // Bỏ qua đoạn rác hoặc đoạn chỉ chứa ảnh
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) return;

      // Bỏ qua các dòng chỉ chứa số trang hoặc header/footer rác
      if (/^\s*(page\s+\d+|\d+)\s*$/i.test(text)) return;

      paragraphs.push({
        idx: idx++,
        text,
        originalHtml: $el.html() || text,
        tagName: el.tagName ? el.tagName.toLowerCase() : 'p'
      });
    });

    return { paragraphs, h1Title };
  }

  /**
   * Áp dụng bản dịch tiếng Việt vào DOM, đồng thời chèn thẻ marker chú thích modal Pop-up
   */
  static applyBilingualContent(
    htmlContent: string,
    chapterFileName: string,
    translations: { idx: number; text: string }[],
    originalParagraphs: TranslatableParagraph[],
    startIndex = 1,
    h1Vi?: string,
    authorFootnotes?: { num: string; textVi: string }[]
  ): ApplyBilingualResult {
    const $ = cheerio.load(htmlContent, {
      xml: { decodeEntities: false }
    });

    // 1. Đảm bảo thuộc tính xmlns:epub trên <html>
    const $html = $('html');
    if (!$html.attr('xmlns:epub')) {
      $html.attr('xmlns:epub', 'http://www.idpf.org/2007/ops');
    }

    // 2. Cập nhật tiêu đề H1 nếu có bản dịch
    if (h1Vi && h1Vi.trim()) {
      const h1El = $('h1').first();
      if (h1El.length > 0) {
        const originalH1 = h1El.text().trim();
        h1El.attr('data-original-title', originalH1);
        h1El.text(h1Vi.trim());
      }
    }

    // 3. Xây dựng bản đồ dịch thuật theo idx
    const transMap = new Map<number, string>();
    for (const t of translations) {
      transMap.set(t.idx, t.text.trim());
    }

    const noteItems: BilingualFootnoteEntry[] = [];
    let currentNoteId = startIndex;

    // 4. Lấy lại danh sách phần tử DOM tương ứng với paragraphs
    let currentIdx = 0;
    $('body p, body blockquote, body li').each((_, el) => {
      const $el = $(el);

      if (
        $el.closest(
          'aside[epub\\:type="footnote"], section[epub\\:type="footnotes"], .en-bilingual-notes, .chapter-footnotes-section, aside.chapter-footnote'
        ).length > 0
      ) {
        return;
      }

      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) return;
      if (/^\s*(page\s+\d+|\d+)\s*$/i.test(text)) return;

      const pIdx = currentIdx++;
      const translatedText = transMap.get(pIdx);
      const originalInfo = originalParagraphs.find((p) => p.idx === pIdx);

      if (translatedText && originalInfo) {
        const noteId = currentNoteId++;

        // Gán id cho đoạn văn: p_1, p_2,...
        $el.attr('id', `p_${noteId}`);

        // Bảo tồn thẻ link gốc nếu có (ví dụ trong trang mục lục in-book TOC)
        const originalLink = $el.find('a[href]').first();
        const origHref = originalLink.length > 0 && !originalLink.attr('id')?.startsWith('chuthich_') && !originalLink.hasClass('noteref')
          ? originalLink.attr('href')
          : undefined;

        if (origHref) {
          $el.html(`<a href="${origHref}">${translatedText}</a> `);
        } else {
          $el.html(translatedText);
        }

        // Nối marker chú thích modal chuẩn:
        // <a id="chuthich_4" href="chuthich.html#chuthich_4"><sup>[*]</sup></a>
        const markerHtml = `<a id="chuthich_${noteId}" href="chuthich.html#chuthich_${noteId}"><sup>[*]</sup></a>`;
        $el.append(markerHtml);

        noteItems.push({
          id: noteId,
          chapterFile: chapterFileName,
          enText: originalInfo.text
        });
      }
    });

    // 5. Cập nhật chú thích tác giả (nếu có bản dịch chú thích tác giả)
    if (authorFootnotes && authorFootnotes.length > 0) {
      const authorMap = new Map<string, string>();
      for (const fn of authorFootnotes) {
        authorMap.set(fn.num, fn.textVi);
      }

      $('aside[epub\\:type="footnote"], p.footnote, div.footnote, li.footnote').each((_, el) => {
        const $el = $(el);
        const id = $el.attr('id') || '';
        const match = id.match(/(\d+)/);
        if (match) {
          const num = match[1];
          const textVi = authorMap.get(num);
          if (textVi) {
            const backlink = $el.find('a[role="doc-backlink"], a[href*="#ref"], a.footnote-backlink').clone();
            $el.text(`${num}. ${textVi} `);
            if (backlink.length > 0) {
              $el.append(backlink);
            }
          }
        }
      });
    }

    // 6. Xoá section footnotes cũ nếu đã tồn tại để tránh trùng lặp hoặc hiển thị ở cuối chương
    $('.en-bilingual-notes, .chapter-footnotes-section').remove();

    return {
      updatedHtml: $.xml(),
      footnotes: noteItems,
      nextIndex: currentNoteId
    };
  }

  /**
   * Tạo nội dung file chuthich.html chuyên biệt chuẩn modal pop-up cho Apple Books và Kindle
   */
  static generateChuthichHtml(
    footnotes: BilingualFootnoteEntry[],
    relativeCssPath = '../../stylesheet.css'
  ): string {
    let html = `<?xml version='1.0' encoding='utf-8'?>\n`;
    html += `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n`;
    html += `<html xmlns="http://www.w3.org/1999/xhtml">\n`;
    html += `  <head>\n`;
    html += `    <title>Chú thích</title>\n`;
    html += `    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>\n`;
    html += `    <link href="${relativeCssPath}" rel="stylesheet" type="text/css"/>\n`;
    html += `  </head>\n`;
    html += `  <body class="calibre">\n`;
    html += `    <div class="calibre4" id="calibre_pb_0"/>\n`;

    for (const fn of footnotes) {
      let escapedEn = fn.enText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      while (escapedEn.includes('&amp;amp;')) {
        escapedEn = escapedEn.replace(/&amp;amp;/g, '&amp;');
      }

      html += `    <p id="chuthich_${fn.id}"><a id="p_${fn.id}" href="${fn.chapterFile}#p_${fn.id}"><sup>[*]</sup></a> ${escapedEn}</p>\n`;
    }

    html += `  </body>\n`;
    html += `</html>\n`;
    return html;
  }
}
