import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractExpenseVendorNotes,
  findExpenseNotesBackfillUpdates,
} from '../src/utils/expenseProcessor.ts';
import type { ExpenseRecord } from '../src/types/expense.ts';

test('extractExpenseVendorNotes detects common suppliers and vendors in descriptions', () => {
  assert.equal(
    extractExpenseVendorNotes('Purchased LED light signs from Amazon for kitchen'),
    'Amazon'
  );
  assert.equal(
    extractExpenseVendorNotes('Hardware & Plywood - The Home Depot'),
    'Home Depot'
  );
  assert.equal(
    extractExpenseVendorNotes('Ordered from Amazon.com and Home Depot for Puja prep'),
    'Amazon, Home Depot'
  );
  assert.equal(
    extractExpenseVendorNotes('Groceries from Vishala and Patel Brothers'),
    'Vishala, Patel Brothers'
  );
  assert.equal(
    extractExpenseVendorNotes('Bulk water bottles at Costco Wholesale'),
    'Costco'
  );
  assert.equal(
    extractExpenseVendorNotes('Vendor: Sunrise Catering - Prasad boxes'),
    'Sunrise Catering'
  );
  assert.equal(
    extractExpenseVendorNotes('Sound & stage setup by Metro Stage Rentals'),
    'Metro Stage Rentals'
  );
  // Generic word "target" lowercase shouldn't falsely trigger Target brand unless capitalized/branded context?
  // Wait: let's also test empty or vendor-free description
  assert.equal(
    extractExpenseVendorNotes('Reimbursement for priest travel mileage'),
    ''
  );
  assert.equal(extractExpenseVendorNotes(''), '');
});

test('findExpenseNotesBackfillUpdates only populates blank Notes on saved sheet rows', () => {
  const base: Omit<ExpenseRecord, 'sheetRowNumber' | 'expId' | 'description' | 'notes' | 'sourceOrigin'> = {
    date: '2026-10-05',
    amount: 120.5,
    category: 'Supplies',
    subCategory: '',
    status: 'Paid',
    puja: '',
    paymentMode: 'Debit Card',
    reconSource: '',
    reconSourceId: '',
    isRecon: 'No',
  };

  const records: ExpenseRecord[] = [
    {
      ...base,
      sheetRowNumber: 2,
      expId: 'EXP-001',
      description: 'Extension cords from Home Depot',
      notes: '',
      sourceOrigin: 'sheet',
    },
    {
      ...base,
      sheetRowNumber: 3,
      expId: 'EXP-002',
      description: 'Amazon order #111-2222222-3333333',
      notes: 'Custom Existing Note',
      sourceOrigin: 'sheet',
    },
    {
      ...base,
      sheetRowNumber: 4,
      expId: 'EXP-003',
      description: 'Reimbursement for flowers',
      notes: '',
      sourceOrigin: 'sheet',
    },
    {
      ...base,
      sheetRowNumber: null,
      expId: 'EXP-004',
      description: 'Walmart paper plates',
      notes: '',
      sourceOrigin: 'csv',
    },
  ];

  const updates = findExpenseNotesBackfillUpdates(records);
  assert.deepEqual(updates, [
    {
      sheetRowNumber: 2,
      notes: 'Home Depot',
    },
  ]);
});
