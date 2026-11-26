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
import type { AmazonOrderRecord, UploadedAmazonFile } from '../src/types/amazon.ts';

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
