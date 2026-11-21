export type CheckTransactionType = 'Income' | 'Expense';

export interface RawExtractedCheck {
  checkNumber: string;
  routingNumber: string;
  bank: string;
  date: string;
  amount: number;
  paidTo: string;
  paidBy: string;
  memo: string;
  category?: string;
}

export type CheckCategoryMethod =
  | 'deterministic-exact'
  | 'deterministic-keyword'
  | 'historical-memo'
  | 'historical-counterparty'
  | 'llm'
  | 'abstained';

export interface CheckCategorizeInput {
  id: string;
  transactionType: CheckTransactionType;
  amount?: number;
  memo: string;
  paidTo: string;
  paidBy: string;
}

export interface CheckCategorizeHistoricalExample {
  transactionType: CheckTransactionType;
  memo: string;
  paidTo: string;
  paidBy: string;
  category: string;
}

export interface CheckCategorizeSuggestion {
  id: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  method: CheckCategoryMethod;
  reason: string;
}

export interface CheckCategorizeRequest {
  checks: CheckCategorizeInput[];
  expenseCategories: string[];
  incomeCategories: string[];
  historicalExamples?: CheckCategorizeHistoricalExample[];
}

export interface CheckCategorizeResponse {
  results: Array<{
    id: string;
    category: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  }>;
}

export interface CheckRecord {
  rowKey: string;
  uniqueId: string;
  canonicalKey: string;
  routingKey?: string;
  checkNumber: string;
  routingNumber: string;
  bank: string;
  date: string;
  amount: number;
  amountCents: number;
  paidTo: string;
  paidBy: string;
  memo: string;
  transactionType: CheckTransactionType;
  isRecon: 'Yes' | 'No';
  category?: string;
  sourceOrigin: 'sheet' | 'scan';
  sourceFileName?: string;
  isDuplicate?: boolean;
  duplicateReason?: string;
  sheetRowNumber?: number;
  rawRowValues?: Array<string | number>;
}

export interface UploadedCheckFile {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: 'scanning' | 'ready' | 'error';
  errorMessage?: string;
  extractedChecks: RawExtractedCheck[];
}

export interface CheckPipelineSummary {
  totalExtracted: number;
  duplicateSkipped: number;
  readyToSync: number;
  savedInSheet: number;
}

export interface CheckSheetMeta {
  spreadsheetId: string;
  spreadsheetTitle: string;
  ledgerTabName: string;
  ledgerTabExists: boolean;
  needsHeader: boolean;
  hasTransactionTypeHeader: boolean;
  hasIsReconHeader: boolean;
  hasRoutingNumberHeader: boolean;
  hasCategoryHeader: boolean;
  transactionTypeColIndex: number;
  isReconColIndex: number;
  routingNumberColIndex: number;
  categoryColIndex: number;
  columnHeaders: string[];
}

export interface CheckSyncPlan {
  meta: CheckSheetMeta;
  existingIdsCount: number;
  toAppend: CheckRecord[];
  skippedDuplicatesCount: number;
}

export interface CheckSyncResult {
  tabName: string;
  spreadsheetId: string;
  appendedCount: number;
  skippedCount: number;
  syncedAt: string;
}
