import { AccountType } from './statement';

export type ChatbotLedgerScope = 'All' | AccountType;
export type ChatbotPaymentStatusFilter = 'All' | 'Paid' | 'Pending';
export type ChatbotLinkStateFilter = 'All' | 'Unlinked' | 'Linked';

export interface ChatbotFilters {
  ledgerScope: ChatbotLedgerScope;
  paymentStatus: ChatbotPaymentStatusFilter;
  linkState: ChatbotLinkStateFilter;
  pujaTag: string;
  startDate: string;
  endDate: string;
}

export interface SnapshotExpenseRow {
  expId: string;
  puja: string;
  ledgerGroup: AccountType;
  date: string;
  amountCents: number;
  amountUsd: number;
  category: string;
  subCategory: string;
  status: string;
  normalizedStatus: 'Paid' | 'Pending' | 'Other';
  paymentMode: string;
  description: string;
  reconSource: string;
  reconSourceId: string;
  isRecon: 'Yes' | 'No';
  isLinked: boolean;
}

export interface SnapshotBankRow {
  uniqueId: string;
  accountTab: AccountType;
  date: string;
  amountCents: number;
  absAmountCents: number;
  amountUsd: number;
  transactionType: 'Income' | 'Expense';
  description: string;
  referenceNumber: string;
  source: string;
  targetId: string;
  isRecon: 'Yes' | 'No';
  category: string;
  isLinked: boolean;
}

export interface SnapshotCatSubcatRow {
  category: string;
  subCategory: string;
}

export interface LedgerSnapshotPayload {
  loadedAt: string;
  filters: ChatbotFilters;
  expenses: SnapshotExpenseRow[];
  bankTransactions: SnapshotBankRow[];
  catSubcats: SnapshotCatSubcatRow[];
  categories: string[];
  pujas: string[];
}

export type DynamicChartType = 'bar' | 'pie' | 'line';

export interface DynamicChartSpec {
  chartType: DynamicChartType;
  title: string;
  subtitle?: string;
  xKey: string;
  valueKey: string;
  secondaryValueKey?: string;
  valueFormat: 'currency' | 'count';
  data: Array<Record<string, string | number>>;
}

export interface SqlQueryAudit {
  sql: string;
  purpose: string;
  rowCount: number;
  durationMs: number;
  error?: string;
}

export interface ChatTableData {
  columns: string[];
  currencyColumns?: string[];
  rows: Array<Record<string, string | number>>;
}

export interface ChatTurnHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  sqlQueries?: SqlQueryAudit[];
  chartSpec?: DynamicChartSpec | null;
  tableData?: ChatTableData | null;
  followUpPrompts?: string[];
  error?: string;
}

export interface ChatApiRequest {
  message: string;
  history: ChatTurnHistoryItem[];
  snapshot: LedgerSnapshotPayload;
}

export interface ChatApiResponse {
  answer: string;
  sqlQueries: SqlQueryAudit[];
  chartSpec: DynamicChartSpec | null;
  tableData: ChatTableData | null;
  followUpPrompts: string[];
}

export interface CategoryBreakdownItem {
  category: string;
  count: number;
  totalCents: number;
  totalUsd: number;
  paidCents: number;
  paidUsd: number;
  pendingCents: number;
  pendingUsd: number;
  unlinkedCount: number;
  unlinkedCents: number;
  unlinkedUsd: number;
  subCategories: Array<{
    subCategory: string;
    count: number;
    totalCents: number;
    totalUsd: number;
    paidUsd: number;
    pendingUsd: number;
    unlinkedCount: number;
    unlinkedUsd: number;
  }>;
}

export interface SourceBreakdownItem {
  source: string;
  totalCount: number;
  totalCents: number;
  totalUsd: number;
  linkedCount: number;
  linkedCents: number;
  linkedUsd: number;
  unlinkedCount: number;
  unlinkedCents: number;
  unlinkedUsd: number;
}

export interface MonthlyTrendItem {
  month: string;
  expenseLedgerUsd: number;
  bankExpenseUsd: number;
  paidUsd: number;
  pendingUsd: number;
}

export interface DashboardAnalyticsResult {
  kpis: {
    expenseCount: number;
    expenseTotalCents: number;
    expenseTotalUsd: number;
    paidCount: number;
    paidCents: number;
    paidUsd: number;
    pendingCount: number;
    pendingCents: number;
    pendingUsd: number;
    bankExpenseCount: number;
    bankExpenseTotalCents: number;
    bankExpenseTotalUsd: number;
    bankIncomeCount: number;
    bankIncomeTotalUsd: number;
    bankLinkedCount: number;
    bankLinkedUsd: number;
    bankUnlinkedCount: number;
    bankUnlinkedCents: number;
    bankUnlinkedUsd: number;
    expenseLinkedCount: number;
    expenseLinkedUsd: number;
    expenseUnlinkedCount: number;
    expenseUnlinkedCents: number;
    expenseUnlinkedUsd: number;
    bankMatchRatePct: number;
    expenseMatchRatePct: number;
  };
  ledgerSplit: Array<{
    ledger: string;
    expenseLedgerUsd: number;
    bankExpenseUsd: number;
    paidUsd: number;
    pendingUsd: number;
    unlinkedBankUsd: number;
    unlinkedExpenseUsd: number;
  }>;
  categoryBreakdown: CategoryBreakdownItem[];
  sourceBreakdown: SourceBreakdownItem[];
  unlinkedBankBySource: SourceBreakdownItem[];
  unlinkedExpenseByCategory: CategoryBreakdownItem[];
  monthlyTrend: MonthlyTrendItem[];
  filteredExpenses: SnapshotExpenseRow[];
  filteredBankExpenses: SnapshotBankRow[];
}
