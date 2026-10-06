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
  isPhotoPlate?: boolean;
}

export interface PdfExtractedPage {
  pageNumber: number;
  lines: PdfLineItem[];
  rawText: string;
  images?: PdfExtractedImage[];
  isPhotoPlate?: boolean;
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
