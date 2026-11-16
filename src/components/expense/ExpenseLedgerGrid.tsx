import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  FileUp,
  Pencil,
  Plus,
} from 'lucide-react';
import { ExpenseRecord } from '../../types/expense';
import { GoogleSignInButton } from '../GoogleSignInButton';

interface ExpenseLedgerGridProps {
  records: ExpenseRecord[];
  hasUploadedCsv: boolean;
  isLoading: boolean;
  needsAuth: boolean;
  isLoggingIn: boolean;
  dateSortOrder: 'desc' | 'asc';
  onSignIn: () => void;
  onToggleDateSort: () => void;
  onEditRecord: (record: ExpenseRecord) => void;
  onTriggerUpload: () => void;
  onOpenManualEntry: () => void;
  onResetFilters: () => void;
}

export const ExpenseLedgerGrid: React.FC<ExpenseLedgerGridProps> = ({
  records,
  hasUploadedCsv,
  isLoading,
  needsAuth,
  isLoggingIn,
  dateSortOrder,
  onSignIn,
  onToggleDateSort,
  onEditRecord,
  onTriggerUpload,
  onOpenManualEntry,
  onResetFilters,
}) => {
  if (isLoading) {
    return (
      <div className="divide-y divide-slate-100">
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="grid grid-cols-12 items-center gap-4 px-4 py-3">
            <div className="col-span-1 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-1 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-3 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-1 h-3.5 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (!hasUploadedCsv && records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
          <FileUp className="h-5 w-5" aria-hidden="true" />
        </div>
        {needsAuth ? (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              Sign in to load your Expense_Ledger Google Sheet
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Connect your Google account to load saved expense records along with{' '}
              <strong>LookUp</strong> and <strong>CatSubcat</strong> dropdown mappings, or
              upload an expense tracker CSV from the sidebar.
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
                Upload Expense CSV
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              No expense records found in Expense_Ledger
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Bulk upload an expense item tracker CSV (filtered for Actual · Accepted/Paid) or add
              individual expense entries manually.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onOpenManualEntry}
                className="inline-flex items-center gap-1.5 rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Expense Manually
              </button>
              <button
                type="button"
                onClick={onTriggerUpload}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                Upload Expense CSV
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
        <p className="text-sm font-medium text-slate-800">
          No expense records match the current filter
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Adjust your search query or clear active filters to inspect saved or staged expenses.
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
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Exp_ID</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">
                Category / Sub Category
              </th>
              <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Amount</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Status</th>
              <th className="px-3 py-2.5 font-medium">Description</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">
                Puja / Payment Mode
              </th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Recon Source / ID</th>
              <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                State / Edit
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {records.map((rec) => {
              const isStaged = rec.sourceOrigin === 'csv';
              const statusLower = rec.status.trim().toLowerCase();
              const statusColor =
                statusLower === 'paid'
                  ? 'text-emerald-700'
                  : statusLower === 'accepted'
                    ? 'text-teal-700'
                    : 'text-slate-700';

              return (
                <tr
                  key={`${rec.sourceOrigin}-${rec.sheetRowNumber ?? 'staged'}-${rec.expId}`}
                  className={`transition-colors ${
                    isStaged ? 'bg-teal-50/30 hover:bg-teal-50/60' : 'hover:bg-slate-50/80'
                  }`}
                >
                  <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums">
                    {rec.date}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                    {rec.expId}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-slate-800 whitespace-nowrap">
                      {rec.category || '—'}
                    </div>
                    {rec.subCategory && (
                      <div className="mt-0.5 text-[11px] text-slate-500 whitespace-nowrap">
                        {rec.subCategory}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] font-medium text-slate-900 whitespace-nowrap tabular-nums">
                    {rec.amount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className={`font-medium ${statusColor}`}>{rec.status || '—'}</span>
                  </td>
                  <td className="max-w-[260px] px-3 py-2.5">
                    <div className="truncate text-slate-800" title={rec.description}>
                      {rec.description || '—'}
                    </div>
                    {rec.sourceFileName && (
                      <div className="mt-0.5 truncate text-[11px] text-slate-400">
                        {rec.sourceFileName}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-slate-700 whitespace-nowrap">{rec.puja || '—'}</div>
                    {rec.paymentMode && (
                      <div className="mt-0.5 text-[11px] text-slate-500 whitespace-nowrap">
                        {rec.paymentMode}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-slate-700 whitespace-nowrap">
                      {rec.reconSource || '—'}
                    </div>
                    {rec.reconSourceId && (
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                        {rec.reconSourceId}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-2.5">
                      <span
                        className={`text-[11px] ${
                          isStaged ? 'font-medium text-teal-700' : 'text-slate-500'
                        }`}
                      >
                        {isStaged ? 'Staged (CSV)' : 'In Sheet'}
                      </span>
                      <button
                        type="button"
                        onClick={() => onEditRecord(rec)}
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 hover:text-teal-800"
                        title={`Edit ${rec.expId}`}
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-2 text-xs text-slate-500">
        <span className="font-mono tabular-nums">
          Showing all {records.length.toLocaleString()}{' '}
          {records.length === 1 ? 'expense record' : 'expense records'}
        </span>
      </div>
    </div>
  );
};
