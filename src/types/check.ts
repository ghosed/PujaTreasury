export type CheckTransactionType = 'Income' | 'Expense';

export interface RawExtractedCheck {
  checkNumber: string;
  bank: string;
  date: string;
  amount: number;
  paidTo: string;
  paidBy: string;
  memo: string;
}

export interface CheckRecord {
  rowKey: string;
  uniqueId: string;
  canonicalKey: string;
  checkNumber: string;
  bank: string;
  date: string;
  amount: number;
  amountCents: number;
  paidTo: string;
  paidBy: string;
  memo: string;
  transactionType: CheckTransactionType;
  isRecon: 'Yes' | 'No';
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
  transactionTypeColIndex: number;
  isReconColIndex: number;
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
