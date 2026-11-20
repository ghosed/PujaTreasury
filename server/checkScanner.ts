import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { RawExtractedCheck } from '../src/types/check.ts';

const DEFAULT_MODEL = 'gemini-4-hydrogen';

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
]);

export interface CheckScanRequest {
  fileName: string;
  mimeType: string;
  base64Data: string;
}

export interface CheckScanResponse {
  fileName: string;
  checks: RawExtractedCheck[];
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function resolveMimeType(fileName: string, mimeType: string): string {
  const norm = mimeType.trim().toLowerCase();
  if (norm === 'image/jpg') return 'image/jpeg';
  if (SUPPORTED_MIME_TYPES.has(norm)) return norm;

  const lowerName = fileName.trim().toLowerCase();
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  if (lowerName.endsWith('.bmp')) return 'image/bmp';
  if (lowerName.endsWith('.tif') || lowerName.endsWith('.tiff')) return 'image/tiff';

  return norm || 'application/octet-stream';
}

function normalizeCheckDateOutput(rawDate: string): string {
  const trimmed = rawDate.trim();
  if (!trimmed) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slashMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed);
  if (slashMatch) {
    const m = Number(slashMatch[1]);
    const d = Number(slashMatch[2]);
    let y = Number(slashMatch[3]);
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const d = String(parsed.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return trimmed;
}

function parseAmountNumber(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(Math.abs(raw) * 100) / 100;
  }
  const cleaned = String(raw ?? '').replace(/[$,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.abs(n) * 100) / 100;
}

function normalizeRoutingNumberOutput(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  const nineDigitMatch = /\d{9}/.exec(str.replace(/[\s-]+/g, ''));
  if (nineDigitMatch) return nineDigitMatch[0];
  const digits = str.replace(/\D/g, '');
  return digits.slice(0, 9);
}

async function generateWithRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('500') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('RESOURCE_EXHAUSTED');
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function scanCheckDocument(
  req: CheckScanRequest
): Promise<CheckScanResponse> {
  const mimeType = resolveMimeType(req.fileName, req.mimeType);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `Unsupported file format (${mimeType}) for "${req.fileName}". Upload PDF, PNG, JPG, or WEBP check files.`
    );
  }

  const cleanBase64 = req.base64Data.replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanBase64) {
    throw new Error(`Uploaded file "${req.fileName}" is empty.`);
  }

  const ai = getGeminiClient();

  const response = await generateWithRetry(() =>
    ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: cleanBase64,
            },
          },
          {
            text: `Inspect every page and every check copy visible in this document (${req.fileName}).
A single image or PDF page may contain 1, 2, 3, or multiple distinct checks (or duplicate copies of the same check).
For EACH check front visible in the document, extract these 8 fields accurately:
1. checkNumber: The check number (usually top-right corner and/or MICR bottom line; digits/alphanumeric only, no "#" prefix).
2. routingNumber: The 9-digit MICR ABA routing number printed at the bottom-left of the check between the MICR transit symbols (e.g., ⑆111000614⑆ -> "111000614", 9 digits only; return "" if completely absent or illegible). Do NOT confuse with the account number or check number.
3. bank: The issuing bank name printed on the check (e.g., "Chase Bank", "Bank of America", "Wells Fargo", "Citibank", "Zions Bank", etc.).
4. date: The date written on the check, formatted as YYYY-MM-DD whenever readable.
5. amount: The numeric dollar amount on the check (e.g., 250.00). Cross-verify the numeric box ($...) against the written amount line if helpful.
6. paidTo: The payee name on the "PAY TO THE ORDER OF" line.
7. paidBy: The payer / account holder name printed in the TOP-LEFT corner of the check (e.g., "Houston Durgabari Society" or the individual/company name).
8. memo: The text written in the "MEMO" or "FOR" field in the BOTTOM-LEFT corner of the check (empty string "" if blank).

Ignore check backs/endorsement-only images that do not contain a check front, unless no front exists. If multiple checks appear, return every single check front in order of appearance.`,
          },
        ],
      },
      config: {
        systemInstruction:
          'You are an accurate financial document check OCR extractor. Return strictly valid JSON matching the schema. Never invent amounts, check numbers, MICR routing numbers, or names not present in the document.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            checks: {
              type: Type.ARRAY,
              description: 'All check fronts detected across the uploaded image or PDF.',
              items: {
                type: Type.OBJECT,
                properties: {
                  checkNumber: {
                    type: Type.STRING,
                    description: 'Check number without leading #.',
                  },
                  routingNumber: {
                    type: Type.STRING,
                    description: '9-digit MICR ABA routing number from the bottom-left MICR line, digits only.',
                  },
                  bank: {
                    type: Type.STRING,
                    description: 'Issuing bank name printed on the check.',
                  },
                  date: {
                    type: Type.STRING,
                    description: 'Check date in YYYY-MM-DD format.',
                  },
                  amount: {
                    type: Type.NUMBER,
                    description: 'Numeric USD check amount.',
                  },
                  paidTo: {
                    type: Type.STRING,
                    description: 'Payee from PAY TO THE ORDER OF line.',
                  },
                  paidBy: {
                    type: Type.STRING,
                    description: 'Payer name from the top-left corner of the check.',
                  },
                  memo: {
                    type: Type.STRING,
                    description: 'Memo or For field from the bottom-left corner.',
                  },
                },
                required: [
                  'checkNumber',
                  'routingNumber',
                  'bank',
                  'date',
                  'amount',
                  'paidTo',
                  'paidBy',
                  'memo',
                ],
              },
            },
          },
          required: ['checks'],
        },
      },
    })
  );

  const rawText = (response.text ?? '').trim();
  let parsed: { checks?: Array<Record<string, unknown>> } = {};
  try {
    parsed = JSON.parse(rawText || '{"checks":[]}');
  } catch {
    throw new Error(
      `Check scanner received invalid JSON output while reading "${req.fileName}".`
    );
  }

  const rawChecks = Array.isArray(parsed.checks) ? parsed.checks : [];
  const checks: RawExtractedCheck[] = rawChecks
    .map((item) => ({
      checkNumber: String(item.checkNumber ?? '').trim().replace(/^#/, ''),
      routingNumber: normalizeRoutingNumberOutput(item.routingNumber),
      bank: String(item.bank ?? '').trim(),
      date: normalizeCheckDateOutput(String(item.date ?? '')),
      amount: parseAmountNumber(item.amount),
      paidTo: String(item.paidTo ?? '').trim(),
      paidBy: String(item.paidBy ?? '').trim(),
      memo: String(item.memo ?? '').trim(),
    }))
    .filter(
      (chk) =>
        Boolean(chk.checkNumber) ||
        Boolean(chk.paidTo) ||
        Boolean(chk.paidBy) ||
        chk.amount > 0
    );

  return {
    fileName: req.fileName,
    checks,
  };
}
