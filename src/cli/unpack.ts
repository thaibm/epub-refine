import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { unpackEpubToDir } from '../core/epubArchive.js';

const program = new Command();

program
  .name('unpack')
  .description('Giải nén file EPUB ra một thư mục riêng biệt và khởi tạo Git để dễ dàng theo dõi diff')
  .argument('[epub-file]', 'Đường dẫn file EPUB (nếu để trống sẽ tự tìm file .epub)')
  .option('-d, --dir <path>', 'Thư mục đích để giải nén', './workspace')
  .action(async (epubFileArg, options) => {
    let epubPath = epubFileArg;
    const inputDir = path.resolve('input');

    if (epubPath) {
      // Nếu user truyền đường dẫn nhưng chưa đúng, kiểm tra thử trong input/
      if (!fs.existsSync(epubPath) && fs.existsSync(path.join(inputDir, epubPath))) {
        epubPath = path.join(inputDir, epubPath);
      }
    } else {
      // Ưu tiên tìm trong thư mục input/
      const searchDirs = [inputDir, process.cwd(), path.resolve(process.cwd(), '..', 'input'), path.resolve(process.cwd(), '..')];
      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const epubs = fs.readdirSync(dir).filter((f) => f.endsWith('.epub') && !f.endsWith('_edited.epub'));
        if (epubs.length > 0) {
          epubPath = path.join(dir, epubs[0]);
          break;
        }
      }

      if (!epubPath) {
        console.error('❌ Lỗi: Không tìm thấy file .epub nào trong thư mục input/ hoặc thư mục hiện tại.');
        console.error('👉 Hãy đặt file sách vào thư mục: ./input/');
        process.exit(1);
      }
    }

    if (!fs.existsSync(epubPath)) {
      console.error(`❌ Lỗi: Không tìm thấy file "${epubPath}"`);
      process.exit(1);
    }

    const targetDir = path.resolve(options.dir);
    console.log(`\n======================================================`);
    console.log(`📦 ĐANG GIẢI NÉN EPUB RA THƯ MỤC RIÊNG`);
    console.log(`📖 File nguồn: ${path.basename(epubPath)}`);
    console.log(`📁 Thư mục đích: ${targetDir}`);
    console.log(`======================================================\n`);

    await unpackEpubToDir(epubPath, targetDir, true);

    console.log(`✅ Giải nén thành công!`);
    console.log(`🌱 Đã tự động khởi tạo Git repository riêng trong: ${targetDir}`);
    console.log(`   và tạo commit gốc: "Original EPUB content (Bản gốc trước khi AI chỉnh sửa)"\n`);
    console.log(`💡 Bây giờ bạn có thể:`);
    console.log(`   1. Chạy AI update trực tiếp trên thư mục này:`);
    console.log(`      pnpm start --dir ${options.dir}`);
    console.log(`   2. Dùng lệnh sau để xem mọi thay đổi AI đã tạo ra:`);
    console.log(`      git -C ${options.dir} diff`);
    console.log(`   3. Hoặc mở thư mục "${options.dir}" trong VS Code / IDE để duyệt trực quan từng file.`);
    console.log(`   4. Đóng gói lại thành EPUB sau khi duyệt xong:`);
    console.log(`      pnpm run pack --dir ${options.dir}\n`);
  });

program.parse(process.argv);
