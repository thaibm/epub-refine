import * as cheerio from 'cheerio';
import type { HeadingItem, HeadingSuggestion, SpellingFix, AiFootnoteAnalysis } from '../types/index.js';
import { CHAPTER_REGEX } from './chapterSplitter.js';

export interface TopElementInfo {
  index: number;
  tagName: string;
  text: string;
  id?: string;
  className?: string;
}

export interface ParagraphInfo {
  idx: number;
  text: string;
}

export class ChapterDomProcessor {
  public $: cheerio.CheerioAPI;
  private chapterFileRelativeHref: string;

  constructor(htmlContent: string, chapterFileRelativeHref: string) {
    this.chapterFileRelativeHref = chapterFileRelativeHref;
    // Dùng xml: { decodeEntities: false } để bảo toàn tiếng Việt UTF-8 và cú pháp tự đóng thẻ XHTML
    this.$ = cheerio.load(htmlContent, {
      xml: {
        decodeEntities: false
      }
    });

    // Tự động phân tách các thẻ <p> chứa nhiều thẻ <br/> (do Calibre gộp đoạn văn) thành các đoạn văn riêng
    this.unpackParagraphs();
  }

  /**
   * Xác định container chính chứa nội dung (tránh xoá nhầm thẻ wrapper ngoài cùng như div.calibre1)
   */
  getContentContainer(): cheerio.Cheerio<any> {
    if (this.$('body > div.calibre1').length > 0) {
      return this.$('body > div.calibre1');
    }
    if (this.$('body > div').length === 1 && this.$('body > *').length === 1) {
      return this.$('body > div');
    }
    return this.$('body');
  }

  /**
   * Phân tách các thẻ <p> có chứa nhiều <br/> (thường gặp ở sách Calibre convert từ MOBI/PRC)
   * thành các thẻ <p> riêng biệt chuẩn HTML
   */
  unpackParagraphs(): void {
    this.$('body p').each((_, pEl) => {
      const $p = this.$(pEl);
      const brs = $p.find('br');
      if (brs.length >= 2) {
        const rawHtml = $p.html();
        if (!rawHtml) return;
        const parts = rawHtml.split(/<br[^>]*>/i).map((s) => s.trim()).filter(Boolean);
        if (parts.length > 1) {
          const pClass = $p.attr('class') || '';
          const pId = $p.attr('id');
          const newParagraphs = parts.map((part, i) => {
            const idAttr = (i === 0 && pId) ? ` id="${pId}"` : '';
            const classAttr = pClass ? ` class="${pClass}"` : '';
            return `<p${classAttr}${idAttr}>${part}</p>`;
          }).join('\n');
          $p.replaceWith(newParagraphs);
        }
      }
    });
  }

  /**
   * Lấy danh sách các phần tử đầu trang trong container
   * để AI phân tích xác định H1 chuẩn và các thẻ trùng lặp cần dọn dẹp.
   */
  getTopElements(maxCount = 10): TopElementInfo[] {
    const results: TopElementInfo[] = [];
    let count = 0;
    const container = this.getContentContainer();

    container.children().each((i, el) => {
      if (count >= maxCount) return;
      const $el = this.$(el);
      const text = $el.text().replace(/\s+/g, ' ').trim();
      const tagName = (el as any).tagName?.toLowerCase() || '';

      // Bỏ qua div rỗng (spacer như <div class="calibre_3">&#160;</div>)
      if (tagName === 'div' && (!text || text === ' ' || text === '&#160;')) {
        return;
      }

      results.push({
        index: count,
        tagName,
        text,
        id: $el.attr('id') || $el.find('a[id]').attr('id'),
        className: $el.attr('class')
      });
      count++;
    });

    return results;
  }

  /**
   * Đánh dấu chỉ số tạm thời cho tất cả các thẻ <p> trong body: data-pid="0", data-pid="1",...
   * Trả về danh sách các đoạn văn bản sạch.
   */
  indexParagraphs(): ParagraphInfo[] {
    const paragraphs: ParagraphInfo[] = [];

    this.$('body p').each((idx, el) => {
      const $el = this.$(el);
      $el.attr('data-pid', idx.toString());
      const text = $el.text().trim();
      paragraphs.push({ idx, text });
    });

    return paragraphs;
  }

  /**
   * Chuẩn hoá H1:
   * - Tạo thẻ <h1 id="..." class="chapter-h1">...</h1>
   * - Giữ lại anchor id cũ (nếu có thẻ h4/h3/p cũ có id) để không làm gãy liên kết bên ngoài
   * - Bảo toàn toàn bộ thẻ liên kết chú thích <a> nếu phần tử đầu trang có chứa
   * - Xoá các thẻ trùng lặp thừa ở đầu trang trong container
   */
  normalizeH1(newH1Title: string, removeTopIndices: number[] = [], preferredId?: string): string {
    const container = this.getContentContainer();
    let chosenId = preferredId;

    // Tìm xem trong các thẻ đầu trang có ID nào sẵn có không (ví dụ id="p_1" hoặc id="filepos8338")
    if (!chosenId) {
      container.find('h1, h2, h3, h4, h5, h6, a[id], p[id]').slice(0, 5).each((_, el) => {
        const id = this.$(el).attr('id');
        if (id && !chosenId && !id.startsWith('calibre_pb')) {
          chosenId = id;
        }
      });
      if (!chosenId) {
        container.find('h1, h2, h3, h4, h5, h6, p').slice(0, 5).each((_, el) => {
          const id = this.$(el).attr('id');
          if (id && !chosenId) {
            chosenId = id;
          }
        });
      }
    }

    if (!chosenId) {
      chosenId = `ch-h1-${Math.random().toString(36).substring(2, 8)}`;
    }

    // Xác định các thẻ top cần xoá và trích xuất thẻ chú thích cần bảo tồn
    let topCount = 0;
    const elementsToRemove: cheerio.Cheerio<any>[] = [];
    let firstElementToReplace: cheerio.Cheerio<any> | null = null;
    let preservedFootnotesHtml = '';

    container.children().each((i, el) => {
      const $el = this.$(el);
      const text = $el.text().replace(/\s+/g, ' ').trim();
      const tagName = (el as any).tagName?.toLowerCase() || '';

      if (tagName === 'div' && (!text || text === ' ' || text === '&#160;')) return;

      if (removeTopIndices.includes(topCount) || (removeTopIndices.length === 0 && topCount === 0)) {
        // Trích xuất các thẻ footnote trong các phần tử sắp bị thay thế / xoá
        $el.find('a[href*="#"]').each((_, aEl) => {
          const $a = this.$(aEl);
          const href = $a.attr('href') || '';
          if (/chuthich|footnote|fn|note/i.test(href) || $a.find('sup').length > 0 || $a.attr('epub:type') === 'noteref') {
            preservedFootnotesHtml += this.$.html(aEl);
          }
        });

        if (removeTopIndices.includes(topCount)) {
          // Bảo vệ đoạn văn nội dung: nếu đoạn văn dài (> 80 ký tự) thì không xoá nhầm
          const isLongContent = text.length > 80;
          if (!isLongContent) {
            if (!firstElementToReplace) {
              firstElementToReplace = $el;
              if (!preferredId && $el.attr('id')) {
                chosenId = $el.attr('id');
              }
            } else {
              elementsToRemove.push($el);
            }
          }
        }
      }
      topCount++;
    });

    const h1Html = `<h1 id="${chosenId}" class="chapter-h1">${newH1Title}${preservedFootnotesHtml}</h1>`;

    if (firstElementToReplace) {
      (firstElementToReplace as any).replaceWith(h1Html);
      for (const $rem of elementsToRemove) {
        $rem.remove();
      }
    } else {
      // Nếu không chỉ định thẻ cần xoá, kiểm tra xem có h1 sẵn chưa
      const existingH1 = container.find('h1').first();
      if (existingH1.length > 0) {
        // Trích xuất footnote trong existingH1 nếu có
        existingH1.find('a[href*="#"]').each((_, aEl) => {
          const $a = this.$(aEl);
          const href = $a.attr('href') || '';
          if (/chuthich|footnote|fn|note/i.test(href) || $a.find('sup').length > 0 || $a.attr('epub:type') === 'noteref') {
            preservedFootnotesHtml += this.$.html(aEl);
          }
        });
        existingH1.attr('id', chosenId);
        existingH1.addClass('chapter-h1');
        existingH1.html(`${newH1Title}${preservedFootnotesHtml}`);
      } else {
        container.prepend(h1Html);
      }
    }

    // Cập nhật thẻ <title> trong <head>
    this.$('head title').text(newH1Title);

    return chosenId;
  }

  /**
   * Áp dụng các Heading 2 và Heading 3:
   * Tự động nhận diện xem đoạn văn đó là tiêu đề cần thăng cấp (promote) hay chèn mới (insert).
   * Bảo toàn toàn bộ thẻ chú thích và anchor ID khi thăng cấp <p> thành <h2/h3>.
   */
  applyHeadings(headings: HeadingSuggestion[]): void {
    // Sắp xếp ngược từ dưới lên trên để không làm lệch vị trí chèn
    const sorted = [...headings].sort((a, b) => b.insertBeforeIdx - a.insertBeforeIdx);

    for (const h of sorted) {
      const targetP = this.$(`body p[data-pid="${h.insertBeforeIdx}"]`);
      if (targetP.length === 0) continue;

      const tag = h.tag.toLowerCase() === 'h3' ? 'h3' : 'h2';
      const cleanTitle = h.title.trim();
      const pText = targetP.text().trim();

      // Kiểm tra xem tiêu đề này đã tồn tại sẵn trong file hay chưa (ví dụ H2 tên chương đã có sẵn khi gộp phần)
      let alreadyExists = false;
      this.$('h1, h2, h3').each((_, el) => {
        if (this.$(el).text().replace(/\s+/g, ' ').trim().toLowerCase() === cleanTitle.toLowerCase()) {
          alreadyExists = true;
          return false;
        }
      });
      if (alreadyExists) continue;

      // Trích xuất chú thích bên trong targetP nếu có
      let footnoteHtml = '';
      targetP.find('a[href*="#"]').each((_, aEl) => {
        const $a = this.$(aEl);
        const href = $a.attr('href') || '';
        if (/chuthich|footnote|fn|note/i.test(href) || $a.find('sup').length > 0 || $a.attr('epub:type') === 'noteref') {
          footnoteHtml += this.$.html(aEl);
        }
      });

      // Sinh hoặc tái sử dụng id duy nhất
      const pId = targetP.attr('id');
      const sectionId = pId || `${tag}-${h.insertBeforeIdx}-${Math.random().toString(36).substring(2, 6)}`;
      const headingHtml = `<${tag} id="${sectionId}" class="section-${tag}">${cleanTitle}${footnoteHtml}</${tag}>`;

      // Kiểm tra: Nếu đoạn <p> chính là dòng tiêu đề (ví dụ text của <p> trùng hoặc tương tự tiêu đề)
      // thì thay thế <p> thành <h2/h3> để không bị lặp chữ
      const isSameText = pText.toLowerCase() === cleanTitle.toLowerCase() ||
        pText.startsWith(cleanTitle) ||
        cleanTitle.startsWith(pText);

      if (isSameText && pText.length < 120) {
        targetP.replaceWith(headingHtml);
      } else {
        targetP.before(headingHtml);
      }
    }
  }

  /**
   * Sửa lỗi chính tả trong các thẻ <p>
   */
  applySpellingFixes(fixes: SpellingFix[]): number {
    let appliedCount = 0;

    for (const fix of fixes) {
      if (!fix.original || !fix.fixed || fix.original === fix.fixed) continue;
      const targetP = this.$(`body p[data-pid="${fix.idx}"]`);
      if (targetP.length === 0) continue;

      let fixedText = fix.fixed;

      // Bảo vệ footnote markers: nếu fix.original có [N] hoặc [*] nhưng fix.fixed bị AI vô tình xoá mất
      const origNoteMatch = fix.original.match(/\[([0-9]+|\*+)\]/);
      if (origNoteMatch && !fixedText.includes(origNoteMatch[0])) {
        fixedText = `${fixedText}${origNoteMatch[0]}`;
      }

      const currentHtml = targetP.html() || '';
      // Thay thế chính xác chuỗi gốc
      if (currentHtml.includes(fix.original)) {
        targetP.html(currentHtml.replace(fix.original, fixedText));
        appliedCount++;
      }
    }

    return appliedCount;
  }

  /**
   * Áp dụng và liên kết chú thích (Footnotes / Endnotes):
   * - Kết hợp phân tích từ AI (aiFootnotes) và quét DOM thông minh
   * - Chuyển đổi các ký hiệu chú thích ([1], [*]...) trong bài thành link chuẩn EPUB 3 Pop-up
   * - Đóng gói các định nghĩa chú thích ở cuối chương thành thẻ <aside epub:type="footnote">
   * - Tự động gắn thuộc tính epub:type="noteref" cho các link sẵn có
   */
  applyFootnotes(aiFootnotes?: AiFootnoteAnalysis | null): {
    convertedRefs: number;
    convertedDefs: number;
  } {
    let convertedRefs = 0;
    let convertedDefs = 0;
    const fileSlug = this.chapterFileRelativeHref.replace(/[^a-zA-Z0-9]/g, '_');
    const paragraphs = this.$('body p').toArray();
    if (paragraphs.length < 3) {
      return { convertedRefs, convertedDefs };
    }

    // 1. Xác định vị trí bắt đầu của danh sách chú thích ở cuối chương
    let fnStartIdx = -1;
    if (
      aiFootnotes?.footnoteStartIdx != null &&
      aiFootnotes.footnoteStartIdx >= 0 &&
      aiFootnotes.footnoteStartIdx < paragraphs.length
    ) {
      fnStartIdx = aiFootnotes.footnoteStartIdx;
    } else {
      // Heuristic fallback: Quét từ nửa sau tài liệu
      for (let i = Math.floor(paragraphs.length / 2); i < paragraphs.length; i++) {
        const text = this.$(paragraphs[i]).text().trim();
        if (this.$(paragraphs[i]).find('a[href*="#"]').length > 0) continue;

        if (/^\s*(chú thích\s*:?|footnotes\s*:?|notes\s*:?)\s*$/i.test(text)) {
          fnStartIdx = i;
          break;
        }
        if (/^\s*\[([0-9]+|\*+)\]/.test(text) && this.$(paragraphs[i]).find('a').length === 0) {
          fnStartIdx = i;
          break;
        }
      }
    }

    interface NoteDefItem {
      num: string;
      elements: any[];
      term?: string;
    }
    const noteDefs: NoteDefItem[] = [];
    let currentNote: NoteDefItem | null = null;
    let headerEl: any = null;

    if (fnStartIdx !== -1) {
      for (let i = fnStartIdx; i < paragraphs.length; i++) {
        const pEl = paragraphs[i];
        const $p = this.$(pEl);
        const text = $p.text().trim();

        if (/^\s*(chú thích\s*:?|footnotes\s*:?|notes\s*:?)\s*$/i.test(text)) {
          headerEl = pEl;
          continue;
        }

        if (
          /^\s*(hết|the end|february|january|march|april|may|june|july|august|september|october|november|december)\b/i.test(text) &&
          i === paragraphs.length - 1
        ) {
          continue;
        }

        const defMatch = text.match(/^\s*\[([0-9]+|\*+)\]\s*(.*)/) || text.match(/^\s*([0-9]+)\s+([A-ZÀ-Ỹ].*)/);
        const aiItem = aiFootnotes?.items?.find((item) => item.defIdx === i);

        if (defMatch || aiItem) {
          const num = aiItem?.num || (defMatch ? (parseInt(defMatch[1], 10) > 10 && noteDefs.length === 0 ? '1' : defMatch[1]) : '1');
          currentNote = {
            num,
            elements: [pEl],
            term: aiItem?.term
          };
          noteDefs.push(currentNote);
        } else if (currentNote) {
          currentNote.elements.push(pEl);
        }
      }
    } else if (aiFootnotes?.items && aiFootnotes.items.length > 0) {
      // Nếu AI phát hiện các định nghĩa cụ thể theo defIdx
      for (const item of aiFootnotes.items) {
        const targetP = this.$(`body p[data-pid="${item.defIdx}"]`);
        if (targetP.length > 0) {
          noteDefs.push({
            num: item.num,
            elements: [targetP[0]],
            term: item.term
          });
        }
      }
    }

    // 2. Thay thế các ký hiệu gọi chú thích trong bài thành link chuẩn Pop-up
    if (noteDefs.length > 0) {
      const scanLimit = fnStartIdx !== -1 ? fnStartIdx : paragraphs.length;

      for (const def of noteDefs) {
        const refId = `fnref_${fileSlug}_${def.num}`;
        const targetId = `fn_${fileSlug}_${def.num}`;
        const linkHtml = `<a id="${refId}" href="#${targetId}" epub:type="noteref" role="doc-noteref" class="noteref"><sup>[${def.num}]</sup></a>`;

        // 2a. Nếu AI đã chỉ ra inTextIdx cụ thể
        const aiItem = aiFootnotes?.items?.find((it) => it.num === def.num);
        if (aiItem && aiItem.inTextIdx != null) {
          const inP = this.$(`body p[data-pid="${aiItem.inTextIdx}"]`);
          if (inP.length > 0 && inP.find(`a[href="#${targetId}"]`).length === 0) {
            let pHtml = inP.html() || '';
            let replaced = false;

            if (aiItem.markerText) {
              const escMarker = aiItem.markerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const mRegex = new RegExp(`(?<!<a[^>]*>)${escMarker}`);
              if (mRegex.test(pHtml)) {
                pHtml = pHtml.replace(mRegex, linkHtml);
                inP.html(pHtml);
                convertedRefs++;
                replaced = true;
              }
            }

            if (!replaced && def.term) {
              const escTerm = def.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const termMarkerRegex = new RegExp(`(?<!<a[^>]*>)(${escTerm})\\s*\\[?(${def.num}|\\*+)\\]?`);
              if (termMarkerRegex.test(pHtml)) {
                pHtml = pHtml.replace(termMarkerRegex, `$1${linkHtml}`);
                inP.html(pHtml);
                convertedRefs++;
                replaced = true;
              }
            }

            if (!replaced) {
              const simpleRegex = new RegExp(`(?<!<a[^>]*>)\\[${def.num}\\]`);
              if (simpleRegex.test(pHtml)) {
                pHtml = pHtml.replace(simpleRegex, linkHtml);
                inP.html(pHtml);
                convertedRefs++;
                replaced = true;
              }
            }
          }
        }

        // 2b. Quét các đoạn văn trước fnStartIdx để bắt marker [num] chưa được link
        for (let i = 0; i < scanLimit; i++) {
          const $p = this.$(paragraphs[i]);
          if ($p.find(`a[href="#${targetId}"]`).length > 0) continue;

          let pHtml = $p.html() || '';
          const markerRegex = new RegExp(`(?<!<a[^>]*>)\\[${def.num}\\]`, 'g');
          if (markerRegex.test(pHtml)) {
            pHtml = pHtml.replace(markerRegex, linkHtml);
            $p.html(pHtml);
            convertedRefs++;
          }
        }
      }

      // 3. Chuyển đổi các định nghĩa ở cuối chương thành <aside epub:type="footnote">
      for (const def of noteDefs) {
        const refId = `fnref_${fileSlug}_${def.num}`;
        const noteId = `fn_${fileSlug}_${def.num}`;

        const noteLines: string[] = [];
        def.elements.forEach((el, elIdx) => {
          let t = this.$(el).html() || '';
          if (elIdx === 0) {
            t = t.replace(/^\s*\[?([0-9]+|\*+)\]?\s*\]?\s*/, '').replace(/^\s*[0-9]+\s*\]?\s*(?=[A-ZÀ-Ỹ])/, '');
          }
          if (t.trim()) {
            noteLines.push(t.trim());
          }
        });

        const noteBodyHtml = noteLines.join(' ');
        const asideHtml = `<aside id="${noteId}" class="chapter-footnote" epub:type="footnote" role="doc-footnote">\n  <p><a href="#${refId}" class="footnote-backlink"><sup>[${def.num}]</sup></a> ${noteBodyHtml}</p>\n</aside>`;

        this.$(def.elements[0]).replaceWith(asideHtml);
        for (let k = 1; k < def.elements.length; k++) {
          this.$(def.elements[k]).remove();
        }
        convertedDefs++;
      }

      // 4. Chuẩn hoá tiêu đề "Chú thích:"
      if (headerEl) {
        this.$(headerEl).replaceWith('<p class="footnotes-heading"><strong>Chú thích:</strong></p>');
      }
    }

    // 5. Nâng cấp các thẻ <a> chú thích đã có sẵn lên chuẩn EPUB 3 Pop-up
    this.$('a[href*="#"]').each((_, el) => {
      const $a = this.$(el);
      const href = $a.attr('href') || '';
      const [, targetId] = href.split('#');
      if (!targetId) return;

      if (/^(chuthich|footnote|fn|note)/i.test(targetId) || $a.find('sup').length > 0) {
        if (!$a.attr('epub:type')) {
          $a.attr('epub:type', 'noteref');
          $a.attr('role', 'doc-noteref');
        }
      }
    });

    // 6. Đảm bảo thuộc tính xmlns:epub trên <html>
    const $html = this.$('html');
    if (!$html.attr('xmlns:epub')) {
      $html.attr('xmlns:epub', 'http://www.idpf.org/2007/ops');
    }

    return { convertedRefs, convertedDefs };
  }

  /**
   * Xoá các thuộc tính tạm data-pid trước khi xuất file
   */
  cleanTemporaryAttributes(): void {
    this.$('[data-pid]').removeAttr('data-pid');
  }

  /**
   * Thu thập tất cả các Heading (H1, H2, H3) trong file để phục vụ xây dựng TOC
   */
  collectHeadings(): HeadingItem[] {
    const list: HeadingItem[] = [];
    const hasH1 = this.$('h1').length > 0;

    this.$('h1, h2, h3').each((_, el) => {
      const $el = this.$(el);
      const tagName = (el as any).tagName?.toLowerCase();
      let level: 1 | 2 | 3 = 1;
      if (tagName === 'h2') level = 2;
      else if (tagName === 'h3') level = 3;

      const title = $el.text().trim();
      if (!title) return;

      // Nếu trong file KHÔNG có thẻ h1 nào, nhưng h2 lại là tên chương chính ("Chương 1", "Chapter 1"...)
      // thì mới thăng cấp lên Level 1 để TOC không bị mồ côi
      if (!hasH1 && CHAPTER_REGEX.test(title) && level > 1) {
        level = 1;
      }

      let id = $el.attr('id') || $el.find('a[id]').attr('id');
      if (!id) {
        id = `hdr-${level}-${Math.random().toString(36).substring(2, 7)}`;
        $el.attr('id', id);
      }

      list.push({
        id,
        level,
        title,
        href: `${this.chapterFileRelativeHref}#${id}`,
        children: []
      });
    });

    return list;
  }

  /**
   * Xuất toàn bộ nội dung HTML/XHTML đã chỉnh sửa
   */
  serialize(): string {
    this.cleanTemporaryAttributes();
    return this.$.xml();
  }
}
