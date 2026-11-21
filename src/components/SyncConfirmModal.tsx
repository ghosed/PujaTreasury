import React from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, X } from 'lucide-react';
import { SyncPlan } from '../types/statement';

interface SyncConfirmModalProps {
  plan: SyncPlan | null;
  isSyncing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onReviewFlagged: () => void;
}

export const SyncConfirmModal: React.FC<SyncConfirmModalProps> = ({
  plan,
  isSyncing,
  onCancel,
  onConfirm,
  onReviewFlagged,
}) => {
  if (!plan) return null;

  const previewRows = plan.toAppend.slice(0, 5);
  const nothingToWrite = plan.toAppend.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-confirm-title"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="sync-confirm-title" className="text-base font-semibold text-slate-900">
                Confirm Google Sheet Sync
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {plan.spreadsheetTitle} · Tab &ldquo;{plan.tabName}&rdquo;
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSyncing}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close confirmation dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-md border border-slate-200 bg-slate-50">
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Existing IDs Checked</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-900 tabular-nums">
                {plan.existingIdsCount.toLocaleString()}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">Already Synced (Skipped)</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-700 tabular-nums">
                {plan.skippedAlreadySynced.length.toLocaleString()}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500">New Rows to Append</div>
              <div className="mt-1 font-mono text-lg font-semibold text-teal-700 tabular-nums">
                {plan.toAppend.length.toLocaleString()}
              </div>
            </div>
          </div>

          {(!plan.tabExists || plan.needsHeader) && !nothingToWrite && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
              {!plan.tabExists ? (
                <span>
                  Worksheet tab <strong>{plan.tabName}</strong> was not found and will be
                  created with the 11-column header row before appending records.
                </span>
              ) : (
                <span>
                  Worksheet tab <strong>{plan.tabName}</strong> is missing its header row and
                  will be initialized with the 11-column schema before appending records.
                </span>
              )}
            </div>
          )}

          {plan.unresolvedFlaggedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <span>
                  <strong>{plan.unresolvedFlaggedCount}</strong> flagged same-day duplicate
                  row(s) are unresolved and will be excluded from this sync.
                </span>
              </div>
              <button
                type="button"
                onClick={onReviewFlagged}
                className="font-medium text-amber-900 underline hover:text-amber-700 whitespace-nowrap"
              >
                Review Flagged Rows
              </button>
            </div>
          )}

          {nothingToWrite ? (
            <div className="flex items-center gap-2.5 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
              <span>
                All eligible transactions ({plan.skippedAlreadySynced.length.toLocaleString()})
                already exist in the &ldquo;{plan.tabName}&rdquo; tab. No duplicate rows will be
                written.
              </span>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-slate-600">
                <span className="font-medium text-slate-800">
                  Preview of Rows to Append to &ldquo;{plan.tabName}&rdquo;
                </span>
                <span className="font-mono tabular-nums">
                  Showing {previewRows.length} of {plan.toAppend.length.toLocaleString()}
                </span>
              </div>
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">Unique ID</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">Date</th>
                      <th className="border-b border-slate-200 px-3 py-2 text-right font-medium">
                        Amount
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">Type</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">Source</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">Reference #</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">Notes</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-medium">
                        Description
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewRows.map((tx) => (
                      <tr key={tx.rowKey} className="text-slate-800">
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                          {tx.uniqueId}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {tx.date}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap tabular-nums ${
                            tx.amount >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {tx.amount.toLocaleString('en-US', {
                            style: 'currency',
                            currency: 'USD',
                          })}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{tx.transactionType}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{tx.source}</td>
                        <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap text-slate-600">
                          {tx.referenceNumber || '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-700">
                          {tx.notes || '—'}
                        </td>
                        <td className="max-w-[200px] truncate px-3 py-2 text-slate-600">
                          {tx.description}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSyncing}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              {nothingToWrite ? 'Close' : 'Cancel'}
            </button>
            {!nothingToWrite && (
              <button
                type="button"
                onClick={onConfirm}
                disabled={isSyncing}
                className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap"
              >
                {isSyncing
                  ? 'Appending to Google Sheet...'
                  : `Confirm & Append ${plan.toAppend.length.toLocaleString()} Row${
                      plan.toAppend.length === 1 ? '' : 's'
                    }`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
