import React from 'react';
import { CheckCircle2, FileSpreadsheet, Info, X } from 'lucide-react';
import { CheckSyncPlan } from '../../types/check';

interface CheckSyncConfirmModalProps {
  plan: CheckSyncPlan | null;
  isSyncing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const CheckSyncConfirmModal: React.FC<CheckSyncConfirmModalProps> = ({
  plan,
  isSyncing,
  onCancel,
  onConfirm,
}) => {
  if (!plan) return null;

  const canAppend = plan.toAppend.length > 0;
  const previewRows = plan.toAppend.slice(0, 12);
  const totalAmount = plan.toAppend.reduce((sum, r) => sum + r.amount, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="check-sync-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="check-sync-modal-title" className="text-base font-semibold text-slate-900">
                Confirm Check_Ledger Sync
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Target: <span className="font-medium text-slate-700">{plan.meta.spreadsheetTitle}</span>
                {' · '}
                Tab: <span className="font-mono text-slate-700">{plan.meta.ledgerTabName}</span>
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

        <div className="space-y-4 px-6 py-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5">
              <div className="text-xs text-slate-500">New Checks to Record</div>
              <div className="mt-1 font-mono text-lg font-semibold text-teal-800 tabular-nums">
                {plan.toAppend.length.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5">
              <div className="text-xs text-slate-500">Duplicate Copies Skipped</div>
              <div className="mt-1 font-mono text-lg font-semibold text-amber-700 tabular-nums">
                {plan.skippedDuplicatesCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5">
              <div className="text-xs text-slate-500">Total Batch Value</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-900 tabular-nums">
                {totalAmount.toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                })}
              </div>
            </div>
          </div>

          {!canAppend ? (
            <div className="flex items-start gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              <span>
                All scanned checks already exist in <strong>{plan.meta.ledgerTabName}</strong>.
                No duplicate records will be written.
              </span>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-medium text-slate-700">
                Checks to Append (showing {previewRows.length} of {plan.toAppend.length})
              </div>
              <div className="max-h-64 overflow-x-auto overflow-y-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] text-slate-500">
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Unique ID</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Check #</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Routing #</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Bank</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Date</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Type</th>
                      <th className="px-3 py-1.5 text-right font-medium whitespace-nowrap">Amount</th>
                      <th className="px-3 py-1.5 font-medium">Paid To</th>
                      <th className="px-3 py-1.5 font-medium">Paid By</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewRows.map((chk) => (
                      <tr key={chk.rowKey}>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700 whitespace-nowrap tabular-nums">
                          {chk.uniqueId}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {chk.checkNumber}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                          {chk.routingNumber || '—'}
                        </td>
                        <td className="max-w-[120px] truncate px-3 py-1.5 text-[11px]">
                          {chk.bank}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {chk.date}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <span
                            className={`text-[11px] font-medium ${
                              chk.transactionType === 'Income'
                                ? 'text-emerald-700'
                                : 'text-red-700'
                            }`}
                          >
                            {chk.transactionType}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-[11px] font-medium whitespace-nowrap tabular-nums">
                          {chk.amount.toLocaleString('en-US', {
                            style: 'currency',
                            currency: 'USD',
                          })}
                        </td>
                        <td className="max-w-[130px] truncate px-3 py-1.5 text-[11px]">
                          {chk.paidTo || '—'}
                        </td>
                        <td className="max-w-[130px] truncate px-3 py-1.5 text-[11px]">
                          {chk.paidBy || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSyncing}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canAppend || isSyncing}
            className="inline-flex items-center gap-1.5 rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 whitespace-nowrap"
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {isSyncing ? 'Writing to Check_Ledger...' : 'Confirm & Record Checks'}
          </button>
        </div>
      </div>
    </div>
  );
};
