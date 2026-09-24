import { GoogleGenAI } from '@google/genai';
import type { AiChapterAnalysisResult } from '../types/index.js';

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
}

export class GeminiClient {
  private ai: GoogleGenAI;
  private modelName: string;

  constructor(options: GeminiClientOptions = {}) {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Không tìm thấy GEMINI_API_KEY! Hãy thêm vào file .env hoặc biến môi trường.'
      );
    }

    this.ai = new GoogleGenAI({ apiKey });
    this.modelName = options.model || process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  }

  async analyzeChapter(prompt: string): Promise<AiChapterAnalysisResult> {
    const candidateModels = [
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      this.modelName
    ];
    const uniqueModels = Array.from(new Set(candidateModels));

    let lastError: any = null;

    for (const model of uniqueModels) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await this.ai.models.generateContent({
            model: model,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.1
            }
          });

          const text = response.text;
          if (!text) {
            throw new Error('Gemini không trả về nội dung.');
          }

          let cleanJson = text.trim();
          if (cleanJson.startsWith('```json')) {
            cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
          } else if (cleanJson.startsWith('```')) {
            cleanJson = cleanJson.replace(/^```\s*/, '').replace(/```$/, '').trim();
          }

          const parsed: AiChapterAnalysisResult = JSON.parse(cleanJson);

          if (!parsed.h1 || typeof parsed.h1.title !== 'string') {
            throw new Error('Dữ liệu trả về thiếu trường h1.title hợp lệ.');
          }
          if (!Array.isArray(parsed.headings)) {
            parsed.headings = [];
          }
          if (!Array.isArray(parsed.spellingFixes)) {
            parsed.spellingFixes = [];
          }

          return parsed;
        } catch (err: any) {
          lastError = err;
          const msg = err.message || '';

          // 1. Kiểm tra nếu hết hạn mức NGÀY (PerDay limit) -> Không thể chờ vài chục giây, phải đổi ngay model khác!
          if (msg.includes('PerDay') || (msg.includes('PerProjectPerModel') && msg.includes('Day'))) {
            console.log(`      ⚡ Model ${model} đã hết hạn mức trong ngày (Daily Quota Exceeded), chuyển sang model tiếp theo...`);
            break; // Ngắt vòng lặp retry của model này, chuyển sang model kế tiếp
          }

          // 2. Kiểm tra nếu chỉ là nghẽn tốc độ theo PHÚT (RPM Rate Limit)
          const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
          const isOverloaded = msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE');

          if (isRateLimit && attempt < 3) {
            let waitSeconds = 20;
            const match = msg.match(/retry in ([0-9.]+)s/i) || msg.match(/"retryDelay":\s*"([0-9]+)s"/i);
            if (match && match[1]) {
              waitSeconds = Math.ceil(parseFloat(match[1])) + 2;
            }
            console.log(`      ⏳ Chạm giới hạn theo phút (RPM), tự động chờ ${waitSeconds}s trước khi thử lại...`);
            await new Promise((r) => setTimeout(r, waitSeconds * 1000));
            continue;
          }

          if (isOverloaded && attempt < 2) {
            console.log(`      ⚠️ Model ${model} bận (thử lại lần ${attempt}/2 sau 3s)...`);
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }

          break;
        }
      }
    }

    throw new Error(`Tất cả các model đều gặp sự cố: ${lastError?.message || 'Không rõ nguyên nhân'}`);
  }
}
