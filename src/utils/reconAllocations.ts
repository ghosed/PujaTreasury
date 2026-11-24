import { ExpenseRecord } from '../types/expense';
import {
  AllocationStatus,
  AllocationSummary,
  NewReconLinkInput,
  ReconCardinality,
  ReconLink,
  ReconTargetType,
} from '../types/reconciliation';
import { AccountType } from '../types/statement';
import {
  BankLedgerEntry,
  LinkedBankFieldPatch,
  LinkedExpenseFieldPatch,
} from './reconciler';

export const RECON_PENNY_TOLERANCE_CENTS = 1;
export const MULTIPLE_CATEGORY_LABEL = 'Multiple';

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Parses a search query representing an exact dollar amount (e.g. "352",
 * "352.00", "$1,851.43", "-$516.42", ".50") into positive cents, or returns
 * null if the query is not a pure numeric/currency amount.
 */
export function parseExactAmountQueryCents(rawQuery: string): number | null {
  const trimmed = rawQuery.trim();
  if (!trimmed) return null;
  if (
    !/^[+-]?\$?\s*(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\.\d{1,2})$/.test(
      trimmed
    )
  ) {
    return null;
  }
  const numericStr = trimmed.replace(/[$,\s]/g, '');
  const parsed = Number(numericStr);
  if (!Number.isFinite(parsed)) return null;
  return toCents(Math.abs(parsed));
}

export function parseIdList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const parts = String(raw)
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(part);
    }
  }
  return out;
}

export function formatIdList(ids: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join(', ');
}

export function reconPairKey(
  bankUniqueId: string,
  targetType: ReconTargetType,
  targetId: string
): string {
  return `${bankUniqueId.trim().toLowerCase()}::${targetType}::${targetId.trim().toLowerCase()}`;
}

export function generateLinkId(
  bankUniqueId: string,
  targetType: ReconTargetType,
  targetId: string
): string {
  const input = reconPairKey(bankUniqueId, targetType, targetId);
  // Deterministic 64-bit FNV-1a (split into two 32-bit hashes) so identical pairs generate stable Link_IDs
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex1 = (h1 >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).toUpperCase().padStart(4, '0').slice(0, 4);
  return `LNK-${hex1}${hex2}`;
}

export function bankEntryKey(entry: BankLedgerEntry): string {
  return `${entry.tab}::${entry.tx.uniqueId.trim()}::${entry.tx.sheetRowNumber ?? entry.tx.rowKey}`;
}

export function expenseRecordKey(exp: ExpenseRecord): string {
  return `${exp.expId.trim()}::${exp.sheetRowNumber ?? exp.expId.trim()}`;
}

/**
 * Computes dynamic link cardinality ('1:1', '1:N', 'N:1', 'M:N') across the
 * connected component of links touching a given seed bank/target node.
 */
export function computeDynamicCardinality(
  seedLinks: ReconLink[],
  allLinks: ReconLink[]
): ReconCardinality {
  if (seedLinks.length === 0) return 'none';

  const bankSet = new Set<string>();
  const targetSet = new Set<string>();

  for (const link of seedLinks) {
    bankSet.add(link.bankUniqueId.trim().toLowerCase());
    targetSet.add(`${link.targetType}::${link.targetId.trim().toLowerCase()}`);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const link of allLinks) {
      const bKey = link.bankUniqueId.trim().toLowerCase();
      const tKey = `${link.targetType}::${link.targetId.trim().toLowerCase()}`;
      const hasBank = bankSet.has(bKey);
      const hasTarget = targetSet.has(tKey);
      if (hasBank && !hasTarget) {
        targetSet.add(tKey);
        changed = true;
      } else if (hasTarget && !hasBank) {
        bankSet.add(bKey);
        changed = true;
      }
    }
  }

  const banks = bankSet.size;
  const targets = targetSet.size;
  if (banks === 1 && targets === 1) return '1:1';
  if (banks === 1 && targets > 1) return '1:N';
  if (banks > 1 && targets === 1) return 'N:1';
  return 'M:N';
}

function summarizeAllocation(
  totalCents: number,
  links: ReconLink[],
  allLinks: ReconLink[],
  partnerIdSelector: (link: ReconLink) => string
): AllocationSummary {
  const safeTotalCents = Math.max(0, totalCents);
  let allocatedCents = 0;
  const partnerIds: string[] = [];
  const seenPartners = new Set<string>();
  const distinctCategories: string[] = [];
  const seenCats = new Set<string>();

  for (const link of links) {
    allocatedCents += Math.max(0, link.allocatedCents);
    const pid = partnerIdSelector(link).trim();
    if (pid && !seenPartners.has(pid.toLowerCase())) {
      seenPartners.add(pid.toLowerCase());
      partnerIds.push(pid);
    }
    const cat = link.category.trim();
    if (cat && !seenCats.has(cat.toLowerCase())) {
      seenCats.add(cat.toLowerCase());
      distinctCategories.push(cat);
    }
  }

  const remainingCents = Math.max(0, safeTotalCents - allocatedCents);
  let status: AllocationStatus = 'unlinked';
  if (links.length > 0 && allocatedCents > 0) {
    status = remainingCents <= RECON_PENNY_TOLERANCE_CENTS ? 'full' : 'partial';
  }

  const derivedCategory =
    distinctCategories.length === 0
      ? undefined
      : distinctCategories.length === 1
        ? distinctCategories[0]
        : MULTIPLE_CATEGORY_LABEL;

  return {
    totalAmount: fromCents(safeTotalCents),
    totalCents: safeTotalCents,
    allocatedAmount: fromCents(allocatedCents),
    allocatedCents,
    remainingAmount: fromCents(remainingCents),
    remainingCents,
    links,
    partnerIds,
    distinctCategories,
    matchCardinality: computeDynamicCardinality(links, allLinks),
    status,
    derivedIsRecon: status === 'full' ? 'Yes' : 'No',
    derivedCategory,
  };
}

/**
 * Merges explicit Recon_Links rows with backward-compatible legacy 1:1 links inferred
 * from Bank_Ledger.Target_ID / Expense_Ledger.Recon_Source_ID when no explicit
 * Recon_Links exist for either record yet.
 */
export function buildEffectiveReconLinks(
  sheetLinks: ReconLink[],
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[]
): ReconLink[] {
  const effective: ReconLink[] = [];
  const seenPairs = new Set<string>();
  const banksWithExplicitLinks = new Set<string>();
  const expensesWithExplicitLinks = new Set<string>();

  for (const link of sheetLinks) {
    const bankIdNorm = link.bankUniqueId.trim().toLowerCase();
    const targetIdNorm = link.targetId.trim().toLowerCase();
    if (!bankIdNorm || !targetIdNorm || link.allocatedCents <= 0) continue;

    const pKey = reconPairKey(link.bankUniqueId, link.targetType, link.targetId);
    if (seenPairs.has(pKey)) continue;
    seenPairs.add(pKey);

    effective.push({
      ...link,
      allocatedCents: toCents(link.allocatedAmount),
      allocatedAmount: fromCents(toCents(link.allocatedAmount)),
    });
    banksWithExplicitLinks.add(bankIdNorm);
    if (link.targetType === 'Expense') {
      expensesWithExplicitLinks.add(targetIdNorm);
    }
  }

  // Index sheet-persisted bank expenses & expense records for legacy 1:1 fallback
  const bankById = new Map<string, BankLedgerEntry>();
  for (const entry of bankEntries) {
    if (entry.tx.reviewStatus === 'discarded') continue;
    const idNorm = entry.tx.uniqueId.trim().toLowerCase();
    if (idNorm && !bankById.has(idNorm)) {
      bankById.set(idNorm, entry);
    }
  }

  const expById = new Map<string, ExpenseRecord>();
  for (const exp of expenses) {
    const idNorm = exp.expId.trim().toLowerCase();
    if (idNorm && !expById.has(idNorm)) {
      expById.set(idNorm, exp);
    }
  }

  // Pass A: Legacy Bank Target_ID -> Expense
  for (const entry of bankEntries) {
    if (entry.tx.reviewStatus === 'discarded' || entry.tx.transactionType !== 'Expense') continue;
    const bankIdNorm = entry.tx.uniqueId.trim().toLowerCase();
    if (!bankIdNorm || banksWithExplicitLinks.has(bankIdNorm)) continue;

    const targetIds = parseIdList(entry.tx.targetId);
    if (targetIds.length !== 1) continue;

    const targetExp = expById.get(targetIds[0].toLowerCase());
    if (!targetExp) continue;

    const expIdNorm = targetExp.expId.trim().toLowerCase();
    if (expensesWithExplicitLinks.has(expIdNorm)) continue;

    const pKey = reconPairKey(entry.tx.uniqueId, 'Expense', targetExp.expId);
    if (seenPairs.has(pKey)) continue;

    const bankCents = Math.abs(entry.tx.amountCents);
    const expCents = toCents(Math.abs(targetExp.amount));
    const allocCents = Math.min(bankCents, expCents);
    if (allocCents <= 0) continue;

    seenPairs.add(pKey);
    banksWithExplicitLinks.add(bankIdNorm);
    expensesWithExplicitLinks.add(expIdNorm);

    effective.push({
      linkId: generateLinkId(entry.tx.uniqueId, 'Expense', targetExp.expId),
      sheetRowNumber: null,
      bankTab: entry.tab,
      bankUniqueId: entry.tx.uniqueId.trim(),
      targetType: 'Expense',
      targetId: targetExp.expId.trim(),
      allocatedAmount: fromCents(allocCents),
      allocatedCents: allocCents,
      category: targetExp.category.trim() || (entry.tx.category ?? '').trim(),
      linkMode: 'Auto',
      linkedAt: '',
      notes: '',
    });
  }

  // Pass B: Legacy Expense Recon_Source_ID -> Bank
  for (const exp of expenses) {
    const expIdNorm = exp.expId.trim().toLowerCase();
    if (!expIdNorm || expensesWithExplicitLinks.has(expIdNorm)) continue;

    const reconIds = parseIdList(exp.reconSourceId);
    if (reconIds.length !== 1) continue;

    const bankEntry = bankById.get(reconIds[0].toLowerCase());
    if (!bankEntry || bankEntry.tx.transactionType !== 'Expense') continue;

    const bankIdNorm = bankEntry.tx.uniqueId.trim().toLowerCase();
    if (banksWithExplicitLinks.has(bankIdNorm)) continue;

    const pKey = reconPairKey(bankEntry.tx.uniqueId, 'Expense', exp.expId);
    if (seenPairs.has(pKey)) continue;

    const bankCents = Math.abs(bankEntry.tx.amountCents);
    const expCents = toCents(Math.abs(exp.amount));
    const allocCents = Math.min(bankCents, expCents);
    if (allocCents <= 0) continue;

    seenPairs.add(pKey);
    banksWithExplicitLinks.add(bankIdNorm);
    expensesWithExplicitLinks.add(expIdNorm);

    effective.push({
      linkId: generateLinkId(bankEntry.tx.uniqueId, 'Expense', exp.expId),
      sheetRowNumber: null,
      bankTab: bankEntry.tab,
      bankUniqueId: bankEntry.tx.uniqueId.trim(),
      targetType: 'Expense',
      targetId: exp.expId.trim(),
      allocatedAmount: fromCents(allocCents),
      allocatedCents: allocCents,
      category: exp.category.trim() || (bankEntry.tx.category ?? '').trim(),
      linkMode: 'Auto',
      linkedAt: '',
      notes: '',
    });
  }

  return effective;
}

export function computeBankAllocationMap(
  bankEntries: BankLedgerEntry[],
  allLinks: ReconLink[]
): Map<string, AllocationSummary> {
  const linksByBankId = new Map<string, ReconLink[]>();
  for (const link of allLinks) {
    const idNorm = link.bankUniqueId.trim().toLowerCase();
    if (!idNorm) continue;
    const arr = linksByBankId.get(idNorm) ?? [];
    arr.push(link);
    linksByBankId.set(idNorm, arr);
  }

  const out = new Map<string, AllocationSummary>();
  for (const entry of bankEntries) {
    const idNorm = entry.tx.uniqueId.trim().toLowerCase();
    const links = linksByBankId.get(idNorm) ?? [];
    out.set(
      bankEntryKey(entry),
      summarizeAllocation(Math.abs(entry.tx.amountCents), links, allLinks, (l) => l.targetId)
    );
  }
  return out;
}

export function computeExpenseAllocationMap(
  expenses: ExpenseRecord[],
  allLinks: ReconLink[]
): Map<string, AllocationSummary> {
  const linksByExpId = new Map<string, ReconLink[]>();
  for (const link of allLinks) {
    if (link.targetType !== 'Expense') continue;
    const idNorm = link.targetId.trim().toLowerCase();
    if (!idNorm) continue;
    const arr = linksByExpId.get(idNorm) ?? [];
    arr.push(link);
    linksByExpId.set(idNorm, arr);
  }

  const out = new Map<string, AllocationSummary>();
  for (const exp of expenses) {
    const idNorm = exp.expId.trim().toLowerCase();
    const links = linksByExpId.get(idNorm) ?? [];
    out.set(
      expenseRecordKey(exp),
      summarizeAllocation(toCents(Math.abs(exp.amount)), links, allLinks, (l) => l.bankUniqueId)
    );
  }
  return out;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  normalizedLinks: ReconLink[];
}

/**
 * Validates candidate new Recon_Links against existing links, verifying:
 * - Positive amounts
 * - No duplicate (Bank_Unique_ID, Target_Type, Target_ID) pairs
 * - Target records exist
 * - No over-allocation on either Bank_Ledger or Expense_Ledger
 */
export function validateNewReconLinks(
  existingLinks: ReconLink[],
  candidates: NewReconLinkInput[],
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[]
): ValidationResult {
  const errors: string[] = [];
  const normalizedLinks: ReconLink[] = [];

  if (candidates.length === 0) {
    return { valid: true, errors, normalizedLinks };
  }

  const bankById = new Map<string, BankLedgerEntry>();
  for (const entry of bankEntries) {
    if (entry.tx.reviewStatus === 'discarded') continue;
    const idNorm = entry.tx.uniqueId.trim().toLowerCase();
    if (idNorm && !bankById.has(idNorm)) {
      bankById.set(idNorm, entry);
    }
  }

  const expById = new Map<string, ExpenseRecord>();
  for (const exp of expenses) {
    const idNorm = exp.expId.trim().toLowerCase();
    if (idNorm && !expById.has(idNorm)) {
      expById.set(idNorm, exp);
    }
  }

  const existingPairSet = new Set<string>();
  const bankAllocatedCents = new Map<string, number>();
  const targetAllocatedCents = new Map<string, number>();

  for (const link of existingLinks) {
    const bNorm = link.bankUniqueId.trim().toLowerCase();
    const tNorm = link.targetId.trim().toLowerCase();
    existingPairSet.add(reconPairKey(link.bankUniqueId, link.targetType, link.targetId));
    bankAllocatedCents.set(bNorm, (bankAllocatedCents.get(bNorm) ?? 0) + link.allocatedCents);
    const tMapKey = `${link.targetType}::${tNorm}`;
    targetAllocatedCents.set(
      tMapKey,
      (targetAllocatedCents.get(tMapKey) ?? 0) + link.allocatedCents
    );
  }

  const nowIso = new Date().toISOString();

  for (const cand of candidates) {
    const bankId = cand.bankUniqueId.trim();
    const targetId = cand.targetId.trim();
    const bNorm = bankId.toLowerCase();
    const tNorm = targetId.toLowerCase();
    const allocCents = toCents(cand.allocatedAmount);

    if (!bankId || !targetId) {
      errors.push('Both Bank_Unique_ID and Target_ID are required for a reconciliation link.');
      continue;
    }

    if (allocCents <= 0) {
      errors.push(
        `Link ${bankId} -> ${targetId} must have a positive Allocated_Amount.`
      );
      continue;
    }

    const pKey = reconPairKey(bankId, cand.targetType, targetId);
    if (existingPairSet.has(pKey)) {
      errors.push(`Link between Bank ${bankId} and ${cand.targetType} ${targetId} already exists.`);
      continue;
    }

    const bankEntry = bankById.get(bNorm);
    if (!bankEntry) {
      errors.push(`Bank transaction ${bankId} was not found.`);
      continue;
    }

    const nextBankAlloc = (bankAllocatedCents.get(bNorm) ?? 0) + allocCents;
    const bankLimitCents = Math.abs(bankEntry.tx.amountCents);
    if (nextBankAlloc > bankLimitCents + RECON_PENNY_TOLERANCE_CENTS) {
      errors.push(
        `Bank transaction ${bankId} would be over-allocated ($${fromCents(nextBankAlloc).toFixed(2)} > $${fromCents(bankLimitCents).toFixed(2)}).`
      );
      continue;
    }

    if (cand.targetType === 'Expense') {
      const exp = expById.get(tNorm);
      if (!exp) {
        errors.push(`Expense ${targetId} was not found in Expense_Ledger.`);
        continue;
      }
      const tMapKey = `${cand.targetType}::${tNorm}`;
      const nextExpAlloc = (targetAllocatedCents.get(tMapKey) ?? 0) + allocCents;
      const expLimitCents = toCents(Math.abs(exp.amount));
      if (nextExpAlloc > expLimitCents + RECON_PENNY_TOLERANCE_CENTS) {
        errors.push(
          `Expense ${targetId} would be over-allocated ($${fromCents(nextExpAlloc).toFixed(2)} > $${fromCents(expLimitCents).toFixed(2)}).`
        );
        continue;
      }
      targetAllocatedCents.set(tMapKey, nextExpAlloc);
    }

    existingPairSet.add(pKey);
    bankAllocatedCents.set(bNorm, nextBankAlloc);

    normalizedLinks.push({
      linkId:
        cand.linkId?.trim() || generateLinkId(bankId, cand.targetType, targetId),
      sheetRowNumber: null,
      bankTab: cand.bankTab || bankEntry.tab,
      bankUniqueId: bankId,
      targetType: cand.targetType,
      targetId,
      allocatedAmount: fromCents(allocCents),
      allocatedCents: allocCents,
      category: cand.category.trim(),
      linkMode: cand.linkMode ?? 'Manual',
      linkedAt: cand.linkedAt ?? nowIso,
      notes: (cand.notes ?? '').trim(),
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    normalizedLinks,
  };
}

export interface DerivedLedgerPatchesResult {
  bankUpdatesByTab: Record<AccountType, LinkedBankFieldPatch[]>;
  expenseUpdates: LinkedExpenseFieldPatch[];
}

/**
 * Computes minimal derived Google Sheet patches (Target_ID, Recon_Source_ID, Is_Recon, Category)
 * from an authoritative list of effective ReconLinks.
 */
export function computeDerivedLedgerSyncPatches(
  effectiveLinks: ReconLink[],
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[],
  options?: {
    /** When provided, only compute patches for records matching these IDs */
    touchedBankIds?: Set<string>;
    touchedExpenseIds?: Set<string>;
  }
): DerivedLedgerPatchesResult {
  const bankAllocMap = computeBankAllocationMap(bankEntries, effectiveLinks);
  const expAllocMap = computeExpenseAllocationMap(expenses, effectiveLinks);

  const bankUpdatesByTab: Record<AccountType, LinkedBankFieldPatch[]> = {
    Puja: [],
    Regular: [],
  };
  const expenseUpdates: LinkedExpenseFieldPatch[] = [];

  for (const entry of bankEntries) {
    if (entry.tx.reviewStatus === 'discarded') continue;
    if (typeof entry.tx.sheetRowNumber !== 'number' || entry.tx.sheetRowNumber < 1) continue;

    const bankIdNorm = entry.tx.uniqueId.trim().toLowerCase();
    if (options?.touchedBankIds && !options.touchedBankIds.has(bankIdNorm)) continue;

    const summary = bankAllocMap.get(bankEntryKey(entry));
    if (!summary) continue;

    const expectedTargetId = formatIdList(summary.partnerIds);
    const currentTargetId = (entry.tx.targetId ?? '').trim();
    const currentNormalizedTargetId = formatIdList(parseIdList(currentTargetId));

    const patch: LinkedBankFieldPatch = {
      sheetRowNumber: entry.tx.sheetRowNumber,
    };
    let changed = false;

    if (summary.links.length > 0) {
      if (currentNormalizedTargetId.toLowerCase() !== expectedTargetId.toLowerCase()) {
        patch.targetId = expectedTargetId;
        changed = true;
      }

      if ((entry.tx.isRecon ?? 'No') !== summary.derivedIsRecon) {
        patch.isRecon = summary.derivedIsRecon;
        changed = true;
      }

      if (
        summary.derivedCategory &&
        (entry.tx.category ?? '').trim() !== summary.derivedCategory
      ) {
        patch.category = summary.derivedCategory;
        changed = true;
      }
    } else if (options?.touchedBankIds?.has(bankIdNorm)) {
      // Bank transaction had all its links removed
      if (currentTargetId !== '') {
        patch.targetId = '';
        changed = true;
      }
      if ((entry.tx.isRecon ?? 'No') !== 'No') {
        patch.isRecon = 'No';
        changed = true;
      }
      if ((entry.tx.category ?? '').trim() === MULTIPLE_CATEGORY_LABEL) {
        patch.category = '';
        changed = true;
      }
    }

    if (changed) {
      bankUpdatesByTab[entry.tab].push(patch);
    }
  }

  for (const exp of expenses) {
    if (typeof exp.sheetRowNumber !== 'number' || exp.sheetRowNumber < 1) continue;

    const expIdNorm = exp.expId.trim().toLowerCase();
    if (options?.touchedExpenseIds && !options.touchedExpenseIds.has(expIdNorm)) continue;

    const summary = expAllocMap.get(expenseRecordKey(exp));
    if (!summary) continue;

    const expectedReconSourceId = formatIdList(summary.partnerIds);
    const currentReconSourceId = exp.reconSourceId.trim();
    const currentNormalizedReconSourceId = formatIdList(parseIdList(currentReconSourceId));

    const patch: LinkedExpenseFieldPatch = {
      sheetRowNumber: exp.sheetRowNumber,
    };
    let changed = false;

    if (summary.links.length > 0) {
      if (
        currentNormalizedReconSourceId.toLowerCase() !==
        expectedReconSourceId.toLowerCase()
      ) {
        patch.reconSourceId = expectedReconSourceId;
        changed = true;
      }
      if (exp.isRecon !== summary.derivedIsRecon) {
        patch.isRecon = summary.derivedIsRecon;
        changed = true;
      }
    } else if (options?.touchedExpenseIds?.has(expIdNorm)) {
      // Expense had all its links removed
      if (currentReconSourceId !== '') {
        patch.reconSourceId = '';
        changed = true;
      }
      if (exp.isRecon !== 'No') {
        patch.isRecon = 'No';
        changed = true;
      }
    }

    if (changed) {
      expenseUpdates.push(patch);
    }
  }

  return { bankUpdatesByTab, expenseUpdates };
}
