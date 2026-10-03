import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { unpackEpubToDir, loadEpubFromDir, packEpubFromDir, getSourceEpubMeta } from './core/epubArchive.js';
import { OpfManager } from './core/opfManager.js';
import { ChapterDomProcessor } from './core/domProcessor.js';
import { TocBuilder } from './core/tocBuilder.js';
import { GeminiClient } from './ai/geminiClient.js';
import { buildChapterPrompt } from './ai/prompts.js';
import { FootnoteProcessor } from './core/footnoteProcessor.js';
import type { HeadingItem } from './types/index.js';
import { splitMultiChapterFiles, isTableOfContentsFile, CHAPTER_REGEX } from './core/chapterSplitter.js';
import { mergePartChapters } from './core/partMerger.js';
import { selectOrResolveEpub } from './core/fileSelector.js';
import { ensureStandardStyles } from './core/styleManager.js';

dotenv.config();

const program = new Command();

program
  .name('edit-epub')
  .description('AI-powered EPUB editor: chuẩn hoá H1, chèn H2/H3, sửa chính tả, liên kết chú thích và tái tạo TOC')
  .version('1.0.0')
  .option('-i, --input <path>', 'Số thứ tự [1-N], tên file, từ khoá hoặc đường dẫn file EPUB trong input/')
  .option('-o, --output <path>', 'Đường dẫn file EPUB đầu ra')
  .option('-d, --dir <path>', 'Thư mục làm việc giải nén (có Git tracking)', './workspace')
  .option('-k, --api-key <key>', 'Google Gemini API Key (nếu không set trong .env)')
  .option('-m, --model <model>', 'Tên Gemini Model', process.env.GEMINI_MODEL || 'gemini-3.6-flash')
  .option('--start <number>', 'Bắt đầu từ chương thứ mấy (1-based)', '1')
  .option('--limit <number>', 'Giới hạn số lượng chương cần xử lý (để test trước)')
  .option('--no-footnote', 'Bỏ qua nhận diện và xử lý chú thích', false)
  .option('--renumber-footnotes [style]', 'Đánh số lại thứ tự chú thích toàn sách ("bracket", "star", "number")')
  .option('--dry-run', 'Chỉ chạy phân tích và in kết quả, không ghi đè file', false)
  .option('--fresh', 'Bắt buộc giải nén lại từ file EPUB gốc (ghi đè workspace)', false)
  .option('--no-merge-parts', 'Không gộp các chương theo từng phần (giữ nguyên từng file riêng lẻ)')
  .option('--pack', 'Tự động đóng gói file EPUB sau khi xử lý xong (mặc định: tắt, giữ workspace để duyệt Git diff)')
  .option('--no-pack', 'Không đóng gói file EPUB (mặc định)')
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
    let bookName: string | undefined;
    const sourceMeta = getSourceEpubMeta(workspaceDir);
    if (sourceMeta?.baseName) {
      bookName = sourceMeta.baseName;
    } else {
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
                bookName = titleMatch[1]
                  .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
                  .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
                  .trim()
                  .replace(/[/\\?%*:|"<>]/g, '_');
              }
            }
          }
        }
      } catch {
        // fallback
      }
    }

    if (!bookName) {
      bookName = path.basename(workspaceDir);
    }

    const outputPath = options.output ? path.resolve(options.output) : path.join(outputDir, `${bookName}_edited.epub`);
    console.log(`📦 Đang đóng gói lại thư mục "${workspaceDir}" thành "${outputPath}"...`);
    await packEpubFromDir(workspaceDir, outputPath);
    console.log(`✅ Đã đóng gói thành công: ${outputPath}`);
    return;
  }

  // 1. Xác định file đầu vào và chuẩn bị thư mục làm việc (workspace)
  let inputPath: string | undefined;
  let chosenBaseName: string | undefined;
  const inputDir = path.resolve('input');
  if (!fs.existsSync(inputDir)) {
    await fs.promises.mkdir(inputDir, { recursive: true });
  }

  const isAlreadyUnpacked =
    fs.existsSync(path.join(workspaceDir, 'mimetype')) &&
    fs.existsSync(path.join(workspaceDir, 'META-INF'));

  const existingMeta = isAlreadyUnpacked ? getSourceEpubMeta(workspaceDir) : undefined;

  if (options.input) {
    const selected = await selectOrResolveEpub(options.input, { actionName: 'xử lý' });
    inputPath = selected.fullPath;
    chosenBaseName = selected.baseName;

    const sameBookInWorkspace =
      isAlreadyUnpacked && existingMeta?.fileName === selected.fileName;

    if (!isAlreadyUnpacked || options.fresh || !sameBookInWorkspace) {
      console.log(`[1/5] Đang giải nén EPUB "${selected.fileName}" ra thư mục riêng "${workspaceDir}"...`);
      await unpackEpubToDir(inputPath, workspaceDir, true);
      console.log(`   🌱 Đã khởi tạo Git repository riêng với commit gốc (bản chưa sửa).`);
    } else {
      console.log(`[1/5] Thư mục "${workspaceDir}" đã có sẵn nội dung của "${selected.fileName}" (sử dụng lại).`);
      console.log(`   💡 (Dùng cờ --fresh nếu bạn muốn giải nén đè lại từ đầu).`);
    }
  } else if (!isAlreadyUnpacked || options.fresh) {
    const selected = await selectOrResolveEpub(undefined, { actionName: 'xử lý' });
    inputPath = selected.fullPath;
    chosenBaseName = selected.baseName;

    console.log(`[1/5] Đang giải nén EPUB "${selected.fileName}" ra thư mục riêng "${workspaceDir}"...`);
    await unpackEpubToDir(inputPath, workspaceDir, true);
    console.log(`   🌱 Đã khởi tạo Git repository riêng với commit gốc (bản chưa sửa).`);
  } else {
    chosenBaseName = existingMeta?.baseName;
    console.log(`[1/5] Sử dụng nội dung EPUB có sẵn trong thư mục "${workspaceDir}".`);
    if (existingMeta?.fileName) {
      console.log(`   📖 Sách đang xử lý: "${existingMeta.fileName}"`);
    }
    console.log(`   💡 (Mẹo: Để chọn file khác trong input/, hãy dùng: pnpm start -i <số_thứ_tự|tên_file> hoặc --fresh)`);
  }

  let outputPath = options.output ? path.resolve(options.output) : undefined;
  if (!outputPath) {
    let baseName = chosenBaseName;
    if (!baseName && inputPath) {
      baseName = path.basename(inputPath, path.extname(inputPath));
    }
    if (!baseName) {
      baseName = 'book';
    }
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
  else if (existingMeta?.fileName) console.log(`📖 File gốc: ${existingMeta.fileName}`);
  console.log(`📁 Thư mục làm việc: ${workspaceDir}`);
  console.log(`🤖 Model AI: ${options.model}`);
  console.log(`💾 File xuất dự kiến: ${outputPath}`);
  if (options.dryRun) console.log(`🔍 Chế độ: DRY-RUN (chỉ kiểm tra, không ghi file)`);
  console.log(`======================================================\n`);

  const unpacked = loadEpubFromDir(workspaceDir);
  const opfPath = OpfManager.findOpfPath(unpacked);
  let opfManager = new OpfManager(unpacked, opfPath);
  let pkg = opfManager.getPackageInfo();

  console.log(`   - Tựa sách: "${pkg.metadata.title}"`);
  console.log(`   - Tác giả: ${pkg.metadata.creator || 'Chưa rõ'}`);

  // Tự động phân tách các file XHTML chứa nhiều chương thành các file độc lập
  const splitResult = splitMultiChapterFiles(unpacked, opfManager);
  if (splitResult.splitFilesCount > 0) {
    // Reload lại OPF manager sau khi đã bổ sung các file mới vào manifest và spine
    opfManager = new OpfManager(unpacked, opfPath);
    pkg = opfManager.getPackageInfo();
  }

  // Tự động gộp các chương trong cùng một phần (Phần => Chương) vào 1 file duy nhất để tiết kiệm gọi Gemini API
  if (options.mergeParts !== false) {
    const mergeResult = mergePartChapters(unpacked, opfManager);
    if (mergeResult.mergedPartsCount > 0) {
      opfManager = new OpfManager(unpacked, opfPath);
      pkg = opfManager.getPackageInfo();
    }
  }

  // Tự động chuẩn hoá bộ quy chuẩn Typography cho Headings trong các file CSS của sách
  const stylesUpdated = ensureStandardStyles(unpacked);
  if (stylesUpdated) {
    console.log(`   🎨 Đã thiết lập bộ quy chuẩn Typography (H1, H2, H3, H4) vào stylesheet.`);
  }

  // 4. Lấy danh sách chương
  const allFiles = opfManager.getSpineChapterFiles();
  
  // Lọc bỏ các file bìa, mục lục và trang thông tin ebook
  const contentChapters = allFiles.filter((ch) => {
    const name = ch.relativeHref.toLowerCase();
    if (name.includes('titlepage') || name.includes('cover')) return false;

    try {
      const html = unpacked.getFileString(ch.zipPath);
      // Nhận diện và bỏ qua trang Mục lục (Inline TOC) để không gửi cho AI chỉnh sửa làm chương
      if (isTableOfContentsFile(html, ch.relativeHref)) return false;

      // Nhận diện và bỏ qua file Chú Thích (Footnote/Endnote) để bảo toàn nguyên vẹn
      if (FootnoteProcessor.isFootnoteFile(html, ch.relativeHref)) return false;

      const text = html.toLowerCase();

      // Bỏ qua trang chỉ có ảnh bìa hoặc ảnh đơn lẻ không có nội dung chữ (như index_split_000.html)
      const hasImg = html.includes('<img') || html.includes('<image');
      const hasFewText = !html.includes('<p') && !html.includes('<div class="calibre1"');
      if (hasImg && hasFewText) return false;

      // Bỏ qua trang bìa lót / thông tin sách ngắn không có nội dung chương (như index_split_001.html)
      if (html.length < 2000 && !CHAPTER_REGEX.test(text) && !text.includes('giới thiệu') && !text.includes('lời nói đầu') && !text.includes('mở đầu')) {
        return false;
      }

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
  console.log(`[2/5] Đang phân tích & xử lý nội dung qua AI (H1, H2/H3, Chính tả & Chú thích)...`);
  const allHeadings: HeadingItem[] = [];
  let totalFixes = 0;
  let totalHeadingsAdded = 0;
  let totalFootnotesConverted = 0;

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

      // Xử lý chú thích cục bộ (Local Footnotes Processing)
      if (options.footnote !== false) {
        const fnResult = proc.applyFootnotes();
        if (fnResult.convertedRefs > 0 || fnResult.convertedDefs > 0) {
          console.log(`   🔖 Chú thích (Local): Đã liên kết ${fnResult.convertedRefs} vị trí gọi và ${fnResult.convertedDefs} định nghĩa Pop-up.`);
          totalFootnotesConverted += fnResult.convertedRefs;
        }
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

  // 6. Chuẩn hoá & Tối ưu hoá Chú thích toàn sách (EPUB 3 Pop-up & Auto-repair)
  if (options.footnote !== false) {
    console.log(`\n[3/5] Đang tối ưu & kiểm định Chú thích toàn sách (EPUB 3 Pop-up)...`);

    // Quét và chuyển đổi các chú thích text thuần còn sót lại nếu có
    const plainScan = FootnoteProcessor.scanPlaintextFootnotes(unpacked);
    if (plainScan.totalPlaintextNotes > 0) {
      console.log(`   🔗 Tìm thấy ${plainScan.totalPlaintextNotes} chú thích text thuần chưa gắn link, đang tự động liên kết...`);
      const convertRes = FootnoteProcessor.convertPlaintextFootnotes(unpacked);
      console.log(`   ✅ Đã chuyển đổi ${convertRes.totalConverted} mục chú thích thành Pop-up.`);
      totalFootnotesConverted += convertRes.totalConverted;
    }

    // Đánh số lại thứ tự chú thích nếu người dùng yêu cầu
    if (options.renumberFootnotes) {
      let rStyle: 'bracket-number' | 'star' | 'number' = 'bracket-number';
      if (options.renumberFootnotes === 'star') rStyle = 'star';
      else if (options.renumberFootnotes === 'number') rStyle = 'number';
      console.log(`   🔢 Đang đánh số lại thứ tự chú thích liên tục (kiểu: ${rStyle})...`);
      const ren = FootnoteProcessor.renumberFootnotes(unpacked, rStyle);
      console.log(`   ✅ Đã đánh số lại ${ren.totalRenumbered} liên kết chú thích.`);
    }

    // Tự động kiểm tra và sửa liên kết bị gãy (nếu có)
    const repair = FootnoteProcessor.autoRepair(unpacked);
    if (repair.repairedCount > 0) {
      console.log(`   🔧 Đã tự động sửa ${repair.repairedCount} liên kết chú thích.`);
    }

    // Nâng cấp toàn bộ liên kết còn lại sang EPUB 3 Pop-up
    const popup = FootnoteProcessor.convertToEpub3Popup(unpacked);
    if (popup.convertedRefs > 0 || popup.convertedDefs > 0) {
      console.log(`   🚀 Nâng cấp Pop-up EPUB 3: ${popup.convertedRefs} refs, ${popup.convertedDefs} defs.`);
    }

    // Kiểm định tổng thể
    const fnReport = FootnoteProcessor.validate(unpacked);
    console.log(`   📊 Tổng kết chú thích: ${fnReport.validPairs} cặp liên kết hợp lệ | Lỗi còn lại: ${fnReport.issues.length} | Pop-up: ${fnReport.isEpub3PopupReady ? '✅ Sẵn sàng' : 'Chưa'}`);
  }

  // 7. Xây dựng lại Table of Contents (TOC)
  console.log(`\n[4/5] Đang tái tạo Table of Contents (Mục lục đa cấp)...`);
  
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

  // Cập nhật các trang Mục lục nội dung đọc trực tiếp trong sách (Inline TOC như part0001.html, part0014.html, index_split_003.html)
  const allWorkspaceFiles = unpacked.listFiles();
  for (const f of allWorkspaceFiles) {
    if (!f.endsWith('.html') && !f.endsWith('.xhtml')) continue;
    // Bỏ qua nav.xhtml vì nav.xhtml là EPUB 3 Navigation Document chuyên dụng, đã tạo ở trên
    if (f === 'nav.xhtml' || f.endsWith('/nav.xhtml')) continue;

    const content = unpacked.getFileString(f);
    const lower = content.toLowerCase();

    const isInlineToc =
      isTableOfContentsFile(content, f) ||
      lower.includes('mục lục | table of contents') ||
      lower.includes('calibre_generated_inline_toc') ||
      (lower.includes('table of contents') && (lower.includes('<ul class="level"') || lower.includes("<ul class='level'")));

    if (isInlineToc) {
      console.log(`   - Đã cập nhật trang Mục lục đọc trong sách (Inline TOC): ${f}`);
      const updatedHtml = TocBuilder.updateInlineToc(content, tocTree, f);
      unpacked.setFileString(f, updatedHtml);
    }
  }

  // 8. Báo cáo Git Diff
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

  // 9. Đóng gói lại EPUB
  if (options.dryRun) {
    console.log(`\n[5/5] Bỏ qua đóng gói vì đang chạy ở chế độ DRY-RUN.`);
  } else if (!options.pack) {
    console.log(`\n[5/5] Không tự động đóng gói EPUB (mặc định để duyệt qua Git diff).`);
    console.log(`   Sau khi duyệt xong qua Git, bạn có thể đóng gói bằng lệnh:`);
    console.log(`   pnpm run pack --dir "${options.dir}" -o "${outputPath}"`);
    console.log(`   (Hoặc lần sau chạy trực tiếp kèm cờ: pnpm start --pack)`);
  } else {
    console.log(`\n[5/5] Đang đóng gói lại EPUB chuẩn IDPF (mimetype uncompressed)...`);
    await packEpubFromDir(workspaceDir, outputPath);
    console.log(`   ✅ Đã tạo file EPUB mới thành công tại:`);
    console.log(`      ${path.resolve(outputPath)}`);
  }

  console.log(`\n======================================================`);
  console.log(`🎉 HOÀN THÀNH TẤT CẢ CÔNG VIỆC!`);
  console.log(`   - Số chương đã xử lý: ${targetChapters.length}`);
  console.log(`   - Số heading H2/H3 đã thêm: ${totalHeadingsAdded}`);
  console.log(`   - Số lỗi chính tả đã sửa: ${totalFixes}`);
  console.log(`   - Số chú thích Pop-up đã tạo/chuẩn hoá: ${totalFootnotesConverted}`);
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error('\nLỗi không mong muốn:', err);
  process.exit(1);
});
