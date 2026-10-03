# AI-Powered EPUB Editor

Công cụ tự động hoá chỉnh sửa và nâng cấp file sách EPUB bằng **Google Gemini AI** và **Node.js/TypeScript**:
- **Chuẩn hoá H1:** Tự động phát hiện và sửa các thẻ tiêu đề chương bị gắn nhầm (ví dụ: `<h4>`, `<h3>` hoặc `<p class="...">` do Calibre convert), xử lý gộp tiêu đề phân mảnh và xoá thẻ lặp lại.
- **Bổ sung Heading 2 & Heading 3:** AI đọc ngữ cảnh từng chương để nhận diện hoặc chèn các phân mục `<h2>` và `<h3>` logic.
- **Sửa lỗi chính tả:** Chế độ strict correction cho tiếng Việt hiện đại (lỗi gõ phím, lỗi dấu thanh, telex/vni) mà không làm biến đổi văn phong hay từ vựng của tác giả.
- **Xử lý Chú thích (EPUB 3 Pop-up Footnotes):** Tự động nhận diện chú thích text thuần (`[1]`, `[*]`), liên kết hai chiều, khôi phục link gãy và nâng cấp sang chuẩn Pop-up Card (tương thích Kindle, Apple Books, Kobo) **ngay trong cùng một lần gọi Gemini API** (không tốn thêm quota).
- **Đồng bộ Table of Contents (TOC) đa cấp:** Tái tạo mục lục cây 3 cấp (`H1` -> `H2` -> `H3`) cho cả **EPUB 3** (`nav.xhtml`) và **EPUB 2** (`toc.ncx`).
- **Bảo toàn 100% XHTML:** Thao tác trên DOM nội bộ (Cheerio XML mode) thay vì để AI sinh lại raw HTML, bảo vệ toàn bộ class CSS và layout.
- **Đóng gói chuẩn IDPF:** Đảm bảo file `mimetype` nằm ở byte đầu tiên, không nén (STORE), tương thích hoàn hảo với Kindle, Apple Books, Kobo, v.v.

---

## Cài đặt

1. Đảm bảo đã cài đặt Node.js (khuyến nghị v20+) và `pnpm`.
2. Cài đặt dependencies:
   ```bash
   pnpm install
   ```
3. Cấu hình Gemini API Key:
   - Tạo file `.env` từ `.env.example`:
     ```bash
     cp .env.example .env
     ```
   - Điền API Key của bạn vào `.env`:
     ```env
     GEMINI_API_KEY=AIzaSy...
     GEMINI_MODEL=gemini-2.5-flash
     ```

## Cấu trúc thư mục dự án

```text
edit-epub/
├── input/                    # 👉 Nơi đặt các file EPUB đầu vào
├── output/                   # 🚀 Nơi xuất các file EPUB hoàn thiện sau khi pack
├── workspace/                # 📂 Thư mục làm việc giải nén (có Git tracking riêng để xem diff)
├── src/                      # Mã nguồn công cụ
├── .env                      # Cấu hình GEMINI_API_KEY
└── package.json
```

---

## Quy trình làm việc chuẩn (Khuyến nghị với Git Diff Review)

Sơ đồ tổng quan quy trình từng bước:

```text
[input/*.epub] 
       │
       ▼ (Bước 1: pnpm run unpack)
 [./workspace/]  <── Tự động tạo Git commit gốc ban đầu
       │
       ▼ (Bước 2: pnpm start --no-pack) [1 Lệnh duy nhất]
 [AI Xử lý]      <── Chuẩn hoá H1 + Chèn H2/H3 + Sửa chính tả + Pop-up Chú thích + Tái tạo TOC
       │             (Call Gemini API cùng nhau, không trùng lặp API hay tốn thêm quota)
       │
       ▼ (Bước 3: git -C workspace diff)
 [Duyệt Git Diff] <── Xem trực quan 2 cột trên VS Code, sửa tay nếu cần
       │
       ▼ (Bước 4: pnpm run pack)
[output/*_edited.epub] <── Đóng gói chuẩn IDPF hoàn thiện
```

---

### Bước 1: Đặt file sách vào thư mục `input/` và giải nén (Unpack)
- Bạn có thể đặt một hoặc nhiều file `.epub` vào thư mục `./input/`.
- Chạy lệnh giải nén với nhiều cách linh hoạt:
  ```bash
  # Cách 1: Menu tương tác (khi có nhiều file, script hiển thị danh sách 1, 2, 3... để chọn)
  pnpm run unpack

  # Cách 2: Chọn nhanh theo số thứ tự (1-based index)
  pnpm run unpack 2

  # Cách 3: Tìm kiếm theo từ khoá hoặc tên sách (không phân biệt hoa thường, không cần gõ dấu)
  pnpm run unpack "Dan Koe"
  pnpm run unpack minh
  pnpm run unpack -i 2
  ```
  *(Script sẽ giải nén file đã chọn vào `./workspace/` và tự động khởi tạo commit Git gốc ban đầu).*

---

### Bước 2: Chạy xử lý toàn diện qua 1 lệnh duy nhất (`pnpm start`)
Lệnh `pnpm start` thực hiện đồng thời:
1. Chuẩn hoá tiêu đề H1
2. Phân tích & chèn phân mục H2/H3
3. Sửa lỗi chính tả
4. Nhận diện & chuyển đổi Chú thích sang chuẩn EPUB 3 Pop-up
5. Tái tạo TOC đa cấp (NCX, NAV, Inline TOC)

**Tất cả nội dung H1, H2/H3, chính tả và chú thích đều được phân tích trong cùng một lượt gọi Gemini API**, không bị gọi 2 lần, tiết kiệm tối đa quota và thời gian.

```bash
# Xử lý toàn bộ sách (giữ nguyên trên đĩa để duyệt qua Git, chưa đóng gói vội):
pnpm start --no-pack

# Hoặc chạy thử nghiệm 1-2 chương đầu:
pnpm start --limit 2 --no-pack

# Các tuỳ chọn bổ sung:
#   --no-footnote              : Bỏ qua xử lý chú thích nếu muốn giữ nguyên
#   --renumber-footnotes [style]: Đánh số lại thứ tự chú thích toàn sách ("bracket", "star", "number")
```

---

### Tiện ích độc lập (Khi cần chạy riêng lẻ)
- **Menu Chú thích chuyên sâu (kiểm định, đánh số lại, popup độc lập):**
  ```bash
  pnpm run footnote
  ```
- **Đồng bộ lại Mục lục (nếu có chỉnh sửa thủ công tiêu đề chương):**
  ```bash
  pnpm run toc
  ```

---

### Bước 4: Duyệt lại các thay đổi qua Git (Review Diff)
Bạn có thể kiểm tra trực quan tất cả các dòng AI và công cụ đã thêm/bớt/sửa:
```bash
# Xem tóm tắt danh sách file và số dòng thay đổi:
git -C workspace status
git -C workspace diff --stat

# Xem chi tiết từng dòng diff (màu xanh là dòng mới, đỏ là dòng cũ):
git -C workspace diff

# Hoàn tác 1 chương nếu muốn giữ nguyên bản gốc:
git -C workspace checkout -- article.html
```
> **Mẹo hữu ích:** 
> - Bạn có thể mở trực tiếp thư mục `workspace/` trong VS Code / IDE. Mở tab **Source Control (Git)** để duyệt so sánh 2 cột (side-by-side) cực kỳ trực quan, dễ dàng sửa tay hoặc hoàn tác từng file.

---

### Bước 5: Đóng gói lại thành EPUB hoàn thiện (Pack)
Sau khi đã hoàn toàn hài lòng với tất cả các thay đổi:
```bash
pnpm run pack
```
*File xuất ra sẽ tự động được lưu vào thư mục `./output/` đúng theo tên file gốc đã giải nén (ví dụ: `output/Huong_Dan_Kich_Hoat_Su_Tap_Trung_edited.epub`).*

---

## Chạy 1 bước tự động (All-in-one)
Nếu không cần duyệt thủ công từng bước, bạn có thể chạy trực tiếp:
```bash
# Chọn file cụ thể theo số thứ tự hoặc từ khoá:
pnpm start -i 2
pnpm start -i "Dan Koe"
pnpm start -i minh

# Hoặc chạy trực tiếp (script sẽ hiển thị danh sách file để bạn chọn nếu workspace trống hoặc khi dùng --fresh):
pnpm start
pnpm start --fresh
```

---

## Kiểm tra cấu trúc sách (Inspect)
Để xem trước số lượng chương, thẻ tiêu đề và cấu trúc của bất kỳ file nào trong `input/`:
```bash
pnpm run inspect         # Hiện danh sách file trong input/ để chọn
pnpm run inspect 2       # Kiểm tra file số 2
pnpm run inspect "Dan"   # Kiểm tra theo từ khoá
```

---

## Kiểm định & Chuẩn hoá Chú thích (Footnotes / Endnotes)
Quản lý, kiểm tra tính toàn vẹn của liên kết hai chiều giữa bài viết và danh sách chú thích, tự động sửa link gãy và nâng cấp hiển thị dạng Pop-up chuẩn **EPUB 3** (tương thích Kindle, Apple Books, Kobo):

```bash
# Chạy 1 lệnh duy nhất với Menu tương tác [1-5]:
pnpm run footnote
```

Khi chạy lệnh, hệ thống sẽ in bảng tình trạng chú thích và hiển thị menu để bạn chọn:
```text
======================================================
👉 BẠN MUỐN THỰC HIỆN HÀNH ĐỘNG GÌ?
   [1] ✨ Toàn diện: Nâng cấp Pop-up EPUB 3 + Tự động sửa liên kết (Khuyến nghị)
   [2] 🚀 Nâng cấp Pop-up EPUB 3 (hiển thị popup card tại chỗ cho Kindle / Apple Books / Kobo)
   [3] 🔧 Tự động sửa liên kết bị gãy & khôi phục anchor ID
   [4] 🔢 Đánh số lại thứ tự chú thích liên tục ([1], [2], [3]...)
   [5] 🔍 Chỉ kiểm tra, giữ nguyên file
======================================================
```

*(Tuỳ chọn) Chạy trực tiếp không cần hỏi qua cờ CLI:*
```bash
pnpm run footnote --all      # Tự động thực hiện [1] (Nâng cấp Pop-up + Sửa link)
pnpm run footnote --check    # Chỉ kiểm tra và in báo cáo [5]
```

---

## Các tùy chọn dòng lệnh (CLI Options)

| Tham số | Mô tả | Mặc định |
|---|---|---|
| `-i, --input <query>` | Số thứ tự [1-N], tên file, từ khoá hoặc đường dẫn file trong `input/` | Hiển thị menu chọn hoặc tự nhận diện |
| `-o, --output <path>` | File EPUB đầu ra | `<tên_gốc>_edited.epub` |
| `-d, --dir <path>` | Thư mục làm việc giải nén (có Git tracking) | `./workspace` |
| `-k, --api-key <key>` | Gemini API Key | Đọc từ `.env` |
| `-m, --model <model>` | Tên model Gemini | `gemini-3.6-flash` |
| `--start <n>` | Bắt đầu từ chương thứ `n` (1-indexed) | `1` |
| `--limit <n>` | Chỉ xử lý tối đa `n` chương | Toàn bộ chương |
| `--dry-run` | Chạy thử nghiệm in log, không ghi file | `false` |
| `--fresh` | Bắt buộc giải nén lại từ file EPUB gốc | `false` |
| `--no-pack` | Không tự động đóng gói, giữ nguyên workspace để duyệt Git | `false` |
| `--delay <ms>` | Thời gian nghỉ giữa các chương để tránh rate limit | `2000` (2 giây) |
