import React from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { AmazonOrderRecord } from '../../types/amazon';

interface AmazonDeleteConfirmModalProps {
  isOpen: boolean;
  mode: 'single' | 'all';
  records: AmazonOrderRecord[];
  isFiltered: boolean;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const AmazonDeleteConfirmModal: React.FC<AmazonDeleteConfirmModalProps> = ({
  isOpen,
  mode,
  records,
  isFiltered,
  isDeleting,
  onCancel,
  onConfirm,
}) => {
  if (!isOpen || records.length === 0) return null;

  const sheetCount = records.filter(
    (r) => r.sourceOrigin === 'sheet' && Boolean(r.sheetRowNumber)
  ).length;
  const scanCount = records.length - sheetCount;
  const previewRows = records.slice(0, 6);
  const singleRecord = records[0];

  const title =
    mode === 'single'
      ? 'Confirm Delete Amazon Order'
      : isFiltered
        ? `Confirm Delete All Filtered Orders (${records.length})`
        : `Confirm Delete All Orders (${records.length})`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="amazon-delete-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-700">
              <AlertTriangle className="h-4.5 w-4.5" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="amazon-delete-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                {title}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {sheetCount > 0
                  ? 'This will permanently delete rows from Amazon_Ledger (tab AmzOrders).'
                  : 'This will remove the selected scanned items from your queue.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close delete confirmation dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5 text-xs">
          {mode === 'single' ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] font-medium text-slate-600">
                  Unique ID: <span className="text-slate-900">{singleRecord.uniqueId}</span>
                </span>
                <span className="rounded bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 border border-slate-200">
                  {singleRecord.sourceOrigin === 'sheet'
                    ? `In Sheet (Row #${singleRecord.sheetRowNumber})`
                    : singleRecord.isDuplicate
                      ? 'Duplicate (Scan Queue)'
                      : 'Scanned (Queue)'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
                <div>
                  Order #: <span className="font-mono text-slate-900">{singleRecord.orderNumber || '—'}</span>
                </div>
                <div>
                  Order Date: <span className="font-mono text-slate-900">{singleRecord.orderDate || '—'}</span>
                </div>
              </div>
              <div className="text-slate-800 font-medium line-clamp-2">
                {singleRecord.itemDescription || 'No item description'}
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-600">
                <span>Qty: {singleRecord.quantity ?? '—'}</span>
                <span className="font-mono font-semibold text-red-700">
                  Total:{' '}
                  {singleRecord.total !== null
                    ? singleRecord.total.toLocaleString('en-US', {
                        style: 'currency',
                        currency: 'USD',
                      })
                    : '—'}
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="rounded-md border border-red-200 bg-red-50/70 px-3.5 py-2.5">
                  <div className="text-[11px] text-red-700">Rows in Amazon_Ledger Sheet</div>
                  <div className="mt-0.5 font-mono text-lg font-semibold text-red-900 tabular-nums">
                    {sheetCount.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                  <div className="text-[11px] text-slate-500">Items in Scan Queue</div>
                  <div className="mt-0.5 font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    {scanCount.toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-md border border-slate-200">
                <div className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600">
                  Preview ({previewRows.length} of {records.length} records to delete)
                </div>
                <div className="divide-y divide-slate-100">
                  {previewRows.map((rec) => (
                    <div
                      key={rec.rowKey}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-[11px]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-slate-800">
                          {rec.itemDescription || 'No description'}
                        </div>
                        <div className="font-mono text-slate-500">
                          {rec.orderDate || '—'} · {rec.orderNumber || rec.uniqueId}
                        </div>
                      </div>
                      <div className="shrink-0 font-mono font-medium text-red-700 tabular-nums">
                        {rec.total !== null
                          ? rec.total.toLocaleString('en-US', {
                              style: 'currency',
                              currency: 'USD',
                            })
                          : '—'}
                      </div>
                    </div>
                  ))}
                  {records.length > previewRows.length && (
                    <div className="bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
                      ...and {(records.length - previewRows.length).toLocaleString()} more{' '}
                      {records.length - previewRows.length === 1 ? 'record' : 'records'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-[11px] text-red-900">
            {sheetCount > 0
              ? `Are you sure you want to permanently delete ${
                  records.length === 1 ? 'this record' : `all ${records.length} records`
                }? Saved rows in Google Sheets cannot be recovered after deletion.`
              : `Are you sure you want to remove ${
                  records.length === 1 ? 'this scanned item' : `all ${records.length} scanned items`
                } from the queue?`}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {isDeleting
              ? 'Deleting...'
              : mode === 'single'
                ? 'Confirm Delete'
                : `Confirm Delete All (${records.length})`}
          </button>
        </div>
      </div>
    </div>
  );
};
