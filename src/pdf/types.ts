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

export interface PdfExtractedPage {
  pageNumber: number;
  lines: PdfLineItem[];
  rawText: string;
}

export interface PdfExtractionResult {
  totalPages: number;
  pages: PdfExtractedPage[];
  coverImagePath?: string;
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
