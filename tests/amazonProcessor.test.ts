import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAmazonDuplicateKey,
  buildAmazonUniqueId,
  isValid12DigitAmazonUniqueId,
  normalizeAmazonPaymentMethod,
  normalizeAmazonStatus,
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

test('processScannedAmazonFiles enforces strict 5-field deduplication without blocking distinct multi-item orders', () => {
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
    {
      id: 'f1',
      fileName: 'summary.jpeg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      status: 'ready',
      extractedItems: [
        // Exact 5-field match against existing sheet record -> Duplicate skipped
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
        // Same Order #, Date, Qty, Item Price=null vs 29.99 -> Allowed because Item Description & Price differ
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
        // Second item in the same multi-item order with blank Item Price and blank Total
        {
          orderNumber: '111-4489470-1300211',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Custom Neon Signs (REGISTRATION)',
          itemPrice: null,
          total: null,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Ordered',
        },
        // Duplicate of item 2 inside the same upload batch -> Duplicate skipped
        {
          orderNumber: '111-4489470-1300211',
          orderDate: '2026-10-04',
          quantity: 1,
          itemDescription: 'Custom Neon Signs (REGISTRATION)',
          itemPrice: null,
          total: null,
          shippedTo: 'Sandip Dasgupta',
          paymentMethod: '',
          status: 'Ordered',
        },
      ],
    },
  ];

  const result = processScannedAmazonFiles(
    files,
    new Set([existingId]),
    new Set([existingDupKey])
  );

  assert.equal(result.summary.totalExtracted, 4);
  assert.equal(result.summary.readyToSync, 2);
  assert.equal(result.summary.duplicateSkipped, 2);
  assert.equal(result.readyOrders[0].itemPrice, null);
  assert.equal(result.readyOrders[1].total, null);
  assert.equal(isValid12DigitAmazonUniqueId(result.readyOrders[0].uniqueId), true);
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


