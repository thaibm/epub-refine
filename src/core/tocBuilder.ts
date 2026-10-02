import path from 'node:path';
import * as cheerio from 'cheerio';
import type { HeadingItem } from '../types/index.js';

export class TocBuilder {
  /**
   * Chuyển đổi danh sách phẳng các heading thành cây phân cấp:
   * Level 1 -> Level 2 -> Level 3
   */
  static buildTree(flatHeadings: HeadingItem[]): HeadingItem[] {
    const rootNodes: HeadingItem[] = [];
    let currentH1: HeadingItem | null = null;
    let currentH2: HeadingItem | null = null;

    for (const item of flatHeadings) {
      const node: HeadingItem = {
        ...item,
        children: []
      };

      if (item.level === 1) {
        rootNodes.push(node);
        currentH1 = node;
        currentH2 = null;
      } else if (item.level === 2) {
        if (currentH1) {
          currentH1.children.push(node);
        } else {
          // Nếu chưa có H1, đưa tạm vào root
          rootNodes.push(node);
        }
        currentH2 = node;
      } else if (item.level === 3) {
        if (currentH2) {
          currentH2.children.push(node);
        } else if (currentH1) {
          currentH1.children.push(node);
        } else {
          rootNodes.push(node);
        }
      }
    }

    return rootNodes;
  }

  /**
   * Sinh file toc.ncx (EPUB 2) chuẩn XML với các navPoint lồng nhau
   */
  static generateNcx(tree: HeadingItem[], bookTitle: string, bookUid: string): string {
    let playOrder = 1;

    function renderNavPoints(nodes: HeadingItem[]): string {
      let xml = '';
      for (const node of nodes) {
        const currentOrder = playOrder++;
        const safeTitle = escapeXml(node.title);
        const safeHref = escapeXml(node.href);
        const pointId = `nav_${currentOrder}`;

        xml += `    <navPoint id="${pointId}" playOrder="${currentOrder}">\n`;
        xml += `      <navLabel>\n`;
        xml += `        <text>${safeTitle}</text>\n`;
        xml += `      </navLabel>\n`;
        xml += `      <content src="${safeHref}"/>\n`;

        if (node.children && node.children.length > 0) {
          xml += renderNavPoints(node.children);
        }

        xml += `    </navPoint>\n`;
      }
      return xml;
    }

    const navPointsXml = renderNavPoints(tree);

    return `<?xml version='1.0' encoding='utf-8'?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="vie">
  <head>
    <meta content="${escapeXml(bookUid)}" name="dtb:uid"/>
    <meta content="3" name="dtb:depth"/>
    <meta content="0" name="dtb:totalPageCount"/>
    <meta content="0" name="dtb:maxPageNumber"/>
  </head>
  <docTitle>
    <text>${escapeXml(bookTitle)}</text>
  </docTitle>
  <navMap>
${navPointsXml}  </navMap>
</ncx>
`;
  }

  /**
   * Sinh file nav.xhtml (EPUB 3) chuẩn Navigation Document
   */
  static generateNavXhtml(tree: HeadingItem[], bookTitle: string, cssHref = 'stylesheet.css'): string {
    function renderOl(nodes: HeadingItem[]): string {
      let html = '<ol>\n';
      for (const node of nodes) {
        html += `  <li>\n`;
        html += `    <a href="${escapeXml(node.href)}">${escapeXml(node.title)}</a>\n`;
        if (node.children && node.children.length > 0) {
          html += renderOl(node.children);
        }
        html += `  </li>\n`;
      }
      html += '</ol>\n';
      return html;
    }

    const olHtml = renderOl(tree);

    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Mục lục - ${escapeXml(bookTitle)}</title>
  <meta charset="utf-8"/>
  <link href="${escapeXml(cssHref)}" rel="stylesheet" type="text/css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    ${olHtml}
  </nav>
</body>
</html>
`;
  }

  /**
   * Cập nhật trang mục lục đọc trực tiếp trong sách (Inline Reading TOC như part0001.html, part0014.html, index_split_003.html)
   */
  static updateInlineToc(
    tocHtmlContent: string,
    tree: HeadingItem[],
    tocFileRelativeZipPath: string
  ): string {
    const $ = cheerio.load(tocHtmlContent, {
      xml: { decodeEntities: false }
    });

    const tocFileDir = path.posix.dirname(tocFileRelativeZipPath);

    function renderList(nodes: HeadingItem[], depth = 1): string {
      const ulClass = depth === 1 ? 'toc-list level' : `level level-h${depth}`;
      let html = `<ul class="${ulClass}">\n`;
      for (const node of nodes) {
        const [targetPath, targetHash] = node.href.split('#');
        let relLink = path.posix.relative(tocFileDir, targetPath);
        if (targetHash) relLink += `#${targetHash}`;

        const safeTitle = escapeXml(node.title);
        const safeHref = escapeXml(relLink);

        html += `  <li class="toc-item calibre5">`;
        html += `<a href="${safeHref}" class="toc-link pcalibre calibre6">${safeTitle}</a>`;
        if (node.children && node.children.length > 0) {
          html += '\n' + renderList(node.children, depth + 1);
        }
        html += `</li>\n`;
      }
      html += `</ul>\n`;
      return html;
    }

    const newUlHtml = renderList(tree);

    // 1. Nếu có thẻ ul/ol sẵn thì thay thế
    const targetUl = $('ul.level, ul, ol').first();
    if (targetUl.length > 0) {
      targetUl.replaceWith(newUlHtml);
    } else {
      // 2. Nếu là file mục lục dạng các thẻ p liên kết (như Calibre index_split_003.html)
      const linkParagraphs = $('p, div').filter((_, el) => {
        const $el = $(el);
        const a = $el.find('a[href]');
        return a.length > 0 && ($el.is('p') || $el.hasClass('calibre8'));
      });

      if (linkParagraphs.length > 0) {
        linkParagraphs.first().before(newUlHtml);
        linkParagraphs.remove();
        // Dọn dẹp các thẻ div spacer rỗng cũ xung quanh danh sách
        $('div').each((_, el) => {
          const $d = $(el);
          const cls = $d.attr('class') || '';
          if (cls.includes('calibre_3') || cls.includes('calibre_5') || cls.includes('calibre_9')) {
            const t = $d.text().replace(/\s+/g, ' ').trim();
            if (!t || t === ' ' || t === '&#160;') {
              $d.remove();
            }
          }
        });
      } else {
        const container = $('body > div.calibre1, body > div, body').first();
        container.append(newUlHtml);
      }
    }

    // Đảm bảo có h1 hoặc h2 "Mục lục"
    const existingHeading = $('h1, h2').first();
    if (existingHeading.length === 0) {
      const container = $('body > div.calibre1, body > div, body').first();
      container.prepend('<h1 class="chapter-h1">Mục lục</h1>');
    }

    return $.xml();
  }
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
