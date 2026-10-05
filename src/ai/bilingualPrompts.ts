import type { BookContext } from '../types/index.js';

export interface BilingualBatchInput {
  bookContext: BookContext;
  chapterTitle?: string;
  glossaryPromptFormatted: string;
  slidingContext: string[];
  currentBatch: { idx: number; text: string }[];
  isFirstBatchOfChapter?: boolean;
  rawH1?: string;
  authorNotes?: { num: string; text: string }[];
}

export function buildBilingualBatchPrompt(input: BilingualBatchInput): string {
  const {
    bookContext,
    chapterTitle,
    glossaryPromptFormatted,
    slidingContext,
    currentBatch,
    isFirstBatchOfChapter,
    rawH1,
    authorNotes
  } = input;

  const slidingText =
    slidingContext.length > 0
      ? slidingContext.map((c, i) => `[Ngữ cảnh trước ${i + 1}] ${c}`).join('\n')
      : '(Đây là đoạn mở đầu, không có ngữ cảnh trước)';

  const paragraphsFormatted = currentBatch
    .map((p) => `[p_idx=${p.idx}] ${p.text}`)
    .join('\n');

  let authorNotesSection = '';
  if (authorNotes && authorNotes.length > 0) {
    authorNotesSection = `\nDANH SÁCH CHÚ THÍCH TÁC GIẢ GỐC CẦN DỊCH:\n` +
      authorNotes.map((fn) => `[fn_${fn.num}] ${fn.text}`).join('\n');
  }

  let h1Instruction = '';
  if (isFirstBatchOfChapter && rawH1) {
    h1Instruction = `\n- Tiêu đề chương gốc: "${rawH1}". Hãy dịch tiêu đề chương này sang tiếng Việt ngắn gọn, trang trọng trong trường "h1Vi".`;
  }

  return `Bạn là một dịch giả sách xuất sắc và chuyên gia văn học chuyển ngữ Anh - Việt.
THÔNG TIN CUỐN SÁCH:
- Tựa sách: "${bookContext.bookTitle}" (Tựa gốc: "${bookContext.originalTitle}")
- Thể loại: ${bookContext.genre || 'Sách tổng hợp'}
- Giọng văn: ${bookContext.tone || 'Văn phong tự nhiên, chuẩn mực, truyền cảm hứng'}
- Đại từ nhân xưng: Tác giả tự xưng là "${bookContext.pronouns?.author || 'tôi'}", gọi độc giả là "${bookContext.pronouns?.reader || 'bạn'}".
- Tóm tắt cốt lõi: ${bookContext.summary || ''}
${chapterTitle ? `- Chương hiện tại: "${chapterTitle}"` : ''}

${glossaryPromptFormatted ? `${glossaryPromptFormatted}\n` : ''}
BỐI CẢNH 1-2 ĐOẠN LIỀN TRƯỚC (CHỈ ĐỂ THAM KHẢO NGỮ CẢNH, KHÔNG DỊCH LẠI):
${slidingText}

CÁC ĐOẠN VĂN CẦN DỊCH (BẮT BUỘC ÁNH XẠ CHÍNH XÁC 1:1 THEO p_idx):
${paragraphsFormatted}
${authorNotesSection}

YÊU CẦU DỊCH THUẬT:
1. Dịch văn học thoát ý, trôi chảy, giàu sức biểu cảm nhưng tuyệt đối trung thực với ý đồ của tác giả.
2. TUYỆT ĐỐI TUÂN THỦ bảng thuật ngữ và danh sách từ không dịch (Do Not Translate) ở trên.
3. Ánh xạ 1:1 đầy đủ: Mỗi [p_idx=...] đầu vào phải có đúng 1 phần tử trong mảng "translatedParagraphs" với cùng "idx". Không gộp đoạn, không bỏ sót bất kỳ đoạn nào.
4. Nếu trong đoạn gốc có ký hiệu chú thích số của tác giả như [1], [2], hãy giữ nguyên vị trí trong câu dịch tiếng Việt.
5. Nếu trong đoạn văn có phát hiện THUẬT NGỮ CHUYÊN NGÀNH MỚI (chưa có trong glossary) xuất hiện kèm định nghĩa rõ ràng, hãy trả về trong "newTerms" dạng: { "Tên tiếng Anh": "Bản dịch tiếng Việt" } để hệ thống bổ sung vào từ điển chung.
6. CHUẨN XÁC CHÍNH TẢ & TỪ VỰNG TIẾNG VIỆT 100%: Tuyệt đối không để xảy ra lỗi dính token, lỗi ghép dính từ tiếng Anh vào giữa từ tiếng Việt (ví dụ: nghiêm cấm các từ dị dạng như 'niềmisOn', 'hạphúcThe', 'tiềmis'). Mọi câu dịch phải là tiếng Việt chuẩn mực, mạch lạc, tự nhiên.
${h1Instruction}

TRẢ VỀ KẾT QUẢ DƯỚI ĐỊNH DẠNG JSON THUẦN TUÝ:
{
  ${isFirstBatchOfChapter && rawH1 ? '"h1Vi": "Tiêu đề tiếng Việt",' : ''}
  "translatedParagraphs": [
    {
      "idx": 0,
      "text": "Bản dịch tiếng Việt của đoạn idx 0"
    }
  ],
  ${authorNotes && authorNotes.length > 0 ? '"authorFootnotes": [{ "num": "1", "textVi": "Bản dịch chú thích tác giả" }],' : ''}
  "newTerms": {},
  "batchSummary": "Tóm tắt 1-2 câu ý chính của khối văn bản này để làm ngữ cảnh nối tiếp."
}
`;
}
