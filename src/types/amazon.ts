export type AmazonOrderStatus = 'Ordered' | 'Delivered' | 'Cancelled' | 'Returned' | '';

export interface RawExtractedAmazonItem {
  orderNumber: string;
  orderDate: string;
  quantity: number | null;
  itemDescription: string;
  itemPrice: number | null;
  total: number | null;
  shippedTo: string;
  paymentMethod: string;
  status: AmazonOrderStatus;
  category?: string;
}

export type AmazonCategoryMethod =
  | 'deterministic-exact'
  | 'deterministic-keyword'
  | 'historical-description'
  | 'llm'
  | 'abstained';

export interface AmazonCategorizeInput {
  id: string;
  itemDescription: string;
  total?: number | null;
  shippedTo?: string;
}

export interface AmazonCategorizeHistoricalExample {
  itemDescription: string;
  category: string;
}

export interface AmazonCategorizeSuggestion {
  id: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  method: AmazonCategoryMethod;
  reason: string;
}

export interface AmazonCategorizeRequest {
  items: AmazonCategorizeInput[];
  expenseCategories: string[];
  historicalExamples?: AmazonCategorizeHistoricalExample[];
}

export interface AmazonCategorizeResponse {
  results: Array<{
    id: string;
    category: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  }>;
}

export interface AmazonOrderRecord {
  rowKey: string;
  uniqueId: string;
  duplicateKey: string;
  orderNumber: string;
  orderDate: string;
  quantity: number | null;
  itemDescription: string;
  itemPrice: number | null;
  total: number | null;
  shippedTo: string;
  paymentMethod: string;
  status: AmazonOrderStatus;
  isRecon: 'Yes' | 'No';
  category: string;
  expId?: string;
  bankId?: string;
  sourceOrigin: 'sheet' | 'scan';
  sourceFileName?: string;
  isDuplicate?: boolean;
  duplicateReason?: string;
  sheetRowNumber?: number;
  rawRowValues?: Array<string | number>;
}

export interface UploadedAmazonFile {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: 'scanning' | 'ready' | 'error';
  errorMessage?: string;
  extractedItems: RawExtractedAmazonItem[];
}

export interface AmazonPipelineSummary {
  totalExtracted: number;
  duplicateSkipped: number;
  readyToSync: number;
  savedInSheet: number;
}

export interface AmazonSheetMeta {
  spreadsheetId: string;
  spreadsheetTitle: string;
  ledgerTabName: string;
  ledgerTabExists: boolean;
  needsHeader: boolean;
  hasIsReconHeader: boolean;
  hasCategoryHeader: boolean;
  hasExpIdHeader: boolean;
  hasBankIdHeader: boolean;
  isReconColIndex: number;
  categoryColIndex: number;
  expIdColIndex: number;
  bankIdColIndex: number;
  columnHeaders: string[];
}

export interface AmazonSyncPlan {
  meta: AmazonSheetMeta;
  existingIdsCount: number;
  toAppend: AmazonOrderRecord[];
  skippedDuplicatesCount: number;
}

export interface AmazonSyncResult {
  tabName: string;
  spreadsheetId: string;
  appendedCount: number;
  skippedCount: number;
  syncedAt: string;
}
