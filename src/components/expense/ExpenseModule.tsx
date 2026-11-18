import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  Calendar,
  CheckCircle2,
  Columns3,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ExpenseCsvColumnMapping,
  ExpenseLookups,
  ExpenseMutationAction,
  ExpenseRecord,
  ExpenseSheetMeta,
  StagedExpenseBatchSummary,
  UploadedExpenseCsv,
} from '../../types/expense';
import { parseCsvText } from '../../utils/csvParser';
import {
  detectExpenseCsvMapping,
  processExpenseCsvs,
} from '../../utils/expenseProcessor';
import {
  appendExpenseRecords,
  CANONICAL_EXPENSE_HEADERS,
  EXPENSE_SPREADSHEET_ID,
  fetchExpenseWorkspace,
  updateExpenseIsRecon,
  updateExpenseRecord,
} from '../../services/expenseSheets';
import { SheetsApiError } from '../../services/googleSheets';
import { clearCachedToken, getAccessToken } from '../../services/firebaseAuth';
import { ExpenseCsvMappingModal } from './ExpenseCsvMappingModal';
import { ExpenseEntryModal } from './ExpenseEntryModal';
import { ExpenseConfirmModal } from './ExpenseConfirmModal';
import { ExpenseLedgerGrid } from './ExpenseLedgerGrid';

interface ExpenseModuleProps {
  needsAuth: boolean;
  isLoggingIn: boolean;
  onSignIn: () => void;
  onAuthExpired: () => void;
  onOpenReconcile?: () => void;
  refreshNonce?: number;
  externalStatusMessage?: string | null;
  onDismissExternalStatus?: () => void;
  onExpenseMutated?: () => void;
}

const EMPTY_LOOKUPS: ExpenseLookups = {
  categories: [],
  statuses: [],
  pujas: [],
  paymentModes: [],
  catSubcatMap: {},
};

const EMPTY_STAGED_SUMMARY: StagedExpenseBatchSummary = {
  totalRawRows: 0,
  filteredOutByTypeOrStatus: 0,
  skippedInvalidRows: 0,
  duplicateIdsRemoved: 0,
  readyToSync: 0,
};

type OriginFilter = 'all' | 'sheet' | 'staged';
type ExpenseLinkFilter = 'all' | 'unrecon' | 'recon' | 'unlinked' | 'linked';

export const ExpenseModule: React.FC<ExpenseModuleProps> = ({
  needsAuth,
  isLoggingIn,
  onSignIn,
  onAuthExpired,
  onOpenReconcile,
  refreshNonce = 0,
  externalStatusMessage = null,
  onDismissExternalStatus,
  onExpenseMutated,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isFetchingRef = useRef(false);
  const prevRefreshNonceRef = useRef(refreshNonce);

  // Google Sheet state
  const [sheetMeta, setSheetMeta] = useState<ExpenseSheetMeta | null>(null);
  const [lookups, setLookups] = useState<ExpenseLookups>(EMPTY_LOOKUPS);
  const [sheetRecords, setSheetRecords] = useState<ExpenseRecord[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [hasLoadedSheet, setHasLoadedSheet] = useState(false);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  // Bulk CSV state (Option 1)
  const [uploadedCsvs, setUploadedCsvs] = useState<UploadedExpenseCsv[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [editingCsvId, setEditingCsvId] = useState<string | null>(null);
  const [stagedRecords, setStagedRecords] = useState<ExpenseRecord[]>([]);
  const [stagedOverrides, setStagedOverrides] = useState<Record<string, ExpenseRecord>>({});
  const [stagedSummary, setStagedSummary] =
    useState<StagedExpenseBatchSummary>(EMPTY_STAGED_SUMMARY);
  const [isProcessingCsv, setIsProcessingCsv] = useState(false);

  // Entry / Edit modal state (Option 2 & Row Edit)
  const [entryModalState, setEntryModalState] = useState<{
    isOpen: boolean;
    mode: 'create' | 'edit';
    record: ExpenseRecord | null;
  }>({
    isOpen: false,
    mode: 'create',
    record: null,
  });

  // Confirmation & Sync state
  const [pendingMutation, setPendingMutation] = useState<ExpenseMutationAction | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingReconExpId, setUpdatingReconExpId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters & Sort
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [linkFilter, setLinkFilter] = useState<ExpenseLinkFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pujaFilter, setPujaFilter] = useState('all');
  const [paymentModeFilter, setPaymentModeFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateSortOrder, setDateSortOrder] = useState<'desc' | 'asc'>('desc');

  const loadWorkspace = useCallback(
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
        const loaded = await fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID);
        setSheetMeta(loaded.meta);
        setLookups(loaded.lookups);
        setSheetRecords(loaded.records);
        setExistingIds(loaded.existingIds);
        setHasLoadedSheet(true);
      } catch (err) {
        if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
          clearCachedToken();
          onAuthExpired();
          setErrorMessage(
            'Your Google session expired or lacks permission for Expense_Ledger. Please sign in with Google again.'
          );
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Unable to load Expense_Ledger Google Sheet.'
          );
        }
      } finally {
        isFetchingRef.current = false;
        setIsLoadingSheet(false);
      }
    },
    [onAuthExpired]
  );

  // Load automatically when authenticated
  useEffect(() => {
    if (!needsAuth && !hasLoadedSheet) {
      void loadWorkspace();
    } else if (needsAuth) {
      setSheetMeta(null);
      setLookups(EMPTY_LOOKUPS);
      setSheetRecords([]);
      setExistingIds(new Set());
      setHasLoadedSheet(false);
    }
  }, [needsAuth, hasLoadedSheet, loadWorkspace]);

  // Reload Expense_Ledger when external reconciliation updates Google Sheets
  useEffect(() => {
    if (refreshNonce !== prevRefreshNonceRef.current) {
      prevRefreshNonceRef.current = refreshNonce;
      if (!needsAuth) {
        void loadWorkspace();
      }
    }
  }, [refreshNonce, needsAuth, loadWorkspace]);

  // Process uploaded expense CSVs whenever files, existing Sheet IDs, or lookups change
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (uploadedCsvs.length === 0) {
        setStagedRecords([]);
        setStagedSummary(EMPTY_STAGED_SUMMARY);
        return;
      }
      setIsProcessingCsv(true);
      try {
        const res = await processExpenseCsvs(uploadedCsvs, existingIds, lookups);
        if (!cancelled) {
          setStagedRecords(res.stagedRecords);
          setStagedSummary(res.summary);
        }
      } finally {
        if (!cancelled) {
          setIsProcessingCsv(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [uploadedCsvs, existingIds, lookups]);

  const effectiveStagedRecords = useMemo(() => {
    return stagedRecords.map((rec) => stagedOverrides[rec.expId] ?? rec);
  }, [stagedRecords, stagedOverrides]);

  const allRecords = useMemo<ExpenseRecord[]>(() => {
    return [...effectiveStagedRecords, ...sheetRecords];
  }, [effectiveStagedRecords, sheetRecords]);

  const allKnownIds = useMemo(() => {
    const combined = new Set<string>(existingIds);
    for (const rec of effectiveStagedRecords) {
      combined.add(rec.expId.toLowerCase());
    }
    return combined;
  }, [existingIds, effectiveStagedRecords]);

  const ingestExpenseCsvFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) => f.name.toLowerCase().endsWith('.csv') || f.type.includes('csv') || f.type === ''
    );
    if (files.length === 0) {
      setErrorMessage('Please select valid .csv expense tracker files.');
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);

    const parsed: UploadedExpenseCsv[] = [];
    for (const file of files) {
      const text = await file.text();
      const { headers, rows, skippedPreambleLines } = parseCsvText(text);
      if (headers.length === 0 || rows.length === 0) {
        setErrorMessage(`"${file.name}" appears to be empty or has no readable rows.`);
        continue;
      }
      const detected = detectExpenseCsvMapping(headers);
      parsed.push({
        id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
        fileName: file.name,
        fileSize: file.size,
        rawHeaders: headers,
        rawRows: rows,
        skippedPreambleLines,
        mapping: detected.mapping,
        mappingStatus: detected.status,
      });
    }

    if (parsed.length > 0) {
      setUploadedCsvs((prev) => [...prev, ...parsed]);
    }
  }, []);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await ingestExpenseCsvFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await ingestExpenseCsvFiles(e.dataTransfer.files);
    }
  };

  const handleSaveCsvMapping = (fileId: string, mapping: ExpenseCsvColumnMapping) => {
    setUploadedCsvs((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, mapping, mappingStatus: 'manual' } : f))
    );
  };

  const handleRemoveCsv = (fileId: string) => {
    setUploadedCsvs((prev) => prev.filter((f) => f.id !== fileId));
    setStatusMessage(null);
  };

  const handleClearCsvs = () => {
    setUploadedCsvs([]);
    setStagedOverrides({});
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const handleStartBulkSync = async () => {
    setErrorMessage(null);
    setStatusMessage(null);

    if (uploadedCsvs.length === 0) {
      setErrorMessage('Upload an expense tracker CSV file first.');
      return;
    }

    const unmapped = uploadedCsvs.filter((f) => f.mappingStatus === 'needs-mapping');
    if (unmapped.length > 0) {
      setEditingCsvId(unmapped[0].id);
      setErrorMessage(
        `"${unmapped[0].fileName}" needs column mapping before syncing to Expense_Ledger.`
      );
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMessage('Sign in with Google to sync records to Expense_Ledger.');
      return;
    }

    // Refresh sheet IDs before planning sync to ensure zero stale duplicates
    setIsLoadingSheet(true);
    try {
      const latest = await fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID);
      setSheetMeta(latest.meta);
      setLookups(latest.lookups);
      setSheetRecords(latest.records);
      setExistingIds(latest.existingIds);
      setHasLoadedSheet(true);

      const recomputed = await processExpenseCsvs(
        uploadedCsvs,
        latest.existingIds,
        latest.lookups
      );
      const recordsWithOverrides = recomputed.stagedRecords.map(
        (rec) => stagedOverrides[rec.expId] ?? rec
      );

      setPendingMutation({
        kind: 'bulk-append',
        records: recordsWithOverrides,
        duplicateCount: recomputed.summary.duplicateIdsRemoved,
      });
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired. Please sign in with Google again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to inspect Expense_Ledger sheet.'
        );
      }
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleOpenManualEntry = () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setEntryModalState({ isOpen: true, mode: 'create', record: null });
  };

  const handleOpenEditRecord = (record: ExpenseRecord) => {
    setErrorMessage(null);
    setStatusMessage(null);
    setEntryModalState({ isOpen: true, mode: 'edit', record });
  };

  const handleEntryModalSubmit = async (
    nextRecord: ExpenseRecord,
    original: ExpenseRecord | null
  ) => {
    if (entryModalState.mode === 'edit' && original?.sourceOrigin === 'csv') {
      setStagedOverrides((prev) => ({
        ...prev,
        [nextRecord.expId]: nextRecord,
      }));
      setEntryModalState({ isOpen: false, mode: 'create', record: null });
      setStatusMessage(`Updated staged CSV record ${nextRecord.expId}.`);
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMessage('Sign in with Google to save changes to Expense_Ledger.');
      return;
    }

    // Ensure sheetMeta exists before opening confirmation modal
    let activeMeta = sheetMeta;
    if (!activeMeta) {
      try {
        const latest = await fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID);
        activeMeta = latest.meta;
        setSheetMeta(latest.meta);
        setLookups(latest.lookups);
        setSheetRecords(latest.records);
        setExistingIds(latest.existingIds);
        setHasLoadedSheet(true);
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to connect to Expense_Ledger sheet.'
        );
        return;
      }
    }

    setEntryModalState({ isOpen: false, mode: 'create', record: null });

    if (entryModalState.mode === 'edit' && original) {
      setPendingMutation({
        kind: 'edit-update',
        before: original,
        after: nextRecord,
      });
    } else {
      setPendingMutation({
        kind: 'manual-create',
        record: nextRecord,
      });
    }
  };

  const handleConfirmMutation = async () => {
    if (!pendingMutation || !sheetMeta) return;
    const token = await getAccessToken();
    if (!token) {
      setPendingMutation(null);
      onAuthExpired();
      setErrorMessage('Google session expired. Please sign in with Google again.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      if (pendingMutation.kind === 'bulk-append') {
        const { appendedCount } = await appendExpenseRecords(
          token,
          sheetMeta,
          pendingMutation.records
        );
        setUploadedCsvs([]);
        setStagedOverrides({});
        await loadWorkspace(token);
        setStatusMessage(
          `Appended ${appendedCount.toLocaleString()} expense record(s) to "${sheetMeta.ledgerTabName}" (${pendingMutation.duplicateCount.toLocaleString()} duplicate IDs skipped).`
        );
      } else if (pendingMutation.kind === 'manual-create') {
        await appendExpenseRecords(token, sheetMeta, [pendingMutation.record]);
        await loadWorkspace(token);
        setStatusMessage(
          `Added manual expense ${pendingMutation.record.expId} to "${sheetMeta.ledgerTabName}".`
        );
      } else if (pendingMutation.kind === 'edit-update') {
        await updateExpenseRecord(token, sheetMeta, pendingMutation.after);
        await loadWorkspace(token);
        setStatusMessage(
          `Saved changes for ${pendingMutation.after.expId} (row #${pendingMutation.after.sheetRowNumber}).`
        );
      }
      setPendingMutation(null);
      onExpenseMutated?.();
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setPendingMutation(null);
        setErrorMessage('Google session expired while saving. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to update Expense_Ledger Google Sheet.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateExpenseIsRecon = async (
    rec: ExpenseRecord,
    nextIsRecon: 'Yes' | 'No'
  ) => {
    if (rec.sourceOrigin === 'csv' || !rec.sheetRowNumber) {
      setStagedOverrides((prev) => ({
        ...prev,
        [rec.expId]: {
          ...(prev[rec.expId] ?? rec),
          isRecon: nextIsRecon,
        },
      }));
      return;
    }

    if (!sheetMeta) return;
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMessage('Sign in with Google to save Is_Recon changes to Expense_Ledger.');
      return;
    }

    const prevRecords = sheetRecords;
    setUpdatingReconExpId(rec.expId);
    setErrorMessage(null);
    setSheetRecords((prev) =>
      prev.map((item) =>
        item.expId === rec.expId && item.sheetRowNumber === rec.sheetRowNumber
          ? { ...item, isRecon: nextIsRecon }
          : item
      )
    );

    try {
      await updateExpenseIsRecon(token, sheetMeta, rec.sheetRowNumber, nextIsRecon);
      setSheetMeta((prev) => (prev ? { ...prev, hasIsReconHeader: true } : prev));
      if (rec.reconSourceId.trim() !== '') {
        onExpenseMutated?.();
      }
    } catch (err) {
      setSheetRecords(prevRecords);
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMessage('Google session expired while saving Is_Recon. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to update Is_Recon in Expense_Ledger.'
        );
      }
    } finally {
      setUpdatingReconExpId(null);
    }
  };

  // Dynamic filter option lists
  const filterOptions = useMemo(() => {
    const mergeUnique = (a: string[], b: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of [...a, ...b]) {
        const v = item.trim();
        if (!v) continue;
        const k = v.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(v);
        }
      }
      return out.sort((x, y) => x.localeCompare(y));
    };

    return {
      categories: mergeUnique(lookups.categories, allRecords.map((r) => r.category)),
      statuses: mergeUnique(lookups.statuses, allRecords.map((r) => r.status)),
      pujas: mergeUnique(lookups.pujas, allRecords.map((r) => r.puja)),
      paymentModes: mergeUnique(lookups.paymentModes, allRecords.map((r) => r.paymentMode)),
    };
  }, [lookups, allRecords]);

  // Date bounds & Period selector helpers
  const dateBounds = useMemo(() => {
    let minDate = '';
    let maxDate = '';
    const monthSet = new Set<string>();

    for (const rec of allRecords) {
      if (!rec.date) continue;
      if (!minDate || rec.date < minDate) minDate = rec.date;
      if (!maxDate || rec.date > maxDate) maxDate = rec.date;
      if (rec.date.length >= 7) {
        monthSet.add(rec.date.slice(0, 7));
      }
    }

    const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
    return { minDate, maxDate, months };
  }, [allRecords]);

  const activeMonthKey = useMemo(() => {
    if (!startDate && !endDate) return 'all';
    if (startDate && endDate && startDate.slice(0, 7) === endDate.slice(0, 7)) {
      const ym = startDate.slice(0, 7);
      const [yStr, mStr] = ym.split('-');
      const lastDay = String(
        new Date(parseInt(yStr, 10), parseInt(mStr, 10), 0).getDate()
      ).padStart(2, '0');
      if (startDate === `${ym}-01` && endDate === `${ym}-${lastDay}`) {
        return ym;
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
    if (ym === 'all') {
      setStartDate('');
      setEndDate('');
      return;
    }
    const [yStr, mStr] = ym.split('-');
    const lastDay = String(
      new Date(parseInt(yStr, 10), parseInt(mStr, 10), 0).getDate()
    ).padStart(2, '0');
    setStartDate(`${ym}-01`);
    setEndDate(`${ym}-${lastDay}`);
  };

  const formatMonthLabel = (ym: string) => {
    const [yStr, mStr] = ym.split('-');
    const date = new Date(parseInt(yStr, 10), parseInt(mStr, 10) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = allRecords.filter((rec) => {
      if (originFilter === 'sheet' && rec.sourceOrigin !== 'sheet') return false;
      if (originFilter === 'staged' && rec.sourceOrigin !== 'csv') return false;
      if (linkFilter === 'unrecon' && (rec.isRecon ?? 'No') === 'Yes') return false;
      if (linkFilter === 'recon' && (rec.isRecon ?? 'No') !== 'Yes') return false;
      if (linkFilter === 'unlinked' && rec.reconSourceId.trim() !== '') return false;
      if (linkFilter === 'linked' && rec.reconSourceId.trim() === '') return false;
      if (
        categoryFilter !== 'all' &&
        rec.category.toLowerCase() !== categoryFilter.toLowerCase()
      ) {
        return false;
      }
      if (
        statusFilter !== 'all' &&
        rec.status.toLowerCase() !== statusFilter.toLowerCase()
      ) {
        return false;
      }
      if (pujaFilter !== 'all' && rec.puja.toLowerCase() !== pujaFilter.toLowerCase()) {
        return false;
      }
      if (
        paymentModeFilter !== 'all' &&
        rec.paymentMode.toLowerCase() !== paymentModeFilter.toLowerCase()
      ) {
        return false;
      }
      if (startDate && rec.date < startDate) return false;
      if (endDate && rec.date > endDate) return false;
      if (q) {
        const hay =
          `${rec.expId} ${rec.date} ${rec.category} ${rec.subCategory} ${rec.description} ${rec.status} ${rec.puja} ${rec.paymentMode} ${rec.reconSource} ${rec.reconSourceId} ${rec.isRecon}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...matched].sort((a, b) => {
      const cmp =
        dateSortOrder === 'desc'
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return b.expId.localeCompare(a.expId);
    });
  }, [
    allRecords,
    originFilter,
    linkFilter,
    categoryFilter,
    statusFilter,
    pujaFilter,
    paymentModeFilter,
    startDate,
    endDate,
    searchQuery,
    dateSortOrder,
  ]);

  const expenseTotals = useMemo(() => {
    let totalCents = 0;
    let paidCents = 0;
    let acceptedCents = 0;
    for (const rec of filteredRecords) {
      const cents = Math.round(rec.amount * 100);
      totalCents += cents;
      const st = rec.status.trim().toLowerCase();
      if (st === 'paid') paidCents += cents;
      if (st === 'accepted') acceptedCents += cents;
    }
    return {
      total: totalCents / 100,
      paid: paidCents / 100,
      accepted: acceptedCents / 100,
    };
  }, [filteredRecords]);

  const categorySummaries = useMemo(() => {
    const map = new Map<string, { category: string; count: number; totalCents: number }>();
    const q = searchQuery.trim().toLowerCase();

    for (const rec of allRecords) {
      if (originFilter === 'sheet' && rec.sourceOrigin !== 'sheet') continue;
      if (originFilter === 'staged' && rec.sourceOrigin !== 'csv') continue;
      if (statusFilter !== 'all' && rec.status.toLowerCase() !== statusFilter.toLowerCase()) {
        continue;
      }
      if (pujaFilter !== 'all' && rec.puja.toLowerCase() !== pujaFilter.toLowerCase()) continue;
      if (
        paymentModeFilter !== 'all' &&
        rec.paymentMode.toLowerCase() !== paymentModeFilter.toLowerCase()
      ) {
        continue;
      }
      if (startDate && rec.date < startDate) continue;
      if (endDate && rec.date > endDate) continue;
      if (q) {
        const hay =
          `${rec.expId} ${rec.date} ${rec.category} ${rec.subCategory} ${rec.description} ${rec.status} ${rec.puja} ${rec.paymentMode} ${rec.reconSource} ${rec.reconSourceId}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const cat = rec.category || 'Uncategorized';
      const entry = map.get(cat) ?? { category: cat, count: 0, totalCents: 0 };
      entry.count++;
      entry.totalCents += Math.round(rec.amount * 100);
      map.set(cat, entry);
    }

    return Array.from(map.values())
      .map((item) => ({
        category: item.category,
        count: item.count,
        total: item.totalCents / 100,
      }))
      .sort((a, b) => b.total - a.total);
  }, [
    allRecords,
    originFilter,
    statusFilter,
    pujaFilter,
    paymentModeFilter,
    startDate,
    endDate,
    searchQuery,
  ]);

  const unreconCategorySummary = useMemo(() => {
    const map = new Map<string, { category: string; count: number; totalCents: number }>();
    const unreconRecords: ExpenseRecord[] = [];
    const q = searchQuery.trim().toLowerCase();
    let totalCount = 0;
    let totalCents = 0;

    for (const rec of allRecords) {
      if (originFilter === 'sheet' && rec.sourceOrigin !== 'sheet') continue;
      if (originFilter === 'staged' && rec.sourceOrigin !== 'csv') continue;
      if ((rec.isRecon ?? 'No') === 'Yes') continue;
      if (statusFilter !== 'all' && rec.status.toLowerCase() !== statusFilter.toLowerCase()) {
        continue;
      }
      if (pujaFilter !== 'all' && rec.puja.toLowerCase() !== pujaFilter.toLowerCase()) continue;
      if (
        paymentModeFilter !== 'all' &&
        rec.paymentMode.toLowerCase() !== paymentModeFilter.toLowerCase()
      ) {
        continue;
      }
      if (startDate && rec.date < startDate) continue;
      if (endDate && rec.date > endDate) continue;
      if (q) {
        const hay =
          `${rec.expId} ${rec.date} ${rec.category} ${rec.subCategory} ${rec.description} ${rec.status} ${rec.puja} ${rec.paymentMode} ${rec.reconSource} ${rec.reconSourceId} ${rec.isRecon}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const cents = Math.round(rec.amount * 100);
      const cat = rec.category || 'Uncategorized';
      const entry = map.get(cat) ?? { category: cat, count: 0, totalCents: 0 };
      entry.count++;
      entry.totalCents += cents;
      map.set(cat, entry);

      unreconRecords.push(rec);
      totalCount++;
      totalCents += cents;
    }

    const items = Array.from(map.values())
      .map((item) => ({
        category: item.category,
        count: item.count,
        total: item.totalCents / 100,
      }))
      .sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return a.category.localeCompare(b.category);
      });

    return {
      items,
      records: unreconRecords,
      totalCount,
      totalAmount: totalCents / 100,
      activeCategoryCount: items.length,
    };
  }, [
    allRecords,
    originFilter,
    statusFilter,
    pujaFilter,
    paymentModeFilter,
    startDate,
    endDate,
    searchQuery,
  ]);

  const exportRecordsCsv = (rows: ExpenseRecord[], fileName: string) => {
    if (rows.length === 0) return;

    const escapeCsv = (val: string | number) => {
      const s = String(val);
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      CANONICAL_EXPENSE_HEADERS.join(','),
      ...rows.map((rec) =>
        [
          rec.expId,
          rec.date,
          rec.amount.toFixed(2),
          rec.category,
          rec.subCategory,
          rec.description,
          rec.status,
          rec.puja,
          rec.paymentMode,
          rec.reconSource,
          rec.reconSourceId,
          rec.isRecon || 'No',
        ]
          .map(escapeCsv)
          .join(',')
      ),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    exportRecordsCsv(filteredRecords, 'expense-ledger-export.csv');
  };

  const handleExportUnreconCsv = () => {
    const sorted = [...unreconCategorySummary.records].sort((a, b) => {
      const cmp =
        dateSortOrder === 'desc'
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return b.expId.localeCompare(a.expId);
    });
    exportRecordsCsv(sorted, 'expense-ledger-unrecon-expenses.csv');
  };

  const resetFilters = () => {
    setOriginFilter('all');
    setLinkFilter('all');
    setSearchQuery('');
    setCategoryFilter('all');
    setStatusFilter('all');
    setPujaFilter('all');
    setPaymentModeFilter('all');
    setStartDate('');
    setEndDate('');
  };

  const unmappedCsvs = uploadedCsvs.filter((f) => f.mappingStatus === 'needs-mapping');
  const editingCsv = uploadedCsvs.find((f) => f.id === editingCsvId) ?? null;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${EXPENSE_SPREADSHEET_ID}/edit`;

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      {/* Left Configuration & Action Sidebar */}
      <aside className="w-full shrink-0 border-b border-slate-200 bg-white p-5 lg:w-[290px] lg:border-r lg:border-b-0">
        <div className="space-y-6">
          {/* 01. Target Expense Sheet */}
          <section>
            <h2 className="text-xs font-semibold tracking-tight text-slate-900">
              01. Expense_Ledger Sheet
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Connected to Expense_Ledger with dynamic LookUp &amp; CatSubcat dropdowns.
            </p>

            <div className="mt-3 space-y-2 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
              <div className="flex items-center justify-between">
                <span>Spreadsheet ID</span>
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-slate-700 underline decoration-slate-300 hover:text-teal-700"
                  title={EXPENSE_SPREADSHEET_ID}
                >
                  {EXPENSE_SPREADSHEET_ID.slice(0, 8)}...{EXPENSE_SPREADSHEET_ID.slice(-4)}
                </a>
              </div>
              {sheetMeta && (
                <>
                  <div className="flex items-center justify-between">
                    <span>Ledger Tab</span>
                    <span className="font-mono text-slate-700">{sheetMeta.ledgerTabName}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>LookUp · CatSubcat</span>
                    <span className="font-mono text-slate-700">
                      {sheetMeta.lookUpTabName || '—'} · {sheetMeta.catSubcatTabName || '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Mapped Categories</span>
                    <span className="font-mono text-slate-700 tabular-nums">
                      {Object.keys(lookups.catSubcatMap).length.toLocaleString()}
                    </span>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => void loadWorkspace()}
              disabled={needsAuth || isLoadingSheet || isSubmitting}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 shrink-0 ${isLoadingSheet ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {isLoadingSheet ? 'Loading Expense Ledger...' : 'Refresh Expense Ledger'}
            </button>
          </section>

          {/* 02. Option 1: Bulk Upload Expense CSV */}
          <section className="border-t border-slate-200 pt-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold tracking-tight text-slate-900">
                02. Bulk Expense CSV
              </h2>
              {uploadedCsvs.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearCsvs}
                  className="text-[11px] font-medium text-slate-500 hover:text-red-700 whitespace-nowrap"
                >
                  Clear All
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Filters for Request Type &ldquo;Actual&rdquo; with Status &ldquo;Accepted&rdquo;
              or &ldquo;Paid&rdquo; and deduplicates by Exp_ID.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              multiple
              onChange={handleFileInputChange}
              className="sr-only"
              aria-label="Upload expense tracker CSV files"
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={`mt-3 flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-5 text-center transition-colors ${
                isDragging
                  ? 'border-teal-600 bg-teal-50/50'
                  : 'border-slate-300 bg-slate-50/60 hover:border-slate-400 hover:bg-slate-50'
              }`}
            >
              <Upload className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <span className="mt-2 text-xs font-medium text-slate-800">
                Drop expense tracker CSV
              </span>
              <span className="mt-0.5 text-[11px] text-slate-500">
                or click to browse files
              </span>
            </div>

            {uploadedCsvs.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                {uploadedCsvs.map((f) => (
                  <li key={f.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <FileText
                            className="h-3.5 w-3.5 shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                          <span
                            className="truncate text-xs font-medium text-slate-800"
                            title={f.fileName}
                          >
                            {f.fileName}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span className="font-mono tabular-nums">
                            {f.rawRows.length.toLocaleString()} rows
                          </span>
                          <span aria-hidden="true">·</span>
                          {f.mappingStatus === 'needs-mapping' ? (
                            <span className="font-medium text-amber-700">Needs mapping</span>
                          ) : f.mappingStatus === 'manual' ? (
                            <span className="text-teal-700">Mapped manually</span>
                          ) : (
                            <span className="text-emerald-700">Auto-mapped</span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveCsv(f.id)}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                        aria-label={`Remove ${f.fileName}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingCsvId(f.id)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-teal-700"
                    >
                      <Columns3 className="h-3 w-3" aria-hidden="true" />
                      {f.mappingStatus === 'needs-mapping'
                        ? 'Configure Column Mapping'
                        : 'Edit Column Mapping'}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={handleStartBulkSync}
              disabled={
                uploadedCsvs.length === 0 || isLoadingSheet || isProcessingCsv || isSubmitting
              }
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-teal-700 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-4 w-4 shrink-0" aria-hidden="true" />
              Sync Staged CSV to Expense_Ledger
            </button>
          </section>

          {/* 03. Option 2: Manual Expense Entry */}
          <section className="border-t border-slate-200 pt-5">
            <h2 className="text-xs font-semibold tracking-tight text-slate-900">
              03. Manual Expense Entry
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Key in an expense item with auto-generated Exp_ID and LookUp dropdowns.
            </p>
            <button
              type="button"
              onClick={handleOpenManualEntry}
              disabled={isLoadingSheet || isSubmitting}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-teal-700" aria-hidden="true" />
              Add Expense Manually
            </button>
          </section>
        </div>
      </aside>

      {/* Main Expense Ledger Viewport */}
      <main className="min-w-0 flex-1 p-6">
        <div className="mx-auto max-w-[1200px] space-y-5">
          {/* Header Row */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>Expenses</span>
                <span aria-hidden="true">/</span>
                <span className="font-medium text-slate-800">
                  {sheetMeta?.ledgerTabName || 'Expense_Ledger'}
                </span>
                <span aria-hidden="true">·</span>
                <span>Bulk Upload &amp; Manual Entry</span>
              </div>
              <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900">
                Expense Ledger Processing &amp; Editor
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {onOpenReconcile && (
                <button
                  type="button"
                  onClick={onOpenReconcile}
                  disabled={needsAuth || isLoadingSheet || isSubmitting}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  Reconcile with Bank Ledger
                </button>
              )}

              <button
                type="button"
                onClick={handleOpenManualEntry}
                disabled={isLoadingSheet || isSubmitting}
                className="inline-flex items-center gap-1.5 rounded-md bg-teal-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Expense
              </button>

              {unreconCategorySummary.totalCount > 0 && (
                <button
                  type="button"
                  onClick={handleExportUnreconCsv}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  Export Unrecon Expenses CSV
                </button>
              )}

              {filteredRecords.length > 0 && (
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Export Expense CSV
                </button>
              )}
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
                  aria-label="Select Expense Month Period"
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
                <label htmlFor="exp-period-start" className="text-xs text-slate-500">
                  From
                </label>
                <input
                  id="exp-period-start"
                  type="date"
                  value={startDate}
                  min={dateBounds.minDate || undefined}
                  max={endDate || dateBounds.maxDate || undefined}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label htmlFor="exp-period-end" className="text-xs text-slate-500">
                  To
                </label>
                <input
                  id="exp-period-end"
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
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* KPI Summary Row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-white px-5 py-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Total Expenses</span>
                <Receipt className="h-4 w-4 text-slate-500" aria-hidden="true" />
              </div>
              <div className="mt-2 font-mono text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
                {expenseTotals.total.toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                })}
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                <span className="font-mono tabular-nums">
                  {filteredRecords.length.toLocaleString()}
                </span>{' '}
                {filteredRecords.length === 1 ? 'record' : 'records'}
                <span aria-hidden="true"> · </span>
                <span className="font-mono tabular-nums">{periodLabel}</span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-5 py-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">
                  Paid vs Accepted Breakdown
                </span>
                <span className="text-xs text-slate-500">Filtered View</span>
              </div>
              <div className="mt-2 flex items-baseline gap-6 font-mono tabular-nums">
                <div>
                  <div className="text-[11px] text-slate-500">Paid</div>
                  <div className="text-lg font-semibold text-emerald-700">
                    {expenseTotals.paid.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500">Accepted</div>
                  <div className="text-lg font-semibold text-teal-700">
                    {expenseTotals.accepted.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </div>
                </div>
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                Saved in Sheet:{' '}
                <span className="font-mono tabular-nums">
                  {sheetRecords.length.toLocaleString()}
                </span>
                <span aria-hidden="true"> · </span>
                Staged CSV:{' '}
                <span className="font-mono tabular-nums">
                  {effectiveStagedRecords.length.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* Summary by Category Cards */}
          {categorySummaries.length > 0 && (
            <section aria-label="Summary by Category" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <h2 className="font-semibold text-slate-900">Summary by Category</h2>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono text-slate-500 tabular-nums">
                    {categorySummaries.length}{' '}
                    {categorySummaries.length === 1 ? 'category' : 'categories'}
                  </span>
                </div>
                {categoryFilter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setCategoryFilter('all')}
                    className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                  >
                    Show All Categories
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {categorySummaries.map((item) => {
                  const isSelected =
                    categoryFilter.toLowerCase() === item.category.toLowerCase() &&
                    linkFilter !== 'unrecon';
                  return (
                    <button
                      key={item.category}
                      type="button"
                      onClick={() => {
                        if (
                          categoryFilter.toLowerCase() === item.category.toLowerCase() &&
                          linkFilter !== 'unrecon'
                        ) {
                          setCategoryFilter('all');
                        } else {
                          setCategoryFilter(item.category);
                          if (linkFilter === 'unrecon') {
                            setLinkFilter('all');
                          }
                        }
                      }}
                      aria-pressed={isSelected}
                      className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                        isSelected
                          ? 'border-teal-700 bg-teal-50/40 ring-1 ring-teal-700/20'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-slate-900">
                          {item.category}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
                          {item.count.toLocaleString()}{' '}
                          {item.count === 1 ? 'item' : 'items'}
                        </span>
                      </div>
                      <div className="mt-1.5 font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {item.total.toLocaleString('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        })}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Summary by Category (Unrecon Expenses) Cards */}
          {allRecords.length > 0 && (
            <section
              aria-label="Summary by Category (Unrecon Expenses)"
              className="space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <h2 className="font-semibold text-slate-900">
                    Summary by Category (Unrecon Expenses)
                  </h2>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono text-slate-500 tabular-nums">
                    {unreconCategorySummary.activeCategoryCount}{' '}
                    {unreconCategorySummary.activeCategoryCount === 1
                      ? 'category'
                      : 'categories'}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono text-slate-700 tabular-nums">
                    {unreconCategorySummary.totalCount.toLocaleString()}{' '}
                    {unreconCategorySummary.totalCount === 1 ? 'item' : 'items'} ·{' '}
                    {unreconCategorySummary.totalAmount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono text-slate-500 tabular-nums">{periodLabel}</span>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {unreconCategorySummary.totalCount > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={handleExportUnreconCsv}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        <Download className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                        Export Unrecon CSV
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (linkFilter === 'unrecon' && categoryFilter === 'all') {
                            setLinkFilter('all');
                          } else {
                            setLinkFilter('unrecon');
                            setCategoryFilter('all');
                          }
                        }}
                        className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                      >
                        {linkFilter === 'unrecon' && categoryFilter === 'all'
                          ? 'Show All Records'
                          : 'Filter Table to Unrecon'}
                      </button>
                    </>
                  )}
                  {linkFilter === 'unrecon' && categoryFilter !== 'all' && (
                    <button
                      type="button"
                      onClick={() => {
                        setLinkFilter('all');
                        setCategoryFilter('all');
                      }}
                      className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                    >
                      Reset Unrecon Filter
                    </button>
                  )}
                </div>
              </div>

              {unreconCategorySummary.items.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
                  All expense records in this view have Is_Recon = &ldquo;Yes&rdquo;.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {unreconCategorySummary.items.map((item) => {
                    const isSelected =
                      linkFilter === 'unrecon' &&
                      categoryFilter.toLowerCase() === item.category.toLowerCase();
                    const sharePct =
                      unreconCategorySummary.totalAmount > 0
                        ? (item.total / unreconCategorySummary.totalAmount) * 100
                        : 0;

                    return (
                      <button
                        key={`unrecon-${item.category}`}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            setLinkFilter('all');
                            setCategoryFilter('all');
                          } else {
                            setLinkFilter('unrecon');
                            setCategoryFilter(item.category);
                          }
                        }}
                        aria-pressed={isSelected}
                        className={`rounded-lg border px-4 py-3.5 text-left transition-colors ${
                          isSelected
                            ? 'border-teal-700 bg-teal-50/40 ring-1 ring-teal-700/20'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-slate-900">
                            {item.category}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
                            {item.count.toLocaleString()}{' '}
                            {item.count === 1 ? 'item' : 'items'}
                          </span>
                        </div>

                        <div className="mt-2 font-mono text-base font-semibold tracking-tight text-red-700 tabular-nums">
                          {item.total.toLocaleString('en-US', {
                            style: 'currency',
                            currency: 'USD',
                          })}
                        </div>

                        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 font-mono text-[11px] text-slate-500 tabular-nums">
                          <span>{sharePct.toFixed(1)}% of unrecon</span>
                          <span>Is_Recon = No</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Pipeline Metrics Strip */}
          <div className="grid grid-cols-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-5 sm:divide-x sm:divide-y-0">
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Raw CSV Rows</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-900 tabular-nums">
                {stagedSummary.totalRawRows.toLocaleString()}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Filtered Out</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-700 tabular-nums">
                {stagedSummary.filteredOutByTypeOrStatus.toLocaleString()}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Duplicate IDs Removed</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-700 tabular-nums">
                {stagedSummary.duplicateIdsRemoved.toLocaleString()}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Ready to Sync</div>
              <div className="mt-1 font-mono text-lg font-semibold text-teal-700 tabular-nums">
                {effectiveStagedRecords.length.toLocaleString()}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Saved in Sheet</div>
              <div className="mt-1 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
                {sheetRecords.length.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Alerts */}
          {errorMessage && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
                <span>{errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="font-medium text-red-800 hover:underline whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}

          {statusMessage && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-950">
              <div className="flex items-center gap-2">
                <CheckCircle2
                  className="h-4 w-4 shrink-0 text-emerald-700"
                  aria-hidden="true"
                />
                <span>{statusMessage}</span>
              </div>
              <a
                href={sheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-emerald-800 underline hover:text-emerald-950 whitespace-nowrap"
              >
                Open Expense_Ledger
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          )}

          {externalStatusMessage && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-950">
              <div className="flex items-center gap-2">
                <CheckCircle2
                  className="h-4 w-4 shrink-0 text-emerald-700"
                  aria-hidden="true"
                />
                <span>{externalStatusMessage}</span>
              </div>
              {onDismissExternalStatus && (
                <button
                  type="button"
                  onClick={onDismissExternalStatus}
                  className="font-medium text-emerald-800 hover:underline whitespace-nowrap"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {unmappedCsvs.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950">
              <div className="flex items-center gap-2">
                <AlertTriangle
                  className="h-4 w-4 shrink-0 text-amber-700"
                  aria-hidden="true"
                />
                <span>
                  {unmappedCsvs.length} uploaded CSV file(s) need column mapping:{' '}
                  <strong>{unmappedCsvs.map((f) => f.fileName).join(', ')}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditingCsvId(unmappedCsvs[0].id)}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 whitespace-nowrap"
              >
                Map Columns
              </button>
            </div>
          )}

          {/* Expense Ledger Table Surface */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-1">
                {(
                  [
                    { id: 'all', label: `All (${allRecords.length})` },
                    { id: 'sheet', label: `In Sheet (${sheetRecords.length})` },
                    { id: 'staged', label: `Staged CSV (${effectiveStagedRecords.length})` },
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

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search Exp_ID, description..."
                    className="w-52 rounded-md border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                </div>

                <select
                  value={linkFilter}
                  onChange={(e) => setLinkFilter(e.target.value as ExpenseLinkFilter)}
                  aria-label="Filter by Reconciliation or Link Status"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Recon States</option>
                  <option value="unrecon">Unrecon Expenses (Is_Recon = No)</option>
                  <option value="recon">Reconciled Expenses (Is_Recon = Yes)</option>
                  <option value="unlinked">Unlinked to Bank</option>
                  <option value="linked">Linked to Bank</option>
                </select>

                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by Category"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Categories</option>
                  {filterOptions.categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by Status"
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                >
                  <option value="all">All Statuses</option>
                  {filterOptions.statuses.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>

                {filterOptions.pujas.length > 0 && (
                  <select
                    value={pujaFilter}
                    onChange={(e) => setPujaFilter(e.target.value)}
                    aria-label="Filter by Puja"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="all">All Pujas</option>
                    {filterOptions.pujas.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                )}

                {filterOptions.paymentModes.length > 0 && (
                  <select
                    value={paymentModeFilter}
                    onChange={(e) => setPaymentModeFilter(e.target.value)}
                    aria-label="Filter by Payment Mode"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="all">All Payment Modes</option>
                    {filterOptions.paymentModes.map((pm) => (
                      <option key={pm} value={pm}>
                        {pm}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <ExpenseLedgerGrid
              records={filteredRecords}
              hasUploadedCsv={uploadedCsvs.length > 0}
              isLoading={isLoadingSheet || isProcessingCsv}
              needsAuth={needsAuth}
              isLoggingIn={isLoggingIn}
              dateSortOrder={dateSortOrder}
              updatingReconExpId={updatingReconExpId}
              onSignIn={onSignIn}
              onToggleDateSort={() =>
                setDateSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
              }
              onEditRecord={handleOpenEditRecord}
              onUpdateIsRecon={handleUpdateExpenseIsRecon}
              onTriggerUpload={() => fileInputRef.current?.click()}
              onOpenManualEntry={handleOpenManualEntry}
              onResetFilters={resetFilters}
            />
          </div>
        </div>
      </main>

      {/* Modals */}
      <ExpenseCsvMappingModal
        csvFile={editingCsv}
        onClose={() => setEditingCsvId(null)}
        onSave={handleSaveCsvMapping}
      />

      <ExpenseEntryModal
        isOpen={entryModalState.isOpen}
        mode={entryModalState.mode}
        initialRecord={entryModalState.record}
        lookups={lookups}
        existingIds={allKnownIds}
        onClose={() =>
          setEntryModalState({ isOpen: false, mode: 'create', record: null })
        }
        onSubmit={handleEntryModalSubmit}
      />

      <ExpenseConfirmModal
        action={pendingMutation}
        meta={sheetMeta}
        isSubmitting={isSubmitting}
        onCancel={() => setPendingMutation(null)}
        onConfirm={handleConfirmMutation}
      />
    </div>
  );
};
