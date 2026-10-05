export interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

export interface EpubSpineItem {
  idref: string;
  linear?: string;
}

export interface EpubMetadata {
  title: string;
  creator?: string;
  language?: string;
  identifier?: string;
  publisher?: string;
}

export interface EpubPackage {
  opfPath: string;
  metadata: EpubMetadata;
  manifest: Map<string, EpubManifestItem>;
  spine: EpubSpineItem[];
  tocId?: string;
  tocHref?: string;
}

export interface HeadingItem {
  id: string;
  level: 1 | 2 | 3;
  title: string;
  href: string; // e.g. text/part0004.html#C2
  children: HeadingItem[];
}

export interface HeadingSuggestion {
  tag: 'h2' | 'h3';
  title: string;
  insertBeforeIdx: number;
}

export interface SpellingFix {
  idx: number;
  original: string;
  fixed: string;
  reason?: string;
}

export interface AiChapterAnalysisResult {
  h1: {
    title: string;
    targetSelector?: string;
    removeTopIndices?: number[];
  };
  headings: HeadingSuggestion[];
  spellingFixes: SpellingFix[];
}

export interface BookContext {
  bookTitle: string;
  originalTitle: string;
  genre?: string;
  domain?: string;
  tone?: string;
  pronouns?: {
    author?: string;
    reader?: string;
    notes?: string;
  };
  summary?: string;
}

export interface GlossaryData {
  terms: Record<string, string>;
  doNotTranslate: string[];
}

export interface BilingualParagraphItem {
  idx: number;
  originalEn: string;
  translatedVi: string;
}

export interface BilingualChapterResult {
  h1Vi?: string;
  translatedParagraphs: { idx: number; text: string }[];
  authorFootnotes?: { num: string; textVi: string }[];
  newTerms?: Record<string, string>;
  chapterSummary?: string;
}
