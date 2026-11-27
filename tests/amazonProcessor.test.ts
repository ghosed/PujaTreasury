import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAmazonDuplicateKey,
  buildAmazonUniqueId,
  isValid12DigitAmazonUniqueId,
  normalizeAmazonPaymentMethod,
  normalizeAmazonStatus,
  parseOptionalAmazonNumber,
  processScannedAmazonFiles,
} from '../src/utils/amazonProcessor.ts';
import {
  buildAmazonCategorizationHistory,
  runDeterministicAmazonCategorizer,
} from '../src/utils/amazonCategorizer.ts';
import {
  type BankStatementLookupInput,
  matchAmazonOrdersWithBank,
  matchAmazonOrdersWithExpenses,
} from '../src/utils/amazonExpenseRecon.ts';
import type { AmazonOrderRecord, UploadedAmazonFile } from '../src/types/amazon.ts';
import type { ExpenseRecord } from '../src/types/expense.ts';

test('buildAmazonUniqueId generates deterministic 12-digit numeric hash IDs', () => {
  const id1 = buildAmazonUniqueId({
    orderNumber: '111-0177387-1485024',
    orderDate: '2026-10-04',
    quantity: 1,
    itemDescription: 'Snacks Neon Sign, LED Snacks Light Sign for Kitchen Pantry Decor',
    itemPrice: 29.99,
  });
  const id2 = buildAmazonUniqueId({
    orderNumber: ' 111-0177387-1485024 ',
    orderDate: '10/04/2026',
    quantity: 1,
    itemDescription: 'snacks neon sign, led snacks light sign for kitchen pantry decor',
    itemPrice: 29.99,
  });

  assert.equal(isValid12DigitAmazonUniqueId(id1), true);
  assert.match(id1, /^\d{12}$/);
  assert.equal(id1, id2);
});

test('processScannedAmazonFiles allows individually shipped identical items and different files while skipping exact same file names', () => {
  const args = {
    orderNumber: '111-0177387-1485024',
    orderDate: '2026-10-04',
    quantity: 1,
    itemDescription: 'Snacks Neon Sign, LED Snacks Light Sign for Kitchen Pantry Decor',
    itemPrice: 29.99,
  };
  const existingId = buildAmazonUniqueId(args);
  const existingDupKey = buildAmazonDuplicateKey(args);

  const files: UploadedAmazonFile[] = [
    // Exact same file name as one already recorded in sheet -> all items skipped as duplicate
    {
      id: 'f-existing',
      fileName: 'already-recorded.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      status: 'ready',
      extractedItems: [
        {
          orderNumber: '111-0177387-1485024',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Snacks Neon Sign, LED Snacks Light Sign for Kitchen Pantry Decor',
          itemPrice: 29.99,
          total: 29.99,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Ordered',
        },
      ],
    },
    // New file with differently-named upload containing identical individually-shipped items + Returned item -> all allowed
    {
      id: 'f1',
      fileName: 'summary.jpeg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      status: 'ready',
      extractedItems: [
        {
          orderNumber: '111-0177387-1485024',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Snacks Neon Sign, LED Snacks Light Sign for Kitchen Pantry Decor',
          itemPrice: 29.99,
          total: 29.99,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Ordered',
        },
        {
          orderNumber: '111-4489470-1300211',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Custom Neon Signs (PUJA SHOPPING MARKET)',
          itemPrice: null,
          total: 668.48,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Ordered',
        },
        // Individually shipped identical item inside same order detail file
        {
          orderNumber: '111-4489470-1300211',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Custom Neon Signs (REGISTRATION)',
          itemPrice: 45.0,
          total: 45.0,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Delivered',
        },
        {
          orderNumber: '111-4489470-1300211',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Custom Neon Signs (REGISTRATION)',
          itemPrice: 45.0,
          total: 45.0,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Delivered',
        },
      ],
    },
    // Exact same file name uploaded again in the same queue -> skipped as duplicate
    {
      id: 'f2',
      fileName: 'summary.jpeg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      status: 'ready',
      extractedItems: [
        {
          orderNumber: '111-9999999-9999999',
          orderDate: '2026-10-05',
          quantity: 1,
          itemDescription: 'Another Item',
          itemPrice: 10.0,
          total: 10.0,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Delivered',
        },
      ],
    },
  ];

  const result = processScannedAmazonFiles(
    files,
    new Set([existingId]),
    new Set([existingDupKey]),
    {},
    new Set(['already-recorded.pdf'])
  );

  assert.equal(result.summary.totalExtracted, 6);
  assert.equal(result.summary.readyToSync, 4);
  assert.equal(result.summary.duplicateSkipped, 2);
  assert.equal(result.readyOrders[1].itemPrice, null);
  // Individually shipped identical items get distinct 12-digit IDs
  assert.notEqual(result.readyOrders[2].uniqueId, result.readyOrders[3].uniqueId);
  assert.equal(isValid12DigitAmazonUniqueId(result.readyOrders[0].uniqueId), true);
  assert.equal(isValid12DigitAmazonUniqueId(result.readyOrders[2].uniqueId), true);
  assert.equal(isValid12DigitAmazonUniqueId(result.readyOrders[3].uniqueId), true);
  assert.notEqual(result.readyOrders[0].uniqueId, existingId);
});

test('parseOptionalAmazonNumber converts negative or parenthesized Returned refund amounts into positive income values', () => {
  assert.equal(parseOptionalAmazonNumber('-$29.99', 2), 29.99);
  assert.equal(parseOptionalAmazonNumber('($45.50)', 2), 45.5);
  assert.equal(parseOptionalAmazonNumber(-19.95, 2), 19.95);
  assert.equal(parseOptionalAmazonNumber('$12.34', 2), 12.34);
});

test('normalizeAmazonStatus maps status strings cleanly and preserves blank', () => {
  assert.equal(normalizeAmazonStatus('Arriving today 2 PM – 6 PM'), 'Ordered');
  assert.equal(normalizeAmazonStatus('Delivered October 9'), 'Delivered');
  assert.equal(normalizeAmazonStatus('Cancelled'), 'Cancelled');
  assert.equal(normalizeAmazonStatus('Return complete'), 'Returned');
  assert.equal(normalizeAmazonStatus(''), '');
});

test('runDeterministicAmazonCategorizer classifies Item Description against LookUp expense categories', () => {
  const expenseCategories = ['Food', 'Decoration', 'Registration', 'Puja', 'Maintenance'];
  const historyRecords: AmazonOrderRecord[] = [
    {
      rowKey: 'h1',
      uniqueId: '123456789012',
      duplicateKey: 'k1',
      orderNumber: '111-0000000-0000001',
      orderDate: '2026-09-01',
      quantity: 2,
      itemDescription: 'Plastic Chafing Dish Buffet Set',
      itemPrice: 24.5,
      total: 49.0,
      shippedTo: 'HDBS',
      paymentMethod: 'credit/debit',
      status: 'Delivered',
      isRecon: 'Yes',
      category: 'Food',
      sourceOrigin: 'sheet',
    },
  ];
  const history = buildAmazonCategorizationHistory(historyRecords, expenseCategories);

  const regMatch = runDeterministicAmazonCategorizer(
    { id: '1', itemDescription: 'Custom Neon Signs (REGISTRATION)' },
    expenseCategories,
    history
  );
  assert.equal(regMatch?.category, 'Registration');

  const decorMatch = runDeterministicAmazonCategorizer(
    { id: '2', itemDescription: 'Custom Neon Signs (PUJA SHOPPING MARKET)' },
    expenseCategories,
    history
  );
  assert.equal(decorMatch?.category, 'Puja');

  const neonMatch = runDeterministicAmazonCategorizer(
    { id: '3', itemDescription: 'Custom Neon Signs (Kids Corner)' },
    expenseCategories,
    history
  );
  assert.equal(decorMatch ? neonMatch?.category : '', 'Decoration');

  const histMatch = runDeterministicAmazonCategorizer(
    { id: '4', itemDescription: 'Plastic Chafing Dish Buffet Set' },
    expenseCategories,
    history
  );
  assert.equal(histMatch?.category, 'Food');
  assert.equal(histMatch?.method, 'historical-description');
});

test('normalizeAmazonPaymentMethod shortens Wells Fargo Business Debit to Debit ... XXXX', () => {
  assert.equal(
    normalizeAmazonPaymentMethod('Wells Fargo Business Debit Card ending in 1234'),
    'Debit ... 1234'
  );
  assert.equal(
    normalizeAmazonPaymentMethod('Wells Fargo Business Debit •••• 5678'),
    'Debit ... 5678'
  );
  assert.equal(
    normalizeAmazonPaymentMethod('Wells Fargo Business Debit ****9012'),
    'Debit ... 9012'
  );
  assert.equal(normalizeAmazonPaymentMethod('Debit ... 1234'), 'Debit ... 1234');
  assert.equal(normalizeAmazonPaymentMethod('Wells Fargo Business Debit'), 'Debit');
  assert.equal(normalizeAmazonPaymentMethod('Amazon Gift Card'), 'Amazon Gift Card');
  assert.equal(normalizeAmazonPaymentMethod('credit/debit'), 'credit/debit');
  assert.equal(normalizeAmazonPaymentMethod(''), '');
});

function makeAmazonSheetRow(
  overrides: Partial<AmazonOrderRecord> & {
    sheetRowNumber: number;
    uniqueId: string;
    orderNumber: string;
  }
): AmazonOrderRecord {
  return {
    rowKey: `sheet-${overrides.sheetRowNumber}`,
    duplicateKey: `dup-${overrides.sheetRowNumber}`,
    orderDate: '2026-10-04',
    quantity: 1,
    itemDescription: 'Test Amazon Item',
    itemPrice: null,
    total: null,
    shippedTo: 'Sandip Dasgupta',
    paymentMethod: 'Debit ... 1234',
    status: 'Delivered',
    isRecon: 'No',
    category: '',
    expId: '',
    bankId: '',
    sourceOrigin: 'sheet',
    ...overrides,
  };
}

function makeExpense(
  overrides: Partial<ExpenseRecord> & { expId: string; amount: number }
): ExpenseRecord {
  return {
    sheetRowNumber: 2,
    date: '2026-10-04',
    category: 'Supplies',
    subCategory: '',
    description: 'Order purchase',
    status: 'Approved',
    puja: 'Regular',
    paymentMode: 'Debit Card',
    reconSource: '',
    reconSourceId: '',
    isRecon: 'No',
    notes: '',
    sourceOrigin: 'sheet',
    ...overrides,
  };
}

test('matchAmazonOrdersWithExpenses matches single-item and multi-item Amazon Order IDs against Amazon-noted expenses', () => {
  const amazonRecords: AmazonOrderRecord[] = [
    // Single-item order ($29.99)
    makeAmazonSheetRow({
      sheetRowNumber: 2,
      uniqueId: '100000000001',
      orderNumber: '111-0177387-1485024',
      orderDate: '2026-10-04',
      itemDescription: 'Snacks Neon Sign',
      total: 29.99,
    }),
    // Multi-item order Pattern A: order total on row 1, null on row 2 ($668.48 total)
    makeAmazonSheetRow({
      sheetRowNumber: 3,
      uniqueId: '100000000002',
      orderNumber: '111-4489470-1300211',
      orderDate: '2026-10-04',
      itemDescription: 'Custom Neon Sign (PUJA)',
      total: 668.48,
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 4,
      uniqueId: '100000000003',
      orderNumber: '111-4489470-1300211',
      orderDate: '2026-10-04',
      itemDescription: 'Custom Neon Sign (REG)',
      total: null,
    }),
    // Multi-item order Pattern B: itemized line totals summing to $45.50
    makeAmazonSheetRow({
      sheetRowNumber: 5,
      uniqueId: '100000000004',
      orderNumber: '112-1111111-2222222',
      orderDate: '2026-10-06',
      itemDescription: 'Plates',
      total: 20.0,
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 6,
      uniqueId: '100000000005',
      orderNumber: '112-1111111-2222222',
      orderDate: '2026-10-06',
      itemDescription: 'Cups',
      total: 25.5,
    }),
    // Multi-item order Pattern C: itemPrice * quantity with total=null summing to $36.00
    makeAmazonSheetRow({
      sheetRowNumber: 7,
      uniqueId: '100000000006',
      orderNumber: '113-3333333-4444444',
      orderDate: '2026-10-08',
      quantity: 2,
      itemDescription: 'Batteries',
      itemPrice: 12.0,
      total: null,
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 8,
      uniqueId: '100000000007',
      orderNumber: '113-3333333-4444444',
      orderDate: '2026-10-08',
      quantity: 1,
      itemDescription: 'Tape',
      itemPrice: 12.0,
      total: null,
    }),
    // Unmatched order ($99.00) whose only matching amount expense is NOT Amazon in Notes
    makeAmazonSheetRow({
      sheetRowNumber: 9,
      uniqueId: '100000000008',
      orderNumber: '114-5555555-6666666',
      orderDate: '2026-10-09',
      itemDescription: 'Folding Table',
      total: 99.0,
    }),
  ];

  const expenseRecords: ExpenseRecord[] = [
    makeExpense({
      expId: 'EXP-AMZ-1',
      amount: 29.99,
      date: '2026-10-05',
      notes: 'Amazon',
      description: 'Kitchen decor from Amazon',
    }),
    makeExpense({
      expId: 'EXP-AMZ-2',
      amount: 668.48,
      date: '2026-10-05',
      notes: 'Vendor: Amazon.com',
      description: 'Neon signs',
    }),
    makeExpense({
      expId: 'EXP-AMZ-3',
      amount: 45.5,
      date: '2026-10-07',
      notes: 'Amazon',
      description: 'Plates and cups',
    }),
    makeExpense({
      expId: 'EXP-AMZ-4',
      amount: 36.0,
      date: '2026-10-08',
      notes: 'amazon',
      description: 'Batteries and tape',
    }),
    // Same $99.00 amount, but Notes says Home Depot (NOT Amazon) -> must NOT match
    makeExpense({
      expId: 'EXP-HD-1',
      amount: 99.0,
      date: '2026-10-09',
      notes: 'Home Depot',
      description: 'Folding Table from Amazon lookalike',
    }),
  ];

  const plan = matchAmazonOrdersWithExpenses(amazonRecords, expenseRecords);

  assert.equal(plan.eligibleExpenseCount, 4);
  assert.equal(plan.matchedOrders.length, 4);
  assert.equal(plan.rowUpdates.length, 7);

  const byRow = new Map(plan.rowUpdates.map((u) => [u.sheetRowNumber, u.expId]));
  assert.equal(byRow.get(2), 'EXP-AMZ-1');
  assert.equal(byRow.get(3), 'EXP-AMZ-2');
  assert.equal(byRow.get(4), 'EXP-AMZ-2');
  assert.equal(byRow.get(5), 'EXP-AMZ-3');
  assert.equal(byRow.get(6), 'EXP-AMZ-3');
  assert.equal(byRow.get(7), 'EXP-AMZ-4');
  assert.equal(byRow.get(8), 'EXP-AMZ-4');
  assert.equal(byRow.get(9), undefined);
});

test('matchAmazonOrdersWithExpenses resolves same-amount orders by date proximity, preserves existing Exp_ID, and backfills partial multi-item orders', () => {
  const amazonRecords: AmazonOrderRecord[] = [
    // Two distinct $50.00 orders on different dates
    makeAmazonSheetRow({
      sheetRowNumber: 10,
      uniqueId: '200000000001',
      orderNumber: '111-1000000-0000001',
      orderDate: '2026-09-01',
      total: 50.0,
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 11,
      uniqueId: '200000000002',
      orderNumber: '111-1000000-0000002',
      orderDate: '2026-10-15',
      total: 50.0,
    }),
    // Already completely matched order -> should NOT overwrite or reuse EXP-LOCKED
    makeAmazonSheetRow({
      sheetRowNumber: 12,
      uniqueId: '200000000003',
      orderNumber: '111-1000000-0000003',
      orderDate: '2026-10-16',
      total: 75.0,
      expId: 'EXP-LOCKED',
    }),
    // Partially matched multi-item order: row 13 has EXP-PARTIAL, row 14 is blank -> backfill row 14
    makeAmazonSheetRow({
      sheetRowNumber: 13,
      uniqueId: '200000000004',
      orderNumber: '111-1000000-0000004',
      orderDate: '2026-10-18',
      total: 40.0,
      expId: 'EXP-PARTIAL',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 14,
      uniqueId: '200000000005',
      orderNumber: '111-1000000-0000004',
      orderDate: '2026-10-18',
      total: null,
      expId: '',
    }),
    // Cancelled order -> ignored
    makeAmazonSheetRow({
      sheetRowNumber: 15,
      uniqueId: '200000000006',
      orderNumber: '111-1000000-0000005',
      orderDate: '2026-10-20',
      total: 88.0,
      status: 'Cancelled',
    }),
  ];

  const expenseRecords: ExpenseRecord[] = [
    makeExpense({
      expId: 'EXP-SEP',
      amount: 50.0,
      date: '2026-09-02',
      notes: 'Amazon',
    }),
    makeExpense({
      expId: 'EXP-OCT',
      amount: 50.0,
      date: '2026-10-16',
      notes: 'Amazon',
    }),
    makeExpense({
      expId: 'EXP-LOCKED',
      amount: 75.0,
      date: '2026-10-16',
      notes: 'Amazon',
    }),
    makeExpense({
      expId: 'EXP-PARTIAL',
      amount: 40.0,
      date: '2026-10-18',
      notes: 'Amazon',
    }),
    makeExpense({
      expId: 'EXP-CANC',
      amount: 88.0,
      date: '2026-10-20',
      notes: 'Amazon',
    }),
  ];

  const plan = matchAmazonOrdersWithExpenses(amazonRecords, expenseRecords);
  const byRow = new Map(plan.rowUpdates.map((u) => [u.sheetRowNumber, u.expId]));

  assert.equal(byRow.get(10), 'EXP-SEP');
  assert.equal(byRow.get(11), 'EXP-OCT');
  assert.equal(byRow.get(12), undefined);
  assert.equal(byRow.get(13), undefined);
  assert.equal(byRow.get(14), 'EXP-PARTIAL');
  assert.equal(byRow.get(15), undefined);
  assert.equal(plan.alreadyMatchedOrderCount, 1);
});

function makeBankTx(
  overrides: Partial<BankStatementLookupInput> & {
    uniqueId: string;
    amount: number;
  }
): BankStatementLookupInput {
  const cents = Math.round(overrides.amount * 100);
  return {
    rowKey: `bank-${overrides.uniqueId}`,
    flagKey: `flag-${overrides.uniqueId}`,
    date: '2026-10-05',
    amountCents: cents,
    transactionType: 'Expense',
    description: 'AMAZON MKTPL*1234',
    referenceNumber: '',
    source: 'Card 1234',
    sourceFile: 'statement.csv',
    occurrenceIndex: 1,
    reviewStatus: 'ok',
    syncStatus: 'already-in-sheet',
    notes: '',
    accountTab: 'Regular',
    sheetRowNumber: 2,
    ...overrides,
  };
}

test('matchAmazonOrdersWithBank matches single and multi-item Amazon Order IDs against Amazon-noted Bank Statement expenses and sets Is_Recon=Yes', () => {
  const amazonRecords: AmazonOrderRecord[] = [
    makeAmazonSheetRow({
      sheetRowNumber: 2,
      uniqueId: '300000000001',
      orderNumber: '111-0177387-1485024',
      orderDate: '2026-10-04',
      total: 29.99,
      isRecon: 'No',
    }),
    // Multi-item order ($668.48) with total on row 3 and null on row 4
    makeAmazonSheetRow({
      sheetRowNumber: 3,
      uniqueId: '300000000002',
      orderNumber: '111-4489470-1300211',
      orderDate: '2026-10-04',
      total: 668.48,
      isRecon: 'No',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 4,
      uniqueId: '300000000003',
      orderNumber: '111-4489470-1300211',
      orderDate: '2026-10-04',
      total: null,
      isRecon: 'No',
    }),
    // Order matching an Income refund or non-Amazon note -> must NOT match
    makeAmazonSheetRow({
      sheetRowNumber: 5,
      uniqueId: '300000000004',
      orderNumber: '112-2222222-3333333',
      orderDate: '2026-10-06',
      total: 99.0,
      isRecon: 'No',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 6,
      uniqueId: '300000000005',
      orderNumber: '112-4444444-5555555',
      orderDate: '2026-10-07',
      total: 55.0,
      isRecon: 'No',
    }),
  ];

  const bankRecords: BankStatementLookupInput[] = [
    makeBankTx({
      uniqueId: 'BNK-AMZ-1',
      amount: -29.99,
      date: '2026-10-05',
      notes: 'Amazon',
      accountTab: 'Regular',
    }),
    makeBankTx({
      uniqueId: 'BNK-AMZ-2',
      amount: -668.48,
      date: '2026-10-06',
      notes: 'Amazon.com',
      accountTab: 'Puja',
    }),
    // Home Depot in Notes -> must NOT match row 5
    makeBankTx({
      uniqueId: 'BNK-HD-1',
      amount: -99.0,
      date: '2026-10-06',
      notes: 'Home Depot',
    }),
    // Income transaction with Amazon in Notes -> must NOT match expense order
    makeBankTx({
      uniqueId: 'BNK-REFUND-1',
      amount: 55.0,
      transactionType: 'Income',
      date: '2026-10-07',
      notes: 'Amazon',
    }),
  ];

  const plan = matchAmazonOrdersWithBank(amazonRecords, bankRecords);
  assert.equal(plan.eligibleBankCount, 2);
  assert.equal(plan.matchedOrders.length, 2);
  assert.equal(plan.rowUpdates.length, 3);

  const byRow = new Map(plan.rowUpdates.map((u) => [u.sheetRowNumber, u]));
  assert.equal(byRow.get(2)?.bankId, 'BNK-AMZ-1');
  assert.equal(byRow.get(2)?.isRecon, 'Yes');
  assert.equal(byRow.get(3)?.bankId, 'BNK-AMZ-2');
  assert.equal(byRow.get(3)?.isRecon, 'Yes');
  assert.equal(byRow.get(4)?.bankId, 'BNK-AMZ-2');
  assert.equal(byRow.get(4)?.isRecon, 'Yes');
  assert.equal(byRow.get(5), undefined);
  assert.equal(byRow.get(6), undefined);
});

test('matchAmazonOrdersWithBank resolves same-amount bank charges by date proximity and backfills Bank_ID + Is_Recon on partial orders', () => {
  const amazonRecords: AmazonOrderRecord[] = [
    makeAmazonSheetRow({
      sheetRowNumber: 20,
      uniqueId: '400000000001',
      orderNumber: '111-2000000-0000001',
      orderDate: '2026-09-01',
      total: 42.0,
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 21,
      uniqueId: '400000000002',
      orderNumber: '111-2000000-0000002',
      orderDate: '2026-10-15',
      total: 42.0,
    }),
    // Already reconciled order -> untouched
    makeAmazonSheetRow({
      sheetRowNumber: 22,
      uniqueId: '400000000003',
      orderNumber: '111-2000000-0000003',
      orderDate: '2026-10-16',
      total: 70.0,
      bankId: 'BNK-LOCKED',
      isRecon: 'Yes',
    }),
    // Partial multi-item order: row 23 has BNK-PARTIAL with Is_Recon='No', row 24 is blank -> update both to Yes & BNK-PARTIAL
    makeAmazonSheetRow({
      sheetRowNumber: 23,
      uniqueId: '400000000004',
      orderNumber: '111-2000000-0000004',
      orderDate: '2026-10-18',
      total: 35.0,
      bankId: 'BNK-PARTIAL',
      isRecon: 'No',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 24,
      uniqueId: '400000000005',
      orderNumber: '111-2000000-0000004',
      orderDate: '2026-10-18',
      total: null,
      bankId: '',
      isRecon: 'No',
    }),
  ];

  const bankRecords: BankStatementLookupInput[] = [
    makeBankTx({
      uniqueId: 'BNK-SEP',
      amount: -42.0,
      date: '2026-09-02',
      notes: 'Amazon',
    }),
    makeBankTx({
      uniqueId: 'BNK-OCT',
      amount: -42.0,
      date: '2026-10-16',
      notes: 'Amazon',
    }),
    makeBankTx({
      uniqueId: 'BNK-LOCKED',
      amount: -70.0,
      date: '2026-10-16',
      notes: 'Amazon',
    }),
    makeBankTx({
      uniqueId: 'BNK-PARTIAL',
      amount: -35.0,
      date: '2026-10-19',
      notes: 'Amazon',
    }),
  ];

  const plan = matchAmazonOrdersWithBank(amazonRecords, bankRecords);
  const byRow = new Map(plan.rowUpdates.map((u) => [u.sheetRowNumber, u]));

  assert.equal(byRow.get(20)?.bankId, 'BNK-SEP');
  assert.equal(byRow.get(20)?.isRecon, 'Yes');
  assert.equal(byRow.get(21)?.bankId, 'BNK-OCT');
  assert.equal(byRow.get(21)?.isRecon, 'Yes');
  assert.equal(byRow.get(22), undefined);
  assert.equal(byRow.get(23)?.bankId, 'BNK-PARTIAL');
  assert.equal(byRow.get(23)?.isRecon, 'Yes');
  assert.equal(byRow.get(24)?.bankId, 'BNK-PARTIAL');
  assert.equal(byRow.get(24)?.isRecon, 'Yes');
  assert.equal(plan.alreadyMatchedOrderCount, 1);
});

test('Returned items are not marked duplicate against the original Delivered item and keep positive amounts excluded from expense order totals', () => {
  const files: UploadedAmazonFile[] = [
    {
      id: 'f-return',
      fileName: 'order-with-return.pdf',
      mimeType: 'application/pdf',
      fileSize: 1500,
      status: 'ready',
      extractedItems: [
        {
          orderNumber: '111-7777777-8888888',
          orderDate: '2026-10-10',
          quantity: 1,
          itemDescription: 'LED String Lights',
          itemPrice: 29.99,
          total: 29.99,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: 'Debit ... 1234',
          status: 'Delivered',
        },
        {
          orderNumber: '111-7777777-8888888',
          orderDate: '2026-10-10',
          quantity: 1,
          itemDescription: 'LED String Lights',
          itemPrice: -29.99 as unknown as number,
          total: -29.99 as unknown as number,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: 'Debit ... 1234',
          status: 'Returned',
        },
      ],
    },
  ];

  const scanRes = processScannedAmazonFiles(files, new Set(), new Set());
  assert.equal(scanRes.summary.readyToSync, 2);
  assert.equal(scanRes.summary.duplicateSkipped, 0);
  const [delivered, returned] = scanRes.readyOrders;
  assert.equal(delivered.status, 'Delivered');
  assert.equal(returned.status, 'Returned');
  assert.equal(returned.itemPrice, 29.99);
  assert.equal(returned.total, 29.99);
  assert.notEqual(delivered.uniqueId, returned.uniqueId);

  // When saved in sheet, Returned row must not inflate the Order ID's expense total
  const sheetRows: AmazonOrderRecord[] = [
    makeAmazonSheetRow({
      sheetRowNumber: 30,
      uniqueId: delivered.uniqueId,
      orderNumber: '111-7777777-8888888',
      orderDate: '2026-10-10',
      itemDescription: 'LED String Lights',
      itemPrice: 29.99,
      total: 29.99,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 31,
      uniqueId: returned.uniqueId,
      orderNumber: '111-7777777-8888888',
      orderDate: '2026-10-10',
      itemDescription: 'LED String Lights',
      itemPrice: 29.99,
      total: 29.99,
      status: 'Returned',
    }),
  ];

  const expPlan = matchAmazonOrdersWithExpenses(sheetRows, [
    makeExpense({
      expId: 'EXP-RET-ORIG',
      amount: 29.99,
      date: '2026-10-10',
      notes: 'Amazon',
    }),
  ]);
  assert.equal(expPlan.rowUpdates.length, 1);
  assert.equal(expPlan.rowUpdates[0].sheetRowNumber, 30);

  const bankPlan = matchAmazonOrdersWithBank(sheetRows, [
    makeBankTx({
      uniqueId: 'BNK-RET-ORIG',
      amount: -29.99,
      date: '2026-10-11',
      notes: 'Amazon',
    }),
  ]);
  assert.equal(bankPlan.rowUpdates.length, 1);
  assert.equal(bankPlan.rowUpdates[0].sheetRowNumber, 30);
});

test('Order Summary PDF with Delivered + Returned items ($90.08 + $23.94 = $114.02) matches $114.02 original Expense and Bank charges', () => {
  const orderItems: AmazonOrderRecord[] = [
    makeAmazonSheetRow({
      sheetRowNumber: 40,
      uniqueId: '500000000001',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'Comfy Package Straws',
      itemPrice: 7.96,
      total: 7.96,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 41,
      uniqueId: '500000000002',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 2,
      itemDescription: 'Sugar In The Raw',
      itemPrice: 3.77,
      total: 7.54,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 42,
      uniqueId: '500000000003',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'Dealusy Coffee Cups',
      itemPrice: 9.99,
      total: 9.99,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 43,
      uniqueId: '500000000004',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'Chalk Markers',
      itemPrice: 8.27,
      total: 8.27,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 44,
      uniqueId: '500000000005',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'Milk Frother Wand',
      itemPrice: 8.99,
      total: 8.99,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 45,
      uniqueId: '500000000006',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 2,
      itemDescription: 'Paper Napkins',
      itemPrice: 4.99,
      total: 9.98,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 46,
      uniqueId: '500000000007',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'SPLENDA Sweetener',
      itemPrice: 7.38,
      total: 7.38,
      status: 'Delivered',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 47,
      uniqueId: '500000000008',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 3,
      itemDescription: 'Milk Frothing Pitcher',
      itemPrice: 9.99,
      total: 29.97,
      status: 'Delivered',
    }),
    // Refunded / Returned items ($23.94)
    makeAmazonSheetRow({
      sheetRowNumber: 48,
      uniqueId: '500000000009',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'Dealusy Coffee Cups',
      itemPrice: 9.99,
      total: 9.99,
      status: 'Returned',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 49,
      uniqueId: '500000000010',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'Comfy Package Straws',
      itemPrice: 7.96,
      total: 7.96,
      status: 'Returned',
    }),
    makeAmazonSheetRow({
      sheetRowNumber: 50,
      uniqueId: '500000000011',
      orderNumber: '113-4934328-0854635',
      orderDate: '2026-10-03',
      quantity: 1,
      itemDescription: 'UniPleased Disposable Aprons',
      itemPrice: 5.99,
      total: 5.99,
      status: 'Returned',
    }),
  ];

  const expPlan = matchAmazonOrdersWithExpenses(orderItems, [
    makeExpense({
      expId: 'EXP-11402',
      amount: 114.02,
      date: '2026-10-03',
      notes: 'Amazon',
    }),
  ]);
  assert.equal(expPlan.matchedOrders.length, 1);
  assert.equal(expPlan.matchedOrders[0].orderAmount, 114.02);
  assert.equal(expPlan.rowUpdates.length, 11);

  const bankPlan = matchAmazonOrdersWithBank(orderItems, [
    makeBankTx({
      uniqueId: 'BNK-11402',
      amount: -114.02,
      date: '2026-10-04',
      notes: 'Amazon',
    }),
  ]);
  assert.equal(bankPlan.matchedOrders.length, 1);
  assert.equal(bankPlan.matchedOrders[0].orderAmount, 114.02);
  assert.equal(bankPlan.rowUpdates.length, 11);
  assert.equal(bankPlan.rowUpdates.every((u) => u.isRecon === 'Yes'), true);
});




