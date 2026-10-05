import fs from 'node:fs';
import path from 'node:path';
import type { GlossaryData } from '../types/index.js';

export class GlossaryManager {
  private filePath: string;
  private data: GlossaryData;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, 'glossary.json');
    this.data = {
      terms: {},
      doNotTranslate: [
        'API',
        'CEO',
        'CFO',
        'CTO',
        'DNA',
        'Email',
        'Facebook',
        'Google',
        'Internet',
        'OKR',
        'PDF',
        'ROI',
        'Scrum',
        'Sprint',
        'Startup',
        'Website'
      ]
    };
    this.load();
  }

  load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.data.terms = { ...this.data.terms, ...(parsed.terms || {}) };
          if (Array.isArray(parsed.doNotTranslate)) {
            const set = new Set([...this.data.doNotTranslate, ...parsed.doNotTranslate]);
            this.data.doNotTranslate = Array.from(set);
          }
        }
      } catch (err) {
        console.warn(`[GlossaryManager] Cảnh báo: Không thể đọc ${this.filePath}, sử dụng mặc định.`);
      }
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[GlossaryManager] Cảnh báo: Không thể lưu ${this.filePath}:`, err);
    }
  }

  getTerms(): Record<string, string> {
    return this.data.terms;
  }

  getDoNotTranslate(): string[] {
    return this.data.doNotTranslate;
  }

  addTerms(newTerms: Record<string, string>): void {
    let changed = false;
    for (const [term, translation] of Object.entries(newTerms)) {
      const trimmedTerm = term.trim();
      const trimmedTrans = translation.trim();
      if (trimmedTerm && trimmedTrans && !this.data.terms[trimmedTerm]) {
        this.data.terms[trimmedTerm] = trimmedTrans;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  addDoNotTranslate(words: string[]): void {
    let changed = false;
    const current = new Set(this.data.doNotTranslate);
    for (const w of words) {
      const trimmed = w.trim();
      if (trimmed && !current.has(trimmed)) {
        current.add(trimmed);
        changed = true;
      }
    }
    if (changed) {
      this.data.doNotTranslate = Array.from(current);
      this.save();
    }
  }

  getFormattedForPrompt(): string {
    const lines: string[] = [];

    const termEntries = Object.entries(this.data.terms);
    if (termEntries.length > 0) {
      lines.push('BẢNG THUẬT NGỮ BẮT BUỘC DỊCH ĐỒNG NHẤT (Glossary):');
      for (const [en, vi] of termEntries) {
        lines.push(`- "${en}" => "${vi}"`);
      }
    }

    if (this.data.doNotTranslate.length > 0) {
      lines.push(`CÁC TỪ GIỮ NGUYÊN TIẾNG ANH (Do Not Translate): ${this.data.doNotTranslate.join(', ')}`);
    }

    return lines.join('\n');
  }
}
