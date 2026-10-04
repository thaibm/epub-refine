import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as cheerio from 'cheerio';
import { TocBuilder } from '../core/tocBuilder.js';
import { STANDARD_HEADING_CSS } from '../core/styleManager.js';
import { loadEpubFromDir } from '../core/epubArchive.js';
import { FootnoteProcessor } from '../core/footnoteProcessor.js';
import type { HeadingItem } from '../types/index.js';
import type { SourceEpubMeta } from '../core/epubArchive.js';

export interface ChapterDraft {
  id: string;
  title: string;
  htmlBody: string;
  level: number;
}

export interface WorkspaceCreationOptions {
  bookTitle: string;
  author?: string;
  sourcePdfPath: string;
  coverImagePath?: string;
  targetDir?: string;
  autoFootnotes?: boolean;
}

const DEFAULT_CSS = `/* ========================================================
   EPUB Base Stylesheet
   ======================================================== */
@charset "utf-8";

body {
  margin: 5% 5% 5% 5%;
  text-align: justify;
  line-height: 1.6;
  font-family: serif;
}

p {
  margin-top: 0;
  margin-bottom: 0.8em;
  text-indent: 1.5em;
}

p.no-indent, .footnotes p {
  text-indent: 0;
}

blockquote {
  margin: 1em 2em;
  font-style: italic;
  color: #444;
}

.cover-image {
  text-align: center;
  margin: 0;
  padding: 0;
}

.cover-image img {
  max-width: 100%;
  max-height: 100vh;
  height: auto;
}

.footnotes {
  margin-top: 2em;
  padding-top: 1em;
  border-top: 1px solid #ccc;
  font-size: 0.9em;
}

a.noteref, a[epub\\:type="noteref"] {
  text-decoration: none;
  font-weight: bold;
}

${STANDARD_HEADING_CSS}
`;

/**
 * Phân tích chuỗi HTML gộp từ các batch để tách thành từng chương dựa trên thẻ <h1>
 */
export function splitHtmlIntoChapters(fullHtml: string, fallbackTitle: string): ChapterDraft[] {
  const $ = cheerio.load(fullHtml, { xml: { decodeEntities: false } });
  const h1Elements = $('h1').toArray();

  if (h1Elements.length === 0) {
    // Không có thẻ H1 nào, coi toàn bộ là 1 chương
    return [
      {
        id: 'part0001',
        title: fallbackTitle,
        htmlBody: $('body').html() || fullHtml,
        level: 1
      }
    ];
  }

  const chapters: ChapterDraft[] = [];
  
  // Kiểm tra phần mở đầu trước thẻ h1 đầu tiên nếu có
  const firstH1 = h1Elements[0];
  const prevNodes = $(firstH1).prevAll().toArray().reverse();
  if (prevNodes.length > 0) {
    const preambleHtml = prevNodes.map((n) => $.html(n)).join('\n');
    const preambleText = prevNodes.map((n) => $(n).text().trim()).join(' ');
    if (preambleText.length > 50) {
      chapters.push({
        id: `part${String(chapters.length + 1).padStart(4, '0')}`,
        title: 'Lời Mở Đầu',
        htmlBody: `<h1>Lời Mở Đầu</h1>\n${preambleHtml}`,
        level: 1
      });
    }
  }

  for (let i = 0; i < h1Elements.length; i++) {
    const h1 = h1Elements[i];
    const title = $(h1).text().trim() || `Chương ${i + 1}`;
    
    // Thu thập tất cả các phần tử giữa h1 hiện tại và h1 tiếp theo
    const contentNodes: string[] = [$.html(h1)];
    let curr = $(h1).next();
    
    while (curr.length > 0 && curr[0].tagName !== 'h1') {
      contentNodes.push($.html(curr));
      curr = curr.next();
    }

    chapters.push({
      id: `part${String(chapters.length + 1).padStart(4, '0')}`,
      title,
      htmlBody: contentNodes.join('\n'),
      level: 1
    });
  }

  return chapters;
}

/**
 * Dựng cấu trúc thư mục EPUB hoàn chỉnh vào workspace/ và khởi tạo Git diff
 */
export async function buildEpubWorkspace(
  chapters: ChapterDraft[],
  options: WorkspaceCreationOptions
): Promise<string> {
  const workspaceDir = path.resolve(options.targetDir || 'workspace');
  const oebpsDir = path.join(workspaceDir, 'OEBPS');
  const metaInfDir = path.join(workspaceDir, 'META-INF');
  const imagesDir = path.join(oebpsDir, 'images');

  // 1. Chuẩn bị thư mục (giữ lại .git nếu có)
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  } else {
    const entries = fs.readdirSync(workspaceDir);
    for (const entry of entries) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(workspaceDir, entry), { recursive: true, force: true });
    }
  }

  fs.mkdirSync(metaInfDir, { recursive: true });
  fs.mkdirSync(oebpsDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });

  // 2. Ghi file mimetype (bắt buộc STORE không nén ở vị trí đầu)
  fs.writeFileSync(path.join(workspaceDir, 'mimetype'), 'application/epub+zip', 'utf-8');

  // 3. Ghi file META-INF/container.xml
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  fs.writeFileSync(path.join(metaInfDir, 'container.xml'), containerXml, 'utf-8');

  // 4. Xử lý ảnh bìa
  let hasCoverImage = false;
  if (options.coverImagePath && fs.existsSync(options.coverImagePath)) {
    const destCover = path.join(imagesDir, 'cover.jpg');
    fs.copyFileSync(options.coverImagePath, destCover);
    hasCoverImage = true;
  }

  // 5. Ghi file styles.css
  fs.writeFileSync(path.join(oebpsDir, 'styles.css'), DEFAULT_CSS, 'utf-8');

  // 6. Ghi trang bìa cover.xhtml nếu có ảnh
  if (hasCoverImage) {
    const coverXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi">
<head>
  <title>Bìa sách</title>
  <meta charset="utf-8"/>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <div class="cover-image">
    <img src="images/cover.jpg" alt="Bìa sách ${options.bookTitle}"/>
  </div>
</body>
</html>
`;
    fs.writeFileSync(path.join(oebpsDir, 'cover.xhtml'), coverXhtml, 'utf-8');
  }

  // 7. Ghi các chương nội dung và thu thập Headings để dựng TOC
  const fullBookHeadings: HeadingItem[] = [];

  for (let idx = 0; idx < chapters.length; idx++) {
    const ch = chapters[idx];
    const fileName = `${ch.id}.xhtml`;
    const filePath = path.join(oebpsDir, fileName);

    const $ = cheerio.load(`<body>${ch.htmlBody}</body>`, { xml: { decodeEntities: false } });

    // Đánh ID anchor cho tất cả H1, H2, H3
    let headingCounter = 0;
    $('h1, h2, h3').each((_, el) => {
      headingCounter++;
      const tag = el.tagName.toLowerCase();
      const level = tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3;
      const text = $(el).text().trim();
      let anchorId = $(el).attr('id');

      if (!anchorId) {
        anchorId = `section_${ch.id}_${headingCounter}`;
        $(el).attr('id', anchorId);
      }

      fullBookHeadings.push({
        id: anchorId,
        level: level as 1 | 2 | 3,
        title: text,
        href: `${fileName}#${anchorId}`,
        children: []
      });
    });

    const bodyInner = $('body').html() || ch.htmlBody;
    const xhtmlContent = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="vi" lang="vi">
<head>
  <title>${ch.title}</title>
  <meta charset="utf-8"/>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
${bodyInner}
</body>
</html>
`;
    fs.writeFileSync(filePath, xhtmlContent, 'utf-8');
  }

  // 8. Dựng TOC Tree và sinh nav.xhtml & toc.ncx
  const tocTree = TocBuilder.buildTree(fullBookHeadings);
  const bookUid = `urn:uuid:${Math.random().toString(36).substring(2, 12)}`;

  const navXhtml = TocBuilder.generateNavXhtml(tocTree, options.bookTitle, 'styles.css');
  fs.writeFileSync(path.join(oebpsDir, 'nav.xhtml'), navXhtml, 'utf-8');

  const tocNcx = TocBuilder.generateNcx(tocTree, options.bookTitle, bookUid);
  fs.writeFileSync(path.join(oebpsDir, 'toc.ncx'), tocNcx, 'utf-8');

  // 9. Sinh file content.opf
  const manifestItems: string[] = [
    `    <item id="css" href="styles.css" media-type="text/css"/>`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
  ];

  if (hasCoverImage) {
    manifestItems.push(`    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>`);
    manifestItems.push(`    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
  }

  for (const ch of chapters) {
    manifestItems.push(`    <item id="${ch.id}" href="${ch.id}.xhtml" media-type="application/xhtml+xml"/>`);
  }

  const spineItems: string[] = [];
  if (hasCoverImage) {
    spineItems.push(`    <itemref idref="cover" linear="no"/>`);
  }
  spineItems.push(`    <itemref idref="nav"/>`);
  for (const ch of chapters) {
    spineItems.push(`    <itemref idref="${ch.id}"/>`);
  }

  const opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${options.bookTitle}</dc:title>
    <dc:language>vi</dc:language>
    <dc:identifier id="BookId">${bookUid}</dc:identifier>
    ${options.author ? `<dc:creator>${options.author}</dc:creator>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.[0-9]+Z$/, 'Z')}</meta>
    ${hasCoverImage ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx">
${spineItems.join('\n')}
  </spine>
  <guide>
    ${hasCoverImage ? '<reference type="cover" title="Bìa sách" href="cover.xhtml"/>' : ''}
    <reference type="toc" title="Mục lục" href="nav.xhtml"/>
    <reference type="text" title="Nội dung" href="${chapters[0]?.id || 'part0001'}.xhtml"/>
  </guide>
</package>
`;
  fs.writeFileSync(path.join(oebpsDir, 'content.opf'), opfXml, 'utf-8');

  // 10. Ghi file .epub-source.json
  const sourceMeta: SourceEpubMeta = {
    sourcePath: path.resolve(options.sourcePdfPath),
    fileName: path.basename(options.sourcePdfPath),
    baseName: path.basename(options.sourcePdfPath, path.extname(options.sourcePdfPath)),
    unpackedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(workspaceDir, '.epub-source.json'), JSON.stringify(sourceMeta, null, 2), 'utf-8');

  // 11. Khởi tạo Git commit gốc trong workspace
  try {
    const gitDir = path.join(workspaceDir, '.git');
    if (!fs.existsSync(gitDir)) {
      execSync('git init', { cwd: workspaceDir, stdio: 'ignore' });
      execSync('git config user.name "EPUB Editor"', { cwd: workspaceDir, stdio: 'ignore' });
      execSync('git config user.email "epub@editor.local"', { cwd: workspaceDir, stdio: 'ignore' });
    }
    execSync('git add .', { cwd: workspaceDir, stdio: 'ignore' });
    const status = execSync('git status --porcelain', { cwd: workspaceDir, encoding: 'utf-8' });
    if (status.trim()) {
      execSync('git commit -m "Original PDF extracted content (Bản trích xuất gốc từ PDF)"', {
        cwd: workspaceDir,
        stdio: 'ignore'
      });
    }
  } catch {
    // Bỏ qua nếu có lỗi git nhỏ
  }

  // 12. Tự động chạy FootnoteProcessor để chuyển thành EPUB 3 Pop-up
  if (options.autoFootnotes !== false) {
    try {
      const unpacked = loadEpubFromDir(workspaceDir);
      FootnoteProcessor.convertPlaintextFootnotes(unpacked);
      FootnoteProcessor.convertToEpub3Popup(unpacked);
      FootnoteProcessor.autoRepair(unpacked);

      // Ghi đè các file xhtml đã được bổ sung chú thích pop-up vào workspace
      for (const file of unpacked.listFiles()) {
        if (file.endsWith('.xhtml') || file.endsWith('.html')) {
          const fullP = path.join(workspaceDir, file);
          fs.writeFileSync(fullP, unpacked.getFileString(file), 'utf-8');
        }
      }
    } catch (e: any) {
      console.warn(`⚠️ Lưu ý khi xử lý Pop-up chú thích: ${e.message}`);
    }
  }

  return workspaceDir;
}
