import {
  NormalizedTransaction,
  PipelineSummary,
  TransactionType,
  UploadedStatement,
} from '../types/statement';

const MONTHS: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function expandYear(yearStr: string): number {
  const num = parseInt(yearStr, 10);
  if (yearStr.length === 2) {
    return num >= 70 ? 1900 + num : 2000 + num;
  }
  return num;
}

export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s.*)?$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }
  }

  // MM/DD/YYYY or MM-DD-YYYY or M/D/YY
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:\s.*)?$/);
  if (m) {
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    const y = expandYear(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }
  }

  // DD-MMM-YYYY or DD MMM YYYY (e.g. 15-Nov-2026)
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,](\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    const d = parseInt(m[1], 10);
    const y = expandYear(m[3]);
    if (mo && d >= 1 && d <= 31) {
      return `${y}-${mo}-${pad2(d)}`;
    }
  }

  // MMM DD, YYYY (e.g. Nov 15, 2026)
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d = parseInt(m[2], 10);
    const y = expandYear(m[3]);
    if (mo && d >= 1 && d <= 31) {
      return `${y}-${mo}-${pad2(d)}`;
    }
  }

  return null;
}

export function parseSignedAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s || s === '-' || s === '--') return null;

  let negative = false;
  let cleaned = s;

  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.endsWith('-')) {
    negative = true;
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.startsWith('-')) {
    negative = !negative;
    cleaned = cleaned.slice(1);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }

  cleaned = cleaned.replace(/[$,\s]/g, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const value = parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

export function normalizeCheckNumber(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw.trim().replace(/^#+/, '');
  if (!cleaned || /^(0+|n\/?a|none|-+)$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

export function extractReferenceNumber(description: string, checkNumber?: string): string {
  const cleanCheck = normalizeCheckNumber(checkNumber);
  if (cleanCheck) {
    return cleanCheck;
  }

  // 1. Stripe IDs (ch_, pi_, po_, txn_, py_, re_, in_)
  const stripeMatch = description.match(/\b((?:ch|pi|po|txn|py|re|in)_[A-Za-z0-9]{6,})\b/);
  if (stripeMatch) {
    return stripeMatch[1];
  }

  // 2. Wire / Fed / IMAD / OMAD reference codes
  const wireMatch = description.match(
    /\b(?:IMAD|OMAD|FED\s*REF|TRN|SEQ)\s*[:#-]?\s*([A-Z0-9]{6,})\b/i
  );
  if (wireMatch) {
    return wireMatch[1];
  }

  // 3. Explicit Check reference inside description
  const checkInDesc = description.match(/\b(?:CHECK|CHK)\s*(?:#|NO\.?|NUMBER)?\s*(\d{3,10})\b/i);
  if (checkInDesc) {
    return checkInDesc[1];
  }

  // 4. Zelle / Bank confirmation, reference, trace, auth, or transaction ID tokens
  const taggedRef = description.match(
    /\b(?:CONF(?:IRMATION)?|REF(?:ERENCE)?|TRACE|AUTH|TXN|TRANS(?:ACTION)?|ZELLE\s*ID|ID)\s*(?:#|NO\.?)?\s*[:#-]?\s*([A-Z0-9-]{5,})\b/i
  );
  if (taggedRef) {
    return taggedRef[1];
  }

  // 5. Standalone hash-prefixed alphanumeric reference (e.g., #JPM99AB12 or #12345678)
  const hashRef = description.match(/(?:^|\s)#([A-Z0-9]{5,})\b/i);
  if (hashRef) {
    return hashRef[1];
  }

  return '';
}

const SOURCE_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Zelle', pattern: /\bzelle\b/i },
  { label: 'Stripe', pattern: /\bstripe\b/i },
  { label: 'SumUp', pattern: /\bsumup\b|\bsum\s+up\b/i },
  { label: 'Direct Pay-Payment', pattern: /direct\s*pay[-\s]*payment|\bdirect\s*pay\b/i },
  { label: 'Amazon', pattern: /\bamazon\b|\bamzn\b/i },
  { label: 'Home Depot', pattern: /home\s*depot|\bhomedepot\b/i },
  { label: 'Transfer', pattern: /\bonline\s+transfer\b/i },
  { label: 'Deposit', pattern: /\bedeposit\b/i },
  { label: 'CARD9130', pattern: /\bcard\s*9130\b/i },
  { label: 'CARD7574', pattern: /\bcard\s*7574\b/i },
  { label: 'WT', pattern: /\b(?:wt|wire|fedwire)\b/i },
  { label: 'Cash', pattern: /\bcash\b/i },
  { label: 'Check', pattern: /\bcheck\b/i },
  {
    label: 'Deposit',
    pattern: /\bdeposit\b|\bmobile\s*dep\b|\bremote\s*dep\b|\bcounter\s*credit\b/i,
  },
  {
    label: 'Withdrawal',
    pattern: /\bwithdrawal\b|\batm\s*wd\b/i,
  },
];

export function categorizeSource(description: string): string {
  for (const rule of SOURCE_RULES) {
    if (rule.pattern.test(description)) {
      return rule.label;
    }
  }
  return 'Other';
}

async function sha256Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16).toUpperCase();
}

export async function processStatements(
  statements: UploadedStatement[],
  resolutions: Record<string, 'kept-distinct' | 'discarded'>,
  syncedIds: Set<string>,
  existingSheetIds: Set<string>
): Promise<{
  transactions: NormalizedTransaction[];
  summary: PipelineSummary;
}> {
  let totalRawRows = 0;
  let validParsedRows = 0;
  let skippedInvalidRows = 0;
  let crossFileDuplicatesRemoved = 0;

  // Track global keys already accepted from earlier files so overlapping CSVs deduplicate cleanly
  const seenGlobalOccurrenceKeys = new Set<string>();
  const collected: NormalizedTransaction[] = [];

  for (const stmt of statements) {
    if (stmt.mappingStatus === 'needs-mapping') {
      totalRawRows += stmt.rawRows.length;
      continue;
    }

    const { mapping } = stmt;
    const perFileCounts = new Map<string, number>();

    for (let idx = 0; idx < stmt.rawRows.length; idx++) {
      const row = stmt.rawRows[idx];
      totalRawRows++;

      const normalizedDate = normalizeDate(row[mapping.dateCol] || '');
      const rawDesc = (row[mapping.descriptionCol] || '').trim().replace(/\s+/g, ' ');

      let amount: number | null = null;
      if (mapping.amountMode === 'single') {
        amount = parseSignedAmount(row[mapping.amountCol] || '');
      } else {
        const debitRaw = row[mapping.debitCol] || '';
        const creditRaw = row[mapping.creditCol] || '';
        const debitVal = parseSignedAmount(debitRaw);
        const creditVal = parseSignedAmount(creditRaw);

        if (debitVal !== null && Math.abs(debitVal) > 0) {
          amount = -Math.abs(debitVal);
        } else if (creditVal !== null && Math.abs(creditVal) > 0) {
          amount = Math.abs(creditVal);
        } else if (debitVal === 0 || creditVal === 0) {
          amount = 0;
        }
      }

      if (!normalizedDate || !rawDesc || amount === null) {
        skippedInvalidRows++;
        continue;
      }

      validParsedRows++;
      const amountCents = Math.round(amount * 100);
      const normalizedCheck = mapping.checkCol
        ? normalizeCheckNumber(row[mapping.checkCol])
        : '';

      const baseIdentity = `${normalizedDate}|${rawDesc.toUpperCase()}|${amountCents}|${normalizedCheck.toUpperCase()}`;
      const occurrenceIndex = (perFileCounts.get(baseIdentity) || 0) + 1;
      perFileCounts.set(baseIdentity, occurrenceIndex);

      const globalOccurrenceKey = `${baseIdentity}#${occurrenceIndex}`;

      // If an earlier uploaded statement already contained this exact occurrence, drop as cross-file overlap
      if (seenGlobalOccurrenceKeys.has(globalOccurrenceKey)) {
        crossFileDuplicatesRemoved++;
        continue;
      }
      seenGlobalOccurrenceKeys.add(globalOccurrenceKey);

      let reviewStatus: NormalizedTransaction['reviewStatus'] = 'ok';
      if (occurrenceIndex > 1) {
        const decision = resolutions[globalOccurrenceKey];
        reviewStatus = decision ?? 'flagged-duplicate';
      }

      const uniqueId = await sha256Hex16(`${baseIdentity}|${occurrenceIndex}`);
      const transactionType: TransactionType = amount >= 0 ? 'Income' : 'Expense';
      const referenceNumber = extractReferenceNumber(rawDesc, normalizedCheck);
      const source = categorizeSource(rawDesc);

      let syncStatus: NormalizedTransaction['syncStatus'] = 'pending';
      if (syncedIds.has(uniqueId)) {
        syncStatus = 'newly-synced';
      } else if (existingSheetIds.has(uniqueId)) {
        syncStatus = 'already-in-sheet';
      }

      collected.push({
        rowKey: `${stmt.id}-${idx}-${globalOccurrenceKey}`,
        flagKey: globalOccurrenceKey,
        uniqueId,
        date: normalizedDate,
        amount,
        amountCents,
        transactionType,
        description: rawDesc,
        referenceNumber,
        source,
        sourceFile: stmt.fileName,
        occurrenceIndex,
        reviewStatus,
        syncStatus,
      });
    }
  }

  let flaggedForReview = 0;
  let keptDistinct = 0;
  let discarded = 0;
  let readyToSync = 0;
  let alreadyInSheet = 0;
  let newlySynced = 0;

  for (const tx of collected) {
    if (tx.reviewStatus === 'flagged-duplicate') {
      flaggedForReview++;
    } else if (tx.reviewStatus === 'kept-distinct') {
      keptDistinct++;
    } else if (tx.reviewStatus === 'discarded') {
      discarded++;
    }

    const isEligible = tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct';
    if (isEligible) {
      if (tx.syncStatus === 'newly-synced') {
        newlySynced++;
      } else if (tx.syncStatus === 'already-in-sheet') {
        alreadyInSheet++;
      } else {
        readyToSync++;
      }
    }
  }

  return {
    transactions: collected,
    summary: {
      totalRawRows,
      validParsedRows,
      skippedInvalidRows,
      crossFileDuplicatesRemoved,
      flaggedForReview,
      keptDistinct,
      discarded,
      readyToSync,
      alreadyInSheet,
      newlySynced,
    },
  };
}
