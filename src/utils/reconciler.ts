import { ExpenseRecord } from '../types/expense';
import { ReconLink } from '../types/reconciliation';
import { AccountType, NormalizedTransaction } from '../types/statement';
import {
  bankEntryKey,
  buildEffectiveReconLinks,
  computeBankAllocationMap,
  computeDerivedLedgerSyncPatches,
  computeExpenseAllocationMap,
  expenseRecordKey,
  formatIdList,
  fromCents,
  MULTIPLE_CATEGORY_LABEL,
  parseIdList,
  RECON_PENNY_TOLERANCE_CENTS,
  toCents,
} from './reconAllocations';

export interface BankLedgerEntry {
  tab: AccountType;
  tx: NormalizedTransaction;
}

export interface ReconciliationMatch {
  matchKey: string;
  bankTab: AccountType;
  bankTx: NormalizedTransaction;
  expense: ExpenseRecord;
  dateDiffDays: number;
  score: number;
  reason: string;
  needsBankTargetIdUpdate: boolean;
  needsBankIsReconUpdate: boolean;
  needsBankCategoryUpdate: boolean;
  needsExpenseReconIdUpdate: boolean;
  needsExpenseIsReconUpdate: boolean;
  needsBankUpdate: boolean;
  needsExpenseUpdate: boolean;
  /** Dollar amount matched/allocated by this specific bank<->expense leg */
  matchedAmount?: number;
  /** Full comma-separated Target_ID value for Bank_Ledger after applying this match */
  resultingBankTargetId?: string;
  /** Derived Is_Recon value ('Yes' | 'No') for Bank_Ledger after applying this match */
  resultingBankIsRecon?: 'Yes' | 'No';
  /** Derived Category value (single category or 'Multiple') for Bank_Ledger after applying this match */
  resultingBankCategory?: string;
  /** Full comma-separated Recon_Source_ID value for Expense_Ledger after applying this match */
  resultingExpenseReconId?: string;
  /** Derived Is_Recon value ('Yes' | 'No') for Expense_Ledger after applying this match */
  resultingExpenseIsRecon?: 'Yes' | 'No';
}

export interface ReconciliationAnalysis {
  bankExpenseCount: number;
  expenseLedgerCount: number;
  alreadyReconciledCount: number;
  matches: ReconciliationMatch[];
  unmatchedBankCount: number;
  unmatchedBankAmount: number;
  unmatchedExpenseCount: number;
  unmatchedExpenseAmount: number;
}

function parseIsoDateToUtcDays(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'payment',
  'purchase',
  'debit',
  'card',
  'check',
  'pos',
  'ach',
  'inc',
  'llc',
  'corp',
  'www',
  'com',
]);

function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const parts = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const part of parts) {
    if (part.length >= 3 && !STOP_WORDS.has(part)) {
      tokens.add(part);
    }
  }
  return tokens;
}

function scoreCandidate(
  bankEntry: BankLedgerEntry,
  expense: ExpenseRecord,
  dateDiffDays: number,
  ignoreDate: boolean,
  isRemainingBalanceMatch: boolean
): { score: number; reason: string } {
  const { tab, tx } = bankEntry;
  let score = ignoreDate ? 100 : 100 - dateDiffDays * 10;
  const reasons: string[] = [];

  if (isRemainingBalanceMatch) {
    reasons.push(
      dateDiffDays === 0
        ? 'Remaining balance · Same date'
        : `Remaining balance (±${dateDiffDays}d)`
    );
  } else if (ignoreDate) {
    reasons.push(
      dateDiffDays === 0 ? 'Exact amount · Same date' : `Exact amount (${dateDiffDays}d apart)`
    );
  } else if (dateDiffDays === 0) {
    reasons.push('Exact date & amount');
  } else {
    reasons.push(`Exact amount (±${dateDiffDays}d)`);
  }

  // Reference / Check number match
  const ref = tx.referenceNumber.trim().toLowerCase();
  const expHaystack =
    `${expense.description} ${expense.paymentMode} ${expense.category} ${expense.subCategory}`.toLowerCase();
  if (ref.length >= 3 && expHaystack.includes(ref)) {
    score += 60;
    reasons.push(`Ref #${tx.referenceNumber}`);
  }

  // Source / Notes / Payment Mode alignment
  const srcLower = tx.source.toLowerCase();
  const notesLower = (tx.notes ?? '').toLowerCase();
  const modeLower = expense.paymentMode.toLowerCase();
  const descLower = expense.description.toLowerCase();

  if (
    (srcLower === 'check' && modeLower.includes('check')) ||
    (srcLower === 'zelle' && (modeLower.includes('zelle') || descLower.includes('zelle'))) ||
    (srcLower === 'cash' && modeLower.includes('cash')) ||
    (srcLower.startsWith('card') &&
      (modeLower.includes('card') ||
        modeLower.includes('credit') ||
        modeLower.includes('debit'))) ||
    ((srcLower === 'amazon' || notesLower === 'amazon') && expHaystack.includes('amazon')) ||
    ((srcLower === 'home depot' || notesLower === 'home depot') &&
      (expHaystack.includes('home depot') || expHaystack.includes('homedepot'))) ||
    (srcLower === 'wt' && (modeLower.includes('wire') || descLower.includes('wire')))
  ) {
    score += 25;
    reasons.push(`${tx.notes || tx.source} mode`);
  }

  // Tab <-> Puja hint
  const pujaLower = expense.puja.trim().toLowerCase();
  if (tab === 'Puja' && pujaLower && pujaLower !== 'regular' && pujaLower !== 'none') {
    score += 15;
  } else if (tab === 'Regular' && (!pujaLower || pujaLower === 'regular' || pujaLower === 'none')) {
    score += 10;
  }

  // Token overlap across description, category, subcategory
  const bankTokens = extractTokens(`${tx.description} ${tx.source} ${tx.notes ?? ''}`);
  const expTokens = extractTokens(
    `${expense.description} ${expense.category} ${expense.subCategory}`
  );
  let shared = 0;
  for (const tok of bankTokens) {
    if (expTokens.has(tok)) {
      shared++;
    }
  }
  if (shared > 0) {
    score += Math.min(shared * 10, 40);
    reasons.push(`${shared} keyword match${shared === 1 ? '' : 'es'}`);
  }

  return { score, reason: reasons.join(' · ') };
}

export function findExpenseMatches(
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[],
  dateToleranceDays: number | null = 0,
  reconLinks: ReconLink[] = []
): ReconciliationAnalysis {
  const validBankExpenses = bankEntries.filter(
    ({ tx }) =>
      tx.transactionType === 'Expense' &&
      tx.reviewStatus !== 'discarded' &&
      typeof tx.sheetRowNumber === 'number' &&
      tx.sheetRowNumber >= 1 &&
      Math.abs(tx.amountCents) > 0
  );

  const validExpenses = expenses.filter(
    (exp) =>
      typeof exp.sheetRowNumber === 'number' &&
      exp.sheetRowNumber >= 1 &&
      Math.round(Math.abs(exp.amount) * 100) > 0
  );

  const effectiveLinks = buildEffectiveReconLinks(
    reconLinks,
    validBankExpenses,
    validExpenses
  );

  const bankAllocMap = computeBankAllocationMap(validBankExpenses, effectiveLinks);
  const expAllocMap = computeExpenseAllocationMap(validExpenses, effectiveLinks);

  const bankById = new Map<string, BankLedgerEntry>();
  for (const entry of validBankExpenses) {
    const idNorm = entry.tx.uniqueId.trim().toLowerCase();
    if (idNorm && !bankById.has(idNorm)) {
      bankById.set(idNorm, entry);
    }
  }

  const expById = new Map<string, ExpenseRecord>();
  for (const exp of validExpenses) {
    const idNorm = exp.expId.trim().toLowerCase();
    if (idNorm && !expById.has(idNorm)) {
      expById.set(idNorm, exp);
    }
  }

  const matches: ReconciliationMatch[] = [];
  let alreadyReconciledCount = 0;
  const seenMatchKeys = new Set<string>();

  // Pass 0: Detect already-linked pairs (both fully synced & pairs needing backfill of IDs, Is_Recon, or Category)
  for (const link of effectiveLinks) {
    if (link.targetType !== 'Expense') continue;
    const bankEntry = bankById.get(link.bankUniqueId.trim().toLowerCase());
    const matchedExp = expById.get(link.targetId.trim().toLowerCase());
    if (!bankEntry || !matchedExp) continue;

    const bk = bankEntryKey(bankEntry);
    const ek = expenseRecordKey(matchedExp);
    const matchKey = `${bk}<->${ek}`;
    if (seenMatchKeys.has(matchKey)) continue;
    seenMatchKeys.add(matchKey);

    const bankSummary = bankAllocMap.get(bk);
    const expSummary = expAllocMap.get(ek);
    if (!bankSummary || !expSummary) continue;

    const expectedBankTargetId = formatIdList(bankSummary.partnerIds);
    const currentBankTargetId = formatIdList(parseIdList(bankEntry.tx.targetId));
    const needsBankTargetIdUpdate =
      currentBankTargetId.toLowerCase() !== expectedBankTargetId.toLowerCase();

    const expectedBankIsRecon = bankSummary.derivedIsRecon;
    const needsBankIsReconUpdate = (bankEntry.tx.isRecon ?? 'No') !== expectedBankIsRecon;

    const expectedBankCategory = bankSummary.derivedCategory ?? '';
    const needsBankCategoryUpdate =
      Boolean(expectedBankCategory) &&
      (bankEntry.tx.category ?? '').trim() !== expectedBankCategory;

    const expectedExpReconId = formatIdList(expSummary.partnerIds);
    const currentExpReconId = formatIdList(parseIdList(matchedExp.reconSourceId));
    const needsExpenseReconIdUpdate =
      currentExpReconId.toLowerCase() !== expectedExpReconId.toLowerCase();

    const expectedExpIsRecon = expSummary.derivedIsRecon;
    const needsExpenseIsReconUpdate = matchedExp.isRecon !== expectedExpIsRecon;

    const needsBankUpdate =
      needsBankTargetIdUpdate || needsBankIsReconUpdate || needsBankCategoryUpdate;
    const needsExpenseUpdate =
      needsExpenseReconIdUpdate || needsExpenseIsReconUpdate;

    if (!needsBankUpdate && !needsExpenseUpdate) {
      if (bankSummary.status === 'full' || expSummary.status === 'full') {
        alreadyReconciledCount++;
      }
      continue;
    }

    const bankDays = parseIsoDateToUtcDays(bankEntry.tx.date);
    const expDays = parseIsoDateToUtcDays(matchedExp.date);
    const diff =
      bankDays !== null && expDays !== null ? Math.abs(bankDays - expDays) : 0;

    const reasonParts: string[] = [];
    if (needsBankTargetIdUpdate && !needsExpenseReconIdUpdate) {
      reasonParts.push('Recon Source_ID linked · Backfill Target ID');
    } else if (!needsBankTargetIdUpdate && needsExpenseReconIdUpdate) {
      reasonParts.push('Target ID linked · Backfill Recon Source_ID');
    } else {
      reasonParts.push('Linked pair');
    }
    if (needsBankIsReconUpdate || needsExpenseIsReconUpdate) {
      reasonParts.push(`Sync Is_Recon`);
    }
    if (needsBankCategoryUpdate) {
      reasonParts.push(`Set Category "${expectedBankCategory}"`);
    }

    matches.push({
      matchKey,
      bankTab: bankEntry.tab,
      bankTx: bankEntry.tx,
      expense: matchedExp,
      dateDiffDays: diff,
      score: 1000,
      reason: reasonParts.join(' · '),
      needsBankTargetIdUpdate,
      needsBankIsReconUpdate,
      needsBankCategoryUpdate,
      needsExpenseReconIdUpdate,
      needsExpenseIsReconUpdate,
      needsBankUpdate,
      needsExpenseUpdate,
      matchedAmount: link.allocatedAmount,
      resultingBankTargetId: expectedBankTargetId,
      resultingBankIsRecon: expectedBankIsRecon,
      resultingBankCategory: expectedBankCategory || undefined,
      resultingExpenseReconId: expectedExpReconId,
      resultingExpenseIsRecon: expectedExpIsRecon,
    });
  }

  // Pass 1: Match remaining unallocated Bank Expenses vs remaining unallocated Expense Ledger records (1:1 exact remaining balance)
  const eligibleBank = validBankExpenses.filter((entry) => {
    const summary = bankAllocMap.get(bankEntryKey(entry));
    return summary && summary.remainingCents > RECON_PENNY_TOLERANCE_CENTS;
  });

  const eligibleExpenses = validExpenses.filter((exp) => {
    const summary = expAllocMap.get(expenseRecordKey(exp));
    return summary && summary.remainingCents > RECON_PENNY_TOLERANCE_CENTS;
  });

  // Index eligible expenses by remaining cents for fast lookup
  const expensesByRemainingCents = new Map<number, ExpenseRecord[]>();
  for (const exp of eligibleExpenses) {
    const summary = expAllocMap.get(expenseRecordKey(exp));
    if (!summary) continue;
    const cents = summary.remainingCents;
    const arr = expensesByRemainingCents.get(cents) ?? [];
    arr.push(exp);
    expensesByRemainingCents.set(cents, arr);
  }

  interface ScoredPair {
    bankEntry: BankLedgerEntry;
    expense: ExpenseRecord;
    dateDiffDays: number;
    score: number;
    reason: string;
    matchedCents: number;
  }

  const candidatePairs: ScoredPair[] = [];

  for (const bankEntry of eligibleBank) {
    const bankSummary = bankAllocMap.get(bankEntryKey(bankEntry));
    if (!bankSummary) continue;
    const bankRemCents = bankSummary.remainingCents;

    // Allow +/- 1 cent lookup for rounding tolerance
    const candidateExps: ExpenseRecord[] = [];
    for (
      let delta = -RECON_PENNY_TOLERANCE_CENTS;
      delta <= RECON_PENNY_TOLERANCE_CENTS;
      delta++
    ) {
      const bucket = expensesByRemainingCents.get(bankRemCents + delta);
      if (bucket) {
        for (const exp of bucket) {
          candidateExps.push(exp);
        }
      }
    }
    if (candidateExps.length === 0) continue;

    const bankDays = parseIsoDateToUtcDays(bankEntry.tx.date);
    const ignoreDate = dateToleranceDays === null;

    for (const exp of candidateExps) {
      const bk = bankEntryKey(bankEntry);
      const ek = expenseRecordKey(exp);
      if (seenMatchKeys.has(`${bk}<->${ek}`)) continue;

      let dateDiffDays = 0;
      const expDays = bankDays !== null ? parseIsoDateToUtcDays(exp.date) : null;

      if (bankDays !== null && expDays !== null) {
        dateDiffDays = Math.abs(bankDays - expDays);
      } else if (!ignoreDate && bankEntry.tx.date.trim() !== exp.date.trim()) {
        continue;
      }

      if (dateToleranceDays !== null && dateDiffDays > dateToleranceDays) continue;

      const expSummary = expAllocMap.get(ek);
      const isRemainingMatch =
        bankSummary.links.length > 0 || (expSummary?.links.length ?? 0) > 0;
      const { score, reason } = scoreCandidate(
        bankEntry,
        exp,
        dateDiffDays,
        ignoreDate,
        isRemainingMatch
      );
      candidatePairs.push({
        bankEntry,
        expense: exp,
        dateDiffDays,
        score,
        reason,
        matchedCents: bankRemCents,
      });
    }
  }

  // Sort best matches first for greedy 1-to-1 assignment on remaining balances
  candidatePairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    return b.bankEntry.tx.date.localeCompare(a.bankEntry.tx.date);
  });

  const claimedBankKeys = new Set<string>();
  const claimedExpKeys = new Set<string>();

  for (const pair of candidatePairs) {
    const bk = bankEntryKey(pair.bankEntry);
    const ek = expenseRecordKey(pair.expense);
    if (claimedBankKeys.has(bk) || claimedExpKeys.has(ek)) continue;

    const bankSummary = bankAllocMap.get(bk);
    const expSummary = expAllocMap.get(ek);
    if (!bankSummary || !expSummary) continue;

    claimedBankKeys.add(bk);
    claimedExpKeys.add(ek);
    seenMatchKeys.add(`${bk}<->${ek}`);

    const resultingBankTargetId = formatIdList([
      ...bankSummary.partnerIds,
      pair.expense.expId,
    ]);
    const expCat = pair.expense.category.trim();
    const combinedCategories = Array.from(
      new Set(
        [...bankSummary.distinctCategories, expCat]
          .map((c) => c.trim())
          .filter(Boolean)
      )
    );
    const resultingBankCategory =
      combinedCategories.length === 0
        ? ''
        : combinedCategories.length === 1
          ? combinedCategories[0]
          : MULTIPLE_CATEGORY_LABEL;

    const needsBankCategoryUpdate =
      Boolean(resultingBankCategory) &&
      (pair.bankEntry.tx.category ?? '').trim() !== resultingBankCategory;
    const needsBankIsReconUpdate = pair.bankEntry.tx.isRecon !== 'Yes';

    const resultingExpenseReconId = formatIdList([
      ...expSummary.partnerIds,
      pair.bankEntry.tx.uniqueId,
    ]);
    const needsExpenseIsReconUpdate = pair.expense.isRecon !== 'Yes';

    matches.push({
      matchKey: `${bk}<->${ek}`,
      bankTab: pair.bankEntry.tab,
      bankTx: pair.bankEntry.tx,
      expense: pair.expense,
      dateDiffDays: pair.dateDiffDays,
      score: pair.score,
      reason: pair.reason,
      needsBankTargetIdUpdate: true,
      needsBankIsReconUpdate,
      needsBankCategoryUpdate,
      needsExpenseReconIdUpdate: true,
      needsExpenseIsReconUpdate,
      needsBankUpdate: true,
      needsExpenseUpdate: true,
      matchedAmount: fromCents(pair.matchedCents),
      resultingBankTargetId,
      resultingBankIsRecon: 'Yes',
      resultingBankCategory: resultingBankCategory || undefined,
      resultingExpenseReconId,
      resultingExpenseIsRecon: 'Yes',
    });
  }

  matches.sort((a, b) => b.bankTx.date.localeCompare(a.bankTx.date));

  let unmatchedBankCount = 0;
  let unmatchedBankCents = 0;
  for (const entry of validBankExpenses) {
    const bk = bankEntryKey(entry);
    if (claimedBankKeys.has(bk)) continue;
    const summary = bankAllocMap.get(bk);
    const rem = summary ? summary.remainingCents : Math.abs(entry.tx.amountCents);
    if (rem > RECON_PENNY_TOLERANCE_CENTS) {
      unmatchedBankCount++;
      unmatchedBankCents += rem;
    }
  }

  let unmatchedExpenseCount = 0;
  let unmatchedExpenseCents = 0;
  for (const exp of validExpenses) {
    const ek = expenseRecordKey(exp);
    if (claimedExpKeys.has(ek)) continue;
    const summary = expAllocMap.get(ek);
    const rem = summary ? summary.remainingCents : toCents(Math.abs(exp.amount));
    if (rem > RECON_PENNY_TOLERANCE_CENTS) {
      unmatchedExpenseCount++;
      unmatchedExpenseCents += rem;
    }
  }

  return {
    bankExpenseCount: validBankExpenses.length,
    expenseLedgerCount: validExpenses.length,
    alreadyReconciledCount,
    matches,
    unmatchedBankCount,
    unmatchedBankAmount: fromCents(unmatchedBankCents),
    unmatchedExpenseCount,
    unmatchedExpenseAmount: fromCents(unmatchedExpenseCents),
  };
}

export interface LinkedBankFieldPatch {
  sheetRowNumber: number;
  targetId?: string;
  isRecon?: 'Yes' | 'No';
  category?: string;
}

export interface LinkedExpenseFieldPatch {
  sheetRowNumber: number;
  reconSourceId?: string;
  isRecon?: 'Yes' | 'No';
}

export interface LinkedSyncPlan {
  linkedPairCount: number;
  bankUpdatesByTab: Record<AccountType, LinkedBankFieldPatch[]>;
  expenseUpdates: LinkedExpenseFieldPatch[];
}

export function findLinkedSyncUpdates(
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[],
  reconLinks: ReconLink[] = []
): LinkedSyncPlan {
  const sheetBanks = bankEntries.filter(
    ({ tx }) =>
      tx.reviewStatus !== 'discarded' &&
      typeof tx.sheetRowNumber === 'number' &&
      tx.sheetRowNumber >= 1
  );
  const sheetExpenses = expenses.filter(
    (exp) => typeof exp.sheetRowNumber === 'number' && exp.sheetRowNumber >= 1
  );

  const effectiveLinks = buildEffectiveReconLinks(
    reconLinks,
    sheetBanks,
    sheetExpenses
  );

  const { bankUpdatesByTab, expenseUpdates } = computeDerivedLedgerSyncPatches(
    effectiveLinks,
    sheetBanks,
    sheetExpenses
  );

  return {
    linkedPairCount: effectiveLinks.length,
    bankUpdatesByTab,
    expenseUpdates,
  };
}
