import {
  batchUpdateExpenseReconIds,
  EXPENSE_SPREADSHEET_ID,
  fetchExpenseWorkspace,
  LoadedExpenseWorkspace,
} from './expenseSheets';
import {
  BankSheetColumnLayout,
  batchUpdateBankReconciliation,
  fetchSheetLedger,
  LoadedSheetLedger,
  TARGET_SPREADSHEET_ID,
} from './googleSheets';
import {
  appendReconLinks,
  deleteReconLinksByRowNumbers,
  fetchReconLinks,
  updateReconLinkRows,
} from './reconLinksSheets';
import {
  NewReconLinkInput,
  ReconLink,
  ReconTargetType,
} from '../types/reconciliation';
import { AccountType } from '../types/statement';
import {
  buildEffectiveReconLinks,
  reconPairKey,
} from '../utils/reconAllocations';
import {
  planCommitReconLinks,
  planUnlinkReconLink,
} from '../utils/reconMutations';
import { BankLedgerEntry } from '../utils/reconciler';

export interface ExecutedReconResult {
  appendedLinksCount: number;
  deletedLinksCount: number;
  bankUpdatedCount: number;
  expenseUpdatedCount: number;
  updatedTabs: AccountType[];
  reconLinks: ReconLink[];
  bankLedgers: Record<AccountType, LoadedSheetLedger>;
  expenseWorkspace: LoadedExpenseWorkspace;
}

function toColumnLayout(ledger: LoadedSheetLedger): BankSheetColumnLayout {
  return {
    descriptionColIndex: ledger.descriptionColIndex,
    referenceColIndex: ledger.referenceColIndex,
    sourceColIndex: ledger.sourceColIndex,
    hasTargetIdHeader: ledger.hasTargetIdHeader,
    targetIdColIndex: ledger.targetIdColIndex,
    hasIsReconHeader: ledger.hasIsReconHeader,
    isReconColIndex: ledger.isReconColIndex,
    hasCategoryHeader: ledger.hasCategoryHeader,
    categoryColIndex: ledger.categoryColIndex,
    hasNotesHeader: ledger.hasNotesHeader,
    notesColIndex: ledger.notesColIndex,
  };
}

/**
 * Atomically validates and commits new Recon_Links (materializing any touched
 * legacy 1:1 virtual links) and applies derived Target_ID, Recon_Source_ID,
 * Is_Recon, and Category updates across Bank_Ledger and Expense_Ledger.
 */
export async function executeAddReconLinks(
  accessToken: string,
  candidates: NewReconLinkInput[]
): Promise<ExecutedReconResult> {
  const [pujaLedger, regularLedger, expenseWorkspace, loadedLinks] =
    await Promise.all([
      fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Puja'),
      fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Regular'),
      fetchExpenseWorkspace(accessToken, EXPENSE_SPREADSHEET_ID),
      fetchReconLinks(accessToken, TARGET_SPREADSHEET_ID).catch(() => null),
    ]);

  const sheetLinks = loadedLinks?.links ?? [];
  const bankEntries: BankLedgerEntry[] = [
    ...pujaLedger.transactions.map((tx) => ({ tab: 'Puja' as AccountType, tx })),
    ...regularLedger.transactions.map((tx) => ({
      tab: 'Regular' as AccountType,
      tx,
    })),
  ];

  const effectiveLinks = buildEffectiveReconLinks(
    sheetLinks,
    bankEntries,
    expenseWorkspace.records
  );

  const plan = planCommitReconLinks(
    candidates,
    effectiveLinks,
    bankEntries,
    expenseWorkspace.records
  );

  if (!plan.valid) {
    throw new Error(plan.errors.join(' '));
  }

  let appendedLinksCount = 0;
  if (plan.linksToAppend.length > 0) {
    const appendRes = await appendReconLinks(
      accessToken,
      plan.linksToAppend.map((l) => ({
        linkId: l.linkId,
        bankTab: l.bankTab,
        bankUniqueId: l.bankUniqueId,
        targetType: l.targetType,
        targetId: l.targetId,
        allocatedAmount: l.allocatedAmount,
        category: l.category,
        linkMode: l.linkMode,
        linkedAt: l.linkedAt,
        notes: l.notes,
      })),
      TARGET_SPREADSHEET_ID
    );
    appendedLinksCount = appendRes.appendedCount;
  }

  const bankLedgers: Record<AccountType, LoadedSheetLedger> = {
    Puja: pujaLedger,
    Regular: regularLedger,
  };

  let bankUpdatedCount = 0;
  const updatedTabs: AccountType[] = [];

  for (const tab of ['Puja', 'Regular'] as AccountType[]) {
    const updates = plan.bankUpdatesByTab[tab];
    const ledger = bankLedgers[tab];
    if (updates.length > 0 && ledger.tabExists) {
      const count = await batchUpdateBankReconciliation(
        accessToken,
        TARGET_SPREADSHEET_ID,
        tab,
        toColumnLayout(ledger),
        updates
      );
      bankUpdatedCount += count;
      updatedTabs.push(tab);
    }
  }

  let expenseUpdatedCount = 0;
  if (plan.expenseUpdates.length > 0) {
    expenseUpdatedCount = await batchUpdateExpenseReconIds(
      accessToken,
      expenseWorkspace.meta,
      plan.expenseUpdates
    );
  }

  // Re-fetch authoritative state so callers stay 100% in sync with Google Sheets
  const [freshPuja, freshRegular, freshExpenseWs, freshLinks] = await Promise.all([
    updatedTabs.includes('Puja')
      ? fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Puja')
      : Promise.resolve(pujaLedger),
    updatedTabs.includes('Regular')
      ? fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Regular')
      : Promise.resolve(regularLedger),
    expenseUpdatedCount > 0
      ? fetchExpenseWorkspace(accessToken, EXPENSE_SPREADSHEET_ID)
      : Promise.resolve(expenseWorkspace),
    fetchReconLinks(accessToken, TARGET_SPREADSHEET_ID).catch(() => loadedLinks),
  ]);

  return {
    appendedLinksCount,
    deletedLinksCount: 0,
    bankUpdatedCount,
    expenseUpdatedCount,
    updatedTabs,
    reconLinks: freshLinks?.links ?? plan.nextEffectiveLinks,
    bankLedgers: {
      Puja: freshPuja,
      Regular: freshRegular,
    },
    expenseWorkspace: freshExpenseWs,
  };
}

/**
 * Unlinks a single reconciliation pair (either explicit Recon_Links row or legacy
 * virtual 1:1 pair) and propagates reverted Target_ID, Recon_Source_ID, Is_Recon,
 * and Category ("Multiple" -> single or "") updates across both spreadsheets.
 */
export async function executeUnlinkReconLink(
  accessToken: string,
  pair: {
    bankUniqueId: string;
    targetType: ReconTargetType;
    targetId: string;
  }
): Promise<ExecutedReconResult> {
  const [pujaLedger, regularLedger, expenseWorkspace, loadedLinks] =
    await Promise.all([
      fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Puja'),
      fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Regular'),
      fetchExpenseWorkspace(accessToken, EXPENSE_SPREADSHEET_ID),
      fetchReconLinks(accessToken, TARGET_SPREADSHEET_ID).catch(() => null),
    ]);

  const sheetLinks = loadedLinks?.links ?? [];
  const bankEntries: BankLedgerEntry[] = [
    ...pujaLedger.transactions.map((tx) => ({ tab: 'Puja' as AccountType, tx })),
    ...regularLedger.transactions.map((tx) => ({
      tab: 'Regular' as AccountType,
      tx,
    })),
  ];

  const effectiveLinks = buildEffectiveReconLinks(
    sheetLinks,
    bankEntries,
    expenseWorkspace.records
  );

  const targetKey = reconPairKey(
    pair.bankUniqueId,
    pair.targetType,
    pair.targetId
  );
  const matchingLink: ReconLink =
    effectiveLinks.find(
      (l) => reconPairKey(l.bankUniqueId, l.targetType, l.targetId) === targetKey
    ) ?? {
      linkId: '',
      sheetRowNumber: null,
      bankTab: 'Regular',
      bankUniqueId: pair.bankUniqueId.trim(),
      targetType: pair.targetType,
      targetId: pair.targetId.trim(),
      allocatedAmount: 0,
      allocatedCents: 0,
      category: '',
      linkMode: 'Manual',
      linkedAt: '',
      notes: '',
    };

  const plan = planUnlinkReconLink(
    matchingLink,
    effectiveLinks,
    bankEntries,
    expenseWorkspace.records
  );

  let deletedLinksCount = 0;
  if (plan.rowNumbersToDelete.length > 0) {
    deletedLinksCount = await deleteReconLinksByRowNumbers(
      accessToken,
      plan.rowNumbersToDelete,
      TARGET_SPREADSHEET_ID
    );
  }

  const bankLedgers: Record<AccountType, LoadedSheetLedger> = {
    Puja: pujaLedger,
    Regular: regularLedger,
  };

  let bankUpdatedCount = 0;
  const updatedTabs: AccountType[] = [];

  for (const tab of ['Puja', 'Regular'] as AccountType[]) {
    const updates = plan.bankUpdatesByTab[tab];
    const ledger = bankLedgers[tab];
    if (updates.length > 0 && ledger.tabExists) {
      const count = await batchUpdateBankReconciliation(
        accessToken,
        TARGET_SPREADSHEET_ID,
        tab,
        toColumnLayout(ledger),
        updates
      );
      bankUpdatedCount += count;
      updatedTabs.push(tab);
    }
  }

  let expenseUpdatedCount = 0;
  if (plan.expenseUpdates.length > 0) {
    expenseUpdatedCount = await batchUpdateExpenseReconIds(
      accessToken,
      expenseWorkspace.meta,
      plan.expenseUpdates
    );
  }

  const [freshPuja, freshRegular, freshExpenseWs, freshLinks] = await Promise.all([
    updatedTabs.includes('Puja')
      ? fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Puja')
      : Promise.resolve(pujaLedger),
    updatedTabs.includes('Regular')
      ? fetchSheetLedger(accessToken, TARGET_SPREADSHEET_ID, 'Regular')
      : Promise.resolve(regularLedger),
    expenseUpdatedCount > 0
      ? fetchExpenseWorkspace(accessToken, EXPENSE_SPREADSHEET_ID)
      : Promise.resolve(expenseWorkspace),
    fetchReconLinks(accessToken, TARGET_SPREADSHEET_ID).catch(() => loadedLinks),
  ]);

  return {
    appendedLinksCount: 0,
    deletedLinksCount,
    bankUpdatedCount,
    expenseUpdatedCount,
    updatedTabs,
    reconLinks: freshLinks?.links ?? plan.nextEffectiveLinks,
    bankLedgers: {
      Puja: freshPuja,
      Regular: freshRegular,
    },
    expenseWorkspace: freshExpenseWs,
  };
}

/**
 * Syncs an Expense's updated Category into any matching explicit Recon_Links rows
 * so linked Bank_Ledger rows update between a single Category and "Multiple".
 */
export async function syncExpenseCategoryToReconLinks(
  accessToken: string,
  expId: string,
  nextCategory: string
): Promise<number> {
  const loadedLinks = await fetchReconLinks(
    accessToken,
    TARGET_SPREADSHEET_ID
  ).catch(() => null);
  if (!loadedLinks || loadedLinks.links.length === 0) return 0;

  const targetNorm = expId.trim().toLowerCase();
  const trimmedCat = nextCategory.trim();

  const patches = loadedLinks.links
    .filter(
      (l) =>
        l.targetType === 'Expense' &&
        l.targetId.trim().toLowerCase() === targetNorm &&
        l.sheetRowNumber !== null &&
        l.category.trim() !== trimmedCat
    )
    .map((l) => ({
      sheetRowNumber: l.sheetRowNumber!,
      category: trimmedCat,
    }));

  if (patches.length === 0) return 0;
  return updateReconLinkRows(accessToken, patches, TARGET_SPREADSHEET_ID);
}
