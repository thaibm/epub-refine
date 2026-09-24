import type { TopElementInfo, ParagraphInfo } from '../core/domProcessor.js';

export function buildChapterPrompt(
  bookTitle: string,
  chapterFileName: string,
  topElements: TopElementInfo[],
  paragraphs: ParagraphInfo[]
): string {
  const topElementsFormatted = topElements
    .map((e) => `[Index ${e.index}] <${e.tagName}${e.id ? ` id="${e.id}"` : ''}${e.className ? ` class="${e.className}"` : ''}>: "${e.text}"`)
    .join('\n');

  // Rút gọn các đoạn văn nhưng giữ nguyên chỉ số idx
  const paragraphsFormatted = paragraphs
    .map((p) => `[p_idx=${p.idx}] ${p.text}`)
    .join('\n');

  return `Bạn là một chuyên gia biên tập sách và xuất bản EPUB tiếng Việt chuyên nghiệp.
Cuốn sách đang xử lý: "${bookTitle}"
Tập tin chương: "${chapterFileName}"

Nhiệm vụ của bạn gồm 3 phần:

1. CHUẨN HOÁ TIÊU ĐỀ CHƯƠNG (H1):
Quan sát các phần tử đầu trang dưới đây:
${topElementsFormatted}

- Rất nhiều sách bị lỗi gắn nhầm thẻ tiêu đề thành <h4>, <h3> hoặc <p>, hoặc bị lặp lại/phân mảnh (ví dụ 1 dòng là "Thói Quen Thứ 1", dòng sau lặp lại "THÓI QUEN THỨ 1", dòng thứ 3 là "Chấp nhận toàn bộ con người mình").
- Hãy xác định tiêu đề H1 ĐẦY ĐỦ, CHÍNH XÁC của chương này (Ví dụ: "Thói Quen Thứ 1: Chấp nhận toàn bộ con người mình").
- Liệt kê các chỉ số (Index) trong topElements cần loại bỏ/thay thế vì bị lặp lại hoặc rác.

2. PHÂN TÍCH VÀ BỔ SUNG HEADING 2 (<h2>) VÀ HEADING 3 (<h3>):
Đọc toàn bộ nội dung các đoạn văn sau:
${paragraphsFormatted}

- Rất nhiều tiểu mục trong sách bị định dạng nhầm thành thẻ <p> thường (ví dụ: các dòng bắt đầu bằng "1. ...", "2. ...", "a. ...", "b. ...", "Phương pháp...", "Thói quen thứ...", hoặc các phần phân đoạn quan trọng).
- Hãy xác định các tiêu đề H2 (mục lớn trong chương) và H3 (tiểu mục con trong H2).
- Với mỗi heading, chỉ định:
  + "tag": "h2" hoặc "h3"
  + "title": Tiêu đề sạch sẽ, chuẩn xác
  + "insertBeforeIdx": Chỉ số p_idx của đoạn văn đó (nếu đoạn đó chính là tiêu đề, hoặc vị trí cần đặt heading ngay trước đoạn đó).

3. SỬA LỖI CHÍNH TẢ / GÕ PHÍM (SPELLING & TYPO FIXES):
- Rà soát các lỗi gõ sai dấu, lỗi Telex/VNI trong tiếng Việt (ví dụ: "cuộc sông" -> "cuộc sống", "nổ lực" -> "nỗ lực", "vủa bạn" -> "của bạn", "hiên tại" -> "hiện tại", "bản thân minh" -> "bản thân mình").
- QUY TẮC CỰC KỲ QUAN TRỌNG:
  + CHỈ sửa lỗi chính tả thật sự.
  + TUYỆT ĐỐI KHÔNG viết lại văn phong, KHÔNG tóm tắt hay cắt bớt câu.
  + Giữ nguyên các thuật ngữ tiếng Anh, tên riêng (Ichiro, Oscar Wilde, SMAP, Alderfer,...).
  + Mỗi lỗi chỉ ra chính xác p_idx, từ gốc (original) và từ đã sửa (fixed).

HÃY TRẢ VỀ KẾT QUẢ DƯỚI ĐỊNH DẠNG JSON HỢP LỆ VỚI CẤU TRÚC SAU:
{
  "h1": {
    "title": "Tên chương chuẩn",
    "removeTopIndices": [0, 1, 2]
  },
  "headings": [
    {
      "tag": "h2",
      "title": "1. Không phải \\"khoảng cách\\" mà là \\"sự khác biệt\\"",
      "insertBeforeIdx": 4
    },
    {
      "tag": "h3",
      "title": "a. Tìm ra \\"cá tính\\" của riêng mình",
      "insertBeforeIdx": 10
    }
  ],
  "spellingFixes": [
    {
      "idx": 2,
      "original": "cuộc sông",
      "fixed": "cuộc sống",
      "reason": "lỗi gõ dấu"
    }
  ]
}
`;
}
