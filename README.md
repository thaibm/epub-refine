# AI-Powered EPUB Editor

Công cụ tự động hoá chỉnh sửa và nâng cấp file sách EPUB bằng **Google Gemini AI** và **Node.js/TypeScript**:
- **Chuẩn hoá H1:** Tự động phát hiện và sửa các thẻ tiêu đề chương bị gắn nhầm (ví dụ: `<h4>`, `<h3>` hoặc `<p class="...">` do Calibre convert), xử lý gộp tiêu đề phân mảnh và xoá thẻ lặp lại.
- **Bổ sung Heading 2 & Heading 3:** AI đọc ngữ cảnh từng chương để nhận diện hoặc chèn các phân mục `<h2>` và `<h3>` logic.
- **Sửa lỗi chính tả:** Chế độ strict correction cho tiếng Việt hiện đại (lỗi gõ phím, lỗi dấu thanh, telex/vni) mà không làm biến đổi văn phong hay từ vựng của tác giả.
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

## Quy trình làm việc đề xuất (Với Git Diff Review)

### Bước 1: Đặt file sách vào thư mục `input/` và giải nén
- Bạn chỉ cần copy bất kỳ file sách nào vào thư mục `./input/` (ví dụ `input/Minh_La_Ca_Viec_Cua_Minh_La_Boi.epub`).
- Chạy lệnh giải nén:
  ```bash
  pnpm run unpack
  ```
  *(Script sẽ tự động tìm file `.epub` trong `input/`, giải nén vào `./workspace/` và tạo commit Git gốc ban đầu).*

### Bước 2: Chạy AI cập nhật trực tiếp trên thư mục
```bash
# Xử lý toàn bộ sách (vẫn giữ nguyên trên đĩa để duyệt qua Git, chưa đóng gói vội):
pnpm start --no-pack

# Hoặc chạy thử nghiệm 1-2 chương đầu:
pnpm start --limit 2 --no-pack
```

### Bước 3: Duyệt lại các thay đổi qua Git
Bạn có thể xem trực quan tất cả các dòng AI đã thêm/bớt/sửa:
```bash
# Xem tóm tắt danh sách file và số dòng thay đổi:
git -C workspace status
git -C workspace diff --stat

# Xem chi tiết từng dòng diff (màu xanh là dòng mới, đỏ là dòng cũ):
git -C workspace diff

# Xem riêng sự thay đổi của trang mục lục sách (part0001.html):
git -C workspace diff text/part0001.html
```
> **Mẹo:** 
> - Bạn có thể mở trực tiếp thư mục `workspace/` trong VS Code / IDE. Tab **Source Control (Git)** sẽ hiển thị dạng trực quan 2 cột (side-by-side) cực kỳ tiện lợi để bạn duyệt từng chương, sửa đổi thủ công nếu muốn, hoặc hoàn tác từng file (`git -C workspace checkout -- file.html`).
> - Nếu bạn muốn đồng bộ lại ngay lập tức cả **Mục lục đọc trong sách (part0001.html)**, **toc.ncx** và **nav.xhtml** mà không cần gọi AI, hãy dùng lệnh:
>   ```bash
>   pnpm run toc
>   ```

### Bước 4: Đóng gói lại thành EPUB hoàn thiện
Sau khi đã hài lòng với tất cả các thay đổi:
```bash
pnpm run pack
```
*File xuất ra sẽ tự động được lưu vào thư mục `./output/` (ví dụ: `output/Minh_La_Ca_Viec_Cua_Minh_La_Boi_edited.epub`).*

---

## Chạy 1 bước tự động (All-in-one)
Nếu không cần duyệt thủ công từng bước, bạn chỉ cần đặt sách vào `input/` và chạy:
```bash
pnpm start
```
Script sẽ tự động: đọc sách từ `input/` -> giải nén -> chạy AI cập nhật -> hiển thị tóm tắt Git diff -> đóng gói ra thư mục `output/`.

---

## Các tùy chọn dòng lệnh (CLI Options)

| Tham số | Mô tả | Mặc định |
|---|---|---|
| `-i, --input <path>` | File EPUB đầu vào | Tự động chọn file `.epub` trong thư mục |
| `-o, --output <path>` | File EPUB đầu ra | `<tên_gốc>_edited.epub` |
| `-k, --api-key <key>` | Gemini API Key | Đọc từ `.env` |
| `-m, --model <model>` | Tên model Gemini | `gemini-2.5-flash` |
| `--start <n>` | Bắt đầu từ chương thứ `n` (1-indexed) | `1` |
| `--limit <n>` | Chỉ xử lý tối đa `n` chương | Toàn bộ chương |
| `--dry-run` | Chạy thử nghiệm in log, không ghi file | `false` |
| `--delay <ms>` | Thời gian nghỉ giữa các chương để tránh rate limit | `2000` (2 giây) |
