import type { AmazonOrderRecord } from '../types/amazon.ts';
import type { ExpenseRecord } from '../types/expense.ts';
import type { AccountType, NormalizedTransaction } from '../types/statement.ts';
import { normalizeAmazonOrderNumber } from './amazonProcessor.ts';

export interface AmazonExpenseMatchOrderSummary {
  orderNumber: string;
  orderDate: string;
  orderAmount: number;
  expId: string;
  expenseDate: string;
  expenseDescription: string;
  rowCount: number;
  sheetRowNumbers: number[];
}

export interface AmazonExpenseRowUpdate {
  sheetRowNumber: number;
  uniqueId: string;
  orderNumber: string;
  expId: string;
}

export interface AmazonExpenseReconPlan {
  eligibleExpenseCount: number;
  eligibleOrderCount: number;
  alreadyMatchedOrderCount: number;
  matchedOrders: AmazonExpenseMatchOrderSummary[];
  rowUpdates: AmazonExpenseRowUpdate[];
  unmatchedExpenseCount: number;
  unmatchedOrderCount: number;
}

export type BankStatementLookupInput = NormalizedTransaction & {
  accountTab?: AccountType;
};

export interface AmazonBankMatchOrderSummary {
  orderNumber: string;
  orderDate: string;
  orderAmount: number;
  bankId: string;
  bankDate: string;
  bankDescription: string;
  accountTab?: AccountType;
  rowCount: number;
  sheetRowNumbers: number[];
}

export interface AmazonBankRowUpdate {
  sheetRowNumber: number;
  uniqueId: string;
  orderNumber: string;
  bankId: string;
  isRecon: 'Yes';
}

export interface AmazonBankReconPlan {
  eligibleBankCount: number;
  eligibleOrderCount: number;
  alreadyMatchedOrderCount: number;
  matchedOrders: AmazonBankMatchOrderSummary[];
  rowUpdates: AmazonBankRowUpdate[];
  unmatchedBankCount: number;
  unmatchedOrderCount: number;
}

const TOKEN_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'amazon',
  'amzn',
  'order',
  'item',
  'items',
  'purchase',
  'pack',
  'set',
]);

function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function parseIsoDateToUtcDays(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function extractMatchTokens(text: string): Set<string> {
  const out = new Set<string>();
  const parts = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const part of parts) {
    if (part.length >= 3 && !TOKEN_STOP_WORDS.has(part)) {
      out.add(part);
    }
  }
  return out;
}

export function expenseNotesHasAmazon(notes: string | undefined | null): boolean {
  return String(notes ?? '').toLowerCase().includes('amazon');
}

function isCancelledExpenseStatus(status: string | undefined | null): boolean {
  const st = String(status ?? '').trim().toLowerCase();
  if (!st) return false;
  return st.includes('cancel') || st.includes('reject') || st.includes('void');
}

interface OrderGroup {
  normOrder: string;
  displayOrderNumber: string;
  orderDate: string;
  activeRows: AmazonOrderRecord[];
  allNonCancelledRows: AmazonOrderRecord[];
  primaryCents: number;
  originalWithReturnsCents: number | null;
  repeatedOrderTotalCents: number | null;
  hasUniqueReturnedItems: boolean;
  existingExpIds: string[];
  existingBankIds: string[];
  categories: Set<string>;
  descriptionTokens: Set<string>;
}

function computeOrderGroupAmounts(activeRows: AmazonOrderRecord[]): {
  primaryCents: number;
  repeatedOrderTotalCents: number | null;
} {
  let primaryCents = 0;
  let itemPriceSumCents = 0;
  const nonNullTotalCents: number[] = [];

  for (const row of activeRows) {
    const qty = row.quantity !== null && row.quantity > 0 ? row.quantity : 1;
    const itemPriceLineCents =
      row.itemPrice !== null && Number.isFinite(row.itemPrice)
        ? toCents(row.itemPrice * qty)
        : 0;
    itemPriceSumCents += itemPriceLineCents;

    if (row.total !== null && Number.isFinite(row.total)) {
      const tCents = toCents(row.total);
      primaryCents += tCents;
      nonNullTotalCents.push(tCents);
    } else if (row.itemPrice !== null && Number.isFinite(row.itemPrice)) {
      primaryCents += itemPriceLineCents;
    }
  }

  let repeatedOrderTotalCents: number | null = null;
  if (
    activeRows.length > 1 &&
    nonNullTotalCents.length > 1 &&
    nonNullTotalCents[0] > 0 &&
    nonNullTotalCents.every((t) => t === nonNullTotalCents[0]) &&
    itemPriceSumCents !== primaryCents
  ) {
    repeatedOrderTotalCents = nonNullTotalCents[0];
  }

  return { primaryCents, repeatedOrderTotalCents };
}

function buildOrderGroupFromRows(
  normOrder: string,
  allRows: AmazonOrderRecord[]
): OrderGroup | null {
  const allNonCancelledRows = allRows.filter((r) => r.status !== 'Cancelled');
  const activeRows = allNonCancelledRows.filter((r) => r.status !== 'Returned');
  const returnedRows = allNonCancelledRows.filter((r) => r.status === 'Returned');

  if (activeRows.length === 0) return null;

  const { primaryCents, repeatedOrderTotalCents } = computeOrderGroupAmounts(activeRows);
  const { primaryCents: returnedCents } = computeOrderGroupAmounts(returnedRows);
  const originalWithReturnsCents =
    returnedCents > 0 ? primaryCents + returnedCents : null;

  if (
    primaryCents <= 0 &&
    (repeatedOrderTotalCents ?? 0) <= 0 &&
    (originalWithReturnsCents ?? 0) <= 0
  ) {
    return null;
  }

  // Detect whether any Returned row has no matching active Delivered/Ordered row
  const activeSignatureCounts = new Map<string, number>();
  for (const r of activeRows) {
    const sig = `${r.itemDescription.trim().toLowerCase()}::${
      r.itemPrice !== null ? toCents(Math.abs(r.itemPrice)) : ''
    }`;
    activeSignatureCounts.set(sig, (activeSignatureCounts.get(sig) ?? 0) + 1);
  }
  const hasUniqueReturnedItems = returnedRows.some((r) => {
    const sig = `${r.itemDescription.trim().toLowerCase()}::${
      r.itemPrice !== null ? toCents(Math.abs(r.itemPrice)) : ''
    }`;
    return !activeSignatureCounts.has(sig);
  });

  const sortedDates = allNonCancelledRows
    .map((r) => r.orderDate.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => a.localeCompare(b));
  const orderDate = sortedDates[0] ?? allNonCancelledRows[0].orderDate.trim();

  const existingExpSet = new Map<string, string>();
  const existingBankSet = new Map<string, string>();
  const categories = new Set<string>();
  const descriptionTokens = new Set<string>();

  for (const row of allNonCancelledRows) {
    const eid = (row.expId ?? '').trim();
    if (eid && !existingExpSet.has(eid.toLowerCase())) {
      existingExpSet.set(eid.toLowerCase(), eid);
    }
    const bid = (row.bankId ?? '').trim();
    if (bid && !existingBankSet.has(bid.toLowerCase())) {
      existingBankSet.set(bid.toLowerCase(), bid);
    }
    const cat = (row.category ?? '').trim().toLowerCase();
    if (cat) categories.add(cat);
    for (const tok of extractMatchTokens(row.itemDescription)) {
      descriptionTokens.add(tok);
    }
  }

  return {
    normOrder,
    displayOrderNumber: allNonCancelledRows[0].orderNumber.trim() || normOrder,
    orderDate,
    activeRows,
    allNonCancelledRows,
    primaryCents,
    originalWithReturnsCents,
    repeatedOrderTotalCents,
    hasUniqueReturnedItems,
    existingExpIds: Array.from(existingExpSet.values()),
    existingBankIds: Array.from(existingBankSet.values()),
    categories,
    descriptionTokens,
  };
}

/**
 * Matches Amazon Order IDs (each Order ID may span 1 or more line-item rows in Amazon_Ledger)
 * against Expense Ledger records whose `Notes` contains "Amazon" and whose dollar amount
 * matches the Amazon Order ID amount.
 */
export function matchAmazonOrdersWithExpenses(
  amazonRecords: AmazonOrderRecord[],
  expenseRecords: ExpenseRecord[]
): AmazonExpenseReconPlan {
  const eligibleExpenses = expenseRecords.filter((exp) => {
    const expId = exp.expId.trim();
    if (!expId) return false;
    if (!expenseNotesHasAmazon(exp.notes)) return false;
    if (isCancelledExpenseStatus(exp.status)) return false;
    return toCents(Math.abs(exp.amount)) > 0;
  });

  const amazonExpById = new Map<string, ExpenseRecord>();
  const expensesByCents = new Map<number, ExpenseRecord[]>();
  for (const exp of eligibleExpenses) {
    const idNorm = exp.expId.trim().toLowerCase();
    if (!amazonExpById.has(idNorm)) {
      amazonExpById.set(idNorm, exp);
    }
    const cents = toCents(Math.abs(exp.amount));
    const bucket = expensesByCents.get(cents) ?? [];
    bucket.push(exp);
    expensesByCents.set(cents, bucket);
  }

  // Group saved non-duplicate Amazon sheet rows by normalized Order #
  const rowsByOrder = new Map<string, AmazonOrderRecord[]>();
  for (const rec of amazonRecords) {
    if (rec.isDuplicate) continue;
    if (rec.sourceOrigin !== 'sheet') continue;
    if (typeof rec.sheetRowNumber !== 'number' || rec.sheetRowNumber < 1) continue;
    const normOrder = normalizeAmazonOrderNumber(rec.orderNumber);
    if (!normOrder) continue;

    const list = rowsByOrder.get(normOrder) ?? [];
    list.push(rec);
    rowsByOrder.set(normOrder, list);
  }

  const orderGroups: OrderGroup[] = [];
  for (const [normOrder, allRows] of rowsByOrder.entries()) {
    const group = buildOrderGroupFromRows(normOrder, allRows);
    if (group) orderGroups.push(group);
  }

  const claimedOrderNumbers = new Set<string>();
  const claimedExpenseIds = new Set<string>();
  const matchedOrders: AmazonExpenseMatchOrderSummary[] = [];
  const rowUpdates: AmazonExpenseRowUpdate[] = [];
  let alreadyMatchedOrderCount = 0;

  // Step 1: Respect existing Exp_ID links & backfill sibling rows within partially-linked orders
  for (const group of orderGroups) {
    const allHaveExpId = group.activeRows.every(
      (r) => (r.expId ?? '').trim().length > 0
    );

    if (allHaveExpId) {
      claimedOrderNumbers.add(group.normOrder);
      alreadyMatchedOrderCount++;
      for (const eid of group.existingExpIds) {
        claimedExpenseIds.add(eid.toLowerCase());
      }
      continue;
    }

    if (group.existingExpIds.length === 1) {
      const existingExpId = group.existingExpIds[0];
      const existingExpNorm = existingExpId.toLowerCase();
      claimedExpenseIds.add(existingExpNorm);
      claimedOrderNumbers.add(group.normOrder);

      const linkedAmazonExp = amazonExpById.get(existingExpNorm);
      if (linkedAmazonExp) {
        const expCents = toCents(Math.abs(linkedAmazonExp.amount));
        const matchesWithReturns =
          group.originalWithReturnsCents !== null &&
          expCents === group.originalWithReturnsCents;
        const amountMatches =
          expCents === group.primaryCents ||
          matchesWithReturns ||
          (group.repeatedOrderTotalCents !== null &&
            expCents === group.repeatedOrderTotalCents);

        if (amountMatches) {
          const targetRows = matchesWithReturns
            ? group.allNonCancelledRows
            : group.activeRows;
          const rowsNeedingBackfill = targetRows.filter(
            (r) => (r.expId ?? '').trim() !== existingExpId
          );
          if (rowsNeedingBackfill.length > 0) {
            for (const row of rowsNeedingBackfill) {
              rowUpdates.push({
                sheetRowNumber: row.sheetRowNumber as number,
                uniqueId: row.uniqueId,
                orderNumber: group.displayOrderNumber,
                expId: existingExpId,
              });
            }
            matchedOrders.push({
              orderNumber: group.displayOrderNumber,
              orderDate: group.orderDate,
              orderAmount: expCents / 100,
              expId: existingExpId,
              expenseDate: linkedAmazonExp.date,
              expenseDescription: linkedAmazonExp.description,
              rowCount: rowsNeedingBackfill.length,
              sheetRowNumbers: rowsNeedingBackfill.map((r) => r.sheetRowNumber as number),
            });
          } else {
            alreadyMatchedOrderCount++;
          }
          continue;
        }
      }

      alreadyMatchedOrderCount++;
    } else if (group.existingExpIds.length > 1) {
      // Mixed pre-existing IDs in the same order: leave existing rows untouched and claim those IDs
      claimedOrderNumbers.add(group.normOrder);
      alreadyMatchedOrderCount++;
      for (const eid of group.existingExpIds) {
        claimedExpenseIds.add(eid.toLowerCase());
      }
    }
  }

  // Step 2: Score candidate (unmatched OrderGroup <-> unclaimed Amazon Expense) pairs
  interface CandidatePair {
    group: OrderGroup;
    expense: ExpenseRecord;
    matchedCents: number;
    includesReturnedRows: boolean;
    score: number;
    dateDiffDays: number;
  }

  const candidatePairs: CandidatePair[] = [];

  for (const group of orderGroups) {
    if (claimedOrderNumbers.has(group.normOrder)) continue;

    const amountTargets: Array<{
      cents: number;
      baseScore: number;
      includesReturnedRows: boolean;
    }> = [];
    if (
      group.originalWithReturnsCents !== null &&
      group.originalWithReturnsCents > 0 &&
      group.originalWithReturnsCents !== group.primaryCents
    ) {
      amountTargets.push({
        cents: group.originalWithReturnsCents,
        baseScore: group.hasUniqueReturnedItems ? 1050 : 950,
        includesReturnedRows: true,
      });
    }
    if (group.primaryCents > 0) {
      amountTargets.push({
        cents: group.primaryCents,
        baseScore: 1000,
        includesReturnedRows: false,
      });
    }
    if (
      group.repeatedOrderTotalCents !== null &&
      group.repeatedOrderTotalCents > 0 &&
      group.repeatedOrderTotalCents !== group.primaryCents
    ) {
      amountTargets.push({
        cents: group.repeatedOrderTotalCents,
        baseScore: 500,
        includesReturnedRows: false,
      });
    }

    const orderDays = parseIsoDateToUtcDays(group.orderDate);

    for (const target of amountTargets) {
      const bucket = expensesByCents.get(target.cents) ?? [];
      for (const exp of bucket) {
        const expIdNorm = exp.expId.trim().toLowerCase();
        if (claimedExpenseIds.has(expIdNorm)) continue;

        let score = target.baseScore;

        // Direct Order # mention in Expense description or Recon Source ID
        const expSearchCompact = `${exp.description} ${exp.reconSourceId}`
          .replace(/[#\s]/g, '')
          .toUpperCase();
        if (group.normOrder.length >= 6 && expSearchCompact.includes(group.normOrder)) {
          score += 1000;
        }

        // Date proximity tie-breaker (closer dates outrank farther dates)
        const expDays = parseIsoDateToUtcDays(exp.date);
        const dateDiffDays =
          orderDays !== null && expDays !== null ? Math.abs(orderDays - expDays) : 180;
        score -= Math.min(dateDiffDays, 365);

        // Category & description token alignment
        const expCategory = exp.category.trim().toLowerCase();
        if (expCategory && group.categories.has(expCategory)) {
          score += 50;
        }

        const expTokens = extractMatchTokens(`${exp.description} ${exp.subCategory}`);
        let sharedTokens = 0;
        for (const tok of expTokens) {
          if (group.descriptionTokens.has(tok)) sharedTokens++;
        }
        if (sharedTokens > 0) {
          score += Math.min(sharedTokens * 10, 40);
        }

        candidatePairs.push({
          group,
          expense: exp,
          matchedCents: target.cents,
          includesReturnedRows: target.includesReturnedRows,
          score,
          dateDiffDays,
        });
      }
    }
  }

  candidatePairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    if (b.group.orderDate !== a.group.orderDate) {
      return b.group.orderDate.localeCompare(a.group.orderDate);
    }
    const orderCmp = a.group.normOrder.localeCompare(b.group.normOrder);
    if (orderCmp !== 0) return orderCmp;
    return a.expense.expId.localeCompare(b.expense.expId);
  });

  // Step 3: Greedy 1-to-1 assignment (1 Amazon Order ID -> 1 Expense ID, updating all items in the Order ID)
  for (const pair of candidatePairs) {
    const expIdTrimmed = pair.expense.expId.trim();
    const expIdNorm = expIdTrimmed.toLowerCase();
    if (
      claimedOrderNumbers.has(pair.group.normOrder) ||
      claimedExpenseIds.has(expIdNorm)
    ) {
      continue;
    }

    claimedOrderNumbers.add(pair.group.normOrder);
    claimedExpenseIds.add(expIdNorm);

    const targetRows = pair.includesReturnedRows
      ? pair.group.allNonCancelledRows
      : pair.group.activeRows;
    const rowsToUpdate = targetRows.filter(
      (r) => (r.expId ?? '').trim() !== expIdTrimmed
    );
    if (rowsToUpdate.length === 0) continue;

    for (const row of rowsToUpdate) {
      rowUpdates.push({
        sheetRowNumber: row.sheetRowNumber as number,
        uniqueId: row.uniqueId,
        orderNumber: pair.group.displayOrderNumber,
        expId: expIdTrimmed,
      });
    }

    matchedOrders.push({
      orderNumber: pair.group.displayOrderNumber,
      orderDate: pair.group.orderDate,
      orderAmount: pair.matchedCents / 100,
      expId: expIdTrimmed,
      expenseDate: pair.expense.date,
      expenseDescription: pair.expense.description,
      rowCount: rowsToUpdate.length,
      sheetRowNumbers: rowsToUpdate.map((r) => r.sheetRowNumber as number),
    });
  }

  let unmatchedExpenseCount = 0;
  for (const exp of eligibleExpenses) {
    if (!claimedExpenseIds.has(exp.expId.trim().toLowerCase())) {
      unmatchedExpenseCount++;
    }
  }

  let unmatchedOrderCount = 0;
  for (const group of orderGroups) {
    if (!claimedOrderNumbers.has(group.normOrder)) {
      unmatchedOrderCount++;
    }
  }

  return {
    eligibleExpenseCount: eligibleExpenses.length,
    eligibleOrderCount: orderGroups.length - alreadyMatchedOrderCount,
    alreadyMatchedOrderCount,
    matchedOrders,
    rowUpdates,
    unmatchedExpenseCount,
    unmatchedOrderCount,
  };
}

/**
 * Matches Amazon Order IDs (each Order ID may span 1 or more line-item rows in Amazon_Ledger)
 * against Bank Statement Ledger expense transactions whose `Notes` contains "Amazon"
 * and whose dollar amount matches the Amazon Order ID amount.
 * Updates `Bank_ID` and sets `Is_Recon` to `'Yes'` on all active rows of matched Order IDs.
 */
export function matchAmazonOrdersWithBank(
  amazonRecords: AmazonOrderRecord[],
  bankRecords: BankStatementLookupInput[]
): AmazonBankReconPlan {
  const getBankAbsCents = (tx: BankStatementLookupInput): number => {
    const rawCents =
      typeof tx.amountCents === 'number' && Number.isFinite(tx.amountCents) && tx.amountCents !== 0
        ? tx.amountCents
        : toCents(tx.amount);
    return Math.abs(rawCents);
  };

  const eligibleBank = bankRecords.filter((tx) => {
    if (tx.reviewStatus === 'discarded') return false;
    if (tx.transactionType !== 'Expense') return false;
    const bankId = tx.uniqueId.trim();
    if (!bankId) return false;
    if (!expenseNotesHasAmazon(tx.notes)) return false;
    return getBankAbsCents(tx) > 0;
  });

  const amazonBankById = new Map<string, BankStatementLookupInput>();
  const bankByCents = new Map<number, BankStatementLookupInput[]>();
  for (const tx of eligibleBank) {
    const idNorm = tx.uniqueId.trim().toLowerCase();
    if (!amazonBankById.has(idNorm)) {
      amazonBankById.set(idNorm, tx);
    }
    const cents = getBankAbsCents(tx);
    const bucket = bankByCents.get(cents) ?? [];
    bucket.push(tx);
    bankByCents.set(cents, bucket);
  }

  // Group saved non-duplicate Amazon sheet rows by normalized Order #
  const rowsByOrder = new Map<string, AmazonOrderRecord[]>();
  for (const rec of amazonRecords) {
    if (rec.isDuplicate) continue;
    if (rec.sourceOrigin !== 'sheet') continue;
    if (typeof rec.sheetRowNumber !== 'number' || rec.sheetRowNumber < 1) continue;
    const normOrder = normalizeAmazonOrderNumber(rec.orderNumber);
    if (!normOrder) continue;

    const list = rowsByOrder.get(normOrder) ?? [];
    list.push(rec);
    rowsByOrder.set(normOrder, list);
  }

  const orderGroups: OrderGroup[] = [];
  for (const [normOrder, allRows] of rowsByOrder.entries()) {
    const group = buildOrderGroupFromRows(normOrder, allRows);
    if (group) orderGroups.push(group);
  }

  const claimedOrderNumbers = new Set<string>();
  const claimedBankIds = new Set<string>();
  const matchedOrders: AmazonBankMatchOrderSummary[] = [];
  const rowUpdates: AmazonBankRowUpdate[] = [];
  let alreadyMatchedOrderCount = 0;

  // Step 1: Respect existing Bank_ID links & backfill sibling rows or missing Is_Recon='Yes'
  for (const group of orderGroups) {
    const allHaveBankId = group.activeRows.every(
      (r) => (r.bankId ?? '').trim().length > 0
    );

    if (allHaveBankId) {
      claimedOrderNumbers.add(group.normOrder);
      for (const bid of group.existingBankIds) {
        claimedBankIds.add(bid.toLowerCase());
      }

      if (group.existingBankIds.length === 1) {
        const existingBankId = group.existingBankIds[0];
        const linkedAmazonBank = amazonBankById.get(existingBankId.toLowerCase());
        if (linkedAmazonBank) {
          const bankCents = getBankAbsCents(linkedAmazonBank);
          const matchesWithReturns =
            group.originalWithReturnsCents !== null &&
            bankCents === group.originalWithReturnsCents;
          const amountMatches =
            bankCents === group.primaryCents ||
            matchesWithReturns ||
            (group.repeatedOrderTotalCents !== null &&
              bankCents === group.repeatedOrderTotalCents);
          const targetRows = matchesWithReturns
            ? group.allNonCancelledRows
            : group.activeRows;
          const rowsNeedingReconSync = targetRows.filter(
            (r) => (r.bankId ?? '').trim() !== existingBankId || r.isRecon !== 'Yes'
          );
          if (amountMatches && rowsNeedingReconSync.length > 0) {
            for (const row of rowsNeedingReconSync) {
              rowUpdates.push({
                sheetRowNumber: row.sheetRowNumber as number,
                uniqueId: row.uniqueId,
                orderNumber: group.displayOrderNumber,
                bankId: existingBankId,
                isRecon: 'Yes',
              });
            }
            matchedOrders.push({
              orderNumber: group.displayOrderNumber,
              orderDate: group.orderDate,
              orderAmount: bankCents / 100,
              bankId: existingBankId,
              bankDate: linkedAmazonBank.date,
              bankDescription: linkedAmazonBank.description,
              accountTab: linkedAmazonBank.accountTab,
              rowCount: rowsNeedingReconSync.length,
              sheetRowNumbers: rowsNeedingReconSync.map((r) => r.sheetRowNumber as number),
            });
            continue;
          }
        }
      }

      alreadyMatchedOrderCount++;
      continue;
    }

    if (group.existingBankIds.length === 1) {
      const existingBankId = group.existingBankIds[0];
      const existingBankNorm = existingBankId.toLowerCase();
      claimedBankIds.add(existingBankNorm);
      claimedOrderNumbers.add(group.normOrder);

      const linkedAmazonBank = amazonBankById.get(existingBankNorm);
      if (linkedAmazonBank) {
        const bankCents = getBankAbsCents(linkedAmazonBank);
        const matchesWithReturns =
          group.originalWithReturnsCents !== null &&
          bankCents === group.originalWithReturnsCents;
        const amountMatches =
          bankCents === group.primaryCents ||
          matchesWithReturns ||
          (group.repeatedOrderTotalCents !== null &&
            bankCents === group.repeatedOrderTotalCents);

        if (amountMatches) {
          const targetRows = matchesWithReturns
            ? group.allNonCancelledRows
            : group.activeRows;
          const rowsNeedingBackfill = targetRows.filter(
            (r) => (r.bankId ?? '').trim() !== existingBankId || r.isRecon !== 'Yes'
          );
          if (rowsNeedingBackfill.length > 0) {
            for (const row of rowsNeedingBackfill) {
              rowUpdates.push({
                sheetRowNumber: row.sheetRowNumber as number,
                uniqueId: row.uniqueId,
                orderNumber: group.displayOrderNumber,
                bankId: existingBankId,
                isRecon: 'Yes',
              });
            }
            matchedOrders.push({
              orderNumber: group.displayOrderNumber,
              orderDate: group.orderDate,
              orderAmount: bankCents / 100,
              bankId: existingBankId,
              bankDate: linkedAmazonBank.date,
              bankDescription: linkedAmazonBank.description,
              accountTab: linkedAmazonBank.accountTab,
              rowCount: rowsNeedingBackfill.length,
              sheetRowNumbers: rowsNeedingBackfill.map((r) => r.sheetRowNumber as number),
            });
          } else {
            alreadyMatchedOrderCount++;
          }
          continue;
        }
      }

      alreadyMatchedOrderCount++;
    } else if (group.existingBankIds.length > 1) {
      claimedOrderNumbers.add(group.normOrder);
      alreadyMatchedOrderCount++;
      for (const bid of group.existingBankIds) {
        claimedBankIds.add(bid.toLowerCase());
      }
    }
  }

  // Step 2: Score candidate (unmatched OrderGroup <-> unclaimed Amazon Bank Expense) pairs
  interface CandidateBankPair {
    group: OrderGroup;
    bankTx: BankStatementLookupInput;
    matchedCents: number;
    includesReturnedRows: boolean;
    score: number;
    dateDiffDays: number;
  }

  const candidatePairs: CandidateBankPair[] = [];

  for (const group of orderGroups) {
    if (claimedOrderNumbers.has(group.normOrder)) continue;

    const amountTargets: Array<{
      cents: number;
      baseScore: number;
      includesReturnedRows: boolean;
    }> = [];
    if (
      group.originalWithReturnsCents !== null &&
      group.originalWithReturnsCents > 0 &&
      group.originalWithReturnsCents !== group.primaryCents
    ) {
      amountTargets.push({
        cents: group.originalWithReturnsCents,
        baseScore: group.hasUniqueReturnedItems ? 1050 : 950,
        includesReturnedRows: true,
      });
    }
    if (group.primaryCents > 0) {
      amountTargets.push({
        cents: group.primaryCents,
        baseScore: 1000,
        includesReturnedRows: false,
      });
    }
    if (
      group.repeatedOrderTotalCents !== null &&
      group.repeatedOrderTotalCents > 0 &&
      group.repeatedOrderTotalCents !== group.primaryCents
    ) {
      amountTargets.push({
        cents: group.repeatedOrderTotalCents,
        baseScore: 500,
        includesReturnedRows: false,
      });
    }

    const orderDays = parseIsoDateToUtcDays(group.orderDate);

    for (const target of amountTargets) {
      const bucket = bankByCents.get(target.cents) ?? [];
      for (const tx of bucket) {
        const bankIdNorm = tx.uniqueId.trim().toLowerCase();
        if (claimedBankIds.has(bankIdNorm)) continue;

        let score = target.baseScore;

        // Direct Order # mention in Bank description or referenceNumber
        const bankSearchCompact = `${tx.description} ${tx.referenceNumber}`
          .replace(/[#\s]/g, '')
          .toUpperCase();
        if (group.normOrder.length >= 6 && bankSearchCompact.includes(group.normOrder)) {
          score += 1000;
        }

        // Date proximity tie-breaker
        const bankDays = parseIsoDateToUtcDays(tx.date);
        const dateDiffDays =
          orderDays !== null && bankDays !== null ? Math.abs(orderDays - bankDays) : 180;
        score -= Math.min(dateDiffDays, 365);

        // Category & description token alignment
        const bankCategory = (tx.category ?? '').trim().toLowerCase();
        if (bankCategory && group.categories.has(bankCategory)) {
          score += 50;
        }

        const bankTokens = extractMatchTokens(tx.description);
        let sharedTokens = 0;
        for (const tok of bankTokens) {
          if (group.descriptionTokens.has(tok)) sharedTokens++;
        }
        if (sharedTokens > 0) {
          score += Math.min(sharedTokens * 10, 40);
        }

        candidatePairs.push({
          group,
          bankTx: tx,
          matchedCents: target.cents,
          includesReturnedRows: target.includesReturnedRows,
          score,
          dateDiffDays,
        });
      }
    }
  }

  candidatePairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    if (b.group.orderDate !== a.group.orderDate) {
      return b.group.orderDate.localeCompare(a.group.orderDate);
    }
    const orderCmp = a.group.normOrder.localeCompare(b.group.normOrder);
    if (orderCmp !== 0) return orderCmp;
    return a.bankTx.uniqueId.localeCompare(b.bankTx.uniqueId);
  });

  // Step 3: Greedy 1-to-1 assignment (1 Amazon Order ID -> 1 Bank Unique ID, updating Bank_ID & Is_Recon='Yes')
  for (const pair of candidatePairs) {
    const bankIdTrimmed = pair.bankTx.uniqueId.trim();
    const bankIdNorm = bankIdTrimmed.toLowerCase();
    if (
      claimedOrderNumbers.has(pair.group.normOrder) ||
      claimedBankIds.has(bankIdNorm)
    ) {
      continue;
    }

    claimedOrderNumbers.add(pair.group.normOrder);
    claimedBankIds.add(bankIdNorm);

    const targetRows = pair.includesReturnedRows
      ? pair.group.allNonCancelledRows
      : pair.group.activeRows;
    const rowsToUpdate = targetRows.filter(
      (r) => (r.bankId ?? '').trim() !== bankIdTrimmed || r.isRecon !== 'Yes'
    );
    if (rowsToUpdate.length === 0) continue;

    for (const row of rowsToUpdate) {
      rowUpdates.push({
        sheetRowNumber: row.sheetRowNumber as number,
        uniqueId: row.uniqueId,
        orderNumber: pair.group.displayOrderNumber,
        bankId: bankIdTrimmed,
        isRecon: 'Yes',
      });
    }

    matchedOrders.push({
      orderNumber: pair.group.displayOrderNumber,
      orderDate: pair.group.orderDate,
      orderAmount: pair.matchedCents / 100,
      bankId: bankIdTrimmed,
      bankDate: pair.bankTx.date,
      bankDescription: pair.bankTx.description,
      accountTab: pair.bankTx.accountTab,
      rowCount: rowsToUpdate.length,
      sheetRowNumbers: rowsToUpdate.map((r) => r.sheetRowNumber as number),
    });
  }

  let unmatchedBankCount = 0;
  for (const tx of eligibleBank) {
    if (!claimedBankIds.has(tx.uniqueId.trim().toLowerCase())) {
      unmatchedBankCount++;
    }
  }

  let unmatchedOrderCount = 0;
  for (const group of orderGroups) {
    if (!claimedOrderNumbers.has(group.normOrder)) {
      unmatchedOrderCount++;
    }
  }

  return {
    eligibleBankCount: eligibleBank.length,
    eligibleOrderCount: orderGroups.length - alreadyMatchedOrderCount,
    alreadyMatchedOrderCount,
    matchedOrders,
    rowUpdates,
    unmatchedBankCount,
    unmatchedOrderCount,
  };
}
