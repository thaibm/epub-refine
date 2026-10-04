# Kế Hoạch Hợp Nhất: Unified EPUB Toolkit (`edit-epub` + `pdf-to-epub`)

> **Mục tiêu chiến lược:** Hợp nhất dự án chuyển đổi PDF vào repository [`edit-epub`](file:///Users/thaibuiminh/Projects/edit-epub) để tạo thành một bộ công cụ xuất bản toàn diện:
> 1. **`edit-epub`:** Biên tập, chuẩn hóa tiêu đề H1/H2/H3, sửa chính tả tiếng Việt, đồng bộ mục lục kép (EPUB 2/3) và nâng cấp chú thích Pop-up EPUB 3 cho sách EPUB hiện có.
> 2. **`pdf-to-epub`:** Chuyển đổi PDF (cả dạng Scan và Docs) thành sách EPUB chuẩn quốc tế, tự động kế thừa toàn bộ pipeline xử lý chất lượng cao của `edit-epub`.

---

## 1. Kiến Trúc Hợp Nhất (Unified Pipeline)

```mermaid
flowchart TD
    subgraph INPUT
        EpubIn[input/*.epub]
        PdfIn[input/*.pdf]
    end

    subgraph WORKSPACE DÙNG CHUNG (Git Diff Tracking)
        EpubIn -->|pnpm run unpack| WS[workspace/]
        PdfIn -->|pnpm run pdf| Preprocess[Tầng 1: Local Ingestion<br>Apple Vision / PDF Parser]
        Preprocess --> Structuring[Tầng 2: Gemini Batching<br>Nhận diện H1/H2, Lọc rác, Bóc Footnote]
        Structuring --> WS
    end

    subgraph CORE ENGINES CỦA EDIT-EPUB
        WS --> AI[AI Polish: Sửa lỗi chính tả & tinh chỉnh H2/H3]
        AI --> FN[Footnote Engine: EPUB 3 Pop-up Chú thích 2 chiều]
        FN --> TOC[TOC Engine: Đồng bộ nav.xhtml & toc.ncx đa cấp]
    end

    subgraph REVIEW & PACKAGING
        TOC --> Diff[Duyệt Git Diff trực quan trên VS Code]
        Diff -->|pnpm run pack| Out[output/*.epub chuẩn IDPF]
    end
```

---

## 2. Các Lệnh CLI Sau Khi Hợp Nhất

Trong cùng một dự án `edit-epub`, người dùng có đầy đủ các luồng làm việc:

```bash
# === NHÁNH 1: SÁCH EPUB CÓ SẴN (Kế thừa nguyên bản) ===
pnpm run unpack                 # Giải nén epub vào workspace/ (tự tạo git commit gốc)
pnpm start --no-pack            # AI chuẩn hoá H1, bổ sung H2/H3, sửa lỗi chính tả
pnpm run footnote               # Menu kiểm tra và nâng cấp Pop-up EPUB 3
pnpm run toc                    # Đồng bộ lại mục lục 3 cấp
pnpm run pack                   # Đóng gói ra output/*_edited.epub

# === NHÁNH 2: CHUYỂN ĐỔI PDF SANG EPUB (Tính năng mới) ===
pnpm run pdf                    # Hiển thị danh sách file PDF trong input/ để chọn
pnpm run pdf "dich-kinh"        # Chọn nhanh theo tên hoặc từ khoá
pnpm run pdf --cover my_cov.jpg # Tuỳ chọn truyền ảnh bìa ngoài nếu scan mờ
pnpm run pdf --all              # Chạy trọn gói từ PDF ra thẳng file EPUB hoàn thiện
```

---

## 3. Cấu Trúc Mã Nguồn Đề Xuất trong `edit-epub`

```text
edit-epub/
├── input/                      # Nơi đặt cả file .epub và .pdf
│   └── dich-kinh-linh-the-kim-dinh.pdf
├── output/                     # Nơi xuất file .epub thành phẩm
├── workspace/                  # Thư mục làm việc giải nén (có Git tracking)
│
├── src/
│   ├── core/                   # Các module cốt lõi dùng chung
│   │   ├── epubArchive.ts      # Đóng gói IDPF (mimetype uncompressed byte 0)
│   │   ├── opfManager.ts       # Đọc/ghi file .opf, manifest, spine, cover metadata
│   │   ├── tocBuilder.ts       # Sinh nav.xhtml (EPUB 3) & toc.ncx (EPUB 2)
│   │   ├── footnoteProcessor.ts# Chuẩn hoá liên kết chú thích và pop-up EPUB 3
│   │   └── domProcessor.ts     # Thao tác Cheerio XML/HTML trên DOM
│   │
│   ├── ai/                     # Kết nối AI & Prompts
│   │   ├── geminiClient.ts     # Gọi Gemini 2.5 Flash / 3.6 Flash
│   │   └── prompts.ts          # Prompts xử lý văn bản, heading, chính tả
│   │
│   ├── pdf/                    # 🚀 MODULE CHUYỂN ĐỔI PDF MỚI
│   │   ├── classifier.ts       # Tự động nhận diện PDF Scan vs PDF Docs
│   │   ├── nativeVisionOcr.ts  # Tầng 1 (Scan): Apple Vision OCR (macOS) / fallback Tesseract
│   │   ├── digitalPdfParser.ts # Tầng 1 (Docs): pdfjs-dist trích xuất text + bounding boxes
│   │   ├── layoutReflow.ts     # Lọc bỏ Running Header/Footer, nối dòng đoạn văn
│   │   └── pdfToWorkspace.ts   # Tầng 2: Gom batch AI, tạo cấu trúc XHTML vào workspace/
│   │
│   └── cli/                    # Giao diện dòng lệnh
│       ├── unpack.ts
│       ├── pack.ts
│       ├── footnote.ts
│       ├── updateToc.ts
│       └── pdf.ts              # 🚀 CLI entrypoint: pnpm run pdf
│
└── package.json
```

---

## 4. Lộ Trình Triển Khai Chi Tiết (Milestones)

- [x] **Milestone 1: Hợp nhất môi trường & Cài đặt dependencies**
  - Chuyển file mẫu `dich-kinh-linh-the-kim-dinh.pdf` vào `edit-epub/input/`.
  - Bổ sung các thư viện cần thiết vào `edit-epub/package.json` (`pdfjs-dist` cho digital PDF, bridge Apple Vision cho macOS).
  - Khai báo script `pnpm run pdf` trong `package.json`.

- [x] **Milestone 2: Xây dựng Tầng 1 (Local Text & Image Extraction)**
  - Module `classifier.ts`: Kiểm tra tỷ lệ text layer để tự động định tuyến (Scan vs Docs).
  - Module `nativeVisionOcr.ts`: Sử dụng Apple Vision Framework cục bộ trên macOS để OCR siêu tốc sách scan tiếng Việt ra Raw Text.
  - Module `digitalPdfParser.ts`: Trích xuất text stream, font size và toạ độ đối với PDF xuất từ Docs.
  - Tách trang 1 làm `images/cover.jpg` và trích xuất các ảnh minh họa.

- [x] **Milestone 3: Xây dựng Tầng 2 (Gemini Batch Structurer & Layout Reflow)**
  - Module `layoutReflow.ts`: Loại bỏ running headers/footers và số trang lặp lại.
  - Gom cụm văn bản thô (theo 10-15 trang hoặc theo chương sơ bộ).
  - Tích hợp Gemini prompt để chuẩn hóa Heading (`H1`, `H2`, `H3`), bóc tách các chú thích chân trang thành dạng Markdown `[^1]` và sửa lỗi chính tả phát sinh do OCR.

- [x] **Milestone 4: Dựng Khung EPUB vào `workspace/`**
  - Cắt các chương thành từng file `.xhtml` độc lập (`part0001.xhtml`, v.v.).
  - Khởi tạo `cover.xhtml` và khai báo cấu trúc chuẩn trong `content.opf`.
  - Khởi tạo Git commit gốc trong `workspace/` (tương tự như lệnh `unpack`) để người dùng xem được Git Diff rõ ràng.

- [x] **Milestone 5: Tích hợp Toàn diện với Core Engine của `edit-epub`**
  - Chạy `FootnoteProcessor` để tự động chuyển toàn bộ `[^1]` thành thẻ Pop-up chuẩn EPUB 3 (`<aside epub:type="footnote">` hoặc file `chuthich.xhtml`).
  - Chạy `TocBuilder` để sinh tự động mục lục cây cho cả `nav.xhtml` (EPUB 3) và `toc.ncx` (EPUB 2).
  - Thử nghiệm đóng gói thành phẩm qua `pnpm run pack` và kiểm tra trên máy đọc sách/Apple Books.

- [ ] **Milestone 6: Kiểm Thử Thực Tế & Tối Ưu Hoá**
  - Chạy thử nghiệm toàn bộ cuốn `dich-kinh-linh-the-kim-dinh.pdf` (122 trang).
  - Đánh giá chất lượng OCR tiếng Việt, tính chính xác của mục lục, liên kết chú thích và hiển thị bìa sách.
