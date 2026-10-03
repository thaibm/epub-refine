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

Nhiệm vụ của bạn gồm 4 phần (thực hiện đồng thời và toàn diện):

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
  + TUYỆT ĐỐI KHÔNG sửa, xoá hoặc lược bỏ các ký hiệu chú thích như [1], [2], [3], [*], <sup>[1]</sup> trong văn bản. Không được coi các dấu ngoặc vuông chú thích là lỗi chính tả.
  + Trong "removeTopIndices": CHỈ chỉ định xoá các dòng tiêu đề rác trùng lặp ngắn (ví dụ "Chương 1", tựa sách). TUYỆT ĐỐI KHÔNG xoá đoạn văn mở đầu của truyện chứa nội dung kể chuyện (đoạn văn dài > 60 ký tự).
  + TUYỆT ĐỐI KHÔNG viết lại văn phong, KHÔNG tóm tắt hay cắt bớt câu.
  + Giữ nguyên các thuật ngữ tiếng Anh, tên riêng (Ichiro, Oscar Wilde, SMAP, Alderfer,...).
  + Mỗi lỗi chỉ ra chính xác p_idx, từ gốc (original) và từ đã sửa (fixed).

4. NHẬN DIỆN VÀ LIÊN KẾT CHÚ THÍCH (FOOTNOTES / ENDNOTES):
Nhiều cuốn sách có phần chú thích giải nghĩa từ ngữ, điển tích, tên riêng đặt ở cuối chương (dưới tiêu đề "Chú thích:", "Notes:" hoặc các đoạn bắt đầu bằng "[1]", "[2]", "1. ...", "15 ...") và ký hiệu gọi chú thích nằm trong các đoạn văn thân bài (ví dụ "... Maecenas[1] ...", "... Trimalchio[1] ...", "[*]", "(1)").
- "footnoteStartIdx": Chỉ số p_idx bắt đầu phần chú thích ở cuối chương (nếu không có, để null).
- "items": Danh sách các cặp chú thích tìm được. Với mỗi chú thích:
  + "num": Số hoặc ký hiệu chú thích (ví dụ "1", "2", "*", "15").
  + "markerText": Ký hiệu chú thích xuất hiện trong thân bài văn bản (ví dụ "[1]", "[*]", "(1)").
  + "inTextIdx": Chỉ số p_idx của đoạn văn thân bài chứa điểm gọi chú thích.
  + "defIdx": Chỉ số p_idx của đoạn văn ở cuối chương giải thích chú thích đó.
  + "term": Thuật ngữ / từ ngữ được chú thích (nếu có, ví dụ "Maecenas", "Trimalchio").
- LƯU Ý VỀ CHÚ THÍCH:
  + Nếu chương KHÔNG có chú thích nào, trả về "footnotes": null hoặc "items": [].
  + TUYỆT ĐỐI KHÔNG gán Heading 2/3 cho các đoạn giải nghĩa chú thích ở cuối chương.
  + TUYỆT ĐỐI KHÔNG coi ký hiệu chú thích là lỗi chính tả.

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
  ],
  "footnotes": {
    "footnoteStartIdx": 157,
    "items": [
      {
        "num": "1",
        "markerText": "[1]",
        "inTextIdx": 2,
        "defIdx": 157,
        "term": "Maecenas"
      }
    ]
  }
}
`;
}
