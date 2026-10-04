import { GeminiClient } from '../ai/geminiClient.js';
import type { PdfBatchChunk } from './types.js';

export function buildPdfBatchPrompt(chunk: PdfBatchChunk, bookTitle?: string): string {
  return `Bạn là một chuyên gia biên tập và số hóa sách xuất bản tiếng Việt hàng đầu thế giới.
Nhiệm vụ của bạn là tiếp nhận đoạn văn bản thô trích xuất từ sách PDF (từ trang ${chunk.startPage} đến trang ${chunk.endPage}${bookTitle ? ` của cuốn sách "${bookTitle}"` : ''}), và xuất bản lại dưới dạng các thẻ HTML ngữ nghĩa chuẩn xác, sạch sẽ, sẵn sàng đưa vào sách điện tử EPUB.

---
### NGUYÊN TẮC BIÊN TẬP & XỬ LÝ:

1. **SỬA LỖI CHÍNH TẢ & LỖI OCR TIẾNG VIỆT:**
   - Sửa toàn bộ lỗi biến dạng dấu và ký tự do quét OCR (ví dụ: "vho" -> "cho", "Rộc Nam" -> "Bắc Nam", "qủi chụng" -> "quy chung" hoặc "chung", "Thàn Nóng" -> "Thần Nông", "Đé Minh" -> "Đế Minh", "Van Lanz" -> "Văn Lang", "kháp" -> "khắp").
   - Giữ nguyên văn phong, từ ngữ cổ, thuật ngữ triết học, tên riêng lịch sử và nội dung của tác giả. Tuyệt đối KHÔNG tự ý tóm tắt, cắt xén hoặc thêm thắt câu chữ ngoài việc sửa lỗi nhận diện chữ.

2. **CHUẨN HÓA TIÊU ĐỀ (HEADINGS):**
   - Đặt thẻ \`<h1>\` cho Tiêu đề Chương lớn, Tên Phần, Tên Quẻ hoặc Mục chính quan trọng nhất (ví dụ: \`<h1>Chương I: Nguồn Gốc Triết Lý</h1>\`, \`<h1>1. Quẻ Càn</h1>\`).
   - Đặt thẻ \`<h2>\` cho các đề mục cấp 2 bên trong chương.
   - Đặt thẻ \`<h3>\` cho các tiểu mục nhỏ hơn.

3. **LOẠI BỎ RÁC & DỮ LIỆU ĐẦU/CHÂN TRANG CÒN SÓT LẠI:**
   - Lọc bỏ triệt để các dòng số trang sót lại (như "Trang 12", "12", "Trang 13").
   - Lọc bỏ tiêu đề chạy trên đầu trang (running header) lặp lại như "${bookTitle || 'Tên Sách'}".

4. **BÓC TÁCH VÀ CHUẨN HOÁ CHÚ THÍCH (FOOTNOTES):**
   - Nếu trong văn bản có ký hiệu chú thích (ví dụ: (1), [1], hoặc số mũ 1) và ở chân trang có lời giải thích tương ứng:
     - Trong đoạn văn: đặt thẻ liên kết \`<a href="#chuthich_1" id="ref_1"><sup>[1]</sup></a>\`
     - Ở cuối đoạn/chương: gom tất cả các chú thích vào khối:
       \`\`\`html
       <div class="footnotes">
         <p id="chuthich_1"><strong>[1]</strong> Lời giải thích chú thích 1...</p>
       </div>
       \`\`\`

5. **ĐỊNH DẠNG HTML/XHTML CHUẨN:**
   - Mọi đoạn văn xuôi phải được bọc trong thẻ \`<p>...</p>\`.
   - Trích dẫn thơ hoặc đoạn văn trích dẫn đặt trong \`<blockquote><p>...</p></blockquote>\`.
   - Danh sách gạch đầu dòng/số thứ tự đặt trong \`<ul>\` / \`<ol>\` và \`<li>\`.
   - CHỈ trả về các thẻ HTML hợp lệ, KHÔNG bọc trong markdown code fence (\`\`\`html), KHÔNG kèm bất kỳ lời giải thích nào.

---
### VĂN BẢN NGUỒN CẦN XỬ LÝ (TRANG ${chunk.startPage} - ${chunk.endPage}):
${chunk.content}
`;
}

/**
 * Xử lý từng batch trang PDF qua Gemini để cấu trúc hoá thành HTML
 */
export async function structurePdfBatch(
  gemini: GeminiClient,
  chunk: PdfBatchChunk,
  bookTitle?: string
): Promise<string> {
  const prompt = buildPdfBatchPrompt(chunk, bookTitle);
  const result = await gemini.structurePdfContent(prompt);
  return result;
}
