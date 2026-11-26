import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Download,
  ExternalLink,
  FileImage,
  FileSpreadsheet,
  FileText,
  Landmark,
  Link2,
  Package,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  AmazonOrderRecord,
  AmazonOrderStatus,
  AmazonSheetMeta,
  AmazonSyncPlan,
  RawExtractedAmazonItem,
  UploadedAmazonFile,
} from '../../types/amazon';
import { ExpenseRecord } from '../../types/expense';
import {
  buildAmazonUniqueId,
  isValid12DigitAmazonUniqueId,
  processScannedAmazonFiles,
} from '../../utils/amazonProcessor';
import { categorizeAmazonHybrid } from '../../utils/amazonCategorizer';
import {
  matchAmazonOrdersWithBank,
  matchAmazonOrdersWithExpenses,
} from '../../utils/amazonExpenseRecon';
import { parseExactAmountQueryCents, toCents } from '../../utils/reconAllocations';
import {
  AMAZON_SPREADSHEET_ID,
  batchUpdateAmazonBankRecon,
  batchUpdateAmazonCategories,
  batchUpdateAmazonExpIds,
  batchUpdateAmazonUniqueIds,
  CANONICAL_AMAZON_HEADERS,
  deleteAmazonRows,
  ensureAmazonExtraHeaders,
  executeAmazonSyncPlan,
  fetchAmazonLedger,
  prepareAmazonSyncPlan,
  updateAmazonCategory,
  updateAmazonIsRecon,
  updateAmazonRecord,
} from '../../services/amazonSheets';
import {
  BankLookUpCategories,
  fetchBankLookUpCategories,
  fetchSheetLedger,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from '../../services/googleSheets';
import {
  EXPENSE_SPREADSHEET_ID,
  fetchExpenseCategories,
  fetchExpenseWorkspace,
} from '../../services/expenseSheets';
import { clearCachedToken, getAccessToken } from '../../services/firebaseAuth';
import { AmazonGrid, AmazonSortField } from './AmazonGrid';
import { AmazonEntryModal, BankLedgerLookupRecord } from './AmazonEntryModal';
import { AmazonSyncConfirmModal } from './AmazonSyncConfirmModal';
import {
  AmazonCategorizeModal,
  AmazonCategorizeReviewItem,
} from './AmazonCategorizeModal';
import { AmazonDeleteConfirmModal } from './AmazonDeleteConfirmModal';

interface AmazonModuleProps {
  needsAuth: boolean;
  isLoggingIn: boolean;
  onSignIn: () => void;
  onAuthExpired: () => void;
}

type OriginFilter = 'all' | 'sheet' | 'ready' | 'duplicates';
type StatusFilter = 'all' | 'Ordered' | 'Delivered' | 'Cancelled' | 'Returned' | 'blank';
type ReconFilter = 'all' | 'unrecon' | 'recon';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => {
      reject(new Error(`Could not read "${file.name}".`));
    };
    reader.readAsDataURL(file);
  });
}

function inferMimeType(file: File): string {
  if (file.type) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  return 'application/octet-stream';
}

function isSupportedAmazonFile(file: File): boolean {
  const mime = inferMimeType(file).toLowerCase();
  return mime === 'application/pdf' || mime.startsWith('image/');
}

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const AmazonModule: React.FC<AmazonModuleProps> = ({
  needsAuth,
  isLoggingIn,
  onSignIn,
  onAuthExpired,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isFetchingRef = useRef(false);
  const rawFileMapRef = useRef<Record<string, File>>({});

  // Google Sheet state
  const [sheetMeta, setSheetMeta] = useState<AmazonSheetMeta | null>(null);
  const [sheetRecords, setSheetRecords] = useState<AmazonOrderRecord[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [existingDuplicateKeys, setExistingDuplicateKeys] = useState<Set<string>>(new Set());
  const [hasLoadedSheet, setHasLoadedSheet] = useState(false);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  // Scan Queue & Edits
  const [uploadedFiles, setUploadedFiles] = useState<UploadedAmazonFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [stagedOverrides, setStagedOverrides] = useState<
    Record<string, Partial<AmazonOrderRecord>>
  >({});

  // Modals & Operations
  const [entryModalState, setEntryModalState] = useState<{
    isOpen: boolean;
    mode: 'create' | 'edit';
    record: AmazonOrderRecord | null;
  }>({
    isOpen: false,
    mode: 'create',
    record: null,
  });
  const [pendingSyncPlan, setPendingSyncPlan] = useState<AmazonSyncPlan | null>(null);
  const [clearQueueAfterSync, setClearQueueAfterSync] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPreparingSync, setIsPreparingSync] = useState(false);
  const [isMigratingIds, setIsMigratingIds] = useState(false);
  const [isSavingModal, setIsSavingModal] = useState(false);
  const [updatingReconKey, setUpdatingReconKey] = useState<string | null>(null);
  const [updatingCategoryKey, setUpdatingCategoryKey] = useState<string | null>(null);
  const [isAutoCategorizing, setIsAutoCategorizing] = useState(false);
  const [isApplyingBatchCategories, setIsApplyingBatchCategories] = useState(false);
  const [isAutoReconExpenses, setIsAutoReconExpenses] = useState(false);
  const [isAutoReconBank, setIsAutoReconBank] = useState(false);
  const [categorizeReviewState, setCategorizeReviewState] = useState<{
    isOpen: boolean;
    items: AmazonCategorizeReviewItem[];
  }>({ isOpen: false, items: [] });
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    isOpen: boolean;
    mode: 'single' | 'all';
    records: AmazonOrderRecord[];
  }>({
    isOpen: false,
    mode: 'single',
    records: [],
  });
  const [isDeletingRecords, setIsDeletingRecords] = useState(false);

  // LookUp Categories (Amazon_Ledger LookUp -> Bank_Ledger LookUp -> Expense_Ledger fallback)
  const [amazonLookupCategories, setAmazonLookupCategories] = useState<BankLookUpCategories>({
    expenseCategories: [],
    incomeCategories: [],
  });
  const [bankLookupCategories, setBankLookupCategories] = useState<BankLookUpCategories>({
    expenseCategories: [],
    incomeCategories: [],
  });
  const [expenseFallbackCategories, setExpenseFallbackCategories] = useState<string[]>([]);
  const [expenseRecords, setExpenseRecords] = useState<ExpenseRecord[]>([]);
  const [bankRecords, setBankRecords] = useState<BankLedgerLookupRecord[]>([]);

  // Notifications
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters & Sort
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [reconFilter, setReconFilter] = useState<ReconFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sortField, setSortField] = useState<AmazonSortField>('orderDate');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const loadAmazonLookupCategories = useCallback(async (explicitToken?: string) => {
    const token = explicitToken ?? (await getAccessToken());
    if (!token) return;

    const [amzRes, bankRes, expenseRes] = await Promise.allSettled([
      fetchBankLookUpCategories(token, AMAZON_SPREADSHEET_ID),
      fetchBankLookUpCategories(token, TARGET_SPREADSHEET_ID),
      fetchExpenseCategories(token, EXPENSE_SPREADSHEET_ID),
    ]);

    if (amzRes.status === 'fulfilled') {
      setAmazonLookupCategories(amzRes.value);
    }
    if (bankRes.status === 'fulfilled') {
      setBankLookupCategories(bankRes.value);
    }
    if (expenseRes.status === 'fulfilled') {
      setExpenseFallbackCategories(expenseRes.value);
    }
  }, []);

  const loadAmazonLedger = useCallback(
    async (explicitToken?: string) => {
      if (isFetchingRef.current) return;
      const token = explicitToken ?? (await getAccessToken());
      if (!token) {
        onAuthExpired();
        return;
      }

      isFetchingRef.current = true;
      setIsLoadingSheet(true);
      setErrorMessage(null);
      try {
        const [loaded, , expenseRes, pujaBankRes, regularBankRes] = await Promise.all([
          fetchAmazonLedger(token, AMAZON_SPREADSHEET_ID),
          loadAmazonLookupCategories(token),
          fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID).catch(() => null),
          fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Puja').catch(() => null),
          fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Regular').catch(() => null),
        ]);

        let activeMeta = loaded.meta;
        if (
          activeMeta.ledgerTabExists &&
          !activeMeta.needsHeader &&
          (!activeMeta.hasIsReconHeader ||
            !activeMeta.hasCategoryHeader ||
            !activeMeta.hasExpIdHeader ||
            !activeMeta.hasBankIdHeader)
        ) {
          try {
            activeMeta = await ensureAmazonExtraHeaders(token, activeMeta);
          } catch {
            // Keep loaded metadata if header auto-append is skipped
          }
        }

        setSheetMeta(activeMeta);
        setSheetRecords(loaded.records);
        setExistingIds(loaded.existingIds);
        setExistingDuplicateKeys(loaded.existingDuplicateKeys);
        if (expenseRes) {
          setExpenseRecords(expenseRes.records);
        }
        const combinedBank: BankLedgerLookupRecord[] = [];
        if (pujaBankRes) {
          for (const tx of pujaBankRes.transactions) {
            combinedBank.push({ ...tx, accountTab: 'Puja' });
          }
        }
        if (regularBankRes) {
          for (const tx of regularBankRes.transactions) {
            combinedBank.push({ ...tx, accountTab: 'Regular' });
          }
        }
        if (pujaBankRes || regularBankRes) {
          setBankRecords(combinedBank);
        }
        setHasLoadedSheet(true);
      } catch (err) {
        if (err instanceof SheetsApiError && err.status === 401) {
          clearCachedToken();
          onAuthExpired();
          setErrorMessage(
            'Google session expired. Please sign in again to refresh Amazon_Ledger.'
          );
        } else {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : 'Failed to load Amazon_Ledger from Google Sheets.'
          );
        }
      } finally {
        setIsLoadingSheet(false);
        isFetchingRef.current = false;
      }
    },
    [loadAmazonLookupCategories, onAuthExpired]
  );

  useEffect(() => {
    if (!needsAuth && !hasLoadedSheet) {
      void loadAmazonLedger();
    }
  }, [needsAuth, hasLoadedSheet, loadAmazonLedger]);

  const amazonExpenseCategoryOptions = useMemo(() => {
    if (amazonLookupCategories.expenseCategories.length > 0) {
      return amazonLookupCategories.expenseCategories;
    }
    if (bankLookupCategories.expenseCategories.length > 0) {
      return bankLookupCategories.expenseCategories;
    }
    return expenseFallbackCategories;
  }, [
    amazonLookupCategories.expenseCategories,
    bankLookupCategories.expenseCategories,
    expenseFallbackCategories,
  ]);

  const categorizeContextRef = useRef<{
    expenseCategories: string[];
    existingRecords: AmazonOrderRecord[];
  }>({
    expenseCategories: [],
    existingRecords: [],
  });

  useEffect(() => {
    categorizeContextRef.current = {
      expenseCategories: amazonExpenseCategoryOptions,
      existingRecords: sheetRecords,
    };
  }, [amazonExpenseCategoryOptions, sheetRecords]);

  const scanSingleFile = useCallback(async (fileId: string, file: File) => {
    try {
      const base64Data = await readFileAsBase64(file);
      const mimeType = inferMimeType(file);
      const resp = await fetch('/api/amazon/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName: file.name,
          mimeType,
          base64Data,
        }),
      });

      const payload = (await resp.json().catch(() => ({}))) as {
        items?: RawExtractedAmazonItem[];
        error?: string;
      };

      if (!resp.ok) {
        throw new Error(payload.error || `Scan failed (${resp.status})`);
      }

      const extractedItems = Array.isArray(payload.items) ? payload.items : [];

      let categorizedItems = extractedItems;
      const ctx = categorizeContextRef.current;
      if (extractedItems.length > 0 && ctx.expenseCategories.length > 0) {
        try {
          const suggestions = await categorizeAmazonHybrid({
            items: extractedItems.map((it, idx) => ({
              id: `scan-${fileId}-${idx}`,
              itemDescription: it.itemDescription ?? '',
              total: it.total ?? it.itemPrice ?? null,
              shippedTo: it.shippedTo ?? '',
            })),
            expenseCategories: ctx.expenseCategories,
            existingRecords: ctx.existingRecords,
          });
          categorizedItems = extractedItems.map((it, idx) => {
            const match = suggestions.get(`scan-${fileId}-${idx}`);
            return match?.category ? { ...it, category: match.category } : it;
          });
        } catch {
          // Preserve extracted order items even if AI categorization endpoint fails transiently
        }
      }

      setUploadedFiles((prev) =>
        prev.map((item) =>
          item.id === fileId
            ? {
                ...item,
                status: 'ready',
                errorMessage:
                  categorizedItems.length === 0
                    ? 'No Amazon order items detected in this file.'
                    : undefined,
                extractedItems: categorizedItems,
              }
            : item
        )
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to extract order data from file.';
      setUploadedFiles((prev) =>
        prev.map((item) =>
          item.id === fileId
            ? {
                ...item,
                status: 'error',
                errorMessage: msg,
                extractedItems: [],
              }
            : item
        )
      );
    }
  }, []);

  const handleFilesSelected = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;

      const rejected = incoming.filter((f) => !isSupportedAmazonFile(f));
      const accepted = incoming.filter((f) => isSupportedAmazonFile(f));

      if (rejected.length > 0) {
        setErrorMessage(
          `Unsupported file(s) skipped: ${rejected
            .map((f) => f.name)
            .join(', ')}. Upload Amazon order summary images (PNG, JPG, WEBP) or invoice PDFs.`
        );
      } else {
        setErrorMessage(null);
      }

      if (accepted.length === 0) return;
      setStatusMessage(null);

      const newEntries: Array<{ entry: UploadedAmazonFile; file: File }> = accepted.map(
        (file) => {
          const id = `amzfile-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          rawFileMapRef.current[id] = file;
          return {
            file,
            entry: {
              id,
              fileName: file.name,
              mimeType: inferMimeType(file),
              fileSize: file.size,
              status: 'scanning',
              extractedItems: [],
            },
          };
        }
      );

      setUploadedFiles((prev) => [...prev, ...newEntries.map((n) => n.entry)]);

      await Promise.all(
        newEntries.map(({ entry, file }) => scanSingleFile(entry.id, file))
      );
    },
    [scanSingleFile]
  );

  const handleRetryFile = async (fileId: string) => {
    const file = rawFileMapRef.current[fileId];
    if (!file) {
      setErrorMessage('Original file reference is no longer in memory. Please re-upload it.');
      return;
    }
    setUploadedFiles((prev) =>
      prev.map((item) =>
        item.id === fileId
          ? { ...item, status: 'scanning', errorMessage: undefined, extractedItems: [] }
          : item
      )
    );
    await scanSingleFile(fileId, file);
  };

  const handleRemoveFile = (fileId: string) => {
    delete rawFileMapRef.current[fileId];
    setUploadedFiles((prev) => prev.filter((item) => item.id !== fileId));
    setStagedOverrides((prev) => {
      const next: Record<string, Partial<AmazonOrderRecord>> = {};
      for (const [key, val] of Object.entries(prev)) {
        if (!key.startsWith(`scan-${fileId}-`)) {
          next[key] = val;
        }
      }
      return next;
    });
  };

  const handleClearQueue = () => {
    rawFileMapRef.current = {};
    setUploadedFiles([]);
    setStagedOverrides({});
    setStatusMessage(null);
  };

  // Run deduplication over uploaded scans + sheet IDs/keys
  const scanPipeline = useMemo(
    () =>
      processScannedAmazonFiles(
        uploadedFiles,
        existingIds,
        existingDuplicateKeys,
        stagedOverrides
      ),
    [uploadedFiles, existingIds, existingDuplicateKeys, stagedOverrides]
  );

  const scanningCount = useMemo(
    () => uploadedFiles.filter((f) => f.status === 'scanning').length,
    [uploadedFiles]
  );

  const combinedRecords = useMemo<AmazonOrderRecord[]>(() => {
    return [
      ...scanPipeline.readyOrders,
      ...scanPipeline.duplicateOrders,
      ...sheetRecords,
    ];
  }, [scanPipeline.readyOrders, scanPipeline.duplicateOrders, sheetRecords]);

  // Date bounds & Time Period filter helpers
  const dateBounds = useMemo(() => {
    let minDate = '';
    let maxDate = '';
    const monthSet = new Set<string>();

    for (const rec of combinedRecords) {
      if (!rec.orderDate || !/^\d{4}-\d{2}-\d{2}$/.test(rec.orderDate)) continue;
      if (!minDate || rec.orderDate < minDate) minDate = rec.orderDate;
      if (!maxDate || rec.orderDate > maxDate) maxDate = rec.orderDate;
      monthSet.add(rec.orderDate.slice(0, 7));
    }

    const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
    return { minDate, maxDate, months };
  }, [combinedRecords]);

  const activeMonthKey = useMemo(() => {
    if (!startDate && !endDate) return 'all';
    if (startDate && endDate && startDate.slice(0, 7) === endDate.slice(0, 7)) {
      const ym = startDate.slice(0, 7);
      const [y, m] = ym.split('-').map(Number);
      if (y && m) {
        const lastDay = String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
        if (startDate === `${ym}-01` && endDate === `${ym}-${lastDay}`) {
          return ym;
        }
      }
    }
    return 'custom';
  }, [startDate, endDate]);

  const periodLabel = useMemo(() => {
    if (!startDate && !endDate) return 'All dates';
    if (startDate && endDate) return `${startDate} to ${endDate}`;
    if (startDate) return `From ${startDate}`;
    return `Through ${endDate}`;
  }, [startDate, endDate]);

  const handleSelectMonth = (ym: string) => {
    if (!ym || ym === 'all') {
      setStartDate('');
      setEndDate('');
      return;
    }
    const [y, m] = ym.split('-').map(Number);
    const lastDay = String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
    setStartDate(`${ym}-01`);
    setEndDate(`${ym}-${lastDay}`);
  };

  const formatMonthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, 1));
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  };

  const uncategorizedSheetOrders = useMemo(
    () =>
      sheetRecords.filter(
        (rec) => Boolean(rec.sheetRowNumber) && !(rec.category ?? '').trim()
      ),
    [sheetRecords]
  );

  const availableAmazonCategories = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [
      ...amazonExpenseCategoryOptions,
      ...combinedRecords.map((r) => r.category ?? ''),
    ]) {
      const trimmed = c.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [amazonExpenseCategoryOptions, combinedRecords]);

  const availablePaymentMethods = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of combinedRecords) {
      const trimmed = (r.paymentMethod ?? '').trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [combinedRecords]);

  const expenseByIdMap = useMemo(() => {
    const map = new Map<string, ExpenseRecord>();
    for (const exp of expenseRecords) {
      const id = exp.expId.trim();
      if (id) map.set(id, exp);
    }
    return map;
  }, [expenseRecords]);

  const bankByIdMap = useMemo(() => {
    const map = new Map<string, BankLedgerLookupRecord>();
    for (const tx of bankRecords) {
      const id = tx.uniqueId.trim();
      if (id) map.set(id, tx);
    }
    return map;
  }, [bankRecords]);

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const queryAmountCents = parseExactAmountQueryCents(searchQuery);

    const filtered = combinedRecords.filter((rec) => {
      if (originFilter === 'sheet' && rec.sourceOrigin !== 'sheet') return false;
      if (originFilter === 'ready' && (rec.sourceOrigin !== 'scan' || rec.isDuplicate))
        return false;
      if (originFilter === 'duplicates' && !rec.isDuplicate) return false;

      if (statusFilter === 'blank') {
        if (rec.status !== '') return false;
      } else if (statusFilter !== 'all' && rec.status !== statusFilter) {
        return false;
      }

      if (reconFilter === 'unrecon' && rec.isRecon !== 'No') return false;
      if (reconFilter === 'recon' && rec.isRecon !== 'Yes') return false;

      if (categoryFilter === '__uncategorized__') {
        if ((rec.category ?? '').trim() !== '') return false;
      } else if (
        categoryFilter !== 'all' &&
        (rec.category ?? '').trim().toLowerCase() !== categoryFilter.toLowerCase()
      ) {
        return false;
      }

      if (paymentMethodFilter === '__blank__') {
        if ((rec.paymentMethod ?? '').trim() !== '') return false;
      } else if (
        paymentMethodFilter !== 'all' &&
        (rec.paymentMethod ?? '').trim().toLowerCase() !== paymentMethodFilter.toLowerCase()
      ) {
        return false;
      }

      if (startDate && (!rec.orderDate || rec.orderDate < startDate)) return false;
      if (endDate && (!rec.orderDate || rec.orderDate > endDate)) return false;

      if (q) {
        const matchesExactAmount =
          queryAmountCents !== null &&
          ((rec.itemPrice !== null && toCents(rec.itemPrice) === queryAmountCents) ||
            (rec.total !== null && toCents(rec.total) === queryAmountCents));
        if (!matchesExactAmount) {
          const hay = `${rec.uniqueId} ${rec.orderNumber} ${rec.itemDescription} ${rec.shippedTo} ${rec.paymentMethod} ${rec.status} ${rec.category ?? ''} ${rec.expId ?? ''} ${rec.bankId ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortField === 'orderNumber') {
        const ordA = a.orderNumber.trim();
        const ordB = b.orderNumber.trim();
        if (!ordA && ordB) return 1;
        if (ordA && !ordB) return -1;
        if (ordA !== ordB) {
          const cmp = ordA.localeCompare(ordB, undefined, {
            numeric: true,
            sensitivity: 'base',
          });
          if (cmp !== 0) {
            return sortOrder === 'asc' ? cmp : -cmp;
          }
        }
        return b.orderDate.localeCompare(a.orderDate);
      }

      if (a.orderDate !== b.orderDate) {
        if (!a.orderDate) return 1;
        if (!b.orderDate) return -1;
        return sortOrder === 'desc'
          ? b.orderDate.localeCompare(a.orderDate)
          : a.orderDate.localeCompare(b.orderDate);
      }
      return b.uniqueId.localeCompare(a.uniqueId);
    });
  }, [
    combinedRecords,
    originFilter,
    statusFilter,
    reconFilter,
    categoryFilter,
    paymentMethodFilter,
    startDate,
    endDate,
    searchQuery,
    sortField,
    sortOrder,
  ]);

  const legacySheetUpdates = useMemo(() => {
    const updates: Array<{ sheetRowNumber: number; uniqueId: string }> = [];
    for (const rec of sheetRecords) {
      if (!rec.sheetRowNumber) continue;
      if (!isValid12DigitAmazonUniqueId(rec.uniqueId)) {
        const hashedId = buildAmazonUniqueId({
          orderNumber: rec.orderNumber,
          orderDate: rec.orderDate,
          quantity: rec.quantity,
          itemDescription: rec.itemDescription,
          itemPrice: rec.itemPrice,
        });
        if (hashedId !== rec.uniqueId) {
          updates.push({ sheetRowNumber: rec.sheetRowNumber, uniqueId: hashedId });
        }
      }
    }
    return updates;
  }, [sheetRecords]);

  const handleToggleSort = (field: AmazonSortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortOrder(field === 'orderNumber' ? 'asc' : 'desc');
    }
  };

  // Metrics excluding skipped duplicate copies
  const kpiMetrics = useMemo(() => {
    let totalSpendCents = 0;
    let activeCount = 0;
    let unreconCount = 0;
    let deliveredCount = 0;
    let orderedCount = 0;
    let cancelledReturnedCount = 0;
    let uncategorizedCount = 0;
    const distinctOrders = new Set<string>();

    for (const rec of filteredRecords) {
      if (rec.isDuplicate) continue;
      activeCount++;
      if (rec.orderNumber.trim()) {
        distinctOrders.add(rec.orderNumber.trim().toUpperCase());
      }
      const lineValue =
        rec.total !== null
          ? rec.total
          : rec.itemPrice !== null
            ? rec.itemPrice * (rec.quantity ?? 1)
            : 0;
      totalSpendCents += toCents(lineValue);

      if (rec.isRecon === 'No') unreconCount++;
      if (rec.status === 'Delivered') deliveredCount++;
      else if (rec.status === 'Ordered') orderedCount++;
      else if (rec.status === 'Cancelled' || rec.status === 'Returned') {
        cancelledReturnedCount++;
      }
      if (!(rec.category ?? '').trim()) uncategorizedCount++;
    }

    return {
      activeCount,
      distinctOrderCount: distinctOrders.size,
      totalSpend: totalSpendCents / 100,
      unreconCount,
      deliveredCount,
      orderedCount,
      cancelledReturnedCount,
      uncategorizedCount,
    };
  }, [filteredRecords]);

  const handleOpenSyncConfirmation = async () => {
    if (scanPipeline.readyOrders.length === 0) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsPreparingSync(true);
    setErrorMessage(null);
    try {
      const { plan, workspace } = await prepareAmazonSyncPlan(
        token,
        AMAZON_SPREADSHEET_ID,
        scanPipeline.readyOrders
      );
      setSheetMeta(workspace.meta);
      setSheetRecords(workspace.records);
      setExistingIds(workspace.existingIds);
      setExistingDuplicateKeys(workspace.existingDuplicateKeys);
      setHasLoadedSheet(true);
      setClearQueueAfterSync(true);
      setPendingSyncPlan(plan);
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to prepare Amazon_Ledger sync.'
        );
      }
    } finally {
      setIsPreparingSync(false);
    }
  };

  const handleConfirmSync = async () => {
    if (!pendingSyncPlan) return;
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsSyncing(true);
    setErrorMessage(null);
    try {
      const result = await executeAmazonSyncPlan(token, pendingSyncPlan);
      setPendingSyncPlan(null);
      if (clearQueueAfterSync) {
        rawFileMapRef.current = {};
        setUploadedFiles([]);
        setStagedOverrides({});
      }
      await loadAmazonLedger(token);
      setStatusMessage(
        `Recorded ${result.appendedCount} new ${
          result.appendedCount === 1 ? 'order item' : 'order items'
        } to ${result.tabName}${
          result.skippedCount > 0
            ? ` (${result.skippedCount} duplicate ${
                result.skippedCount === 1 ? 'item' : 'items'
              } skipped)`
            : ''
        }.`
      );
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to write orders to Amazon_Ledger.'
        );
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveEntryModal = async (
    nextRecord: AmazonOrderRecord,
    original: AmazonOrderRecord | null
  ) => {
    setErrorMessage(null);

    // Editing an already-saved Google Sheet row
    if (entryModalState.mode === 'edit' && original?.sourceOrigin === 'sheet') {
      if (!sheetMeta) {
        setErrorMessage('Amazon_Ledger sheet metadata is not loaded yet.');
        return;
      }
      const token = await getAccessToken();
      if (!token) {
        onAuthExpired();
        return;
      }

      setIsSavingModal(true);
      try {
        await updateAmazonRecord(token, sheetMeta, nextRecord);
        setEntryModalState({ isOpen: false, mode: 'create', record: null });
        await loadAmazonLedger(token);
        setStatusMessage(`Updated order ${nextRecord.uniqueId} in Amazon_Ledger.`);
      } catch (err) {
        if (err instanceof SheetsApiError && err.status === 401) {
          clearCachedToken();
          onAuthExpired();
          setErrorMessage('Google session expired. Please sign in again.');
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to update order in Google Sheets.'
          );
        }
      } finally {
        setIsSavingModal(false);
      }
      return;
    }

    // Editing a staged order from an uploaded image/PDF
    if (entryModalState.mode === 'edit' && original) {
      setStagedOverrides((prev) => ({
        ...prev,
        [original.rowKey]: {
          orderNumber: nextRecord.orderNumber,
          orderDate: nextRecord.orderDate,
          quantity: nextRecord.quantity,
          itemDescription: nextRecord.itemDescription,
          itemPrice: nextRecord.itemPrice,
          total: nextRecord.total,
          shippedTo: nextRecord.shippedTo,
          paymentMethod: nextRecord.paymentMethod,
          status: nextRecord.status,
          isRecon: nextRecord.isRecon,
          category: nextRecord.category ?? '',
          expId: nextRecord.expId ?? '',
          bankId: nextRecord.bankId ?? '',
        },
      }));
      setEntryModalState({ isOpen: false, mode: 'create', record: null });
      setStatusMessage(`Updated staged order ${nextRecord.uniqueId}.`);
      return;
    }

    // Creating a manual order -> prepare sync plan and ask confirmation before recording
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsSavingModal(true);
    try {
      const { plan, workspace } = await prepareAmazonSyncPlan(
        token,
        AMAZON_SPREADSHEET_ID,
        [nextRecord]
      );
      setSheetMeta(workspace.meta);
      setSheetRecords(workspace.records);
      setExistingIds(workspace.existingIds);
      setExistingDuplicateKeys(workspace.existingDuplicateKeys);
      setHasLoadedSheet(true);
      setEntryModalState({ isOpen: false, mode: 'create', record: null });
      setClearQueueAfterSync(false);
      setPendingSyncPlan(plan);
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to prepare order for Amazon_Ledger.'
        );
      }
    } finally {
      setIsSavingModal(false);
    }
  };

  const handleReplaceLegacyUniqueIds = async () => {
    if (!sheetMeta || legacySheetUpdates.length === 0) return;
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsMigratingIds(true);
    setErrorMessage(null);
    try {
      const count = await batchUpdateAmazonUniqueIds(
        token,
        sheetMeta,
        legacySheetUpdates
      );
      await loadAmazonLedger(token);
      setStatusMessage(
        `Replaced ${count} legacy Column A Unique ${
          count === 1 ? 'ID' : 'IDs'
        } with deterministic 12-digit hash numbers.`
      );
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to update Column A Unique IDs.'
        );
      }
    } finally {
      setIsMigratingIds(false);
    }
  };

  const handleUpdateIsRecon = async (rec: AmazonOrderRecord, nextIsRecon: 'Yes' | 'No') => {
    if (rec.isRecon === nextIsRecon) return;

    if (rec.sourceOrigin === 'scan') {
      setStagedOverrides((prev) => ({
        ...prev,
        [rec.rowKey]: {
          ...prev[rec.rowKey],
          isRecon: nextIsRecon,
        },
      }));
      return;
    }

    if (!sheetMeta || !rec.sheetRowNumber) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setUpdatingReconKey(rec.rowKey);
    setErrorMessage(null);
    try {
      await updateAmazonIsRecon(token, sheetMeta, rec.sheetRowNumber, nextIsRecon);
      setSheetRecords((prev) =>
        prev.map((item) =>
          item.rowKey === rec.rowKey ? { ...item, isRecon: nextIsRecon } : item
        )
      );
      setStatusMessage(`Updated Is_Recon for ${rec.uniqueId} to "${nextIsRecon}".`);
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to update Is_Recon in Amazon_Ledger.'
        );
      }
    } finally {
      setUpdatingReconKey(null);
    }
  };

  const handleUpdateCategory = async (rec: AmazonOrderRecord, nextCategory: string) => {
    const trimmed = nextCategory.trim();
    if ((rec.category ?? '').trim() === trimmed) return;

    if (rec.sourceOrigin === 'scan') {
      setStagedOverrides((prev) => ({
        ...prev,
        [rec.rowKey]: {
          ...prev[rec.rowKey],
          category: trimmed,
        },
      }));
      return;
    }

    if (!sheetMeta || !rec.sheetRowNumber) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    const prevRecords = sheetRecords;
    setUpdatingCategoryKey(rec.rowKey);
    setErrorMessage(null);
    setSheetRecords((prev) =>
      prev.map((item) =>
        item.rowKey === rec.rowKey ? { ...item, category: trimmed } : item
      )
    );

    try {
      await updateAmazonCategory(token, sheetMeta, rec.sheetRowNumber, trimmed);
      setSheetMeta((prev) =>
        prev
          ? {
              ...prev,
              hasIsReconHeader: true,
              hasCategoryHeader: true,
            }
          : prev
      );
      setStatusMessage(
        trimmed
          ? `Updated Category for ${rec.uniqueId} to "${trimmed}".`
          : `Cleared Category for ${rec.uniqueId}.`
      );
    } catch (err) {
      setSheetRecords(prevRecords);
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to update Category in Amazon_Ledger.'
        );
      }
    } finally {
      setUpdatingCategoryKey(null);
    }
  };

  const handleRunAutoCategorizeUncategorized = async () => {
    if (uncategorizedSheetOrders.length === 0) return;
    if (amazonExpenseCategoryOptions.length === 0) {
      setErrorMessage(
        'No Expense categories were found in the LookUp tab. Please refresh Amazon_Ledger first.'
      );
      return;
    }

    setIsAutoCategorizing(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const suggestions = await categorizeAmazonHybrid({
        items: uncategorizedSheetOrders.map((rec) => ({
          id: rec.rowKey,
          itemDescription: rec.itemDescription,
          total: rec.total ?? rec.itemPrice ?? null,
          shippedTo: rec.shippedTo,
        })),
        expenseCategories: amazonExpenseCategoryOptions,
        existingRecords: sheetRecords,
      });

      const items: AmazonCategorizeReviewItem[] = uncategorizedSheetOrders.map((record) => ({
        record,
        suggestion: suggestions.get(record.rowKey) ?? {
          id: record.rowKey,
          category: '',
          confidence: 'low',
          method: 'abstained',
          reason: 'Abstained: insufficient information.',
        },
      }));

      setCategorizeReviewState({ isOpen: true, items });
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Failed to auto-categorize uncategorized Amazon orders.'
      );
    } finally {
      setIsAutoCategorizing(false);
    }
  };

  const handleApplyAutoCategories = async (
    updates: Array<{ sheetRowNumber: number; category: string }>
  ) => {
    if (!sheetMeta || updates.length === 0) return;
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsApplyingBatchCategories(true);
    setErrorMessage(null);
    try {
      const count = await batchUpdateAmazonCategories(token, sheetMeta, updates);
      setCategorizeReviewState({ isOpen: false, items: [] });
      await loadAmazonLedger(token);
      setStatusMessage(
        `Assigned Category for ${count} ${count === 1 ? 'order' : 'orders'} in Amazon_Ledger.`
      );
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to save assigned categories to Amazon_Ledger.'
        );
      }
    } finally {
      setIsApplyingBatchCategories(false);
    }
  };

  const handleAutoReconWithExpenses = async () => {
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsAutoReconExpenses(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const [amazonWorkspace, expenseWorkspace] = await Promise.all([
        fetchAmazonLedger(token, AMAZON_SPREADSHEET_ID),
        fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID),
      ]);

      let activeMeta = amazonWorkspace.meta;
      if (
        activeMeta.ledgerTabExists &&
        !activeMeta.needsHeader &&
        (!activeMeta.hasIsReconHeader ||
          !activeMeta.hasCategoryHeader ||
          !activeMeta.hasExpIdHeader ||
          !activeMeta.hasBankIdHeader)
      ) {
        activeMeta = await ensureAmazonExtraHeaders(token, activeMeta);
      }

      const plan = matchAmazonOrdersWithExpenses(
        amazonWorkspace.records,
        expenseWorkspace.records
      );

      if (plan.rowUpdates.length === 0) {
        setSheetMeta(activeMeta);
        setSheetRecords(amazonWorkspace.records);
        setExistingIds(amazonWorkspace.existingIds);
        setExistingDuplicateKeys(amazonWorkspace.existingDuplicateKeys);
        setExpenseRecords(expenseWorkspace.records);
        setHasLoadedSheet(true);

        if (plan.eligibleExpenseCount === 0) {
          setStatusMessage(
            'No Expense Ledger records with "Amazon" in Notes were found to reconcile.'
          );
        } else if (plan.eligibleOrderCount === 0 && plan.alreadyMatchedOrderCount > 0) {
          setStatusMessage(
            `All ${plan.alreadyMatchedOrderCount} Amazon Order ${
              plan.alreadyMatchedOrderCount === 1 ? 'ID already has' : 'IDs already have'
            } Exp_ID assigned.`
          );
        } else {
          setStatusMessage(
            `No new Amazon Order ID amount matches found across ${plan.eligibleExpenseCount} Expense ${
              plan.eligibleExpenseCount === 1 ? 'record' : 'records'
            } with "Amazon" in Notes.`
          );
        }
        return;
      }

      const updatedRowsCount = await batchUpdateAmazonExpIds(
        token,
        activeMeta,
        plan.rowUpdates.map((u) => ({
          sheetRowNumber: u.sheetRowNumber,
          expId: u.expId,
        }))
      );

      await loadAmazonLedger(token);
      setStatusMessage(
        `Matched ${plan.matchedOrders.length} Amazon Order ${
          plan.matchedOrders.length === 1 ? 'ID' : 'IDs'
        } and updated Exp_ID on ${updatedRowsCount} ${
          updatedRowsCount === 1 ? 'record' : 'records'
        } in Amazon_Ledger.`
      );
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to auto-reconcile Amazon orders with Expense Ledger.'
        );
      }
    } finally {
      setIsAutoReconExpenses(false);
    }
  };

  const handleAutoReconWithBank = async () => {
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsAutoReconBank(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const [amazonWorkspace, pujaBankRes, regularBankRes] = await Promise.all([
        fetchAmazonLedger(token, AMAZON_SPREADSHEET_ID),
        fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Puja'),
        fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Regular'),
      ]);

      const combinedBank: BankLedgerLookupRecord[] = [
        ...pujaBankRes.transactions.map((tx) => ({ ...tx, accountTab: 'Puja' as const })),
        ...regularBankRes.transactions.map((tx) => ({ ...tx, accountTab: 'Regular' as const })),
      ];

      let activeMeta = amazonWorkspace.meta;
      if (
        activeMeta.ledgerTabExists &&
        !activeMeta.needsHeader &&
        (!activeMeta.hasIsReconHeader ||
          !activeMeta.hasCategoryHeader ||
          !activeMeta.hasExpIdHeader ||
          !activeMeta.hasBankIdHeader)
      ) {
        activeMeta = await ensureAmazonExtraHeaders(token, activeMeta);
      }

      const plan = matchAmazonOrdersWithBank(amazonWorkspace.records, combinedBank);

      if (plan.rowUpdates.length === 0) {
        setSheetMeta(activeMeta);
        setSheetRecords(amazonWorkspace.records);
        setExistingIds(amazonWorkspace.existingIds);
        setExistingDuplicateKeys(amazonWorkspace.existingDuplicateKeys);
        setBankRecords(combinedBank);
        setHasLoadedSheet(true);

        if (plan.eligibleBankCount === 0) {
          setStatusMessage(
            'No Bank Statement Ledger expense records with "Amazon" in Notes were found to reconcile.'
          );
        } else if (plan.eligibleOrderCount === 0 && plan.alreadyMatchedOrderCount > 0) {
          setStatusMessage(
            `All ${plan.alreadyMatchedOrderCount} Amazon Order ${
              plan.alreadyMatchedOrderCount === 1 ? 'ID already has' : 'IDs already have'
            } Bank_ID and Is_Recon assigned.`
          );
        } else {
          setStatusMessage(
            `No new Amazon Order ID amount matches found across ${plan.eligibleBankCount} Bank Statement expense ${
              plan.eligibleBankCount === 1 ? 'record' : 'records'
            } with "Amazon" in Notes.`
          );
        }
        return;
      }

      const updatedRowsCount = await batchUpdateAmazonBankRecon(
        token,
        activeMeta,
        plan.rowUpdates.map((u) => ({
          sheetRowNumber: u.sheetRowNumber,
          bankId: u.bankId,
          isRecon: u.isRecon,
        }))
      );

      await loadAmazonLedger(token);
      setStatusMessage(
        `Matched ${plan.matchedOrders.length} Amazon Order ${
          plan.matchedOrders.length === 1 ? 'ID' : 'IDs'
        } with Bank Statements and updated Bank_ID & Is_Recon ("Yes") on ${updatedRowsCount} ${
          updatedRowsCount === 1 ? 'record' : 'records'
        } in Amazon_Ledger.`
      );
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to auto-reconcile Amazon orders with Bank Statements.'
        );
      }
    } finally {
      setIsAutoReconBank(false);
    }
  };

  const removeScannedItemsByRowKeys = useCallback(
    (rowKeysToRemove: Set<string>) => {
      if (rowKeysToRemove.size === 0) return;

      const keyRemap = new Map<string, string>();
      const removedFileIds = new Set<string>();

      setUploadedFiles((prev) => {
        const nextFiles: UploadedAmazonFile[] = [];
        for (const file of prev) {
          if (file.status !== 'ready') {
            nextFiles.push(file);
            continue;
          }
          const keptItems: RawExtractedAmazonItem[] = [];
          file.extractedItems.forEach((item, oldIdx) => {
            const oldKey = `scan-${file.id}-${oldIdx}`;
            if (!rowKeysToRemove.has(oldKey)) {
              const newIdx = keptItems.length;
              keyRemap.set(oldKey, `scan-${file.id}-${newIdx}`);
              keptItems.push(item);
            }
          });
          if (keptItems.length === 0) {
            removedFileIds.add(file.id);
          } else {
            nextFiles.push({
              ...file,
              extractedItems: keptItems,
            });
          }
        }
        return nextFiles;
      });

      for (const fileId of removedFileIds) {
        delete rawFileMapRef.current[fileId];
      }

      setStagedOverrides((prev) => {
        const next: Record<string, Partial<AmazonOrderRecord>> = {};
        for (const [oldKey, ov] of Object.entries(prev)) {
          if (rowKeysToRemove.has(oldKey)) continue;
          const mappedKey = keyRemap.get(oldKey) ?? oldKey;
          next[mappedKey] = ov;
        }
        return next;
      });
    },
    []
  );

  const handleRequestDeleteSingle = (rec: AmazonOrderRecord) => {
    setDeleteConfirmState({
      isOpen: true,
      mode: 'single',
      records: [rec],
    });
  };

  const handleRequestDeleteAll = () => {
    if (filteredRecords.length === 0) return;
    setDeleteConfirmState({
      isOpen: true,
      mode: 'all',
      records: filteredRecords,
    });
  };

  const handleConfirmDelete = async () => {
    const targets = deleteConfirmState.records;
    if (targets.length === 0) return;

    const sheetRowNumbers = targets
      .filter((r) => r.sourceOrigin === 'sheet' && Boolean(r.sheetRowNumber))
      .map((r) => r.sheetRowNumber as number);
    const scanRowKeys = new Set(
      targets.filter((r) => r.sourceOrigin === 'scan').map((r) => r.rowKey)
    );

    setErrorMessage(null);
    setStatusMessage(null);
    setIsDeletingRecords(true);

    try {
      let deletedSheetCount = 0;
      let activeToken: string | null = null;

      if (sheetRowNumbers.length > 0) {
        if (!sheetMeta) {
          throw new Error('Amazon_Ledger sheet metadata is not loaded yet.');
        }
        activeToken = await getAccessToken();
        if (!activeToken) {
          onAuthExpired();
          setIsDeletingRecords(false);
          return;
        }
        deletedSheetCount = await deleteAmazonRows(activeToken, sheetMeta, sheetRowNumbers);
      }

      if (scanRowKeys.size > 0) {
        removeScannedItemsByRowKeys(scanRowKeys);
      }

      setDeleteConfirmState({ isOpen: false, mode: 'single', records: [] });

      if (deletedSheetCount > 0 && activeToken) {
        await loadAmazonLedger(activeToken);
      }

      if (deletedSheetCount > 0 && scanRowKeys.size > 0) {
        setStatusMessage(
          `Deleted ${deletedSheetCount} ${
            deletedSheetCount === 1 ? 'record' : 'records'
          } from Amazon_Ledger and removed ${scanRowKeys.size} scanned ${
            scanRowKeys.size === 1 ? 'item' : 'items'
          }.`
        );
      } else if (deletedSheetCount > 0) {
        setStatusMessage(
          `Deleted ${deletedSheetCount} ${
            deletedSheetCount === 1 ? 'record' : 'records'
          } from Amazon_Ledger.`
        );
      } else if (scanRowKeys.size > 0) {
        setStatusMessage(
          `Removed ${scanRowKeys.size} scanned ${
            scanRowKeys.size === 1 ? 'item' : 'items'
          } from the scan queue.`
        );
      }
    } catch (err) {
      if (err instanceof SheetsApiError && err.status === 401) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to delete record(s) from Amazon_Ledger.'
        );
      }
    } finally {
      setIsDeletingRecords(false);
    }
  };

  const handleExportCsv = () => {
    const exportRows = filteredRecords.filter((r) => !r.isDuplicate);
    if (exportRows.length === 0) return;

    const headerLine = [...CANONICAL_AMAZON_HEADERS, 'Source Origin'].map(csvCell).join(',');
    const bodyLines = exportRows.map((rec) =>
      [
        rec.uniqueId,
        rec.orderNumber,
        rec.orderDate,
        rec.quantity !== null ? rec.quantity : '',
        rec.itemDescription,
        rec.itemPrice !== null ? rec.itemPrice.toFixed(2) : '',
        rec.total !== null ? rec.total.toFixed(2) : '',
        rec.shippedTo,
        rec.paymentMethod,
        rec.status,
        rec.isRecon,
        rec.category ?? '',
        rec.expId ?? '',
        rec.bankId ?? '',
        rec.sourceOrigin === 'sheet' ? 'Amazon_Ledger' : rec.sourceFileName || 'Scanned',
      ]
        .map(csvCell)
        .join(',')
    );

    const csv = [headerLine, ...bodyLines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `amazon-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const resetFilters = () => {
    setOriginFilter('all');
    setStatusFilter('all');
    setReconFilter('all');
    setCategoryFilter('all');
    setPaymentMethodFilter('all');
    setSearchQuery('');
    setStartDate('');
    setEndDate('');
  };

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full shrink-0 border-b border-slate-200 bg-white p-5 lg:w-[295px] lg:border-r lg:border-b-0">
        <div className="space-y-6">
          {/* 01. Amazon_Ledger Target */}
          <section>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold tracking-tight text-slate-900">
                01. Amazon_Ledger Sheet
              </h2>
              <a
                href={`https://docs.google.com/spreadsheets/d/${AMAZON_SPREADSHEET_ID}/edit`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open Amazon_Ledger spreadsheet in Google Sheets"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:underline"
              >
                Open Sheet
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {sheetMeta
                ? `${sheetMeta.spreadsheetTitle} · Tab "${sheetMeta.ledgerTabName}"`
                : 'Amazon_Ledger · Tab "AmzOrders"'}
            </p>
            <button
              type="button"
              onClick={() => void loadAmazonLedger()}
              disabled={isLoadingSheet || needsAuth}
              title="Reload saved orders and LookUp expense categories from Amazon_Ledger"
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoadingSheet ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {isLoadingSheet ? 'Refreshing Amazon_Ledger...' : 'Refresh Amazon_Ledger'}
            </button>
          </section>

          {/* 02. Upload Order Images or Invoice PDFs */}
          <section>
            <h2 className="text-xs font-semibold tracking-tight text-slate-900">
              02. Upload Order Images / PDFs
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Amazon order summary images or invoice PDFs (PNG, JPG, WEBP, PDF). Exact duplicate
              items are skipped.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) {
                  void handleFilesSelected(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (e.dataTransfer.files) {
                  void handleFilesSelected(e.dataTransfer.files);
                }
              }}
              title="Upload Amazon order summary images or invoice PDFs to extract line items and auto-categorize"
              className={`mt-3 flex w-full flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center transition-colors ${
                isDragging
                  ? 'border-teal-700 bg-teal-50/70'
                  : 'border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-100/70'
              }`}
            >
              <Upload className="h-5 w-5 text-slate-500" aria-hidden="true" />
              <span className="mt-2 text-xs font-medium text-slate-800">
                Drop order images or PDFs
              </span>
              <span className="mt-0.5 text-[11px] text-slate-500">
                or click to browse summaries &amp; invoices
              </span>
            </button>

            {uploadedFiles.length > 0 && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Scan Queue ({uploadedFiles.length})</span>
                  <button
                    type="button"
                    onClick={handleClearQueue}
                    title="Remove all uploaded files and staged orders from the queue"
                    className="font-medium text-slate-600 hover:text-red-700"
                  >
                    Clear Queue
                  </button>
                </div>

                {uploadedFiles.map((file) => {
                  const isPdf = file.mimeType === 'application/pdf';
                  return (
                    <div
                      key={file.id}
                      className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {isPdf ? (
                            <FileText
                              className="h-3.5 w-3.5 shrink-0 text-slate-500"
                              aria-hidden="true"
                            />
                          ) : (
                            <FileImage
                              className="h-3.5 w-3.5 shrink-0 text-slate-500"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className="truncate font-medium text-slate-800"
                            title={file.fileName}
                          >
                            {file.fileName}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveFile(file.id)}
                          className="rounded p-0.5 text-slate-400 hover:text-red-600"
                          title={`Remove ${file.fileName}`}
                          aria-label={`Remove ${file.fileName}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>

                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        {file.status === 'scanning' ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-teal-700">
                            <ScanLine className="h-3 w-3 animate-pulse" aria-hidden="true" />
                            Extracting order items...
                          </span>
                        ) : file.status === 'error' ? (
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="truncate text-red-700" title={file.errorMessage}>
                              {file.errorMessage || 'Scan failed'}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleRetryFile(file.id)}
                              title={`Re-run order scan for ${file.fileName}`}
                              className="shrink-0 font-medium text-teal-700 hover:underline"
                            >
                              Retry
                            </button>
                          </div>
                        ) : (
                          <span className="font-mono text-slate-600 tabular-nums">
                            {file.extractedItems.length}{' '}
                            {file.extractedItems.length === 1 ? 'item' : 'items'} extracted
                          </span>
                        )}
                      </div>
                      {file.status === 'ready' && file.errorMessage && (
                        <div className="mt-1 text-[11px] text-amber-700">
                          {file.errorMessage}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 03. Extraction & Dedup Summary */}
          <section className="border-t border-slate-200 pt-5">
            <h2 className="text-xs font-semibold tracking-tight text-slate-900">
              03. Scan &amp; Dedup Summary
            </h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <dt>Saved in Amazon_Ledger</dt>
                <dd className="font-mono font-medium text-slate-900 tabular-nums">
                  {sheetRecords.length.toLocaleString()}
                </dd>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <dt>Extracted from uploads</dt>
                <dd className="font-mono font-medium text-slate-900 tabular-nums">
                  {scanPipeline.summary.totalExtracted.toLocaleString()}
                </dd>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <dt>Duplicate items skipped</dt>
                <dd className="font-mono font-medium text-amber-700 tabular-nums">
                  {scanPipeline.summary.duplicateSkipped.toLocaleString()}
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-2 font-semibold text-slate-900">
                <dt>Ready to Record</dt>
                <dd className="font-mono text-teal-800 tabular-nums">
                  {scanPipeline.summary.readyToSync.toLocaleString()}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={() => void handleOpenSyncConfirmation()}
              disabled={
                needsAuth ||
                scanningCount > 0 ||
                scanPipeline.readyOrders.length === 0 ||
                isPreparingSync
              }
              title="Run final duplicate check and append ready scanned order items to AmzOrders"
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3.5 py-2.5 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
              {isPreparingSync
                ? 'Checking Duplicates...'
                : `Record ${scanPipeline.readyOrders.length} to Amazon_Ledger`}
            </button>
          </section>
        </div>
      </aside>

      {/* Main Content */}
      <main className="min-w-0 flex-1 p-5">
        <div className="mx-auto max-w-[1560px] space-y-5">
          {/* Header Row */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-[240px] flex-1">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Amazon Ledger</h1>
              <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Upload Amazon order summaries or invoice PDFs, auto-categorize against LookUp
                expense categories, deduplicate identical items, and sync to{' '}
                <span className="font-medium text-slate-700">Amazon_Ledger</span> (tab{' '}
                <span className="font-mono text-slate-700">AmzOrders</span>).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() =>
                  setEntryModalState({
                    isOpen: true,
                    mode: 'create',
                    record: null,
                  })
                }
                disabled={needsAuth}
                title="Open manual entry form to log an Amazon order item into AmzOrders"
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Order Manually
              </button>

              <button
                type="button"
                onClick={() => void handleRunAutoCategorizeUncategorized()}
                disabled={
                  needsAuth ||
                  isLoadingSheet ||
                  isAutoCategorizing ||
                  isAutoReconExpenses ||
                  isAutoReconBank ||
                  uncategorizedSheetOrders.length === 0
                }
                title="Auto-assign LookUp Expense categories from Item Description for uncategorized AmzOrders rows"
                className="inline-flex items-center gap-1.5 rounded-md border border-teal-300 bg-teal-50/60 px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100/70 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 whitespace-nowrap shrink-0"
              >
                <Sparkles
                  className={`h-3.5 w-3.5 ${isAutoCategorizing ? 'animate-pulse' : ''}`}
                  aria-hidden="true"
                />
                {isAutoCategorizing
                  ? 'Categorizing...'
                  : `Auto-Categorize Uncategorized Orders (${uncategorizedSheetOrders.length})`}
              </button>

              <button
                type="button"
                onClick={() => void handleAutoReconWithExpenses()}
                disabled={
                  needsAuth ||
                  isLoadingSheet ||
                  isAutoReconExpenses ||
                  isAutoReconBank ||
                  isAutoCategorizing ||
                  sheetRecords.length === 0
                }
                title='Match Amazon Order ID totals against Expense Ledger records whose "Notes" contains Amazon and update Exp_ID'
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50/60 px-3.5 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100/70 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 whitespace-nowrap shrink-0"
              >
                <Link2
                  className={`h-3.5 w-3.5 ${isAutoReconExpenses ? 'animate-pulse' : ''}`}
                  aria-hidden="true"
                />
                {isAutoReconExpenses ? 'Reconciling Expenses...' : 'Auto Recon with Expenses'}
              </button>

              <button
                type="button"
                onClick={() => void handleAutoReconWithBank()}
                disabled={
                  needsAuth ||
                  isLoadingSheet ||
                  isAutoReconBank ||
                  isAutoReconExpenses ||
                  isAutoCategorizing ||
                  sheetRecords.length === 0
                }
                title='Match Amazon Order ID totals against Bank Statement Ledger expense records whose "Notes" contains Amazon and update Bank_ID & Is_Recon'
                className="inline-flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50/60 px-3.5 py-2 text-xs font-medium text-indigo-800 hover:bg-indigo-100/70 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 whitespace-nowrap shrink-0"
              >
                <Landmark
                  className={`h-3.5 w-3.5 ${isAutoReconBank ? 'animate-pulse' : ''}`}
                  aria-hidden="true"
                />
                {isAutoReconBank ? 'Reconciling Bank...' : 'Auto Recon with Bank'}
              </button>

              <button
                type="button"
                onClick={handleExportCsv}
                disabled={kpiMetrics.activeCount === 0}
                title="Download the currently filtered active Amazon order items as a CSV file"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Export CSV
              </button>
            </div>
          </div>

          {/* Time Period Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <Calendar className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <span className="font-medium text-slate-800">Time Period</span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <span className="font-mono text-slate-600 tabular-nums">{periodLabel}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleSelectMonth('all')}
                title="Clear date filters and show Amazon orders across all dates"
                className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                  !startDate && !endDate
                    ? 'border-teal-700 bg-teal-50 text-teal-800'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                All Time
              </button>

              {dateBounds.months.length > 0 && (
                <select
                  value={activeMonthKey}
                  onChange={(e) => {
                    if (e.target.value !== 'custom') {
                      handleSelectMonth(e.target.value);
                    }
                  }}
                  aria-label="Select Amazon Order Month Period"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Months</option>
                  {activeMonthKey === 'custom' && (
                    <option value="custom">Custom Range</option>
                  )}
                  {dateBounds.months.map((ym) => (
                    <option key={ym} value={ym}>
                      {formatMonthLabel(ym)}
                    </option>
                  ))}
                </select>
              )}

              <div className="flex items-center gap-1.5">
                <label htmlFor="amz-period-start" className="text-xs text-slate-500">
                  From
                </label>
                <input
                  id="amz-period-start"
                  type="date"
                  value={startDate}
                  min={dateBounds.minDate || undefined}
                  max={endDate || dateBounds.maxDate || undefined}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label htmlFor="amz-period-end" className="text-xs text-slate-500">
                  To
                </label>
                <input
                  id="amz-period-end"
                  type="date"
                  value={endDate}
                  min={startDate || dateBounds.minDate || undefined}
                  max={dateBounds.maxDate || undefined}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
                />
              </div>

              {(startDate || endDate) && (
                <button
                  type="button"
                  onClick={() => handleSelectMonth('all')}
                  title="Reset From and To date filters"
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Status & Error Banners */}
          {statusMessage && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-900">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
                <span>{statusMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setStatusMessage(null)}
                className="text-emerald-700 hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {errorMessage && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                <span>{errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="text-red-700 hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {legacySheetUpdates.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <span>
                  <strong>{legacySheetUpdates.length}</strong> existing{' '}
                  {legacySheetUpdates.length === 1
                    ? 'row in Amazon_Ledger lacks'
                    : 'rows in Amazon_Ledger lack'}{' '}
                  a deterministic 12-digit numeric hash ID in Column A.
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleReplaceLegacyUniqueIds()}
                disabled={isMigratingIds || needsAuth}
                title="Update Column A Unique IDs in Amazon_Ledger to deterministic 12-digit hash numbers"
                className="rounded-md bg-amber-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
              >
                {isMigratingIds
                  ? 'Updating Unique IDs...'
                  : `Generate ${legacySheetUpdates.length} 12-Digit Unique IDs`}
              </button>
            </div>
          )}

          {scanPipeline.duplicateOrders.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <span>
                  <strong>{scanPipeline.duplicateOrders.length}</strong> duplicate order{' '}
                  {scanPipeline.duplicateOrders.length === 1 ? 'item was' : 'items were'}{' '}
                  detected (same Order #, Date, Qty, Description &amp; Item Price) and will{' '}
                  <strong>not</strong> be recorded to Amazon_Ledger.
                </span>
              </div>
              <button
                type="button"
                onClick={() =>
                  setOriginFilter((prev) => (prev === 'duplicates' ? 'all' : 'duplicates'))
                }
                title="Filter table to inspect duplicate skipped order items"
                className="font-medium text-amber-900 underline whitespace-nowrap"
              >
                {originFilter === 'duplicates' ? 'Show All' : 'Inspect Skipped'}
              </button>
            </div>
          )}

          {/* KPI Strip */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="text-xs text-slate-500">Active Items (Filtered)</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                  {kpiMetrics.activeCount.toLocaleString()}
                </span>
                <span className="text-[11px] text-slate-500">
                  {kpiMetrics.distinctOrderCount} orders · {kpiMetrics.unreconCount} unrecon
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Total Amazon Spend</span>
                <Package className="h-3.5 w-3.5 text-red-700" aria-hidden="true" />
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-2xl font-bold text-red-700 tabular-nums">
                  {kpiMetrics.totalSpend.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </span>
                <span className="text-[11px] text-slate-500">
                  {scanPipeline.readyOrders.length} staged
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="text-xs text-slate-500">Fulfillment Breakdown</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-2xl font-bold text-emerald-700 tabular-nums">
                  {kpiMetrics.deliveredCount.toLocaleString()}
                </span>
                <span className="text-[11px] text-slate-500">
                  Delivered · {kpiMetrics.orderedCount} Ordered ·{' '}
                  {kpiMetrics.cancelledReturnedCount} Canc/Ret
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="text-xs text-slate-500">Needs Category (Filtered)</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span
                  className={`font-mono text-2xl font-bold tabular-nums ${
                    kpiMetrics.uncategorizedCount > 0 ? 'text-amber-700' : 'text-slate-900'
                  }`}
                >
                  {kpiMetrics.uncategorizedCount.toLocaleString()}
                </span>
                <span className="text-[11px] text-slate-500">
                  {uncategorizedSheetOrders.length} in sheet
                </span>
              </div>
            </div>
          </div>

          {/* Amazon Grid Surface */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            {/* Filter Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              {/* Origin Tabs + Delete All */}
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-1">
                  {(
                    [
                      { id: 'all', label: `All (${combinedRecords.length})` },
                      { id: 'sheet', label: `In Sheet (${sheetRecords.length})` },
                      { id: 'ready', label: `Ready (${scanPipeline.readyOrders.length})` },
                      {
                        id: 'duplicates',
                        label: `Duplicates (${scanPipeline.duplicateOrders.length})`,
                      },
                    ] as Array<{ id: OriginFilter; label: string }>
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setOriginFilter(tab.id)}
                      className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                        originFilter === tab.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleRequestDeleteAll}
                  disabled={filteredRecords.length === 0 || isDeletingRecords}
                  title="Delete all currently listed Amazon order records (requires confirmation)"
                  className="px-1.5 py-1 text-xs font-medium text-red-700 hover:text-red-800 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline whitespace-nowrap"
                >
                  Delete All
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Search */}
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search Order #, Exp_ID, Bank_ID, exact amount..."
                    className="w-44 rounded-md border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                </div>

                {/* Is_Recon Filter */}
                <select
                  value={reconFilter}
                  onChange={(e) => setReconFilter(e.target.value as ReconFilter)}
                  aria-label="Filter by Is_Recon"
                  title="Filter orders by reconciliation status"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Is_Recon</option>
                  <option value="unrecon">Unreconciled (No)</option>
                  <option value="recon">Reconciled (Yes)</option>
                </select>

                {/* Status Filter */}
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  aria-label="Filter by Status"
                  title="Filter orders by fulfillment status"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Statuses</option>
                  <option value="Ordered">Ordered</option>
                  <option value="Delivered">Delivered</option>
                  <option value="Cancelled">Cancelled</option>
                  <option value="Returned">Returned</option>
                  <option value="blank">Blank Status</option>
                </select>

                {/* Payment Method Filter */}
                <select
                  value={paymentMethodFilter}
                  onChange={(e) => setPaymentMethodFilter(e.target.value)}
                  aria-label="Filter by Payment Method"
                  title="Filter orders by Payment Method"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Payment Methods</option>
                  <option value="__blank__">Blank Payment Method</option>
                  {availablePaymentMethods.map((pm) => (
                    <option key={pm} value={pm}>
                      {pm}
                    </option>
                  ))}
                </select>

                {/* Category Filter */}
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by Category"
                  title="Filter orders by Expense Category"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Categories</option>
                  <option value="__uncategorized__">Uncategorized Only</option>
                  {availableAmazonCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                {(originFilter !== 'all' ||
                  statusFilter !== 'all' ||
                  reconFilter !== 'all' ||
                  paymentMethodFilter !== 'all' ||
                  categoryFilter !== 'all' ||
                  searchQuery ||
                  startDate ||
                  endDate) && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    title="Reset all active Amazon filters and search text"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            </div>

            <AmazonGrid
              records={filteredRecords}
              hasUploadedFiles={uploadedFiles.length > 0}
              isLoading={isLoadingSheet}
              needsAuth={needsAuth}
              isLoggingIn={isLoggingIn}
              sortField={sortField}
              sortOrder={sortOrder}
              expenseCategoryOptions={amazonExpenseCategoryOptions}
              expenseByIdMap={expenseByIdMap}
              bankByIdMap={bankByIdMap}
              updatingReconKey={updatingReconKey}
              updatingCategoryKey={updatingCategoryKey}
              isDeletingRecords={isDeletingRecords}
              onSignIn={onSignIn}
              onToggleSort={handleToggleSort}
              onEditRecord={(rec) =>
                setEntryModalState({
                  isOpen: true,
                  mode: 'edit',
                  record: rec,
                })
              }
              onDeleteRecord={handleRequestDeleteSingle}
              onUpdateIsRecon={handleUpdateIsRecon}
              onUpdateCategory={(rec, category) => void handleUpdateCategory(rec, category)}
              onTriggerUpload={() => fileInputRef.current?.click()}
              onOpenManualEntry={() =>
                setEntryModalState({
                  isOpen: true,
                  mode: 'create',
                  record: null,
                })
              }
              onResetFilters={resetFilters}
            />
          </div>
        </div>
      </main>

      {/* Modals */}
      <AmazonEntryModal
        isOpen={entryModalState.isOpen}
        mode={entryModalState.mode}
        record={entryModalState.record}
        expenseCategoryOptions={amazonExpenseCategoryOptions}
        expenseRecords={expenseRecords}
        bankRecords={bankRecords}
        isSaving={isSavingModal}
        onClose={() =>
          !isSavingModal &&
          setEntryModalState({ isOpen: false, mode: 'create', record: null })
        }
        onSave={handleSaveEntryModal}
      />

      <AmazonSyncConfirmModal
        plan={pendingSyncPlan}
        isSyncing={isSyncing}
        onCancel={() => !isSyncing && setPendingSyncPlan(null)}
        onConfirm={() => void handleConfirmSync()}
      />

      <AmazonCategorizeModal
        isOpen={categorizeReviewState.isOpen}
        items={categorizeReviewState.items}
        expenseCategoryOptions={amazonExpenseCategoryOptions}
        isApplying={isApplyingBatchCategories}
        onClose={() =>
          !isApplyingBatchCategories &&
          setCategorizeReviewState({ isOpen: false, items: [] })
        }
        onApply={handleApplyAutoCategories}
      />

      <AmazonDeleteConfirmModal
        isOpen={deleteConfirmState.isOpen}
        mode={deleteConfirmState.mode}
        records={deleteConfirmState.records}
        isFiltered={
          originFilter !== 'all' ||
          statusFilter !== 'all' ||
          reconFilter !== 'all' ||
          paymentMethodFilter !== 'all' ||
          categoryFilter !== 'all' ||
          Boolean(searchQuery) ||
          Boolean(startDate) ||
          Boolean(endDate)
        }
        isDeleting={isDeletingRecords}
        onCancel={() =>
          !isDeletingRecords &&
          setDeleteConfirmState({ isOpen: false, mode: 'single', records: [] })
        }
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
};
