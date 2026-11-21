import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { AccountType } from '../types/statement';
import { getAccessToken, clearCachedToken } from '../services/firebaseAuth';
import {
  BankReconcileRowUpdate,
  BankSheetColumnLayout,
  batchUpdateBankReconciliation,
  fetchSheetLedger,
  LoadedSheetLedger,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from '../services/googleSheets';
import {
  batchUpdateExpenseReconIds,
  EXPENSE_SPREADSHEET_ID,
  ExpenseReconUpdate,
  fetchExpenseWorkspace,
  LoadedExpenseWorkspace,
} from '../services/expenseSheets';
import {
  BankLedgerEntry,
  findExpenseMatches,
  ReconciliationMatch,
} from '../utils/reconciler';

type ScopeOption = 'both' | 'Puja' | 'Regular';

export interface ReconcileCompleteSummary {
  bankUpdatedCount: number;
  expenseUpdatedCount: number;
  updatedTabs: AccountType[];
}

interface ReconcileModalProps {
  isOpen: boolean;
  activeBankTab: AccountType;
  onClose: () => void;
  onAuthExpired: () => void;
  onReconciled: (summary: ReconcileCompleteSummary) => Promise<void> | void;
}

export const ReconcileModal: React.FC<ReconcileModalProps> = ({
  isOpen,
  activeBankTab,
  onClose,
  onAuthExpired,
  onReconciled,
}) => {
  const [scope, setScope] = useState<ScopeOption>('both');
  const [dateToleranceDays, setDateToleranceDays] = useState<number | null>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [bankLedgers, setBankLedgers] = useState<Record<AccountType, LoadedSheetLedger> | null>(
    null
  );
  const [expenseWorkspace, setExpenseWorkspace] = useState<LoadedExpenseWorkspace | null>(null);
  const [deselectedKeys, setDeselectedKeys] = useState<Set<string>>(new Set());

  const loadComparisonData = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMsg('Sign in with Google to compare Bank Ledger and Expense Ledger sheets.');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    setDeselectedKeys(new Set());

    try {
      const [pujaLedger, regularLedger, expWs] = await Promise.all([
        fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Puja'),
        fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Regular'),
        fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID),
      ]);
      setBankLedgers({ Puja: pujaLedger, Regular: regularLedger });
      setExpenseWorkspace(expWs);
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMsg('Google session expired or lacks permission. Please sign in again.');
      } else {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Unable to load Bank Ledger and Expense Ledger sheets.'
        );
      }
    } finally {
      setIsLoading(false);
    }
  }, [onAuthExpired]);

  useEffect(() => {
    if (isOpen) {
      void loadComparisonData();
    } else {
      setErrorMsg(null);
      setDeselectedKeys(new Set());
    }
  }, [isOpen, loadComparisonData]);

  const analysis = useMemo(() => {
    if (!bankLedgers || !expenseWorkspace) return null;

    const entries: BankLedgerEntry[] = [];
    if (scope === 'both' || scope === 'Puja') {
      for (const tx of bankLedgers.Puja.transactions) {
        entries.push({ tab: 'Puja', tx });
      }
    }
    if (scope === 'both' || scope === 'Regular') {
      for (const tx of bankLedgers.Regular.transactions) {
        entries.push({ tab: 'Regular', tx });
      }
    }

    return findExpenseMatches(entries, expenseWorkspace.records, dateToleranceDays);
  }, [bankLedgers, expenseWorkspace, scope, dateToleranceDays]);

  const selectedMatches = useMemo<ReconciliationMatch[]>(() => {
    if (!analysis) return [];
    return analysis.matches.filter((m) => !deselectedKeys.has(m.matchKey));
  }, [analysis, deselectedKeys]);

  const tabsMissingHeaders = useMemo<Array<{ tab: AccountType; columns: string[] }>>(() => {
    if (!bankLedgers) return [];
    const tabsToCheck: AccountType[] =
      scope === 'both' ? ['Puja', 'Regular'] : [scope];
    const missing: Array<{ tab: AccountType; columns: string[] }> = [];
    for (const tab of tabsToCheck) {
      const ledger = bankLedgers[tab];
      if (!ledger.tabExists) continue;
      const cols: string[] = [];
      if (!ledger.hasTargetIdHeader) cols.push('Target ID');
      if (!ledger.hasIsReconHeader) cols.push('Is_Recon');
      if (!ledger.hasCategoryHeader) cols.push('Category');
      if (cols.length > 0) {
        missing.push({ tab, columns: cols });
      }
    }
    return missing;
  }, [bankLedgers, scope]);

  const expenseMissingIsReconHeader = Boolean(
    expenseWorkspace &&
      expenseWorkspace.meta.ledgerTabExists &&
      !expenseWorkspace.meta.needsHeader &&
      !expenseWorkspace.meta.hasIsReconHeader
  );

  const toggleMatch = (matchKey: string) => {
    setDeselectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(matchKey)) {
        next.delete(matchKey);
      } else {
        next.add(matchKey);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (!analysis) return;
    if (selectedMatches.length === analysis.matches.length) {
      setDeselectedKeys(new Set(analysis.matches.map((m) => m.matchKey)));
    } else {
      setDeselectedKeys(new Set());
    }
  };

  const handleApplyReconciliation = async () => {
    if (!bankLedgers || !expenseWorkspace) return;
    const hasHeaderInitialization =
      tabsMissingHeaders.length > 0 || expenseMissingIsReconHeader;
    if (selectedMatches.length === 0 && !hasHeaderInitialization) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMsg('Google session expired. Please sign in with Google again.');
      return;
    }

    setIsApplying(true);
    setErrorMsg(null);

    try {
      const bankUpdatesByTab: Record<AccountType, BankReconcileRowUpdate[]> = {
        Puja: [],
        Regular: [],
      };
      const expenseUpdates: ExpenseReconUpdate[] = [];

      for (const match of selectedMatches) {
        if (match.needsBankUpdate && match.bankTx.sheetRowNumber) {
          const upd: BankReconcileRowUpdate = {
            sheetRowNumber: match.bankTx.sheetRowNumber,
          };
          if (match.needsBankTargetIdUpdate) {
            upd.targetId = match.expense.expId;
          }
          if (match.needsBankIsReconUpdate) {
            upd.isRecon = 'Yes';
          }
          if (match.needsBankCategoryUpdate) {
            upd.category = match.expense.category.trim();
          }
          bankUpdatesByTab[match.bankTab].push(upd);
        }
        if (match.needsExpenseUpdate && match.expense.sheetRowNumber) {
          const expUpd: ExpenseReconUpdate = {
            sheetRowNumber: match.expense.sheetRowNumber,
          };
          if (match.needsExpenseReconIdUpdate) {
            expUpd.reconSourceId = match.bankTx.uniqueId;
          }
          if (match.needsExpenseIsReconUpdate) {
            expUpd.isRecon = 'Yes';
          }
          expenseUpdates.push(expUpd);
        }
      }

      let bankUpdatedCount = 0;
      const updatedTabs: AccountType[] = [];

      for (const tab of ['Puja', 'Regular'] as AccountType[]) {
        const updates = bankUpdatesByTab[tab];
        const ledger = bankLedgers[tab];
        const needsHeaderInit =
          (scope === 'both' || scope === tab) &&
          ledger.tabExists &&
          (!ledger.hasTargetIdHeader || !ledger.hasIsReconHeader || !ledger.hasCategoryHeader);

        if (updates.length > 0 || needsHeaderInit) {
          const layout: BankSheetColumnLayout = {
            hasTargetIdHeader: ledger.hasTargetIdHeader,
            targetIdColIndex: ledger.targetIdColIndex,
            hasIsReconHeader: ledger.hasIsReconHeader,
            isReconColIndex: ledger.isReconColIndex,
            hasCategoryHeader: ledger.hasCategoryHeader,
            categoryColIndex: ledger.categoryColIndex,
            hasNotesHeader: ledger.hasNotesHeader,
            notesColIndex: ledger.notesColIndex,
          };
          const count = await batchUpdateBankReconciliation(
            token,
            TARGET_SPREADSHEET_ID,
            tab,
            layout,
            updates
          );
          bankUpdatedCount += count;
          updatedTabs.push(tab);
        }
      }

      let expenseUpdatedCount = 0;
      if (expenseUpdates.length > 0 || expenseMissingIsReconHeader) {
        expenseUpdatedCount = await batchUpdateExpenseReconIds(
          token,
          expenseWorkspace.meta,
          expenseUpdates
        );
      }

      await onReconciled({
        bankUpdatedCount,
        expenseUpdatedCount,
        updatedTabs,
      });
      onClose();
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMsg('Google session expired while saving updates. Please sign in again.');
      } else {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Failed to update reconciliation fields in Google Sheets.'
        );
      }
    } finally {
      setIsApplying(false);
    }
  };

  if (!isOpen) return null;

  const canConfirm =
    !isLoading &&
    !isApplying &&
    Boolean(analysis) &&
    (selectedMatches.length > 0 ||
      tabsMissingHeaders.length > 0 ||
      expenseMissingIsReconHeader);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reconcile-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ArrowLeftRight className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="reconcile-modal-title" className="text-base font-semibold text-slate-900">
                Reconcile Bank Ledger &amp; Expense Ledger
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Links matching Bank &amp; Expense rows, sets <strong>Is_Recon = Yes</strong> in both
                sheets, and copies Expense <strong>Category</strong> into Bank_Ledger.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isApplying}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close reconciliation modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {/* Controls Row */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">Bank Tab Scope:</span>
                <div className="inline-flex rounded-md bg-slate-200/70 p-0.5">
                  {(
                    [
                      { id: 'both', label: 'Both (Puja & Regular)' },
                      { id: 'Puja', label: `Puja${activeBankTab === 'Puja' ? ' (Active)' : ''}` },
                      {
                        id: 'Regular',
                        label: `Regular${activeBankTab === 'Regular' ? ' (Active)' : ''}`,
                      },
                    ] as Array<{ id: ScopeOption; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setScope(opt.id);
                        setDeselectedKeys(new Set());
                      }}
                      disabled={isLoading || isApplying}
                      className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                        scope === opt.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">Date Tolerance:</span>
                <div className="inline-flex rounded-md bg-slate-200/70 p-0.5">
                  {(
                    [
                      { days: 0, label: 'Exact Date' },
                      { days: 3, label: '±3 Days' },
                      { days: 7, label: '±7 Days' },
                      { days: null, label: 'None' },
                    ] as Array<{ days: number | null; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setDateToleranceDays(opt.days);
                        setDeselectedKeys(new Set());
                      }}
                      disabled={isLoading || isApplying}
                      className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                        dateToleranceDays === opt.days
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void loadComparisonData()}
              disabled={isLoading || isApplying}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Re-scan Sheets
            </button>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          {(tabsMissingHeaders.length > 0 || expenseMissingIsReconHeader) && !isLoading && (
            <div className="space-y-1 rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
              {tabsMissingHeaders.map((item) => (
                <div key={item.tab}>
                  Bank Ledger tab <strong>{item.tab}</strong> will initialize missing header{' '}
                  {item.columns.length === 1 ? 'column' : 'columns'}:{' '}
                  <strong>{item.columns.join(', ')}</strong>.
                </div>
              ))}
              {expenseMissingIsReconHeader && (
                <div>
                  Expense_Ledger tab <strong>{expenseWorkspace?.meta.ledgerTabName}</strong> will
                  initialize missing header column: <strong>Is_Recon</strong>.
                </div>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-teal-700" aria-hidden="true" />
              <p className="mt-3 text-xs font-medium text-slate-700">
                Loading Bank Ledger (Puja &amp; Regular) and Expense_Ledger rows...
              </p>
            </div>
          ) : analysis ? (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-2 divide-y divide-slate-200 rounded-md border border-slate-200 bg-slate-50 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Selected Matches</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-teal-700 tabular-nums">
                    {selectedMatches.length.toLocaleString()} / {analysis.matches.length.toLocaleString()}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Already Reconciled</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
                    {analysis.alreadyReconciledCount.toLocaleString()}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Bank Expenses Unlinked</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-slate-800 tabular-nums">
                    {analysis.unmatchedBankCount.toLocaleString()}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                    {analysis.unmatchedBankAmount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Expense Ledger Unlinked</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-slate-800 tabular-nums">
                    {analysis.unmatchedExpenseCount.toLocaleString()}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                    {analysis.unmatchedExpenseAmount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </div>
                </div>
              </div>

              {analysis.matches.length === 0 ? (
                <div className="flex items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-4 py-5 text-xs text-slate-700">
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-emerald-700"
                    aria-hidden="true"
                  />
                  <span>
                    {analysis.alreadyReconciledCount > 0
                      ? `All ${analysis.alreadyReconciledCount.toLocaleString()} matching expenses across the selected sheets are already reconciled.`
                      : dateToleranceDays === null
                        ? 'No new matching expenses were found with the selected Bank Tab scope.'
                        : 'No new matching expenses were found with the selected Bank Tab scope and Date Tolerance. Try expanding the date window to ±3 Days, ±7 Days, or None if check clearing or posting dates differ.'}
                  </span>
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
                    <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={
                          analysis.matches.length > 0 &&
                          selectedMatches.length === analysis.matches.length
                        }
                        onChange={handleToggleAll}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                      />
                      <span>
                        Proposed 1-to-1 Matches ({selectedMatches.length} of{' '}
                        {analysis.matches.length} selected)
                      </span>
                    </label>
                    <span className="text-[11px] text-slate-500">
                      {dateToleranceDays === null
                        ? 'Matched on exact dollar amount (date ignored)'
                        : 'Matched on exact dollar amount & date window'}
                    </span>
                  </div>

                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-slate-600 shadow-[inset_0_-1px_0_0_#e2e8f0]">
                        <tr>
                          <th className="w-10 px-3 py-2 font-medium">Use</th>
                          <th className="px-3 py-2 font-medium">Bank Ledger Expense</th>
                          <th className="px-3 py-2 text-right font-medium">Amount</th>
                          <th className="px-3 py-2 font-medium">Expense_Ledger Item</th>
                          <th className="px-3 py-2 font-medium">Match Signal &amp; Writes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {analysis.matches.map((m) => {
                          const checked = !deselectedKeys.has(m.matchKey);
                          return (
                            <tr
                              key={m.matchKey}
                              className={
                                checked
                                  ? 'bg-white hover:bg-slate-50/80'
                                  : 'bg-slate-50/60 text-slate-400'
                              }
                            >
                              <td className="px-3 py-2.5 align-top">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMatch(m.matchKey)}
                                  aria-label={`Select match ${m.bankTx.uniqueId} and ${m.expense.expId}`}
                                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                                />
                              </td>
                              <td className="max-w-[260px] px-3 py-2.5 align-top">
                                <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                                  <span className="font-semibold text-slate-700">{m.bankTab}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{m.bankTx.date}</span>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-slate-500">{m.bankTx.source}</span>
                                </div>
                                <div
                                  className="mt-0.5 truncate font-medium text-slate-800"
                                  title={m.bankTx.description}
                                >
                                  {m.bankTx.description}
                                </div>
                                <div className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                                  ID: {m.bankTx.uniqueId}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-right align-top font-mono text-[12px] font-semibold text-slate-900 whitespace-nowrap tabular-nums">
                                {Math.abs(m.bankTx.amount).toLocaleString('en-US', {
                                  style: 'currency',
                                  currency: 'USD',
                                })}
                              </td>
                              <td className="max-w-[260px] px-3 py-2.5 align-top">
                                <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                                  <span className="font-semibold text-teal-700">
                                    {m.expense.expId}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span>{m.expense.date}</span>
                                </div>
                                <div
                                  className="mt-0.5 truncate font-medium text-slate-800"
                                  title={m.expense.description}
                                >
                                  {m.expense.description || '—'}
                                </div>
                                <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                  {m.expense.category || 'Uncategorized'}
                                  {m.expense.subCategory ? ` / ${m.expense.subCategory}` : ''}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 align-top">
                                <div className="text-[11px] font-medium text-slate-700">
                                  {m.reason}
                                </div>
                                <div className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-500">
                                  {m.needsBankTargetIdUpdate && (
                                    <div>
                                      Bank Target ID ←{' '}
                                      <span className="text-teal-700">{m.expense.expId}</span>
                                    </div>
                                  )}
                                  {m.needsBankIsReconUpdate && (
                                    <div>
                                      Bank Is_Recon ← <span className="text-emerald-700">Yes</span>
                                    </div>
                                  )}
                                  {m.needsBankCategoryUpdate && (
                                    <div>
                                      Bank Category ←{' '}
                                      <span className="text-teal-700">{m.expense.category}</span>
                                    </div>
                                  )}
                                  {m.needsExpenseReconIdUpdate && (
                                    <div>
                                      Recon Source_ID ←{' '}
                                      <span className="text-slate-700">{m.bankTx.uniqueId}</span>
                                    </div>
                                  )}
                                  {m.needsExpenseIsReconUpdate && (
                                    <div>
                                      Expense Is_Recon ←{' '}
                                      <span className="text-emerald-700">Yes</span>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <p className="text-[11px] text-slate-500">
            Selected matches update <strong>Target ID</strong>, <strong>Is_Recon</strong>, and{' '}
            <strong>Category</strong> in Bank Ledger plus <strong>Recon Source_ID</strong> and{' '}
            <strong>Is_Recon</strong> in Expense_Ledger.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isApplying}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyReconciliation}
              disabled={!canConfirm}
              className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 whitespace-nowrap"
            >
              {isApplying
                ? 'Updating Google Sheets...'
                : selectedMatches.length > 0
                  ? `Confirm & Update ${selectedMatches.length} Match${selectedMatches.length === 1 ? '' : 'es'}`
                  : tabsMissingHeaders.length > 0 || expenseMissingIsReconHeader
                    ? 'Initialize Missing Columns'
                    : 'No Updates Selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
