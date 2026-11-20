import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { selectOrResolvePdf } from '../pdf/pdfSelector.js';
import { classifyPdf } from '../pdf/classifier.js';
import { runVisionOcr } from '../pdf/nativeVisionOcr.js';
import { parseDigitalPdf } from '../pdf/digitalPdfParser.js';
import { detectAndParsePdfToc } from '../pdf/tocParser.js';
import { removeHeadersAndFooters, convertPagesToCleanHtml } from '../pdf/layoutReflow.js';
import { splitHtmlIntoChapters, buildEpubWorkspace } from '../pdf/pdfToWorkspace.js';
import type { ChapterDraft } from '../pdf/pdfToWorkspace.js';
import { buildDigitalNavigation } from '../pdf/digitalNavigation.js';
import { structureDigitalBook } from '../pdf/digitalStructure.js';
import type { DigitalStructureReport } from '../pdf/digitalStructure.js';
import { packEpubFromDir } from '../core/epubArchive.js';
import type { PdfDigitalExtraction, PdfDigitalNavigation, PdfExtractionResult } from '../pdf/types.js';

dotenv.config();

const program = new Command();

program
  .name('pdf')
  .description('Trích xuất nội dung thuần túy từ sách PDF (Scan và Docs) thành workspace EPUB chuẩn (chưa qua AI biên tập)')
  .argument('[pdf-file]', 'Số thứ tự [1-N], tên file hoặc từ khoá PDF trong input/')
  .option('-i, --input <query>', 'Số thứ tự [1-N], tên file hoặc từ khoá file PDF trong input/')
  .option('-d, --dir <path>', 'Thư mục workspace xuất bản', './workspace')
  .option('-o, --output <path>', 'Đường dẫn file EPUB xuất xưởng (nếu muốn đóng gói ngay)')
  .option('-c, --cover <path>', 'Đường dẫn ảnh bìa ngoài (nếu bìa scan mờ hoặc muốn thay thế)')
  .option('--title <text>', 'Tên sách (mặc định lấy từ metadata hoặc trang tên sách)')
  .option('--author <text>', 'Tác giả (mặc định lấy từ trang tên sách)')
  .option('--start <number>', 'Bắt đầu từ trang thứ mấy (1-based)')
  .option('--limit <number>', 'Giới hạn số trang xử lý (để kiểm thử nhanh)')
  .option('--pack', 'Tự động đóng gói file EPUB thô sau khi hoàn thành workspace', false);

program.parse(process.argv);
const options = program.opts();

async function main() {
  const query = options.input || program.args[0];
  const selectedPdf = await selectOrResolvePdf(query, { actionName: 'trích xuất nội dung sang workspace' });
  const pdfPath = selectedPdf.fullPath;
  const workspaceDir = path.resolve(options.dir);

  console.log(`\n======================================================`);
  console.log(`🚀 BẮT ĐẦU TRÍCH XUẤT NỘI DUNG PDF SANG WORKSPACE`);
  console.log(`📖 File nguồn: ${selectedPdf.fileName} (${selectedPdf.sizeFormatted})`);
  console.log(`📁 Thư mục làm việc: ${workspaceDir}`);
  console.log(`⚙️  Chế độ: Thuần túy trích xuất nội dung (chưa edit heading, chính tả)`);
  console.log(`======================================================\n`);

  // 1. Phân loại PDF (Scan vs Docs)
  console.log(`🔍 [1/4] Đang phân tích cấu trúc tài liệu PDF...`);
  const classification = await classifyPdf(pdfPath);
  console.log(`   📄 Tổng số trang: ${classification.totalPages}`);
  console.log(`   🏷️  Loại tài liệu: ${classification.type === 'scanned' ? '📸 Sách Quét (Scan PDF - Sử dụng Apple Vision OCR)' : '📑 Văn Bản Số (Docs PDF - Trích xuất Text Vector)'}`);
  console.log(`   ℹ️  Chi tiết: ${classification.sampleDetails}\n`);

  // Xác định khoảng trang cần xử lý
  const startPage = options.start ? Math.max(1, parseInt(options.start, 10)) : 1;
  let endPage = classification.totalPages;
  if (options.limit) {
    endPage = Math.min(classification.totalPages, startPage + parseInt(options.limit, 10) - 1);
  }
  console.log(`📌 Phạm vi xử lý: Trang ${startPage} -> Trang ${endPage} (${endPage - startPage + 1} trang)`);

  // Chuẩn bị đường dẫn ảnh bìa và thư mục ảnh trích xuất
  const scratchDir = path.resolve('scratch');
  if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
  const coverTempPath = options.cover
    ? path.resolve(options.cover)
    : path.join(scratchDir, `cover_${selectedPdf.baseName}.jpg`);
  const imagesTempDir = path.join(scratchDir, `extracted_images_${selectedPdf.baseName}`);
  // Dọn sạch ảnh của các lần chạy trước: nếu không, ảnh cũ (kể cả từ phiên bản lỗi) sẽ bị copy vào workspace và manifest
  fs.rmSync(imagesTempDir, { recursive: true, force: true });
  fs.mkdirSync(imagesTempDir, { recursive: true });

  // 2. Trích xuất Text & Hình ảnh
  let extraction: PdfExtractionResult;

  if (classification.type === 'scanned') {
    console.log(`\n⚡ [2/4] Đang kích hoạt native Apple Vision OCR siêu tốc (ngôn ngữ: vi-VT)...`);
    let lastProgress = 0;
    extraction = await runVisionOcr(pdfPath, {
      startPage,
      endPage,
      extractCoverPath: options.cover ? undefined : coverTempPath,
      extractImagesDir: imagesTempDir,
      onProgress(current, total) {
        const percent = Math.round((current / total) * 100);
        if (percent >= lastProgress + 10 || current === total) {
          process.stdout.write(`\r   ⏳ Tiến độ OCR: ${current}/${total} trang (${percent}%)...`);
          lastProgress = percent;
        }
      }
    });
    console.log(`\n   ✅ Đã hoàn tất OCR toàn bộ ${extraction.pages.length} trang.`);
  } else {
    console.log(`\n⚡ [2/4] Đang trích xuất text streams và toạ độ font qua PDF.js...`);
    let lastProgress = 0;
    extraction = await parseDigitalPdf(pdfPath, {
      onProgress(current, total) {
        const percent = Math.round((current / total) * 100);
        if (percent >= lastProgress + 10 || current === total) {
          process.stdout.write(`\r   ⏳ Tiến độ trích xuất: ${current}/${total} trang (${percent}%)...`);
          lastProgress = percent;
        }
      }
    });
    console.log(`\n   ✅ Đã hoàn tất trích xuất text cho ${extraction.pages.length} trang.`);
  }

  const bookTitle = selectedPdf.baseName
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  let chapters: ChapterDraft[] | undefined;
  let finalTitle: string = options.title || bookTitle;
  let finalAuthor: string | undefined = options.author;

  // Luồng PDF số: dựng cấu trúc theo bookmark/link của chính tài liệu
  if (classification.type === 'digital') {
    const digital = extraction as PdfDigitalExtraction;
    console.log(`\n📑 [2.5/4] Đang đọc cấu trúc mục lục (bookmark, link, mục lục in)...`);
    const navigation = buildDigitalNavigation(digital);

    if (navigation.source !== 'none') {
      console.log(`   ✅ Nguồn mục lục: ${navigation.source} (${navigation.entries.length} mục)`);
      console.log(`\n🧹 [3/4] Đang lọc lề trang, dựng đoạn văn và tách theo mục lục...`);
      const result = structureDigitalBook(digital, navigation, { startPage, endPage, fallbackTitle: bookTitle });

      chapters = result.chapters;
      finalTitle = options.title || result.metadata.title;
      finalAuthor = options.author || result.metadata.author;

      if (result.hasCoverPage && !options.cover) {
        await extractDigitalCover(pdfPath, coverTempPath);
      }
      printDigitalReport(result.report, navigation, scratchDir, selectedPdf.baseName);
    } else {
      console.log(`   ℹ️ Tài liệu không có bookmark, link hay mục lục in, dùng thuật toán tách chương theo nội dung.`);
      extraction = { ...extraction, pages: extraction.pages.filter((p) => p.pageNumber >= startPage && p.pageNumber <= endPage) };
    }
  }

  // Luồng sách scan, hoặc PDF số không có mục lục
  if (!chapters) {
    console.log(`\n📑 [2.5/4] Đang quét tìm và phân tích cấu trúc Mục lục trong tài liệu PDF...`);
    const toc = detectAndParsePdfToc(extraction.pages);
    if (toc.hasToc) {
      console.log(`   ✅ Đã nhận diện Mục lục (trang ${toc.tocPageNumbers.join(', ')}):`);
      console.log(`      + ${toc.majorChapters.length} Chương chính (H1)`);
      console.log(`      + ${toc.subSections.length} Tiểu mục (H2)`);
    } else {
      console.log(`   ℹ️ Không tìm thấy trang Mục lục riêng biệt, áp dụng thuật toán phân tách cấu trúc tự thân.`);
    }

    console.log(`\n🧹 [3/4] Đang lọc bỏ running headers, running footers, số trang và reflow đoạn văn...`);
    const cleanedPages = removeHeadersAndFooters(extraction.pages, { bookTitle, toc });
    const fullStructuredHtml = convertPagesToCleanHtml(cleanedPages, bookTitle, toc);
    chapters = splitHtmlIntoChapters(fullStructuredHtml, bookTitle);
  }

  // 4. Dựng EPUB Workspace
  console.log(`\n📚 [4/4] Đang khởi tạo cấu trúc EPUB chuẩn vào workspace...`);
  console.log(`   📖 Tên sách: ${finalTitle}${finalAuthor ? ` | Tác giả: ${finalAuthor}` : ''}`);
  console.log(`   📑 Đã tạo: ${chapters.length} file nội dung:`);
  for (const ch of chapters) {
    console.log(`      - [${ch.id}] ${'  '.repeat(ch.level - 1)}${ch.title}`);
  }

  const finalCoverImage = fs.existsSync(coverTempPath) ? coverTempPath : options.cover;

  await buildEpubWorkspace(chapters, {
    bookTitle: finalTitle,
    author: finalAuthor,
    sourcePdfPath: pdfPath,
    coverImagePath: finalCoverImage,
    backCoverImagePath: extraction.backCoverImagePath,
    imagesSourceDir: extraction.extractedImagesDir || imagesTempDir,
    targetDir: workspaceDir,
    autoFootnotes: false // Giữ nguyên bản chú thích ở bước trích xuất PDF
  });

  console.log(`\n======================================================`);
  console.log(`🎉 HOÀN THÀNH TRÍCH XUẤT NỘI DUNG TỪ PDF!`);
  console.log(`   - File nguồn: ${selectedPdf.fileName}`);
  console.log(`   - Số trang đã xử lý: ${endPage - startPage + 1}`);
  console.log(`   - Số chương/phần đã tạo: ${chapters.length}`);
  console.log(`   - Thư mục lưu trữ: ${workspaceDir}`);
  console.log(`   🌱 Git repository riêng đã được tạo với commit gốc: "Original PDF extracted content"`);
  console.log(`======================================================\n`);

  // Đóng gói nếu có cờ --pack
  if (options.pack) {
    const outputDir = path.resolve('output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const finalOutputPath = options.output
      ? path.resolve(options.output)
      : path.join(outputDir, `${selectedPdf.baseName}_raw.epub`);

    console.log(`📦 Đang đóng gói ra file EPUB thô...`);
    await packEpubFromDir(workspaceDir, finalOutputPath);
    const stat = fs.statSync(finalOutputPath);
    console.log(`✅ File EPUB thô đã tạo: ${finalOutputPath} (${(stat.size / 1024).toFixed(1)} KB)\n`);
  }

  console.log(`💡 BƯỚC TIẾP THEO:`);
  console.log(`   Để dùng AI bắt đầu biên tập nâng cao (chuẩn hoá H1, chèn H2/H3, sửa chính tả, tối ưu chú thích Pop-up & tạo mục lục):`);
  console.log(`   👉 pnpm start --no-pack`);
  console.log(``);
  console.log(`   Sau khi AI chạy xong, bạn có thể kiểm tra từng thay đổi bằng Git diff:`);
  console.log(`   👉 git -C ${options.dir} diff\n`);
}

async function extractDigitalCover(pdfPath: string, coverPath: string): Promise<void> {
  try {
    await runVisionOcr(pdfPath, { startPage: 1, endPage: 1, extractCoverPath: coverPath });
  } catch (err: any) {
    console.warn(`   ⚠️ Không tạo được ảnh bìa (${err.message}). Dùng --cover để truyền ảnh bìa.`);
  }
}

function printDigitalReport(
  report: DigitalStructureReport,
  navigation: PdfDigitalNavigation,
  scratchDir: string,
  baseName: string
): void {
  const percent = (report.coverage * 100).toFixed(2);
  console.log(`   📊 Kiểm tra: ${report.matchedHeadings}/${report.tocEntries} tiêu đề khớp, nội dung giữ lại ${percent}% (${report.matchedWords}/${report.sourceWords} từ)`);
  console.log(`   🧹 Đã bỏ ${report.removedMarginLines} dòng lề trang.`);

  for (const item of report.unmatchedHeadings) {
    console.warn(`   ⚠️ Không tìm thấy tiêu đề trong thân sách: "${item.title}" (trang ${item.page})`);
  }
  if (report.coverage < 0.995) {
    console.warn(`   ⚠️ Nội dung có thể bị thiếu. Các từ thiếu nhiều nhất: ${report.topMissingWords.map(([w, n]) => `${w}(${n})`).join(', ')}`);
  }
  if (report.pagesWithInlineImages.length > 0) {
    console.warn(`   ⚠️ Các trang có hình chưa được đưa vào EPUB: ${report.pagesWithInlineImages.join(', ')}`);
  }

  const reportPath = path.join(scratchDir, `pdf_report_${baseName}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, entries: navigation.entries }, null, 2), 'utf-8');
  console.log(`   📝 Báo cáo chi tiết: ${reportPath}`);
}

main().catch((err) => {
  console.error(`\n❌ LỖI TRONG QUÁ TRÌNH TRÍCH XUẤT PDF:`, err);
  process.exit(1);
});
