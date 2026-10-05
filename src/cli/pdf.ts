import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { selectOrResolvePdf } from '../pdf/pdfSelector.js';
import { classifyPdf } from '../pdf/classifier.js';
import { runVisionOcr } from '../pdf/nativeVisionOcr.js';
import { parseDigitalPdf } from '../pdf/digitalPdfParser.js';
import { removeHeadersAndFooters, convertPagesToCleanHtml } from '../pdf/layoutReflow.js';
import { splitHtmlIntoChapters, buildEpubWorkspace } from '../pdf/pdfToWorkspace.js';
import { packEpubFromDir } from '../core/epubArchive.js';
import type { PdfExtractionResult } from '../pdf/types.js';

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

  // Chuẩn bị đường dẫn ảnh bìa
  const scratchDir = path.resolve('scratch');
  if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
  const coverTempPath = options.cover
    ? path.resolve(options.cover)
    : path.join(scratchDir, `cover_${selectedPdf.baseName}.jpg`);

  // 2. Trích xuất Text & Hình ảnh
  let extraction: PdfExtractionResult;

  if (classification.type === 'scanned') {
    console.log(`\n⚡ [2/4] Đang kích hoạt native Apple Vision OCR siêu tốc (ngôn ngữ: vi-VT)...`);
    let lastProgress = 0;
    extraction = await runVisionOcr(pdfPath, {
      startPage,
      endPage,
      extractCoverPath: options.cover ? undefined : coverTempPath,
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
      startPage,
      endPage,
      extractCoverPath: options.cover ? undefined : coverTempPath,
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

  // 3. Layout Reflow & Lọc Header/Footer/Số trang
  console.log(`\n🧹 [3/4] Đang lọc bỏ running headers, running footers, số trang và reflow đoạn văn...`);
  const cleanedPages = removeHeadersAndFooters(extraction.pages);

  const bookTitle = selectedPdf.baseName
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // Cấu trúc hoá văn bản thuần túy (không qua AI, bảo toàn nguyên bản 100%)
  const fullStructuredHtml = convertPagesToCleanHtml(cleanedPages, bookTitle);

  // 4. Cắt chương và dựng EPUB Workspace
  console.log(`\n📚 [4/4] Đang phân tách chương và khởi tạo cấu trúc EPUB chuẩn vào workspace...`);
  const chapters = splitHtmlIntoChapters(fullStructuredHtml, bookTitle);
  console.log(`   📑 Đã nhận diện: ${chapters.length} chương/phần nội dung thô:`);
  for (const ch of chapters) {
    console.log(`      - [${ch.id}] ${ch.title}`);
  }

  const finalCoverImage = fs.existsSync(coverTempPath) ? coverTempPath : options.cover;

  await buildEpubWorkspace(chapters, {
    bookTitle,
    sourcePdfPath: pdfPath,
    coverImagePath: finalCoverImage,
    targetDir: workspaceDir,
    autoFootnotes: false // Giữ nguyên bản chú thích ở bước trích xuất PDF
  });

  console.log(`\n======================================================`);
  console.log(`🎉 HOÀN THÀNH TRÍCH XUẤT NỘI DUNG TỪ PDF!`);
  console.log(`   - File nguồn: ${selectedPdf.fileName}`);
  console.log(`   - Số trang đã xử lý: ${extraction.pages.length}`);
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

main().catch((err) => {
  console.error(`\n❌ LỖI TRONG QUÁ TRÌNH TRÍCH XUẤT PDF:`, err);
  process.exit(1);
});
