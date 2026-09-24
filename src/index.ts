import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { unpackEpubToDir, loadEpubFromDir, packEpubFromDir } from './core/epubArchive.js';
import { OpfManager } from './core/opfManager.js';
import { ChapterDomProcessor } from './core/domProcessor.js';
import { TocBuilder } from './core/tocBuilder.js';
import { GeminiClient } from './ai/geminiClient.js';
import { buildChapterPrompt } from './ai/prompts.js';
import type { HeadingItem } from './types/index.js';

dotenv.config();

const program = new Command();

program
  .name('edit-epub')
  .description('AI-powered EPUB editor: chuẩn hoá H1, chèn H2/H3, sửa chính tả và tái tạo TOC')
  .version('1.0.0')
  .option('-i, --input <path>', 'Đường dẫn file EPUB đầu vào')
  .option('-o, --output <path>', 'Đường dẫn file EPUB đầu ra')
  .option('-d, --dir <path>', 'Thư mục làm việc giải nén (có Git tracking)', './workspace')
  .option('-k, --api-key <key>', 'Google Gemini API Key (nếu không set trong .env)')
  .option('-m, --model <model>', 'Tên Gemini Model', process.env.GEMINI_MODEL || 'gemini-3.6-flash')
  .option('--start <number>', 'Bắt đầu từ chương thứ mấy (1-based)', '1')
  .option('--limit <number>', 'Giới hạn số lượng chương cần xử lý (để test trước)')
  .option('--dry-run', 'Chỉ chạy phân tích và in kết quả, không ghi đè file', false)
  .option('--fresh', 'Bắt buộc giải nén lại từ file EPUB gốc (ghi đè workspace)', false)
  .option('--no-pack', 'Không tự động đóng gói EPUB, giữ nguyên thư mục đĩa để duyệt Git diff')
  .option('--pack-only', 'Chỉ đóng gói thư mục workspace thành file EPUB (sau khi đã duyệt)', false)
  .option('--delay <ms>', 'Thời gian nghỉ giữa các chương (ms)', '2000');

program.parse(process.argv);
const options = program.opts();

async function main() {
  // Nhận diện thông minh thư mục workspace
  let workspaceDir: string;
  if (fs.existsSync(path.join(process.cwd(), 'mimetype')) && fs.existsSync(path.join(process.cwd(), 'META-INF'))) {
    // Nếu terminal đang đứng ngay trong thư mục workspace
    workspaceDir = process.cwd();
  } else {
    workspaceDir = path.resolve(options.dir);
  }

  const outputDir = path.resolve('output');
  if (!fs.existsSync(outputDir)) {
    await fs.promises.mkdir(outputDir, { recursive: true });
  }

  // Chế độ: Chỉ đóng gói lại sau khi người dùng duyệt xong
  if (options.packOnly) {
    if (!fs.existsSync(workspaceDir)) {
      console.error(`❌ Lỗi: Thư mục "${workspaceDir}" không tồn tại.`);
      process.exit(1);
    }
    let bookName = path.basename(workspaceDir);
    try {
      const containerPath = path.join(workspaceDir, 'META-INF/container.xml');
      if (fs.existsSync(containerPath)) {
        const containerXml = fs.readFileSync(containerPath, 'utf-8');
        const fullPathMatch = containerXml.match(/full-path="([^"]+)"/);
        if (fullPathMatch) {
          const opfPath = path.join(workspaceDir, fullPathMatch[1]);
          if (fs.existsSync(opfPath)) {
            const opfXml = fs.readFileSync(opfPath, 'utf-8');
            const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
            if (titleMatch) {
              bookName = titleMatch[1].trim().replace(/[/\\?%*:|"<>]/g, '_');
            }
          }
        }
      }
    } catch {
      // fallback
    }

    const outputPath = options.output ? path.resolve(options.output) : path.join(outputDir, `${bookName}_edited.epub`);
    console.log(`📦 Đang đóng gói lại thư mục "${workspaceDir}" thành "${outputPath}"...`);
    await packEpubFromDir(workspaceDir, outputPath);
    console.log(`✅ Đã đóng gói thành công: ${outputPath}`);
    return;
  }

  // 1. Xác định file đầu vào (nếu cần giải nén)
  let inputPath = options.input;
  const inputDir = path.resolve('input');
  if (!fs.existsSync(inputDir)) {
    await fs.promises.mkdir(inputDir, { recursive: true });
  }

  const isAlreadyUnpacked =
    fs.existsSync(path.join(workspaceDir, 'mimetype')) &&
    fs.existsSync(path.join(workspaceDir, 'META-INF'));

  if (inputPath) {
    if (!fs.existsSync(inputPath) && fs.existsSync(path.join(inputDir, inputPath))) {
      inputPath = path.join(inputDir, inputPath);
    }
  } else if (!isAlreadyUnpacked || options.fresh) {
    // Ưu tiên tìm file epub trong thư mục input/
    const searchDirs = [
      inputDir,
      process.cwd(),
      path.resolve(process.cwd(), '..', 'input'),
      path.resolve(process.cwd(), '..')
    ];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const epubs = fs.readdirSync(dir).filter((f) => f.endsWith('.epub') && !f.endsWith('_edited.epub'));
      if (epubs.length > 0) {
        inputPath = path.join(dir, epubs[0]);
        break;
      }
    }

    if (inputPath) {
      console.log(`[Auto-detect] Đã tự động chọn file EPUB: "${path.basename(inputPath)}" (từ ${path.dirname(inputPath)})`);
    } else {
      console.error('❌ Lỗi: Không tìm thấy file .epub nào.');
      console.error('👉 Hãy đặt file sách vào thư mục: ./input/ hoặc truyền tham số -i <tên_file.epub>');
      process.exit(1);
    }
  }

  if (inputPath && !fs.existsSync(inputPath)) {
    console.error(`❌ Lỗi: Không tìm thấy file "${inputPath}"`);
    process.exit(1);
  }

  let outputPath = options.output ? path.resolve(options.output) : undefined;
  if (!outputPath) {
    const baseName = inputPath
      ? path.basename(inputPath, path.extname(inputPath))
      : 'book';
    outputPath = path.join(outputDir, `${baseName}_edited.epub`);
  }

  // 2. Khởi tạo Gemini Client
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('\n❌ Lỗi: Chưa cung cấp GEMINI_API_KEY!');
    console.error('Bạn có thể:');
    console.error('  1. Tạo file .env và thêm dòng: GEMINI_API_KEY=AIzaSy...');
    console.error('  2. Hoặc truyền trực tiếp: pnpm start --api-key <key>\n');
    process.exit(1);
  }

  const gemini = new GeminiClient({ apiKey, model: options.model });

  console.log(`\n======================================================`);
  console.log(`📖 BẮT ĐẦU XỬ LÝ EPUB`);
  if (inputPath) console.log(`📖 File gốc: ${path.basename(inputPath)}`);
  console.log(`📁 Thư mục làm việc: ${workspaceDir}`);
  console.log(`🤖 Model AI: ${options.model}`);
  console.log(`💾 File xuất dự kiến: ${outputPath}`);
  if (options.dryRun) console.log(`🔍 Chế độ: DRY-RUN (chỉ kiểm tra, không ghi file)`);
  console.log(`======================================================\n`);

  // 3. Giải nén EPUB (hoặc tái sử dụng thư mục đã có)
  if (!isAlreadyUnpacked || options.fresh) {
    console.log(`[1/4] Đang giải nén EPUB ra thư mục riêng "${workspaceDir}"...`);
    await unpackEpubToDir(inputPath!, workspaceDir, true);
    console.log(`   🌱 Đã khởi tạo Git repository riêng với commit gốc (bản chưa sửa).`);
  } else {
    console.log(`[1/4] Thư mục "${workspaceDir}" đã có sẵn nội dung EPUB (sử dụng lại).`);
  }

  const unpacked = loadEpubFromDir(workspaceDir);
  const opfPath = OpfManager.findOpfPath(unpacked);
  const opfManager = new OpfManager(unpacked, opfPath);
  const pkg = opfManager.getPackageInfo();

  console.log(`   - Tựa sách: "${pkg.metadata.title}"`);
  console.log(`   - Tác giả: ${pkg.metadata.creator || 'Chưa rõ'}`);

  // 4. Lấy danh sách chương
  const allFiles = opfManager.getSpineChapterFiles();
  
  // Lọc bỏ các file bìa, mục lục và trang thông tin ebook
  const contentChapters = allFiles.filter((ch) => {
    const name = ch.relativeHref.toLowerCase();
    if (name.includes('titlepage') || name.includes('cover')) return false;

    try {
      const html = unpacked.getFileString(ch.zipPath);
      const text = html.toLowerCase();
      if (text.includes('table of contents') && text.includes('calibre_generated_inline_toc')) return false;
      if (text.includes('mục lục | table of contents')) return false;
      if (text.includes('thông tin ebook') && html.length < 3000) return false;
      return true;
    } catch {
      return true;
    }
  });

  console.log(`   - Tìm thấy ${contentChapters.length} chương nội dung cần xử lý.`);

  // Quản lý checkpoint (tiến trình các chương đã hoàn thành)
  const progressFilePath = path.join(workspaceDir, '.processed_chapters.json');
  let processedMap: Record<string, boolean> = {};
  if (!options.fresh && fs.existsSync(progressFilePath)) {
    try {
      processedMap = JSON.parse(fs.readFileSync(progressFilePath, 'utf-8'));
    } catch {
      processedMap = {};
    }
  }

  const startIdx = Math.max(0, parseInt(options.start, 10) - 1);
  const limitCount = options.limit ? parseInt(options.limit, 10) : contentChapters.length;
  const targetChapters = contentChapters.slice(startIdx, startIdx + limitCount);

  console.log(`   - Sẽ xử lý từ chương ${startIdx + 1} đến ${startIdx + targetChapters.length} (Tổng ${targetChapters.length} chương)\n`);

  // 5. Vòng lặp xử lý từng chương qua AI
  console.log(`[2/4] Đang phân tích và xử lý nội dung từng chương qua AI...`);
  const allHeadings: HeadingItem[] = [];
  let totalFixes = 0;
  let totalHeadingsAdded = 0;

  for (let i = 0; i < targetChapters.length; i++) {
    const ch = targetChapters[i];
    const chapterNum = startIdx + i + 1;
    console.log(`\n------------------------------------------------------------`);
    console.log(`⏳ [${chapterNum}/${contentChapters.length}] Đang xử lý: ${ch.relativeHref}...`);

    const html = unpacked.getFileString(ch.zipPath);
    const proc = new ChapterDomProcessor(html, ch.relativeHref);

    // Kiểm tra xem chương này đã xử lý thành công ở lần chạy trước chưa
    if (!options.fresh && processedMap[ch.relativeHref]) {
      console.log(`   ⏭️ Chương ${ch.relativeHref} đã được xử lý hoàn tất trước đó (tự động bỏ qua để tiết kiệm Quota).`);
      const chapterHeadings = proc.collectHeadings();
      allHeadings.push(...chapterHeadings);
      continue;
    }

    const topElements = proc.getTopElements(8);
    const paragraphs = proc.indexParagraphs();

    if (paragraphs.length < 3) {
      console.log(`   ⚠️ Đoạn văn quá ngắn (${paragraphs.length} đoạn), bỏ qua AI.`);
      const chapterHeadings = proc.collectHeadings();
      allHeadings.push(...chapterHeadings);
      continue;
    }

    const prompt = buildChapterPrompt(pkg.metadata.title, ch.relativeHref, topElements, paragraphs);

    try {
      const aiResult = await gemini.analyzeChapter(prompt);

      console.log(`   ✅ H1 Chuẩn: "${aiResult.h1.title}"`);
      if (aiResult.h1.removeTopIndices && aiResult.h1.removeTopIndices.length > 0) {
        console.log(`      Dọn dẹp các thẻ top rác: index [${aiResult.h1.removeTopIndices.join(', ')}]`);
      }

      // Chuẩn hoá H1 vào DOM
      proc.normalizeH1(aiResult.h1.title, aiResult.h1.removeTopIndices);

      // Chèn H2 và H3
      if (aiResult.headings.length > 0) {
        console.log(`   📌 Bổ sung ${aiResult.headings.length} heading (H2/H3):`);
        for (const h of aiResult.headings) {
          console.log(`      + [${h.tag.toUpperCase()}] "${h.title}" (trước đoạn ${h.insertBeforeIdx})`);
        }
        proc.applyHeadings(aiResult.headings);
        totalHeadingsAdded += aiResult.headings.length;
      } else {
        console.log(`   ℹ️ Không có phân mục H2/H3 mới.`);
      }

      // Sửa chính tả
      if (aiResult.spellingFixes.length > 0) {
        console.log(`   ✍️ Sửa ${aiResult.spellingFixes.length} lỗi chính tả:`);
        for (const fix of aiResult.spellingFixes.slice(0, 5)) {
          console.log(`      * [p_${fix.idx}] "${fix.original}" -> "${fix.fixed}" ${fix.reason ? `(${fix.reason})` : ''}`);
        }
        if (aiResult.spellingFixes.length > 5) {
          console.log(`      ... và ${aiResult.spellingFixes.length - 5} lỗi khác.`);
        }
        const applied = proc.applySpellingFixes(aiResult.spellingFixes);
        totalFixes += applied;
      }

      // Thu thập headings đã cập nhật
      const chapterHeadings = proc.collectHeadings();
      allHeadings.push(...chapterHeadings);

      // Đánh dấu chương đã hoàn tất thành công để không bao giờ chạy lại lãng phí quota
      processedMap[ch.relativeHref] = true;
      try {
        fs.writeFileSync(progressFilePath, JSON.stringify(processedMap, null, 2), 'utf-8');
      } catch {
        // ignore
      }

      // Lưu lại XHTML trực tiếp vào file trên đĩa
      if (!options.dryRun) {
        unpacked.setFileString(ch.zipPath, proc.serialize());
      }
    } catch (err: any) {
      console.error(`   ❌ Lỗi khi xử lý chương ${ch.relativeHref}:`, err.message);
      allHeadings.push(...proc.collectHeadings());
    }

    const delayMs = parseInt(options.delay, 10) || 2000;
    if (i < targetChapters.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // 6. Xây dựng lại Table of Contents (TOC)
  console.log(`\n[3/4] Đang tái tạo Table of Contents (Mục lục đa cấp)...`);
  
  // Thu thập toàn bộ headings từ tất cả các chương nội dung trong sách (đảm bảo không bị thiếu chương)
  const fullBookHeadings: HeadingItem[] = [];
  for (const ch of contentChapters) {
    if (!unpacked.hasFile(ch.zipPath)) continue;
    const html = unpacked.getFileString(ch.zipPath);
    const proc = new ChapterDomProcessor(html, ch.relativeHref);
    fullBookHeadings.push(...proc.collectHeadings());
  }

  const tocTree = TocBuilder.buildTree(fullBookHeadings);
  console.log(`   - Tổng số mục trong cây TOC: ${fullBookHeadings.length} mục (gồm cả H1, H2, H3)`);

  const bookUid = pkg.metadata.identifier || `urn:uuid:${Math.random().toString(36).substring(2)}`;

  // Tạo file toc.ncx (EPUB 2)
  const ncxContent = TocBuilder.generateNcx(tocTree, pkg.metadata.title, bookUid);
  const ncxPath = pkg.tocHref ? opfManager.resolvePathInZip(pkg.tocHref) : 'toc.ncx';
  unpacked.setFileString(ncxPath, ncxContent);
  console.log(`   - Đã cập nhật: ${ncxPath} (EPUB 2 NCX)`);

  // Tạo file nav.xhtml (EPUB 3)
  const navContent = TocBuilder.generateNavXhtml(tocTree, pkg.metadata.title);
  const navRelativeHref = 'nav.xhtml';
  const navZipPath = opfManager.resolvePathInZip(navRelativeHref);
  unpacked.setFileString(navZipPath, navContent);
  opfManager.ensureManifestItem('nav', navRelativeHref, 'application/xhtml+xml', 'nav');
  opfManager.save();
  console.log(`   - Đã sinh mới & thêm vào manifest: ${navZipPath} (EPUB 3 Navigation Document)`);

  // Cập nhật các trang Mục lục nội dung đọc trực tiếp trong sách (Inline TOC như part0001.html, part0014.html)
  const allWorkspaceFiles = unpacked.listFiles();
  for (const f of allWorkspaceFiles) {
    if (!f.endsWith('.html') && !f.endsWith('.xhtml')) continue;
    const content = unpacked.getFileString(f);
    const lower = content.toLowerCase();

    const isInlineToc =
      lower.includes('mục lục | table of contents') ||
      lower.includes('calibre_generated_inline_toc') ||
      (lower.includes('table of contents') && (lower.includes('<ul class="level"') || lower.includes("<ul class='level'")));

    if (isInlineToc) {
      console.log(`   - Đã cập nhật trang Mục lục đọc trong sách (Inline TOC): ${f}`);
      const updatedHtml = TocBuilder.updateInlineToc(content, tocTree, f);
      unpacked.setFileString(f, updatedHtml);
    }
  }

  // 7. Báo cáo Git Diff
  console.log(`\n======================================================`);
  console.log(`🔍 TỔNG HỢP CÁC THAY ĐỔI QUA GIT`);
  console.log(`======================================================`);
  try {
    const diffStat = execSync('git diff --stat', { cwd: workspaceDir, encoding: 'utf-8' });
    console.log(diffStat || 'Chưa có thay đổi nào được ghi nhận.');
  } catch {
    // ignore
  }

  console.log(`\n💡 Bạn có thể xem chi tiết từng dòng diff bằng lệnh:`);
  console.log(`   git -C "${options.dir}" diff`);
  console.log(`Hoặc mở thư mục "${options.dir}" trong VS Code / IDE để duyệt trực quan.`);

  // 8. Đóng gói lại EPUB
  if (options.dryRun) {
    console.log(`\n[4/4] Bỏ qua đóng gói vì đang chạy ở chế độ DRY-RUN.`);
  } else if (!options.pack) {
    console.log(`\n[4/4] Đã bỏ qua đóng gói theo tuỳ chọn --no-pack.`);
    console.log(`   Sau khi duyệt xong qua Git, bạn chỉ cần gõ lệnh sau để tạo file EPUB:`);
    console.log(`   pnpm run pack --dir "${options.dir}" -o "${outputPath}"`);
  } else {
    console.log(`\n[4/4] Đang đóng gói lại EPUB chuẩn IDPF (mimetype uncompressed)...`);
    await packEpubFromDir(workspaceDir, outputPath);
    console.log(`   ✅ Đã tạo file EPUB mới thành công tại:`);
    console.log(`      ${path.resolve(outputPath)}`);
  }

  console.log(`\n======================================================`);
  console.log(`🎉 HOÀN THÀNH TẤT CẢ CÔNG VIỆC!`);
  console.log(`   - Số chương đã xử lý: ${targetChapters.length}`);
  console.log(`   - Số heading H2/H3 đã thêm: ${totalHeadingsAdded}`);
  console.log(`   - Số lỗi chính tả đã sửa: ${totalFixes}`);
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error('\nLỗi không mong muốn:', err);
  process.exit(1);
});
