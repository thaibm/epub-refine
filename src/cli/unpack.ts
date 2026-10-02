import path from 'node:path';
import { Command } from 'commander';
import { unpackEpubToDir } from '../core/epubArchive.js';
import { selectOrResolveEpub } from '../core/fileSelector.js';

const program = new Command();

program
  .name('unpack')
  .description('Giải nén file EPUB ra một thư mục riêng biệt và khởi tạo Git để dễ dàng theo dõi diff')
  .argument('[epub-file]', 'Số thứ tự [1-N], tên file, từ khoá tìm kiếm hoặc đường dẫn file EPUB (nếu để trống sẽ hiển thị danh sách lựa chọn)')
  .option('-i, --input <query>', 'Số thứ tự [1-N], tên file hoặc từ khoá tìm kiếm file trong input/')
  .option('-d, --dir <path>', 'Thư mục đích để giải nén', './workspace')
  .action(async (epubFileArg, options) => {
    const query = options.input || epubFileArg;
    const selectedEpub = await selectOrResolveEpub(query, { actionName: 'giải nén' });
    const epubPath = selectedEpub.fullPath;
    const targetDir = path.resolve(options.dir);

    console.log(`\n======================================================`);
    console.log(`📦 ĐANG GIẢI NÉN EPUB RA THƯ MỤC RIÊNG`);
    console.log(`📖 File nguồn: ${selectedEpub.fileName} (${selectedEpub.sizeFormatted})`);
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
