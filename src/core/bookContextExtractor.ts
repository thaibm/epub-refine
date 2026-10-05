import fs from 'node:fs';
import path from 'node:path';
import type { BookContext } from '../types/index.js';
import type { GeminiClient } from '../ai/geminiClient.js';
import type { UnpackedEpub } from './epubArchive.js';
import { OpfManager } from './opfManager.js';
import * as cheerio from 'cheerio';

export class BookContextExtractor {
  private filePath: string;
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, 'book_context.json');
  }

  load(): BookContext | null {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw) as BookContext;
      } catch (err) {
        console.warn(`[BookContextExtractor] Không thể đọc ${this.filePath}`);
      }
    }
    return null;
  }

  save(context: BookContext): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(context, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[BookContextExtractor] Không thể lưu ${this.filePath}:`, err);
    }
  }

  async extractOrLoad(
    unpacked: UnpackedEpub,
    geminiClient: GeminiClient
  ): Promise<BookContext> {
    const existing = this.load();
    if (existing) {
      console.log(`   💡 Đã tải ngữ cảnh sách từ ${this.filePath}`);
      return existing;
    }

    console.log('   🔍 Đang phân tích tổng quan cuốn sách (Book Profiling) bằng AI...');

    const opfPath = OpfManager.findOpfPath(unpacked);
    const opfManager = new OpfManager(unpacked, opfPath);
    const pkg = opfManager.getPackageInfo();
    const bookTitle = pkg.metadata.title || 'Untitled Book';

    // Thu thập một số đoạn mở đầu từ các chương đầu tiên để AI nhận diện thể loại và văn phong
    const spineItems = opfManager.getSpineChapterFiles();
    let sampleText = '';
    let sampleCount = 0;

    for (const item of spineItems) {
      if (sampleCount >= 3) break;
      const content = unpacked.getFileString(item.zipPath);
      const $ = cheerio.load(content, { xml: { decodeEntities: false } });
      const text = $('body').text().replace(/\s+/g, ' ').trim();
      if (text.length > 200) {
        sampleText += `\n--- Trích đoạn ${item.relativeHref} ---\n` + text.slice(0, 1500) + '\n';
        sampleCount++;
      }
    }

    const prompt = `Bạn là chuyên gia thẩm định và dịch thuật sách quốc tế.
Dưới đây là thông tin và một số trích đoạn của một cuốn sách tiếng Anh cần dịch sang tiếng Việt:
Tựa sách: "${bookTitle}"
Tác giả: "${pkg.metadata.creator || 'Chưa rõ'}"

Trích đoạn nội dung sách:
${sampleText}

Hãy phân tích toàn diện cuốn sách này để thiết lập ngữ cảnh dịch thuật chuẩn xác nhất, trả về định dạng JSON thuần tuý:
{
  "bookTitle": "Tên sách dịch sang tiếng Việt (ví dụ: 'Tuần Làm Việc 4 Giờ')",
  "originalTitle": "${bookTitle}",
  "genre": "Thể loại sách (ví dụ: Kinh doanh / Kỹ năng sống / Triết học / Tiểu thuyết)",
  "domain": "Lĩnh vực chuyên môn chính",
  "tone": "Giọng văn chuẩn cần dịch (ví dụ: Trang trọng, truyền cảm hứng, đối thoại thân mật, hài hước, hoặc học thuật)",
  "pronouns": {
    "author": "Đại từ tác giả tự xưng (ví dụ: 'tôi', 'chúng tôi', 'tác giả')",
    "reader": "Đại từ xưng hô với độc giả (ví dụ: 'bạn', 'quý độc giả', 'các bạn')",
    "notes": "Quy tắc xưng hô đặc biệt nếu có"
  },
  "summary": "Tóm tắt cốt lõi chủ đề cuốn sách trong 3-4 câu để làm bối cảnh dịch thuật."
}
`;

    try {
      const result = await geminiClient.analyzeGenericJson<BookContext>(prompt);
      if (!result.originalTitle) result.originalTitle = bookTitle;
      this.save(result);
      console.log(`   ✅ Đã định hình ngữ cảnh sách: "${result.bookTitle}" (Thể loại: ${result.genre}, Giọng văn: ${result.tone})`);
      return result;
    } catch (err: any) {
      console.warn(`   ⚠️ Không thể phân tích ngữ cảnh tự động (${err.message}), dùng cấu hình mặc định.`);
      const fallback: BookContext = {
        bookTitle,
        originalTitle: bookTitle,
        genre: 'General Non-Fiction',
        tone: 'Truyền cảm hứng, trang trọng, gần gũi',
        pronouns: {
          author: 'tôi',
          reader: 'bạn'
        },
        summary: `Cuốn sách "${bookTitle}".`
      };
      this.save(fallback);
      return fallback;
    }
  }
}
