import {
  CheckPipelineSummary,
  CheckRecord,
  CheckTransactionType,
  RawExtractedCheck,
  UploadedCheckFile,
} from '../types/check';
import { normalizeDate } from './statementProcessor';

export function deriveCheckTransactionType(paidBy: string): CheckTransactionType {
  const normalized = paidBy
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = normalized.replace(/\s+/g, '');

  if (
    normalized.includes('houston durgabari society') ||
    compact.includes('houstondurgabarisociety')
  ) {
    return 'Expense';
  }
  return 'Income';
}

function sanitizeIdToken(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

export function normalizeCheckNumber(raw: string): string {
  return raw.trim().replace(/^#/, '').replace(/\s+/g, '');
}

export function normalizeCheckDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const iso = normalizeDate(trimmed);
  return iso || trimmed;
}

export function buildCheckUniqueId(
  checkNumber: string,
  bank: string,
  date: string
): string {
  const normCheck = sanitizeIdToken(normalizeCheckNumber(checkNumber), 'NOCHK');
  const normBank = sanitizeIdToken(bank, 'NOBANK');
  const normDate = normalizeCheckDate(date) || 'NODATE';
  return `${normCheck}-${normBank}-${normDate}`;
}

export function buildCheckCanonicalKey(
  checkNumber: string,
  bank: string,
  date: string
): string {
  const rawCheck = normalizeCheckNumber(checkNumber).toUpperCase();
  const strippedCheck = rawCheck.replace(/^0+(?=\d)/, '') || rawCheck || 'NOCHK';
  const normBank = bank
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
  const normDate = normalizeCheckDate(date);
  return `${strippedCheck}::${normBank || 'NOBANK'}::${normDate || 'NODATE'}`;
}

export function processScannedCheckFiles(
  files: UploadedCheckFile[],
  existingSheetIds: Set<string>,
  existingCanonicalKeys: Set<string>,
  overrides: Record<string, Partial<CheckRecord>> = {}
): {
  readyChecks: CheckRecord[];
  duplicateChecks: CheckRecord[];
  summary: CheckPipelineSummary;
} {
  const readyChecks: CheckRecord[] = [];
  const duplicateChecks: CheckRecord[] = [];
  const seenIds = new Set<string>(existingSheetIds);
  const seenCanonical = new Set<string>(existingCanonicalKeys);
  let totalExtracted = 0;

  for (const file of files) {
    if (file.status !== 'ready') continue;
    file.extractedChecks.forEach((raw: RawExtractedCheck, idx: number) => {
      totalExtracted++;
      const rowKey = `scan-${file.id}-${idx}`;
      const ov = overrides[rowKey];

      const checkNumber = (ov?.checkNumber ?? raw.checkNumber ?? '').trim();
      const bank = (ov?.bank ?? raw.bank ?? '').trim();
      const date = normalizeCheckDate(ov?.date ?? raw.date ?? '');
      const amountNum =
        typeof ov?.amount === 'number'
          ? ov.amount
          : Number.isFinite(raw.amount)
            ? raw.amount
            : 0;
      const amountCents = Math.round(Math.abs(amountNum) * 100);
      const amount = amountCents / 100;
      const paidTo = (ov?.paidTo ?? raw.paidTo ?? '').trim();
      const paidBy = (ov?.paidBy ?? raw.paidBy ?? '').trim();
      const memo = (ov?.memo ?? raw.memo ?? '').trim();
      const transactionType =
        ov?.transactionType ?? deriveCheckTransactionType(paidBy);
      const isRecon: 'Yes' | 'No' = ov?.isRecon === 'Yes' ? 'Yes' : 'No';

      const uniqueId = buildCheckUniqueId(checkNumber, bank, date);
      const canonicalKey = buildCheckCanonicalKey(checkNumber, bank, date);
      const idLower = uniqueId.toLowerCase();

      const isDupInSheet =
        existingSheetIds.has(idLower) || existingCanonicalKeys.has(canonicalKey);
      const isDupInBatch =
        !isDupInSheet && (seenIds.has(idLower) || seenCanonical.has(canonicalKey));

      if (isDupInSheet || isDupInBatch) {
        duplicateChecks.push({
          rowKey,
          uniqueId,
          canonicalKey,
          checkNumber,
          bank,
          date,
          amount,
          amountCents,
          paidTo,
          paidBy,
          memo,
          transactionType,
          isRecon,
          sourceOrigin: 'scan',
          sourceFileName: file.fileName,
          isDuplicate: true,
          duplicateReason: isDupInSheet
            ? 'Already recorded in Check_Ledger'
            : 'Duplicate check copy in uploaded files',
        });
        return;
      }

      seenIds.add(idLower);
      seenCanonical.add(canonicalKey);

      readyChecks.push({
        rowKey,
        uniqueId,
        canonicalKey,
        checkNumber,
        bank,
        date,
        amount,
        amountCents,
        paidTo,
        paidBy,
        memo,
        transactionType,
        isRecon,
        sourceOrigin: 'scan',
        sourceFileName: file.fileName,
        isDuplicate: false,
      });
    });
  }

  return {
    readyChecks,
    duplicateChecks,
    summary: {
      totalExtracted,
      duplicateSkipped: duplicateChecks.length,
      readyToSync: readyChecks.length,
      savedInSheet: existingSheetIds.size,
    },
  };
}
