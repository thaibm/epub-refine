export type PdfType = 'scanned' | 'digital';

export interface PdfClassificationResult {
  type: PdfType;
  totalPages: number;
  sampleAvgCharsPerPage: number;
  sampleDetails: string;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfLineItem {
  text: string;
  bbox?: BBox;
  confidence?: number;
  fontSize?: number;
}

export interface PdfExtractedImage {
  fileName: string;
  pageNumber: number;
  width?: number;
  height?: number;
  alt?: string;
  /** Vùng ảnh trên trang, chuẩn hoá 0..1, gốc dưới-trái (cùng hệ với bbox của dòng) */
  bbox?: BBox;
}

export interface PdfExtractedPage {
  pageNumber: number;
  lines: PdfLineItem[];
  rawText: string;
  images?: PdfExtractedImage[];
}

export interface PdfExtractionResult {
  totalPages: number;
  pages: PdfExtractedPage[];
  coverImagePath?: string;
  backCoverImagePath?: string;
  extractedImagesDir?: string;
  sourcePdfPath: string;
  fileName: string;
  baseName: string;
  pdfType: PdfType;
}

/** Một đoạn chữ liên tục cùng kiểu font trên một dòng (chỉ có ở PDF số) */
export interface PdfTextSpan {
  text: string;
  x: number;
  width: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
}

export interface PdfDigitalLine extends PdfLineItem {
  pageNumber: number;
  x: number;
  xEnd: number;
  baseline: number; // Toạ độ PDF (gốc ở mép dưới trang), đơn vị point
  fontSize: number;
  spans: PdfTextSpan[];
  boldRatio: number; // Tỷ lệ ký tự in đậm trên dòng (0 -> 1)
}

export interface PdfDigitalPage extends PdfExtractedPage {
  lines: PdfDigitalLine[];
  width: number;
  height: number;
  imageCount: number;
}

export interface PdfOutlineNode {
  title: string;
  depth: number; // 0 = cấp cao nhất
  page: number;
  y: number;
}

export interface PdfLinkAnnotation {
  page: number;
  rect: [number, number, number, number]; // [x1, y1, x2, y2] theo toạ độ PDF
  targetPage: number;
  targetY: number;
}

export interface PdfDocumentInfo {
  title?: string;
  author?: string;
}

export interface PdfDigitalExtraction extends PdfExtractionResult {
  pages: PdfDigitalPage[];
  outline: PdfOutlineNode[];
  links: PdfLinkAnnotation[];
  info: PdfDocumentInfo;
}

export interface PdfNavEntry {
  title: string;
  level: number; // 1 -> 3
  page: number; // Số trang PDF (1-based)
  y: number;
}

/** Dải chứa mục lục in trong sách, tính từ dòng (startPage, startY) đến dòng (endPage, endY) */
export interface PdfTocRegion {
  startPage: number;
  startY: number;
  endPage: number;
  endY: number;
}

export type PdfNavSource = 'outline' | 'links' | 'text' | 'none';

export interface PdfDigitalNavigation {
  source: PdfNavSource;
  entries: PdfNavEntry[];
  tocRegion?: PdfTocRegion;
}

export interface PdfBatchChunk {
  batchIndex: number;
  startPage: number;
  endPage: number;
  content: string;
}

export interface StructuredChapter {
  id: string;
  title: string;
  htmlContent: string;
  level: number;
}

export interface PdfTocItem {
  title: string;
  level: number; // 1 = Chương / Phần lớn, 2 = Tiểu mục (H2)
  pageNumber?: number; // Số trang in trong sách (nếu có)
  normalizedTitle: string; // Chuẩn hoá không dấu, chữ thường để so khớp
}

export interface PdfTocStructure {
  hasToc: boolean;
  tocPageNumbers: number[]; // Danh sách số trang PDF chứa Mục Lục (để tránh xử lý nội dung trùng)
  items: PdfTocItem[];
  majorChapters: PdfTocItem[]; // Chỉ các mục cấp 1 (Chương/Phần)
  subSections: PdfTocItem[]; // Chỉ các mục cấp 2 (Tiểu mục)
}
