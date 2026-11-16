import {
  ExpenseCsvColumnMapping,
  ExpenseLookups,
  ExpenseRecord,
  StagedExpenseBatchSummary,
  UploadedExpenseCsv,
} from '../types/expense';
import { normalizeDate, parseSignedAmount } from './statementProcessor';

export const TREAT_AS_ACTUAL_SENTINEL = '__TREAT_AS_ACTUAL__';

function findBestHeader(headers: string[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = headers.find((h) => pattern.test(h.trim().toLowerCase()));
    if (match) return match;
  }
  return '';
}

export function detectExpenseCsvMapping(headers: string[]): {
  mapping: ExpenseCsvColumnMapping;
  status: 'auto' | 'needs-mapping';
} {
  const expIdCol = findBestHeader(headers, [
    /^(exp_?id|expense_?id|unique_?id|item_?id|request_?id|record_?id)$/,
    /\b(exp_?id|expense\s*id|unique\s*id)\b/,
    /^id$/,
  ]);

  const dateCol = findBestHeader(headers, [
    /^(date|expense\s*date|transaction\s*date|paid\s*date|submitted\s*date)$/,
    /\bdate\b/,
  ]);

  const amountCol = findBestHeader(headers, [
    /^(amount|expense\s*amount|total\s*amount|cost|amt)$/,
    /\b(amount|amt|total|cost)\b/,
  ]);

  const categoryCol = findBestHeader(headers, [
    /^(category|expense\s*category|cat)$/,
    /\bcategory\b/,
  ]);

  const subCategoryCol = findBestHeader(headers, [
    /^(sub[\s_-]*category|sub[\s_-]*cat)$/,
    /\bsub[\s_-]*cat/,
  ]);

  const descriptionCol = findBestHeader(headers, [
    /^(description|expense\s*description|item\s*description|details|memo|purpose|notes)$/,
    /\b(description|details|memo|purpose|item)\b/,
  ]);

  const statusCol = findBestHeader(headers, [
    /^(status|payment\s*status|expense\s*status|approval\s*status)$/,
    /\bstatus\b/,
  ]);

  const requestTypeCol = findBestHeader(headers, [
    /^(request[\s_-]*type|req[\s_-]*type|expense[\s_-]*type|record[\s_-]*type)$/,
    /\brequest[\s_-]*type\b/,
    /^type$/,
  ]);

  const pujaCol = findBestHeader(headers, [
    /^(puja|puja\s*name|event|occasion)$/,
    /\bpuja\b/,
  ]);

  const paymentModeCol = findBestHeader(headers, [
    /^(payment[\s_-]*mode|payment[\s_-]*method|pay[\s_-]*mode|mode)$/,
    /\bpayment[\s_-]*(mode|method)\b/,
  ]);

  const reconSourceCol = findBestHeader(headers, [
    /^(recon[\s_-]*source)$/,
    /\brecon[\s_-]*source\b/,
  ]);

  const reconSourceIdCol = findBestHeader(headers, [
    /^(recon[\s_-]*source[\s_-]*id)$/,
    /\brecon[\s_-]*source[\s_-]*id\b/,
  ]);

  const mapping: ExpenseCsvColumnMapping = {
    expIdCol,
    dateCol,
    amountCol,
    categoryCol,
    subCategoryCol,
    descriptionCol,
    statusCol,
    requestTypeCol,
    pujaCol,
    paymentModeCol,
    reconSourceCol,
    reconSourceIdCol,
  };

  const isComplete =
    Boolean(dateCol) &&
    Boolean(amountCol) &&
    Boolean(categoryCol) &&
    Boolean(descriptionCol) &&
    Boolean(statusCol) &&
    Boolean(requestTypeCol);

  return {
    mapping,
    status: isComplete ? 'auto' : 'needs-mapping',
  };
}

async function sha256Hex12(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 12).toUpperCase();
}

function matchLookupCasing(value: string, allowed: string[]): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = allowed.find((opt) => opt.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}

export function getSubCategoryOptions(
  category: string,
  catSubcatMap: Record<string, string[]>
): string[] {
  const cat = category.replace(/\s+/g, ' ').trim();
  if (!cat) return [];
  const lower = cat.toLowerCase();
  const keys = Object.keys(catSubcatMap);

  const exactKey = keys.find((k) => k.replace(/\s+/g, ' ').trim().toLowerCase() === lower);
  if (exactKey) return catSubcatMap[exactKey];

  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (!compact) return [];
  const fuzzyKey = keys.find(
    (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === compact
  );
  return fuzzyKey ? catSubcatMap[fuzzyKey] : [];
}

export function generateManualExpenseId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const randPart = crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase();
    const candidate = `EXP-${timePart}-${randPart}`;
    if (!existingIds.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `EXP-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

export async function processExpenseCsvs(
  files: UploadedExpenseCsv[],
  existingSheetIds: Set<string>,
  lookups: ExpenseLookups
): Promise<{
  stagedRecords: ExpenseRecord[];
  summary: StagedExpenseBatchSummary;
}> {
  let totalRawRows = 0;
  let filteredOutByTypeOrStatus = 0;
  let skippedInvalidRows = 0;
  let duplicateIdsRemoved = 0;

  const seenIds = new Set<string>();
  for (const id of existingSheetIds) {
    seenIds.add(id.toLowerCase());
  }

  const stagedRecords: ExpenseRecord[] = [];

  for (const file of files) {
    if (file.mappingStatus === 'needs-mapping') {
      totalRawRows += file.rawRows.length;
      continue;
    }

    const { mapping } = file;
    const perFileIdentityCounts = new Map<string, number>();

    for (const row of file.rawRows) {
      totalRawRows++;

      const requestTypeRaw =
        mapping.requestTypeCol === TREAT_AS_ACTUAL_SENTINEL
          ? 'Actual'
          : (row[mapping.requestTypeCol] ?? '').trim();
      const statusRaw = (row[mapping.statusCol] ?? '').trim();

      const reqNorm = requestTypeRaw.toLowerCase();
      const statusNorm = statusRaw.toLowerCase();

      // Task 8: Filter only Request Type === "Actual" AND Status === "Accepted" or "Paid"
      const passesFilter =
        reqNorm === 'actual' && (statusNorm === 'accepted' || statusNorm === 'paid');

      if (!passesFilter) {
        filteredOutByTypeOrStatus++;
        continue;
      }

      const rawDate = (row[mapping.dateCol] ?? '').trim();
      const normalizedDate = normalizeDate(rawDate);
      const amount = parseSignedAmount(row[mapping.amountCol] ?? '');
      const description = (row[mapping.descriptionCol] ?? '').trim().replace(/\s+/g, ' ');
      const categoryRaw = (row[mapping.categoryCol] ?? '').trim();

      if (!normalizedDate || amount === null || !description || !categoryRaw) {
        skippedInvalidRows++;
        continue;
      }

      const category = matchLookupCasing(categoryRaw, lookups.categories);
      const status = matchLookupCasing(statusRaw, lookups.statuses);

      const subCatRaw = mapping.subCategoryCol ? (row[mapping.subCategoryCol] ?? '').trim() : '';
      const subCatOptions = getSubCategoryOptions(category, lookups.catSubcatMap);
      const subCategory = matchLookupCasing(subCatRaw, subCatOptions);

      const pujaRaw = mapping.pujaCol ? (row[mapping.pujaCol] ?? '').trim() : '';
      const puja = matchLookupCasing(pujaRaw, lookups.pujas);

      const payModeRaw = mapping.paymentModeCol ? (row[mapping.paymentModeCol] ?? '').trim() : '';
      const paymentMode = matchLookupCasing(payModeRaw, lookups.paymentModes);

      const reconSource = mapping.reconSourceCol
        ? (row[mapping.reconSourceCol] ?? '').trim()
        : '';
      const reconSourceId = mapping.reconSourceIdCol
        ? (row[mapping.reconSourceIdCol] ?? '').trim()
        : '';

      const providedId = mapping.expIdCol ? (row[mapping.expIdCol] ?? '').trim() : '';
      let expId = providedId;

      if (!expId) {
        const amountCents = Math.round(amount * 100);
        const identity = `${normalizedDate}|${amountCents}|${category.toUpperCase()}|${description.toUpperCase()}`;
        const occ = (perFileIdentityCounts.get(identity) || 0) + 1;
        perFileIdentityCounts.set(identity, occ);
        const hash = await sha256Hex12(`${identity}|${occ}`);
        expId = `EXP-${hash}`;
      }

      const idKey = expId.toLowerCase();
      if (seenIds.has(idKey)) {
        duplicateIdsRemoved++;
        continue;
      }
      seenIds.add(idKey);

      stagedRecords.push({
        sheetRowNumber: null,
        expId,
        date: normalizedDate,
        amount: Math.abs(amount),
        category,
        subCategory,
        description,
        status,
        puja,
        paymentMode,
        reconSource,
        reconSourceId,
        sourceOrigin: 'csv',
        sourceFileName: file.fileName,
      });
    }
  }

  return {
    stagedRecords,
    summary: {
      totalRawRows,
      filteredOutByTypeOrStatus,
      skippedInvalidRows,
      duplicateIdsRemoved,
      readyToSync: stagedRecords.length,
    },
  };
}
