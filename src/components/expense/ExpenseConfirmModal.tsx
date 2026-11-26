import React from 'react';
import { CheckCircle2, FileSpreadsheet, X } from 'lucide-react';
import {
  ExpenseMutationAction,
  ExpenseRecord,
  ExpenseSheetMeta,
} from '../../types/expense';

interface ExpenseConfirmModalProps {
  action: ExpenseMutationAction | null;
  meta: ExpenseSheetMeta | null;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const COMPARE_FIELDS: Array<{ key: keyof ExpenseRecord; label: string }> = [
  { key: 'date', label: 'Date' },
  { key: 'amount', label: 'Amount' },
  { key: 'category', label: 'Category' },
  { key: 'subCategory', label: 'Sub Category' },
  { key: 'description', label: 'Description' },
  { key: 'notes', label: 'Notes' },
  { key: 'status', label: 'Status' },
  { key: 'puja', label: 'Puja' },
  { key: 'paymentMode', label: 'Payment Mode' },
  { key: 'reconSource', label: 'Recon Source' },
  { key: 'reconSourceId', label: 'Recon Source ID' },
  { key: 'isRecon', label: 'Is_Recon' },
];

export const ExpenseConfirmModal: React.FC<ExpenseConfirmModalProps> = ({
  action,
  meta,
  isSubmitting,
  onCancel,
  onConfirm,
}) => {
  if (!action || !meta) return null;

  const formatFieldVal = (key: keyof ExpenseRecord, val: unknown) => {
    if (key === 'amount' && typeof val === 'number') {
      return val.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    }
    const s = String(val ?? '').trim();
    return s || '—';
  };

  const title =
    action.kind === 'bulk-append'
      ? 'Confirm Bulk Sync to Expense_Ledger'
      : action.kind === 'manual-create'
        ? 'Confirm New Expense Record'
        : 'Confirm Update to Expense_Ledger';

  const editDiffs =
    action.kind === 'edit-update'
      ? COMPARE_FIELDS.filter(({ key }) => {
          if (key === 'amount') {
            return (
              Math.round(action.before.amount * 100) !==
              Math.round(action.after.amount * 100)
            );
          }
          return (
            String(action.before[key] ?? '').trim() !==
            String(action.after[key] ?? '').trim()
          );
        })
      : [];

  const nothingToAppend =
    action.kind === 'bulk-append' && action.records.length === 0;
  const nothingChanged = action.kind === 'edit-update' && editDiffs.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expense-confirm-title"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="expense-confirm-title" className="text-base font-semibold text-slate-900">
                {title}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {meta.spreadsheetTitle} · Tab &ldquo;{meta.ledgerTabName}&rdquo;
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close confirmation dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {action.kind === 'bulk-append' && (
            <>
              <div className="grid grid-cols-2 divide-x divide-slate-200 rounded-md border border-slate-200 bg-slate-50">
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Duplicate IDs Skipped</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-slate-700 tabular-nums">
                    {action.duplicateCount.toLocaleString()}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">New Expense Rows to Append</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-teal-700 tabular-nums">
                    {action.records.length.toLocaleString()}
                  </div>
                </div>
              </div>

              {(!meta.ledgerTabExists || meta.needsHeader) && !nothingToAppend && (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
                  {!meta.ledgerTabExists
                    ? `Worksheet tab "${meta.ledgerTabName}" will be created with the Expense_Ledger header row before appending.`
                    : `Worksheet tab "${meta.ledgerTabName}" will be initialized with its header row before appending.`}
                </div>
              )}

              {nothingToAppend ? (
                <div className="flex items-center gap-2.5 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-emerald-700"
                    aria-hidden="true"
                  />
                  <span>
                    All eligible expense rows from your CSV already exist in{' '}
                    <strong>{meta.ledgerTabName}</strong>. No duplicate rows will be added.
                  </span>
                </div>
              ) : (
                <div>
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-600">
                    <span className="font-medium text-slate-800">
                      Preview of Rows to Append
                    </span>
                    <span className="font-mono tabular-nums">
                      Showing {Math.min(5, action.records.length)} of{' '}
                      {action.records.length.toLocaleString()}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-md border border-slate-200">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium">
                            Exp_ID
                          </th>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium">
                            Date
                          </th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right font-medium">
                            Amount
                          </th>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium">
                            Category
                          </th>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium">
                            Status
                          </th>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium">
                            Description
                          </th>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium">
                            Notes
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {action.records.slice(0, 5).map((rec) => (
                          <tr key={rec.expId} className="text-slate-800">
                            <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                              {rec.expId}
                            </td>
                            <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap tabular-nums">
                              {rec.date}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap tabular-nums">
                              {rec.amount.toLocaleString('en-US', {
                                style: 'currency',
                                currency: 'USD',
                              })}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">{rec.category}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{rec.status}</td>
                            <td className="max-w-[200px] truncate px-3 py-2 text-slate-600">
                              {rec.description}
                            </td>
                            <td className="max-w-[140px] truncate px-3 py-2 text-slate-700">
                              {rec.notes || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {action.kind === 'manual-create' && (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-medium text-slate-800">
                New Row Details to Append to &ldquo;{meta.ledgerTabName}&rdquo;
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-4 py-3 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-slate-500">Exp_ID</dt>
                  <dd className="mt-0.5 font-mono font-medium text-slate-900">
                    {action.record.expId}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Date</dt>
                  <dd className="mt-0.5 font-mono text-slate-900 tabular-nums">
                    {action.record.date}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Amount</dt>
                  <dd className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                    {action.record.amount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Category</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.category}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Sub Category</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.subCategory || '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Status</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.status}</dd>
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <dt className="text-slate-500">Description</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.description}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Notes (Vendor / Supplier)</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.notes || '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Puja</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.puja || '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Payment Mode</dt>
                  <dd className="mt-0.5 text-slate-900">{action.record.paymentMode || '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Recon Source / ID</dt>
                  <dd className="mt-0.5 font-mono text-slate-900">
                    {[action.record.reconSource, action.record.reconSourceId]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Is_Recon</dt>
                  <dd className="mt-0.5 font-medium text-slate-900">
                    {action.record.isRecon || 'No'}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {action.kind === 'edit-update' && (
            <>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
                Updating Google Sheet row{' '}
                <strong className="font-mono tabular-nums">
                  #{action.after.sheetRowNumber}
                </strong>{' '}
                for Exp_ID{' '}
                <strong className="font-mono">{action.after.expId}</strong>
              </div>

              {nothingChanged ? (
                <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                  No field values were changed for this record.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2 font-medium">
                          Field
                        </th>
                        <th className="border-b border-slate-200 px-3 py-2 font-medium">
                          Previous Value
                        </th>
                        <th className="border-b border-slate-200 px-3 py-2 font-medium">
                          Updated Value
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {editDiffs.map(({ key, label }) => (
                        <tr key={key}>
                          <td className="px-3 py-2 font-medium text-slate-700">{label}</td>
                          <td className="px-3 py-2 text-slate-500 line-through">
                            {formatFieldVal(key, action.before[key])}
                          </td>
                          <td className="px-3 py-2 font-medium text-teal-800">
                            {formatFieldVal(key, action.after[key])}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              {nothingToAppend || nothingChanged ? 'Close' : 'Cancel'}
            </button>
            {!nothingToAppend && !nothingChanged && (
              <button
                type="button"
                onClick={onConfirm}
                disabled={isSubmitting}
                className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap"
              >
                {isSubmitting
                  ? 'Saving to Google Sheet...'
                  : action.kind === 'bulk-append'
                    ? `Confirm & Append ${action.records.length.toLocaleString()} Row${
                        action.records.length === 1 ? '' : 's'
                      }`
                    : action.kind === 'manual-create'
                      ? 'Confirm & Add Expense'
                      : 'Confirm & Update Row'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
