import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
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
  executeSyncPlan,
  prepareSyncPlan,
  SHEET_HEADERS,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from './services/googleSheets';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { ColumnMappingModal } from './components/ColumnMappingModal';
import { SyncConfirmModal } from './components/SyncConfirmModal';
import { TransactionGrid } from './components/TransactionGrid';

type StatusFilter = 'all' | 'ready' | 'review' | 'discarded' | 'in-sheet';
type TypeFilter = 'all' | 'Income' | 'Expense';

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

  const [transactions, setTransactions] = useState<NormalizedTransaction[]>([]);
  const [summary, setSummary] = useState<PipelineSummary>(EMPTY_SUMMARY);
  const [isProcessing, setIsProcessing] = useState(false);

  // Filters & Sort
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateSortOrder, setDateSortOrder] = useState<'desc' | 'asc'>('desc');

  // Google Sheets Sync State
  const [isPreparingSync, setIsPreparingSync] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingSyncPlan, setPendingSyncPlan] = useState<SyncPlan | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  // Re-run normalization & SHA-256 ID pipeline whenever statements, account, or resolutions change
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (statements.length === 0) {
        setTransactions([]);
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
          setTransactions(result.transactions);
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

  const handleSignIn = async () => {
    setIsLoggingIn(true);
    setErrorMessage(null);
    try {
      const res = await googleSignIn();
      if (res) {
        setUser(res.user);
        setNeedsAuth(false);
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
    setUser(null);
    setNeedsAuth(true);
    setPendingSyncPlan(null);
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
      for (const tx of transactions) {
        if (tx.reviewStatus === 'flagged-duplicate') {
          next[tx.flagKey] = decision;
        }
      }
      return next;
    });
  };

  const handleCheckExistingIds = async () => {
    setErrorMessage(null);
    const token = await getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      setErrorMessage('Please sign in with Google to check existing Google Sheet records.');
      return;
    }

    setIsPreparingSync(true);
    try {
      const { existingIds } = await prepareSyncPlan(
        token,
        TARGET_SPREADSHEET_ID,
        account,
        transactions
      );
      setExistingIdsByAccount((prev) => ({
        ...prev,
        [account]: existingIds,
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
      setIsPreparingSync(false);
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
        transactions
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
      const appendedIds = pendingSyncPlan.toAppend.map((tx) => tx.uniqueId);

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

  const handleExportPreviewCsv = () => {
    const eligible = transactions.filter(
      (tx) => tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct'
    );
    if (eligible.length === 0) return;

    const escapeCsv = (val: string | number) => {
      const s = String(val);
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      SHEET_HEADERS.join(','),
      ...eligible.map((tx) =>
        [
          tx.uniqueId,
          tx.date,
          tx.amount.toFixed(2),
          tx.transactionType,
          tx.description,
          tx.referenceNumber,
          tx.source,
        ]
          .map(escapeCsv)
          .join(',')
      ),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${account.toLowerCase()}-normalized-statements.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      set.add(tx.source);
    }
    return Array.from(set).sort();
  }, [transactions]);

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
      if (sourceFilter !== 'all' && tx.source !== sourceFilter) {
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
          `${tx.description} ${tx.referenceNumber} ${tx.uniqueId} ${tx.source} ${tx.date}`.toLowerCase();
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
    sourceFilter,
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
          `${tx.description} ${tx.referenceNumber} ${tx.uniqueId} ${tx.source} ${tx.date}`.toLowerCase();
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

  const unmappedStatements = statements.filter((s) => s.mappingStatus === 'needs-mapping');
  const editingStatement = statements.find((s) => s.id === editingStatementId) ?? null;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${TARGET_SPREADSHEET_ID}/edit`;

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setTypeFilter('all');
    setSourceFilter('all');
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

        <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 ${
              statusFilter !== 'review' ? 'text-slate-900 underline underline-offset-4' : ''
            }`}
          >
            Ledger Preview
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('review')}
            className={`transition-colors whitespace-nowrap shrink-0 hover:text-slate-900 ${
              statusFilter === 'review' ? 'text-slate-900 underline underline-offset-4' : ''
            }`}
          >
            Review Queue
            {summary.flaggedForReview > 0 ? ` (${summary.flaggedForReview})` : ''}
          </button>
          <a
            href={sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 hover:text-slate-900"
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
                Checks existing Unique IDs in &ldquo;{account}&rdquo; before appending new
                records.
              </p>

              <div className="mt-3 space-y-2">
                <button
                  type="button"
                  onClick={handleStartSync}
                  disabled={
                    statements.length === 0 || isPreparingSync || isSyncing || isProcessing
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
                  onClick={handleCheckExistingIds}
                  disabled={
                    statements.length === 0 || needsAuth || isPreparingSync || isSyncing
                  }
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Check Existing Sheet IDs
                </button>
              </div>

              {needsAuth && (
                <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
                  Sign in with Google from the header to enable reading and syncing to your
                  Google Sheet.
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
                  <span>7-Column Incremental Upsert</span>
                </div>
                <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900">
                  Statement Processing &amp; Ledger Preview
                </h1>
              </div>

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
                        const isSelected = sourceFilter === sourceName;
                        const isEmpty = item.count === 0;

                        return (
                          <button
                            key={`${rowIndex}-${sourceName}`}
                            type="button"
                            onClick={() =>
                              setSourceFilter((prev) =>
                                prev === sourceName ? 'all' : sourceName
                              )
                            }
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
                  {summary.alreadyInSheet.toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-slate-500">Newly Synced</div>
                <div className="mt-1 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
                  {summary.newlySynced.toLocaleString()}
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
                        label: `In Sheet (${summary.alreadyInSheet + summary.newlySynced})`,
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
                </div>
              </div>

              <TransactionGrid
                transactions={filteredTransactions}
                hasUploadedFiles={statements.length > 0}
                isProcessing={isProcessing}
                dateSortOrder={dateSortOrder}
                onToggleDateSort={() =>
                  setDateSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                }
                onResolveFlag={handleResolveFlag}
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
    </div>
  );
}
