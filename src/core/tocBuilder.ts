import path from 'node:path';
import * as cheerio from 'cheerio';
import type { HeadingItem } from '../types/index.js';

export function cleanTocTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/<[^>]+>/g, '')
    .replace(/\s*\[(?:\*+|\d+)\]/g, '')
    .replace(/\s*\*+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
        title: cleanTocTitle(item.title),
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
        const safeTitle = escapeXml(cleanTocTitle(node.title));
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
        const safeTitle = escapeXml(cleanTocTitle(node.title));
        html += `  <li>\n`;
        html += `    <a href="${escapeXml(node.href)}">${safeTitle}</a>\n`;
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

        const safeTitle = escapeXml(cleanTocTitle(node.title));
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

  /**
   * Quét toàn bộ sách và đồng bộ nav.xhtml, toc.ncx và các trang Inline TOC
   */
  static syncAllToc(
    unpacked: any,
    opfManager: any,
    customTitle?: string
  ): { totalHeadings: number; navZipPath: string; ncxZipPath: string } {
    const pkg = opfManager.getPackageInfo();
    const title = customTitle || pkg.metadata.title || 'Untitled';
    const spineChapters = opfManager.getSpineChapterFiles();
    const fullBookHeadings: HeadingItem[] = [];

    for (const ch of spineChapters) {
      const name = ch.relativeHref.toLowerCase();
      if (
        name.includes('titlepage') ||
        name.includes('cover') ||
        name.includes('part0000') ||
        name.includes('part0001') ||
        name.includes('part0014')
      ) {
        continue;
      }

      if (!unpacked.hasFile(ch.zipPath)) continue;
      const html = unpacked.getFileString(ch.zipPath);
      const $ = cheerio.load(html, { xml: { decodeEntities: false } });

      $('h1, h2, h3').each((_, el) => {
        const $el = $(el);
        const tag = el.tagName.toLowerCase();
        const level = tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3;
        const $clone = $el.clone();
        $clone.find('a[href*="#"], a[role*="doc-noteref"], a[epub\\:type*="noteref"], sup, aside').remove();
        const text = cleanTocTitle($clone.text());
        if (!text) return;

        let id = $el.attr('id');
        if (!id) {
          id = `h_${level}_${Math.random().toString(36).substring(2, 8)}`;
          $el.attr('id', id);
          unpacked.setFileString(ch.zipPath, $.xml());
        }

        fullBookHeadings.push({
          id,
          level,
          title: text,
          href: `${ch.relativeHref}#${id}`,
          children: []
        });
      });
    }

    const tocTree = TocBuilder.buildTree(fullBookHeadings);
    const bookUid = pkg.metadata.identifier || `urn:uuid:${Math.random().toString(36).substring(2)}`;

    // 1. Cập nhật toc.ncx
    const ncxContent = TocBuilder.generateNcx(tocTree, title, bookUid);
    const ncxPath = pkg.tocHref ? opfManager.resolvePathInZip(pkg.tocHref) : 'toc.ncx';
    unpacked.setFileString(ncxPath, ncxContent);

    // 2. Cập nhật nav.xhtml
    const navContent = TocBuilder.generateNavXhtml(tocTree, title);
    const navRelativeHref = 'nav.xhtml';
    const navZipPath = opfManager.resolvePathInZip(navRelativeHref);
    unpacked.setFileString(navZipPath, navContent);
    opfManager.ensureManifestItem('nav', navRelativeHref, 'application/xhtml+xml', 'nav');
    opfManager.save();

    // 3. Cập nhật Inline TOC nếu có
    const allFiles = unpacked.listFiles();
    for (const f of allFiles) {
      if (!f.endsWith('.html') && !f.endsWith('.xhtml')) continue;
      const content = unpacked.getFileString(f);
      const lower = content.toLowerCase();

      const isInlineToc =
        lower.includes('mục lục | table of contents') ||
        lower.includes('calibre_generated_inline_toc') ||
        (lower.includes('table of contents') &&
          (lower.includes('<ul class="level"') || lower.includes("<ul class='level'")));

      if (isInlineToc) {
        const updatedHtml = TocBuilder.updateInlineToc(content, tocTree, f);
        unpacked.setFileString(f, updatedHtml);
      }
    }

    return {
      totalHeadings: fullBookHeadings.length,
      navZipPath,
      ncxZipPath: ncxPath
    };
  }

  /**
   * Đọc và phân tích cây mục lục từ file toc.ncx sẵn có trong sách
   */
  static parseNcxToTree(ncxXml: string): HeadingItem[] {
    const $ = cheerio.load(ncxXml, { xmlMode: true });

    function parseNavPoints(parent: any): HeadingItem[] {
      const items: HeadingItem[] = [];
      $(parent).children('navPoint').each((_, el) => {
        const id = $(el).attr('id') || `nav_${Math.random().toString(36).substring(2, 8)}`;
        const title = $(el).children('navLabel').children('text').text().trim() || 'Untitled';
        const href = $(el).children('content').attr('src') || '';
        const children = parseNavPoints(el);
        items.push({
          id,
          level: 1,
          title,
          href,
          children
        });
      });
      return items;
    }

    return parseNavPoints($('navMap'));
  }

  /**
   * Đọc và phân tích cây mục lục từ file nav.xhtml (EPUB 3 Navigation Document)
   */
  static parseNavXhtmlToTree(navHtml: string): HeadingItem[] {
    const $ = cheerio.load(navHtml, { xml: { decodeEntities: false } });

    function parseOl(olEl: any, level: 1 | 2 | 3 = 1): HeadingItem[] {
      const res: HeadingItem[] = [];
      $(olEl).children('li').each((_, li) => {
        const $li = $(li);
        const $a = $li.children('a').first();
        if ($a.length === 0) return;

        const href = $a.attr('href') || '';
        const title = cleanTocTitle($a.text());
        const id = $a.attr('id') || `nav_${Math.random().toString(36).substring(2, 8)}`;
        const $subOl = $li.children('ol').first();
        const nextLevel = Math.min(3, level + 1) as 1 | 2 | 3;
        const children = $subOl.length > 0 ? parseOl($subOl, nextLevel) : [];

        res.push({
          id,
          level,
          title,
          href,
          children
        });
      });
      return res;
    }

    const $mainOl = $('nav[epub\\:type="toc"] > ol, nav#toc > ol, nav > ol').first();
    if ($mainOl.length > 0) {
      return parseOl($mainOl, 1);
    }
    return [];
  }

  /**
   * Trích xuất bản đồ ánh xạ từ đường dẫn file sang Tiêu đề chương chuẩn từ nav.xhtml hoặc toc.ncx.
   * Hỗ trợ ánh xạ cả tên file chính xác lẫn file cùng nhóm phân tách (split parts, ví dụ: chapter0002_split_001.html).
   */
  static getTocMap(unpacked: any, opfManager: any): Map<string, string> {
    const map = new Map<string, string>();

    // 1. Ưu tiên đọc nav.xhtml
    const navZipPath = opfManager.resolvePathInZip('nav.xhtml');
    let tree: HeadingItem[] = [];

    if (unpacked.hasFile(navZipPath)) {
      const navHtml = unpacked.getFileString(navZipPath);
      tree = TocBuilder.parseNavXhtmlToTree(navHtml);
    } else if (unpacked.hasFile('nav.xhtml')) {
      const navHtml = unpacked.getFileString('nav.xhtml');
      tree = TocBuilder.parseNavXhtmlToTree(navHtml);
    }

    // 2. Nếu không có nav.xhtml, đọc toc.ncx
    if (tree.length === 0) {
      const pkg = opfManager.getPackageInfo();
      const ncxPath = pkg.tocHref ? opfManager.resolvePathInZip(pkg.tocHref) : 'toc.ncx';
      if (unpacked.hasFile(ncxPath)) {
        tree = TocBuilder.parseNcxToTree(unpacked.getFileString(ncxPath));
      }
    }

    function fillMap(nodes: HeadingItem[]) {
      for (const node of nodes) {
        if (node.href && node.title) {
          const rawHref = node.href.split('#')[0];
          const normalized = rawHref.replace(/\\/g, '/').replace(/^\/+/, '');
          const fileName = path.posix.basename(normalized);

          map.set(normalized, node.title);
          map.set(fileName, node.title);

          // Nếu file có dạng prefix_split_000.html, ánh xạ cả tiền tố (ví dụ chapter0002)
          const splitMatch = fileName.match(/^(.*?_split_|\w+?)_?(?:split_)?\d+\.(?:x?html)$/i);
          const baseMatch = fileName.match(/^([a-zA-Z]+[0-9]+)/);
          if (baseMatch) {
            map.set(baseMatch[1], node.title);
          }
        }
        if (node.children && node.children.length > 0) {
          fillMap(node.children);
        }
      }
    }

    fillMap(tree);
    return map;
  }

  /**
   * BẢO TỒN VÀ ĐỒNG BỘ MỤC LỤC GỐC:
   * 1. Nếu sách đã có nav.xhtml (EPUB 3) -> GIỮ NGUYÊN và đồng bộ sang toc.ncx (EPUB 2).
   * 2. Nếu sách đã có toc.ncx gốc -> GIỮ NGUYÊN và sinh nav.xhtml từ toc.ncx.
   * 3. Chỉ khi sách hoàn toàn không có mục lục nào mới quét H1-H3 để tạo mới.
   */
  static preserveAndSyncToc(
    unpacked: any,
    opfManager: any,
    customTitle?: string
  ): { totalHeadings: number; navZipPath?: string; ncxZipPath?: string } {
    const pkg = opfManager.getPackageInfo();
    const title = customTitle || pkg.metadata.title || 'Untitled';
    const bookUid = pkg.metadata.identifier || `urn:uuid:${Math.random().toString(36).substring(2)}`;

    // 1. Ưu tiên kiểm tra file nav.xhtml (EPUB 3)
    const navRelativeHref = 'nav.xhtml';
    const navZipPath = opfManager.resolvePathInZip(navRelativeHref);
    if (unpacked.hasFile(navZipPath)) {
      const navHtml = unpacked.getFileString(navZipPath);
      const navTree = TocBuilder.parseNavXhtmlToTree(navHtml);
      if (navTree.length > 0) {
        // Đồng bộ sang toc.ncx (EPUB 2)
        const ncxPath = pkg.tocHref ? opfManager.resolvePathInZip(pkg.tocHref) : 'toc.ncx';
        const ncxDir = path.posix.dirname(ncxPath);
        const navDir = path.posix.dirname(navZipPath);

        function adjustHrefsForNcx(nodes: HeadingItem[]): HeadingItem[] {
          return nodes.map((node) => {
            let adjustedHref = node.href;
            if (navDir !== ncxDir) {
              const targetZipPath = path.posix.join(navDir, node.href);
              adjustedHref = path.posix.relative(ncxDir, targetZipPath);
            }
            return {
              ...node,
              href: adjustedHref,
              children: adjustHrefsForNcx(node.children)
            };
          });
        }

        const adjustedTree = adjustHrefsForNcx(navTree);
        const ncxContent = TocBuilder.generateNcx(adjustedTree, title, bookUid);
        unpacked.setFileString(ncxPath, ncxContent);

        opfManager.ensureManifestItem('nav', navRelativeHref, 'application/xhtml+xml', 'nav');
        opfManager.save();

        return {
          totalHeadings: navTree.length,
          navZipPath,
          ncxZipPath: ncxPath
        };
      }
    }

    // 2. Kiểm tra file toc.ncx gốc
    const ncxPath = pkg.tocHref
      ? opfManager.resolvePathInZip(pkg.tocHref)
      : unpacked.hasFile('toc.ncx')
      ? 'toc.ncx'
      : unpacked.hasFile('OEBPS/toc.ncx')
      ? 'OEBPS/toc.ncx'
      : 'toc.ncx';

    let ncxTree: HeadingItem[] = [];

    if (unpacked.hasFile(ncxPath)) {
      const ncxContent = unpacked.getFileString(ncxPath);
      ncxTree = TocBuilder.parseNcxToTree(ncxContent);
    }

    if (ncxTree.length > 0) {
      const navDir = path.posix.dirname(navZipPath);
      const ncxDir = path.posix.dirname(ncxPath);

      function adjustHrefs(nodes: HeadingItem[]): HeadingItem[] {
        return nodes.map((node) => {
          let adjustedHref = node.href;
          if (navDir !== ncxDir) {
            const targetZipPath = path.posix.join(ncxDir, node.href);
            adjustedHref = path.posix.relative(navDir, targetZipPath);
          }
          return {
            ...node,
            href: adjustedHref,
            children: adjustHrefs(node.children)
          };
        });
      }

      const adjustedTree = adjustHrefs(ncxTree);
      const navContent = TocBuilder.generateNavXhtml(adjustedTree, title);
      unpacked.setFileString(navZipPath, navContent);
      opfManager.ensureManifestItem('nav', navRelativeHref, 'application/xhtml+xml', 'nav');
      opfManager.save();

      return {
        totalHeadings: ncxTree.length,
        navZipPath,
        ncxZipPath: ncxPath
      };
    }

    // 3. Fallback: chỉ khi sách hoàn toàn không có TOC nào mới quét H1/H2/H3
    return TocBuilder.syncAllToc(unpacked, opfManager, customTitle);
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
