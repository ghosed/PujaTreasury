export interface ExpenseRecord {
  /** Exact 1-based row number in the Google Sheet if already saved; null for unsaved staged CSV rows */
  sheetRowNumber: number | null;
  /** Unique ID in Google Sheet (`Exp_ID`) */
  expId: string;
  date: string;
  amount: number;
  category: string;
  subCategory: string;
  description: string;
  status: string;
  puja: string;
  paymentMode: string;
  reconSource: string;
  reconSourceId: string;
  /** Reconciliation status (`Is_Recon` column: "Yes" or "No") */
  isRecon: 'Yes' | 'No';
  /** Raw row cells preserved from Google Sheet so updates keep extra columns intact */
  rawRowValues?: Array<string | number>;
  /** Local UI state */
  sourceOrigin: 'sheet' | 'csv' | 'manual';
  sourceFileName?: string;
}

export interface ExpenseLookups {
  categories: string[];
  statuses: string[];
  pujas: string[];
  paymentModes: string[];
  /** Category -> ordered unique list of Sub Categories from CatSubcat tab */
  catSubcatMap: Record<string, string[]>;
}

export interface ExpenseSheetMeta {
  spreadsheetId: string;
  spreadsheetTitle: string;
  ledgerTabName: string;
  ledgerTabExists: boolean;
  needsHeader: boolean;
  hasIsReconHeader: boolean;
  isReconColIndex: number;
  /** Actual header row from the Expense Ledger tab (or canonical headers if empty) */
  columnHeaders: string[];
  lookUpTabName: string | null;
  catSubcatTabName: string | null;
}

export interface ExpenseCsvColumnMapping {
  expIdCol: string;
  dateCol: string;
  amountCol: string;
  categoryCol: string;
  subCategoryCol: string;
  descriptionCol: string;
  statusCol: string;
  requestTypeCol: string;
  pujaCol: string;
  paymentModeCol: string;
  reconSourceCol: string;
  reconSourceIdCol: string;
}

export interface UploadedExpenseCsv {
  id: string;
  fileName: string;
  fileSize: number;
  rawHeaders: string[];
  rawRows: Record<string, string>[];
  skippedPreambleLines: number;
  mapping: ExpenseCsvColumnMapping;
  mappingStatus: 'auto' | 'manual' | 'needs-mapping';
}

export interface StagedExpenseBatchSummary {
  totalRawRows: number;
  filteredOutByTypeOrStatus: number;
  skippedInvalidRows: number;
  duplicateIdsRemoved: number;
  readyToSync: number;
}

export type ExpenseMutationAction =
  | {
      kind: 'bulk-append';
      records: ExpenseRecord[];
      duplicateCount: number;
    }
  | {
      kind: 'manual-create';
      record: ExpenseRecord;
    }
  | {
      kind: 'edit-update';
      before: ExpenseRecord;
      after: ExpenseRecord;
    };
