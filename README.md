# AI-Powered EPUB Editor

Công cụ tự động hoá chỉnh sửa và nâng cấp toàn diện file sách EPUB bằng **Google Gemini AI** và **Node.js/TypeScript**:

- 📄 **Trích xuất PDF sang EPUB chuẩn (Tách riêng luồng):** Hỗ trợ cả sách quét (**Scan PDF** qua Apple Vision OCR native trên macOS) và văn bản số (**Docs PDF** qua PDF.js vector layer). Tự động lọc sạch running headers, running footers, số trang và reflow đoạn văn thông minh. **Tách riêng hoàn toàn khỏi luồng AI**: khi chạy PDF chỉ thuần túy trích xuất nội dung gốc vào workspace và tạo Git commit ban đầu, chưa sửa chính tả hay chèn heading để bạn toàn quyền kiểm soát.
- 📑 **Tự động Gộp Phần => Chương (Part Merger):** Với những sách có cấu trúc nhiều phần (Phần 1, Phần 2...) và bên trong gồm nhiều chương, hệ thống tự động gom các chương con vào file Phần tương ứng. Giúp giảm từ hàng trăm file xuống chỉ còn vài file (tiết kiệm **~96% số request Gemini API**, tránh hoàn toàn lỗi RPM rate limit), đồng thời giữ nguyên ngắt trang trang trọng và mục lục phân cấp chuẩn (`H1 Phần` ➔ `H2 Chương`).
- 🏷️ **Chuẩn hoá H1:** Tự động phát hiện và sửa các thẻ tiêu đề chương bị gắn nhầm (ví dụ: `<h4>`, `<h3>` hoặc `<p class="...">` do Calibre convert), xử lý gộp tiêu đề phân mảnh và xoá thẻ lặp lại.
- 🌳 **Bổ sung Heading 2 & Heading 3:** AI đọc ngữ cảnh từng chương để nhận diện hoặc chèn các phân mục `<h2>` và `<h3>` logic.
- ✍️ **Sửa lỗi chính tả:** Chế độ strict correction cho tiếng Việt hiện đại (lỗi gõ phím, lỗi dấu thanh, telex/vni) mà không làm biến đổi văn phong hay từ vựng của tác giả.
- 💬 **Xử lý Chú thích (EPUB 3 Pop-up Footnotes):** Tự động nhận diện chú thích text thuần (`[1]`, `[*]`), liên kết hai chiều, khôi phục link gãy và nâng cấp sang chuẩn Pop-up Card (tương thích Kindle, Apple Books, Kobo) **ngay trong cùng một lần gọi Gemini API** (không tốn thêm quota).
- 🧭 **Đồng bộ Table of Contents (TOC) đa cấp:** Tái tạo mục lục cây 3 cấp (`H1` -> `H2` -> `H3`) cho cả **EPUB 3** (`nav.xhtml`), **EPUB 2** (`toc.ncx`) và trang đọc trực tiếp trong sách (**Inline TOC**).
- 🛡️ **Bảo toàn 100% XHTML:** Thao tác trên DOM nội bộ (Cheerio XML mode) thay vì để AI sinh lại raw HTML, bảo vệ toàn bộ class CSS và layout.
- 📦 **Đóng gói chuẩn IDPF:** Đảm bảo file `mimetype` nằm ở byte đầu tiên, không nén (STORE), tương thích hoàn hảo với Kindle, Apple Books, Kobo, v.v.

---

## ⚡ Hướng dẫn nhanh (TL;DR)

Hệ thống hỗ trợ 2 luồng xử lý riêng biệt:

### 🅰️ Luồng 1: Xử lý từ sách PDF (`.pdf` ➔ `.epub`)
Quy trình được **tách riêng làm 2 giai đoạn** để đảm bảo tính minh bạch:
```bash
# 1. Trích xuất nội dung thuần túy từ PDF vào workspace (cực nhanh, không tốn quota AI)
pnpm run pdf

# 2. Dùng AI biên tập chuyên sâu (chuẩn hoá H1, chèn H2/H3, sửa chính tả, chú thích & TOC)
pnpm start --no-pack

# 3. Xem chi tiết các điểm AI đã sửa so với bản gốc PDF và đóng gói thành phẩm
git -C workspace diff
pnpm run pack
```

### 🅱️ Luồng 2: Xử lý từ file EPUB có sẵn (`.epub` ➔ `.epub`)
```bash
# 1. Giải nén sách vào workspace để xử lý
pnpm run unpack

# 2. Xử lý toàn diện bằng AI (mặc định KHÔNG đóng gói để bạn kiểm tra Git diff)
pnpm start

# 3. Xem các thay đổi qua Git và đóng gói file EPUB hoàn thiện
git -C workspace diff --stat
pnpm run pack
```

*(Hoặc nếu muốn xử lý xong tự động đóng gói luôn ra file EPUB, chỉ cần thêm cờ `--pack`: `pnpm start --pack`)*

---

## Cài đặt & Cấu hình

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
   - Điền API Key của bạn vào `.env` (lấy tại [Google AI Studio](https://aistudio.google.com/)):
     ```env
     GEMINI_API_KEY=AIzaSy...
     GEMINI_MODEL=gemini-2.5-flash
     ```

## Cấu trúc thư mục dự án

```text
edit-epub/
├── input/                    # 👉 Nơi đặt các file sách đầu vào (.epub hoặc .pdf)
├── output/                   # 🚀 Nơi xuất các file EPUB hoàn thiện sau khi pack
├── workspace/                # 📂 Thư mục làm việc giải nén (có Git tracking riêng để xem diff)
├── src/                      # Mã nguồn công cụ
├── .env                      # Cấu hình GEMINI_API_KEY, GEMINI_MODEL
└── package.json
```

---

## Quy trình làm việc chuẩn (Khuyến nghị với Git Diff Review)

Sơ đồ tổng quan quy trình 2 luồng đầu vào:

```text
  [input/*.pdf]                          [input/*.epub]
        │                                      │
        ▼ (pnpm run pdf)                       ▼ (pnpm run unpack)
┌────────────────────────────────────────────────────────┐
│                      ./workspace/                      │
│        <── Tự động tạo Git commit gốc ban đầu ──>      │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (pnpm start --no-pack)
┌────────────────────────────────────────────────────────┐
│                   AI Xử Lý Toàn Diện                   │
│  - Chuẩn hoá H1                                        │
│  - Bổ sung H2, H3 theo ngữ cảnh                       │
│  - Sửa lỗi chính tả & lỗi OCR                         │
│  - Chuyển đổi Pop-up Chú thích EPUB 3                  │
│  - Tái tạo Mục lục (TOC) đa cấp NCX & NAV             │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (git -C workspace diff)
┌────────────────────────────────────────────────────────┐
│                    Duyệt Git Diff                      │
│   <── So sánh 2 cột trực quan: Bản gốc vs Bản sửa ──> │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (pnpm run pack)
                 [output/*_edited.epub]
```

---

### Bước 1: Đặt file sách vào thư mục `input/` và giải nén (Unpack)
- Bạn có thể đặt một hoặc nhiều file `.epub` vào thư mục `./input/`.
- Chạy lệnh giải nén với nhiều cách linh hoạt:
  ```bash
  # Cách 1: Menu tương tác (khi có nhiều file, script hiển thị danh sách 1, 2, 3... để chọn)
  pnpm run unpack

  # Cách 2: Chọn nhanh theo số thứ tự (1-based index)
  pnpm run unpack 1

  # Cách 3: Tìm kiếm theo từ khoá hoặc tên sách (không phân biệt hoa thường, không cần gõ dấu)
  pnpm run unpack "Anna Karenina"
  pnpm run unpack tolkien
  pnpm run unpack -i 2
  ```
  *(Script sẽ giải nén file đã chọn vào `./workspace/` và tự động khởi tạo commit Git gốc ban đầu).*

---

### Bước 2: Chạy xử lý toàn diện qua 1 lệnh (`pnpm start`)
Lệnh `pnpm start` thực hiện tuần tự và tự động:
1. **Tự động Gộp Phần => Chương:** Nếu sách gồm nhiều Phần và mỗi phần chứa nhiều chương con, hệ thống sẽ gom thông minh về 1 file/phần (ví dụ: từ 238 file xuống 9 file).
2. **Chuẩn hoá tiêu đề H1:** Đặt đúng tên Phần hoặc tên Chương cho thẻ Heading cấp cao nhất.
3. **Phân tích & chèn phân mục H2/H3:** Nhận diện các chương con hoặc phân mục bên trong.
4. **Sửa lỗi chính tả:** Khắc phục lỗi gõ phím tiếng Việt hiện đại theo ngữ cảnh.
5. **Nhận diện & chuyển đổi Chú thích:** Tự động tạo liên kết hai chiều và Pop-up card EPUB 3.
6. **Tái tạo Mục lục TOC đa cấp:** Đồng bộ `toc.ncx` (EPUB 2), `nav.xhtml` (EPUB 3) và trang Inline TOC đọc trực tiếp trong sách.

**Tất cả nội dung H1, H2/H3, chính tả và chú thích đều được phân tích trong cùng một lượt gọi Gemini API**, không bị gọi 2 lần, tiết kiệm tối đa quota và thời gian.

```bash
# Cách 1 (Mặc định): Xử lý toàn bộ sách và giữ nguyên workspace để bạn duyệt Git diff
pnpm start

# Cách 2: Tự động đóng gói luôn thành file EPUB trong output/ sau khi xử lý xong
pnpm start --pack

# Cách 3: Chạy thử nghiệm 1-2 chương đầu để xem chất lượng
pnpm start --limit 2

# Cách 4: Bắt đầu từ chương thứ N
pnpm start --start 5 --limit 3

# Cách 5: Gộp các chương con theo từng phần (khi sách có Phần I gồm Chương 1, 2, 3...)
pnpm start --merge-parts

# Cách 6: Phân tách các file XHTML chứa nhiều chương nằm chung thành file độc lập
pnpm start --split
```

---

### Bước 3: Duyệt lại các thay đổi qua Git (Review Diff)
Bạn có thể kiểm tra trực quan tất cả các dòng AI và công cụ đã thêm/bớt/sửa:
```bash
# Xem tóm tắt danh sách file và số dòng thay đổi:
git -C workspace status
git -C workspace diff --stat

# Xem chi tiết từng dòng diff trên terminal (màu xanh là thêm mới, đỏ là xoá):
git -C workspace diff

# Hoàn tác 1 file nếu muốn giữ nguyên bản gốc:
git -C workspace checkout -- OEBPS/Chapter0001.html

# Hoàn tác toàn bộ thay đổi để trở về bản gốc lúc unpack:
git -C workspace checkout .
```
> 💡 **Mẹo xem trực quan trên VS Code / Cursor:**
> Bạn chỉ cần mở thư mục `./workspace/` trong IDE và bấm vào tab **Source Control (Git)** (phím tắt `Ctrl + Shift + G` hoặc `Cmd + Shift + G`). IDE sẽ hiển thị giao diện so sánh 2 cột (side-by-side) cực kỳ đẹp mắt, cho phép bạn chỉnh sửa thủ công trực tiếp nếu muốn.

---

### Bước 4: Đóng gói lại thành EPUB hoàn thiện (Pack)
Sau khi đã hoàn toàn hài lòng với tất cả các thay đổi trong `workspace/`:
```bash
pnpm run pack
```
*File xuất ra sẽ tự động được lưu vào thư mục `./output/` đúng theo tên file gốc đã giải nén (ví dụ: `output/AK-LTT_edited.epub`).*

---

## 🔬 Chi tiết Cơ chế Tự động Gộp Phần => Chương (Part Merger)

Đối với các bộ tiểu thuyết, trường ca hoặc sách dày kinh điển (như *Anna Karenina*, *Chiến tranh và Hòa bình*, *Chúa tể những chiếc nhẫn*...), sách thường được cấu trúc thành:
**Phần 1, Phần 2...** và trong mỗi phần có **hàng chục chương nhỏ** (`Chương 1`, `Chương 2`...):

### 1. Vấn đề của các file EPUB thông thường
- Các file EPUB từ Calibre hoặc nguồn tải về thường bị cắt nhỏ mỗi chương thành 1 file XHTML riêng biệt (`Chapter0001.html` đến `Chapter0236.html`).
- Khi chạy xử lý AI, hệ thống phải thực hiện hàng trăm request riêng lẻ (236 request), liên tục chạm giới hạn phút (**RPM Rate Limit** - phải dừng chờ 56s), tốn rất nhiều thời gian và quota API.
- Cấu trúc Mục lục (TOC) bị phẳng hoá: mọi chương đều trở thành Level 1 ngang hàng nhau, mất hẳn phân cấp Phần - Chương.

### 2. Cách hệ thống tự động xử lý
Khi phát hiện sách có từ 2 Phần trở lên và mỗi phần gồm nhiều chương:
1. **Tự động bảo toàn Lời mở đầu / Lời tựa:** Nếu file đầu tiên có "Lời giới thiệu" hoặc "Lời tựa" trước khi vào Phần 1 (như trong `Chapter0001.html`), hệ thống tự động trích xuất thành file độc lập `Chapter0001_intro.html` với tiêu đề H1 chuẩn.
2. **Gộp thông minh theo Phần:** Gom toàn bộ các file chương con thuộc cùng một Phần vào file đầu tiên của Phần đó (`Chapter0001.html` cho Phần 1, `Chapter0034.html` cho Phần 2...).
3. **Chuẩn hoá Heading phân cấp:**
   - Tiêu đề Phần trở thành `<h1 class="chapter-h1">` (Level 1).
   - Tiêu đề các chương con trở thành `<h2 class="chapter-h2">` (Level 2).
   - Các tiểu mục con bên trong chương là `<h3 class="section-h3">` (Level 3).
4. **Chèn ngắt trang chuẩn EPUB:** Giữa các chương tự động chèn `<div class="chapter-break"></div>` (với CSS `page-break-before: always; break-before: page;`) giúp khi đọc trên máy đọc sách (Kindle, Kobo, Apple Books), mỗi chương vẫn mở đầu ở một trang màn hình mới trang trọng.
5. **Đồng bộ liên kết & Mục lục:** Tự động remap toàn bộ liên kết nội bộ, thẻ chú thích và cập nhật manifest/spine trong `content.opf`. Cây Mục lục (TOC) được tạo theo đúng thứ tự phân nhánh:
   ```text
   ▼ Lời giới thiệu (H1)
   ▼ Phần 1 (H1)
       ├── Chương 1 (H2)
       ├── Chương 2 (H2)
       └── ...
   ▼ Phần 2 (H1)
       ├── Chương 1 (H2)
       └── ...
   ```
6. **Tiết kiệm vượt trội:** Giảm từ **238 file xuống còn 9 file** ➔ **Tiết kiệm ~96% request Gemini API**, xử lý nhanh hơn gấp nhiều lần và hoàn toàn không bị gián đoạn do lỗi nghẽn RPM!

> 💡 **Muốn tắt tính năng này?** Nếu bạn muốn giữ nguyên mỗi chương là 1 file tách rời như cũ:
> ```bash
> pnpm start --no-merge-parts
> ```

---

## 📄 Luồng Chuyển Đổi Sách PDF (`pnpm run pdf`)

Khác với các công cụ thông thường gộp chung OCR và AI biên tập làm một, `edit-epub` **tách riêng hoàn toàn 2 luồng**:
1. **Lệnh `pnpm run pdf`:** Chỉ làm một nhiệm vụ duy nhất là **thuần túy trích xuất nội dung nguyên bản** từ file PDF sang cấu trúc EPUB workspace.
   - ⚡ **Không gọi Gemini AI:** Chạy cực nhanh, không tiêu tốn quota API.
   - 🔒 **Bảo toàn 100% chữ nghĩa gốc:** Chưa sửa chính tả, chưa chèn heading H2/H3 phỏng đoán.
   - 📸 **Hỗ trợ Scan PDF:** Kích hoạt Apple Vision OCR native trên macOS (ngôn ngữ `vi-VT`) với độ chính xác cao và tốc độ vượt trội.
   - 📑 **Hỗ trợ Docs PDF:** Trích xuất text vector layer và toạ độ font qua PDF.js.
   - 🧹 **Lọc rác trang thông minh:** Tự động phát hiện và loại bỏ running headers, running footers, và các định dạng số trang lặp lại ở đầu/chân trang.
   - 🧩 **Smart Paragraph Reflow:** Tự động nối các từ bị đứt quãng bởi dấu gạch nối cuối dòng (`nông-` + `nghiệp` ➔ `nông nghiệp`), nối các dòng trong cùng một đoạn văn thành một khối `<p>` liền mạch và giữ ngắt đoạn tự nhiên khi hết câu.
   - 🏷️ **Nhận diện tiêu đề chương tự nhiên (H1):** Thuật toán tự động phát hiện các dòng tiêu đề chương/phần (theo pattern *Chương*, *Phần*, *Tựa*, *Lời mở đầu*, số La Mã *I.*, *II.*...) để phân tách thành các file `part0001.xhtml`, `part0002.xhtml`... trong workspace.
   - 🌱 **Git commit gốc:** Tự động khởi tạo commit đầu tiên trong workspace: `"Original PDF extracted content"`.
2. **Lệnh `pnpm start --no-pack`:** Sau khi đã có workspace nội dung gốc, bạn mới chạy AI để biên tập chuyên sâu. Lúc này bạn có thể dùng `git -C workspace diff` để xem chi tiết từng dòng chữ AI đã sửa chữa so với bản gốc PDF.

### Cách sử dụng lệnh `pnpm run pdf`:

```bash
# 1. Menu tương tác (tự động liệt kê các file PDF có sẵn trong input/ để chọn)
pnpm run pdf

# 2. Chọn nhanh theo số thứ tự (1-based)
pnpm run pdf 1

# 3. Tìm kiếm theo từ khoá hoặc tên file PDF (không cần gõ đuôi .pdf, không phân biệt hoa thường)
pnpm run pdf "dich-kinh"
pnpm run pdf -i "dich-kinh-linh-the"

# 4. Kiểm thử nhanh N trang đầu tiên (ví dụ 10 trang)
pnpm run pdf -i dich-kinh --limit 10

# 5. Trích xuất khoảng trang cụ thể (từ trang 20 đến 50)
pnpm run pdf -i dich-kinh --start 20 --limit 30

# 6. Chỉ định ảnh bìa riêng (nếu bìa scan bị mờ hoặc muốn thay bìa mới)
pnpm run pdf -i dich-kinh --cover "./scratch/bia_dep.jpg"

# 7. Trích xuất xong tự động đóng gói luôn thành file EPUB thô
pnpm run pdf -i dich-kinh --pack
```

---

## 🛠️ Các Tiện ích Độc lập (CLI Tools)

Ngoài lệnh `pnpm start` chạy toàn diện, bạn có thể gọi riêng từng công cụ khi cần:

### 1. Menu Chú thích chuyên sâu (`pnpm run footnote`)
Quản lý, kiểm tra tính toàn vẹn của liên kết hai chiều giữa bài viết và danh sách chú thích, tự động sửa link gãy và nâng cấp hiển thị dạng Pop-up chuẩn **EPUB 3** (tương thích Kindle, Apple Books, Kobo):

```bash
pnpm run footnote
```

Hệ thống sẽ in bảng tình trạng chú thích và hiển thị menu để bạn chọn:
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

### 2. Tái tạo & Đồng bộ lại Mục lục (`pnpm run toc`)
Nếu bạn đã sửa tay tiêu đề trong `workspace/` và chỉ muốn cập nhật lại toàn bộ mục lục (NCX, NAV, Inline TOC):
```bash
pnpm run toc
```

### 3. Kiểm tra cấu trúc sách (`pnpm run inspect`)
Xem trước danh sách file, các cấp thẻ H1/H2/H3 và tình trạng chú thích hiện có trong workspace:
```bash
pnpm run inspect
```

### 4. Đóng gói thư mục làm việc (`pnpm run pack`)
Đóng gói thư mục `workspace/` thành file `.epub` chuẩn IDPF uncompressed mimetype:
```bash
pnpm run pack
```

---

## 📋 Bảng tổng hợp các tùy chọn dòng lệnh (CLI Options)

### 1. Tùy chọn cho lệnh biên tập AI (`pnpm start`)

| Tham số | Mô tả | Mặc định |
|---|---|---|
| `-i, --input <query>` | Số thứ tự [1-N], tên file, từ khoá hoặc đường dẫn file trong `input/` | Tự động nhận diện hoặc hiển thị menu chọn |
| `-o, --output <path>` | File EPUB đầu ra sau khi pack | `<tên_gốc>_edited.epub` trong `output/` |
| `-d, --dir <path>` | Thư mục làm việc giải nén (có Git tracking) | `./workspace` |
| `-k, --api-key <key>` | Gemini API Key | Đọc từ `.env` (`GEMINI_API_KEY`) |
| `-m, --model <model>` | Tên model Gemini (`gemini-2.5-flash`, `gemini-3.6-flash`, v.v.) | `gemini-3.6-flash` |
| `--start <n>` | Bắt đầu xử lý từ chương thứ `n` (1-indexed) | `1` |
| `--limit <n>` | Chỉ xử lý tối đa `n` chương (để test nhanh) | Toàn bộ chương |
| `--pack` | Tự động đóng gói file EPUB sau khi xử lý xong | `false` (mặc định giữ workspace để duyệt Git diff) |
| `--no-pack` | Không đóng gói file EPUB, giữ nguyên thư mục workspace | `true` (mặc định) |
| `--pack-only` | Chỉ đóng gói thư mục workspace thành file EPUB (sau khi đã duyệt xong) | `false` |
| `--no-merge-parts` | Không tự động gộp chương theo phần, giữ nguyên từng file riêng lẻ | `false` (mặc định tự động gộp khi có nhiều phần) |
| `--no-footnote` | Bỏ qua nhận diện và xử lý chú thích | `false` (mặc định tự động xử lý chú thích) |
| `--renumber-footnotes [style]` | Đánh số lại chú thích toàn sách (`bracket`, `star`, `number`) | Giữ nguyên kiểu đánh số gốc |
| `--dry-run` | Chạy thử nghiệm in log phân tích, không ghi file | `false` |
| `--fresh` | Bắt buộc giải nén lại từ file EPUB gốc (ghi đè workspace) | `false` |
| `--delay <ms>` | Thời gian nghỉ giữa các chương | `2000` (2 giây) |

### 2. Tùy chọn cho lệnh trích xuất PDF (`pnpm run pdf`)

| Tham số | Mô tả | Mặc định |
|---|---|---|
| `-i, --input <query>` | Số thứ tự [1-N], tên file hoặc từ khoá file PDF trong `input/` | Tự động nhận diện hoặc hiển thị menu chọn |
| `-d, --dir <path>` | Thư mục workspace xuất bản | `./workspace` |
| `-o, --output <path>` | Đường dẫn file EPUB thô xuất xưởng (nếu muốn đóng gói ngay) | `<tên_gốc>_raw.epub` trong `output/` |
| `-c, --cover <path>` | Đường dẫn ảnh bìa ngoài (thay thế nếu bìa scan bị mờ) | Tự động trích xuất trang 1 của PDF |
| `--start <number>` | Bắt đầu trích xuất từ trang thứ mấy (1-based) | `1` |
| `--limit <number>` | Giới hạn số trang trích xuất (để kiểm thử nhanh) | Toàn bộ số trang |
| `--pack` | Tự động đóng gói file EPUB thô sau khi hoàn thành workspace | `false` |


