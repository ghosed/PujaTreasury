import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, FileUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { AmazonOrderRecord, AmazonOrderStatus } from '../../types/amazon';
import { ExpenseRecord } from '../../types/expense';
import { BankLedgerLookupRecord } from './AmazonEntryModal';
import { isValid12DigitAmazonUniqueId } from '../../utils/amazonProcessor';
import { GoogleSignInButton } from '../GoogleSignInButton';
import { TablePagination } from '../TablePagination';

export type AmazonSortField = 'orderDate' | 'orderNumber';

interface AmazonGridProps {
  records: AmazonOrderRecord[];
  hasUploadedFiles: boolean;
  isLoading: boolean;
  needsAuth: boolean;
  isLoggingIn: boolean;
  sortField: AmazonSortField;
  sortOrder: 'desc' | 'asc';
  expenseCategoryOptions: string[];
  expenseByIdMap?: Map<string, ExpenseRecord>;
  bankByIdMap?: Map<string, BankLedgerLookupRecord>;
  updatingReconKey: string | null;
  updatingCategoryKey: string | null;
  isDeletingRecords?: boolean;
  onSignIn: () => void;
  onToggleSort: (field: AmazonSortField) => void;
  onEditRecord: (record: AmazonOrderRecord) => void;
  onDeleteRecord: (record: AmazonOrderRecord) => void;
  onUpdateIsRecon: (record: AmazonOrderRecord, isRecon: 'Yes' | 'No') => void;
  onUpdateCategory: (record: AmazonOrderRecord, category: string) => void;
  onTriggerUpload: () => void;
  onOpenManualEntry: () => void;
  onResetFilters: () => void;
}

function getStatusTextClass(status: AmazonOrderStatus): string {
  switch (status) {
    case 'Delivered':
      return 'text-emerald-700 font-medium';
    case 'Ordered':
      return 'text-blue-700 font-medium';
    case 'Cancelled':
      return 'text-red-700 font-medium';
    case 'Returned':
      return 'text-amber-700 font-medium';
    default:
      return 'text-slate-400';
  }
}

export const AmazonGrid: React.FC<AmazonGridProps> = ({
  records,
  hasUploadedFiles,
  isLoading,
  needsAuth,
  isLoggingIn,
  sortField,
  sortOrder,
  expenseCategoryOptions,
  expenseByIdMap,
  bankByIdMap,
  updatingReconKey,
  updatingCategoryKey,
  isDeletingRecords = false,
  onSignIn,
  onToggleSort,
  onEditRecord,
  onDeleteRecord,
  onUpdateIsRecon,
  onUpdateCategory,
  onTriggerUpload,
  onOpenManualEntry,
  onResetFilters,
}) => {
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedRecords = useMemo(() => {
    const startIdx = (safePage - 1) * pageSize;
    return records.slice(startIdx, startIdx + pageSize);
  }, [records, safePage, pageSize]);

  if (isLoading) {
    return (
      <div className="divide-y divide-slate-100">
        {Array.from({ length: 7 }).map((_, idx) => (
          <div key={idx} className="grid grid-cols-12 items-center gap-4 px-4 py-3">
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-3 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-2 h-3.5 animate-pulse rounded bg-slate-200" />
            <div className="col-span-3 h-3.5 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (!hasUploadedFiles && records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
          <FileUp className="h-5 w-5" aria-hidden="true" />
        </div>
        {needsAuth ? (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              Sign in to load your Amazon_Ledger Google Sheet
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Connect your Google account to load existing records from{' '}
              <strong>Amazon_Ledger</strong> (tab <strong>AmzOrders</strong>), or upload Amazon
              order summary images and invoice PDFs to extract order details.
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
                Upload Order Images / PDFs
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              No order records found in Amazon_Ledger
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Upload Amazon order summary images or invoice PDFs from the sidebar to extract
              Order #, Order Date, Quantity, Item Description, Item Price, Total, Shipped To,
              Payment Method, and Status.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onTriggerUpload}
                className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 whitespace-nowrap"
              >
                Upload Order Images / PDFs
              </button>
              <button
                type="button"
                onClick={onOpenManualEntry}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Order Manually
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
          No Amazon order records match the current filter
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Adjust your search query or clear active filters to view scanned or saved orders.
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

  const renderSortIcon = (field: AmazonSortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />;
    }
    return sortOrder === 'desc' ? (
      <ArrowDown className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
    ) : (
      <ArrowUp className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
    );
  };

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
                  onClick={() => onToggleSort('orderDate')}
                  className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900"
                  title="Sort by Order Date"
                >
                  <span>Order Date / Unique ID</span>
                  {renderSortIcon('orderDate')}
                </button>
              </th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onToggleSort('orderNumber')}
                  className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900"
                  title="Sort by Amazon Order #"
                >
                  <span>Order #</span>
                  {renderSortIcon('orderNumber')}
                </button>
              </th>
              <th className="px-2 py-2 text-center font-medium whitespace-nowrap">Qty</th>
              <th className="px-2 py-2 font-medium">Item Description</th>
              <th className="px-2 py-2 text-right font-medium whitespace-nowrap">Item Price</th>
              <th className="px-2 py-2 text-right font-medium whitespace-nowrap">Total</th>
              <th className="px-2 py-2 font-medium">Shipped To / Payment</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Status</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Category</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Exp_ID</th>
              <th className="py-2 pl-2 pr-3 font-medium whitespace-nowrap">Bank_ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginatedRecords.map((rec) => {
              const isScanned = rec.sourceOrigin === 'scan';
              const isDup = Boolean(rec.isDuplicate);
              const isLegacyId = !isValid12DigitAmazonUniqueId(rec.uniqueId);
              const currentCat = (rec.category ?? '').trim();
              const rowCatOptions =
                currentCat &&
                !expenseCategoryOptions.some(
                  (c) => c.toLowerCase() === currentCat.toLowerCase()
                )
                  ? [currentCat, ...expenseCategoryOptions]
                  : expenseCategoryOptions;

              return (
                <tr
                  key={rec.rowKey}
                  className={`transition-colors ${
                    isDup
                      ? 'bg-amber-50/40 text-slate-500 hover:bg-amber-50/70'
                      : isScanned
                        ? 'bg-teal-50/30 hover:bg-teal-50/60'
                        : 'hover:bg-slate-50/80'
                  }`}
                >
                  <td className="py-2 pl-3 pr-2 whitespace-nowrap">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onEditRecord(rec)}
                          disabled={isDup}
                          aria-label={`Edit ${rec.uniqueId}`}
                          title={
                            isDup
                              ? rec.duplicateReason || 'Duplicate order item'
                              : `Edit ${rec.uniqueId}`
                          }
                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:text-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteRecord(rec)}
                          disabled={isDeletingRecords}
                          aria-label={`Delete ${rec.uniqueId}`}
                          title={
                            rec.sourceOrigin === 'sheet'
                              ? `Delete ${rec.uniqueId} from Amazon_Ledger`
                              : `Remove ${rec.uniqueId} from scan queue`
                          }
                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 bg-white text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                      <div>
                        <select
                          value={rec.isRecon === 'Yes' ? 'Yes' : 'No'}
                          onChange={(e) =>
                            onUpdateIsRecon(rec, e.target.value === 'Yes' ? 'Yes' : 'No')
                          }
                          disabled={isDup || updatingReconKey === rec.rowKey}
                          aria-label={`Is_Recon for ${rec.uniqueId}`}
                          className={`rounded border bg-white px-1.5 py-0.5 text-[11px] font-medium focus:border-teal-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                            rec.isRecon === 'Yes'
                              ? 'border-emerald-300 text-emerald-800'
                              : 'border-slate-300 text-slate-700'
                          }`}
                        >
                          <option value="No">No</option>
                          <option value="Yes">Yes</option>
                        </select>
                      </div>
                    </div>
                  </td>

                  <td className="px-2 py-2 whitespace-nowrap">
                    <span
                      className={`text-[11px] ${
                        isDup
                          ? 'font-medium text-amber-800'
                          : isScanned
                            ? 'font-medium text-teal-700'
                            : 'text-slate-500'
                      }`}
                      title={
                        isDup
                          ? rec.duplicateReason ||
                            'Detected as a duplicate order item and skipped from recording'
                          : isScanned
                            ? 'Newly extracted from an uploaded order image/PDF and ready to record to Amazon_Ledger'
                            : 'Already saved in the Amazon_Ledger Google Sheet'
                      }
                    >
                      {isDup
                        ? 'Duplicate'
                        : isScanned
                          ? 'Scanned (rdy2sync)'
                          : 'In Sheet'}
                    </span>
                  </td>

                  <td className="px-2 py-2 whitespace-nowrap">
                    <div className="font-mono text-[12px] text-slate-800 tabular-nums">
                      {rec.orderDate || '—'}
                    </div>
                    <div
                      className={`mt-0.5 max-w-[125px] truncate font-mono text-[11px] tabular-nums ${
                        isLegacyId ? 'text-amber-700' : 'text-slate-500'
                      }`}
                      title={
                        isLegacyId
                          ? `${rec.uniqueId} (Legacy ID — use Replace Legacy Unique IDs to upgrade to 12-digit hash)`
                          : rec.uniqueId
                      }
                    >
                      {rec.uniqueId}
                    </div>
                  </td>

                  <td className="px-2 py-2 whitespace-nowrap">
                    <div className="font-mono text-[12px] font-medium text-slate-800 tabular-nums">
                      {rec.orderNumber || '—'}
                    </div>
                  </td>

                  <td className="px-2 py-2 text-center font-mono text-[12px] text-slate-800 whitespace-nowrap tabular-nums">
                    {rec.quantity !== null ? rec.quantity : '—'}
                  </td>

                  <td
                    className="max-w-[260px] px-2 py-2 text-slate-800"
                    title={rec.itemDescription || undefined}
                  >
                    <div className="line-clamp-2 leading-snug">
                      {rec.itemDescription || '—'}
                    </div>
                  </td>

                  <td
                    className={`px-2 py-2 text-right font-mono text-[12px] whitespace-nowrap tabular-nums ${
                      rec.status === 'Returned' ? 'text-emerald-800' : 'text-slate-700'
                    }`}
                  >
                    {rec.itemPrice !== null
                      ? Math.abs(rec.itemPrice).toLocaleString('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        })
                      : '—'}
                    {rec.status === 'Returned' &&
                      rec.total === null &&
                      rec.itemPrice !== null && (
                        <div className="font-sans text-[10px] text-emerald-700">Income</div>
                      )}
                  </td>

                  <td
                    className={`px-2 py-2 text-right font-mono text-[12px] font-medium whitespace-nowrap tabular-nums ${
                      rec.status === 'Returned' ? 'text-emerald-800' : 'text-red-700'
                    }`}
                  >
                    {rec.total !== null ? (
                      <>
                        {rec.status === 'Returned' ? '+' : ''}
                        {Math.abs(rec.total).toLocaleString('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        })}
                        {rec.status === 'Returned' && (
                          <div className="font-sans text-[10px] font-normal text-emerald-700">
                            Income
                          </div>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>

                  <td className="max-w-[175px] px-2 py-2">
                    <div
                      className="truncate text-slate-800"
                      title={`Shipped To: ${rec.shippedTo || '—'}`}
                    >
                      {rec.shippedTo || '—'}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-slate-500"
                      title={`Payment Method: ${rec.paymentMethod || '—'}${
                        rec.sourceFileName ? ` (${rec.sourceFileName})` : ''
                      }`}
                    >
                      {rec.paymentMethod || '—'}
                    </div>
                  </td>

                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`text-[11px] ${getStatusTextClass(rec.status)}`}>
                      {rec.status || '—'}
                    </span>
                  </td>

                  <td className="px-2 py-2 whitespace-nowrap">
                    <select
                      value={currentCat}
                      onChange={(e) => onUpdateCategory(rec, e.target.value)}
                      disabled={isDup || updatingCategoryKey === rec.rowKey}
                      aria-label={`Category for ${rec.uniqueId}`}
                      className="w-[140px] rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-800 focus:border-teal-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">—</option>
                      {rowCatOptions.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td className="px-2 py-2 whitespace-nowrap">
                    {(() => {
                      const trimmedExpId = (rec.expId ?? '').trim();
                      const matchedExp = trimmedExpId
                        ? expenseByIdMap?.get(trimmedExpId)
                        : undefined;
                      if (trimmedExpId) {
                        const tooltip = matchedExp
                          ? `${matchedExp.expId} · ${matchedExp.date} · ${Math.abs(matchedExp.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} · ${matchedExp.description}`
                          : `Exp_ID: ${trimmedExpId}`;
                        return (
                          <button
                            type="button"
                            onClick={() => onEditRecord(rec)}
                            disabled={isDup}
                            title={tooltip}
                            className="text-left font-mono text-[11px] font-medium text-teal-800 hover:underline disabled:cursor-not-allowed disabled:opacity-50 tabular-nums"
                          >
                            {trimmedExpId}
                          </button>
                        );
                      }
                      if (isDup) {
                        return <span className="text-[11px] text-slate-400">—</span>;
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => onEditRecord(rec)}
                          title="Match or enter Expense Ledger Exp_ID"
                          className="font-mono text-[11px] text-slate-400 hover:text-teal-700 hover:underline"
                        >
                          —
                        </button>
                      );
                    })()}
                  </td>

                  <td className="py-2 pl-2 pr-3 whitespace-nowrap">
                    {(() => {
                      const trimmedBankId = (rec.bankId ?? '').trim();
                      const matchedBank = trimmedBankId
                        ? bankByIdMap?.get(trimmedBankId)
                        : undefined;
                      if (trimmedBankId) {
                        const tooltip = matchedBank
                          ? `${matchedBank.uniqueId} (${matchedBank.accountTab}) · ${matchedBank.date} · ${Math.abs(matchedBank.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} · ${matchedBank.description}`
                          : `Bank_ID: ${trimmedBankId}`;
                        return (
                          <button
                            type="button"
                            onClick={() => onEditRecord(rec)}
                            disabled={isDup}
                            title={tooltip}
                            className="max-w-[130px] truncate text-left font-mono text-[11px] font-medium text-teal-800 hover:underline disabled:cursor-not-allowed disabled:opacity-50 tabular-nums"
                          >
                            {trimmedBankId}
                          </button>
                        );
                      }
                      if (isDup) {
                        return <span className="text-[11px] text-slate-400">—</span>;
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => onEditRecord(rec)}
                          title="Match or enter Bank Statement Ledger Bank_ID"
                          className="font-mono text-[11px] text-slate-400 hover:text-teal-700 hover:underline"
                        >
                          —
                        </button>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TablePagination
        totalItems={records.length}
        pageSize={pageSize}
        currentPage={safePage}
        singularLabel="Amazon order"
        pluralLabel="Amazon orders"
        onPageChange={setCurrentPage}
        onPageSizeChange={(newSize) => {
          setPageSize(newSize);
          setCurrentPage(1);
        }}
      />
    </div>
  );
};
