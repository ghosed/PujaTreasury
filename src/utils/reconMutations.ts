import { ExpenseRecord } from '../types/expense';
import {
  AllocationSummary,
  NewReconLinkInput,
  ReconLink,
} from '../types/reconciliation';
import { AccountType } from '../types/statement';
import {
  bankEntryKey,
  computeBankAllocationMap,
  computeDerivedLedgerSyncPatches,
  computeExpenseAllocationMap,
  expenseRecordKey,
  fromCents,
  RECON_PENNY_TOLERANCE_CENTS,
  reconPairKey,
  toCents,
  validateNewReconLinks,
} from './reconAllocations';
import {
  BankLedgerEntry,
  LinkedBankFieldPatch,
  LinkedExpenseFieldPatch,
} from './reconciler';

export interface FifoProposalItem {
  pairKey: string;
  bankEntry: BankLedgerEntry;
  expense: ExpenseRecord;
  allocatedAmount: number;
  allocatedCents: number;
  notes: string;
}

/**
 * Generates automatic FIFO allocation proposals across a selected set of
 * Bank Expense transactions and Expense Ledger records using their remaining
 * unallocated balances.
 */
export function buildFifoAllocationProposals(
  selectedBanks: BankLedgerEntry[],
  selectedExpenses: ExpenseRecord[],
  bankAllocMap: Map<string, AllocationSummary>,
  expAllocMap: Map<string, AllocationSummary>,
  existingLinks: ReconLink[] = []
): FifoProposalItem[] {
  if (selectedBanks.length === 0 || selectedExpenses.length === 0) {
    return [];
  }

  const existingPairSet = new Set<string>(
    existingLinks.map((l) => reconPairKey(l.bankUniqueId, l.targetType, l.targetId))
  );

  const sortedBanks = [...selectedBanks].sort((a, b) => {
    const cmp = a.tx.date.localeCompare(b.tx.date);
    if (cmp !== 0) return cmp;
    return a.tx.uniqueId.localeCompare(b.tx.uniqueId);
  });

  const sortedExps = [...selectedExpenses].sort((a, b) => {
    const cmp = a.date.localeCompare(b.date);
    if (cmp !== 0) return cmp;
    return a.expId.localeCompare(b.expId);
  });

  const bankRemByIdx = sortedBanks.map((entry) => {
    const summary = bankAllocMap.get(bankEntryKey(entry));
    return summary ? summary.remainingCents : Math.abs(entry.tx.amountCents);
  });

  const expRemByIdx = sortedExps.map((exp) => {
    const summary = expAllocMap.get(expenseRecordKey(exp));
    return summary ? summary.remainingCents : toCents(Math.abs(exp.amount));
  });

  const proposals: FifoProposalItem[] = [];

  for (let bIdx = 0; bIdx < sortedBanks.length; bIdx++) {
    const bankEntry = sortedBanks[bIdx];
    if (bankRemByIdx[bIdx] <= RECON_PENNY_TOLERANCE_CENTS) continue;

    for (let eIdx = 0; eIdx < sortedExps.length; eIdx++) {
      if (bankRemByIdx[bIdx] <= RECON_PENNY_TOLERANCE_CENTS) break;
      if (expRemByIdx[eIdx] <= RECON_PENNY_TOLERANCE_CENTS) continue;

      const expense = sortedExps[eIdx];
      const pKey = reconPairKey(bankEntry.tx.uniqueId, 'Expense', expense.expId);
      if (existingPairSet.has(pKey)) continue;

      const allocCents = Math.min(bankRemByIdx[bIdx], expRemByIdx[eIdx]);
      if (allocCents <= 0) continue;

      bankRemByIdx[bIdx] -= allocCents;
      expRemByIdx[eIdx] -= allocCents;
      existingPairSet.add(pKey);

      proposals.push({
        pairKey: pKey,
        bankEntry,
        expense,
        allocatedAmount: fromCents(allocCents),
        allocatedCents: allocCents,
        notes: '',
      });
    }
  }

  return proposals;
}

export interface CommitReconLinksPlan {
  valid: boolean;
  errors: string[];
  linksToAppend: ReconLink[];
  bankUpdatesByTab: Record<AccountType, LinkedBankFieldPatch[]>;
  expenseUpdates: LinkedExpenseFieldPatch[];
  nextEffectiveLinks: ReconLink[];
}

/**
 * Validates candidate new Recon_Links, materializes any legacy virtual 1:1 links
 * connected to the touched Bank/Expense IDs so Recon_Links becomes the complete
 * source of truth, and computes derived Google Sheet patches for Bank_Ledger and
 * Expense_Ledger.
 */
export function planCommitReconLinks(
  candidates: NewReconLinkInput[],
  existingEffectiveLinks: ReconLink[],
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[]
): CommitReconLinksPlan {
  const validation = validateNewReconLinks(
    existingEffectiveLinks,
    candidates,
    bankEntries,
    expenses
  );

  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors,
      linksToAppend: [],
      bankUpdatesByTab: { Puja: [], Regular: [] },
      expenseUpdates: [],
      nextEffectiveLinks: existingEffectiveLinks,
    };
  }

  const touchedBankIds = new Set<string>();
  const touchedExpenseIds = new Set<string>();

  for (const link of validation.normalizedLinks) {
    touchedBankIds.add(link.bankUniqueId.trim().toLowerCase());
    if (link.targetType === 'Expense') {
      touchedExpenseIds.add(link.targetId.trim().toLowerCase());
    }
  }

  // Materialize any touched legacy 1:1 virtual links so adding a 2nd link never loses the 1st
  const materializedVirtualLinks: ReconLink[] = [];
  for (const link of existingEffectiveLinks) {
    if (link.sheetRowNumber !== null) continue;
    const bNorm = link.bankUniqueId.trim().toLowerCase();
    const tNorm = link.targetId.trim().toLowerCase();
    const touchesBank = touchedBankIds.has(bNorm);
    const touchesExp = link.targetType === 'Expense' && touchedExpenseIds.has(tNorm);
    if (touchesBank || touchesExp) {
      materializedVirtualLinks.push({
        ...link,
        linkedAt: link.linkedAt || new Date().toISOString(),
      });
      touchedBankIds.add(bNorm);
      if (link.targetType === 'Expense') {
        touchedExpenseIds.add(tNorm);
      }
    }
  }

  const linksToAppend = [...materializedVirtualLinks, ...validation.normalizedLinks];
  const nextEffectiveLinks = [...existingEffectiveLinks, ...validation.normalizedLinks];

  const { bankUpdatesByTab, expenseUpdates } = computeDerivedLedgerSyncPatches(
    nextEffectiveLinks,
    bankEntries,
    expenses,
    {
      touchedBankIds,
      touchedExpenseIds,
    }
  );

  return {
    valid: true,
    errors: [],
    linksToAppend,
    bankUpdatesByTab,
    expenseUpdates,
    nextEffectiveLinks,
  };
}

export interface UnlinkReconLinkPlan {
  rowNumbersToDelete: number[];
  bankUpdatesByTab: Record<AccountType, LinkedBankFieldPatch[]>;
  expenseUpdates: LinkedExpenseFieldPatch[];
  nextEffectiveLinks: ReconLink[];
}

/**
 * Plans removing a single Recon_Link (explicit or legacy virtual 1:1), computing
 * which Recon_Links row to delete and how both ledgers' Target_ID / Recon_Source_ID /
 * Is_Recon / Category ("Multiple" -> single or "") should revert.
 */
export function planUnlinkReconLink(
  linkToRemove: ReconLink,
  existingEffectiveLinks: ReconLink[],
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[]
): UnlinkReconLinkPlan {
  const removePairKey = reconPairKey(
    linkToRemove.bankUniqueId,
    linkToRemove.targetType,
    linkToRemove.targetId
  );

  const rowNumbersToDelete =
    typeof linkToRemove.sheetRowNumber === 'number' && linkToRemove.sheetRowNumber >= 2
      ? [linkToRemove.sheetRowNumber]
      : [];

  const nextEffectiveLinks = existingEffectiveLinks.filter(
    (l) => reconPairKey(l.bankUniqueId, l.targetType, l.targetId) !== removePairKey
  );

  const touchedBankIds = new Set<string>([
    linkToRemove.bankUniqueId.trim().toLowerCase(),
  ]);
  const touchedExpenseIds = new Set<string>(
    linkToRemove.targetType === 'Expense'
      ? [linkToRemove.targetId.trim().toLowerCase()]
      : []
  );

  const { bankUpdatesByTab, expenseUpdates } = computeDerivedLedgerSyncPatches(
    nextEffectiveLinks,
    bankEntries,
    expenses,
    {
      touchedBankIds,
      touchedExpenseIds,
    }
  );

  return {
    rowNumbersToDelete,
    bankUpdatesByTab,
    expenseUpdates,
    nextEffectiveLinks,
  };
}

/**
 * Convenience helper to compute both Bank and Expense allocation maps together
 * from effective links.
 */
export function computeBothAllocationMaps(
  bankEntries: BankLedgerEntry[],
  expenses: ExpenseRecord[],
  effectiveLinks: ReconLink[]
) {
  return {
    bankAllocMap: computeBankAllocationMap(bankEntries, effectiveLinks),
    expAllocMap: computeExpenseAllocationMap(expenses, effectiveLinks),
  };
}
