export type AccountType = 'Puja' | 'Regular';

export interface ColumnMapping {
  dateCol: string;
  descriptionCol: string;
  amountMode: 'single' | 'split';
  amountCol: string;
  debitCol: string;
  creditCol: string;
  checkCol: string;
}

export interface UploadedStatement {
  id: string;
  fileName: string;
  fileSize: number;
  rawHeaders: string[];
  rawRows: Record<string, string>[];
  skippedPreambleLines: number;
  mapping: ColumnMapping;
  mappingStatus: 'auto' | 'manual' | 'needs-mapping';
}

export type TransactionType = 'Income' | 'Expense';

export type ReviewStatus = 'ok' | 'flagged-duplicate' | 'kept-distinct' | 'discarded';

export type SyncStatus = 'pending' | 'already-in-sheet' | 'newly-synced';

export interface NormalizedTransaction {
  rowKey: string;
  flagKey: string;
  uniqueId: string;
  date: string;
  amount: number;
  amountCents: number;
  transactionType: TransactionType;
  description: string;
  referenceNumber: string;
  source: string;
  sourceFile: string;
  occurrenceIndex: number;
  reviewStatus: ReviewStatus;
  syncStatus: SyncStatus;
  /** Linked Exp_ID from Expense_Ledger ("Target ID" column in Bank Ledger) */
  targetId?: string;
  /** Reconciliation status ("Is_Recon" column: "Yes" or "No") */
  isRecon?: 'Yes' | 'No';
  /** Expense Category copied or selected for this transaction ("Category" column) */
  category?: string;
  /** Exact 1-based row number in Google Sheets when loaded from the sheet */
  sheetRowNumber?: number | null;
}

export interface PipelineSummary {
  totalRawRows: number;
  validParsedRows: number;
  skippedInvalidRows: number;
  crossFileDuplicatesRemoved: number;
  flaggedForReview: number;
  keptDistinct: number;
  discarded: number;
  readyToSync: number;
  alreadyInSheet: number;
  newlySynced: number;
}

export interface SyncPlan {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabName: AccountType;
  tabExists: boolean;
  needsHeader: boolean;
  needsTargetIdHeader?: boolean;
  targetIdColIndex?: number;
  needsIsReconHeader?: boolean;
  isReconColIndex?: number;
  needsCategoryHeader?: boolean;
  categoryColIndex?: number;
  existingIdsCount: number;
  toAppend: NormalizedTransaction[];
  skippedAlreadySynced: NormalizedTransaction[];
  unresolvedFlaggedCount: number;
}

export interface SyncResult {
  tabName: AccountType;
  spreadsheetId: string;
  appendedCount: number;
  skippedCount: number;
  syncedAt: string;
}
