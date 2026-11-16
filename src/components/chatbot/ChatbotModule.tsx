import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Code2,
  Download,
  ExternalLink,
  MessageSquare,
  PieChart as PieChartIcon,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  TrendingUp,
} from 'lucide-react';
import {
  ChatbotFilters,
  ChatbotLedgerScope,
  ChatbotLinkStateFilter,
  ChatbotPaymentStatusFilter,
  ChatMessage,
} from '../../types/chatbot';
import { ExpenseLookups, ExpenseRecord } from '../../types/expense';
import { NormalizedTransaction } from '../../types/statement';
import {
  EXPENSE_SPREADSHEET_ID,
  fetchExpenseWorkspace,
} from '../../services/expenseSheets';
import {
  fetchSheetLedger,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from '../../services/googleSheets';
import { clearCachedToken, getAccessToken } from '../../services/firebaseAuth';
import {
  buildLedgerSnapshot,
  computeDashboardAnalytics,
  exportRowsToCsv,
  formatUsd,
} from '../../utils/chatbotAnalytics';
import { sendChatQuery } from '../../services/chatbotApi';
import { GoogleSignInButton } from '../GoogleSignInButton';
import {
  CategoryBreakdownChart,
  DynamicChartRenderer,
  LedgerComparisonChart,
  MonthlyTrendChart,
  SourceUnlinkedChart,
} from './ChatbotCharts';
import { MarkdownMessage } from './MarkdownMessage';

interface ChatbotModuleProps {
  needsAuth: boolean;
  isLoggingIn: boolean;
  onSignIn: () => void;
  onAuthExpired: () => void;
  refreshNonce?: number;
}

const EMPTY_LOOKUPS: ExpenseLookups = {
  categories: [],
  statuses: [],
  pujas: [],
  paymentModes: [],
  catSubcatMap: {},
};

const DEFAULT_FILTERS: ChatbotFilters = {
  ledgerScope: 'All',
  paymentStatus: 'All',
  linkState: 'All',
  pujaTag: 'all',
  startDate: '',
  endDate: '',
};

const STARTER_PROMPTS = [
  'Pie chart of Puja expenses by Category',
  'Compare Paid vs Pending expenses by Category',
  'Show unlinked Bank expenses grouped by Source',
  'Compare Puja vs Regular spending and unlinked gaps',
  'Bar chart of monthly Expense Ledger vs Bank spending',
];

export const ChatbotModule: React.FC<ChatbotModuleProps> = ({
  needsAuth,
  isLoggingIn,
  onSignIn,
  onAuthExpired,
  refreshNonce = 0,
}) => {
  const isFetchingRef = useRef(false);
  const prevRefreshNonceRef = useRef(refreshNonce);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Loaded Google Sheets data
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expenseRecords, setExpenseRecords] = useState<ExpenseRecord[]>([]);
  const [expenseLookups, setExpenseLookups] = useState<ExpenseLookups>(EMPTY_LOOKUPS);
  const [bankPujaTx, setBankPujaTx] = useState<NormalizedTransaction[]>([]);
  const [bankRegularTx, setBankRegularTx] = useState<NormalizedTransaction[]>([]);

  // Global dashboard & SQL filters
  const [filters, setFilters] = useState<ChatbotFilters>(DEFAULT_FILTERS);
  const [categoryChartMode, setCategoryChartMode] = useState<'bar' | 'pie'>('bar');
  const [comparisonTab, setComparisonTab] = useState<'ledger' | 'trend'>('ledger');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [drilldownTab, setDrilldownTab] = useState<'expenses' | 'bank'>('expenses');
  const [drilldownSearch, setDrilldownSearch] = useState('');
  const [mobilePane, setMobilePane] = useState<'dashboard' | 'chat'>('dashboard');

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [promptInput, setPromptInput] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [expandedSqlMessageIds, setExpandedSqlMessageIds] = useState<Record<string, boolean>>({});

  const loadAllLedgers = useCallback(
    async (explicitToken?: string) => {
      if (isFetchingRef.current) return;
      const token = explicitToken ?? (await getAccessToken());
      if (!token) {
        onAuthExpired();
        return;
      }

      isFetchingRef.current = true;
      setIsLoadingData(true);
      setLoadError(null);
      try {
        const [expWorkspace, pujaBank, regularBank] = await Promise.all([
          fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID),
          fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Puja'),
          fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Regular'),
        ]);

        setExpenseRecords(expWorkspace.records);
        setExpenseLookups(expWorkspace.lookups);
        setBankPujaTx(pujaBank.transactions);
        setBankRegularTx(regularBank.transactions);
        setHasLoaded(true);
      } catch (err) {
        if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
          clearCachedToken();
          onAuthExpired();
          setLoadError(
            'Your Google session expired or lacks Google Sheets permission. Please sign in with Google again.'
          );
        } else {
          setLoadError(
            err instanceof Error
              ? err.message
              : 'Failed to load Expense Ledger and Bank Statements from Google Sheets.'
          );
        }
      } finally {
        isFetchingRef.current = false;
        setIsLoadingData(false);
      }
    },
    [onAuthExpired]
  );

  useEffect(() => {
    if (!needsAuth && !hasLoaded) {
      void loadAllLedgers();
    } else if (needsAuth) {
      setHasLoaded(false);
      setExpenseRecords([]);
      setExpenseLookups(EMPTY_LOOKUPS);
      setBankPujaTx([]);
      setBankRegularTx([]);
    }
  }, [needsAuth, hasLoaded, loadAllLedgers]);

  useEffect(() => {
    if (refreshNonce !== prevRefreshNonceRef.current) {
      prevRefreshNonceRef.current = refreshNonce;
      if (!needsAuth) {
        void loadAllLedgers();
      }
    }
  }, [refreshNonce, needsAuth, loadAllLedgers]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isSendingChat]);

  const snapshot = useMemo(
    () =>
      buildLedgerSnapshot(
        expenseRecords,
        expenseLookups,
        bankPujaTx,
        bankRegularTx,
        filters
      ),
    [expenseRecords, expenseLookups, bankPujaTx, bankRegularTx, filters]
  );

  const analytics = useMemo(
    () => computeDashboardAnalytics(snapshot, filters),
    [snapshot, filters]
  );

  const availablePujaTags = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const row of snapshot.expenses) {
      const tag = row.puja.trim();
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      list.push(tag);
    }
    return list.sort((a, b) => a.localeCompare(b));
  }, [snapshot.expenses]);

  const selectedCategoryDetail = useMemo(() => {
    if (!selectedCategory) return null;
    return (
      analytics.categoryBreakdown.find(
        (c) => c.category.toLowerCase() === selectedCategory.toLowerCase()
      ) ?? null
    );
  }, [analytics.categoryBreakdown, selectedCategory]);

  const drilldownExpenses = useMemo(() => {
    const q = drilldownSearch.trim().toLowerCase();
    return analytics.filteredExpenses
      .filter((row) => {
        if (selectedCategory && row.category.toLowerCase() !== selectedCategory.toLowerCase()) {
          return false;
        }
        if (q) {
          const hay =
            `${row.expId} ${row.date} ${row.category} ${row.subCategory} ${row.description} ${row.status} ${row.puja} ${row.reconSourceId}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [analytics.filteredExpenses, selectedCategory, drilldownSearch]);

  const drilldownBank = useMemo(() => {
    const q = drilldownSearch.trim().toLowerCase();
    return analytics.filteredBankExpenses
      .filter((row) => {
        if (selectedSource && row.source.toLowerCase() !== selectedSource.toLowerCase()) {
          return false;
        }
        if (q) {
          const hay =
            `${row.uniqueId} ${row.date} ${row.source} ${row.description} ${row.referenceNumber} ${row.targetId}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [analytics.filteredBankExpenses, selectedSource, drilldownSearch]);

  const handleExportCurrentDashboardCsv = () => {
    if (drilldownTab === 'expenses') {
      const cols = [
        'Exp_ID',
        'Ledger',
        'Puja',
        'Date',
        'Amount',
        'Category',
        'Sub Category',
        'Status',
        'Payment Mode',
        'Description',
        'Recon Source_ID',
      ];
      const rows = drilldownExpenses.map((r) => ({
        Exp_ID: r.expId,
        Ledger: r.ledgerGroup,
        Puja: r.puja,
        Date: r.date,
        Amount: r.amountUsd.toFixed(2),
        Category: r.category,
        'Sub Category': r.subCategory,
        Status: r.status,
        'Payment Mode': r.paymentMode,
        Description: r.description,
        'Recon Source_ID': r.reconSourceId,
      }));
      exportRowsToCsv('chatbot-expense-slice.csv', cols, rows);
    } else {
      const cols = [
        'Unique Transaction ID',
        'Account Tab',
        'Date',
        'Amount',
        'Source',
        'Description',
        'Reference #',
        'Target ID',
      ];
      const rows = drilldownBank.map((r) => ({
        'Unique Transaction ID': r.uniqueId,
        'Account Tab': r.accountTab,
        Date: r.date,
        Amount: (r.amountCents / 100).toFixed(2),
        Source: r.source,
        Description: r.description,
        'Reference #': r.referenceNumber,
        'Target ID': r.targetId,
      }));
      exportRowsToCsv('chatbot-bank-slice.csv', cols, rows);
    }
  };

  const handleExportUnlinkedBankCsv = () => {
    const unlinked = analytics.filteredBankExpenses.filter((r) => !r.isLinked);
    const cols = [
      'Unique Transaction ID',
      'Account Tab',
      'Date',
      'Amount',
      'Source',
      'Description',
      'Reference #',
    ];
    const rows = unlinked.map((r) => ({
      'Unique Transaction ID': r.uniqueId,
      'Account Tab': r.accountTab,
      Date: r.date,
      Amount: r.amountUsd.toFixed(2),
      Source: r.source,
      Description: r.description,
      'Reference #': r.referenceNumber,
    }));
    exportRowsToCsv('unlinked-bank-expenses.csv', cols, rows);
  };

  const handleExportUnlinkedExpensesCsv = () => {
    const unlinked = analytics.filteredExpenses.filter((r) => !r.isLinked);
    const cols = [
      'Exp_ID',
      'Puja',
      'Date',
      'Amount',
      'Category',
      'Sub Category',
      'Status',
      'Payment Mode',
      'Description',
    ];
    const rows = unlinked.map((r) => ({
      Exp_ID: r.expId,
      Puja: r.puja,
      Date: r.date,
      Amount: r.amountUsd.toFixed(2),
      Category: r.category,
      'Sub Category': r.subCategory,
      Status: r.status,
      'Payment Mode': r.paymentMode,
      Description: r.description,
    }));
    exportRowsToCsv('unlinked-expense-ledger.csv', cols, rows);
  };

  const submitPrompt = useCallback(
    async (textRaw: string) => {
      const prompt = textRaw.trim();
      if (!prompt || isSendingChat) return;

      setMobilePane('chat');
      setPromptInput('');

      const userMsg: ChatMessage = {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        text: prompt,
        createdAt: new Date().toISOString(),
      };

      const historyPayload = messages
        .filter((m) => !m.error && m.text.trim())
        .slice(-10)
        .map((m) => ({ role: m.role, text: m.text }));

      setMessages((prev) => [...prev, userMsg]);
      setIsSendingChat(true);

      try {
        const resp = await sendChatQuery({
          message: prompt,
          history: historyPayload,
          snapshot,
        });

        const assistantMsg: ChatMessage = {
          id: `a-${crypto.randomUUID()}`,
          role: 'assistant',
          text: resp.answer,
          createdAt: new Date().toISOString(),
          sqlQueries: resp.sqlQueries,
          chartSpec: resp.chartSpec,
          tableData: resp.tableData,
          followUpPrompts: resp.followUpPrompts,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        const errorText =
          err instanceof Error ? err.message : 'Unable to complete AI query.';
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${crypto.randomUUID()}`,
            role: 'assistant',
            text: '',
            createdAt: new Date().toISOString(),
            error: errorText,
          },
        ]);
      } finally {
        setIsSendingChat(false);
      }
    },
    [isSendingChat, messages, snapshot]
  );

  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setSelectedCategory(null);
    setSelectedSource(null);
    setDrilldownSearch('');
  };

  if (needsAuth) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center">
          <h1 className="font-display text-lg font-semibold text-slate-900">
            AI Financial Chatbot & Analytics
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Connect your Google account to query your live Expense Ledger, Bank Statements, and Reconciliation gaps with exact SQL analytics and charts.
          </p>
          <div className="mt-6 flex justify-center">
            <GoogleSignInButton
              onClick={onSignIn}
              isLoading={isLoggingIn}
              label="Sign in with Google"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Global Filter & Controls Strip */}
      <div className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Ledger Scope */}
            <div
              className="inline-flex items-center rounded-md bg-slate-100 p-0.5"
              role="group"
              aria-label="Ledger Scope Filter"
            >
              {(['All', 'Puja', 'Regular'] as ChatbotLedgerScope[]).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, ledgerScope: scope }))}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    filters.ledgerScope === scope
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {scope === 'All' ? 'All Ledgers' : scope}
                </button>
              ))}
            </div>

            {/* Paid vs Pending */}
            <div
              className="inline-flex items-center rounded-md bg-slate-100 p-0.5"
              role="group"
              aria-label="Payment Status Filter"
            >
              {(['All', 'Paid', 'Pending'] as ChatbotPaymentStatusFilter[]).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, paymentStatus: st }))}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    filters.paymentStatus === st
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'All' ? 'Paid & Pending' : st}
                </button>
              ))}
            </div>

            {/* Reconciliation Link State */}
            <div
              className="inline-flex items-center rounded-md bg-slate-100 p-0.5"
              role="group"
              aria-label="Reconciliation Link Filter"
            >
              {(['All', 'Unlinked', 'Linked'] as ChatbotLinkStateFilter[]).map((lk) => (
                <button
                  key={lk}
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, linkState: lk }))}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    filters.linkState === lk
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lk === 'All' ? 'All Links' : lk}
                </button>
              ))}
            </div>

            {/* Puja Tag Dropdown when multiple tags exist */}
            {availablePujaTags.length > 1 && (
              <select
                value={filters.pujaTag}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, pujaTag: e.target.value }))
                }
                aria-label="Filter by Puja Tag"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              >
                <option value="all">All Puja Tags</option>
                {availablePujaTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            )}

            {/* Date range */}
            <div className="hidden items-center gap-1.5 xl:flex">
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, startDate: e.target.value }))
                }
                aria-label="Start Date"
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              />
              <span className="text-xs text-slate-400">to</span>
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, endDate: e.target.value }))
                }
                aria-label="End Date"
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-teal-700 focus:outline-none"
              />
            </div>

            {(filters.ledgerScope !== 'All' ||
              filters.paymentStatus !== 'All' ||
              filters.linkState !== 'All' ||
              filters.pujaTag !== 'all' ||
              filters.startDate ||
              filters.endDate ||
              selectedCategory ||
              selectedSource) && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Reset
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Mobile pane toggle */}
            <div className="inline-flex rounded-md bg-slate-100 p-0.5 lg:hidden">
              <button
                type="button"
                onClick={() => setMobilePane('dashboard')}
                className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  mobilePane === 'dashboard' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => setMobilePane('chat')}
                className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  mobilePane === 'chat' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                AI Chat
              </button>
            </div>

            <button
              type="button"
              onClick={() => void loadAllLedgers()}
              disabled={isLoadingData}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoadingData ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh Sheets
            </button>

            <button
              type="button"
              onClick={handleExportCurrentDashboardCsv}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadAllLedgers()}
            className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100 whitespace-nowrap shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main Two-Pane Workspace */}
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-12">
        {/* Left/Main Dashboard Pane */}
        <section
          className={`min-w-0 space-y-5 p-6 lg:col-span-7 ${
            mobilePane === 'dashboard' ? 'block' : 'hidden lg:block'
          }`}
        >
          {/* 4-Card KPI Strip */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Expense Ledger Total</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-slate-900 tabular-nums">
                {formatUsd(analytics.kpis.expenseTotalUsd)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono tabular-nums">
                <span>{analytics.kpis.expenseCount} items</span>
                <span aria-hidden="true">·</span>
                <span className="text-teal-700">Paid {formatUsd(analytics.kpis.paidUsd)}</span>
                <span aria-hidden="true">·</span>
                <span className="text-amber-700">Pend {formatUsd(analytics.kpis.pendingUsd)}</span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Bank Ledger Expenses</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-slate-900 tabular-nums">
                {formatUsd(analytics.kpis.bankExpenseTotalUsd)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono tabular-nums">
                <span>{analytics.kpis.bankExpenseCount} debits</span>
                <span aria-hidden="true">·</span>
                <span>{analytics.kpis.bankMatchRatePct}% linked</span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Bank Expenses Unlinked</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-amber-700 tabular-nums">
                {formatUsd(analytics.kpis.bankUnlinkedUsd)}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 font-mono tabular-nums">
                <span>{analytics.kpis.bankUnlinkedCount} missing Target ID</span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Expense Ledger Unlinked</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-amber-700 tabular-nums">
                {formatUsd(analytics.kpis.expenseUnlinkedUsd)}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 font-mono tabular-nums">
                <span>{analytics.kpis.expenseUnlinkedCount} missing Recon ID</span>
              </div>
            </div>
          </div>

          {/* Category & Sub-Category Breakdown */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  Category & Sub-Category Breakdown
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Click any category bar or slice to inspect Sub-Categories from CatSubcat and filter transactions.
                </p>
              </div>
              <div className="inline-flex rounded-md bg-slate-100 p-0.5">
                <button
                  type="button"
                  onClick={() => setCategoryChartMode('bar')}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                    categoryChartMode === 'bar'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
                  Bar Chart
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryChartMode('pie')}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                    categoryChartMode === 'pie'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <PieChartIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Pie Chart
                </button>
              </div>
            </div>

            <div className="mt-4">
              {isLoadingData && !hasLoaded ? (
                <div className="h-[265px] animate-pulse rounded bg-slate-100" />
              ) : (
                <CategoryBreakdownChart
                  items={analytics.categoryBreakdown}
                  chartMode={categoryChartMode}
                  selectedCategory={selectedCategory}
                  onSelectCategory={(cat) => {
                    setSelectedCategory((prev) => (prev === cat ? null : cat));
                    setDrilldownTab('expenses');
                  }}
                />
              )}
            </div>

            {/* Sub-Category Drill-Down when Category selected */}
            {selectedCategoryDetail && (
              <div className="mt-4 border-t border-slate-200 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-700">
                    <span className="font-semibold text-slate-900">
                      {selectedCategoryDetail.category}
                    </span>
                    <span className="mx-1.5 text-slate-400">·</span>
                    <span className="font-mono tabular-nums">
                      {formatUsd(selectedCategoryDetail.totalUsd)} ({selectedCategoryDetail.count} items)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void submitPrompt(
                          `Show detailed Sub-Category breakdown and unlinked items for Category "${selectedCategoryDetail.category}"`
                        )
                      }
                      className="rounded border border-teal-700 bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-800 hover:bg-teal-100 whitespace-nowrap"
                    >
                      Ask AI about this Category
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCategory(null)}
                      className="text-xs text-slate-500 hover:text-slate-900 whitespace-nowrap"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-1.5 font-medium">Sub-Category</th>
                        <th className="py-1.5 text-right font-medium">Items</th>
                        <th className="py-1.5 text-right font-medium">Paid</th>
                        <th className="py-1.5 text-right font-medium">Pending</th>
                        <th className="py-1.5 text-right font-medium">Unlinked</th>
                        <th className="py-1.5 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedCategoryDetail.subCategories.map((sub) => (
                        <tr key={sub.subCategory}>
                          <td className="py-2 font-medium text-slate-800">{sub.subCategory}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-slate-600">
                            {sub.count}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-teal-700">
                            {formatUsd(sub.paidUsd)}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-amber-700">
                            {formatUsd(sub.pendingUsd)}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-slate-600">
                            {formatUsd(sub.unlinkedUsd)}
                          </td>
                          <td className="py-2 text-right font-mono font-medium tabular-nums text-slate-900">
                            {formatUsd(sub.totalUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Puja vs Regular & Monthly Trend */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  {comparisonTab === 'ledger'
                    ? 'Puja vs Regular & Paid vs Pending Comparison'
                    : 'Monthly Spend Progression'}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Cross-ledger comparison using exact integer-cents totals.
                </p>
              </div>
              <div className="inline-flex rounded-md bg-slate-100 p-0.5">
                <button
                  type="button"
                  onClick={() => setComparisonTab('ledger')}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                    comparisonTab === 'ledger'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
                  Puja vs Regular
                </button>
                <button
                  type="button"
                  onClick={() => setComparisonTab('trend')}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                    comparisonTab === 'trend'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                  Monthly Trend
                </button>
              </div>
            </div>

            <div className="mt-4">
              {comparisonTab === 'ledger' ? (
                <LedgerComparisonChart ledgerSplit={analytics.ledgerSplit} />
              ) : (
                <MonthlyTrendChart items={analytics.monthlyTrend} />
              )}
            </div>
          </div>

          {/* Unlinked & Reconciliation Gap Analysis */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {/* Bank Unlinked by Source */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900">
                    Bank Unlinked Expenses by Source
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                    {analytics.kpis.bankUnlinkedCount} transactions ·{' '}
                    {formatUsd(analytics.kpis.bankUnlinkedUsd)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExportUnlinkedBankCsv}
                  disabled={analytics.kpis.bankUnlinkedCount === 0}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  CSV
                </button>
              </div>

              <div className="mt-3">
                <SourceUnlinkedChart
                  items={analytics.unlinkedBankBySource}
                  onSelectSource={(src) => {
                    setSelectedSource((prev) => (prev === src ? null : src));
                    setDrilldownTab('bank');
                  }}
                />
              </div>
            </div>

            {/* Expense Ledger Unlinked by Category */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900">
                    Expense Ledger Unlinked by Category
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                    {analytics.kpis.expenseUnlinkedCount} entries ·{' '}
                    {formatUsd(analytics.kpis.expenseUnlinkedUsd)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExportUnlinkedExpensesCsv}
                  disabled={analytics.kpis.expenseUnlinkedCount === 0}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  CSV
                </button>
              </div>

              <div className="mt-3 max-h-[210px] overflow-y-auto">
                {analytics.unlinkedExpenseByCategory.length === 0 ? (
                  <div className="flex h-[180px] items-center justify-center text-xs text-slate-500">
                    All Expense Ledger entries are linked to Bank Ledger.
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-1.5 font-medium">Category</th>
                        <th className="py-1.5 text-right font-medium">Count</th>
                        <th className="py-1.5 text-right font-medium">Unlinked USD</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {analytics.unlinkedExpenseByCategory.map((item) => (
                        <tr
                          key={item.category}
                          onClick={() => {
                            setSelectedCategory(item.category);
                            setDrilldownTab('expenses');
                          }}
                          className="cursor-pointer hover:bg-slate-50"
                        >
                          <td className="py-2 font-medium text-slate-800">{item.category}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-slate-600">
                            {item.unlinkedCount}
                          </td>
                          <td className="py-2 text-right font-mono font-medium tabular-nums text-amber-700">
                            {formatUsd(item.unlinkedUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          {/* Drill-Down Records Table */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="inline-flex rounded-md bg-slate-100 p-0.5">
                  <button
                    type="button"
                    onClick={() => setDrilldownTab('expenses')}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                      drilldownTab === 'expenses'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Expense Rows ({drilldownExpenses.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrilldownTab('bank')}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                      drilldownTab === 'bank'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Bank Expense Rows ({drilldownBank.length})
                  </button>
                </div>

                {(selectedCategory || selectedSource) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCategory(null);
                      setSelectedSource(null);
                    }}
                    className="text-xs text-teal-700 hover:underline whitespace-nowrap"
                  >
                    Filter: {selectedCategory || selectedSource} (Clear)
                  </button>
                )}
              </div>

              <div className="relative w-full sm:w-64">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={drilldownSearch}
                  onChange={(e) => setDrilldownSearch(e.target.value)}
                  placeholder="Search ID, description, category..."
                  className="w-full rounded-md border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-[320px] overflow-auto">
              {drilldownTab === 'expenses' ? (
                drilldownExpenses.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    No Expense Ledger rows match the current slice.
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr className="border-b border-slate-200">
                        <th className="px-4 py-2 font-medium">Exp_ID</th>
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Category</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Description</th>
                        <th className="px-3 py-2 font-medium">Recon ID</th>
                        <th className="px-4 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {drilldownExpenses.slice(0, 100).map((row) => (
                        <tr key={row.expId} className="hover:bg-slate-50">
                          <td className="px-4 py-2 font-mono text-[11px] text-slate-700 whitespace-nowrap">
                            {row.expId}
                          </td>
                          <td className="px-3 py-2 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                            {row.date}
                          </td>
                          <td className="px-3 py-2 text-slate-800 whitespace-nowrap">
                            {row.category}
                            {row.subCategory && row.subCategory !== 'Unspecified'
                              ? ` / ${row.subCategory}`
                              : ''}
                          </td>
                          <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                            {row.status}
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2 text-slate-600">
                            {row.description}
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                            {row.reconSourceId || 'Unlinked'}
                          </td>
                          <td className="px-4 py-2 text-right font-mono font-medium tabular-nums text-slate-900 whitespace-nowrap">
                            {formatUsd(row.amountUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : drilldownBank.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-500">
                  No Bank Expense rows match the current slice.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-slate-500">
                    <tr className="border-b border-slate-200">
                      <th className="px-4 py-2 font-medium">Tab</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Source</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                      <th className="px-3 py-2 font-medium">Target ID</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drilldownBank.slice(0, 100).map((row) => (
                      <tr key={`${row.accountTab}-${row.uniqueId}`} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-slate-700 whitespace-nowrap">
                          {row.accountTab}
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {row.date}
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">
                          {row.source}
                        </td>
                        <td className="max-w-[240px] truncate px-3 py-2 text-slate-600">
                          {row.description}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                          {row.targetId || 'Unlinked'}
                        </td>
                        <td className="px-4 py-2 text-right font-mono font-medium tabular-nums text-slate-900 whitespace-nowrap">
                          {formatUsd(row.amountUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </section>

        {/* Right Sticky Multi-Turn Text-to-SQL AI Assistant Rail */}
        <aside
          className={`flex flex-col border-t border-slate-200 bg-white lg:col-span-5 lg:h-[calc(100vh-114px)] lg:sticky lg:top-[114px] lg:border-t-0 lg:border-l ${
            mobilePane === 'chat' ? 'flex min-h-[70vh]' : 'hidden lg:flex'
          }`}
        >
          {/* Chat Header */}
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-teal-700 shrink-0" aria-hidden="true" />
                <h2 className="font-display text-sm font-semibold text-slate-900 truncate">
                  Puja & Ledger AI Assistant
                </h2>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                <span>Read-Only Text-to-SQL</span>
                <span aria-hidden="true">·</span>
                <span>{filters.ledgerScope}</span>
                <span aria-hidden="true">·</span>
                <span>{filters.paymentStatus}</span>
                <span aria-hidden="true">·</span>
                <span>{filters.linkState}</span>
              </div>
            </div>

            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  setExpandedSqlMessageIds({});
                }}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                New Chat
              </button>
            )}
          </div>

          {/* Messages Stream */}
          <div ref={chatScrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
            {messages.length === 0 ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-xs font-semibold text-slate-900">
                    Ask anything across your Expense & Bank Ledgers
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">
                    Questions are translated into read-only SQLite queries over exact integer cents—supporting joins, category/sub-category rollups, Paid vs Pending splits, reconciliation gaps, dynamic Bar/Pie charts, and CSV exports.
                  </p>
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${EXPENSE_SPREADSHEET_ID}/edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-teal-700 hover:underline"
                    >
                      Expense Sheet
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                    <span aria-hidden="true">·</span>
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${TARGET_SPREADSHEET_ID}/edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-teal-700 hover:underline"
                    >
                      Bank Sheet
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-medium text-slate-500">
                    Starter Queries
                  </div>
                  <div className="flex flex-col gap-2">
                    {STARTER_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        disabled={isLoadingData || isSendingChat}
                        onClick={() => void submitPrompt(prompt)}
                        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:border-teal-600 hover:bg-teal-50/40 hover:text-slate-900 disabled:opacity-50"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.role === 'user') {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[88%] rounded-lg bg-slate-900 px-3.5 py-2.5 text-sm text-white">
                        {msg.text}
                      </div>
                    </div>
                  );
                }

                const showSql = Boolean(expandedSqlMessageIds[msg.id]);

                return (
                  <div
                    key={msg.id}
                    className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
                  >
                    {msg.error ? (
                      <div className="flex items-start gap-2 text-xs text-red-700">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{msg.error}</span>
                      </div>
                    ) : (
                      <>
                        <MarkdownMessage content={msg.text} />

                        {msg.chartSpec && <DynamicChartRenderer spec={msg.chartSpec} />}

                        {msg.tableData && msg.tableData.rows.length > 0 && (
                          <div className="rounded-md border border-slate-200">
                            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5">
                              <span className="text-[11px] font-medium text-slate-600 font-mono tabular-nums">
                                {msg.tableData.rows.length} rows returned
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  exportRowsToCsv(
                                    'chatbot-query-results.csv',
                                    msg.tableData!.columns,
                                    msg.tableData!.rows
                                  )
                                }
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:underline whitespace-nowrap"
                              >
                                <Download className="h-3 w-3" aria-hidden="true" />
                                Export CSV
                              </button>
                            </div>
                            <div className="max-h-[220px] overflow-auto">
                              <table className="w-full text-left text-xs">
                                <thead className="sticky top-0 bg-white text-slate-500">
                                  <tr className="border-b border-slate-200">
                                    {msg.tableData.columns.map((col) => {
                                      const isCurrency =
                                        msg.tableData!.currencyColumns?.includes(col);
                                      return (
                                        <th
                                          key={col}
                                          className={`px-2.5 py-1.5 font-medium whitespace-nowrap ${
                                            isCurrency ? 'text-right' : ''
                                          }`}
                                        >
                                          {col}
                                        </th>
                                      );
                                    })}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {msg.tableData.rows.slice(0, 15).map((row, rIdx) => (
                                    <tr key={rIdx}>
                                      {msg.tableData!.columns.map((col) => {
                                        const isCurrency =
                                          msg.tableData!.currencyColumns?.includes(col);
                                        const val = row[col];
                                        const numVal = Number(val);
                                        const formatted =
                                          isCurrency &&
                                          val !== '' &&
                                          val !== null &&
                                          Number.isFinite(numVal)
                                            ? formatUsd(numVal)
                                            : String(val ?? '');
                                        return (
                                          <td
                                            key={col}
                                            className={`px-2.5 py-1.5 whitespace-nowrap ${
                                              isCurrency
                                                ? 'text-right font-mono tabular-nums text-slate-900'
                                                : 'text-slate-700'
                                            }`}
                                          >
                                            {formatted}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {msg.sqlQueries && msg.sqlQueries.length > 0 && (
                          <div className="border-t border-slate-100 pt-2">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedSqlMessageIds((prev) => ({
                                  ...prev,
                                  [msg.id]: !prev[msg.id],
                                }))
                              }
                              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-800"
                            >
                              <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>
                                View SQL ({msg.sqlQueries.length})
                              </span>
                              {showSql ? (
                                <ChevronUp className="h-3 w-3" aria-hidden="true" />
                              ) : (
                                <ChevronDown className="h-3 w-3" aria-hidden="true" />
                              )}
                            </button>

                            {showSql && (
                              <div className="mt-2 space-y-2">
                                {msg.sqlQueries.map((q, qIdx) => (
                                  <div
                                    key={qIdx}
                                    className="rounded border border-slate-200 bg-slate-50 p-2.5"
                                  >
                                    <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
                                      <span>{q.purpose}</span>
                                      <span className="font-mono tabular-nums">
                                        {q.rowCount} rows · {q.durationMs}ms
                                      </span>
                                    </div>
                                    <pre className="overflow-x-auto font-mono text-[11px] text-slate-800">
                                      {q.sql}
                                    </pre>
                                    {q.error && (
                                      <div className="mt-1 text-[11px] text-red-600">
                                        Error (auto-corrected): {q.error}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {msg.followUpPrompts && msg.followUpPrompts.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-2.5">
                            {msg.followUpPrompts.map((fp) => (
                              <button
                                key={fp}
                                type="button"
                                disabled={isSendingChat}
                                onClick={() => void submitPrompt(fp)}
                                className="rounded border border-slate-200 bg-slate-50 px-2.5 py-1 text-left text-[11px] font-medium text-slate-700 hover:border-teal-600 hover:bg-teal-50/40 hover:text-slate-900 disabled:opacity-50"
                              >
                                {fp}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })
            )}

            {isSendingChat && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Running read-only SQL queries and analyzing your ledgers...
              </div>
            )}
          </div>

          {/* Prompt Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitPrompt(promptInput);
            }}
            className="border-t border-slate-200 bg-white p-4"
          >
            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submitPrompt(promptInput);
                  }
                }}
                placeholder="Ask about Puja expenses, charts, Paid vs Pending, or unlinked gaps..."
                disabled={isLoadingData || isSendingChat}
                className="flex-1 resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none disabled:bg-slate-50"
              />
              <button
                type="submit"
                disabled={isLoadingData || isSendingChat || !promptInput.trim()}
                className="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-teal-700 px-4 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                Send
              </button>
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
};
