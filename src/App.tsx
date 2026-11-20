import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  Columns3,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  LogOut,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  AccountType,
  ColumnMapping,
  NormalizedTransaction,
  PipelineSummary,
  SyncPlan,
  SyncResult,
  UploadedStatement,
} from './types/statement';
import { detectColumnMapping, parseCsvText } from './utils/csvParser';
import { processStatements } from './utils/statementProcessor';
import {
  clearCachedToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from './services/firebaseAuth';
import {
  BankSheetColumnLayout,
  batchUpdateBankReconciliation,
  executeSyncPlan,
  fetchSheetLedger,
  prepareSyncPlan,
  SHEET_HEADERS,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from './services/googleSheets';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { ColumnMappingModal } from './components/ColumnMappingModal';
import { SyncConfirmModal } from './components/SyncConfirmModal';
import { TransactionGrid } from './components/TransactionGrid';
import {
  BankTransactionEditModal,
  BankTransactionEditPayload,
} from './components/BankTransactionEditModal';
import { ReconcileCompleteSummary, ReconcileModal } from './components/ReconcileModal';
import { ExpenseModule } from './components/expense/ExpenseModule';
import { ChatbotModule } from './components/chatbot/ChatbotModule';
import { CheckModule } from './components/checks/CheckModule';
import {
  batchUpdateExpenseReconIds,
  EXPENSE_SPREADSHEET_ID,
  fetchExpenseCategories,
  fetchExpenseWorkspace,
} from './services/expenseSheets';
import { CHECK_SPREADSHEET_ID } from './services/checkSheets';
import { BankLedgerEntry, findLinkedSyncUpdates } from './utils/reconciler';

type ActiveModule = 'statements' | 'expenses' | 'checks' | 'chatbot';
type StatusFilter = 'all' | 'ready' | 'review' | 'discarded' | 'in-sheet';
type TypeFilter = 'all' | 'Income' | 'Expense';
type LinkFilter =
  | 'all'
  | 'unrecon-expenses'
  | 'recon-expenses'
  | 'unlinked-expenses'
  | 'linked-expenses';

const EMPTY_SUMMARY: PipelineSummary = {
  totalRawRows: 0,
  validParsedRows: 0,
  skippedInvalidRows: 0,
  crossFileDuplicatesRemoved: 0,
  flaggedForReview: 0,
  keptDistinct: 0,
  discarded: 0,
  readyToSync: 0,
  alreadyInSheet: 0,
  newlySynced: 0,
};

const SOURCE_CARD_ROWS: string[][] = [
  ['Check', 'Cash', 'Direct Pay-Payment', 'Zelle'],
  ['Amazon', 'Home Depot', 'CARD9130', 'CARD7574'],
  ['Deposit', 'Stripe', 'SumUp', 'WT'],
  ['Transfer', 'Other'],
];

const CONFIGURED_SOURCE_SET = new Set(SOURCE_CARD_ROWS.flat());

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Active Workspace Module
  const [activeModule, setActiveModule] = useState<ActiveModule>('statements');

  // Auth state (token strictly cached in memory inside firebaseAuth.ts)
  const [user, setUser] = useState<User | null>(null);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Account & Uploaded Statements
  const [account, setAccount] = useState<AccountType>('Puja');
  const [statements, setStatements] = useState<UploadedStatement[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [editingStatementId, setEditingStatementId] = useState<string | null>(null);

  // Processing & Review State
  const [resolutions, setResolutions] = useState<
    Record<string, 'kept-distinct' | 'discarded'>
  >({});
  const [existingIdsByAccount, setExistingIdsByAccount] = useState<
    Record<AccountType, Set<string>>
  >({
    Puja: new Set(),
    Regular: new Set(),
  });
  const [newlySyncedIdsByAccount, setNewlySyncedIdsByAccount] = useState<
    Record<AccountType, Set<string>>
  >({
    Puja: new Set(),
    Regular: new Set(),
  });
  const [sheetTransactionsByAccount, setSheetTransactionsByAccount] = useState<
    Record<AccountType, NormalizedTransaction[]>
  >({
    Puja: [],
    Regular: [],
  });
  const [loadedAccounts, setLoadedAccounts] = useState<Record<AccountType, boolean>>({
    Puja: false,
    Regular: false,
  });
  const inFlightAccountsRef = useRef<Record<AccountType, boolean>>({
    Puja: false,
    Regular: false,
  });

  const [sheetLayoutByAccount, setSheetLayoutByAccount] = useState<
    Record<AccountType, BankSheetColumnLayout>
  >({
    Puja: {
      hasTargetIdHeader: false,
      targetIdColIndex: 7,
      hasIsReconHeader: false,
      isReconColIndex: 8,
      hasCategoryHeader: false,
      categoryColIndex: 9,
    },
    Regular: {
      hasTargetIdHeader: false,
      targetIdColIndex: 7,
      hasIsReconHeader: false,
      isReconColIndex: 8,
      hasCategoryHeader: false,
      categoryColIndex: 9,
    },
  });
  const [expenseCategories, setExpenseCategories] = useState<string[]>([]);
  const [bankFieldOverrides, setBankFieldOverrides] = useState<
    Record<string, Partial<BankTransactionEditPayload>>
  >({});
  const [savingBankRowKey, setSavingBankRowKey] = useState<string | null>(null);
  const [editingBankTx, setEditingBankTx] = useState<NormalizedTransaction | null>(null);
  const [isSavingBankModal, setIsSavingBankModal] = useState(false);
  const hasAutoSyncedLinkedRef = useRef(false);
  const syncLinkedInFlightRef = useRef(false);

  const [csvTransactions, setCsvTransactions] = useState<NormalizedTransaction[]>([]);
  const [summary, setSummary] = useState<PipelineSummary>(EMPTY_SUMMARY);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  // Filters & Sort
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [linkFilter, setLinkFilter] = useState<LinkFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateSortOrder, setDateSortOrder] = useState<'desc' | 'asc'>('desc');

  // Google Sheets Sync State
  const [isPreparingSync, setIsPreparingSync] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingSyncPlan, setPendingSyncPlan] = useState<SyncPlan | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [reconcileModalOpen, setReconcileModalOpen] = useState(false);
  const [expenseRefreshNonce, setExpenseRefreshNonce] = useState(0);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadSheetLedger = useCallback(
    async (targetAccount: AccountType, explicitToken?: string) => {
      if (inFlightAccountsRef.current[targetAccount]) return;

      const token = explicitToken ?? (await getAccessToken());
      if (!token) {
        setNeedsAuth(true);
        return;
      }

      inFlightAccountsRef.current[targetAccount] = true;
      setIsLoadingSheet(true);
      setErrorMessage(null);
      try {
        const loaded = await fetchSheetLedger(token, TARGET_SPREADSHEET_ID, targetAccount);
        setSheetTransactionsByAccount((prev) => ({
          ...prev,
          [targetAccount]: loaded.transactions,
        }));
        setSheetLayoutByAccount((prev) => ({
          ...prev,
          [targetAccount]: {
            hasTargetIdHeader: loaded.hasTargetIdHeader,
            targetIdColIndex: loaded.targetIdColIndex,
            hasIsReconHeader: loaded.hasIsReconHeader,
            isReconColIndex: loaded.isReconColIndex,
            hasCategoryHeader: loaded.hasCategoryHeader,
            categoryColIndex: loaded.categoryColIndex,
          },
        }));
        setExistingIdsByAccount((prev) => ({
          ...prev,
          [targetAccount]: loaded.existingIds,
        }));
        setLoadedAccounts((prev) => ({
          ...prev,
          [targetAccount]: true,
        }));
      } catch (err) {
        if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
          clearCachedToken();
          setNeedsAuth(true);
          setErrorMessage(
            'Your Google session expired or lacks permission for this spreadsheet. Please sign in with Google again.'
          );
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Unable to read target Google Sheet.'
          );
        }
      } finally {
        inFlightAccountsRef.current[targetAccount] = false;
        setIsLoadingSheet(false);
      }
    },
    []
  );

  const loadExpenseCategoriesList = useCallback(async (explicitToken?: string) => {
    const token = explicitToken ?? (await getAccessToken());
    if (!token) return;
    try {
      const cats = await fetchExpenseCategories(token, EXPENSE_SPREADSHEET_ID);
      setExpenseCategories(cats);
    } catch {
      // Non-blocking: Bank ledger still functions if LookUp tab cannot be read
    }
  }, []);

  const syncLinkedPairsAcrossSheets = useCallback(
    async (explicitToken?: string, options?: { silent?: boolean }) => {
      if (syncLinkedInFlightRef.current) return;
      const token = explicitToken ?? (await getAccessToken());
      if (!token) return;

      syncLinkedInFlightRef.current = true;
      try {
        const [pujaLoaded, regularLoaded, expenseWs] = await Promise.all([
          fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Puja'),
          fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Regular'),
          fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID),
        ]);

        const bankEntries: BankLedgerEntry[] = [
          ...pujaLoaded.transactions.map((tx) => ({ tab: 'Puja' as AccountType, tx })),
          ...regularLoaded.transactions.map((tx) => ({ tab: 'Regular' as AccountType, tx })),
        ];

        const plan = findLinkedSyncUpdates(bankEntries, expenseWs.records);
        const pujaPatches = plan.bankUpdatesByTab.Puja;
        const regularPatches = plan.bankUpdatesByTab.Regular;
        const expPatches = plan.expenseUpdates;

        let bankUpdated = 0;
        let expenseUpdated = 0;

        if (pujaPatches.length > 0) {
          bankUpdated += await batchUpdateBankReconciliation(
            token,
            TARGET_SPREADSHEET_ID,
            'Puja',
            pujaLoaded,
            pujaPatches
          );
        }
        if (regularPatches.length > 0) {
          bankUpdated += await batchUpdateBankReconciliation(
            token,
            TARGET_SPREADSHEET_ID,
            'Regular',
            regularLoaded,
            regularPatches
          );
        }
        if (expPatches.length > 0) {
          expenseUpdated = await batchUpdateExpenseReconIds(token, expenseWs.meta, expPatches);
        }

        const applyBankPatches = (
          rows: NormalizedTransaction[],
          patches: typeof pujaPatches
        ): NormalizedTransaction[] => {
          if (patches.length === 0) return rows;
          const byRow = new Map(patches.map((p) => [p.sheetRowNumber, p]));
          return rows.map((row) => {
            if (!row.sheetRowNumber) return row;
            const p = byRow.get(row.sheetRowNumber);
            if (!p) return row;
            return {
              ...row,
              targetId: p.targetId ?? row.targetId,
              isRecon: p.isRecon ?? row.isRecon,
              category: p.category ?? row.category,
            };
          });
        };

        const patchedPujaRows = applyBankPatches(pujaLoaded.transactions, pujaPatches);
        const patchedRegularRows = applyBankPatches(regularLoaded.transactions, regularPatches);

        setSheetTransactionsByAccount({
          Puja: patchedPujaRows,
          Regular: patchedRegularRows,
        });
        setSheetLayoutByAccount({
          Puja: {
            hasTargetIdHeader: pujaLoaded.hasTargetIdHeader || pujaPatches.length > 0,
            targetIdColIndex: pujaLoaded.targetIdColIndex,
            hasIsReconHeader: pujaLoaded.hasIsReconHeader || pujaPatches.length > 0,
            isReconColIndex: pujaLoaded.isReconColIndex,
            hasCategoryHeader: pujaLoaded.hasCategoryHeader || pujaPatches.length > 0,
            categoryColIndex: pujaLoaded.categoryColIndex,
          },
          Regular: {
            hasTargetIdHeader: regularLoaded.hasTargetIdHeader || regularPatches.length > 0,
            targetIdColIndex: regularLoaded.targetIdColIndex,
            hasIsReconHeader: regularLoaded.hasIsReconHeader || regularPatches.length > 0,
            isReconColIndex: regularLoaded.isReconColIndex,
            hasCategoryHeader: regularLoaded.hasCategoryHeader || regularPatches.length > 0,
            categoryColIndex: regularLoaded.categoryColIndex,
          },
        });
        setExistingIdsByAccount({
          Puja: pujaLoaded.existingIds,
          Regular: regularLoaded.existingIds,
        });
        setLoadedAccounts({ Puja: true, Regular: true });

        if (expenseWs.lookups.categories.length > 0) {
          setExpenseCategories(expenseWs.lookups.categories);
        }

        if (expenseUpdated > 0) {
          setExpenseRefreshNonce((n) => n + 1);
        }

        if (!options?.silent && (bankUpdated > 0 || expenseUpdated > 0)) {
          setReconcileMessage(
            `Enforced linked reconciliation rule: set Is_Recon="Yes" and synced Category across ${bankUpdated.toLocaleString()} Bank row(s) and ${expenseUpdated.toLocaleString()} Expense row(s).`
          );
        }
      } catch {
        // Non-blocking background rule enforcement; manual Reconcile remains available
      } finally {
        syncLinkedInFlightRef.current = false;
      }
    },
    []
  );

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser) => {
        setUser(authedUser);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  // Automatically load the selected account tab and Expense LookUp categories once authenticated
  useEffect(() => {
    if (!needsAuth && !loadedAccounts[account]) {
      void loadSheetLedger(account);
    }
  }, [account, needsAuth, loadedAccounts, loadSheetLedger]);

  useEffect(() => {
    if (!needsAuth) {
      void loadExpenseCategoriesList();
    }
  }, [needsAuth, loadExpenseCategoriesList]);

  useEffect(() => {
    if (!needsAuth && !hasAutoSyncedLinkedRef.current) {
      hasAutoSyncedLinkedRef.current = true;
      void syncLinkedPairsAcrossSheets();
    }
  }, [needsAuth, syncLinkedPairsAcrossSheets]);

  // Re-run normalization & SHA-256 ID pipeline whenever statements, account, or resolutions change
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (statements.length === 0) {
        setCsvTransactions([]);
        setSummary(EMPTY_SUMMARY);
        return;
      }
      setIsProcessing(true);
      try {
        const result = await processStatements(
          statements,
          resolutions,
          newlySyncedIdsByAccount[account],
          existingIdsByAccount[account]
        );
        if (!cancelled) {
          setCsvTransactions(result.transactions);
          setSummary(result.summary);
        }
      } finally {
        if (!cancelled) {
          setIsProcessing(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [statements, resolutions, account, newlySyncedIdsByAccount, existingIdsByAccount]);

  const effectiveCsvTransactions = useMemo<NormalizedTransaction[]>(() => {
    return csvTransactions.map((tx) => {
      const ov = bankFieldOverrides[tx.uniqueId];
      if (!ov) return tx;
      const nextTargetId = ov.targetId ?? tx.targetId ?? '';
      return {
        ...tx,
        description: ov.description ?? tx.description,
        referenceNumber: ov.referenceNumber ?? tx.referenceNumber,
        source: ov.source ?? tx.source,
        targetId: nextTargetId,
        isRecon: nextTargetId.trim() !== '' ? 'Yes' : (ov.isRecon ?? tx.isRecon ?? 'No'),
        category: ov.category ?? tx.category ?? '',
      };
    });
  }, [csvTransactions, bankFieldOverrides]);

  const transactions = useMemo<NormalizedTransaction[]>(() => {
    const sheetRows = sheetTransactionsByAccount[account];
    const newlySyncedSet = newlySyncedIdsByAccount[account];

    if (effectiveCsvTransactions.length === 0) {
      return sheetRows.map((tx) =>
        newlySyncedSet.has(tx.uniqueId) ? { ...tx, syncStatus: 'newly-synced' as const } : tx
      );
    }

    const sheetIdSet = new Set(sheetRows.map((tx) => tx.uniqueId));
    const merged: NormalizedTransaction[] = sheetRows.map((tx) =>
      newlySyncedSet.has(tx.uniqueId) ? { ...tx, syncStatus: 'newly-synced' as const } : tx
    );

    for (const csvTx of effectiveCsvTransactions) {
      if (!sheetIdSet.has(csvTx.uniqueId)) {
        merged.push(csvTx);
      }
    }

    return merged;
  }, [effectiveCsvTransactions, sheetTransactionsByAccount, newlySyncedIdsByAccount, account]);

  const { alreadyInSheetDisplayCount, newlySyncedDisplayCount } = useMemo(() => {
    let alreadyInSheet = 0;
    let newlySynced = 0;
    for (const tx of transactions) {
      if (tx.reviewStatus === 'discarded') continue;
      if (tx.syncStatus === 'newly-synced') {
        newlySynced++;
      } else if (tx.syncStatus === 'already-in-sheet') {
        alreadyInSheet++;
      }
    }
    return {
      alreadyInSheetDisplayCount: alreadyInSheet,
      newlySyncedDisplayCount: newlySynced,
    };
  }, [transactions]);

  const handleSignIn = async () => {
    setIsLoggingIn(true);
    setErrorMessage(null);
    try {
      const res = await googleSignIn();
      if (res) {
        hasAutoSyncedLinkedRef.current = true;
        setUser(res.user);
        setNeedsAuth(false);
        await Promise.all([
          loadSheetLedger(account, res.accessToken),
          loadExpenseCategoriesList(res.accessToken),
        ]);
        void syncLinkedPairsAcrossSheets(res.accessToken);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      setErrorMessage(msg);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    hasAutoSyncedLinkedRef.current = false;
    setUser(null);
    setNeedsAuth(true);
    setPendingSyncPlan(null);
    setSheetTransactionsByAccount({ Puja: [], Regular: [] });
    setLoadedAccounts({ Puja: false, Regular: false });
    setExistingIdsByAccount({ Puja: new Set(), Regular: new Set() });
    setNewlySyncedIdsByAccount({ Puja: new Set(), Regular: new Set() });
    setExpenseCategories([]);
    setBankFieldOverrides({});
    setSavingBankRowKey(null);
    setEditingBankTx(null);
    setIsSavingBankModal(false);
    setSyncResult(null);
    setErrorMessage(null);
  };

  const ingestFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) => f.name.toLowerCase().endsWith('.csv') || f.type.includes('csv') || f.type === ''
    );
    if (files.length === 0) {
      setErrorMessage('Please select valid .csv bank statement files.');
      return;
    }

    setErrorMessage(null);
    setSyncResult(null);

    const parsed: UploadedStatement[] = [];
    for (const file of files) {
      const text = await file.text();
      const { headers, rows, skippedPreambleLines } = parseCsvText(text);
      if (headers.length === 0 || rows.length === 0) {
        setErrorMessage(`"${file.name}" appears to be empty or has no readable rows.`);
        continue;
      }
      const detected = detectColumnMapping(headers);
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
      setStatements((prev) => [...prev, ...parsed]);
    }
  }, []);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await ingestFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await ingestFiles(e.dataTransfer.files);
    }
  };

  const handleRemoveStatement = (id: string) => {
    setStatements((prev) => prev.filter((s) => s.id !== id));
    setSyncResult(null);
  };

  const handleClearStatements = () => {
    setStatements([]);
    setResolutions({});
    setSyncResult(null);
    setErrorMessage(null);
  };

  const handleSaveMapping = (statementId: string, mapping: ColumnMapping) => {
    setStatements((prev) =>
      prev.map((stmt) =>
        stmt.id === statementId
          ? { ...stmt, mapping, mappingStatus: 'manual' }
          : stmt
      )
    );
  };

  const handleResolveFlag = (
    flagKey: string,
    decision: 'kept-distinct' | 'discarded' | 'reset'
  ) => {
    setResolutions((prev) => {
      const next = { ...prev };
      if (decision === 'reset') {
        delete next[flagKey];
      } else {
        next[flagKey] = decision;
      }
      return next;
    });
  };

  const handleBulkResolveFlagged = (decision: 'kept-distinct' | 'discarded') => {
    setResolutions((prev) => {
      const next = { ...prev };
      for (const tx of csvTransactions) {
        if (tx.reviewStatus === 'flagged-duplicate') {
          next[tx.flagKey] = decision;
        }
      }
      return next;
    });
  };

  const handleRefreshSheetLedger = async () => {
    setErrorMessage(null);
    const token = await getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      setErrorMessage('Please sign in with Google to load existing Google Sheet records.');
      return;
    }
    await loadSheetLedger(account, token);
    await loadExpenseCategoriesList(token);
    await syncLinkedPairsAcrossSheets(token);
  };

  const handleUpdateBankInlineField = async (
    tx: NormalizedTransaction,
    patch: { category?: string }
  ) => {
    if (!tx.sheetRowNumber) {
      setBankFieldOverrides((prev) => ({
        ...prev,
        [tx.uniqueId]: {
          ...prev[tx.uniqueId],
          ...patch,
        },
      }));
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      setErrorMessage('Sign in with Google to save changes to Bank_Ledger.');
      return;
    }

    const prevRows = sheetTransactionsByAccount[account];
    setSavingBankRowKey(tx.rowKey);
    setErrorMessage(null);
    setSheetTransactionsByAccount((prev) => ({
      ...prev,
      [account]: prev[account].map((row) =>
        row.rowKey === tx.rowKey
          ? {
              ...row,
              category: patch.category ?? row.category,
            }
          : row
      ),
    }));

    try {
      await batchUpdateBankReconciliation(
        token,
        TARGET_SPREADSHEET_ID,
        account,
        sheetLayoutByAccount[account],
        [
          {
            sheetRowNumber: tx.sheetRowNumber,
            ...patch,
          },
        ]
      );
      setSheetLayoutByAccount((prev) => ({
        ...prev,
        [account]: {
          ...prev[account],
          hasTargetIdHeader: true,
          hasIsReconHeader: true,
          hasCategoryHeader: true,
        },
      }));
    } catch (err) {
      setSheetTransactionsByAccount((prev) => ({
        ...prev,
        [account]: prevRows,
      }));
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        setNeedsAuth(true);
        setErrorMessage('Google session expired while saving Bank_Ledger changes. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to update Bank_Ledger cell in Google Sheets.'
        );
      }
    } finally {
      setSavingBankRowKey(null);
    }
  };

  const handleSaveBankTransactionEdit = async (
    tx: NormalizedTransaction,
    updates: BankTransactionEditPayload
  ) => {
    const normalizedUpdates: BankTransactionEditPayload = {
      ...updates,
      isRecon: updates.targetId.trim() !== '' ? 'Yes' : updates.isRecon,
    };

    if (!tx.sheetRowNumber) {
      setBankFieldOverrides((prev) => ({
        ...prev,
        [tx.uniqueId]: {
          ...prev[tx.uniqueId],
          ...normalizedUpdates,
        },
      }));
      setEditingBankTx(null);
      setReconcileMessage(`Updated staged transaction ${tx.uniqueId}.`);
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      setErrorMessage('Sign in with Google to save changes to Bank_Ledger.');
      return;
    }

    const prevRows = sheetTransactionsByAccount[account];
    setIsSavingBankModal(true);
    setSavingBankRowKey(tx.rowKey);
    setErrorMessage(null);
    setSheetTransactionsByAccount((prev) => ({
      ...prev,
      [account]: prev[account].map((row) =>
        row.rowKey === tx.rowKey
          ? {
              ...row,
              description: normalizedUpdates.description,
              referenceNumber: normalizedUpdates.referenceNumber,
              source: normalizedUpdates.source,
              targetId: normalizedUpdates.targetId,
              isRecon: normalizedUpdates.isRecon,
              category: normalizedUpdates.category,
            }
          : row
      ),
    }));

    try {
      await batchUpdateBankReconciliation(
        token,
        TARGET_SPREADSHEET_ID,
        account,
        sheetLayoutByAccount[account],
        [
          {
            sheetRowNumber: tx.sheetRowNumber,
            description: normalizedUpdates.description,
            referenceNumber: normalizedUpdates.referenceNumber,
            source: normalizedUpdates.source,
            targetId: normalizedUpdates.targetId,
            isRecon: normalizedUpdates.isRecon,
            category: normalizedUpdates.category,
          },
        ]
      );
      setSheetLayoutByAccount((prev) => ({
        ...prev,
        [account]: {
          ...prev[account],
          hasTargetIdHeader: true,
          hasIsReconHeader: true,
          hasCategoryHeader: true,
        },
      }));
      setEditingBankTx(null);
      setReconcileMessage(
        `Saved changes for ${tx.uniqueId} (row #${tx.sheetRowNumber}) in "${account}".`
      );
      if (normalizedUpdates.targetId.trim() !== '') {
        await syncLinkedPairsAcrossSheets(token);
      }
    } catch (err) {
      setSheetTransactionsByAccount((prev) => ({
        ...prev,
        [account]: prevRows,
      }));
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        setNeedsAuth(true);
        setErrorMessage('Google session expired while saving Bank_Ledger changes. Please sign in again.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to update Bank_Ledger row in Google Sheets.'
        );
      }
    } finally {
      setIsSavingBankModal(false);
      setSavingBankRowKey(null);
    }
  };

  const handleReconcileComplete = async (res: ReconcileCompleteSummary) => {
    const token = await getAccessToken();
    if (token) {
      for (const tab of ['Puja', 'Regular'] as AccountType[]) {
        if (loadedAccounts[tab] || res.updatedTabs.includes(tab)) {
          await loadSheetLedger(tab, token);
        }
      }
      await loadExpenseCategoriesList(token);
    }
    setExpenseRefreshNonce((n) => n + 1);
    if (res.bankUpdatedCount === 0 && res.expenseUpdatedCount === 0) {
      setReconcileMessage(
        'Initialized reconciliation columns (Target ID, Is_Recon, Category) in Google Sheets.'
      );
    } else {
      setReconcileMessage(
        `Reconciled expenses: updated ${res.bankUpdatedCount.toLocaleString()} Bank row(s) (Target ID, Is_Recon="Yes", Category) and ${res.expenseUpdatedCount.toLocaleString()} Expense row(s) (Recon Source_ID, Is_Recon="Yes").`
      );
    }
  };

  const handleStartSync = async () => {
    setErrorMessage(null);
    setSyncResult(null);

    if (statements.length === 0) {
      setErrorMessage('Upload at least one CSV statement before syncing.');
      return;
    }

    const unmapped = statements.filter((s) => s.mappingStatus === 'needs-mapping');
    if (unmapped.length > 0) {
      setEditingStatementId(unmapped[0].id);
      setErrorMessage(
        `"${unmapped[0].fileName}" requires manual column mapping before syncing.`
      );
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      setErrorMessage('Sign in with Google first to authorize Google Sheets access.');
      return;
    }

    setIsPreparingSync(true);
    try {
      const { plan, existingIds } = await prepareSyncPlan(
        token,
        TARGET_SPREADSHEET_ID,
        account,
        effectiveCsvTransactions
      );
      setExistingIdsByAccount((prev) => ({
        ...prev,
        [account]: existingIds,
      }));
      setPendingSyncPlan(plan);
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        setNeedsAuth(true);
        setErrorMessage(
          'Google authorization expired or access was denied. Please sign in with Google again.'
        );
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to inspect target Google Sheet.'
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
      setPendingSyncPlan(null);
      setNeedsAuth(true);
      setErrorMessage('Google session expired. Please sign in again.');
      return;
    }

    setIsSyncing(true);
    setErrorMessage(null);
    try {
      const result = await executeSyncPlan(token, pendingSyncPlan);
      const appendedRows = pendingSyncPlan.toAppend;
      const appendedIds = appendedRows.map((tx) => tx.uniqueId);

      setNewlySyncedIdsByAccount((prev) => {
        const nextSet = new Set(prev[account]);
        appendedIds.forEach((id) => nextSet.add(id));
        return { ...prev, [account]: nextSet };
      });
      setExistingIdsByAccount((prev) => {
        const nextSet = new Set(prev[account]);
        appendedIds.forEach((id) => nextSet.add(id));
        return { ...prev, [account]: nextSet };
      });
      setSheetTransactionsByAccount((prev) => {
        const current = prev[account];
        const existingIdSet = new Set(current.map((tx) => tx.uniqueId));
        const newSheetEntries: NormalizedTransaction[] = appendedRows
          .filter((tx) => !existingIdSet.has(tx.uniqueId))
          .map((tx) => ({
            ...tx,
            rowKey: `sheet-${account}-synced-${tx.uniqueId}`,
            sourceFile: `Google Sheet (${account})`,
            reviewStatus: 'ok',
            syncStatus: 'newly-synced',
          }));
        return {
          ...prev,
          [account]: [...current, ...newSheetEntries],
        };
      });
      setLoadedAccounts((prev) => ({
        ...prev,
        [account]: true,
      }));

      setSyncResult(result);
      setPendingSyncPlan(null);
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        setNeedsAuth(true);
        setPendingSyncPlan(null);
        setErrorMessage(
          'Google session expired during sync. Please sign in with Google again.'
        );
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to append rows to Google Sheets.'
        );
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const exportTransactionsCsv = (rows: NormalizedTransaction[], fileName: string) => {
    if (rows.length === 0) return;

    const escapeCsv = (val: string | number) => {
      const s = String(val);
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      SHEET_HEADERS.join(','),
      ...rows.map((tx) =>
        [
          tx.uniqueId,
          tx.date,
          tx.amount.toFixed(2),
          tx.transactionType,
          tx.description,
          tx.referenceNumber,
          tx.source,
          tx.targetId ?? '',
          tx.isRecon ?? 'No',
          tx.category ?? '',
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

  const handleExportPreviewCsv = () => {
    const eligible = transactions.filter(
      (tx) => tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct'
    );
    exportTransactionsCsv(eligible, `${account.toLowerCase()}-normalized-statements.csv`);
  };

  const handleExportUnreconExpensesCsv = () => {
    const sorted = [...unreconExpenseSummary.transactions].sort((a, b) => {
      const cmp =
        dateSortOrder === 'desc'
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return a.occurrenceIndex - b.occurrenceIndex;
    });
    exportTransactionsCsv(sorted, `${account.toLowerCase()}-unrecon-expenses.csv`);
  };

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      set.add(tx.source);
    }
    return Array.from(set).sort();
  }, [transactions]);

  const availableBankCategories = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...expenseCategories, ...transactions.map((t) => t.category ?? '')]) {
      const trimmed = c.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [expenseCategories, transactions]);

  const dateBounds = useMemo(() => {
    let minDate = '';
    let maxDate = '';
    const monthSet = new Set<string>();

    for (const tx of transactions) {
      if (!minDate || tx.date < minDate) minDate = tx.date;
      if (!maxDate || tx.date > maxDate) maxDate = tx.date;
      if (tx.date.length >= 7) {
        monthSet.add(tx.date.slice(0, 7));
      }
    }

    const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
    return { minDate, maxDate, months };
  }, [transactions]);

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

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = transactions.filter((tx) => {
      if (statusFilter === 'ready') {
        const eligible = tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct';
        if (!eligible || tx.syncStatus !== 'pending') return false;
      } else if (statusFilter === 'review') {
        if (tx.reviewStatus !== 'flagged-duplicate') return false;
      } else if (statusFilter === 'discarded') {
        if (tx.reviewStatus !== 'discarded') return false;
      } else if (statusFilter === 'in-sheet') {
        if (tx.syncStatus === 'pending') return false;
      }

      if (typeFilter !== 'all' && tx.transactionType !== typeFilter) {
        return false;
      }
      if (linkFilter === 'unrecon-expenses') {
        if (tx.transactionType !== 'Expense' || (tx.isRecon ?? 'No') === 'Yes') {
          return false;
        }
      } else if (linkFilter === 'recon-expenses') {
        if (tx.transactionType !== 'Expense' || (tx.isRecon ?? 'No') !== 'Yes') {
          return false;
        }
      } else if (linkFilter === 'unlinked-expenses') {
        if (tx.transactionType !== 'Expense' || Boolean(tx.targetId?.trim())) {
          return false;
        }
      } else if (linkFilter === 'linked-expenses') {
        if (tx.transactionType !== 'Expense' || !tx.targetId?.trim()) {
          return false;
        }
      }
      if (sourceFilter !== 'all' && tx.source !== sourceFilter) {
        return false;
      }
      if (
        categoryFilter !== 'all' &&
        (tx.category ?? '').trim().toLowerCase() !== categoryFilter.toLowerCase()
      ) {
        return false;
      }
      if (startDate && tx.date < startDate) {
        return false;
      }
      if (endDate && tx.date > endDate) {
        return false;
      }
      if (q) {
        const hay =
          `${tx.description} ${tx.referenceNumber} ${tx.uniqueId} ${tx.targetId ?? ''} ${tx.category ?? ''} ${tx.isRecon ?? ''} ${tx.source} ${tx.date}`.toLowerCase();
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
      return a.occurrenceIndex - b.occurrenceIndex;
    });
  }, [
    transactions,
    statusFilter,
    typeFilter,
    linkFilter,
    sourceFilter,
    categoryFilter,
    startDate,
    endDate,
    searchQuery,
    dateSortOrder,
  ]);

  const financialTotals = useMemo(() => {
    let incomeCents = 0;
    let incomeCount = 0;
    let expenseCents = 0;
    let expenseCount = 0;

    for (const tx of filteredTransactions) {
      if (tx.reviewStatus === 'discarded') continue;
      if (tx.transactionType === 'Income') {
        incomeCents += tx.amountCents;
        incomeCount++;
      } else {
        expenseCents += Math.abs(tx.amountCents);
        expenseCount++;
      }
    }

    return {
      income: incomeCents / 100,
      incomeCount,
      expense: expenseCents / 100,
      expenseCount,
    };
  }, [filteredTransactions]);

  const { sourceSummaryMap, extraSources, activeSourceCount } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const rawMap = new Map<
      string,
      {
        source: string;
        count: number;
        incomeCents: number;
        expenseCents: number;
      }
    >();

    for (const tx of transactions) {
      if (statusFilter === 'ready') {
        const eligible = tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct';
        if (!eligible || tx.syncStatus !== 'pending') continue;
      } else if (statusFilter === 'review') {
        if (tx.reviewStatus !== 'flagged-duplicate') continue;
      } else if (statusFilter === 'discarded') {
        if (tx.reviewStatus !== 'discarded') continue;
      } else if (statusFilter === 'in-sheet') {
        if (tx.syncStatus === 'pending') continue;
      } else if (tx.reviewStatus === 'discarded') {
        continue;
      }

      if (typeFilter !== 'all' && tx.transactionType !== typeFilter) continue;
      if (startDate && tx.date < startDate) continue;
      if (endDate && tx.date > endDate) continue;
      if (q) {
        const hay =
          `${tx.description} ${tx.referenceNumber} ${tx.uniqueId} ${tx.targetId ?? ''} ${tx.category ?? ''} ${tx.isRecon ?? ''} ${tx.source} ${tx.date}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const entry = rawMap.get(tx.source) ?? {
        source: tx.source,
        count: 0,
        incomeCents: 0,
        expenseCents: 0,
      };
      entry.count++;
      if (tx.transactionType === 'Income') {
        entry.incomeCents += tx.amountCents;
      } else {
        entry.expenseCents += Math.abs(tx.amountCents);
      }
      rawMap.set(tx.source, entry);
    }

    const summaryMap = new Map<
      string,
      {
        source: string;
        count: number;
        income: number;
        expense: number;
        net: number;
      }
    >();

    const extras: string[] = [];

    for (const item of rawMap.values()) {
      summaryMap.set(item.source, {
        source: item.source,
        count: item.count,
        income: item.incomeCents / 100,
        expense: item.expenseCents / 100,
        net: (item.incomeCents - item.expenseCents) / 100,
      });
      if (!CONFIGURED_SOURCE_SET.has(item.source)) {
        extras.push(item.source);
      }
    }

    extras.sort((a, b) => a.localeCompare(b));

    return {
      sourceSummaryMap: summaryMap,
      extraSources: extras,
      activeSourceCount: rawMap.size,
    };
  }, [transactions, statusFilter, typeFilter, startDate, endDate, searchQuery]);

  const unreconExpenseSummary = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const bySource = new Map<string, { source: string; count: number; totalCents: number }>();
    const unreconTransactions: NormalizedTransaction[] = [];
    let totalCount = 0;
    let totalCents = 0;

    for (const tx of transactions) {
      if (statusFilter === 'ready') {
        const eligible = tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct';
        if (!eligible || tx.syncStatus !== 'pending') continue;
      } else if (statusFilter === 'review') {
        if (tx.reviewStatus !== 'flagged-duplicate') continue;
      } else if (statusFilter === 'discarded') {
        if (tx.reviewStatus !== 'discarded') continue;
      } else if (statusFilter === 'in-sheet') {
        if (tx.syncStatus === 'pending') continue;
      } else if (tx.reviewStatus === 'discarded') {
        continue;
      }

      if (typeFilter !== 'all' && tx.transactionType !== typeFilter) continue;
      if (tx.transactionType !== 'Expense') continue;
      if ((tx.isRecon ?? 'No') === 'Yes') continue;
      if (startDate && tx.date < startDate) continue;
      if (endDate && tx.date > endDate) continue;
      if (q) {
        const hay =
          `${tx.description} ${tx.referenceNumber} ${tx.uniqueId} ${tx.targetId ?? ''} ${tx.category ?? ''} ${tx.isRecon ?? ''} ${tx.source} ${tx.date}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const absCents = Math.abs(tx.amountCents);
      const entry = bySource.get(tx.source) ?? {
        source: tx.source,
        count: 0,
        totalCents: 0,
      };
      entry.count++;
      entry.totalCents += absCents;
      bySource.set(tx.source, entry);

      unreconTransactions.push(tx);
      totalCount++;
      totalCents += absCents;
    }

    const items = Array.from(bySource.values())
      .map((item) => ({
        source: item.source,
        count: item.count,
        total: item.totalCents / 100,
      }))
      .sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return a.source.localeCompare(b.source);
      });

    return {
      items,
      transactions: unreconTransactions,
      totalCount,
      totalAmount: totalCents / 100,
      activeSourceCount: items.length,
    };
  }, [transactions, statusFilter, typeFilter, startDate, endDate, searchQuery]);

  const unmappedStatements = statements.filter((s) => s.mappingStatus === 'needs-mapping');
  const editingStatement = statements.find((s) => s.id === editingStatementId) ?? null;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${TARGET_SPREADSHEET_ID}/edit`;

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setTypeFilter('all');
    setLinkFilter('all');
    setSourceFilter('all');
    setCategoryFilter('all');
    setStartDate('');
    setEndDate('');
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      {/* Three-Zone Top Bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-8 border-b border-slate-200 bg-white px-6 py-3">
        <a
          href="/"
          className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          LedgerSync
        </a>

        <nav className="flex items-center gap-5 overflow-x-auto text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => {
              setActiveModule('statements');
              setStatusFilter('all');
            }}
            className={`transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 ${
              activeModule === 'statements' && statusFilter !== 'review'
                ? 'text-slate-900 underline underline-offset-4'
                : ''
            }`}
          >
            Bank Statements
          </button>
          <button
            type="button"
            onClick={() => setActiveModule('expenses')}
            className={`transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 ${
              activeModule === 'expenses'
                ? 'text-slate-900 underline underline-offset-4'
                : ''
            }`}
          >
            Expense Ledger
          </button>
          <button
            type="button"
            onClick={() => setActiveModule('checks')}
            className={`transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 ${
              activeModule === 'checks'
                ? 'text-slate-900 underline underline-offset-4'
                : ''
            }`}
          >
            Check Ledger
          </button>
          <button
            type="button"
            onClick={() => setActiveModule('chatbot')}
            className={`transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 ${
              activeModule === 'chatbot'
                ? 'text-slate-900 underline underline-offset-4'
                : ''
            }`}
          >
            AI Chatbot
          </button>
          {activeModule === 'statements' && (
            <button
              type="button"
              onClick={() => setStatusFilter('review')}
              className={`hidden transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 sm:inline ${
                statusFilter === 'review' ? 'text-slate-900 underline underline-offset-4' : ''
              }`}
            >
              Review Queue
              {summary.flaggedForReview > 0 ? ` (${summary.flaggedForReview})` : ''}
            </button>
          )}
          <a
            href={
              activeModule === 'expenses'
                ? `https://docs.google.com/spreadsheets/d/${EXPENSE_SPREADSHEET_ID}/edit`
                : activeModule === 'checks'
                  ? `https://docs.google.com/spreadsheets/d/${CHECK_SPREADSHEET_ID}/edit`
                  : sheetUrl
            }
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 md:inline-flex"
          >
            Target Sheet
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {needsAuth || !user ? (
            <GoogleSignInButton
              onClick={handleSignIn}
              isLoading={isLoggingIn}
              label="Sign in with Google"
            />
          ) : (
            <div className="flex items-center gap-3">
              <span className="hidden max-w-[200px] truncate text-xs text-slate-600 sm:inline">
                {user.email || user.displayName}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Workspace Canvas */}
      {activeModule === 'expenses' ? (
        <ExpenseModule
          needsAuth={needsAuth}
          isLoggingIn={isLoggingIn}
          onSignIn={handleSignIn}
          onAuthExpired={() => setNeedsAuth(true)}
          onOpenReconcile={() => setReconcileModalOpen(true)}
          refreshNonce={expenseRefreshNonce}
          externalStatusMessage={reconcileMessage}
          onDismissExternalStatus={() => setReconcileMessage(null)}
          onExpenseMutated={() => void syncLinkedPairsAcrossSheets()}
        />
      ) : activeModule === 'checks' ? (
        <CheckModule
          needsAuth={needsAuth}
          isLoggingIn={isLoggingIn}
          onSignIn={handleSignIn}
          onAuthExpired={() => setNeedsAuth(true)}
        />
      ) : activeModule === 'chatbot' ? (
        <ChatbotModule
          needsAuth={needsAuth}
          isLoggingIn={isLoggingIn}
          onSignIn={handleSignIn}
          onAuthExpired={() => setNeedsAuth(true)}
          refreshNonce={expenseRefreshNonce}
        />
      ) : (
        <>
          <div className="flex flex-1 flex-col lg:flex-row">
        {/* Configuration Sidebar */}
        <aside className="w-full shrink-0 border-b border-slate-200 bg-white p-5 lg:w-[290px] lg:border-r lg:border-b-0">
          <div className="space-y-6">
            {/* 01. Target Account */}
            <section>
              <h2 className="text-xs font-semibold tracking-tight text-slate-900">
                01. Target Account Tab
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Select which worksheet tab receives these statements.
              </p>

              <div
                className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1"
                role="radiogroup"
                aria-label="Account Name Selector"
              >
                {(['Puja', 'Regular'] as AccountType[]).map((acct) => {
                  const active = account === acct;
                  return (
                    <button
                      key={acct}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setAccount(acct);
                        setSyncResult(null);
                      }}
                      className={`rounded py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {acct}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
                <span>Spreadsheet ID</span>
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-slate-700 underline decoration-slate-300 hover:text-teal-700"
                  title={TARGET_SPREADSHEET_ID}
                >
                  {TARGET_SPREADSHEET_ID.slice(0, 8)}...{TARGET_SPREADSHEET_ID.slice(-4)}
                </a>
              </div>
            </section>

            {/* 02. Statement CSV Uploader */}
            <section className="border-t border-slate-200 pt-5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold tracking-tight text-slate-900">
                  02. Bank Statement CSVs
                </h2>
                {statements.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearStatements}
                    className="text-[11px] font-medium text-slate-500 hover:text-red-700 whitespace-nowrap"
                  >
                    Clear All
                  </button>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                multiple
                onChange={handleFileInputChange}
                className="sr-only"
                aria-label="Upload bank statement CSV files"
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
                  Drop CSV statements here
                </span>
                <span className="mt-0.5 text-[11px] text-slate-500">
                  or click to browse multiple files
                </span>
              </div>

              {statements.length > 0 && (
                <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                  {statements.map((stmt) => (
                    <li key={stmt.id} className="px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <FileText
                              className="h-3.5 w-3.5 shrink-0 text-slate-400"
                              aria-hidden="true"
                            />
                            <span
                              className="truncate text-xs font-medium text-slate-800"
                              title={stmt.fileName}
                            >
                              {stmt.fileName}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                            <span className="font-mono tabular-nums">
                              {stmt.rawRows.length.toLocaleString()} rows
                            </span>
                            <span aria-hidden="true">·</span>
                            {stmt.mappingStatus === 'needs-mapping' ? (
                              <span className="font-medium text-amber-700">Needs mapping</span>
                            ) : stmt.mappingStatus === 'manual' ? (
                              <span className="text-teal-700">Mapped manually</span>
                            ) : (
                              <span className="text-emerald-700">Auto-mapped</span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveStatement(stmt.id)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                          aria-label={`Remove ${stmt.fileName}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingStatementId(stmt.id)}
                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-teal-700"
                      >
                        <Columns3 className="h-3 w-3" aria-hidden="true" />
                        {stmt.mappingStatus === 'needs-mapping'
                          ? 'Configure Column Mapping'
                          : 'Edit Column Mapping'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 03. Execution & Sync Controls */}
            <section className="border-t border-slate-200 pt-5">
              <h2 className="text-xs font-semibold tracking-tight text-slate-900">
                03. Sync Pipeline
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Loads existing ledger rows from &ldquo;{account}&rdquo; and appends deduplicated
                transactions when statements are uploaded.
              </p>

              <div className="mt-3 space-y-2">
                <button
                  type="button"
                  onClick={handleStartSync}
                  disabled={
                    statements.length === 0 ||
                    isPreparingSync ||
                    isSyncing ||
                    isProcessing ||
                    isLoadingSheet
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-teal-700 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 whitespace-nowrap"
                >
                  <FileSpreadsheet className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {isPreparingSync
                    ? 'Inspecting Google Sheet...'
                    : 'Process and Sync to Google Sheet'}
                </button>

                <button
                  type="button"
                  onClick={handleRefreshSheetLedger}
                  disabled={needsAuth || isLoadingSheet || isPreparingSync || isSyncing}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 shrink-0 ${isLoadingSheet ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  {isLoadingSheet ? 'Loading Sheet Ledger...' : 'Refresh Ledger from Sheet'}
                </button>

                <button
                  type="button"
                  onClick={() => setReconcileModalOpen(true)}
                  disabled={needsAuth || isLoadingSheet || isPreparingSync || isSyncing}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <ArrowLeftRight
                    className="h-3.5 w-3.5 shrink-0 text-teal-700"
                    aria-hidden="true"
                  />
                  Reconcile with Expense Ledger
                </button>
              </div>

              {needsAuth && (
                <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
                  Sign in with Google from the header to load your Google Sheet ledger and enable
                  syncing.
                </p>
              )}
            </section>
          </div>
        </aside>

        {/* Main Ledger Viewport */}
        <main className="min-w-0 flex-1 p-6">
          <div className="mx-auto max-w-[1200px] space-y-5">
            {/* Page Title + Context */}
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>Accounts</span>
                  <span aria-hidden="true">/</span>
                  <span className="font-medium text-slate-800">{account} Tab</span>
                  <span aria-hidden="true">·</span>
                  <span>10-Column Incremental Upsert</span>
                </div>
                <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900">
                  Statement Processing &amp; Ledger Preview
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setReconcileModalOpen(true)}
                  disabled={needsAuth || isLoadingSheet}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  Reconcile Expenses
                </button>

                {unreconExpenseSummary.totalCount > 0 && (
                  <button
                    type="button"
                    onClick={handleExportUnreconExpensesCsv}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                    Export Unrecon Expenses CSV
                  </button>
                )}

                {transactions.length > 0 && (
                  <button
                    type="button"
                    onClick={handleExportPreviewCsv}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Export Normalized CSV
                  </button>
                )}
              </div>
            </div>

            {/* Time Period Filter Bar for Income & Expense Totals */}
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
                    aria-label="Select Month Period"
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
                  <label htmlFor="period-start" className="text-xs text-slate-500">
                    From
                  </label>
                  <input
                    id="period-start"
                    type="date"
                    value={startDate}
                    min={dateBounds.minDate || undefined}
                    max={endDate || dateBounds.maxDate || undefined}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <label htmlFor="period-end" className="text-xs text-slate-500">
                    To
                  </label>
                  <input
                    id="period-end"
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

            {/* Total Income & Total Expense Cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white px-5 py-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">Total Income</span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    Income
                  </span>
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold tracking-tight text-emerald-700 tabular-nums">
                  {financialTotals.income.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </div>
                <div className="mt-1.5 text-xs text-slate-500">
                  <span className="font-mono tabular-nums">
                    {financialTotals.incomeCount.toLocaleString()}
                  </span>{' '}
                  {financialTotals.incomeCount === 1 ? 'transaction' : 'transactions'}
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono tabular-nums">{periodLabel}</span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white px-5 py-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">Total Expense</span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
                    <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
                    Expense
                  </span>
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold tracking-tight text-red-700 tabular-nums">
                  {financialTotals.expense.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </div>
                <div className="mt-1.5 text-xs text-slate-500">
                  <span className="font-mono tabular-nums">
                    {financialTotals.expenseCount.toLocaleString()}
                  </span>{' '}
                  {financialTotals.expenseCount === 1 ? 'transaction' : 'transactions'}
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono tabular-nums">{periodLabel}</span>
                </div>
              </div>
            </div>

            {/* Summary by Source Cards */}
            {transactions.length > 0 && (
              <section aria-label="Summary by Source" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <h2 className="font-semibold text-slate-900">Summary by Source</h2>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono text-slate-500 tabular-nums">
                      {activeSourceCount} active{' '}
                      {activeSourceCount === 1 ? 'source' : 'sources'}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono text-slate-500 tabular-nums">
                      {periodLabel}
                    </span>
                  </div>

                  {sourceFilter !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setSourceFilter('all')}
                      className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                    >
                      Show All Sources
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  {(extraSources.length > 0
                    ? [...SOURCE_CARD_ROWS, extraSources]
                    : SOURCE_CARD_ROWS
                  ).map((rowSources, rowIndex) => (
                    <div
                      key={rowIndex}
                      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
                    >
                      {rowSources.map((sourceName) => {
                        const item = sourceSummaryMap.get(sourceName) ?? {
                          source: sourceName,
                          count: 0,
                          income: 0,
                          expense: 0,
                          net: 0,
                        };
                        const isSelected =
                          sourceFilter === sourceName && linkFilter !== 'unrecon-expenses';
                        const isEmpty = item.count === 0;

                        return (
                          <button
                            key={`${rowIndex}-${sourceName}`}
                            type="button"
                            onClick={() => {
                              if (sourceFilter === sourceName && linkFilter !== 'unrecon-expenses') {
                                setSourceFilter('all');
                              } else {
                                setSourceFilter(sourceName);
                                if (linkFilter === 'unrecon-expenses') {
                                  setLinkFilter('all');
                                }
                              }
                            }}
                            aria-pressed={isSelected}
                            className={`rounded-lg border px-4 py-3.5 text-left transition-colors ${
                              isSelected
                                ? 'border-teal-700 bg-teal-50/40 ring-1 ring-teal-700/20'
                                : isEmpty
                                  ? 'border-slate-200 bg-white/70 hover:border-slate-300'
                                  : 'border-slate-200 bg-white hover:border-slate-300'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-xs font-semibold text-slate-900">
                                {item.source}
                              </span>
                              <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
                                {item.count.toLocaleString()}{' '}
                                {item.count === 1 ? 'txn' : 'txns'}
                              </span>
                            </div>

                            <div
                              className={`mt-2 font-mono text-base font-semibold tracking-tight tabular-nums ${
                                isEmpty
                                  ? 'text-slate-400'
                                  : item.net > 0
                                    ? 'text-emerald-700'
                                    : item.net < 0
                                      ? 'text-red-700'
                                      : 'text-slate-900'
                              }`}
                            >
                              {item.net.toLocaleString('en-US', {
                                style: 'currency',
                                currency: 'USD',
                              })}
                            </div>

                            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 font-mono text-[11px] tabular-nums">
                              <span
                                className={isEmpty ? 'text-slate-400' : 'text-emerald-700'}
                              >
                                +
                                {item.income.toLocaleString('en-US', {
                                  style: 'currency',
                                  currency: 'USD',
                                })}
                              </span>
                              <span className={isEmpty ? 'text-slate-400' : 'text-red-700'}>
                                -
                                {item.expense.toLocaleString('en-US', {
                                  style: 'currency',
                                  currency: 'USD',
                                })}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Summary by Source (Unrecon Expenses) Cards */}
            {transactions.length > 0 && (
              <section
                aria-label="Summary by Source (Unrecon Expenses)"
                className="space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <h2 className="font-semibold text-slate-900">
                      Summary by Source (Unrecon Expenses)
                    </h2>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono text-slate-500 tabular-nums">
                      {unreconExpenseSummary.activeSourceCount}{' '}
                      {unreconExpenseSummary.activeSourceCount === 1 ? 'source' : 'sources'}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono text-slate-700 tabular-nums">
                      {unreconExpenseSummary.totalCount.toLocaleString()}{' '}
                      {unreconExpenseSummary.totalCount === 1 ? 'txn' : 'txns'} ·{' '}
                      {unreconExpenseSummary.totalAmount.toLocaleString('en-US', {
                        style: 'currency',
                        currency: 'USD',
                      })}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono text-slate-500 tabular-nums">
                      {periodLabel}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    {unreconExpenseSummary.totalCount > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={handleExportUnreconExpensesCsv}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                          Export Unrecon CSV
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (linkFilter === 'unrecon-expenses' && sourceFilter === 'all') {
                              setLinkFilter('all');
                            } else {
                              setLinkFilter('unrecon-expenses');
                              setSourceFilter('all');
                            }
                          }}
                          className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                        >
                          {linkFilter === 'unrecon-expenses' && sourceFilter === 'all'
                            ? 'Show All Transactions'
                            : 'Filter Table to Unrecon'}
                        </button>
                      </>
                    )}
                    {linkFilter === 'unrecon-expenses' && sourceFilter !== 'all' && (
                      <button
                        type="button"
                        onClick={() => {
                          setLinkFilter('all');
                          setSourceFilter('all');
                        }}
                        className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                      >
                        Reset Unrecon Filter
                      </button>
                    )}
                  </div>
                </div>

                {unreconExpenseSummary.items.length === 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
                    All expense transactions in this view have Is_Recon = &ldquo;Yes&rdquo;.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {unreconExpenseSummary.items.map((item) => {
                      const isSelected =
                        linkFilter === 'unrecon-expenses' && sourceFilter === item.source;
                      const sharePct =
                        unreconExpenseSummary.totalAmount > 0
                          ? (item.total / unreconExpenseSummary.totalAmount) * 100
                          : 0;

                      return (
                        <button
                          key={`unrecon-${item.source}`}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setLinkFilter('all');
                              setSourceFilter('all');
                            } else {
                              setLinkFilter('unrecon-expenses');
                              setSourceFilter(item.source);
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
                              {item.source}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
                              {item.count.toLocaleString()}{' '}
                              {item.count === 1 ? 'txn' : 'txns'}
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

            {/* Summary Metrics Strip */}
            <div className="grid grid-cols-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-3 sm:divide-x lg:grid-cols-6 lg:divide-y-0">
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Parsed Rows</div>
                <div className="mt-1 font-mono text-lg font-semibold text-slate-900 tabular-nums">
                  {summary.validParsedRows.toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Overlap Dupes Removed</div>
                <div className="mt-1 font-mono text-lg font-semibold text-slate-700 tabular-nums">
                  {summary.crossFileDuplicatesRemoved.toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Needs Review</div>
                <div
                  className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
                    summary.flaggedForReview > 0 ? 'text-amber-700' : 'text-slate-900'
                  }`}
                >
                  {summary.flaggedForReview.toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Ready to Sync</div>
                <div className="mt-1 font-mono text-lg font-semibold text-teal-700 tabular-nums">
                  {summary.readyToSync.toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Already in Sheet</div>
                <div className="mt-1 font-mono text-lg font-semibold text-slate-700 tabular-nums">
                  {alreadyInSheetDisplayCount.toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Newly Synced</div>
                <div className="mt-1 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
                  {newlySyncedDisplayCount.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Error Alert */}
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

            {/* Sync Success Alert */}
            {syncResult && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-950">
                <div className="flex items-center gap-2">
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-emerald-700"
                    aria-hidden="true"
                  />
                  <span>
                    Synced to tab <strong>{syncResult.tabName}</strong> at {syncResult.syncedAt}
                    {' · '}
                    <strong className="font-mono tabular-nums">
                      {syncResult.appendedCount.toLocaleString()}
                    </strong>{' '}
                    appended
                    {' · '}
                    <strong className="font-mono tabular-nums">
                      {syncResult.skippedCount.toLocaleString()}
                    </strong>{' '}
                    existing skipped
                  </span>
                </div>
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-emerald-800 underline hover:text-emerald-950 whitespace-nowrap"
                >
                  Open Google Sheet
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </div>
            )}

            {/* Reconciliation Success Alert */}
            {reconcileMessage && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-950">
                <div className="flex items-center gap-2">
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-emerald-700"
                    aria-hidden="true"
                  />
                  <span>{reconcileMessage}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setReconcileMessage(null)}
                  className="font-medium text-emerald-800 hover:underline whitespace-nowrap"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Needs Column Mapping Callout */}
            {unmappedStatements.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-amber-700"
                    aria-hidden="true"
                  />
                  <span>
                    {unmappedStatements.length} uploaded file(s) could not be auto-mapped:{' '}
                    <strong>{unmappedStatements.map((s) => s.fileName).join(', ')}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingStatementId(unmappedStatements[0].id)}
                  className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 whitespace-nowrap"
                >
                  Map Columns
                </button>
              </div>
            )}

            {/* Same-Day Identical Rows Manual Review Callout */}
            {summary.flaggedForReview > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-amber-700"
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{summary.flaggedForReview}</strong> identical same-day transaction(s)
                    detected within a single statement. Review each row to keep as distinct or
                    discard as duplicate.
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStatusFilter('review')}
                    className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 whitespace-nowrap"
                  >
                    Filter Review Queue
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBulkResolveFlagged('kept-distinct')}
                    className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 whitespace-nowrap"
                  >
                    Keep All Distinct
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBulkResolveFlagged('discarded')}
                    className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 whitespace-nowrap"
                  >
                    Discard All
                  </button>
                </div>
              </div>
            )}

            {/* Ledger Table Surface */}
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {/* Filter Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-1">
                  {(
                    [
                      { id: 'all', label: `All (${transactions.length})` },
                      { id: 'ready', label: `Ready (${summary.readyToSync})` },
                      { id: 'review', label: `Review (${summary.flaggedForReview})` },
                      { id: 'discarded', label: `Discarded (${summary.discarded})` },
                      {
                        id: 'in-sheet',
                        label: `In Sheet (${alreadyInSheetDisplayCount + newlySyncedDisplayCount})`,
                      },
                    ] as Array<{ id: StatusFilter; label: string }>
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setStatusFilter(tab.id)}
                      className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                        statusFilter === tab.id
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
                      placeholder="Search description, ref #, ID..."
                      className="w-56 rounded-md border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                    aria-label="Filter by Transaction Type"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="all">All Types</option>
                    <option value="Income">Income</option>
                    <option value="Expense">Expense</option>
                  </select>

                  <select
                    value={linkFilter}
                    onChange={(e) => setLinkFilter(e.target.value as LinkFilter)}
                    aria-label="Filter by Reconciliation or Link Status"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="all">All Recon States</option>
                    <option value="unrecon-expenses">Unrecon Expenses (Is_Recon = No)</option>
                    <option value="recon-expenses">Reconciled Expenses (Is_Recon = Yes)</option>
                    <option value="unlinked-expenses">Unlinked Expenses</option>
                    <option value="linked-expenses">Linked Expenses</option>
                  </select>

                  <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value)}
                    aria-label="Filter by Source"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="all">All Sources</option>
                    {availableSources.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>

                  {availableBankCategories.length > 0 && (
                    <select
                      value={categoryFilter}
                      onChange={(e) => setCategoryFilter(e.target.value)}
                      aria-label="Filter by Category"
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
                    >
                      <option value="all">All Categories</option>
                      {availableBankCategories.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <TransactionGrid
                transactions={filteredTransactions}
                hasUploadedFiles={statements.length > 0}
                isProcessing={isProcessing || isLoadingSheet}
                needsAuth={needsAuth}
                isLoggingIn={isLoggingIn}
                account={account}
                dateSortOrder={dateSortOrder}
                categoryOptions={availableBankCategories}
                savingRowKey={savingBankRowKey}
                onSignIn={handleSignIn}
                onToggleDateSort={() =>
                  setDateSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                }
                onResolveFlag={handleResolveFlag}
                onEditTransaction={(tx) => setEditingBankTx(tx)}
                onUpdateInlineField={handleUpdateBankInlineField}
                onTriggerUpload={() => fileInputRef.current?.click()}
                onResetFilters={resetFilters}
              />
            </div>
          </div>
        </main>
      </div>

      {/* Column Mapping Modal */}
      <ColumnMappingModal
        statement={editingStatement}
        onClose={() => setEditingStatementId(null)}
        onSave={handleSaveMapping}
      />

      {/* Pre-Write Confirmation Dialog for Google Sheets Sync */}
      <SyncConfirmModal
        plan={pendingSyncPlan}
        isSyncing={isSyncing}
        onCancel={() => setPendingSyncPlan(null)}
        onConfirm={handleConfirmSync}
        onReviewFlagged={() => {
          setPendingSyncPlan(null);
          setStatusFilter('review');
        }}
      />
        </>
      )}

      {/* Bank Transaction Edit Modal */}
      <BankTransactionEditModal
        isOpen={Boolean(editingBankTx)}
        transaction={editingBankTx}
        categoryOptions={availableBankCategories}
        isSaving={isSavingBankModal}
        onClose={() => {
          if (!isSavingBankModal) setEditingBankTx(null);
        }}
        onSave={handleSaveBankTransactionEdit}
      />

      {/* Cross-Ledger Bank <-> Expense Reconciliation Modal */}
      <ReconcileModal
        isOpen={reconcileModalOpen}
        activeBankTab={account}
        onClose={() => setReconcileModalOpen(false)}
        onAuthExpired={() => setNeedsAuth(true)}
        onReconciled={handleReconcileComplete}
      />
    </div>
  );
}
