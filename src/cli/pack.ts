import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { packEpubFromDir, getSourceEpubMeta } from '../core/epubArchive.js';

const program = new Command();

program
  .name('pack')
  .description('Đóng gói lại thư mục thành file EPUB chuẩn IDPF/W3C')
  .option('-d, --dir <path>', 'Thư mục chứa nội dung sách đã giải nén', './workspace')
  .option('-o, --output <path>', 'Đường dẫn file EPUB xuất ra')
  .action(async (options) => {
    const inputDir = path.resolve(options.dir);

    if (!fs.existsSync(inputDir)) {
      console.error(`❌ Lỗi: Thư mục "${inputDir}" không tồn tại!`);
      process.exit(1);
    }

    const mimetypePath = path.join(inputDir, 'mimetype');
    if (!fs.existsSync(mimetypePath)) {
      console.error(`❌ Lỗi: Thư mục "${inputDir}" không phải là cấu trúc EPUB hợp lệ (thiếu file mimetype).`);
      process.exit(1);
    }

    const outputDir = path.resolve('output');
    if (!fs.existsSync(outputDir)) {
      await fs.promises.mkdir(outputDir, { recursive: true });
    }

    let outputPath = options.output;
    if (!outputPath) {
      let bookName: string | undefined;

      // 1. Kiểm tra metadata sách gốc lúc unpack (.epub-source.json)
      const sourceMeta = getSourceEpubMeta(inputDir);
      if (sourceMeta?.baseName) {
        bookName = sourceMeta.baseName;
      }

      // 2. Nếu không có, đọc title từ OPF và decode HTML entities
      if (!bookName) {
        try {
          const containerPath = path.join(inputDir, 'META-INF/container.xml');
          if (fs.existsSync(containerPath)) {
            const containerXml = fs.readFileSync(containerPath, 'utf-8');
            const fullPathMatch = containerXml.match(/full-path="([^"]+)"/);
            if (fullPathMatch) {
              const opfPath = path.join(inputDir, fullPathMatch[1]);
              if (fs.existsSync(opfPath)) {
                const opfXml = fs.readFileSync(opfPath, 'utf-8');
                const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
                if (titleMatch) {
                  // Giải mã html entities như &#xec; -> ì
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

      // 3. Fallback: Nếu trong input/ chỉ có đúng 1 file epub gốc
      if (!bookName) {
        const inputDirCheck = path.resolve('input');
        if (fs.existsSync(inputDirCheck)) {
          const inputEpubs = fs.readdirSync(inputDirCheck).filter((f) => f.endsWith('.epub') && !f.endsWith('_edited.epub'));
          if (inputEpubs.length === 1) {
            bookName = path.basename(inputEpubs[0], '.epub');
          }
        }
      }

      if (!bookName) {
        bookName = path.basename(inputDir);
      }

      outputPath = path.join(outputDir, `${bookName}_edited.epub`);
    } else {
      outputPath = path.resolve(outputPath);
    }

    console.log(`\n======================================================`);
    console.log(`📦 ĐANG ĐÓNG GÓI THƯ MỤC THÀNH FILE EPUB CHUẨN IDPF`);
    console.log(`📁 Thư mục nguồn: ${inputDir}`);
    console.log(`💾 File xuất: ${outputPath}`);
    console.log(`======================================================\n`);

    await packEpubFromDir(inputDir, outputPath);

    console.log(`✅ Đóng gói thành công!`);
    console.log(`📖 File EPUB hoàn thiện đã sẵn sàng tại:`);
    console.log(`   ${outputPath}\n`);
  });

program.parse(process.argv);
