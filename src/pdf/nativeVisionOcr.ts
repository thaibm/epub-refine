import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
import type { PdfExtractedPage, PdfExtractionResult, PdfLineItem } from './types.js';

export interface VisionOcrOptions {
  startPage?: number;
  endPage?: number;
  extractCoverPath?: string;
  languages?: string[];
  dpi?: number;
  onProgress?: (current: number, total: number) => void;
}

/**
 * Đảm bảo binary native Swift vision-ocr đã được biên dịch trên macOS
 */
export function ensureVisionOcrBinary(): string {
  const binaryPath = path.resolve('bin/vision-ocr');
  const sourcePath = path.resolve('src/pdf/native/vision_ocr.swift');

  if (fs.existsSync(binaryPath)) {
    // Kiểm tra xem source có mới hơn binary không
    const binStat = fs.statSync(binaryPath);
    const srcStat = fs.statSync(sourcePath);
    if (binStat.mtimeMs >= srcStat.mtimeMs) {
      return binaryPath;
    }
  }

  console.log(`🔨 Đang biên dịch công cụ Apple Vision OCR native cho macOS...`);
  const binDir = path.dirname(binaryPath);
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  try {
    execSync(`swiftc -O -o "${binaryPath}" "${sourcePath}"`, { stdio: 'inherit' });
    console.log(`✅ Biên dịch thành công binary: ${binaryPath}`);
  } catch (err: any) {
    throw new Error(`Không thể biên dịch Swift Apple Vision OCR: ${err.message}`);
  }

  return binaryPath;
}

/**
 * Chạy Apple Vision OCR trên file PDF Scan
 */
export async function runVisionOcr(
  pdfPath: string,
  options: VisionOcrOptions = {}
): Promise<PdfExtractionResult> {
  const binaryPath = ensureVisionOcrBinary();
  const absPdfPath = path.resolve(pdfPath);

  const args = [absPdfPath];

  if (options.startPage && options.startPage > 0) {
    args.push('--start-page', String(options.startPage));
  }
  if (options.endPage && options.endPage > 0) {
    args.push('--end-page', String(options.endPage));
  }
  if (options.extractCoverPath) {
    args.push('--extract-cover', path.resolve(options.extractCoverPath));
  }
  if (options.languages && options.languages.length > 0) {
    args.push('--langs', options.languages.join(','));
  }
  if (options.dpi) {
    args.push('--dpi', String(options.dpi));
  }

  const child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  const pages: PdfExtractedPage[] = [];
  let totalDocPages = 0;
  let coverPath = options.extractCoverPath;

  return new Promise((resolve, reject) => {
    let stderrOutput = '';
    child.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const data = JSON.parse(trimmed);
        if (data.type === 'progress') {
          totalDocPages = data.total;
          if (options.onProgress) {
            options.onProgress(data.current, data.total);
          }
        } else if (data.type === 'cover') {
          coverPath = data.path;
        } else if (data.type === 'page') {
          const lines: PdfLineItem[] = data.lines || [];
          const rawText = lines.map((l: PdfLineItem) => l.text).join('\n');
          pages.push({
            pageNumber: data.pageNumber,
            lines,
            rawText
          });
        } else if (data.type === 'error') {
          console.error(`❌ Vision OCR Error: ${data.message}`);
        }
      } catch {
        // Bỏ qua dòng không phải JSON
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Vision OCR tiến trình dừng với mã lỗi ${code}: ${stderrOutput}`));
      }

      // Sắp xếp các trang theo thứ tự tăng dần
      pages.sort((a, b) => a.pageNumber - b.pageNumber);

      const fileName = path.basename(absPdfPath);
      const baseName = path.basename(fileName, path.extname(fileName));

      resolve({
        totalPages: totalDocPages || pages.length,
        pages,
        coverImagePath: coverPath,
        sourcePdfPath: absPdfPath,
        fileName,
        baseName,
        pdfType: 'scanned'
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
