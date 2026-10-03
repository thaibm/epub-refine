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

export interface FootnoteItemSuggestion {
  num: string;
  markerText?: string;
  inTextIdx: number;
  defIdx: number;
  term?: string;
}

export interface AiFootnoteAnalysis {
  footnoteStartIdx?: number | null;
  items: FootnoteItemSuggestion[];
}

export interface AiChapterAnalysisResult {
  h1: {
    title: string;
    targetSelector?: string;
    removeTopIndices?: number[];
  };
  headings: HeadingSuggestion[];
  spellingFixes: SpellingFix[];
  footnotes?: AiFootnoteAnalysis | null;
}
