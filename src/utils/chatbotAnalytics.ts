import {
  CategoryBreakdownItem,
  ChatbotFilters,
  DashboardAnalyticsResult,
  LedgerSnapshotPayload,
  MonthlyTrendItem,
  SnapshotBankRow,
  SnapshotCatSubcatRow,
  SnapshotExpenseRow,
  SourceBreakdownItem,
} from '../types/chatbot';
import { ExpenseLookups, ExpenseRecord } from '../types/expense';
import { AccountType, NormalizedTransaction } from '../types/statement';

export function formatUsdFromCents(cents: number): string {
  const value = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

function classifyExpenseLedgerGroup(pujaRaw: string): AccountType {
  const lower = pujaRaw.trim().toLowerCase();
  if (lower.includes('regular')) {
    return 'Regular';
  }
  return 'Puja';
}

function normalizePaymentStatus(statusRaw: string): 'Paid' | 'Pending' | 'Other' {
  const lower = statusRaw.trim().toLowerCase();
  if (lower === 'paid') return 'Paid';
  if (lower === 'pending' || lower === 'unpaid' || lower === 'due') return 'Pending';
  return 'Other';
}

export function buildLedgerSnapshot(
  expenses: ExpenseRecord[],
  lookups: ExpenseLookups,
  bankPujaTransactions: NormalizedTransaction[],
  bankRegularTransactions: NormalizedTransaction[],
  filters: ChatbotFilters
): LedgerSnapshotPayload {
  const expenseRows: SnapshotExpenseRow[] = expenses.map((rec) => {
    const amountCents = Math.round(rec.amount * 100);
    const pujaLabel = rec.puja.trim() || 'Unspecified';
    return {
      expId: rec.expId,
      puja: pujaLabel,
      ledgerGroup: classifyExpenseLedgerGroup(pujaLabel),
      date: rec.date,
      amountCents,
      amountUsd: centsToUsd(amountCents),
      category: rec.category.trim() || 'Uncategorized',
      subCategory: rec.subCategory.trim() || 'Unspecified',
      status: rec.status.trim() || 'Unspecified',
      normalizedStatus: normalizePaymentStatus(rec.status),
      paymentMode: rec.paymentMode.trim() || 'Unspecified',
      description: rec.description.trim(),
      reconSource: rec.reconSource.trim(),
      reconSourceId: rec.reconSourceId.trim(),
      isRecon: rec.isRecon === 'Yes' ? 'Yes' : 'No',
      isLinked: rec.reconSourceId.trim() !== '',
    };
  });

  const toBankRow = (tx: NormalizedTransaction, accountTab: AccountType): SnapshotBankRow => {
    const signedCents = Number.isFinite(tx.amountCents)
      ? tx.amountCents
      : Math.round(tx.amount * 100);
    const absCents = Math.abs(signedCents);
    const targetId = (tx.targetId ?? '').trim();
    return {
      uniqueId: tx.uniqueId,
      accountTab,
      date: tx.date,
      amountCents: signedCents,
      absAmountCents: absCents,
      amountUsd: centsToUsd(absCents),
      transactionType: tx.transactionType,
      description: tx.description.trim(),
      referenceNumber: tx.referenceNumber.trim(),
      source: tx.source.trim() || 'Other',
      targetId,
      isRecon: tx.isRecon === 'Yes' ? 'Yes' : 'No',
      category: (tx.category ?? '').trim(),
      isLinked: targetId !== '',
    };
  };

  const bankRows: SnapshotBankRow[] = [
    ...bankPujaTransactions.map((tx) => toBankRow(tx, 'Puja')),
    ...bankRegularTransactions.map((tx) => toBankRow(tx, 'Regular')),
  ];

  const catSubcats: SnapshotCatSubcatRow[] = [];
  for (const [category, subs] of Object.entries(lookups.catSubcatMap)) {
    for (const subCategory of subs) {
      catSubcats.push({ category, subCategory });
    }
  }

  return {
    loadedAt: new Date().toISOString(),
    filters,
    expenses: expenseRows,
    bankTransactions: bankRows,
    catSubcats,
    categories: lookups.categories,
    pujas: lookups.pujas,
  };
}

export function computeDashboardAnalytics(
  snapshot: LedgerSnapshotPayload,
  filters: ChatbotFilters
): DashboardAnalyticsResult {
  const filteredExpenses = snapshot.expenses.filter((row) => {
    if (filters.ledgerScope !== 'All' && row.ledgerGroup !== filters.ledgerScope) {
      return false;
    }
    if (filters.pujaTag !== 'all' && row.puja.toLowerCase() !== filters.pujaTag.toLowerCase()) {
      return false;
    }
    if (filters.paymentStatus === 'Paid' && row.normalizedStatus !== 'Paid') {
      return false;
    }
    if (filters.paymentStatus === 'Pending' && row.normalizedStatus !== 'Pending') {
      return false;
    }
    if (filters.linkState === 'Linked' && !row.isLinked) {
      return false;
    }
    if (filters.linkState === 'Unlinked' && row.isLinked) {
      return false;
    }
    if (filters.startDate && row.date < filters.startDate) {
      return false;
    }
    if (filters.endDate && row.date > filters.endDate) {
      return false;
    }
    return true;
  });

  const filteredBankAll = snapshot.bankTransactions.filter((row) => {
    if (filters.ledgerScope !== 'All' && row.accountTab !== filters.ledgerScope) {
      return false;
    }
    if (filters.startDate && row.date < filters.startDate) {
      return false;
    }
    if (filters.endDate && row.date > filters.endDate) {
      return false;
    }
    return true;
  });

  const filteredBankExpenses = filteredBankAll.filter((row) => {
    if (row.transactionType !== 'Expense') return false;
    if (filters.linkState === 'Linked' && !row.isLinked) return false;
    if (filters.linkState === 'Unlinked' && row.isLinked) return false;
    return true;
  });

  // Expense KPIs
  let expenseTotalCents = 0;
  let paidCount = 0;
  let paidCents = 0;
  let pendingCount = 0;
  let pendingCents = 0;
  let expenseLinkedCount = 0;
  let expenseLinkedCents = 0;
  let expenseUnlinkedCount = 0;
  let expenseUnlinkedCents = 0;

  for (const exp of filteredExpenses) {
    expenseTotalCents += exp.amountCents;
    if (exp.normalizedStatus === 'Paid') {
      paidCount++;
      paidCents += exp.amountCents;
    } else if (exp.normalizedStatus === 'Pending') {
      pendingCount++;
      pendingCents += exp.amountCents;
    }
    if (exp.isLinked) {
      expenseLinkedCount++;
      expenseLinkedCents += exp.amountCents;
    } else {
      expenseUnlinkedCount++;
      expenseUnlinkedCents += exp.amountCents;
    }
  }

  // Bank KPIs
  let bankExpenseTotalCents = 0;
  let bankLinkedCount = 0;
  let bankLinkedCents = 0;
  let bankUnlinkedCount = 0;
  let bankUnlinkedCents = 0;

  for (const bank of filteredBankExpenses) {
    bankExpenseTotalCents += bank.absAmountCents;
    if (bank.isLinked) {
      bankLinkedCount++;
      bankLinkedCents += bank.absAmountCents;
    } else {
      bankUnlinkedCount++;
      bankUnlinkedCents += bank.absAmountCents;
    }
  }

  let bankIncomeCount = 0;
  let bankIncomeCents = 0;
  for (const bank of filteredBankAll) {
    if (bank.transactionType === 'Income') {
      bankIncomeCount++;
      bankIncomeCents += bank.absAmountCents;
    }
  }

  // Category & Sub-Category breakdown
  interface SubAccum {
    subCategory: string;
    count: number;
    totalCents: number;
    paidCents: number;
    pendingCents: number;
    unlinkedCount: number;
    unlinkedCents: number;
  }
  interface CatAccum {
    category: string;
    count: number;
    totalCents: number;
    paidCents: number;
    pendingCents: number;
    unlinkedCount: number;
    unlinkedCents: number;
    subMap: Map<string, SubAccum>;
  }

  const catMap = new Map<string, CatAccum>();
  for (const exp of filteredExpenses) {
    const cat = exp.category || 'Uncategorized';
    const sub = exp.subCategory || 'Unspecified';
    let entry = catMap.get(cat);
    if (!entry) {
      entry = {
        category: cat,
        count: 0,
        totalCents: 0,
        paidCents: 0,
        pendingCents: 0,
        unlinkedCount: 0,
        unlinkedCents: 0,
        subMap: new Map<string, SubAccum>(),
      };
      catMap.set(cat, entry);
    }

    entry.count++;
    entry.totalCents += exp.amountCents;
    if (exp.normalizedStatus === 'Paid') entry.paidCents += exp.amountCents;
    if (exp.normalizedStatus === 'Pending') entry.pendingCents += exp.amountCents;
    if (!exp.isLinked) {
      entry.unlinkedCount++;
      entry.unlinkedCents += exp.amountCents;
    }

    let subEntry = entry.subMap.get(sub);
    if (!subEntry) {
      subEntry = {
        subCategory: sub,
        count: 0,
        totalCents: 0,
        paidCents: 0,
        pendingCents: 0,
        unlinkedCount: 0,
        unlinkedCents: 0,
      };
      entry.subMap.set(sub, subEntry);
    }
    subEntry.count++;
    subEntry.totalCents += exp.amountCents;
    if (exp.normalizedStatus === 'Paid') subEntry.paidCents += exp.amountCents;
    if (exp.normalizedStatus === 'Pending') subEntry.pendingCents += exp.amountCents;
    if (!exp.isLinked) {
      subEntry.unlinkedCount++;
      subEntry.unlinkedCents += exp.amountCents;
    }
  }

  const categoryBreakdown: CategoryBreakdownItem[] = Array.from(catMap.values())
    .map((c) => ({
      category: c.category,
      count: c.count,
      totalCents: c.totalCents,
      totalUsd: centsToUsd(c.totalCents),
      paidCents: c.paidCents,
      paidUsd: centsToUsd(c.paidCents),
      pendingCents: c.pendingCents,
      pendingUsd: centsToUsd(c.pendingCents),
      unlinkedCount: c.unlinkedCount,
      unlinkedCents: c.unlinkedCents,
      unlinkedUsd: centsToUsd(c.unlinkedCents),
      subCategories: Array.from(c.subMap.values())
        .map((s) => ({
          subCategory: s.subCategory,
          count: s.count,
          totalCents: s.totalCents,
          totalUsd: centsToUsd(s.totalCents),
          paidUsd: centsToUsd(s.paidCents),
          pendingUsd: centsToUsd(s.pendingCents),
          unlinkedCount: s.unlinkedCount,
          unlinkedUsd: centsToUsd(s.unlinkedCents),
        }))
        .sort((a, b) => b.totalCents - a.totalCents),
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  // Source breakdown (Bank Expenses)
  const sourceMap = new Map<
    string,
    {
      source: string;
      totalCount: number;
      totalCents: number;
      linkedCount: number;
      linkedCents: number;
      unlinkedCount: number;
      unlinkedCents: number;
    }
  >();

  for (const bank of filteredBankExpenses) {
    const src = bank.source || 'Other';
    let entry = sourceMap.get(src);
    if (!entry) {
      entry = {
        source: src,
        totalCount: 0,
        totalCents: 0,
        linkedCount: 0,
        linkedCents: 0,
        unlinkedCount: 0,
        unlinkedCents: 0,
      };
      sourceMap.set(src, entry);
    }
    entry.totalCount++;
    entry.totalCents += bank.absAmountCents;
    if (bank.isLinked) {
      entry.linkedCount++;
      entry.linkedCents += bank.absAmountCents;
    } else {
      entry.unlinkedCount++;
      entry.unlinkedCents += bank.absAmountCents;
    }
  }

  const sourceBreakdown: SourceBreakdownItem[] = Array.from(sourceMap.values())
    .map((s) => ({
      ...s,
      totalUsd: centsToUsd(s.totalCents),
      linkedUsd: centsToUsd(s.linkedCents),
      unlinkedUsd: centsToUsd(s.unlinkedCents),
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  const unlinkedBankBySource = sourceBreakdown
    .filter((s) => s.unlinkedCount > 0)
    .sort((a, b) => b.unlinkedCents - a.unlinkedCents);

  const unlinkedExpenseByCategory = categoryBreakdown
    .filter((c) => c.unlinkedCount > 0)
    .sort((a, b) => b.unlinkedCents - a.unlinkedCents);

  // Puja vs Regular comparison
  const ledgerSplit = (['Puja', 'Regular'] as AccountType[]).map((ledger) => {
    const exps = filteredExpenses.filter((e) => e.ledgerGroup === ledger);
    const banks = filteredBankExpenses.filter((b) => b.accountTab === ledger);
    const expTotal = exps.reduce((sum, e) => sum + e.amountCents, 0);
    const paid = exps
      .filter((e) => e.normalizedStatus === 'Paid')
      .reduce((sum, e) => sum + e.amountCents, 0);
    const pending = exps
      .filter((e) => e.normalizedStatus === 'Pending')
      .reduce((sum, e) => sum + e.amountCents, 0);
    const bankTotal = banks.reduce((sum, b) => sum + b.absAmountCents, 0);
    const unlinkedBank = banks
      .filter((b) => !b.isLinked)
      .reduce((sum, b) => sum + b.absAmountCents, 0);
    const unlinkedExp = exps
      .filter((e) => !e.isLinked)
      .reduce((sum, e) => sum + e.amountCents, 0);

    return {
      ledger,
      expenseLedgerUsd: centsToUsd(expTotal),
      bankExpenseUsd: centsToUsd(bankTotal),
      paidUsd: centsToUsd(paid),
      pendingUsd: centsToUsd(pending),
      unlinkedBankUsd: centsToUsd(unlinkedBank),
      unlinkedExpenseUsd: centsToUsd(unlinkedExp),
    };
  });

  // Monthly Trend
  const monthMap = new Map<
    string,
    {
      month: string;
      expenseLedgerCents: number;
      bankExpenseCents: number;
      paidCents: number;
      pendingCents: number;
    }
  >();

  const ensureMonth = (dateStr: string) => {
    const m = /^(\d{4}-\d{2})/.exec(dateStr.trim());
    const key = m ? m[1] : null;
    if (!key) return null;
    let entry = monthMap.get(key);
    if (!entry) {
      entry = {
        month: key,
        expenseLedgerCents: 0,
        bankExpenseCents: 0,
        paidCents: 0,
        pendingCents: 0,
      };
      monthMap.set(key, entry);
    }
    return entry;
  };

  for (const exp of filteredExpenses) {
    const entry = ensureMonth(exp.date);
    if (!entry) continue;
    entry.expenseLedgerCents += exp.amountCents;
    if (exp.normalizedStatus === 'Paid') entry.paidCents += exp.amountCents;
    if (exp.normalizedStatus === 'Pending') entry.pendingCents += exp.amountCents;
  }

  for (const bank of filteredBankExpenses) {
    const entry = ensureMonth(bank.date);
    if (!entry) continue;
    entry.bankExpenseCents += bank.absAmountCents;
  }

  const monthlyTrend: MonthlyTrendItem[] = Array.from(monthMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      expenseLedgerUsd: centsToUsd(m.expenseLedgerCents),
      bankExpenseUsd: centsToUsd(m.bankExpenseCents),
      paidUsd: centsToUsd(m.paidCents),
      pendingUsd: centsToUsd(m.pendingCents),
    }));

  const bankMatchRatePct =
    filteredBankExpenses.length > 0
      ? Math.round((bankLinkedCount / filteredBankExpenses.length) * 1000) / 10
      : 0;

  const expenseMatchRatePct =
    filteredExpenses.length > 0
      ? Math.round((expenseLinkedCount / filteredExpenses.length) * 1000) / 10
      : 0;

  return {
    kpis: {
      expenseCount: filteredExpenses.length,
      expenseTotalCents,
      expenseTotalUsd: centsToUsd(expenseTotalCents),
      paidCount,
      paidCents,
      paidUsd: centsToUsd(paidCents),
      pendingCount,
      pendingCents,
      pendingUsd: centsToUsd(pendingCents),
      bankExpenseCount: filteredBankExpenses.length,
      bankExpenseTotalCents,
      bankExpenseTotalUsd: centsToUsd(bankExpenseTotalCents),
      bankIncomeCount,
      bankIncomeTotalUsd: centsToUsd(bankIncomeCents),
      bankLinkedCount,
      bankLinkedUsd: centsToUsd(bankLinkedCents),
      bankUnlinkedCount,
      bankUnlinkedCents,
      bankUnlinkedUsd: centsToUsd(bankUnlinkedCents),
      expenseLinkedCount,
      expenseLinkedUsd: centsToUsd(expenseLinkedCents),
      expenseUnlinkedCount,
      expenseUnlinkedCents,
      expenseUnlinkedUsd: centsToUsd(expenseUnlinkedCents),
      bankMatchRatePct,
      expenseMatchRatePct,
    },
    ledgerSplit,
    categoryBreakdown,
    sourceBreakdown,
    unlinkedBankBySource,
    unlinkedExpenseByCategory,
    monthlyTrend,
    filteredExpenses,
    filteredBankExpenses,
  };
}

export function exportRowsToCsv(
  fileName: string,
  columns: string[],
  rows: Array<Record<string, string | number>>
): void {
  const escapeCell = (val: string | number | undefined | null): string => {
    const str = String(val ?? '');
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines: string[] = [
    columns.map((c) => escapeCell(c)).join(','),
    ...rows.map((r) => columns.map((c) => escapeCell(r[c])).join(',')),
  ];

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
