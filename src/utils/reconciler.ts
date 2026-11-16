import { ExpenseRecord } from '../types/expense';
import { AccountType, NormalizedTransaction } from '../types/statement';

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
  needsBankUpdate: boolean;
  needsExpenseUpdate: boolean;
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
  ignoreDate: boolean
): { score: number; reason: string } {
  const { tab, tx } = bankEntry;
  let score = ignoreDate ? 100 : 100 - dateDiffDays * 10;
  const reasons: string[] = [];

  if (ignoreDate) {
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

  // Source / Payment Mode alignment
  const srcLower = tx.source.toLowerCase();
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
    (srcLower === 'amazon' && expHaystack.includes('amazon')) ||
    (srcLower === 'home depot' &&
      (expHaystack.includes('home depot') || expHaystack.includes('homedepot'))) ||
    (srcLower === 'wt' && (modeLower.includes('wire') || descLower.includes('wire')))
  ) {
    score += 25;
    reasons.push(`${tx.source} mode`);
  }

  // Tab <-> Puja hint
  const pujaLower = expense.puja.trim().toLowerCase();
  if (tab === 'Puja' && pujaLower && pujaLower !== 'regular' && pujaLower !== 'none') {
    score += 15;
  } else if (tab === 'Regular' && (!pujaLower || pujaLower === 'regular' || pujaLower === 'none')) {
    score += 10;
  }

  // Token overlap across description, category, subcategory
  const bankTokens = extractTokens(`${tx.description} ${tx.source}`);
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
  dateToleranceDays: number | null = 0
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

  const usedBankKeys = new Set<string>();
  const usedExpKeys = new Set<string>();
  const matches: ReconciliationMatch[] = [];
  let alreadyReconciledCount = 0;

  const expKey = (e: ExpenseRecord) => `${e.expId}::${e.sheetRowNumber}`;
  const bankKey = (b: BankLedgerEntry) => `${b.tab}::${b.tx.uniqueId}::${b.tx.sheetRowNumber}`;

  const bankById = new Map<string, BankLedgerEntry[]>();
  for (const entry of validBankExpenses) {
    const idNorm = entry.tx.uniqueId.trim().toLowerCase();
    const arr = bankById.get(idNorm) ?? [];
    arr.push(entry);
    bankById.set(idNorm, arr);
  }

  const expById = new Map<string, ExpenseRecord[]>();
  for (const exp of validExpenses) {
    const idNorm = exp.expId.trim().toLowerCase();
    const arr = expById.get(idNorm) ?? [];
    arr.push(exp);
    expById.set(idNorm, arr);
  }

  // Pass 1: Detect already-linked pairs (both fully linked & half-linked requiring backfill)
  for (const entry of validBankExpenses) {
    const bk = bankKey(entry);
    if (usedBankKeys.has(bk)) continue;

    const existingTarget = entry.tx.targetId?.trim() ?? '';
    if (!existingTarget) continue;

    const linkedExps = expById.get(existingTarget.toLowerCase()) ?? [];
    const matchedExp = linkedExps.find((e) => !usedExpKeys.has(expKey(e)));
    if (!matchedExp) continue;

    const ek = expKey(matchedExp);
    usedBankKeys.add(bk);
    usedExpKeys.add(ek);

    const reconId = matchedExp.reconSourceId.trim();
    if (reconId.toLowerCase() === entry.tx.uniqueId.trim().toLowerCase()) {
      alreadyReconciledCount++;
    } else {
      const bankDays = parseIsoDateToUtcDays(entry.tx.date);
      const expDays = parseIsoDateToUtcDays(matchedExp.date);
      const diff =
        bankDays !== null && expDays !== null ? Math.abs(bankDays - expDays) : 0;
      matches.push({
        matchKey: `${bk}<->${ek}`,
        bankTab: entry.tab,
        bankTx: entry.tx,
        expense: matchedExp,
        dateDiffDays: diff,
        score: 1000,
        reason: 'Target ID linked · Backfill Recon Source_ID',
        needsBankUpdate: false,
        needsExpenseUpdate: true,
      });
    }
  }

  for (const exp of validExpenses) {
    const ek = expKey(exp);
    if (usedExpKeys.has(ek)) continue;

    const existingRecon = exp.reconSourceId.trim();
    if (!existingRecon) continue;

    const linkedBanks = bankById.get(existingRecon.toLowerCase()) ?? [];
    const matchedBank = linkedBanks.find((b) => !usedBankKeys.has(bankKey(b)));
    if (!matchedBank) continue;

    const bk = bankKey(matchedBank);
    usedBankKeys.add(bk);
    usedExpKeys.add(ek);

    const bankTarget = matchedBank.tx.targetId?.trim() ?? '';
    if (bankTarget.toLowerCase() === exp.expId.trim().toLowerCase()) {
      alreadyReconciledCount++;
    } else {
      const bankDays = parseIsoDateToUtcDays(matchedBank.tx.date);
      const expDays = parseIsoDateToUtcDays(exp.date);
      const diff =
        bankDays !== null && expDays !== null ? Math.abs(bankDays - expDays) : 0;
      matches.push({
        matchKey: `${bk}<->${ek}`,
        bankTab: matchedBank.tab,
        bankTx: matchedBank.tx,
        expense: exp,
        dateDiffDays: diff,
        score: 1000,
        reason: 'Recon Source_ID linked · Backfill Target ID',
        needsBankUpdate: true,
        needsExpenseUpdate: false,
      });
    }
  }

  // Pass 2: Match unlinked Bank Expenses vs unlinked Expense Ledger records by exact amount & date window
  const unlinkedBank = validBankExpenses.filter(
    (b) => !usedBankKeys.has(bankKey(b)) && !(b.tx.targetId?.trim())
  );
  const unlinkedExpenses = validExpenses.filter(
    (e) => !usedExpKeys.has(expKey(e)) && !e.reconSourceId.trim()
  );

  // Index unlinked expenses by exact cents for fast matching
  const expensesByCents = new Map<number, ExpenseRecord[]>();
  for (const exp of unlinkedExpenses) {
    const cents = Math.round(Math.abs(exp.amount) * 100);
    const arr = expensesByCents.get(cents) ?? [];
    arr.push(exp);
    expensesByCents.set(cents, arr);
  }

  interface ScoredPair {
    bankEntry: BankLedgerEntry;
    expense: ExpenseRecord;
    dateDiffDays: number;
    score: number;
    reason: string;
  }

  const candidatePairs: ScoredPair[] = [];

  for (const bankEntry of unlinkedBank) {
    const bankCents = Math.abs(bankEntry.tx.amountCents);
    const sameAmountExps = expensesByCents.get(bankCents);
    if (!sameAmountExps || sameAmountExps.length === 0) continue;

    const bankDays = parseIsoDateToUtcDays(bankEntry.tx.date);
    const ignoreDate = dateToleranceDays === null;

    for (const exp of sameAmountExps) {
      let dateDiffDays = 0;
      const expDays = bankDays !== null ? parseIsoDateToUtcDays(exp.date) : null;

      if (bankDays !== null && expDays !== null) {
        dateDiffDays = Math.abs(bankDays - expDays);
      } else if (!ignoreDate && bankEntry.tx.date.trim() !== exp.date.trim()) {
        continue;
      }

      if (dateToleranceDays !== null && dateDiffDays > dateToleranceDays) continue;

      const { score, reason } = scoreCandidate(bankEntry, exp, dateDiffDays, ignoreDate);
      candidatePairs.push({
        bankEntry,
        expense: exp,
        dateDiffDays,
        score,
        reason,
      });
    }
  }

  // Sort best matches first for greedy 1-to-1 assignment
  candidatePairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    return b.bankEntry.tx.date.localeCompare(a.bankEntry.tx.date);
  });

  for (const pair of candidatePairs) {
    const bk = bankKey(pair.bankEntry);
    const ek = expKey(pair.expense);
    if (usedBankKeys.has(bk) || usedExpKeys.has(ek)) continue;

    usedBankKeys.add(bk);
    usedExpKeys.add(ek);

    matches.push({
      matchKey: `${bk}<->${ek}`,
      bankTab: pair.bankEntry.tab,
      bankTx: pair.bankEntry.tx,
      expense: pair.expense,
      dateDiffDays: pair.dateDiffDays,
      score: pair.score,
      reason: pair.reason,
      needsBankUpdate: true,
      needsExpenseUpdate: true,
    });
  }

  matches.sort((a, b) => b.bankTx.date.localeCompare(a.bankTx.date));

  let unmatchedBankCount = 0;
  let unmatchedBankCents = 0;
  for (const entry of validBankExpenses) {
    if (!usedBankKeys.has(bankKey(entry))) {
      unmatchedBankCount++;
      unmatchedBankCents += Math.abs(entry.tx.amountCents);
    }
  }

  let unmatchedExpenseCount = 0;
  let unmatchedExpenseCents = 0;
  for (const exp of validExpenses) {
    if (!usedExpKeys.has(expKey(exp))) {
      unmatchedExpenseCount++;
      unmatchedExpenseCents += Math.round(Math.abs(exp.amount) * 100);
    }
  }

  return {
    bankExpenseCount: validBankExpenses.length,
    expenseLedgerCount: validExpenses.length,
    alreadyReconciledCount,
    matches,
    unmatchedBankCount,
    unmatchedBankAmount: unmatchedBankCents / 100,
    unmatchedExpenseCount,
    unmatchedExpenseAmount: unmatchedExpenseCents / 100,
  };
}
