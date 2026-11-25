import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AmazonOrderStatus,
  RawExtractedAmazonItem,
} from '../src/types/amazon.ts';

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

export interface AmazonScanRequest {
  fileName: string;
  mimeType: string;
  base64Data: string;
}

export interface AmazonScanResponse {
  fileName: string;
  items: RawExtractedAmazonItem[];
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

function normalizeDateOutput(rawDate: string): string {
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

function parseOptionalNumber(raw: unknown, decimals = 2): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const factor = 10 ** decimals;
    return Math.round(raw * factor) / factor;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const cleaned = str.replace(/[$,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normalizeStatusOutput(raw: unknown): AmazonOrderStatus {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v.includes('cancel')) return 'Cancelled';
  if (v.includes('return') || v.includes('refund')) return 'Returned';
  if (v.includes('deliver')) return 'Delivered';
  if (
    v === 'ordered' ||
    v.includes('order placed') ||
    v.includes('arriving') ||
    v.includes('shipped') ||
    v.includes('in transit') ||
    v.includes('out for delivery')
  ) {
    return 'Ordered';
  }
  return '';
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

export async function scanAmazonDocument(
  req: AmazonScanRequest
): Promise<AmazonScanResponse> {
  const mimeType = resolveMimeType(req.fileName, req.mimeType);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `Unsupported file format (${mimeType}) for "${req.fileName}". Upload Amazon order images (PNG, JPG, WEBP) or PDFs.`
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
            text: `Inspect every page and every Amazon order or invoice visible in this document (${req.fileName}).
Note: Printable Amazon invoice PDFs may be rotated 90 degrees sideways—read all rotated text carefully.
A single document may contain 1 order or multiple line items within an order. Return ONE item object per line item visible.

For EACH line item, extract these 9 fields accurately. IMPORTANT: If a field is NOT visibly present in the document, leave strings as "" and numeric fields as null—NEVER guess or fabricate missing values:
1. orderNumber: Amazon Order # / Order ID (e.g., "111-0177387-1485024"), "" if absent.
2. orderDate: Order placed date formatted as YYYY-MM-DD (e.g., "October 4, 2026" -> "2026-10-04"), "" if absent.
3. quantity: Numeric quantity for this line item (e.g., 1, 2). On order summary screenshots with a single item thumbnail or item row and no explicit multiplier badge, use 1 if it represents 1 item; if truly unclear, return null.
4. itemDescription: Exact product/item title or description. If multiple items in the same order share an identical truncated title (e.g. "Custom Neon Signs, Personalised Led Neo...") while their thumbnails show distinct custom text (such as "PUJA SHOPPING MARKET", "REGISTRATION", "Kids Corner", "NextGen Den"), append the distinct thumbnail label in parentheses so each item is clearly identified.
5. itemPrice: Unit/item price as a numeric dollar value (e.g., 29.99) if explicitly shown on the line item (or equal to line price when explicitly printed). If NOT shown on an order summary screenshot (only order TOTAL is shown), leave as null.
6. total: Dollar total for the line item if itemized (e.g. invoice "Total" column), or the order "TOTAL" if single-item. If an order summary screenshot shows multiple items and ONLY one order-level TOTAL (no per-item prices/totals), put the order-level TOTAL on the FIRST item of that order and null on the remaining items so the order total is not duplicated across rows.
7. shippedTo: Recipient name from "SHIP TO" or shipping address block (e.g., "Sandip Dasgupta"), "" if not present in the document.
8. paymentMethod: Payment method if visible (e.g., "credit/debit", "Visa ending in 1234", "Amazon Gift Card"). Strip leading "Paid via " if helpful (e.g., "Paid via credit/debit" -> "credit/debit"), "" if not visible.
9. status: Must be one of "Ordered", "Delivered", "Cancelled", "Returned", or "" if status is not indicated.
   - "Arriving ...", "Shipped", "Order placed", "Out for delivery" -> "Ordered"
   - "Delivered ..." -> "Delivered"
   - "Cancelled" / "Canceled" -> "Cancelled"
   - "Returned" / "Return complete" -> "Returned"
   - Invoice/packing slips that only state "Your order of..." or "This shipment completes your order" without a delivery/return/cancellation status -> leave as "" unless status is explicitly shown.`,
          },
        ],
      },
      config: {
        systemInstruction:
          'You are an accurate Amazon order summary and invoice PDF extractor. Return strictly valid JSON matching the schema. Never invent values that are not visible in the document; leave absent string fields as "" and absent numbers as null.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              description: 'All Amazon order line items detected in the uploaded image or PDF.',
              items: {
                type: Type.OBJECT,
                properties: {
                  orderNumber: {
                    type: Type.STRING,
                    description: 'Amazon Order # (e.g. 111-0177387-1485024) or "".',
                  },
                  orderDate: {
                    type: Type.STRING,
                    description: 'Order date in YYYY-MM-DD format or "".',
                  },
                  quantity: {
                    type: Type.NUMBER,
                    nullable: true,
                    description: 'Item quantity, or null if not available.',
                  },
                  itemDescription: {
                    type: Type.STRING,
                    description: 'Item description/title or "".',
                  },
                  itemPrice: {
                    type: Type.NUMBER,
                    nullable: true,
                    description: 'Line item unit price in USD, or null if not available.',
                  },
                  total: {
                    type: Type.NUMBER,
                    nullable: true,
                    description: 'Line item total or order total in USD, or null if not available.',
                  },
                  shippedTo: {
                    type: Type.STRING,
                    description: 'Shipped To / Recipient name, or "".',
                  },
                  paymentMethod: {
                    type: Type.STRING,
                    description: 'Payment method if shown, or "".',
                  },
                  status: {
                    type: Type.STRING,
                    description:
                      'Normalized order status: "Ordered", "Delivered", "Cancelled", "Returned", or "" if not shown.',
                  },
                },
                required: [
                  'orderNumber',
                  'orderDate',
                  'quantity',
                  'itemDescription',
                  'itemPrice',
                  'total',
                  'shippedTo',
                  'paymentMethod',
                  'status',
                ],
              },
            },
          },
          required: ['items'],
        },
      },
    })
  );

  const rawText = (response.text ?? '').trim();
  let parsed: { items?: Array<Record<string, unknown>> } = {};
  try {
    parsed = JSON.parse(rawText || '{"items":[]}');
  } catch {
    throw new Error(
      `Amazon order scanner received invalid JSON output while reading "${req.fileName}".`
    );
  }

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items: RawExtractedAmazonItem[] = rawItems
    .map((item) => {
      const qty = parseOptionalNumber(item.quantity, 0);
      return {
        orderNumber: String(item.orderNumber ?? '').trim(),
        orderDate: normalizeDateOutput(String(item.orderDate ?? '')),
        quantity: qty !== null && qty > 0 ? qty : null,
        itemDescription: String(item.itemDescription ?? '').trim(),
        itemPrice: parseOptionalNumber(item.itemPrice, 2),
        total: parseOptionalNumber(item.total, 2),
        shippedTo: String(item.shippedTo ?? '').trim(),
        paymentMethod: String(item.paymentMethod ?? '').trim(),
        status: normalizeStatusOutput(item.status),
      };
    })
    .filter(
      (it) =>
        Boolean(it.orderNumber) ||
        Boolean(it.itemDescription) ||
        it.total !== null ||
        it.itemPrice !== null
    );

  return {
    fileName: req.fileName,
    items,
  };
}
