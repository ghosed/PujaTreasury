import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  FileUp,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { NormalizedTransaction, AccountType } from '../types/statement';
import { GoogleSignInButton } from './GoogleSignInButton';
import { TablePagination } from './TablePagination';

interface TransactionGridProps {
  transactions: NormalizedTransaction[];
  hasUploadedFiles: boolean;
  isProcessing: boolean;
  needsAuth: boolean;
  isLoggingIn: boolean;
  account: AccountType;
  dateSortOrder: 'desc' | 'asc';
  expenseCategoryOptions: string[];
  incomeCategoryOptions: string[];
  savingRowKey: string | null;
  onSignIn: () => void;
  onToggleDateSort: () => void;
  onResolveFlag: (flagKey: string, decision: 'kept-distinct' | 'discarded' | 'reset') => void;
  onEditTransaction: (tx: NormalizedTransaction) => void;
  onUpdateInlineField: (
    tx: NormalizedTransaction,
    patch: { category?: string; isRecon?: 'Yes' | 'No' }
  ) => void;
  onTriggerUpload: () => void;
  onResetFilters: () => void;
}

export const TransactionGrid: React.FC<TransactionGridProps> = ({
  transactions,
  hasUploadedFiles,
  isProcessing,
  needsAuth,
  isLoggingIn,
  account,
  dateSortOrder,
  expenseCategoryOptions,
  incomeCategoryOptions,
  savingRowKey,
  onSignIn,
  onToggleDateSort,
  onResolveFlag,
  onEditTransaction,
  onUpdateInlineField,
  onTriggerUpload,
  onResetFilters,
}) => {
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const totalPages = Math.max(1, Math.ceil(transactions.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedTransactions = useMemo(() => {
    const startIdx = (safePage - 1) * pageSize;
    return transactions.slice(startIdx, startIdx + pageSize);
  }, [transactions, safePage, pageSize]);

  if (isProcessing) {
    return (
      <div className="divide-y divide-slate-100">
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="grid grid-cols-12 items-center gap-4 px-4 py-3">
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-1 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-3 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (!hasUploadedFiles && transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
          <FileUp className="h-5 w-5" aria-hidden="true" />
        </div>
        {needsAuth ? (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              Sign in to load your &ldquo;{account}&rdquo; Google Sheet ledger
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Connect your Google account to automatically load existing transactions from the{' '}
              <strong>{account}</strong> tab, or upload bank statement CSV files from the
              sidebar to prepare a sync.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <GoogleSignInButton
                onClick={onSignIn}
                isLoading={isLoggingIn}
                label="Sign in with Google"
              />
              <button
                type="button"
                onClick={onTriggerUpload}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                Upload Statement CSVs
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              No transactions found in &ldquo;{account}&rdquo; tab
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Upload one or more CSV bank statements from the sidebar. The processor detects
              columns, removes cross-file duplicates, categorizes sources, and syncs new
              entries to Google Sheets.
            </p>
            <button
              type="button"
              onClick={onTriggerUpload}
              className="mt-5 rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 whitespace-nowrap"
            >
              Upload Statement CSVs
            </button>
          </>
        )}
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
        <p className="text-sm font-medium text-slate-800">
          No transactions match the current filter
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Adjust your search query or clear active filters to inspect parsed entries.
        </p>
        <button
          type="button"
          onClick={onResetFilters}
          className="mt-4 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
        >
          Reset Filters
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <th className="py-2 pl-3 pr-2 font-medium whitespace-nowrap">Action</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">State</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">
                <button
                  type="button"
                  onClick={onToggleDateSort}
                  className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900"
                  title={`Sorted ${
                    dateSortOrder === 'desc' ? 'newest first' : 'oldest first'
                  } (click to toggle)`}
                >
                  <span>Date / Unique ID</span>
                  {dateSortOrder === 'desc' ? (
                    <ArrowDown className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  )}
                </button>
              </th>
              <th className="px-2 py-2 text-right font-medium whitespace-nowrap">Amount</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Source / Ref #</th>
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Target ID</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Category</th>
              <th className="py-2 pl-2 pr-3 font-medium whitespace-nowrap">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginatedTransactions.map((tx) => {
              const isFlagged = tx.reviewStatus === 'flagged-duplicate';
              const isDiscarded = tx.reviewStatus === 'discarded';
              const isKeptDistinct = tx.reviewStatus === 'kept-distinct';
              const reconValue = tx.isRecon === 'Yes' ? 'Yes' : 'No';

              return (
                <tr
                  key={tx.rowKey}
                  className={`transition-colors ${
                    isFlagged
                      ? 'bg-amber-50/50 hover:bg-amber-50'
                      : isDiscarded
                        ? 'bg-slate-50/70 text-slate-400 hover:bg-slate-50'
                        : 'hover:bg-slate-50/80'
                  }`}
                >
                  <td className="py-2 pl-3 pr-2 whitespace-nowrap">
                    {(() => {
                      const isLinkedYes = Boolean(tx.targetId?.trim()) && reconValue === 'Yes';
                      return (
                        <div className="space-y-1">
                          <div>
                            <button
                              type="button"
                              onClick={() => onEditTransaction(tx)}
                              disabled={isDiscarded || savingRowKey === tx.rowKey}
                              aria-label={`Edit ${tx.uniqueId}`}
                              title={
                                isDiscarded ? 'Undo discard to edit' : `Edit ${tx.uniqueId}`
                              }
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:text-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </div>
                          <div>
                            <select
                              value={reconValue}
                              onChange={(e) =>
                                onUpdateInlineField(tx, {
                                  isRecon: e.target.value === 'Yes' ? 'Yes' : 'No',
                                })
                              }
                              disabled={isDiscarded || savingRowKey === tx.rowKey || isLinkedYes}
                              aria-label={`Is_Recon for ${tx.uniqueId}`}
                              title={
                                isDiscarded
                                  ? 'Undo discard to edit'
                                  : isLinkedYes
                                    ? 'Locked to Yes while linked to Expense_Ledger'
                                    : `Set Is_Recon for ${tx.uniqueId}`
                              }
                              className={`rounded border bg-white px-1.5 py-0.5 text-[11px] font-medium focus:border-teal-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                                reconValue === 'Yes'
                                  ? 'border-emerald-300 text-emerald-800'
                                  : 'border-slate-300 text-slate-700'
                              }`}
                            >
                              <option value="No">No</option>
                              <option value="Yes">Yes</option>
                            </select>
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {isFlagged ? (
                      <div className="space-y-1">
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800"
                          title="Flagged as a potential duplicate (requires clicking Keep or Discard)"
                        >
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          Review
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onResolveFlag(tx.flagKey, 'kept-distinct')}
                            className="inline-flex items-center gap-0.5 rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
                            title="Keep as distinct same-day transaction"
                          >
                            <Check className="h-3 w-3" aria-hidden="true" />
                            Keep
                          </button>
                          <button
                            type="button"
                            onClick={() => onResolveFlag(tx.flagKey, 'discarded')}
                            className="inline-flex items-center gap-0.5 rounded border border-red-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
                            title="Discard duplicate"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                            Discard
                          </button>
                        </div>
                      </div>
                    ) : isDiscarded ? (
                      <div className="inline-flex items-center gap-1.5">
                        <span
                          className="text-[11px] text-slate-400"
                          title="Excluded from syncing (can be restored with Undo)"
                        >
                          Discarded
                        </span>
                        <button
                          type="button"
                          onClick={() => onResolveFlag(tx.flagKey, 'reset')}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900"
                          title="Re-open for review"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden="true" />
                          Undo
                        </button>
                      </div>
                    ) : tx.syncStatus === 'newly-synced' ? (
                      <span
                        className="text-[11px] font-medium text-emerald-700"
                        title="Newly synced to Google Sheets during the current session"
                      >
                        Synced
                      </span>
                    ) : tx.syncStatus === 'already-in-sheet' ? (
                      <span
                        className="text-[11px] text-slate-500"
                        title="Already present in the Puja or Regular tab of the Bank Statement Google Sheet"
                      >
                        In Sheet
                      </span>
                    ) : isKeptDistinct ? (
                      <div className="inline-flex items-center gap-1">
                        <span
                          className="text-[11px] font-medium text-teal-700"
                          title="Previously flagged for review, marked Keep as a valid distinct transaction, and now ready to sync"
                        >
                          Reviewed (rdy2sync)
                        </span>
                        <button
                          type="button"
                          onClick={() => onResolveFlag(tx.flagKey, 'reset')}
                          className="text-[11px] text-slate-500 hover:text-slate-800"
                          title="Undo decision"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <span
                        className="text-[11px] font-medium text-slate-700"
                        title="Newly parsed from an uploaded CSV and ready to be synced to Google Sheets"
                      >
                        Uploaded (rdy2sync)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <div className="font-mono text-[12px] text-slate-800 tabular-nums">
                      {tx.date}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-[11px] tabular-nums ${
                        isDiscarded ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      {tx.uniqueId}
                    </div>
                  </td>
                  <td
                    className={`px-2 py-2 text-right font-mono text-[12px] font-medium whitespace-nowrap tabular-nums ${
                      isDiscarded
                        ? 'text-slate-400 line-through'
                        : tx.transactionType === 'Income'
                          ? 'text-emerald-800'
                          : 'text-red-700'
                    }`}
                  >
                    {tx.amount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </td>
                  <td className="max-w-[140px] px-2 py-2">
                    <div className="truncate font-medium text-slate-700" title={tx.source}>
                      {tx.source}
                    </div>
                    <div
                      className="mt-0.5 truncate font-mono text-[11px] text-slate-500 tabular-nums"
                      title={tx.referenceNumber || undefined}
                    >
                      {tx.referenceNumber || '—'}
                    </div>
                  </td>
                  <td className="max-w-[230px] px-2 py-2">
                    <div className="truncate text-slate-800" title={tx.description}>
                      {tx.description}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-slate-400"
                      title={tx.sourceFile}
                    >
                      {tx.sourceFile}
                      {tx.occurrenceIndex > 1 ? ` · Same-day match #${tx.occurrenceIndex}` : ''}
                    </div>
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] whitespace-nowrap tabular-nums">
                    {tx.targetId ? (
                      <span
                        className="font-medium text-teal-700"
                        title={`Linked Expense Exp_ID: ${tx.targetId}`}
                      >
                        {tx.targetId}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {(() => {
                      const currentCat = (tx.category ?? '').trim();
                      const typeOptions =
                        tx.transactionType === 'Income'
                          ? incomeCategoryOptions
                          : expenseCategoryOptions;
                      const rowCatOptions =
                        currentCat &&
                        !typeOptions.some(
                          (c) => c.toLowerCase() === currentCat.toLowerCase()
                        )
                          ? [currentCat, ...typeOptions]
                          : typeOptions;
                      return (
                        <select
                          value={currentCat}
                          onChange={(e) =>
                            onUpdateInlineField(tx, { category: e.target.value })
                          }
                          disabled={isDiscarded || savingRowKey === tx.rowKey}
                          aria-label={`Category for ${tx.uniqueId}`}
                          className="w-[140px] rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-800 focus:border-teal-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">—</option>
                          {rowCatOptions.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                  </td>
                  <td
                    className="max-w-[160px] truncate py-2 pl-2 pr-3 text-slate-700"
                    title={tx.notes || undefined}
                  >
                    {tx.notes || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TablePagination
        totalItems={transactions.length}
        pageSize={pageSize}
        currentPage={safePage}
        singularLabel="transaction"
        pluralLabel="transactions"
        onPageChange={setCurrentPage}
        onPageSizeChange={(newSize) => {
          setPageSize(newSize);
          setCurrentPage(1);
        }}
      />
    </div>
  );
};
