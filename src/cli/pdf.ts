import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { selectOrResolvePdf } from '../pdf/pdfSelector.js';
import { classifyPdf } from '../pdf/classifier.js';
import { runVisionOcr } from '../pdf/nativeVisionOcr.js';
import { parseDigitalPdf } from '../pdf/digitalPdfParser.js';
import { removeHeadersAndFooters, chunkPagesIntoBatches, reflowPageLines } from '../pdf/layoutReflow.js';
import { GeminiClient } from '../ai/geminiClient.js';
import { structurePdfBatch } from '../pdf/pdfGeminiStructurer.js';
import { splitHtmlIntoChapters, buildEpubWorkspace } from '../pdf/pdfToWorkspace.js';
import { packEpubFromDir } from '../core/epubArchive.js';
import type { PdfExtractionResult } from '../pdf/types.js';

dotenv.config();

const program = new Command();

program
  .name('pdf')
  .description('Chuyển đổi sách PDF (cả dạng Scan và Docs) thành sách EPUB 3 chuẩn quốc tế')
  .argument('[pdf-file]', 'Số thứ tự [1-N], tên file hoặc từ khoá PDF trong input/')
  .option('-i, --input <query>', 'Số thứ tự [1-N], tên file hoặc từ khoá file PDF trong input/')
  .option('-d, --dir <path>', 'Thư mục workspace xuất bản', './workspace')
  .option('-o, --output <path>', 'Đường dẫn file EPUB xuất xưởng (mặc định trong output/)')
  .option('-c, --cover <path>', 'Đường dẫn ảnh bìa ngoài (nếu bìa scan mờ hoặc muốn thay thế)')
  .option('-m, --model <model>', 'Tên Gemini Model', process.env.GEMINI_MODEL || 'gemini-3.6-flash')
  .option('-k, --api-key <key>', 'Google Gemini API Key')
  .option('--start <number>', 'Bắt đầu từ trang thứ mấy (1-based)')
  .option('--limit <number>', 'Giới hạn số trang xử lý (để kiểm thử nhanh)')
  .option('--no-ai', 'Bỏ qua bước gọi Gemini AI, chỉ trích xuất và reflow thô')
  .option('--all', 'Chạy trọn gói từ PDF ra thẳng file EPUB hoàn thiện trong output/', false)
  .option('--pack', 'Tự động đóng gói file EPUB sau khi hoàn thành workspace', false);

program.parse(process.argv);
const options = program.opts();

async function main() {
  const query = options.input || program.args[0];
  const selectedPdf = await selectOrResolvePdf(query, { actionName: 'chuyển đổi sang EPUB' });
  const pdfPath = selectedPdf.fullPath;
  const workspaceDir = path.resolve(options.dir);

  console.log(`\n======================================================`);
  console.log(`🚀 BẮT ĐẦU CHUYỂN ĐỔI PDF SANG EPUB`);
  console.log(`📖 File nguồn: ${selectedPdf.fileName} (${selectedPdf.sizeFormatted})`);
  console.log(`📁 Workspace: ${workspaceDir}`);
  console.log(`======================================================\n`);

  // 1. Phân loại PDF (Scan vs Docs)
  console.log(`🔍 [Tầng 1] Đang phân tích cấu trúc tài liệu PDF...`);
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
    console.log(`\n⚡ Đang kích hoạt native Apple Vision OCR siêu tốc (ngôn ngữ: vi-VT)...`);
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
    console.log(`\n⚡ Đang trích xuất text streams và toạ độ font qua PDF.js...`);
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
  console.log(`\n🧹 [Tầng 2] Đang lọc bỏ running headers, running footers và số trang lặp lại...`);
  const cleanedPages = removeHeadersAndFooters(extraction.pages);
  const batches = chunkPagesIntoBatches(cleanedPages);
  console.log(`   📦 Đã gom thành ${batches.length} batch xử lý (${batches.map((b) => `Trang ${b.startPage}-${b.endPage}`).join(', ')})`);

  // 4. Cấu trúc hoá văn bản qua Gemini hoặc chuyển đổi thô
  const bookTitle = selectedPdf.baseName.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  let fullStructuredHtml = '';

  if (options.ai === false) {
    console.log(`\n⏭️  Bỏ qua bước gọi Gemini AI (--no-ai). Tiến hành chuyển đổi trực tiếp sang HTML...`);
    const partsHtml = batches.map((b) => {
      const paras = b.content
        .split('\n\n')
        .map((p) => p.trim())
        .filter((p) => !p.startsWith('<!-- PAGE:'))
        .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
        .join('\n');
      return `<section>\n<h1>${bookTitle} - Phần ${b.batchIndex}</h1>\n${paras}\n</section>`;
    });
    fullStructuredHtml = partsHtml.join('\n\n');
  } else {
    console.log(`\n🤖 [Tầng 2] Đang chuyển tiếp qua Gemini AI để sửa lỗi chính tả OCR, chuẩn hoá H1/H2 và bóc Footnote...`);
    const gemini = new GeminiClient({
      apiKey: options.apiKey,
      model: options.model
    });

    const structuredParts: string[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`   👉 [Batch ${i + 1}/${batches.length}] Xử lý từ trang ${batch.startPage} đến trang ${batch.endPage}...`);
      try {
        const structuredHtml = await structurePdfBatch(gemini, batch, bookTitle);
        structuredParts.push(structuredHtml);
        console.log(`      ✅ Xong batch ${i + 1}/${batches.length}`);
      } catch (err: any) {
        console.warn(`      ⚠️ Lỗi batch ${i + 1}: ${err.message}. Sử dụng văn bản đã reflow cho batch này.`);
        const fallbackParas = batch.content
          .split('\n\n')
          .filter((p) => !p.startsWith('<!-- PAGE:'))
          .map((p) => `<p>${p}</p>`)
          .join('\n');
        structuredParts.push(`<section><h1>Phần ${batch.batchIndex}</h1>${fallbackParas}</section>`);
      }
    }

    fullStructuredHtml = structuredParts.join('\n\n');
  }

  // 5. Cắt chương và dựng EPUB Workspace
  console.log(`\n📚 [Tầng 3] Đang cắt chương và khởi tạo cấu trúc EPUB chuẩn IDPF vào workspace...`);
  const chapters = splitHtmlIntoChapters(fullStructuredHtml, bookTitle);
  console.log(`   📑 Đã nhận diện: ${chapters.length} chương/phần.`);
  for (const ch of chapters) {
    console.log(`      - [${ch.id}] ${ch.title}`);
  }

  const finalCoverImage = fs.existsSync(coverTempPath) ? coverTempPath : options.cover;

  await buildEpubWorkspace(chapters, {
    bookTitle,
    sourcePdfPath: pdfPath,
    coverImagePath: finalCoverImage,
    targetDir: workspaceDir,
    autoFootnotes: true
  });

  console.log(`\n✅ ĐÃ XUẤT BẢN THÀNH CÔNG VÀO WORKSPACE!`);
  console.log(`🌱 Đã tự động khởi tạo Git repository riêng trong: ${workspaceDir}`);
  console.log(`   và tạo commit gốc: "Original PDF extracted content"`);

  // 6. Đóng gói nếu có flag --all hoặc --pack
  if (options.all || options.pack) {
    const outputDir = path.resolve('output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const finalOutputPath = options.output
      ? path.resolve(options.output)
      : path.join(outputDir, `${selectedPdf.baseName}_edited.epub`);

    console.log(`\n📦 Đang đóng gói ra file EPUB thành phẩm...`);
    await packEpubFromDir(workspaceDir, finalOutputPath);
    const stat = fs.statSync(finalOutputPath);
    console.log(`🎉 HOÀN TẤT TRỌN GÓI!`);
    console.log(`📖 File xuất xưởng: ${finalOutputPath} (${(stat.size / 1024).toFixed(1)} KB)`);
  } else {
    console.log(`\n💡 BÂY GIỜ BẠN CÓ THỂ:`);
    console.log(`   1. Duyệt Git diff trực quan trên VS Code hoặc dòng lệnh:`);
    console.log(`      git -C ${options.dir} diff`);
    console.log(`   2. Chạy tiếp các công cụ chuyên sâu của edit-epub:`);
    console.log(`      pnpm run footnote    # Kiểm tra & nâng cấp chú thích Pop-up`);
    console.log(`      pnpm run toc         # Đồng bộ lại cây mục lục 3 cấp`);
    console.log(`      pnpm start --no-pack # Tinh chỉnh H2/H3 và sửa chính tả`);
    console.log(`   3. Đóng gói thành file EPUB hoàn chỉnh sau khi duyệt:`);
    console.log(`      pnpm run pack --dir ${options.dir}\n`);
  }
}

main().catch((err) => {
  console.error(`\n❌ LỖI TRONG QUÁ TRÌNH XỬ LÝ:`, err);
  process.exit(1);
});
