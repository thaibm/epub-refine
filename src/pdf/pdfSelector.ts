import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { formatBytes, cleanForSearch } from '../core/fileSelector.js';

export interface PdfFileInfo {
  index: number;
  fileName: string;
  baseName: string;
  fullPath: string;
  sizeBytes: number;
  sizeFormatted: string;
}

export function listInputPdfs(customInputDir = 'input'): PdfFileInfo[] {
  const inputDir = path.resolve(customInputDir);
  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  const pdfFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'vi', { sensitivity: 'base' }));

  return pdfFiles.map((fileName, idx) => {
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

export function resolvePdfFromQuery(query: string, pdfs: PdfFileInfo[]): PdfFileInfo | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  // 1. Số thứ tự (1, 2, ...)
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && /^\d+$/.test(trimmed)) {
    if (num >= 1 && num <= pdfs.length) {
      return pdfs[num - 1];
    }
    return undefined;
  }

  // 2. Đường dẫn file trực tiếp
  const directPath = path.resolve(trimmed);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    const fileName = path.basename(directPath);
    const stats = fs.statSync(directPath);
    const existing = pdfs.find((p) => path.resolve(p.fullPath) === directPath);
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

  // 3. Trong input/
  const inputDir = path.resolve('input');
  const pathInInput = path.join(inputDir, trimmed);
  if (fs.existsSync(pathInInput) && fs.statSync(pathInInput).isFile()) {
    const inInput = pdfs.find((p) => path.resolve(p.fullPath) === pathInInput);
    if (inInput) return inInput;
  }

  // 4. Khớp tên file chính xác
  const queryLower = trimmed.toLowerCase();
  const exactMatch = pdfs.find(
    (p) =>
      p.fileName.toLowerCase() === queryLower ||
      p.baseName.toLowerCase() === queryLower ||
      p.fileName.toLowerCase() === `${queryLower}.pdf`
  );
  if (exactMatch) return exactMatch;

  // 5. Khớp gần đúng (accent-insensitive)
  const normQ = cleanForSearch(trimmed);
  if (normQ.length > 0) {
    const matches = pdfs.filter((p) => {
      const normFileName = cleanForSearch(p.fileName);
      return normFileName.includes(normQ);
    });

    if (matches.length > 0) {
      const startsWithMatch = matches.find((p) => cleanForSearch(p.fileName).startsWith(normQ));
      return startsWithMatch || matches[0];
    }
  }

  return undefined;
}

export async function promptUserForPdfSelection(
  pdfs: PdfFileInfo[],
  actionName = 'chuyển đổi sang EPUB'
): Promise<PdfFileInfo> {
  if (pdfs.length === 0) {
    console.error(`\n❌ Không tìm thấy file PDF nào trong thư mục input/!`);
    console.log(`💡 Hãy đặt các file sách .pdf vào thư mục: ${path.resolve('input')}\n`);
    process.exit(1);
  }

  if (pdfs.length === 1) {
    console.log(`\n📌 Tự động chọn file PDF duy nhất trong input/:`);
    console.log(`   👉 [1] ${pdfs[0].fileName} (${pdfs[0].sizeFormatted})\n`);
    return pdfs[0];
  }

  console.log(`\n📚 DANH SÁCH FILE PDF TRONG THƯ MỤC INPUT:`);
  console.log(`--------------------------------------------------------------------------------`);
  for (const pdf of pdfs) {
    const idxStr = `[${pdf.index}]`.padStart(4, ' ');
    const sizeStr = `(${pdf.sizeFormatted})`.padStart(11, ' ');
    console.log(` ${idxStr} ${pdf.fileName.padEnd(52, ' ')} ${sizeStr}`);
  }
  console.log(`--------------------------------------------------------------------------------`);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const answer = await rl.question(
        `\n👉 Nhập số thứ tự [1-${pdfs.length}] hoặc từ khoá để ${actionName} (hoặc 'q' để thoát): `
      );

      const trimmed = answer.trim();
      if (trimmed.toLowerCase() === 'q' || trimmed.toLowerCase() === 'exit') {
        console.log(`Đã huỷ thao tác.`);
        process.exit(0);
      }

      if (!trimmed) {
        console.log(`⚠️ Vui lòng nhập số thứ tự hoặc từ khoá tìm kiếm.`);
        continue;
      }

      const match = resolvePdfFromQuery(trimmed, pdfs);
      if (match) {
        return match;
      }

      console.log(`❌ Không tìm thấy file PDF nào khớp với "${trimmed}". Vui lòng thử lại.`);
    }
  } finally {
    rl.close();
  }
}

export async function selectOrResolvePdf(
  query?: string,
  options: { actionName?: string; inputDir?: string } = {}
): Promise<PdfFileInfo> {
  const pdfs = listInputPdfs(options.inputDir || 'input');

  if (query && query.trim()) {
    const resolved = resolvePdfFromQuery(query, pdfs);
    if (resolved) {
      return resolved;
    }
    console.warn(`⚠️ Không tìm thấy file PDF nào khớp với query "${query}". Chuyển sang menu chọn...`);
  }

  return promptUserForPdfSelection(pdfs, options.actionName || 'chuyển đổi sang EPUB');
}
