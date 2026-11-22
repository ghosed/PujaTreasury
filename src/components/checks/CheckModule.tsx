import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  Download,
  ExternalLink,
  FileImage,
  FileSpreadsheet,
  FileText,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  CheckRecord,
  CheckSheetMeta,
  CheckSyncPlan,
  RawExtractedCheck,
  UploadedCheckFile,
} from '../../types/check';
import {
  buildCheckUniqueId,
  deriveCheckTransactionType,
  isValid12CharUniqueId,
  processScannedCheckFiles,
} from '../../utils/checkProcessor';
import { categorizeChecksHybrid } from '../../utils/checkCategorizer';
import {
  batchUpdateCheckCategories,
  batchUpdateCheckUniqueIds,
  CANONICAL_CHECK_HEADERS,
  CHECK_SPREADSHEET_ID,
  executeCheckSyncPlan,
  fetchCheckLedger,
  prepareCheckSyncPlan,
  updateCheckCategory,
  updateCheckIsRecon,
  updateCheckRecord,
} from '../../services/checkSheets';
import {
  BankLookUpCategories,
  fetchBankLookUpCategories,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from '../../services/googleSheets';
import {
  EXPENSE_SPREADSHEET_ID,
  fetchExpenseCategories,
} from '../../services/expenseSheets';
import { clearCachedToken, getAccessToken } from '../../services/firebaseAuth';
import { CheckGrid, CheckSortField } from './CheckGrid';
import { CheckEntryModal } from './CheckEntryModal';
import { CheckSyncConfirmModal } from './CheckSyncConfirmModal';
import { CategorizeReviewItem, CheckCategorizeModal } from './CheckCategorizeModal';

interface CheckModuleProps {
  needsAuth: boolean;
  isLoggingIn: boolean;
  onSignIn: () => void;
  onAuthExpired: () => void;
  onCheckRecordsChange?: (records: CheckRecord[]) => void;
}

type OriginFilter = 'all' | 'sheet' | 'ready' | 'duplicates';
type TypeFilter = 'all' | 'Income' | 'Expense';
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

function isSupportedCheckFile(file: File): boolean {
  const mime = inferMimeType(file).toLowerCase();
  return mime === 'application/pdf' || mime.startsWith('image/');
}

function csvCell(value: string | number): string {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const CheckModule: React.FC<CheckModuleProps> = ({
  needsAuth,
  isLoggingIn,
  onSignIn,
  onAuthExpired,
  onCheckRecordsChange,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isFetchingRef = useRef(false);
  const rawFileMapRef = useRef<Record<string, File>>({});

  // Google Sheet state
  const [sheetMeta, setSheetMeta] = useState<CheckSheetMeta | null>(null);
  const [sheetRecords, setSheetRecords] = useState<CheckRecord[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [existingCanonicalKeys, setExistingCanonicalKeys] = useState<Set<string>>(new Set());
  const [hasLoadedSheet, setHasLoadedSheet] = useState(false);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  // Scan Queue & Edits
  const [uploadedFiles, setUploadedFiles] = useState<UploadedCheckFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [stagedOverrides, setStagedOverrides] = useState<Record<string, Partial<CheckRecord>>>(
    {}
  );

  // Modals & Operations
  const [entryModalState, setEntryModalState] = useState<{
    isOpen: boolean;
    mode: 'create' | 'edit';
    record: CheckRecord | null;
  }>({
    isOpen: false,
    mode: 'create',
    record: null,
  });
  const [pendingSyncPlan, setPendingSyncPlan] = useState<CheckSyncPlan | null>(null);
  const [clearQueueAfterSync, setClearQueueAfterSync] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPreparingSync, setIsPreparingSync] = useState(false);
  const [isMigratingIds, setIsMigratingIds] = useState(false);
  const [isSavingModal, setIsSavingModal] = useState(false);
  const [updatingReconKey, setUpdatingReconKey] = useState<string | null>(null);
  const [updatingCategoryKey, setUpdatingCategoryKey] = useState<string | null>(null);
  const [isAutoCategorizing, setIsAutoCategorizing] = useState(false);
  const [isApplyingBatchCategories, setIsApplyingBatchCategories] = useState(false);
  const [categorizeReviewState, setCategorizeReviewState] = useState<{
    isOpen: boolean;
    items: CategorizeReviewItem[];
  }>({ isOpen: false, items: [] });

  // LookUp Categories (Check_Ledger LookUp -> Bank_Ledger LookUp -> Expense_Ledger fallback)
  const [checkLookupCategories, setCheckLookupCategories] = useState<BankLookUpCategories>({
    expenseCategories: [],
    incomeCategories: [],
  });
  const [bankLookupCategories, setBankLookupCategories] = useState<BankLookUpCategories>({
    expenseCategories: [],
    incomeCategories: [],
  });
  const [expenseFallbackCategories, setExpenseFallbackCategories] = useState<string[]>([]);

  // Notifications
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters & Sort
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [reconFilter, setReconFilter] = useState<ReconFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sortField, setSortField] = useState<CheckSortField>('date');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const loadCheckLookupCategories = useCallback(async (explicitToken?: string) => {
    const token = explicitToken ?? (await getAccessToken());
    if (!token) return;

    const [checkRes, bankRes, expenseRes] = await Promise.allSettled([
      fetchBankLookUpCategories(token, CHECK_SPREADSHEET_ID),
      fetchBankLookUpCategories(token, TARGET_SPREADSHEET_ID),
      fetchExpenseCategories(token, EXPENSE_SPREADSHEET_ID),
    ]);

    if (checkRes.status === 'fulfilled') {
      setCheckLookupCategories(checkRes.value);
    }
    if (bankRes.status === 'fulfilled') {
      setBankLookupCategories(bankRes.value);
    }
    if (expenseRes.status === 'fulfilled') {
      setExpenseFallbackCategories(expenseRes.value);
    }
  }, []);

  const loadCheckLedger = useCallback(
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
        const [loaded] = await Promise.all([
          fetchCheckLedger(token, CHECK_SPREADSHEET_ID),
          loadCheckLookupCategories(token),
        ]);
        setSheetMeta(loaded.meta);
        setSheetRecords(loaded.records);
        setExistingIds(loaded.existingIds);
        setExistingCanonicalKeys(loaded.existingCanonicalKeys);
        setHasLoadedSheet(true);
      } catch (err) {
        if (err instanceof SheetsApiError && err.status === 401) {
          clearCachedToken();
          onAuthExpired();
          setErrorMessage('Google session expired. Please sign in again to refresh Check_Ledger.');
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to load Check_Ledger from Google Sheets.'
          );
        }
      } finally {
        setIsLoadingSheet(false);
        isFetchingRef.current = false;
      }
    },
    [loadCheckLookupCategories, onAuthExpired]
  );

  useEffect(() => {
    if (!needsAuth && !hasLoadedSheet) {
      void loadCheckLedger();
    }
  }, [needsAuth, hasLoadedSheet, loadCheckLedger]);

  useEffect(() => {
    if (hasLoadedSheet && onCheckRecordsChange) {
      onCheckRecordsChange(sheetRecords);
    }
  }, [hasLoadedSheet, sheetRecords, onCheckRecordsChange]);

  const scanSingleFile = useCallback(async (fileId: string, file: File) => {
    try {
      const base64Data = await readFileAsBase64(file);
      const mimeType = inferMimeType(file);
      const resp = await fetch('/api/checks/scan', {
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
        checks?: RawExtractedCheck[];
        error?: string;
      };

      if (!resp.ok) {
        throw new Error(payload.error || `Scan failed (${resp.status})`);
      }

      const extractedChecks = Array.isArray(payload.checks) ? payload.checks : [];

      let categorizedChecks = extractedChecks;
      const ctx = categorizeContextRef.current;
      if (
        extractedChecks.length > 0 &&
        (ctx.expenseCategories.length > 0 || ctx.incomeCategories.length > 0)
      ) {
        try {
          const suggestions = await categorizeChecksHybrid({
            checks: extractedChecks.map((chk, idx) => ({
              id: `scan-${fileId}-${idx}`,
              transactionType: deriveCheckTransactionType(chk.paidBy ?? ''),
              amount: Number.isFinite(chk.amount) ? Math.abs(chk.amount) : undefined,
              memo: chk.memo ?? '',
              paidTo: chk.paidTo ?? '',
              paidBy: chk.paidBy ?? '',
            })),
            expenseCategories: ctx.expenseCategories,
            incomeCategories: ctx.incomeCategories,
            existingRecords: ctx.existingRecords,
          });
          categorizedChecks = extractedChecks.map((chk, idx) => {
            const match = suggestions.get(`scan-${fileId}-${idx}`);
            return match?.category ? { ...chk, category: match.category } : chk;
          });
        } catch {
          // Preserve extracted checks even if AI categorization endpoint fails transiently
        }
      }

      setUploadedFiles((prev) =>
        prev.map((item) =>
          item.id === fileId
            ? {
                ...item,
                status: 'ready',
                errorMessage:
                  categorizedChecks.length === 0
                    ? 'No checks detected in this file.'
                    : undefined,
                extractedChecks: categorizedChecks,
              }
            : item
        )
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to extract check data from file.';
      setUploadedFiles((prev) =>
        prev.map((item) =>
          item.id === fileId
            ? {
                ...item,
                status: 'error',
                errorMessage: msg,
                extractedChecks: [],
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

      const rejected = incoming.filter((f) => !isSupportedCheckFile(f));
      const accepted = incoming.filter((f) => isSupportedCheckFile(f));

      if (rejected.length > 0) {
        setErrorMessage(
          `Unsupported file(s) skipped: ${rejected
            .map((f) => f.name)
            .join(', ')}. Upload check images (PNG, JPG, WEBP) or PDFs.`
        );
      } else {
        setErrorMessage(null);
      }

      if (accepted.length === 0) return;
      setStatusMessage(null);

      const newEntries: Array<{ entry: UploadedCheckFile; file: File }> = accepted.map((file) => {
        const id = `chkfile-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        rawFileMapRef.current[id] = file;
        return {
          file,
          entry: {
            id,
            fileName: file.name,
            mimeType: inferMimeType(file),
            fileSize: file.size,
            status: 'scanning',
            extractedChecks: [],
          },
        };
      });

      setUploadedFiles((prev) => [...prev, ...newEntries.map((n) => n.entry)]);

      await Promise.all(newEntries.map(({ entry, file }) => scanSingleFile(entry.id, file)));
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
          ? { ...item, status: 'scanning', errorMessage: undefined, extractedChecks: [] }
          : item
      )
    );
    await scanSingleFile(fileId, file);
  };

  const handleRemoveFile = (fileId: string) => {
    delete rawFileMapRef.current[fileId];
    setUploadedFiles((prev) => prev.filter((item) => item.id !== fileId));
    setStagedOverrides((prev) => {
      const next: Record<string, Partial<CheckRecord>> = {};
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

  // Run deduplication and transaction type derivation over uploaded scans + sheet IDs
  const scanPipeline = useMemo(
    () =>
      processScannedCheckFiles(
        uploadedFiles,
        existingIds,
        existingCanonicalKeys,
        stagedOverrides
      ),
    [uploadedFiles, existingIds, existingCanonicalKeys, stagedOverrides]
  );

  const scanningCount = useMemo(
    () => uploadedFiles.filter((f) => f.status === 'scanning').length,
    [uploadedFiles]
  );

  const combinedRecords = useMemo<CheckRecord[]>(() => {
    return [...scanPipeline.readyChecks, ...scanPipeline.duplicateChecks, ...sheetRecords];
  }, [scanPipeline.readyChecks, scanPipeline.duplicateChecks, sheetRecords]);

  // Month quick-filter presets
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const rec of combinedRecords) {
      if (rec.date && /^\d{4}-\d{2}/.test(rec.date)) {
        set.add(rec.date.slice(0, 7));
      }
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [combinedRecords]);

  const activeMonthPreset = useMemo(() => {
    if (!startDate || !endDate) return '';
    const ym = startDate.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    if (!y || !m) return '';
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const expectedStart = `${ym}-01`;
    const expectedEnd = `${ym}-${String(lastDay).padStart(2, '0')}`;
    return startDate === expectedStart && endDate === expectedEnd ? ym : '';
  }, [startDate, endDate]);

  const handleSelectMonth = (ym: string) => {
    if (!ym) {
      setStartDate('');
      setEndDate('');
      return;
    }
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    setStartDate(`${ym}-01`);
    setEndDate(`${ym}-${String(lastDay).padStart(2, '0')}`);
  };

  const checkExpenseCategoryOptions = useMemo(() => {
    if (checkLookupCategories.expenseCategories.length > 0) {
      return checkLookupCategories.expenseCategories;
    }
    if (bankLookupCategories.expenseCategories.length > 0) {
      return bankLookupCategories.expenseCategories;
    }
    return expenseFallbackCategories;
  }, [
    checkLookupCategories.expenseCategories,
    bankLookupCategories.expenseCategories,
    expenseFallbackCategories,
  ]);

  const checkIncomeCategoryOptions = useMemo(() => {
    if (checkLookupCategories.incomeCategories.length > 0) {
      return checkLookupCategories.incomeCategories;
    }
    return bankLookupCategories.incomeCategories;
  }, [checkLookupCategories.incomeCategories, bankLookupCategories.incomeCategories]);

  const categorizeContextRef = useRef<{
    expenseCategories: string[];
    incomeCategories: string[];
    existingRecords: CheckRecord[];
  }>({
    expenseCategories: [],
    incomeCategories: [],
    existingRecords: [],
  });

  useEffect(() => {
    categorizeContextRef.current = {
      expenseCategories: checkExpenseCategoryOptions,
      incomeCategories: checkIncomeCategoryOptions,
      existingRecords: sheetRecords,
    };
  }, [checkExpenseCategoryOptions, checkIncomeCategoryOptions, sheetRecords]);

  const uncategorizedSheetChecks = useMemo(
    () =>
      sheetRecords.filter(
        (rec) => Boolean(rec.sheetRowNumber) && !(rec.category ?? '').trim()
      ),
    [sheetRecords]
  );

  const availableCheckCategories = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [
      ...checkExpenseCategoryOptions,
      ...checkIncomeCategoryOptions,
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
  }, [checkExpenseCategoryOptions, checkIncomeCategoryOptions, combinedRecords]);

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const filtered = combinedRecords.filter((rec) => {
      if (originFilter === 'sheet' && rec.sourceOrigin !== 'sheet') return false;
      if (originFilter === 'ready' && (rec.sourceOrigin !== 'scan' || rec.isDuplicate))
        return false;
      if (originFilter === 'duplicates' && !rec.isDuplicate) return false;

      if (typeFilter !== 'all' && rec.transactionType !== typeFilter) return false;

      if (reconFilter === 'unrecon' && rec.isRecon !== 'No') return false;
      if (reconFilter === 'recon' && rec.isRecon !== 'Yes') return false;

      if (
        categoryFilter !== 'all' &&
        (rec.category ?? '').trim().toLowerCase() !== categoryFilter.toLowerCase()
      ) {
        return false;
      }

      if (startDate && (!rec.date || rec.date < startDate)) return false;
      if (endDate && (!rec.date || rec.date > endDate)) return false;

      if (q) {
        const hay = `${rec.uniqueId} ${rec.checkNumber} ${rec.routingNumber} ${rec.bank} ${rec.paidTo} ${rec.paidBy} ${rec.memo} ${rec.category ?? ''} ${rec.transactionType}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortField === 'checkNumber') {
        const chkA = a.checkNumber.trim();
        const chkB = b.checkNumber.trim();
        if (!chkA && chkB) return 1;
        if (chkA && !chkB) return -1;
        if (chkA !== chkB) {
          const cmp = chkA.localeCompare(chkB, undefined, {
            numeric: true,
            sensitivity: 'base',
          });
          if (cmp !== 0) {
            return sortOrder === 'asc' ? cmp : -cmp;
          }
        }
        return b.date.localeCompare(a.date);
      }

      if (a.date !== b.date) {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return sortOrder === 'desc'
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      }
      return b.uniqueId.localeCompare(a.uniqueId);
    });
  }, [
    combinedRecords,
    originFilter,
    typeFilter,
    reconFilter,
    categoryFilter,
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
      if (!isValid12CharUniqueId(rec.uniqueId)) {
        const hashedId = buildCheckUniqueId(
          rec.checkNumber,
          rec.routingNumber,
          rec.date,
          rec.bank
        );
        if (hashedId !== rec.uniqueId) {
          updates.push({ sheetRowNumber: rec.sheetRowNumber, uniqueId: hashedId });
        }
      }
    }
    return updates;
  }, [sheetRecords]);

  const handleToggleSort = (field: CheckSortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortOrder(field === 'checkNumber' ? 'asc' : 'desc');
    }
  };

  // Metrics excluding skipped duplicate copies
  const kpiMetrics = useMemo(() => {
    let incomeCents = 0;
    let expenseCents = 0;
    let incomeCount = 0;
    let expenseCount = 0;
    let unreconCount = 0;

    for (const rec of filteredRecords) {
      if (rec.isDuplicate) continue;
      if (rec.transactionType === 'Income') {
        incomeCents += rec.amountCents;
        incomeCount++;
      } else {
        expenseCents += rec.amountCents;
        expenseCount++;
      }
      if (rec.isRecon === 'No') {
        unreconCount++;
      }
    }

    return {
      totalActive: incomeCount + expenseCount,
      income: incomeCents / 100,
      incomeCount,
      expense: expenseCents / 100,
      expenseCount,
      net: (incomeCents - expenseCents) / 100,
      unreconCount,
    };
  }, [filteredRecords]);

  const handleOpenSyncConfirmation = async () => {
    if (scanPipeline.readyChecks.length === 0) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsPreparingSync(true);
    setErrorMessage(null);
    try {
      const { plan, workspace } = await prepareCheckSyncPlan(
        token,
        CHECK_SPREADSHEET_ID,
        scanPipeline.readyChecks
      );
      setSheetMeta(workspace.meta);
      setSheetRecords(workspace.records);
      setExistingIds(workspace.existingIds);
      setExistingCanonicalKeys(workspace.existingCanonicalKeys);
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
          err instanceof Error ? err.message : 'Failed to prepare Check_Ledger sync.'
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
      const result = await executeCheckSyncPlan(token, pendingSyncPlan);
      setPendingSyncPlan(null);
      if (clearQueueAfterSync) {
        rawFileMapRef.current = {};
        setUploadedFiles([]);
        setStagedOverrides({});
      }
      await loadCheckLedger(token);
      setStatusMessage(
        `Recorded ${result.appendedCount} new ${
          result.appendedCount === 1 ? 'check' : 'checks'
        } to ${result.tabName}${
          result.skippedCount > 0
            ? ` (${result.skippedCount} duplicate ${
                result.skippedCount === 1 ? 'copy' : 'copies'
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
          err instanceof Error ? err.message : 'Failed to write checks to Check_Ledger.'
        );
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveEntryModal = async (
    nextRecord: CheckRecord,
    original: CheckRecord | null
  ) => {
    setErrorMessage(null);

    // Editing an already-saved Google Sheet row
    if (entryModalState.mode === 'edit' && original?.sourceOrigin === 'sheet') {
      if (!sheetMeta) {
        setErrorMessage('Check_Ledger sheet metadata is not loaded yet.');
        return;
      }
      const token = await getAccessToken();
      if (!token) {
        onAuthExpired();
        return;
      }

      setIsSavingModal(true);
      try {
        await updateCheckRecord(token, sheetMeta, nextRecord);
        setEntryModalState({ isOpen: false, mode: 'create', record: null });
        await loadCheckLedger(token);
        setStatusMessage(`Updated check ${nextRecord.uniqueId} in Check_Ledger.`);
      } catch (err) {
        if (err instanceof SheetsApiError && err.status === 401) {
          clearCachedToken();
          onAuthExpired();
          setErrorMessage('Google session expired. Please sign in again.');
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to update check in Google Sheets.'
          );
        }
      } finally {
        setIsSavingModal(false);
      }
      return;
    }

    // Editing a staged check from an uploaded image/PDF
    if (entryModalState.mode === 'edit' && original) {
      setStagedOverrides((prev) => ({
        ...prev,
        [original.rowKey]: {
          checkNumber: nextRecord.checkNumber,
          routingNumber: nextRecord.routingNumber,
          bank: nextRecord.bank,
          date: nextRecord.date,
          amount: nextRecord.amount,
          paidTo: nextRecord.paidTo,
          paidBy: nextRecord.paidBy,
          memo: nextRecord.memo,
          transactionType: nextRecord.transactionType,
          isRecon: nextRecord.isRecon,
          category: nextRecord.category ?? '',
        },
      }));
      setEntryModalState({ isOpen: false, mode: 'create', record: null });
      setStatusMessage(`Updated staged check ${nextRecord.uniqueId}.`);
      return;
    }

    // Creating a manual check -> prepare sync plan and ask confirmation before recording
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      return;
    }

    setIsSavingModal(true);
    try {
      const { plan, workspace } = await prepareCheckSyncPlan(token, CHECK_SPREADSHEET_ID, [
        nextRecord,
      ]);
      setSheetMeta(workspace.meta);
      setSheetRecords(workspace.records);
      setExistingIds(workspace.existingIds);
      setExistingCanonicalKeys(workspace.existingCanonicalKeys);
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
          err instanceof Error ? err.message : 'Failed to prepare check for Check_Ledger.'
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
      const count = await batchUpdateCheckUniqueIds(token, sheetMeta, legacySheetUpdates);
      await loadCheckLedger(token);
      setStatusMessage(
        `Replaced ${count} legacy Column A Unique ${
          count === 1 ? 'ID' : 'IDs'
        } with deterministic 12-character alphanumeric hashes.`
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

  const handleUpdateIsRecon = async (rec: CheckRecord, nextIsRecon: 'Yes' | 'No') => {
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
      await updateCheckIsRecon(token, sheetMeta, rec.sheetRowNumber, nextIsRecon);
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
          err instanceof Error ? err.message : 'Failed to update Is_Recon in Check_Ledger.'
        );
      }
    } finally {
      setUpdatingReconKey(null);
    }
  };

  const handleUpdateCategory = async (rec: CheckRecord, nextCategory: string) => {
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
      await updateCheckCategory(token, sheetMeta, rec.sheetRowNumber, trimmed);
      setSheetMeta((prev) =>
        prev
          ? {
              ...prev,
              hasTransactionTypeHeader: true,
              hasIsReconHeader: true,
              hasRoutingNumberHeader: true,
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
          err instanceof Error ? err.message : 'Failed to update Category in Check_Ledger.'
        );
      }
    } finally {
      setUpdatingCategoryKey(null);
    }
  };

  const handleRunAutoCategorizeUncategorized = async () => {
    if (uncategorizedSheetChecks.length === 0) return;
    if (
      checkExpenseCategoryOptions.length === 0 &&
      checkIncomeCategoryOptions.length === 0
    ) {
      setErrorMessage(
        'No Expense or Income categories were found in the LookUp tab. Please refresh Check_Ledger first.'
      );
      return;
    }

    setIsAutoCategorizing(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const suggestions = await categorizeChecksHybrid({
        checks: uncategorizedSheetChecks.map((rec) => ({
          id: rec.rowKey,
          transactionType: rec.transactionType,
          amount: rec.amount,
          memo: rec.memo,
          paidTo: rec.paidTo,
          paidBy: rec.paidBy,
        })),
        expenseCategories: checkExpenseCategoryOptions,
        incomeCategories: checkIncomeCategoryOptions,
        existingRecords: sheetRecords,
      });

      const items: CategorizeReviewItem[] = uncategorizedSheetChecks.map((record) => ({
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
          : 'Failed to auto-categorize uncategorized checks.'
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
      const count = await batchUpdateCheckCategories(token, sheetMeta, updates);
      setCategorizeReviewState({ isOpen: false, items: [] });
      await loadCheckLedger(token);
      setStatusMessage(
        `Assigned Category for ${count} ${count === 1 ? 'check' : 'checks'} in Check_Ledger.`
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
            : 'Failed to save assigned categories to Check_Ledger.'
        );
      }
    } finally {
      setIsApplyingBatchCategories(false);
    }
  };

  const handleExportCsv = () => {
    const exportRows = filteredRecords.filter((r) => !r.isDuplicate);
    if (exportRows.length === 0) return;

    const headerLine = [...CANONICAL_CHECK_HEADERS, 'Source Origin'].map(csvCell).join(',');
    const bodyLines = exportRows.map((rec) =>
      [
        rec.uniqueId,
        rec.checkNumber,
        rec.bank,
        rec.date,
        rec.amount.toFixed(2),
        rec.paidTo,
        rec.paidBy,
        rec.memo,
        rec.transactionType,
        rec.isRecon,
        rec.routingNumber,
        rec.category ?? '',
        rec.sourceOrigin === 'sheet' ? 'Check_Ledger' : rec.sourceFileName || 'Scanned',
      ]
        .map(csvCell)
        .join(',')
    );

    const csv = [headerLine, ...bodyLines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `check-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const resetFilters = () => {
    setOriginFilter('all');
    setTypeFilter('all');
    setReconFilter('all');
    setCategoryFilter('all');
    setSearchQuery('');
    setStartDate('');
    setEndDate('');
  };

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full shrink-0 border-b border-slate-200 bg-white p-5 lg:w-[295px] lg:border-r lg:border-b-0">
        <div className="space-y-6">
          {/* 01. Check_Ledger Target */}
          <section>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold tracking-tight text-slate-900">
                01. Check_Ledger Sheet
              </h2>
              <a
                href={`https://docs.google.com/spreadsheets/d/${CHECK_SPREADSHEET_ID}/edit`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open Check_Ledger spreadsheet in Google Sheets"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:underline"
              >
                Open Sheet
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {sheetMeta
                ? `${sheetMeta.spreadsheetTitle} · Tab "${sheetMeta.ledgerTabName}"`
                : 'Target spreadsheet: Check_Ledger'}
            </p>
            <button
              type="button"
              onClick={() => void loadCheckLedger()}
              disabled={isLoadingSheet || needsAuth}
              title="Reload saved check rows and LookUp categories from Check_Ledger"
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoadingSheet ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {isLoadingSheet ? 'Refreshing Check_Ledger...' : 'Refresh Check_Ledger'}
            </button>
          </section>

          {/* 02. Upload Check Images or PDFs */}
          <section>
            <h2 className="text-xs font-semibold tracking-tight text-slate-900">
              02. Upload Check Images / PDFs
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Single or multi-check pages (PNG, JPG, WEBP, PDF). Duplicate check copies are skipped.
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
              title="Upload check images (PNG, JPG, WEBP) or PDFs to extract check fields and auto-categorize"
              className={`mt-3 flex w-full flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center transition-colors ${
                isDragging
                  ? 'border-teal-700 bg-teal-50/70'
                  : 'border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-100/70'
              }`}
            >
              <Upload className="h-5 w-5 text-slate-500" aria-hidden="true" />
              <span className="mt-2 text-xs font-medium text-slate-800">
                Drop check images or PDFs
              </span>
              <span className="mt-0.5 text-[11px] text-slate-500">
                or click to browse multi-check scans
              </span>
            </button>

            {uploadedFiles.length > 0 && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Scan Queue ({uploadedFiles.length})</span>
                  <button
                    type="button"
                    onClick={handleClearQueue}
                    title="Remove all uploaded files and staged checks from the queue"
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
                          <span className="truncate font-medium text-slate-800" title={file.fileName}>
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
                            Extracting check fields...
                          </span>
                        ) : file.status === 'error' ? (
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="truncate text-red-700" title={file.errorMessage}>
                              {file.errorMessage || 'Scan failed'}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleRetryFile(file.id)}
                              title={`Re-run OCR check scan for ${file.fileName}`}
                              className="shrink-0 font-medium text-teal-700 hover:underline"
                            >
                              Retry
                            </button>
                          </div>
                        ) : (
                          <span className="font-mono text-slate-600 tabular-nums">
                            {file.extractedChecks.length}{' '}
                            {file.extractedChecks.length === 1 ? 'check' : 'checks'} extracted
                          </span>
                        )}
                      </div>
                      {file.status === 'ready' && file.errorMessage && (
                        <div className="mt-1 text-[11px] text-amber-700">{file.errorMessage}</div>
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
              03. Scan & Dedup Summary
            </h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <dt>Saved in Check_Ledger</dt>
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
                <dt>Duplicate copies skipped</dt>
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
                scanPipeline.readyChecks.length === 0 ||
                isPreparingSync
              }
              title="Run final duplicate check and append ready scanned checks to Check_Ledger"
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3.5 py-2.5 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
              {isPreparingSync
                ? 'Checking Duplicates...'
                : `Record ${scanPipeline.readyChecks.length} to Check_Ledger`}
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
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Check Ledger</h1>
              <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Scan single or multi-check images and PDFs, auto-classify Income vs. Expense
                (Houston Durgabari Society), skip duplicate copies, and sync to Google Sheets{' '}
                <span className="font-medium text-slate-700">Check_Ledger</span>.
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
                title="Open manual entry form to add a single check to Check_Ledger"
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Check Manually
              </button>

              <button
                type="button"
                onClick={() => void handleRunAutoCategorizeUncategorized()}
                disabled={
                  needsAuth ||
                  isLoadingSheet ||
                  isAutoCategorizing ||
                  uncategorizedSheetChecks.length === 0
                }
                title="Auto-assign LookUp categories to uncategorized Check_Ledger rows using hybrid rules and strict constrained AI for review"
                className="inline-flex items-center gap-1.5 rounded-md border border-teal-300 bg-teal-50/60 px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100/70 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 whitespace-nowrap shrink-0"
              >
                <Sparkles
                  className={`h-3.5 w-3.5 ${isAutoCategorizing ? 'animate-pulse' : ''}`}
                  aria-hidden="true"
                />
                {isAutoCategorizing
                  ? 'Categorizing...'
                  : `Auto-Categorize Uncategorized Checks (${uncategorizedSheetChecks.length})`}
              </button>

              <button
                type="button"
                onClick={handleExportCsv}
                disabled={kpiMetrics.totalActive === 0}
                title="Download the currently filtered active check records as a CSV file"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Export CSV
              </button>
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
                  {legacySheetUpdates.length === 1 ? 'row in Check_Ledger uses' : 'rows in Check_Ledger use'}{' '}
                  the legacy long Column A Unique ID. Replace them with deterministic 12-character alphanumeric hashes.
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleReplaceLegacyUniqueIds()}
                disabled={isMigratingIds || needsAuth}
                title="Update legacy Column A Unique IDs in Check_Ledger to deterministic 12-character hashes"
                className="rounded-md bg-amber-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
              >
                {isMigratingIds
                  ? 'Updating Unique IDs...'
                  : `Replace ${legacySheetUpdates.length} Legacy Unique IDs`}
              </button>
            </div>
          )}

          {scanPipeline.duplicateChecks.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <span>
                  <strong>{scanPipeline.duplicateChecks.length}</strong> duplicate check{' '}
                  {scanPipeline.duplicateChecks.length === 1 ? 'copy was' : 'copies were'} detected
                  and will <strong>not</strong> be recorded to Check_Ledger.
                </span>
              </div>
              <button
                type="button"
                onClick={() =>
                  setOriginFilter((prev) => (prev === 'duplicates' ? 'all' : 'duplicates'))
                }
                title="Filter table to inspect or leave duplicate skipped checks"
                className="font-medium text-amber-900 underline whitespace-nowrap"
              >
                {originFilter === 'duplicates' ? 'Show All' : 'Inspect Skipped'}
              </button>
            </div>
          )}

          {/* KPI Strip */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="text-xs text-slate-500">Active Checks (Filtered)</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                  {kpiMetrics.totalActive.toLocaleString()}
                </span>
                <span className="text-[11px] text-slate-500">
                  {kpiMetrics.unreconCount} unrecon
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Check Income</span>
                <ArrowUpRight className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-2xl font-bold text-emerald-700 tabular-nums">
                  {kpiMetrics.income.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </span>
                <span className="text-[11px] text-slate-500">
                  {kpiMetrics.incomeCount} checks
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Check Expenses (HDS Paid By)</span>
                <ArrowDownRight className="h-3.5 w-3.5 text-red-700" aria-hidden="true" />
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-2xl font-bold text-red-700 tabular-nums">
                  {kpiMetrics.expense.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </span>
                <span className="text-[11px] text-slate-500">
                  {kpiMetrics.expenseCount} checks
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
              <div className="text-xs text-slate-500">Net Check Flow</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span
                  className={`font-mono text-2xl font-bold tabular-nums ${
                    kpiMetrics.net >= 0 ? 'text-slate-900' : 'text-red-700'
                  }`}
                >
                  {kpiMetrics.net.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </span>
                <span className="text-[11px] text-slate-500">
                  {scanPipeline.readyChecks.length} staged
                </span>
              </div>
            </div>
          </div>

          {/* Filter Bar */}
          <div className="space-y-2.5 rounded-lg border border-slate-200 bg-white p-3.5">
            {/* Row 1: Month & Date Range */}
            <div className="flex flex-wrap items-center gap-2.5">
              <select
                value={activeMonthPreset}
                onChange={(e) => handleSelectMonth(e.target.value)}
                aria-label="Quick select month"
                title="Quick-select a calendar month"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              >
                <option value="">All Months</option>
                {monthOptions.map((ym) => (
                  <option key={ym} value={ym}>
                    {ym}
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <Calendar className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  aria-label="Start Date"
                  title="Filter checks from this date"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                />
                <span>to</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  aria-label="End Date"
                  title="Filter checks through this date"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                />
              </div>
            </div>

            {/* Row 2: Origin Tabs + Search */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Origin Tabs */}
              <div className="inline-flex rounded-md bg-slate-100 p-1 text-xs font-medium">
                {(
                  [
                    { id: 'all', label: `All (${combinedRecords.length})` },
                    { id: 'sheet', label: `In Sheet (${sheetRecords.length})` },
                    { id: 'ready', label: `Ready (${scanPipeline.readyChecks.length})` },
                    {
                      id: 'duplicates',
                      label: `Duplicates (${scanPipeline.duplicateChecks.length})`,
                    },
                  ] as Array<{ id: OriginFilter; label: string }>
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setOriginFilter(tab.id)}
                    className={`rounded px-2.5 py-1 transition-colors whitespace-nowrap ${
                      originFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Search */}
              <div className="relative min-w-[220px] flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search check #, bank, paid to, paid by, category, memo, Unique ID..."
                  className="w-full rounded-md border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>
            </div>

            {/* Row 3: Dropdown Filters */}
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Is_Recon Filter */}
              <select
                value={reconFilter}
                onChange={(e) => setReconFilter(e.target.value as ReconFilter)}
                aria-label="Filter by Is_Recon"
                title="Filter checks by reconciliation status"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              >
                <option value="all">All Is_Recon</option>
                <option value="unrecon">Unreconciled (No)</option>
                <option value="recon">Reconciled (Yes)</option>
              </select>

              {/* Transaction Type Filter */}
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                aria-label="Filter by Transaction Type"
                title="Filter checks by Income or Expense"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              >
                <option value="all">All Types</option>
                <option value="Income">Income</option>
                <option value="Expense">Expense</option>
              </select>

              {/* Category Filter */}
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label="Filter by Category"
                title="Filter checks by category"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              >
                <option value="all">All Categories</option>
                {availableCheckCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>

              {(originFilter !== 'all' ||
                typeFilter !== 'all' ||
                reconFilter !== 'all' ||
                categoryFilter !== 'all' ||
                searchQuery ||
                startDate ||
                endDate) && (
                <button
                  type="button"
                  onClick={resetFilters}
                  title="Reset all active check filters and search text"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>

          {/* Check Grid */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <CheckGrid
              records={filteredRecords}
              hasUploadedFiles={uploadedFiles.length > 0}
              isLoading={isLoadingSheet}
              needsAuth={needsAuth}
              isLoggingIn={isLoggingIn}
              sortField={sortField}
              sortOrder={sortOrder}
              expenseCategoryOptions={checkExpenseCategoryOptions}
              incomeCategoryOptions={checkIncomeCategoryOptions}
              updatingReconKey={updatingReconKey}
              updatingCategoryKey={updatingCategoryKey}
              onSignIn={onSignIn}
              onToggleSort={handleToggleSort}
              onEditRecord={(rec) =>
                setEntryModalState({
                  isOpen: true,
                  mode: 'edit',
                  record: rec,
                })
              }
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
      <CheckEntryModal
        isOpen={entryModalState.isOpen}
        mode={entryModalState.mode}
        record={entryModalState.record}
        expenseCategoryOptions={checkExpenseCategoryOptions}
        incomeCategoryOptions={checkIncomeCategoryOptions}
        isSaving={isSavingModal}
        onClose={() =>
          !isSavingModal &&
          setEntryModalState({ isOpen: false, mode: 'create', record: null })
        }
        onSave={handleSaveEntryModal}
      />

      <CheckSyncConfirmModal
        plan={pendingSyncPlan}
        isSyncing={isSyncing}
        onCancel={() => !isSyncing && setPendingSyncPlan(null)}
        onConfirm={() => void handleConfirmSync()}
      />

      <CheckCategorizeModal
        isOpen={categorizeReviewState.isOpen}
        items={categorizeReviewState.items}
        expenseCategoryOptions={checkExpenseCategoryOptions}
        incomeCategoryOptions={checkIncomeCategoryOptions}
        isApplying={isApplyingBatchCategories}
        onClose={() =>
          !isApplyingBatchCategories &&
          setCategorizeReviewState({ isOpen: false, items: [] })
        }
        onApply={handleApplyAutoCategories}
      />
    </div>
  );
};
