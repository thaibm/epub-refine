/**
 * Bộ kiểm định chất lượng bản dịch (Translation Quality Guardrail & Linter)
 * Giúp phát hiện token glitch, từ ghép dị dạng, lỗi encoding hoặc sót tiếng Anh.
 */

export interface ValidationIssue {
  idx: number;
  word: string;
  contextSnippet: string;
  reason: string;
}

export class TranslationValidator {
  // Danh sách các tên riêng, thương hiệu có chữ hoa ở giữa (CamelCase / PascalCase) hợp lệ
  private static readonly KNOWN_BRAND_NAMES = new Set([
    'iphone', 'ipad', 'imac', 'ipod', 'ebay', 'macos', 'ios',
    'paypal', 'youtube', 'wi-fi', 'wifi', 'mcdonald', "mcdonald's",
    'mckinsey', 'mccloskey', 'macarthur', 'marketwatch', 'sciencedaily',
    'wework', 'ebook', 'epub', 'linkedin', 'github', 'fedex', 'blackrock',
    'vương', 'quốc', 'anh', 'lafrance'
  ]);

  /**
   * Kiểm tra một đoạn văn bản tiếng Việt có chứa từ bất thường hoặc glitch token không
   */
  static findAnomaliesInText(text: string): { word: string; reason: string }[] {
    const anomalies: { word: string; reason: string }[] = [];

    // 1. Phát hiện từ có chữ thường đi liền chữ hoa (CamelCase trong tiếng Việt, ví dụ: niềmisOn, đượcla)
    const mixedCaseMatches = text.match(/\b[\p{L}]*[a-zà-ỹ][A-Z][\p{L}]*\b/gu);
    if (mixedCaseMatches) {
      for (const m of mixedCaseMatches) {
        const lower = m.toLowerCase().replace(/[.,;!?]/g, '');
        if (!this.KNOWN_BRAND_NAMES.has(lower) && !/^[A-ZĐÀ-Ỹ]+$/.test(m)) {
          anomalies.push({
            word: m,
            reason: 'Token glitch / ghép chữ hoa thường dị dạng (CamelCase)'
          });
        }
      }
    }

    // 2. Phát hiện các mảnh từ tiếng Anh rác dính liền dấu tiếng Việt (ví dụ: "niềmis", "hạpthe")
    const englishFragmentRegex = /\b([a-zà-ỹ]*[à-ỹ][a-zà-ỹ]*(?:is|the|on|of|in|at|and|or|for))\b/gui;
    let match: RegExpExecArray | null;
    while ((match = englishFragmentRegex.exec(text)) !== null) {
      const w = match[1];
      // Bỏ qua các từ tiếng Việt hợp lệ kết thúc bằng 'in', 'on', 'or' như 'tin', 'nón', 'hòn', 'còn', v.v.
      if (!/^(tin|hòn|còn|chọn|tròn|nón|ngon|mòn|đòn|con|son|non|bón|chồn|rốn|lớn)$/i.test(w)) {
        if (!anomalies.some((a) => a.word === w)) {
          anomalies.push({
            word: w,
            reason: 'Có dấu hiệu dính mảnh token tiếng Anh rác'
          });
        }
      }
    }

    return anomalies;
  }

  /**
   * Quét và kiểm tra một mảng các đoạn văn vừa dịch xong
   */
  static validateBatch(
    paragraphs: { idx: number; text: string }[]
  ): { valid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];

    for (const p of paragraphs) {
      if (!p.text || p.text.trim().length === 0) {
        issues.push({
          idx: p.idx,
          word: '<EMPTY>',
          contextSnippet: '',
          reason: 'Bản dịch bị rỗng'
        });
        continue;
      }

      const textAnomalies = this.findAnomaliesInText(p.text);
      for (const a of textAnomalies) {
        issues.push({
          idx: p.idx,
          word: a.word,
          contextSnippet: p.text.substring(0, 100) + '...',
          reason: a.reason
        });
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }
}
