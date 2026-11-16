import React from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  FileUp,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { NormalizedTransaction, AccountType } from '../types/statement';
import { GoogleSignInButton } from './GoogleSignInButton';

interface TransactionGridProps {
  transactions: NormalizedTransaction[];
  hasUploadedFiles: boolean;
  isProcessing: boolean;
  needsAuth: boolean;
  isLoggingIn: boolean;
  account: AccountType;
  dateSortOrder: 'desc' | 'asc';
  onSignIn: () => void;
  onToggleDateSort: () => void;
  onResolveFlag: (flagKey: string, decision: 'kept-distinct' | 'discarded' | 'reset') => void;
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
  onSignIn,
  onToggleDateSort,
  onResolveFlag,
  onTriggerUpload,
  onResetFilters,
}) => {

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
              <th className="px-4 py-2.5 font-medium whitespace-nowrap">
                <button
                  type="button"
                  onClick={onToggleDateSort}
                  className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900"
                  title={`Sorted ${
                    dateSortOrder === 'desc' ? 'newest first' : 'oldest first'
                  } (click to toggle)`}
                >
                  <span>Date</span>
                  {dateSortOrder === 'desc' ? (
                    <ArrowDown className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  )}
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Type</th>
              <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Amount</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Source</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Reference #</th>
              <th className="px-3 py-2.5 font-medium">Description</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Unique ID</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Target ID</th>
              <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                State / Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {transactions.map((tx) => {
              const isFlagged = tx.reviewStatus === 'flagged-duplicate';
              const isDiscarded = tx.reviewStatus === 'discarded';
              const isKeptDistinct = tx.reviewStatus === 'kept-distinct';

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
                  <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums">
                    {tx.date}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span
                      className={`font-medium ${
                        isDiscarded
                          ? 'text-slate-400'
                          : tx.transactionType === 'Income'
                            ? 'text-emerald-700'
                            : 'text-red-700'
                      }`}
                    >
                      {tx.transactionType}
                    </span>
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-mono text-[12px] font-medium whitespace-nowrap tabular-nums ${
                      isDiscarded
                        ? 'text-slate-400 line-through'
                        : tx.amount >= 0
                          ? 'text-emerald-700'
                          : 'text-slate-900'
                    }`}
                  >
                    {tx.amount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-slate-700">{tx.source}</td>
                  <td className="max-w-[140px] truncate px-3 py-2.5 font-mono text-[11px] text-slate-600 tabular-nums">
                    {tx.referenceNumber || '—'}
                  </td>
                  <td className="max-w-[280px] px-3 py-2.5">
                    <div className="truncate text-slate-800" title={tx.description}>
                      {tx.description}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400">
                      {tx.sourceFile}
                      {tx.occurrenceIndex > 1 ? ` · Same-day match #${tx.occurrenceIndex}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                    {tx.uniqueId}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap tabular-nums">
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
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {isFlagged ? (
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-800">
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          Review
                        </span>
                        <button
                          type="button"
                          onClick={() => onResolveFlag(tx.flagKey, 'kept-distinct')}
                          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
                          title="Keep as distinct same-day transaction"
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => onResolveFlag(tx.flagKey, 'discarded')}
                          className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                          title="Discard duplicate"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          Discard
                        </button>
                      </div>
                    ) : isDiscarded ? (
                      <div className="inline-flex items-center gap-2">
                        <span className="text-[11px] text-slate-400">Discarded</span>
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
                      <span className="text-[11px] font-medium text-emerald-700">Synced</span>
                    ) : tx.syncStatus === 'already-in-sheet' ? (
                      <span className="text-[11px] text-slate-500">In Sheet</span>
                    ) : isKeptDistinct ? (
                      <div className="inline-flex items-center gap-2">
                        <span className="text-[11px] font-medium text-teal-700">
                          Ready (Distinct)
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
                      <span className="text-[11px] font-medium text-slate-700">Ready</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-2 text-xs text-slate-500">
        <span className="font-mono tabular-nums">
          Showing all {transactions.length.toLocaleString()}{' '}
          {transactions.length === 1 ? 'transaction' : 'transactions'}
        </span>
      </div>
    </div>
  );
};
