import * as cheerio from 'cheerio';
import type { HeadingItem, HeadingSuggestion, SpellingFix } from '../types/index.js';
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
   * - Xoá các thẻ trùng lặp thừa ở đầu trang trong container
   */
  normalizeH1(newH1Title: string, removeTopIndices: number[] = [], preferredId?: string): string {
    const container = this.getContentContainer();
    let chosenId = preferredId;

    // Tìm xem trong các thẻ đầu trang có ID nào sẵn có không (ví dụ id="filepos8338")
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

    // Xác định các thẻ top cần xoá
    let topCount = 0;
    const elementsToRemove: cheerio.Cheerio<any>[] = [];
    let firstElementToReplace: cheerio.Cheerio<any> | null = null;

    container.children().each((i, el) => {
      const $el = this.$(el);
      const text = $el.text().replace(/\s+/g, ' ').trim();
      const tagName = (el as any).tagName?.toLowerCase() || '';

      if (tagName === 'div' && (!text || text === ' ' || text === '&#160;')) return;

      if (removeTopIndices.includes(topCount)) {
        if (!firstElementToReplace) {
          firstElementToReplace = $el;
        } else {
          elementsToRemove.push($el);
        }
      }
      topCount++;
    });

    const h1Html = `<h1 id="${chosenId}" class="chapter-h1">${newH1Title}</h1>`;

    if (firstElementToReplace) {
      (firstElementToReplace as any).replaceWith(h1Html);
      for (const $rem of elementsToRemove) {
        $rem.remove();
      }
    } else {
      // Nếu không chỉ định thẻ cần xoá, kiểm tra xem có h1 sẵn chưa
      const existingH1 = container.find('h1').first();
      if (existingH1.length > 0) {
        existingH1.attr('id', chosenId);
        existingH1.addClass('chapter-h1');
        existingH1.text(newH1Title);
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

      // Sinh id duy nhất
      const sectionId = `${tag}-${h.insertBeforeIdx}-${Math.random().toString(36).substring(2, 6)}`;
      const headingHtml = `<${tag} id="${sectionId}" class="section-${tag}">${cleanTitle}</${tag}>`;

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

      const currentHtml = targetP.html() || '';
      // Thay thế chính xác chuỗi gốc
      if (currentHtml.includes(fix.original)) {
        targetP.html(currentHtml.replace(fix.original, fix.fixed));
        appliedCount++;
      }
    }

    return appliedCount;
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

    this.$('h1, h2, h3').each((_, el) => {
      const $el = this.$(el);
      const tagName = (el as any).tagName?.toLowerCase();
      let level: 1 | 2 | 3 = 1;
      if (tagName === 'h2') level = 2;
      else if (tagName === 'h3') level = 3;

      const title = $el.text().trim();
      if (!title) return;

      // Các tiêu đề khớp mẫu "Chương 1", "Chapter 1"... luôn được gán Level 1 (mục chính)
      if (CHAPTER_REGEX.test(title)) {
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
