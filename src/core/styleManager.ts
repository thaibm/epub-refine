import type { UnpackedEpub } from './epubArchive.js';

export const STANDARD_HEADING_CSS = `
/* ========================================================
   Quy chuẩn Typography cho Headings trong EPUB
   ======================================================== */
h1, .chapter-h1 {
  font-size: 1.45em;
  font-weight: bold;
  line-height: 1.35;
  margin-top: 1.2em;
  margin-bottom: 0.8em;
  text-align: center;
}

h2, .chapter-h2, .section-h2 {
  font-size: 1.25em;
  font-weight: bold;
  line-height: 1.3;
  margin-top: 1.2em;
  margin-bottom: 0.6em;
}

h3, .section-h3 {
  font-size: 1.1em;
  font-weight: bold;
  line-height: 1.25;
  margin-top: 1em;
  margin-bottom: 0.4em;
}

h4, .section-h4 {
  font-size: 1.0em;
  font-weight: bold;
  line-height: 1.2;
  margin-top: 0.8em;
  margin-bottom: 0.3em;
}

/* Phân trang cho các chương được gộp theo phần */
.chapter-break {
  page-break-before: always;
  break-before: page;
  margin-top: 2em;
}
`;

/**
 * Đảm bảo các file CSS trong EPUB có định nghĩa bộ quy chuẩn Heading và Chapter Break
 */
export function ensureStandardStyles(unpacked: UnpackedEpub): boolean {
  const cssFiles = unpacked.listFiles().filter((f) => f.endsWith('.css'));
  if (cssFiles.length === 0) return false;

  let anyModified = false;
  for (const cssFile of cssFiles) {
    let css = unpacked.getFileString(cssFile);
    let modified = false;

    const lower = cssFile.toLowerCase();
    // Bỏ qua page_styles.css (chỉ dùng cho @page / margin khổ trang in)
    if (lower.includes('page_style') || lower.includes('page-style')) continue;

    // Kiểm tra xem file này có phải là stylesheet chính (hoặc file css duy nhất)
    const isMainStylesheet = lower.includes('stylesheet') || lower.includes('main') || lower.includes('style') || cssFiles.length === 1;

    if (isMainStylesheet) {
      if (!css.includes('.chapter-h1') && !css.includes('h1, .chapter-h1') && !css.includes('h1 {')) {
        css += `\n${STANDARD_HEADING_CSS}\n`;
        modified = true;
      } else {
        if (!css.includes('.chapter-break')) {
          css += `\n\n.chapter-break {\n  page-break-before: always;\n  break-before: page;\n  margin-top: 2em;\n}\n`;
          modified = true;
        }
      }
    }

    if (modified) {
      unpacked.setFileString(cssFile, css);
      anyModified = true;
    }
  }

  return anyModified;
}

/**
 * Đảm bảo các file CSS trong EPUB có định nghĩa bộ quy chuẩn hiển thị chú thích song ngữ Pop-up
 */
export function ensureBilingualStyles(unpacked: UnpackedEpub, customBilingualCss?: string): boolean {
  const cssFiles = unpacked.listFiles().filter((f) => f.endsWith('.css'));
  if (cssFiles.length === 0) return false;

  const bilingualCssToInject = customBilingualCss || `
/* ========================================================
   Quy chuẩn Hiển thị Chú thích Pop-up Modal EPUB
   ======================================================== */
a[id^="chuthich_"] {
  text-decoration: none !important;
  color: #1a73e8 !important;
  margin-left: 0.2em;
  font-weight: bold;
  cursor: pointer;
}

a[id^="chuthich_"] sup {
  font-size: 0.75em;
  line-height: 0;
  vertical-align: baseline;
  position: relative;
  top: -0.4em;
}

p[id^="chuthich_"] {
  margin: 0.8em 0;
  line-height: 1.5;
}

p[id^="chuthich_"] a[id^="p_"] {
  text-decoration: none !important;
  color: #1a73e8 !important;
  font-weight: bold;
  margin-right: 0.3em;
}
`;

  let anyModified = false;
  for (const cssFile of cssFiles) {
    let css = unpacked.getFileString(cssFile);
    const lower = cssFile.toLowerCase();
    if (lower.includes('page_style') || lower.includes('page-style')) continue;

    const isMainStylesheet =
      lower.includes('stylesheet') || lower.includes('main') || lower.includes('style') || cssFiles.length === 1;

    if (isMainStylesheet && !css.includes('.chapter-footnotes-section')) {
      css += `\n${bilingualCssToInject}\n`;
      unpacked.setFileString(cssFile, css);
      anyModified = true;
    }
  }

  return anyModified;
}
