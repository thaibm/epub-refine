import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface EpubFileInfo {
  index: number; // 1-based index
  fileName: string;
  baseName: string;
  fullPath: string;
  sizeBytes: number;
  sizeFormatted: string;
}

/**
 * Định dạng dung lượng byte sang B / KB / MB dễ đọc
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Loại bỏ dấu tiếng Việt để phục vụ tìm kiếm gần đúng
 */
export function removeVietnameseTones(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Chuẩn hoá chuỗi tìm kiếm: Unicode NFC, bỏ dấu, thay gạch dưới/nối bằng khoảng trắng
 */
export function cleanForSearch(str: string): string {
  return removeVietnameseTones(str.normalize('NFC').toLowerCase())
    .replace(/[-_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Quét thư mục input/ để lấy danh sách tất cả các file EPUB hợp lệ
 */
export function listInputEpubs(customInputDir = 'input'): EpubFileInfo[] {
  const inputDir = path.resolve(customInputDir);
  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  const epubFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.epub') && !entry.name.endsWith('_edited.epub'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'vi', { sensitivity: 'base' }));

  return epubFiles.map((fileName, idx) => {
    const fullPath = path.join(inputDir, fileName);
    const stats = fs.statSync(fullPath);
    return {
      index: idx + 1,
      fileName,
      baseName: path.basename(fileName, path.extname(fileName)),
      fullPath,
      sizeBytes: stats.size,
      sizeFormatted: formatBytes(stats.size)
    };
  });
}

/**
 * Tìm file EPUB theo:
 * 1. Số thứ tự (1-based index: "1", "2", ...)
 * 2. Đường dẫn file cụ thể trên đĩa
 * 3. Tên file chính xác (hoặc không kèm đuôi .epub)
 * 4. Tìm kiếm gần đúng / không phân biệt hoa thường / không phân biệt dấu tiếng Việt
 */
export function resolveEpubFromQuery(query: string, epubs: EpubFileInfo[]): EpubFileInfo | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  // 1. Kiểm tra nếu là số thứ tự 1-based (ví dụ: "1", "2", "3")
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && /^\d+$/.test(trimmed)) {
    if (num >= 1 && num <= epubs.length) {
      return epubs[num - 1];
    }
    return undefined;
  }

  // 2. Kiểm tra nếu là đường dẫn file tồn tại trực tiếp trên hệ thống
  const directPath = path.resolve(trimmed);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    if (directPath.toLowerCase().endsWith('.pdf')) {
      return undefined;
    }
    const fileName = path.basename(directPath);
    const stats = fs.statSync(directPath);
    const existing = epubs.find((e) => path.resolve(e.fullPath) === directPath);
    if (existing) return existing;
    return {
      index: 0,
      fileName,
      baseName: path.basename(fileName, path.extname(fileName)),
      fullPath: directPath,
      sizeBytes: stats.size,
      sizeFormatted: formatBytes(stats.size)
    };
  }

  // 3. Kiểm tra nếu nằm trong input/
  const inputDir = path.resolve('input');
  const pathInInput = path.join(inputDir, trimmed);
  if (fs.existsSync(pathInInput) && fs.statSync(pathInInput).isFile()) {
    if (pathInInput.toLowerCase().endsWith('.pdf')) {
      return undefined;
    }
    const inInput = epubs.find((e) => path.resolve(e.fullPath) === pathInInput);
    if (inInput) return inInput;
  }

  // 4. Khớp chính xác tên file (hoặc không cần đuôi .epub)
  const queryLower = trimmed.toLowerCase();
  const exactMatch = epubs.find(
    (e) =>
      e.fileName.toLowerCase() === queryLower ||
      e.baseName.toLowerCase() === queryLower ||
      e.fileName.toLowerCase() === `${queryLower}.epub`
  );
  if (exactMatch) return exactMatch;

  // 5. Khớp gần đúng (accent-insensitive & normalized search)
  const normQ = cleanForSearch(trimmed);
  if (normQ.length > 0) {
    const matches = epubs.filter((e) => {
      const normFileName = cleanForSearch(e.fileName);
      return normFileName.includes(normQ);
    });

    if (matches.length > 0) {
      // Ưu tiên file bắt đầu bằng từ khoá tìm kiếm, nếu không thì lấy kết quả đầu tiên
      const startsWithMatch = matches.find((e) => cleanForSearch(e.fileName).startsWith(normQ));
      return startsWithMatch || matches[0];
    }
  }

  return undefined;
}

/**
 * In ra màn hình danh sách các file EPUB có sẵn trong input/
 */
export function printAvailableEpubs(epubs: EpubFileInfo[]): void {
  console.log(`\n📚 Tìm thấy ${epubs.length} file EPUB trong thư mục input/:`);
  epubs.forEach((e) => {
    console.log(`  [${e.index}] ${e.fileName} (${e.sizeFormatted})`);
  });
  console.log('');
}

/**
 * Lựa chọn hoặc phân giải file EPUB:
 * - Nếu có query: tìm file khớp (theo số thứ tự, tên file hoặc từ khoá).
 * - Nếu không có query:
 *   + Nếu có 1 file: tự động chọn.
 *   + Nếu có nhiều file: hiển thị menu tương tác để người dùng chọn.
 */
export async function selectOrResolveEpub(
  query?: string,
  options?: { customInputDir?: string; actionName?: string }
): Promise<EpubFileInfo> {
  const inputDir = options?.customInputDir || 'input';
  const epubs = listInputEpubs(inputDir);
  const actionName = options?.actionName || 'xử lý';

  // 1. Trường hợp người dùng có truyền tham số query
  if (query && query.trim()) {
    const trimmed = query.trim();
    const isDirectPdf =
      trimmed.toLowerCase().endsWith('.pdf') ||
      (fs.existsSync(trimmed) && trimmed.toLowerCase().endsWith('.pdf')) ||
      (fs.existsSync(path.join(inputDir, trimmed)) && trimmed.toLowerCase().endsWith('.pdf'));

    if (isDirectPdf) {
      console.error(`\n❌ Lỗi: "${trimmed}" là tài liệu định dạng PDF, không phải sách EPUB.`);
      console.error(`👉 Quy trình xử lý PDF đã được tách riêng khỏi pnpm start:`);
      console.error(`   Bước 1: Trích xuất nội dung thuần túy từ PDF sang workspace:`);
      console.error(`      pnpm run pdf -i "${trimmed}"`);
      console.error(`   Bước 2: Dùng AI biên tập heading, chính tả, footnote & TOC:`);
      console.error(`      pnpm start --no-pack\n`);
      process.exit(1);
    }

    const matched = resolveEpubFromQuery(query, epubs);
    if (matched) {
      return matched;
    }

    console.error(`\n❌ Lỗi: Không tìm thấy file EPUB nào khớp với: "${query}"`);
    if (epubs.length > 0) {
      printAvailableEpubs(epubs);
      console.error(`👉 Bạn có thể chỉ định theo số thứ tự (ví dụ: 1 đến ${epubs.length}) hoặc một phần tên file.\n`);
    } else {
      console.error(`👉 Thư mục "${inputDir}" hiện không có file .epub nào.\n`);
    }
    process.exit(1);
  }

  // 2. Trường hợp không truyền query
  if (epubs.length === 0) {
    const pdfs = fs.existsSync(inputDir)
      ? fs.readdirSync(inputDir).filter((f) => f.endsWith('.pdf'))
      : [];
    console.error(`\n❌ Lỗi: Không tìm thấy file .epub nào trong thư mục "${inputDir}/"`);
    if (pdfs.length > 0) {
      console.error(`💡 Tìm thấy ${pdfs.length} file PDF trong "${inputDir}/": ${pdfs.join(', ')}`);
      console.error(`👉 Để trích xuất nội dung PDF vào workspace, hãy chạy:`);
      console.error(`   pnpm run pdf\n`);
    } else {
      console.error(`👉 Hãy copy file sách (.epub hoặc .pdf) vào thư mục: ./${inputDir}/\n`);
    }
    process.exit(1);
  }

  // Nếu chỉ có duy nhất 1 file trong input/
  if (epubs.length === 1) {
    console.log(`\n[Auto-detect] Đã tự động chọn file EPUB duy nhất: "${epubs[0].fileName}" (${epubs[0].sizeFormatted})`);
    return epubs[0];
  }

  // Nếu có nhiều file trong input/
  printAvailableEpubs(epubs);

  // Kiểm tra nếu terminal không hỗ trợ tương tác (TTY)
  if (!process.stdin.isTTY) {
    console.log(`⚡ Môi trường non-interactive: tự động chọn file [1] "${epubs[0].fileName}".`);
    console.log(`💡 Mẹo: Bạn có thể chỉ định file cụ thể bằng: -i <số_thứ_tự|tên_file>\n`);
    return epubs[0];
  }

  // Mở giao diện dòng lệnh tương tác hỏi người dùng
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const answer = (
        await rl.question(`👉 Chọn file cần ${actionName} [1-${epubs.length}] hoặc nhập từ khoá (mặc định: 1): `)
      ).trim();

      if (!answer) {
        rl.close();
        return epubs[0];
      }

      const match = resolveEpubFromQuery(answer, epubs);
      if (match) {
        rl.close();
        return match;
      }

      console.log(`⚠️ Không tìm thấy file nào khớp với "${answer}". Vui lòng nhập số từ 1 đến ${epubs.length} hoặc từ khoá:`);
    }
  } catch (err) {
    rl.close();
    throw err;
  }
}
