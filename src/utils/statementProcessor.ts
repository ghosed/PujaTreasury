import type { CheckRecord } from '../types/check.ts';
import type {
  NormalizedTransaction,
  PipelineSummary,
  TransactionType,
  UploadedStatement,
} from '../types/statement.ts';

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

function extractDirectPayTranId(description: string): string {
  const match = description.match(
    /\bTRAN(?:S(?:ACTION)?)?\s*(?:ID|NO\.?|NUMBER)\b\s*[:#-]?\s*([A-Z0-9-]{4,})\b|\bTRAN(?:S(?:ACTION)?)?\s*[:#]\s*([A-Z0-9-]{4,})\b/i
  );
  return match ? match[1] || match[2] || '' : '';
}

export function extractReferenceNumber(
  description: string,
  checkNumber?: string,
  sourceHint?: string
): string {
  const cleanCheck = normalizeCheckNumber(checkNumber);
  if (cleanCheck) {
    return cleanCheck;
  }

  const trimmedDesc = description.trim();
  const isWire =
    /\b(?:wt|wire|fedwire)\b/i.test(trimmedDesc) ||
    /\b(?:wt|wire|fedwire)\b/i.test(sourceHint ?? '');

  // 1. WT / WIRE: use the number/code following TRN as Reference #
  if (isWire) {
    const trnMatch = trimmedDesc.match(/\bTRN\s*(?:NO\.?)?\s*[:#-]?\s*([A-Z0-9-]{4,})\b/i);
    if (trnMatch) {
      return trnMatch[1];
    }
  }

  // 1b. Direct Pay-Payment: use the Tran ID as Reference #
  const isDirectPay =
    /direct\s*pay[-\s]*payment|\bdirect\s*pay\b/i.test(trimmedDesc) ||
    /direct\s*pay/i.test(sourceHint ?? '');
  if (isDirectPay) {
    const tranId = extractDirectPayTranId(trimmedDesc);
    if (tranId) {
      return tranId;
    }
  }

  // 2. Descriptions ending with "CARD 7574" or "CARD 9130": use the 16 characters preceding it
  const cardEndMatch = trimmedDesc.match(/^(.*?)\s*\bCARD\s*(?:7574|9130)\s*$/i);
  if (cardEndMatch) {
    const prefix = cardEndMatch[1].trimEnd();
    const ref16 = prefix.length >= 16 ? prefix.slice(-16).trim() : prefix.trim();
    if (ref16) {
      return ref16;
    }
  }

  // 3. Deposits: Mobile/eDeposit ("Ref Number :") vs Branch/Store ("BRANCH")
  const isDeposit =
    /\b(?:edeposit|mobile\s*(?:check\s*)?dep(?:osit)?|deposit|counter\s*credit)\b/i.test(
      trimmedDesc
    ) || /^deposit$/i.test((sourceHint ?? '').trim());

  if (isDeposit) {
    const depositRefMatch = trimmedDesc.match(
      /\bRef(?:erence)?\s*(?:Number|Num|No\.?)\s*:\s*([A-Z0-9-]+)\b/i
    );
    if (depositRefMatch) {
      return depositRefMatch[1];
    }
    if (/\b(?:branch|store)\b/i.test(trimmedDesc)) {
      return 'BRANCH';
    }
  }

  // 4. Stripe IDs (ch_, pi_, po_, txn_, py_, re_, in_)
  const stripeMatch = trimmedDesc.match(/\b((?:ch|pi|po|txn|py|re|in)_[A-Za-z0-9]{6,})\b/);
  if (stripeMatch) {
    return stripeMatch[1];
  }

  // 5. Wire / Fed / IMAD / OMAD / SEQ fallback
  const wireMatch = trimmedDesc.match(
    /\b(?:IMAD|OMAD|FED\s*REF|TRN|SEQ)\s*[:#-]?\s*([A-Z0-9]{6,})\b/i
  );
  if (wireMatch) {
    return wireMatch[1];
  }

  // 6. Explicit Check reference inside description
  const checkInDesc = trimmedDesc.match(/\b(?:CHECK|CHK)\s*(?:#|NO\.?|NUMBER)?\s*(\d{3,10})\b/i);
  if (checkInDesc) {
    return checkInDesc[1];
  }

  // 7. Zelle / Bank confirmation, ref number, reference, trace, auth, tran ID, or transaction ID tokens
  const taggedRef = trimmedDesc.match(
    /\b(?:CONF(?:IRMATION)?|REF(?:ERENCE)?(?:\s*NUMBER)?|TRACE|AUTH|TRAN(?:\s*ID)?|TXN(?:\s*ID)?|TRANS(?:ACTION)?(?:\s*ID)?|ZELLE\s*ID|ID)\s*(?:#|NO\.?)?\s*[:#-]?\s*([A-Z0-9-]{5,})\b/i
  );
  if (taggedRef) {
    return taggedRef[1];
  }

  // 8. Standalone hash-prefixed alphanumeric reference (e.g., #JPM99AB12 or #12345678)
  const hashRef = trimmedDesc.match(/(?:^|\s)#([A-Z0-9]{5,})\b/i);
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
  { label: 'WT', pattern: /\b(?:wt|wire|fedwire)\b/i },
  {
    label: 'ACC-T',
    pattern: /\bonline\s+(?:banking\s+)?transfer\b|\baccount\s+transfer\b/i,
  },
  { label: 'Deposit', pattern: /\bedeposit\b|\bmobile\s*(?:check\s*)?dep(?:osit)?\b/i },
  { label: 'CARD9130', pattern: /\bcard\s*9130\b/i },
  { label: 'CARD7574', pattern: /\bcard\s*7574\b/i },
  { label: 'Cash', pattern: /\bcash\b/i },
  { label: 'Check', pattern: /\bcheck\b/i },
  {
    label: 'Deposit',
    pattern: /\bdeposit\b|\bremote\s*dep\b|\bcounter\s*credit\b/i,
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

const US_STATE_CODES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

const CARD_TRAIL_CITIES_TX =
  'HOUSTON|KATY|SUGAR\\s+LAND|CYPRESS|PEARLAND|RICHMOND|STAFFORD|SPRING|MISSOURI\\s+CITY|ROSENBERG|FULSHEAR|THE\\s+WOODLANDS|PASADENA|BELLAIRE|AUSTIN|DALLAS|SAN\\s+ANTONIO';

export function extractCardVendorName(description: string): string {
  const authMatch = description.match(
    /\bAUTHORIZED\s+ON\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+(.+)$/i
  );
  if (!authMatch) return '';

  let vendor = authMatch[1].trim();
  // Remove trailing "CARD 9130" or "CARD 7574"
  vendor = vendor.replace(/\s+CARD\s*(?:9130|7574)\s*$/i, '').trim();
  // Remove trailing card transaction ID (e.g., S466310066835954, P586269825040169)
  vendor = vendor.replace(/\s+(?:[A-Z]\d{8,}[A-Z0-9]*|(?=[A-Z0-9]*\d{6,})[A-Z0-9]{12,})\s*$/i, '').trim();

  // Strip trailing store number (e.g., "#03306* KATY TX")
  vendor = vendor.replace(/\s+#\d[\w*-]*.*$/, '');
  // Strip trailing phone number and following location/state (e.g., "713-4531616 TX")
  vendor = vendor.replace(/\s+(?:\(\d{3}\)\s*|\d{3}[-.\s]?)\d{3}[-.\s]?\d{4}\b.*$/, '');
  // Strip trailing known Texas city + TX or trailing 2-letter US state code
  vendor = vendor.replace(
    new RegExp(`(?:,\\s*|\\s+)(?:${CARD_TRAIL_CITIES_TX})\\s+TX\\s*$`, 'i'),
    ''
  );
  vendor = vendor.replace(new RegExp(`\\s+(?:${US_STATE_CODES})\\s*$`), '');

  return vendor.replace(/[\s,-]+$/, '').trim();
}

export function extractNotes(description: string, sourceHint?: string): string {
  if (/\bamazon\b|\bamzn\b/i.test(description)) {
    return 'Amazon';
  }
  if (/home\s*depot|\bhomedepot\b/i.test(description)) {
    return 'Home Depot';
  }

  const effectiveSource = (sourceHint ?? categorizeSource(description)).trim().toUpperCase();
  if (effectiveSource === 'CARD9130' || effectiveSource === 'CARD7574') {
    return extractCardVendorName(description);
  }

  return '';
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

      const uniqueId = await sha256Hex16(`${baseIdentity}|${occurrenceIndex}`);

      let reviewStatus: NormalizedTransaction['reviewStatus'] = 'ok';
      if (occurrenceIndex > 1 && !existingSheetIds.has(uniqueId) && !syncedIds.has(uniqueId)) {
        const decision = resolutions[globalOccurrenceKey];
        reviewStatus = decision ?? 'flagged-duplicate';
      }

      const transactionType: TransactionType = amount >= 0 ? 'Income' : 'Expense';
      const source = categorizeSource(rawDesc);
      const referenceNumber = extractReferenceNumber(rawDesc, normalizedCheck, source);
      const notes = extractNotes(rawDesc, source);

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
        notes,
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

export const DEFAULT_BANK_LEDGER_BANK = 'Wells Fargo';

export function normalizeCheckNumberForMatch(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw.trim().replace(/^#+/, '').replace(/\s+/g, '');
  if (!cleaned || /^(0+|n\/?a|none|-+)$/i.test(cleaned)) {
    return '';
  }
  return cleaned.replace(/^0+(?=\d)/, '').toUpperCase();
}

export function normalizeBankNameForMatch(raw?: string): string {
  const lower = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!lower) return '';

  if (lower === 'wf' || lower.includes('wells fargo') || lower.includes('wellsfargo')) {
    return 'wellsfargo';
  }
  if (lower === 'bofa' || lower.includes('bank of america') || lower.includes('bankofamerica')) {
    return 'bankofamerica';
  }
  if (lower.includes('jpmorgan chase') || lower === 'chase' || lower.startsWith('chase ')) {
    return 'chase';
  }

  const genericSuffixes = new Set([
    'bank',
    'na',
    'n',
    'a',
    'national',
    'association',
    'inc',
    'llc',
    'corp',
    'co',
    'puja',
    'regular',
    'checking',
    'account',
  ]);
  const tokens = lower.split(' ').filter((t) => t && !genericSuffixes.has(t));
  return tokens.join('') || lower.replace(/\s+/g, '');
}

export function isBankCheckTransaction(
  tx: Pick<NormalizedTransaction, 'source' | 'description'>
): boolean {
  const srcLower = tx.source.trim().toLowerCase();
  const desc = tx.description.trim();
  if (srcLower === 'check') return true;
  if ((srcLower === '' || srcLower === 'other') && categorizeSource(desc) === 'Check') {
    return true;
  }
  return /^\s*check\b/i.test(desc) && srcLower !== 'deposit';
}

export function extractBankTxCheckNumber(
  tx: Pick<NormalizedTransaction, 'referenceNumber' | 'description'>
): string {
  const fromRef = normalizeCheckNumberForMatch(tx.referenceNumber);
  if (fromRef) return fromRef;
  const descMatch = tx.description
    .trim()
    .match(/\b(?:CHECK|CHK)\s*(?:#|NO\.?|NUMBER)?\s*(\d{2,12})\b/i);
  return descMatch ? normalizeCheckNumberForMatch(descMatch[1]) : '';
}

export function buildMatchedCheckDescription(paidTo: string, memo: string): string {
  const cleanPaidTo = paidTo.trim().replace(/\s+/g, ' ');
  const cleanMemo = memo.trim().replace(/\s+/g, ' ');
  if (!cleanPaidTo && !cleanMemo) {
    return '';
  }
  return ['CHECK', cleanPaidTo, cleanMemo].filter(Boolean).join(' ');
}

function parseIsoDays(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
}

export function findMatchingCheckRecord(
  tx: Pick<
    NormalizedTransaction,
    'source' | 'description' | 'referenceNumber' | 'transactionType' | 'amountCents' | 'date' | 'bank'
  >,
  checkRecords: CheckRecord[],
  defaultBankName: string = DEFAULT_BANK_LEDGER_BANK
): CheckRecord | null {
  if (!checkRecords.length || !isBankCheckTransaction(tx)) return null;

  const txCheckNum = extractBankTxCheckNumber(tx);
  if (!txCheckNum) return null;

  const txBankNorm = normalizeBankNameForMatch(tx.bank || defaultBankName);
  if (!txBankNorm) return null;

  const candidates = checkRecords.filter((chk) => {
    if (chk.isDuplicate) return false;
    const chkNum = normalizeCheckNumberForMatch(chk.checkNumber);
    const chkBankNorm = normalizeBankNameForMatch(chk.bank);
    return Boolean(chkNum && chkBankNorm && chkNum === txCheckNum && chkBankNorm === txBankNorm);
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const txAbsCents = Math.abs(tx.amountCents);
  const txDays = parseIsoDays(tx.date);

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const chk of candidates) {
    let score = 0;
    if (chk.transactionType === tx.transactionType) score += 100;
    if (chk.amountCents > 0 && chk.amountCents === txAbsCents) score += 100;
    if (chk.paidTo.trim()) score += 20;
    if (chk.memo.trim()) score += 10;
    if (txDays !== null) {
      const chkDays = parseIsoDays(chk.date);
      if (chkDays !== null) {
        const diff = Math.abs(txDays - chkDays);
        score -= Math.min(diff, 365) * 0.05;
        if (chkDays <= txDays) score += 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = chk;
    }
  }

  return best;
}

export function resolveCheckLedgerDescription(
  tx: Pick<
    NormalizedTransaction,
    'source' | 'description' | 'referenceNumber' | 'transactionType' | 'amountCents' | 'date' | 'bank'
  >,
  checkRecords: CheckRecord[],
  defaultBankName: string = DEFAULT_BANK_LEDGER_BANK
): string | null {
  const matched = findMatchingCheckRecord(tx, checkRecords, defaultBankName);
  if (!matched) return null;
  const built = buildMatchedCheckDescription(matched.paidTo, matched.memo);
  return built || null;
}

export interface BankRuleBackfillUpdate {
  sheetRowNumber: number;
  description?: string;
  referenceNumber?: string;
  source?: string;
  notes?: string;
}

export function findBankRuleBackfillUpdates(
  transactions: NormalizedTransaction[],
  checkRecords: CheckRecord[] = [],
  defaultBankName: string = DEFAULT_BANK_LEDGER_BANK
): BankRuleBackfillUpdate[] {
  const updates: BankRuleBackfillUpdate[] = [];

  for (const tx of transactions) {
    if (!tx.sheetRowNumber || tx.sheetRowNumber < 1) continue;
    const desc = tx.description.trim();
    if (!desc) continue;

    const patch: BankRuleBackfillUpdate = { sheetRowNumber: tx.sheetRowNumber };
    let changed = false;

    const isCheckTx = isBankCheckTransaction(tx);

    // 0. Check_Ledger match: replace Check Description with "CHECK <Paid To> <Memo / For>"
    const matchedCheckDesc =
      checkRecords.length > 0
        ? resolveCheckLedgerDescription(tx, checkRecords, defaultBankName)
        : null;
    if (matchedCheckDesc && desc !== matchedCheckDesc) {
      patch.description = matchedCheckDesc;
      changed = true;
    }

    const effectiveDesc = matchedCheckDesc ?? desc;

    // 1. Source: Merge WIRE -> WT, rename Transfer -> ACC-T, and re-categorize legacy Amazon, Home Depot, empty, or Other sources
    const currSrcLower = tx.source.trim().toLowerCase();
    let nextSource = tx.source;
    if (currSrcLower === 'wire') {
      nextSource = 'WT';
    } else if (currSrcLower === 'transfer') {
      nextSource = 'ACC-T';
    } else if (
      currSrcLower === 'amazon' ||
      currSrcLower === 'home depot' ||
      currSrcLower === 'other' ||
      currSrcLower === ''
    ) {
      nextSource = isCheckTx ? 'Check' : categorizeSource(desc);
    }
    if (nextSource !== tx.source) {
      patch.source = nextSource;
      changed = true;
    }

    // 2. Notes: Amazon, Home Depot, or Vendor Name for CARD9130 / CARD7574
    const expectedNote = extractNotes(effectiveDesc, nextSource);
    const currentNotes = (tx.notes ?? '').trim();
    const hasProtectedVendorNote = /\bamazon\b|home\s*depot/i.test(currentNotes);
    if (expectedNote && !hasProtectedVendorNote && currentNotes !== expectedNote && !currentNotes) {
      patch.notes = expectedNote;
      changed = true;
    }

    // 3. Reference # rules: WT/WIRE TRN, Direct Pay Tran ID, ending CARD 7574/9130, Branch/Store Deposit, Mobile Deposit Ref Number
    const isWire = !isCheckTx && /\b(?:wt|wire|fedwire)\b/i.test(`${nextSource} ${desc}`);
    const hasTrn = /\bTRN\s*(?:NO\.?)?\s*[:#-]?\s*([A-Z0-9-]{4,})\b/i.test(desc);
    const isDirectPay =
      !isCheckTx &&
      (/direct\s*pay[-\s]*payment|\bdirect\s*pay\b/i.test(desc) ||
        /direct\s*pay/i.test(nextSource));
    const hasDirectPayTranId = isDirectPay && Boolean(extractDirectPayTranId(desc));
    const endsWithCard = !isCheckTx && /\bCARD\s*(?:7574|9130)\s*$/i.test(desc);
    const isDeposit =
      !isCheckTx &&
      (/\b(?:edeposit|mobile\s*(?:check\s*)?dep(?:osit)?|deposit|counter\s*credit)\b/i.test(
        desc
      ) ||
        /^deposit$/i.test(nextSource));
    const hasDepositRef =
      isDeposit && /\bRef(?:erence)?\s*(?:Number|Num|No\.?)\s*:\s*([A-Z0-9-]+)\b/i.test(desc);
    const isBranchDeposit = isDeposit && !hasDepositRef && /\b(?:branch|store)\b/i.test(desc);

    if (
      (isWire && hasTrn) ||
      hasDirectPayTranId ||
      endsWithCard ||
      isBranchDeposit ||
      hasDepositRef
    ) {
      const expectedRef = extractReferenceNumber(desc, undefined, nextSource);
      if (expectedRef && tx.referenceNumber.trim() !== expectedRef) {
        patch.referenceNumber = expectedRef;
        changed = true;
      }
    }

    if (changed) {
      updates.push(patch);
    }
  }

  return updates;
}

