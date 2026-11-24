import assert from 'node:assert/strict';
import test from 'node:test';
import { ExpenseRecord } from '../src/types/expense';
import { NewReconLinkInput, ReconLink } from '../src/types/reconciliation';
import { AccountType, NormalizedTransaction } from '../src/types/statement';
import {
  bankEntryKey,
  buildEffectiveReconLinks,
  computeBankAllocationMap,
  computeDerivedLedgerSyncPatches,
  computeExpenseAllocationMap,
  expenseRecordKey,
  fromCents,
  generateLinkId,
  MULTIPLE_CATEGORY_LABEL,
  parseExactAmountQueryCents,
  toCents,
  validateNewReconLinks,
} from '../src/utils/reconAllocations';
import {
  BankLedgerEntry,
  findExpenseMatches,
  findLinkedSyncUpdates,
} from '../src/utils/reconciler';
import {
  buildFifoAllocationProposals,
  computeBothAllocationMaps,
  planCommitReconLinks,
  planUnlinkReconLink,
} from '../src/utils/reconMutations';

function makeBankEntry(
  overrides: Partial<NormalizedTransaction> & { tab?: AccountType } = {}
): BankLedgerEntry {
  const tab: AccountType = overrides.tab ?? 'Regular';
  const amount = overrides.amount ?? -100;
  const tx: NormalizedTransaction = {
    rowKey: overrides.rowKey ?? `row-${overrides.uniqueId ?? 'BANK1'}`,
    flagKey: overrides.flagKey ?? `flag-${overrides.uniqueId ?? 'BANK1'}`,
    uniqueId: overrides.uniqueId ?? 'BANK1',
    date: overrides.date ?? '2026-10-10',
    amount,
    amountCents: overrides.amountCents ?? toCents(amount),
    transactionType: overrides.transactionType ?? 'Expense',
    description: overrides.description ?? 'CHECK PAYMENT',
    referenceNumber: overrides.referenceNumber ?? '',
    source: overrides.source ?? 'Check',
    sourceFile: overrides.sourceFile ?? 'Sheet',
    occurrenceIndex: overrides.occurrenceIndex ?? 1,
    reviewStatus: overrides.reviewStatus ?? 'ok',
    syncStatus: overrides.syncStatus ?? 'already-in-sheet',
    targetId: overrides.targetId ?? '',
    isRecon: overrides.isRecon ?? 'No',
    category: overrides.category ?? '',
    notes: overrides.notes ?? '',
    sheetRowNumber:
      overrides.sheetRowNumber === undefined ? 2 : overrides.sheetRowNumber,
  };
  return { tab, tx };
}

function makeExpense(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    sheetRowNumber:
      overrides.sheetRowNumber === undefined ? 2 : overrides.sheetRowNumber,
    expId: overrides.expId ?? 'EXP1',
    date: overrides.date ?? '2026-10-10',
    amount: overrides.amount ?? 100,
    category: overrides.category ?? 'Puja Supplies',
    subCategory: overrides.subCategory ?? '',
    description: overrides.description ?? 'Temple Supplies',
    status: overrides.status ?? 'Paid',
    puja: overrides.puja ?? 'Regular',
    paymentMode: overrides.paymentMode ?? 'Check',
    reconSource: overrides.reconSource ?? '',
    reconSourceId: overrides.reconSourceId ?? '',
    isRecon: overrides.isRecon ?? 'No',
    sourceOrigin: overrides.sourceOrigin ?? 'sheet',
  };
}

function makeSheetLink(
  input: NewReconLinkInput & { sheetRowNumber?: number }
): ReconLink {
  const allocCents = toCents(input.allocatedAmount);
  return {
    linkId:
      input.linkId ??
      generateLinkId(input.bankUniqueId, input.targetType, input.targetId),
    sheetRowNumber: input.sheetRowNumber ?? 2,
    bankTab: input.bankTab,
    bankUniqueId: input.bankUniqueId,
    targetType: input.targetType,
    targetId: input.targetId,
    allocatedAmount: fromCents(allocCents),
    allocatedCents: allocCents,
    category: input.category,
    linkMode: input.linkMode ?? 'Manual',
    linkedAt: input.linkedAt ?? '2026-11-23T12:00:00Z',
    notes: input.notes ?? '',
  };
}

test('Legacy 1:1 regression: unlinked exact match and backfill work identically with empty Recon_Links', () => {
  const bank1 = makeBankEntry({
    uniqueId: 'B-100',
    amount: -150,
    date: '2026-10-05',
    description: 'AMAZON MARKETPLACE',
    source: 'CARD9130',
    sheetRowNumber: 5,
  });
  const exp1 = makeExpense({
    expId: 'EXP-100',
    amount: 150,
    date: '2026-10-05',
    category: 'Kitchen',
    description: 'Amazon Kitchen Bowls',
    paymentMode: 'Credit Card',
    sheetRowNumber: 8,
  });

  // Already linked 1:1 on Bank side only -> should backfill Expense side + Is_Recon + Category
  const bank2 = makeBankEntry({
    uniqueId: 'B-200',
    amount: -220,
    date: '2026-10-06',
    targetId: 'EXP-200',
    isRecon: 'No',
    category: '',
    sheetRowNumber: 6,
  });
  const exp2 = makeExpense({
    expId: 'EXP-200',
    amount: 220,
    date: '2026-10-06',
    category: 'Utilities',
    reconSourceId: '',
    isRecon: 'No',
    sheetRowNumber: 9,
  });

  // Fully synced 1:1 pair
  const bank3 = makeBankEntry({
    uniqueId: 'B-300',
    amount: -75,
    date: '2026-10-07',
    targetId: 'EXP-300',
    isRecon: 'Yes',
    category: 'Maintenance',
    sheetRowNumber: 7,
  });
  const exp3 = makeExpense({
    expId: 'EXP-300',
    amount: 75,
    date: '2026-10-07',
    category: 'Maintenance',
    reconSourceId: 'B-300',
    isRecon: 'Yes',
    sheetRowNumber: 10,
  });

  const analysis = findExpenseMatches(
    [bank1, bank2, bank3],
    [exp1, exp2, exp3],
    0,
    []
  );

  assert.equal(analysis.alreadyReconciledCount, 1);
  assert.equal(analysis.matches.length, 2);

  const match1 = analysis.matches.find((m) => m.bankTx.uniqueId === 'B-100');
  assert.ok(match1);
  assert.equal(match1.expense.expId, 'EXP-100');
  assert.equal(match1.resultingBankTargetId, 'EXP-100');
  assert.equal(match1.resultingBankIsRecon, 'Yes');
  assert.equal(match1.resultingBankCategory, 'Kitchen');
  assert.equal(match1.resultingExpenseReconId, 'B-100');
  assert.equal(match1.resultingExpenseIsRecon, 'Yes');

  const syncPlan = findLinkedSyncUpdates([bank2, bank3], [exp2, exp3], []);
  assert.equal(syncPlan.linkedPairCount, 2);
  assert.equal(syncPlan.bankUpdatesByTab.Regular.length, 1);
  assert.deepEqual(syncPlan.bankUpdatesByTab.Regular[0], {
    sheetRowNumber: 6,
    isRecon: 'Yes',
    category: 'Utilities',
  });
  assert.equal(syncPlan.expenseUpdates.length, 1);
  assert.deepEqual(syncPlan.expenseUpdates[0], {
    sheetRowNumber: 9,
    reconSourceId: 'B-200',
    isRecon: 'Yes',
  });
});

test('Example 1 (1:N): Bank 243A274AFA37A854 ($408.50) linked to Expenses 1794090597 ($317.50) and 1794090831 ($91.00)', () => {
  const bank = makeBankEntry({
    tab: 'Regular',
    uniqueId: '243A274AFA37A854',
    amount: -408.5,
    date: '2026-10-12',
    description: 'POS PURCHASE COSTCO',
    source: 'CARD9130',
    sheetRowNumber: 12,
  });
  const expA = makeExpense({
    expId: '1794090597',
    amount: 317.5,
    date: '2026-10-12',
    category: 'Puja Supplies',
    sheetRowNumber: 20,
  });
  const expB = makeExpense({
    expId: '1794090831',
    amount: 91.0,
    date: '2026-10-12',
    category: 'Kitchen',
    sheetRowNumber: 21,
  });

  // 1) Before any links exist, Pass 2 subset-sum auto-matching is NOT run
  const preAnalysis = findExpenseMatches([bank], [expA, expB], 0, []);
  assert.equal(preAnalysis.matches.length, 0);
  assert.equal(preAnalysis.unmatchedBankAmount, 408.5);
  assert.equal(preAnalysis.unmatchedExpenseAmount, 408.5);

  // 2) Partial intermediate state: only 1794090597 ($317.50) linked so far
  const partialLinks = [
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: '243A274AFA37A854',
      targetType: 'Expense',
      targetId: '1794090597',
      allocatedAmount: 317.5,
      category: 'Puja Supplies',
      sheetRowNumber: 2,
    }),
  ];

  const partialBankAlloc = computeBankAllocationMap([bank], partialLinks).get(
    bankEntryKey(bank)
  );
  assert.ok(partialBankAlloc);
  assert.equal(partialBankAlloc.status, 'partial');
  assert.equal(partialBankAlloc.allocatedAmount, 317.5);
  assert.equal(partialBankAlloc.remainingAmount, 91.0);
  assert.equal(partialBankAlloc.derivedIsRecon, 'No');
  assert.equal(partialBankAlloc.derivedCategory, 'Puja Supplies');

  // Even when Bank has partial link ($91 remaining), Pass 1 auto-matches remaining $91 to 1794090831!
  const midAnalysis = findExpenseMatches([bank], [expA, expB], 0, partialLinks);
  const remainingMatch = midAnalysis.matches.find(
    (m) => m.expense.expId === '1794090831'
  );
  assert.ok(remainingMatch);
  assert.equal(remainingMatch.matchedAmount, 91.0);
  assert.equal(remainingMatch.resultingBankTargetId, '1794090597, 1794090831');
  assert.equal(remainingMatch.resultingBankIsRecon, 'Yes');
  assert.equal(remainingMatch.resultingBankCategory, MULTIPLE_CATEGORY_LABEL);

  // 3) Full 1:N state with both links in Recon_Links (mixed categories -> "Multiple")
  const fullLinks = [
    ...partialLinks,
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: '243A274AFA37A854',
      targetType: 'Expense',
      targetId: '1794090831',
      allocatedAmount: 91.0,
      category: 'Kitchen',
      sheetRowNumber: 3,
    }),
  ];

  const fullBankAlloc = computeBankAllocationMap([bank], fullLinks).get(
    bankEntryKey(bank)
  );
  assert.ok(fullBankAlloc);
  assert.equal(fullBankAlloc.status, 'full');
  assert.equal(fullBankAlloc.remainingAmount, 0);
  assert.equal(fullBankAlloc.derivedIsRecon, 'Yes');
  assert.equal(fullBankAlloc.derivedCategory, MULTIPLE_CATEGORY_LABEL);
  assert.equal(fullBankAlloc.matchCardinality, '1:N');

  const syncPatches = computeDerivedLedgerSyncPatches(
    fullLinks,
    [bank],
    [expA, expB]
  );
  assert.deepEqual(syncPatches.bankUpdatesByTab.Regular, [
    {
      sheetRowNumber: 12,
      targetId: '1794090597, 1794090831',
      isRecon: 'Yes',
      category: 'Multiple',
    },
  ]);
  assert.deepEqual(syncPatches.expenseUpdates, [
    { sheetRowNumber: 20, reconSourceId: '243A274AFA37A854', isRecon: 'Yes' },
    { sheetRowNumber: 21, reconSourceId: '243A274AFA37A854', isRecon: 'Yes' },
  ]);

  // 4) Same-category 1:N should keep single category instead of "Multiple"
  const sameCatLinks = [
    partialLinks[0],
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: '243A274AFA37A854',
      targetType: 'Expense',
      targetId: '1794090831',
      allocatedAmount: 91.0,
      category: 'Puja Supplies',
      sheetRowNumber: 3,
    }),
  ];
  const sameCatAlloc = computeBankAllocationMap([bank], sameCatLinks).get(
    bankEntryKey(bank)
  );
  assert.equal(sameCatAlloc?.derivedCategory, 'Puja Supplies');

  // 5) Unlinking 1794090831 from a synced "Multiple" bank row reverts Category back to single & Is_Recon to "No"
  const syncedBank = makeBankEntry({
    ...bank.tx,
    tab: 'Regular',
    targetId: '1794090597, 1794090831',
    isRecon: 'Yes',
    category: 'Multiple',
    sheetRowNumber: 12,
  });
  const syncedExpA = makeExpense({
    ...expA,
    reconSourceId: '243A274AFA37A854',
    isRecon: 'Yes',
  });
  const syncedExpB = makeExpense({
    ...expB,
    reconSourceId: '243A274AFA37A854',
    isRecon: 'Yes',
  });
  const revertPatches = computeDerivedLedgerSyncPatches(
    partialLinks,
    [syncedBank],
    [syncedExpA, syncedExpB],
    {
      touchedBankIds: new Set(['243a274afa37a854']),
      touchedExpenseIds: new Set(['1794090831']),
    }
  );
  assert.deepEqual(revertPatches.bankUpdatesByTab.Regular, [
    {
      sheetRowNumber: 12,
      targetId: '1794090597',
      isRecon: 'No',
      category: 'Puja Supplies',
    },
  ]);
  assert.deepEqual(revertPatches.expenseUpdates, [
    { sheetRowNumber: 21, reconSourceId: '', isRecon: 'No' },
  ]);

  // Removing all links clears Target_ID, sets Is_Recon = No, and clears "Multiple"
  const clearAllPatches = computeDerivedLedgerSyncPatches(
    [],
    [syncedBank],
    [syncedExpA, syncedExpB],
    {
      touchedBankIds: new Set(['243a274afa37a854']),
      touchedExpenseIds: new Set(['1794090597', '1794090831']),
    }
  );
  assert.deepEqual(clearAllPatches.bankUpdatesByTab.Regular, [
    {
      sheetRowNumber: 12,
      targetId: '',
      isRecon: 'No',
      category: '',
    },
  ]);
});

test('Example 2 (N:1): Expense 1794280766 ($1,050.00) paid via 3 Bank Checks ($350 each, cross-tab)', () => {
  const expense = makeExpense({
    expId: '1794280766',
    amount: 1050,
    date: '2026-10-01',
    category: 'Facilities',
    description: 'Annual Hall Maintenance',
    sheetRowNumber: 30,
  });

  const chk1 = makeBankEntry({
    tab: 'Regular',
    uniqueId: 'A8A3DB888E6FCCA4',
    amount: -350,
    date: '2026-10-05',
    referenceNumber: '1001',
    sheetRowNumber: 101,
  });
  const chk2 = makeBankEntry({
    tab: 'Puja',
    uniqueId: '3A4D718D7308CD87',
    amount: -350,
    date: '2026-10-15',
    referenceNumber: '1002',
    sheetRowNumber: 45,
  });
  const chk3 = makeBankEntry({
    tab: 'Regular',
    uniqueId: '5D06E77803FA7083',
    amount: -350,
    date: '2026-11-01',
    referenceNumber: '1003',
    sheetRowNumber: 120,
  });

  // 1) Link Check 1 and Check 2 ($700 / $1,050 linked -> $350 remaining)
  const twoCheckLinks = [
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'A8A3DB888E6FCCA4',
      targetType: 'Expense',
      targetId: '1794280766',
      allocatedAmount: 350,
      category: 'Facilities',
      sheetRowNumber: 10,
    }),
    makeSheetLink({
      bankTab: 'Puja',
      bankUniqueId: '3A4D718D7308CD87',
      targetType: 'Expense',
      targetId: '1794280766',
      allocatedAmount: 350,
      category: 'Facilities',
      sheetRowNumber: 11,
    }),
  ];

  const partialExpAlloc = computeExpenseAllocationMap(
    [expense],
    twoCheckLinks
  ).get(expenseRecordKey(expense));
  assert.ok(partialExpAlloc);
  assert.equal(partialExpAlloc.status, 'partial');
  assert.equal(partialExpAlloc.allocatedAmount, 700);
  assert.equal(partialExpAlloc.remainingAmount, 350);
  assert.equal(partialExpAlloc.derivedIsRecon, 'No');
  assert.equal(partialExpAlloc.matchCardinality, 'N:1');

  // Verify unmatchedExpenseAmount counts only the $350 remaining (not $1,050)
  const twoCheckAnalysis = findExpenseMatches(
    [chk1, chk2, chk3],
    [expense],
    null, // All dates
    twoCheckLinks
  );
  // Pass 1 auto-matches Check 3 ($350) with the $350 remaining on 1794280766!
  const chk3Match = twoCheckAnalysis.matches.find(
    (m) => m.bankTx.uniqueId === '5D06E77803FA7083'
  );
  assert.ok(chk3Match);
  assert.equal(chk3Match.matchedAmount, 350);
  assert.equal(
    chk3Match.resultingExpenseReconId,
    'A8A3DB888E6FCCA4, 3A4D718D7308CD87, 5D06E77803FA7083'
  );
  assert.equal(chk3Match.resultingExpenseIsRecon, 'Yes');

  // Without Check 3 present, unmatched expense balance is exactly $350 (remaining)
  const partialOnlyAnalysis = findExpenseMatches(
    [chk1, chk2],
    [expense],
    0,
    twoCheckLinks
  );
  assert.equal(partialOnlyAnalysis.unmatchedExpenseCount, 1);
  assert.equal(partialOnlyAnalysis.unmatchedExpenseAmount, 350);

  // 2) Full 3-check N:1 state
  const threeCheckLinks = [
    ...twoCheckLinks,
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: '5D06E77803FA7083',
      targetType: 'Expense',
      targetId: '1794280766',
      allocatedAmount: 350,
      category: 'Facilities',
      sheetRowNumber: 12,
    }),
  ];

  const syncPatches = computeDerivedLedgerSyncPatches(
    threeCheckLinks,
    [chk1, chk2, chk3],
    [expense]
  );
  assert.equal(syncPatches.bankUpdatesByTab.Regular.length, 2);
  assert.equal(syncPatches.bankUpdatesByTab.Puja.length, 1);
  assert.deepEqual(syncPatches.expenseUpdates, [
    {
      sheetRowNumber: 30,
      reconSourceId: 'A8A3DB888E6FCCA4, 3A4D718D7308CD87, 5D06E77803FA7083',
      isRecon: 'Yes',
    },
  ]);

  const syncedAnalysis = findExpenseMatches(
    [
      makeBankEntry({
        ...chk1.tx,
        tab: 'Regular',
        targetId: '1794280766',
        isRecon: 'Yes',
        category: 'Facilities',
      }),
      makeBankEntry({
        ...chk2.tx,
        tab: 'Puja',
        targetId: '1794280766',
        isRecon: 'Yes',
        category: 'Facilities',
      }),
      makeBankEntry({
        ...chk3.tx,
        tab: 'Regular',
        targetId: '1794280766',
        isRecon: 'Yes',
        category: 'Facilities',
      }),
    ],
    [
      makeExpense({
        ...expense,
        reconSourceId: 'A8A3DB888E6FCCA4, 3A4D718D7308CD87, 5D06E77803FA7083',
        isRecon: 'Yes',
      }),
    ],
    0,
    threeCheckLinks
  );
  assert.equal(syncedAnalysis.matches.length, 0);
  assert.equal(syncedAnalysis.alreadyReconciledCount, 3);
  assert.equal(syncedAnalysis.unmatchedBankAmount, 0);
  assert.equal(syncedAnalysis.unmatchedExpenseAmount, 0);
});

test('Validation guards: blocks over-allocation, duplicates, non-positive amounts; allows penny tolerance', () => {
  const bank = makeBankEntry({ uniqueId: 'B1', amount: -100, sheetRowNumber: 2 });
  const exp = makeExpense({ expId: 'E1', amount: 100, sheetRowNumber: 2 });

  const existing = [
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'B1',
      targetType: 'Expense',
      targetId: 'E1',
      allocatedAmount: 60,
      category: 'Supplies',
    }),
  ];

  // Duplicate pair
  const dupRes = validateNewReconLinks(
    existing,
    [
      {
        bankTab: 'Regular',
        bankUniqueId: 'B1',
        targetType: 'Expense',
        targetId: 'E1',
        allocatedAmount: 10,
        category: 'Supplies',
      },
    ],
    [bank],
    [exp]
  );
  assert.equal(dupRes.valid, false);
  assert.match(dupRes.errors[0], /already exists/i);

  // Over-allocation on bank
  const exp2 = makeExpense({ expId: 'E2', amount: 80, sheetRowNumber: 3 });
  const overRes = validateNewReconLinks(
    existing,
    [
      {
        bankTab: 'Regular',
        bankUniqueId: 'B1',
        targetType: 'Expense',
        targetId: 'E2',
        allocatedAmount: 45,
        category: 'Supplies',
      },
    ],
    [bank],
    [exp, exp2]
  );
  assert.equal(overRes.valid, false);
  assert.match(overRes.errors[0], /over-allocated/i);

  // Zero / negative amount
  const zeroRes = validateNewReconLinks(
    [],
    [
      {
        bankTab: 'Regular',
        bankUniqueId: 'B1',
        targetType: 'Expense',
        targetId: 'E2',
        allocatedAmount: 0,
        category: 'Supplies',
      },
    ],
    [bank],
    [exp2]
  );
  assert.equal(zeroRes.valid, false);
  assert.match(zeroRes.errors[0], /positive/i);

  // Penny tolerance: $99.99 on $100.00 counts as 'full'
  const pennyLink = [
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'B1',
      targetType: 'Expense',
      targetId: 'E1',
      allocatedAmount: 99.99,
      category: 'Supplies',
    }),
  ];
  const pennyAlloc = computeBankAllocationMap([bank], pennyLink).get(
    bankEntryKey(bank)
  );
  assert.equal(pennyAlloc?.status, 'full');
  assert.equal(pennyAlloc?.derivedIsRecon, 'Yes');
});

test('M:N cardinality and Income Target_Type isolation', () => {
  const b1 = makeBankEntry({ uniqueId: 'B1', amount: -300, sheetRowNumber: 2 });
  const b2 = makeBankEntry({ uniqueId: 'B2', amount: -200, sheetRowNumber: 3 });
  const e1 = makeExpense({ expId: 'E1', amount: 400, sheetRowNumber: 2 });
  const e2 = makeExpense({ expId: 'E2', amount: 100, sheetRowNumber: 3 });

  const mnLinks: ReconLink[] = [
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'B1',
      targetType: 'Expense',
      targetId: 'E1',
      allocatedAmount: 300,
      category: 'Rent',
      sheetRowNumber: 2,
    }),
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'B2',
      targetType: 'Expense',
      targetId: 'E1',
      allocatedAmount: 100,
      category: 'Rent',
      sheetRowNumber: 3,
    }),
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'B2',
      targetType: 'Expense',
      targetId: 'E2',
      allocatedAmount: 100,
      category: 'Utilities',
      sheetRowNumber: 4,
    }),
    // Future Income_Ledger link should not interfere with Expense allocation
    makeSheetLink({
      bankTab: 'Regular',
      bankUniqueId: 'INC-BANK-1',
      targetType: 'Income',
      targetId: 'E1', // Same ID string as E1 to test Target_Type namespace isolation
      allocatedAmount: 500,
      category: 'Donations',
      sheetRowNumber: 5,
    }),
  ];

  const b2Alloc = computeBankAllocationMap([b1, b2], mnLinks).get(
    bankEntryKey(b2)
  );
  assert.equal(b2Alloc?.matchCardinality, 'M:N');
  assert.equal(b2Alloc?.derivedCategory, 'Multiple');
  assert.equal(b2Alloc?.derivedIsRecon, 'Yes');

  const e1Alloc = computeExpenseAllocationMap([e1, e2], mnLinks).get(
    expenseRecordKey(e1)
  );
  assert.equal(e1Alloc?.allocatedAmount, 400);
  assert.equal(e1Alloc?.remainingAmount, 0);
  assert.equal(e1Alloc?.matchCardinality, 'M:N');
  assert.deepEqual(e1Alloc?.partnerIds, ['B1', 'B2']);

  // Confirm buildEffectiveReconLinks ignores Income links when counting Expense partners
  const effective = buildEffectiveReconLinks(mnLinks, [b1, b2], [e1, e2]);
  assert.equal(effective.length, 4);
});

test('Phase 3 Workbench FIFO proposals & legacy virtual link materialization', () => {
  // 1) FIFO Multi-Link Proposal for Example 1 (1 Bank $408.50 -> 2 Expenses $317.50 + $91.00)
  const bank = makeBankEntry({
    tab: 'Regular',
    uniqueId: '243A274AFA37A854',
    amount: -408.5,
    date: '2026-10-12',
    sheetRowNumber: 12,
  });
  const expA = makeExpense({
    expId: '1794090597',
    amount: 317.5,
    date: '2026-10-12',
    category: 'Puja Supplies',
    sheetRowNumber: 20,
  });
  const expB = makeExpense({
    expId: '1794090831',
    amount: 91.0,
    date: '2026-10-12',
    category: 'Kitchen',
    sheetRowNumber: 21,
  });

  const { bankAllocMap, expAllocMap } = computeBothAllocationMaps(
    [bank],
    [expA, expB],
    []
  );
  const fifo1N = buildFifoAllocationProposals(
    [bank],
    [expA, expB],
    bankAllocMap,
    expAllocMap,
    []
  );
  assert.equal(fifo1N.length, 2);
  assert.equal(fifo1N[0].expense.expId, '1794090597');
  assert.equal(fifo1N[0].allocatedAmount, 317.5);
  assert.equal(fifo1N[1].expense.expId, '1794090831');
  assert.equal(fifo1N[1].allocatedAmount, 91.0);

  // 2) FIFO M:N Proposal (2 Bank tx: $600 + $400 across Puja/Regular; 2 Expenses: $700 + $300)
  const b1 = makeBankEntry({ tab: 'Puja', uniqueId: 'B1', amount: -600, date: '2026-10-01', sheetRowNumber: 2 });
  const b2 = makeBankEntry({ tab: 'Regular', uniqueId: 'B2', amount: -400, date: '2026-10-02', sheetRowNumber: 3 });
  const e1 = makeExpense({ expId: 'E1', amount: 700, date: '2026-10-01', category: 'Food', sheetRowNumber: 2 });
  const e2 = makeExpense({ expId: 'E2', amount: 300, date: '2026-10-02', category: 'Hall', sheetRowNumber: 3 });
  const mnMaps = computeBothAllocationMaps([b1, b2], [e1, e2], []);
  const fifoMN = buildFifoAllocationProposals([b1, b2], [e1, e2], mnMaps.bankAllocMap, mnMaps.expAllocMap, []);
  assert.equal(fifoMN.length, 3);
  assert.deepEqual(
    fifoMN.map((p) => [p.bankEntry.tx.uniqueId, p.expense.expId, p.allocatedAmount]),
    [
      ['B1', 'E1', 600],
      ['B2', 'E1', 100],
      ['B2', 'E2', 300],
    ]
  );

  // 3) Legacy virtual link materialization: Bank already has legacy targetId='1794090597' ($317.50) with no Recon_Links rows
  const legacyBank = makeBankEntry({
    ...bank.tx,
    targetId: '1794090597',
    isRecon: 'No',
    category: 'Puja Supplies',
    sheetRowNumber: 12,
  });
  const legacyExpA = makeExpense({
    ...expA,
    reconSourceId: '243A274AFA37A854',
    isRecon: 'Yes',
  });
  const effectiveLegacy = buildEffectiveReconLinks([], [legacyBank], [legacyExpA, expB]);
  assert.equal(effectiveLegacy.length, 1);
  assert.equal(effectiveLegacy[0].sheetRowNumber, null);

  const commitPlan = planCommitReconLinks(
    [
      {
        bankTab: 'Regular',
        bankUniqueId: '243A274AFA37A854',
        targetType: 'Expense',
        targetId: '1794090831',
        allocatedAmount: 91.0,
        category: 'Kitchen',
        linkMode: 'Manual',
      },
    ],
    effectiveLegacy,
    [legacyBank],
    [legacyExpA, expB]
  );
  assert.equal(commitPlan.valid, true);
  // Should materialize the legacy link AND append the new link (2 rows total)
  assert.equal(commitPlan.linksToAppend.length, 2);
  assert.deepEqual(commitPlan.bankUpdatesByTab.Regular, [
    {
      sheetRowNumber: 12,
      targetId: '1794090597, 1794090831',
      isRecon: 'Yes',
      category: 'Multiple',
    },
  ]);

  // 4) Unlinking a legacy virtual link (sheetRowNumber === null) clears both sides without needing row deletion
  const unlinkLegacyPlan = planUnlinkReconLink(
    effectiveLegacy[0],
    effectiveLegacy,
    [legacyBank],
    [legacyExpA]
  );
  assert.deepEqual(unlinkLegacyPlan.rowNumbersToDelete, []);
  assert.deepEqual(unlinkLegacyPlan.bankUpdatesByTab.Regular, [
    {
      sheetRowNumber: 12,
      targetId: '',
    },
  ]);
  assert.deepEqual(unlinkLegacyPlan.expenseUpdates, [
    {
      sheetRowNumber: 20,
      reconSourceId: '',
      isRecon: 'No',
    },
  ]);
});

test('Phase 3 step-by-step N:1 commits and partial unlink on Example 2', () => {
  const expense = makeExpense({
    expId: '1794280766',
    amount: 1050,
    date: '2026-10-01',
    category: 'Facilities',
    sheetRowNumber: 30,
  });
  const chk1 = makeBankEntry({ tab: 'Regular', uniqueId: 'A8A3DB888E6FCCA4', amount: -350, sheetRowNumber: 101 });
  const chk2 = makeBankEntry({ tab: 'Puja', uniqueId: '3A4D718D7308CD87', amount: -350, sheetRowNumber: 45 });
  const chk3 = makeBankEntry({ tab: 'Regular', uniqueId: '5D06E77803FA7083', amount: -350, sheetRowNumber: 120 });

  const link1 = makeSheetLink({
    bankTab: 'Regular',
    bankUniqueId: 'A8A3DB888E6FCCA4',
    targetType: 'Expense',
    targetId: '1794280766',
    allocatedAmount: 350,
    category: 'Facilities',
    sheetRowNumber: 10,
  });
  const link2 = makeSheetLink({
    bankTab: 'Puja',
    bankUniqueId: '3A4D718D7308CD87',
    targetType: 'Expense',
    targetId: '1794280766',
    allocatedAmount: 350,
    category: 'Facilities',
    sheetRowNumber: 11,
  });
  const link3 = makeSheetLink({
    bankTab: 'Regular',
    bankUniqueId: '5D06E77803FA7083',
    targetType: 'Expense',
    targetId: '1794280766',
    allocatedAmount: 350,
    category: 'Facilities',
    sheetRowNumber: 12,
  });

  // Committing link 3 onto [link1, link2] sets Expense Is_Recon = Yes
  const step3Plan = planCommitReconLinks(
    [
      {
        bankTab: 'Regular',
        bankUniqueId: '5D06E77803FA7083',
        targetType: 'Expense',
        targetId: '1794280766',
        allocatedAmount: 350,
        category: 'Facilities',
        linkMode: 'Manual',
      },
    ],
    [link1, link2],
    [chk1, chk2, chk3],
    [
      makeExpense({
        ...expense,
        reconSourceId: 'A8A3DB888E6FCCA4, 3A4D718D7308CD87',
        isRecon: 'No',
      }),
    ]
  );
  assert.equal(step3Plan.valid, true);
  assert.deepEqual(step3Plan.expenseUpdates, [
    {
      sheetRowNumber: 30,
      reconSourceId: 'A8A3DB888E6FCCA4, 3A4D718D7308CD87, 5D06E77803FA7083',
      isRecon: 'Yes',
    },
  ]);

  // Now unlink Check 2 (Puja sheetRowNumber 11 in Recon_Links) -> reverts Expense Is_Recon back to No
  const syncedExpense = makeExpense({
    ...expense,
    reconSourceId: 'A8A3DB888E6FCCA4, 3A4D718D7308CD87, 5D06E77803FA7083',
    isRecon: 'Yes',
  });
  const syncedChk2 = makeBankEntry({
    ...chk2.tx,
    tab: 'Puja',
    targetId: '1794280766',
    isRecon: 'Yes',
    category: 'Facilities',
  });
  const unlinkPlan = planUnlinkReconLink(
    link2,
    [link1, link2, link3],
    [chk1, syncedChk2, chk3],
    [syncedExpense]
  );
  assert.deepEqual(unlinkPlan.rowNumbersToDelete, [11]);
  assert.deepEqual(unlinkPlan.bankUpdatesByTab.Puja, [
    { sheetRowNumber: 45, targetId: '', isRecon: 'No' },
  ]);
  assert.deepEqual(unlinkPlan.expenseUpdates, [
    {
      sheetRowNumber: 30,
      reconSourceId: 'A8A3DB888E6FCCA4, 5D06E77803FA7083',
      isRecon: 'No',
    },
  ]);
});

test('parseExactAmountQueryCents parses exact dollar search inputs cleanly', () => {
  assert.equal(parseExactAmountQueryCents('352'), 35200);
  assert.equal(parseExactAmountQueryCents('352.00'), 35200);
  assert.equal(parseExactAmountQueryCents('$352.00'), 35200);
  assert.equal(parseExactAmountQueryCents('1,851.43'), 185143);
  assert.equal(parseExactAmountQueryCents('$1,851.43'), 185143);
  assert.equal(parseExactAmountQueryCents('1851.43'), 185143);
  assert.equal(parseExactAmountQueryCents('-$516.42'), 51642);
  assert.equal(parseExactAmountQueryCents('.50'), 50);
  assert.equal(parseExactAmountQueryCents('$.50'), 50);
  assert.equal(parseExactAmountQueryCents(''), null);
  assert.equal(parseExactAmountQueryCents('2026-11-09'), null);
  assert.equal(parseExactAmountQueryCents('Food'), null);
  assert.equal(parseExactAmountQueryCents('Chicken = $240'), null);
});

