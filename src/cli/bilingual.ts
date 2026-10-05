import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadEpubFromDir, unpackEpubToDir, packEpubFromDir, getSourceEpubMeta } from '../core/epubArchive.js';
import { selectOrResolveEpub } from '../core/fileSelector.js';
import { OpfManager } from '../core/opfManager.js';
import { GeminiClient } from '../ai/geminiClient.js';
import { BilingualProcessor, type BilingualFootnoteEntry } from '../core/bilingualProcessor.js';
import { BookContextExtractor } from '../core/bookContextExtractor.js';
import { GlossaryManager } from '../core/glossaryManager.js';
import { buildBilingualBatchPrompt } from '../ai/bilingualPrompts.js';
import { ensureBilingualStyles } from '../core/styleManager.js';
import { TocBuilder } from '../core/tocBuilder.js';
import { TranslationValidator } from '../core/translationValidator.js';
import type { BilingualChapterResult } from '../types/index.js';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('bilingual')
  .description('Dịch sách tiếng Anh sang EPUB tiếng Việt song ngữ (văn bản gốc hiển thị dạng EPUB 3 Pop-up Footnote)')
  .option('-i, --input <query>', 'Số thứ tự [1-N], tên file hoặc từ khoá file EPUB trong input/')
  .option('-d, --dir <path>', 'Thư mục workspace làm việc giải nén', './workspace')
  .option('-b, --batch-size <number>', 'Số đoạn văn mỗi lần gửi Gemini API (khuyến nghị 35-50)', '40')
  .option('-m, --model <name>', 'Tên model Gemini sử dụng', process.env.GEMINI_MODEL || 'gemini-2.5-flash')
  .option('--fresh', 'Dịch lại từ đầu (xoá cache/checkpoint tiến độ)', false)
  .option('--pack', 'Tự động đóng gói ra file EPUB sau khi dịch xong', false)
  .option('--no-pack', 'Không đóng gói ra file EPUB sau khi dịch', false);

program.parse(process.argv);
const options = program.opts();

interface CheckpointData {
  completedFiles: string[];
  totalParagraphsTranslated: number;
  lastUpdated: string;
}

async function main() {
  const batchSize = Math.max(5, parseInt(options.batchSize, 10) || 15);
  let workspaceDir = path.resolve(options.dir);

  const isAlreadyUnpacked =
    fs.existsSync(path.join(workspaceDir, 'mimetype')) &&
    fs.existsSync(path.join(workspaceDir, 'META-INF'));

  const existingMeta = isAlreadyUnpacked ? getSourceEpubMeta(workspaceDir) : undefined;

  // 1. Lựa chọn file sách và unpack
  if (options.input) {
    const selected = await selectOrResolveEpub(options.input, { actionName: 'dịch song ngữ' });
    const sameBook = isAlreadyUnpacked && existingMeta?.fileName === selected.fileName;

    if (!isAlreadyUnpacked || options.fresh || !sameBook) {
      console.log(`📦 Đang giải nén EPUB "${selected.fileName}" vào "${workspaceDir}"...`);
      await unpackEpubToDir(selected.fullPath, workspaceDir, true);
    }
  } else if (!isAlreadyUnpacked || options.fresh) {
    const selected = await selectOrResolveEpub(undefined, { actionName: 'dịch song ngữ' });
    console.log(`📦 Đang giải nén EPUB "${selected.fileName}" vào "${workspaceDir}"...`);
    await unpackEpubToDir(selected.fullPath, workspaceDir, true);
  }

  console.log(`\n======================================================`);
  console.log(`🌐 TẠO SÁCH SONG NGỮ ANH - VIỆT (EPUB 3 POP-UP FOOTNOTE)`);
  console.log(`📁 Thư mục: ${workspaceDir}`);
  console.log(`⚡ Batch size: ${batchSize} đoạn/lần | Model: ${options.model}`);
  console.log(`======================================================\n`);

  const unpacked = loadEpubFromDir(workspaceDir);
  const opfPath = OpfManager.findOpfPath(unpacked);
  const opfManager = new OpfManager(unpacked, opfPath);
  const pkg = opfManager.getPackageInfo();

  console.log(`📖 Tựa sách gốc: "${pkg.metadata.title}"`);
  console.log(`👤 Tác giả: "${pkg.metadata.creator || 'Chưa rõ'}"`);

  // 2. Khởi tạo Gemini Client
  const geminiClient = new GeminiClient({ model: options.model });

  // 3. Khởi tạo BookContextExtractor và GlossaryManager
  const contextExtractor = new BookContextExtractor(workspaceDir);
  const bookContext = await contextExtractor.extractOrLoad(unpacked, geminiClient);

  const glossaryManager = new GlossaryManager(workspaceDir);
  console.log(`📚 Từ điển thuật ngữ: ${Object.keys(glossaryManager.getTerms()).length} từ | Bỏ qua: ${glossaryManager.getDoNotTranslate().length} từ`);

  // 4. Quản lý Checkpoint
  const checkpointPath = path.join(workspaceDir, '.bilingual_checkpoint.json');
  let checkpoint: CheckpointData = {
    completedFiles: [],
    totalParagraphsTranslated: 0,
    lastUpdated: new Date().toISOString()
  };

  if (!options.fresh && fs.existsSync(checkpointPath)) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
      console.log(`🔄 Khôi phục tiến độ từ checkpoint: Đã hoàn thành ${checkpoint.completedFiles.length} file.`);
    } catch {
      // bỏ qua lỗi đọc checkpoint
    }
  }

  // 5. Lấy danh sách các file chương trong spine
  const spineFiles = opfManager.getSpineChapterFiles();
  const translatableChapters = spineFiles.filter((ch) => {
    const lower = ch.relativeHref.toLowerCase();
    // Bỏ qua trang bìa, titlepage thuần tuý
    if (lower.includes('cover') || lower.includes('titlepage')) return false;
    return true;
  });

  console.log(`📑 Tổng số file nội dung cần kiểm tra dịch: ${translatableChapters.length}`);

  let totalParagraphsInSession = 0;
  let slidingContext: string[] = [];
  let globalNoteIndex = 1;
  const allBilingualFootnotes: BilingualFootnoteEntry[] = [];

  // 6. Lặp qua từng chương để dịch
  for (let cIdx = 0; cIdx < translatableChapters.length; cIdx++) {
    const ch = translatableChapters[cIdx];
    const fileName = ch.relativeHref.split('/').pop() || ch.relativeHref;
    const progressTag = `[${cIdx + 1}/${translatableChapters.length}]`;

    if (checkpoint.completedFiles.includes(ch.zipPath)) {
      console.log(`${progressTag} ⏩ Bỏ qua ${fileName} (đã dịch xong trong checkpoint trước)`);
      continue;
    }

    const htmlContent = unpacked.getFileString(ch.zipPath);
    const { paragraphs, h1Title } = BilingualProcessor.extractParagraphs(htmlContent);

    if (paragraphs.length === 0) {
      console.log(`${progressTag} ⚪ ${fileName}: Không có văn bản cần dịch.`);
      checkpoint.completedFiles.push(ch.zipPath);
      continue;
    }

    console.log(`\n${progressTag} 🚀 Đang dịch chương: "${fileName}" (Gồm ${paragraphs.length} đoạn văn)...`);
    const chapterSlug = fileName.replace(/[^a-zA-Z0-9]/g, '_');

    const translatedParagraphs: { idx: number; text: string }[] = [];
    const authorFootnotes: { num: string; textVi: string }[] = [];
    let chapterH1Vi: string | undefined;

    // Chia batch thông minh: nếu chương <= 50 đoạn văn thì gom dịch trong 1 request duy nhất!
    const totalBatches = paragraphs.length <= 50 ? 1 : Math.ceil(paragraphs.length / batchSize);
    const effectiveBatchSize = Math.ceil(paragraphs.length / totalBatches);

    for (let b = 0; b < totalBatches; b++) {
      const startIdx = b * effectiveBatchSize;
      const endIdx = Math.min(startIdx + effectiveBatchSize, paragraphs.length);
      const currentBatch = paragraphs.slice(startIdx, endIdx);

      console.log(`   ⏳ Batch ${b + 1}/${totalBatches} (đoạn ${startIdx + 1} - ${endIdx}/${paragraphs.length})...`);

      const prompt = buildBilingualBatchPrompt({
        bookContext,
        chapterTitle: h1Title || fileName,
        glossaryPromptFormatted: glossaryManager.getFormattedForPrompt(),
        slidingContext,
        currentBatch: currentBatch.map((p) => ({ idx: p.idx, text: p.text })),
        isFirstBatchOfChapter: b === 0,
        rawH1: h1Title
      });

      try {
        const result = await geminiClient.analyzeGenericJson<BilingualChapterResult>(prompt);

        if (b === 0 && result.h1Vi) {
          chapterH1Vi = result.h1Vi;
          console.log(`      🏷️ Tiêu đề chương dịch: "${chapterH1Vi}"`);
        }

        if (Array.isArray(result.translatedParagraphs)) {
          // Kiểm tra và cảnh báo nếu có lỗi token glitch / từ ghép dị dạng
          const validation = TranslationValidator.validateBatch(result.translatedParagraphs);
          if (!validation.valid) {
            console.log(`      ⚠️ Cảnh báo chất lượng từ ngữ (${validation.issues.length} điểm nghi vấn):`);
            for (const issue of validation.issues) {
              console.log(`         - [p_idx=${issue.idx}] Từ '${issue.word}': ${issue.reason}`);
            }
          }

          for (const tp of result.translatedParagraphs) {
            translatedParagraphs.push(tp);
          }
        }

        if (Array.isArray(result.authorFootnotes)) {
          authorFootnotes.push(...result.authorFootnotes);
        }

        // Cập nhật thuật ngữ mới nếu AI phát hiện
        if (result.newTerms && typeof result.newTerms === 'object') {
          const newEntries = Object.entries(result.newTerms);
          if (newEntries.length > 0) {
            glossaryManager.addTerms(result.newTerms);
            console.log(`      💡 Bổ sung ${newEntries.length} thuật ngữ mới vào glossary.json`);
          }
        }

        // Cập nhật sliding context cho batch sau
        slidingContext = currentBatch.slice(-2).map((p) => p.text);

        // Giãn cách nhẹ 1s giữa các batch để tránh dồn dập RPM burst
        if (b < totalBatches - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err: any) {
        console.error(`      ❌ Lỗi dịch batch ${b + 1}: ${err.message}`);
        throw err;
      }
    }

    // Áp dụng bản dịch và chèn marker chú thích modal Pop-up
    const { updatedHtml, footnotes, nextIndex } = BilingualProcessor.applyBilingualContent(
      htmlContent,
      fileName,
      translatedParagraphs,
      paragraphs,
      globalNoteIndex,
      chapterH1Vi,
      authorFootnotes
    );

    allBilingualFootnotes.push(...footnotes);
    globalNoteIndex = nextIndex;

    unpacked.setFileString(ch.zipPath, updatedHtml);

    // Ghi nhận checkpoint
    checkpoint.completedFiles.push(ch.zipPath);
    checkpoint.totalParagraphsTranslated += paragraphs.length;
    checkpoint.lastUpdated = new Date().toISOString();
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');

    totalParagraphsInSession += paragraphs.length;
    console.log(`   ✅ Đã hoàn tất và lưu "${fileName}" (Tổng đã dịch: ${checkpoint.totalParagraphsTranslated} đoạn)`);
  }

  // 6.5. Tạo file chuthich.html chuyên biệt chuẩn modal pop-up và đăng ký vào content.opf
  if (allBilingualFootnotes.length > 0) {
    console.log(`\n📚 Đang tạo file chuthich.html với ${allBilingualFootnotes.length} chú thích modal...`);
    const chuthichHtml = BilingualProcessor.generateChuthichHtml(allBilingualFootnotes);
    const firstChapterZip = translatableChapters[0].zipPath;
    const chuthichZipPath = path.posix.join(path.posix.dirname(firstChapterZip), 'chuthich.html');
    unpacked.setFileString(chuthichZipPath, chuthichHtml);

    const relativeHrefToOpf = path.posix.relative(opfManager.opfDir || '.', chuthichZipPath);
    opfManager.ensureManifestItem('chuthich', relativeHrefToOpf, 'application/xhtml+xml');
    opfManager.addSpineItem('chuthich', 'no');
    console.log(`   ✅ Đã tạo ${chuthichZipPath} và đăng ký vào content.opf (spine linear="no")`);
  } else {
    const firstChapterZip = translatableChapters[0]?.zipPath;
    if (firstChapterZip) {
      const chuthichZipPath = path.posix.join(path.posix.dirname(firstChapterZip), 'chuthich.html');
      if (unpacked.hasFile(chuthichZipPath)) {
        const relativeHrefToOpf = path.posix.relative(opfManager.opfDir || '.', chuthichZipPath);
        opfManager.ensureManifestItem('chuthich', relativeHrefToOpf, 'application/xhtml+xml');
        opfManager.addSpineItem('chuthich', 'no');
      }
    }
  }

  // 7. Nhúng CSS song ngữ chuẩn EPUB Pop-up
  console.log('\n🎨 Đang tối ưu hoá CSS cho giao diện chú thích song ngữ Pop-up...');
  ensureBilingualStyles(unpacked);

  // 8. Cập nhật Metadata OPF
  console.log('📝 Đang cập nhật Metadata sách trong OPF...');
  opfManager.setLanguage('vi');
  const bilingualTitle = bookContext.bookTitle.includes('Song ngữ')
    ? bookContext.bookTitle
    : `${bookContext.bookTitle} [Song ngữ Anh - Việt]`;
  opfManager.setTitle(bilingualTitle);
  opfManager.save();

  // 9. Bảo tồn và đồng bộ Mục lục (TOC)
  console.log('🧭 Đang bảo tồn và đồng bộ lại Mục lục (nav.xhtml, toc.ncx)...');
  const tocResult = TocBuilder.preserveAndSyncToc(unpacked, opfManager, bilingualTitle);
  console.log(`   ✅ Đã bảo tồn và đồng bộ ${tocResult.totalHeadings} mục tiêu đề vào mục lục.`);

  // 10. Đóng gói ra file EPUB nếu được yêu cầu
  const shouldPack = options.pack === true;
  if (shouldPack) {
    console.log('\n📦 Đang đóng gói file EPUB song ngữ hoàn thiện...');
    const outputDir = path.resolve('output');
    if (!fs.existsSync(outputDir)) {
      await fs.promises.mkdir(outputDir, { recursive: true });
    }
    const baseName = existingMeta?.baseName || pkg.metadata.title.replace(/[/\\?%*:|"<>]/g, '_');
    const outputPath = path.join(outputDir, `${baseName}-Bilingual.epub`);
    await packEpubFromDir(workspaceDir, outputPath);
    const stat = fs.statSync(outputPath);
    console.log(`\n🎉 XUẤT BẢN THÀNH CÔNG!`);
    console.log(`🚀 File thành phẩm: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    console.log(`\n🎉 HOÀN TẤT DỊCH SONG NGỮ TOÀN BỘ SÁCH!`);
    console.log(`📁 Sách song ngữ đã được cập nhật trong thư mục: "${workspaceDir}"`);
    console.log(`👉 Bạn có thể kiểm tra thay đổi bằng lệnh: git -C workspace diff`);
    console.log(`👉 Để đóng gói ra file EPUB, hãy chạy: pnpm run pack`);
  }
}

main().catch((err) => {
  console.error('\n❌ Có lỗi xảy ra trong quá trình xử lý:', err);
  process.exit(1);
});
