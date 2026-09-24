import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadEpubFromDir } from '../core/epubArchive.js';
import { OpfManager } from '../core/opfManager.js';
import { ChapterDomProcessor } from '../core/domProcessor.js';
import { TocBuilder } from '../core/tocBuilder.js';
import type { HeadingItem } from '../types/index.js';

const program = new Command();

program
  .name('update-toc')
  .description('Đồng bộ và cập nhật lại toàn bộ Table of Contents: toc.ncx, nav.xhtml và các trang Mục lục nội dung (như part0001.html)')
  .option('-d, --dir <path>', 'Thư mục workspace chứa sách đã giải nén', './workspace')
  .action(async (options) => {
    let workspaceDir: string;
    if (fs.existsSync(path.join(process.cwd(), 'mimetype')) && fs.existsSync(path.join(process.cwd(), 'META-INF'))) {
      workspaceDir = process.cwd();
    } else {
      workspaceDir = path.resolve(options.dir);
    }

    if (!fs.existsSync(workspaceDir)) {
      console.error(`❌ Lỗi: Thư mục "${workspaceDir}" không tồn tại.`);
      process.exit(1);
    }

    console.log(`\n======================================================`);
    console.log(`📑 ĐỒNG BỘ TABLE OF CONTENTS (MỤC LỤC TOÀN CUỐN SÁCH)`);
    console.log(`📁 Thư mục: ${workspaceDir}`);
    console.log(`======================================================\n`);

    const unpacked = loadEpubFromDir(workspaceDir);
    const opfPath = OpfManager.findOpfPath(unpacked);
    const opfManager = new OpfManager(unpacked, opfPath);
    const pkg = opfManager.getPackageInfo();

    console.log(`📖 Sách: "${pkg.metadata.title}"`);

    // 1. Quét toàn bộ các chương trong spine để thu thập đầy đủ Headings (H1, H2, H3)
    const spineChapters = opfManager.getSpineChapterFiles();
    const fullBookHeadings: HeadingItem[] = [];

    for (const ch of spineChapters) {
      const name = ch.relativeHref.toLowerCase();
      // Bỏ qua trang bìa và trang mục lục
      if (name.includes('titlepage') || name.includes('cover') || name.includes('part0000') || name.includes('part0001') || name.includes('part0014')) {
        continue;
      }

      if (!unpacked.hasFile(ch.zipPath)) continue;
      const html = unpacked.getFileString(ch.zipPath);
      const proc = new ChapterDomProcessor(html, ch.relativeHref);
      const headings = proc.collectHeadings();
      fullBookHeadings.push(...headings);
    }

    console.log(`🔍 Đã thu thập: ${fullBookHeadings.length} mục tiêu đề từ các chương.`);
    const tocTree = TocBuilder.buildTree(fullBookHeadings);

    const bookUid = pkg.metadata.identifier || `urn:uuid:${Math.random().toString(36).substring(2)}`;

    // 2. Cập nhật toc.ncx (EPUB 2)
    const ncxContent = TocBuilder.generateNcx(tocTree, pkg.metadata.title, bookUid);
    const ncxPath = pkg.tocHref ? opfManager.resolvePathInZip(pkg.tocHref) : 'toc.ncx';
    unpacked.setFileString(ncxPath, ncxContent);
    console.log(`✅ Đã cập nhật: ${ncxPath} (EPUB 2 NCX)`);

    // 3. Cập nhật nav.xhtml (EPUB 3)
    const navContent = TocBuilder.generateNavXhtml(tocTree, pkg.metadata.title);
    const navRelativeHref = 'nav.xhtml';
    const navZipPath = opfManager.resolvePathInZip(navRelativeHref);
    unpacked.setFileString(navZipPath, navContent);
    opfManager.ensureManifestItem('nav', navRelativeHref, 'application/xhtml+xml', 'nav');
    opfManager.save();
    console.log(`✅ Đã cập nhật: ${navZipPath} (EPUB 3 Navigation Document)`);

    // 4. Cập nhật các trang Mục lục đọc trực tiếp trong sách (Inline TOC như part0001.html, part0014.html)
    const allFiles = unpacked.listFiles();
    let inlineUpdatedCount = 0;

    for (const f of allFiles) {
      if (!f.endsWith('.html') && !f.endsWith('.xhtml')) continue;
      const content = unpacked.getFileString(f);
      const lower = content.toLowerCase();

      const isInlineToc =
        lower.includes('mục lục | table of contents') ||
        lower.includes('calibre_generated_inline_toc') ||
        (lower.includes('table of contents') && (lower.includes('<ul class="level"') || lower.includes("<ul class='level'")));

      if (isInlineToc) {
        console.log(`🔄 Đang cập nhật trang Mục lục nội dung đọc trong sách: ${f}...`);
        const updatedHtml = TocBuilder.updateInlineToc(content, tocTree, f);
        unpacked.setFileString(f, updatedHtml);
        inlineUpdatedCount++;
      }
    }

    console.log(`\n🎉 Hoàn thành! Đã cập nhật ${inlineUpdatedCount} trang Mục lục nội dung (Inline TOC).`);
    console.log(`💡 Bây giờ bạn có thể kiểm tra file part0001.html hoặc chạy git diff để xem kết quả:`);
    console.log(`   git -C "${workspaceDir}" diff text/part0001.html\n`);
  });

program.parse(process.argv);
