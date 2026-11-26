import type {
  AmazonOrderRecord,
  AmazonOrderStatus,
  AmazonPipelineSummary,
  RawExtractedAmazonItem,
  UploadedAmazonFile,
} from '../types/amazon.ts';
import { normalizeDate } from './statementProcessor.ts';

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const DIGIT_SPACE_12 = 1_000_000_000_000n;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Bytes(input: string): Uint8Array {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;
  const paddedLen = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(utf8);
  padded[utf8.length] = 0x80;

  const view = new DataView(padded.buffer);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  view.setUint32(paddedLen - 8, hi, false);
  view.setUint32(paddedLen - 4, lo, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    digestView.setUint32(i * 4, h[i], false);
  }
  return digest;
}

export function normalizeAmazonOrderNumber(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function normalizeAmazonDate(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const iso = normalizeDate(trimmed);
  return iso || trimmed;
}

export function normalizeAmazonStatus(raw: unknown): AmazonOrderStatus {
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

export function normalizeAmazonPaymentMethod(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';

  const alreadyShortMatch = /^debit\s*[.•*…-]{2,}\s*(\d{4})$/i.exec(trimmed);
  if (alreadyShortMatch) {
    return `Debit ... ${alreadyShortMatch[1]}`;
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes('wells fargo') && lower.includes('debit')) {
    const endingMatch =
      /(?:ending\s*(?:in)?\s*[:#-]?\s*|[•*…]{2,}\s*|\.{2,}\s*|x)(\d{4})\b/i.exec(trimmed);
    if (endingMatch) {
      return `Debit ... ${endingMatch[1]}`;
    }
    const fourDigitMatches = trimmed.match(/(?<!\d)\d{4}(?!\d)/g);
    const last4 = fourDigitMatches ? fourDigitMatches[fourDigitMatches.length - 1] : '';
    return last4 ? `Debit ... ${last4}` : 'Debit';
  }

  return trimmed;
}

export function parseOptionalAmazonNumber(raw: unknown, decimals = 2): number | null {
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

function normalizeQuantityToken(quantity: number | null): string {
  if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) return '';
  return String(Math.round(quantity));
}

function normalizeDescriptionToken(itemDescription: string): string {
  return String(itemDescription ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeItemPriceToken(itemPrice: number | null): string {
  if (itemPrice === null || !Number.isFinite(itemPrice) || itemPrice < 0) return '';
  return (Math.round(Math.abs(itemPrice) * 100) / 100).toFixed(2);
}

export function isValid12DigitAmazonUniqueId(uniqueId: string): boolean {
  return /^\d{12}$/.test(String(uniqueId ?? '').trim());
}

/**
 * Duplicate key defined strictly over the 5 requested fields:
 * Order # AND Order Date AND Quantity AND Item Description AND Item Price.
 */
export function buildAmazonDuplicateKey(params: {
  orderNumber: string;
  orderDate: string;
  quantity: number | null;
  itemDescription: string;
  itemPrice: number | null;
}): string {
  const normOrder = normalizeAmazonOrderNumber(params.orderNumber);
  const normDate = normalizeAmazonDate(params.orderDate);
  const normQty = normalizeQuantityToken(params.quantity);
  const normDesc = normalizeDescriptionToken(params.itemDescription);
  const normPrice = normalizeItemPriceToken(params.itemPrice);
  return `${normOrder}::${normDate}::${normQty}::${normDesc}::${normPrice}`;
}

/**
 * System-generated deterministic 12-digit numeric hash ID (`[0-9]{12}`)
 * computed via SHA-256 of the canonical 5-field identity.
 */
export function buildAmazonUniqueId(params: {
  orderNumber: string;
  orderDate: string;
  quantity: number | null;
  itemDescription: string;
  itemPrice: number | null;
}): string {
  const normOrder = normalizeAmazonOrderNumber(params.orderNumber);
  const normDate = normalizeAmazonDate(params.orderDate);
  const normQty = normalizeQuantityToken(params.quantity);
  const normDesc = normalizeDescriptionToken(params.itemDescription);
  const normPrice = normalizeItemPriceToken(params.itemPrice);

  const canonicalPayload = `AMZ1|${normOrder}|${normDate}|${normQty}|${normDesc}|${normPrice}`;
  const digest = sha256Bytes(canonicalPayload);
  const view = new DataView(digest.buffer);
  const hi64 = (BigInt(view.getUint32(0, false)) << 32n) | BigInt(view.getUint32(4, false));
  const code = (hi64 % DIGIT_SPACE_12).toString(10).padStart(12, '0');
  return code;
}

export function processScannedAmazonFiles(
  files: UploadedAmazonFile[],
  existingSheetIds: Set<string>,
  existingSheetDuplicateKeys: Set<string>,
  overrides: Record<string, Partial<AmazonOrderRecord>> = {}
): {
  readyOrders: AmazonOrderRecord[];
  duplicateOrders: AmazonOrderRecord[];
  summary: AmazonPipelineSummary;
} {
  const readyOrders: AmazonOrderRecord[] = [];
  const duplicateOrders: AmazonOrderRecord[] = [];
  const seenIds = new Set<string>(existingSheetIds);
  const seenDupKeys = new Set<string>(existingSheetDuplicateKeys);
  let totalExtracted = 0;

  for (const file of files) {
    if (file.status !== 'ready') continue;
    file.extractedItems.forEach((raw: RawExtractedAmazonItem, idx: number) => {
      totalExtracted++;
      const rowKey = `scan-${file.id}-${idx}`;
      const ov = overrides[rowKey];

      const orderNumber = (ov?.orderNumber ?? raw.orderNumber ?? '').trim();
      const orderDate = normalizeAmazonDate(ov?.orderDate ?? raw.orderDate ?? '');
      const quantity =
        ov && 'quantity' in ov
          ? parseOptionalAmazonNumber(ov.quantity, 0)
          : parseOptionalAmazonNumber(raw.quantity, 0);
      const safeQty = quantity !== null && quantity > 0 ? quantity : null;
      const itemDescription = (ov?.itemDescription ?? raw.itemDescription ?? '').trim();
      const itemPrice =
        ov && 'itemPrice' in ov
          ? parseOptionalAmazonNumber(ov.itemPrice, 2)
          : parseOptionalAmazonNumber(raw.itemPrice, 2);
      const total =
        ov && 'total' in ov
          ? parseOptionalAmazonNumber(ov.total, 2)
          : parseOptionalAmazonNumber(raw.total, 2);
      const shippedTo = (ov?.shippedTo ?? raw.shippedTo ?? '').trim();
      const paymentMethod = normalizeAmazonPaymentMethod(
        ov?.paymentMethod ?? raw.paymentMethod ?? ''
      );
      const status =
        ov && 'status' in ov
          ? normalizeAmazonStatus(ov.status)
          : normalizeAmazonStatus(raw.status);
      const isRecon: 'Yes' | 'No' = ov?.isRecon === 'Yes' ? 'Yes' : 'No';
      const category = (ov?.category ?? raw.category ?? '').trim();
      const expId = (ov?.expId ?? '').trim();
      const bankId = (ov?.bankId ?? '').trim();

      const keyArgs = {
        orderNumber,
        orderDate,
        quantity: safeQty,
        itemDescription,
        itemPrice,
      };
      const uniqueId = buildAmazonUniqueId(keyArgs);
      const duplicateKey = buildAmazonDuplicateKey(keyArgs);

      const isDupInSheet =
        existingSheetIds.has(uniqueId) || existingSheetDuplicateKeys.has(duplicateKey);
      const isDupInBatch =
        !isDupInSheet && (seenIds.has(uniqueId) || seenDupKeys.has(duplicateKey));

      if (isDupInSheet || isDupInBatch) {
        duplicateOrders.push({
          rowKey,
          uniqueId,
          duplicateKey,
          orderNumber,
          orderDate,
          quantity: safeQty,
          itemDescription,
          itemPrice,
          total,
          shippedTo,
          paymentMethod,
          status,
          isRecon,
          category,
          expId,
          bankId,
          sourceOrigin: 'scan',
          sourceFileName: file.fileName,
          isDuplicate: true,
          duplicateReason: isDupInSheet
            ? 'Already recorded in Amazon_Ledger'
            : 'Duplicate order item in uploaded files',
        });
        return;
      }

      seenIds.add(uniqueId);
      seenDupKeys.add(duplicateKey);

      readyOrders.push({
        rowKey,
        uniqueId,
        duplicateKey,
        orderNumber,
        orderDate,
        quantity: safeQty,
        itemDescription,
        itemPrice,
        total,
        shippedTo,
        paymentMethod,
        status,
        isRecon,
        category,
        expId,
        bankId,
        sourceOrigin: 'scan',
        sourceFileName: file.fileName,
        isDuplicate: false,
      });
    });
  }

  return {
    readyOrders,
    duplicateOrders,
    summary: {
      totalExtracted,
      duplicateSkipped: duplicateOrders.length,
      readyToSync: readyOrders.length,
      savedInSheet: existingSheetIds.size,
    },
  };
}
