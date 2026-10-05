import { GoogleGenAI } from '@google/genai';
import type { AiChapterAnalysisResult } from '../types/index.js';

export interface GeminiClientOptions {
  apiKey?: string | string[];
  model?: string;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class GeminiClient {
  private apiKeys: string[];
  private currentKeyIndex = 0;
  private keyClients: Map<string, GoogleGenAI> = new Map();
  private exhaustedKeys: Set<string> = new Set();
  private modelName: string;

  constructor(options: GeminiClientOptions = {}) {
    const rawKeys: string[] = [];

    if (options.apiKey) {
      if (Array.isArray(options.apiKey)) {
        rawKeys.push(...options.apiKey);
      } else {
        rawKeys.push(...options.apiKey.split(','));
      }
    }

    if (process.env.GEMINI_API_KEYS) {
      rawKeys.push(...process.env.GEMINI_API_KEYS.split(','));
    }

    if (process.env.GEMINI_API_KEY) {
      rawKeys.push(...process.env.GEMINI_API_KEY.split(','));
    }

    // Hỗ trợ dạng GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
    for (const [k, v] of Object.entries(process.env)) {
      if (/^GEMINI_API_KEY_\d+$/i.test(k) && v) {
        rawKeys.push(v);
      }
    }

    this.apiKeys = Array.from(
      new Set(rawKeys.map((k) => k.trim()).filter((k) => k.length > 0))
    );

    if (this.apiKeys.length === 0) {
      throw new Error(
        'Không tìm thấy GEMINI_API_KEY! Hãy thêm vào file .env hoặc biến môi trường.'
      );
    }

    this.modelName = options.model || process.env.GEMINI_MODEL || 'gemini-3.6-flash';

    if (this.apiKeys.length > 1) {
      console.log(`🔑 Đã nạp ${this.apiKeys.length} API Keys vào Pool luân phiên (Round-Robin & Failover).`);
    }
  }

  private getClient(apiKey: string): GoogleGenAI {
    let client = this.keyClients.get(apiKey);
    if (!client) {
      client = new GoogleGenAI({ apiKey });
      this.keyClients.set(apiKey, client);
    }
    return client;
  }

  /**
   * Bộ điều phối gọi Gemini thông minh:
   * 1. Luân phiên Round-Robin qua danh sách API Key để chia tải RPM.
   * 2. Tự động chuyển ngay sang Key khác nếu gặp 429 hoặc Hết quota ngày (PerDay).
   * 3. Fallback sang các model khác nếu model chính bị quá tải (503 High Demand).
   */
  private async executeWithKeyRotation<T>(
    operation: (ai: GoogleGenAI, model: string, key: string) => Promise<T>
  ): Promise<T> {
    const candidateModels = [
      this.modelName,
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite'
    ];
    const uniqueModels = Array.from(new Set(candidateModels));

    let lastError: any = null;
    const totalKeys = this.apiKeys.length;

    // Duyệt qua các API key theo thứ tự round-robin
    for (let keyAttempt = 0; keyAttempt < totalKeys; keyAttempt++) {
      const keyIndex = (this.currentKeyIndex + keyAttempt) % totalKeys;
      const apiKey = this.apiKeys[keyIndex];

      // Nếu key này đã bị đánh dấu cạn kiệt quota ngày và vẫn còn key khác, bỏ qua
      if (this.exhaustedKeys.has(apiKey) && this.exhaustedKeys.size < totalKeys) {
        continue;
      }

      const client = this.getClient(apiKey);
      const masked = maskKey(apiKey);

      for (const model of uniqueModels) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const result = await operation(client, model, apiKey);
            // Cập nhật key index cho lần gọi tiếp theo (Round-robin)
            this.currentKeyIndex = (keyIndex + 1) % totalKeys;
            return result;
          } catch (err: any) {
            lastError = err;
            const msg = err.message || '';

            // 1. Hết hạn mức ngày (Daily Quota) của Key
            if (msg.includes('PerDay') || (msg.includes('PerProjectPerModel') && msg.includes('Day'))) {
              this.exhaustedKeys.add(apiKey);
              console.log(`      ⚡ Key [${masked}] hết quota ngày (${this.exhaustedKeys.size}/${totalKeys} keys cạn), chuyển key tiếp theo...`);
              break; // Chuyển sang key tiếp theo ngay lập tức
            }

            // 2. Chạm trần RPM (429 Rate Limit)
            const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
            if (isRateLimit) {
              if (totalKeys > 1 && keyAttempt < totalKeys - 1) {
                console.log(`      ⏳ Key [${masked}] chạm trần RPM, tự động chuyển sang Key tiếp theo trong Pool...`);
                break; // Thoát sang key tiếp theo ngay mà không cần chờ 20s
              }

              // Nếu là key duy nhất hoặc tất cả key đều bị rate limit
              let waitSeconds = 20;
              const match = msg.match(/retry in ([0-9.]+)s/i) || msg.match(/"retryDelay":\s*"([0-9]+)s"/i);
              if (match && match[1]) {
                waitSeconds = Math.ceil(parseFloat(match[1])) + 2;
              }
              console.log(`      ⏳ Toàn bộ key chạm giới hạn phút (RPM), tự động chờ ${waitSeconds}s...`);
              await new Promise((r) => setTimeout(r, waitSeconds * 1000));
              continue;
            }

            // 3. Model bận hoặc quá tải (503 High Demand)
            const isOverloaded = msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE');
            if (isOverloaded) {
              if (totalKeys > 1 && attempt === 1) {
                console.log(`      ⚠️ Model ${model} bận trên key [${masked}], thử sang Key khác trong Pool...`);
                break;
              }
              console.log(`      ⚠️ Model ${model} bận (thử lại lần ${attempt}/2 sau 2s)...`);
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }

            break;
          }
        }
      }
    }

    throw new Error(`Tất cả các API Key và Model đều gặp sự cố: ${lastError?.message || 'Không rõ nguyên nhân'}`);
  }

  async analyzeChapter(prompt: string): Promise<AiChapterAnalysisResult> {
    return this.executeWithKeyRotation(async (ai, model) => {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const text = response.text;
      if (!text) throw new Error('Gemini không trả về nội dung.');

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
      if (!Array.isArray(parsed.headings)) parsed.headings = [];
      if (!Array.isArray(parsed.spellingFixes)) parsed.spellingFixes = [];

      return parsed;
    });
  }

  async structurePdfContent(prompt: string): Promise<string> {
    return this.executeWithKeyRotation(async (ai, model) => {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          temperature: 0.15
        }
      });

      const text = response.text;
      if (!text) throw new Error('Gemini không trả về nội dung.');

      let cleanText = text.trim();
      if (cleanText.startsWith('```html')) {
        cleanText = cleanText.replace(/^```html\s*/i, '').replace(/```$/i, '').trim();
      } else if (cleanText.startsWith('```xml')) {
        cleanText = cleanText.replace(/^```xml\s*/i, '').replace(/```$/i, '').trim();
      } else if (cleanText.startsWith('```markdown')) {
        cleanText = cleanText.replace(/^```markdown\s*/i, '').replace(/```$/i, '').trim();
      } else if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```\s*/, '').replace(/```$/, '').trim();
      }

      return cleanText;
    });
  }

  async analyzeGenericJson<T>(prompt: string): Promise<T> {
    return this.executeWithKeyRotation(async (ai, model) => {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.15
        }
      });

      const text = response.text;
      if (!text) throw new Error('Gemini không trả về nội dung.');

      let cleanJson = text.trim();
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      } else if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```\s*/, '').replace(/```$/, '').trim();
      }

      const parsed: T = JSON.parse(cleanJson);
      return parsed;
    });
  }
}
