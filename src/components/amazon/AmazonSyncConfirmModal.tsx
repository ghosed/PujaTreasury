import React from 'react';
import { CheckCircle2, FileSpreadsheet, Info, X } from 'lucide-react';
import { AmazonSyncPlan } from '../../types/amazon';

interface AmazonSyncConfirmModalProps {
  plan: AmazonSyncPlan | null;
  isSyncing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const AmazonSyncConfirmModal: React.FC<AmazonSyncConfirmModalProps> = ({
  plan,
  isSyncing,
  onCancel,
  onConfirm,
}) => {
  if (!plan) return null;

  const canAppend = plan.toAppend.length > 0;
  const previewRows = plan.toAppend.slice(0, 12);
  const totalValue = plan.toAppend.reduce((sum, r) => {
    const val =
      r.total ?? (r.itemPrice !== null ? r.itemPrice * (r.quantity ?? 1) : 0);
    return sum + val;
  }, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="amazon-sync-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2
                id="amazon-sync-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                Confirm Amazon_Ledger Sync
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Target:{' '}
                <span className="font-medium text-slate-700">
                  {plan.meta.spreadsheetTitle}
                </span>
                {' · '}
                Tab:{' '}
                <span className="font-mono text-slate-700">{plan.meta.ledgerTabName}</span>
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
              <div className="text-xs text-slate-500">New Order Items to Record</div>
              <div className="mt-1 font-mono text-lg font-semibold text-teal-800 tabular-nums">
                {plan.toAppend.length.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5">
              <div className="text-xs text-slate-500">Duplicates Skipped</div>
              <div className="mt-1 font-mono text-lg font-semibold text-amber-700 tabular-nums">
                {plan.skippedDuplicatesCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5">
              <div className="text-xs text-slate-500">Total Batch Value</div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-900 tabular-nums">
                {totalValue.toLocaleString('en-US', {
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
                All scanned items already exist in <strong>{plan.meta.ledgerTabName}</strong>{' '}
                matching Order #, Order Date, Quantity, Item Description, and Item Price. No
                duplicate records will be written.
              </span>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-medium text-slate-700">
                Order Items to Append (showing {previewRows.length} of {plan.toAppend.length})
              </div>
              <div className="max-h-64 overflow-x-auto overflow-y-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] text-slate-500">
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Unique ID</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Order #</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Order Date</th>
                      <th className="px-3 py-1.5 text-center font-medium whitespace-nowrap">Qty</th>
                      <th className="px-3 py-1.5 font-medium">Item Description</th>
                      <th className="px-3 py-1.5 text-right font-medium whitespace-nowrap">Item Price</th>
                      <th className="px-3 py-1.5 text-right font-medium whitespace-nowrap">Total</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Status</th>
                      <th className="px-3 py-1.5 font-medium">Category</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Exp_ID</th>
                      <th className="px-3 py-1.5 font-medium whitespace-nowrap">Bank_ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewRows.map((ord) => (
                      <tr key={ord.rowKey}>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700 whitespace-nowrap tabular-nums">
                          {ord.uniqueId}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {ord.orderNumber || '—'}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {ord.orderDate || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-center font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {ord.quantity !== null ? ord.quantity : '—'}
                        </td>
                        <td
                          className="max-w-[200px] truncate px-3 py-1.5 text-[11px]"
                          title={ord.itemDescription}
                        >
                          {ord.itemDescription || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-[11px] whitespace-nowrap tabular-nums">
                          {ord.itemPrice !== null
                            ? ord.itemPrice.toLocaleString('en-US', {
                                style: 'currency',
                                currency: 'USD',
                              })
                            : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-[11px] font-medium whitespace-nowrap tabular-nums">
                          {ord.total !== null
                            ? ord.total.toLocaleString('en-US', {
                                style: 'currency',
                                currency: 'USD',
                              })
                            : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-[11px] whitespace-nowrap">
                          {ord.status || '—'}
                        </td>
                        <td className="max-w-[120px] truncate px-3 py-1.5 text-[11px]">
                          {ord.category || '—'}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-teal-800 whitespace-nowrap tabular-nums">
                          {ord.expId || '—'}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-teal-800 whitespace-nowrap tabular-nums">
                          {ord.bankId || '—'}
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
            {isSyncing ? 'Writing to Amazon_Ledger...' : 'Confirm & Record Orders'}
          </button>
        </div>
      </div>
    </div>
  );
};
