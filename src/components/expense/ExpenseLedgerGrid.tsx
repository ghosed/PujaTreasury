import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  FileUp,
  Pencil,
  Plus,
} from 'lucide-react';
import { ExpenseRecord } from '../../types/expense';
import { AllocationSummary } from '../../types/reconciliation';
import { expenseRecordKey } from '../../utils/reconAllocations';
import { GoogleSignInButton } from '../GoogleSignInButton';
import { ReconLinkCell } from '../ReconLinkCell';
import { TablePagination } from '../TablePagination';

interface ExpenseLedgerGridProps {
  records: ExpenseRecord[];
  hasUploadedCsv: boolean;
  isLoading: boolean;
  needsAuth: boolean;
  isLoggingIn: boolean;
  dateSortOrder: 'desc' | 'asc';
  updatingReconExpId: string | null;
  allocationMap?: Map<string, AllocationSummary>;
  onSignIn: () => void;
  onToggleDateSort: () => void;
  onEditRecord: (record: ExpenseRecord) => void;
  onUpdateIsRecon: (record: ExpenseRecord, isRecon: 'Yes' | 'No') => void;
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
  updatingReconExpId,
  allocationMap,
  onSignIn,
  onToggleDateSort,
  onEditRecord,
  onUpdateIsRecon,
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
                  <span>Date / Exp_ID</span>
                  {dateSortOrder === 'desc' ? (
                    <ArrowDown className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" />
                  )}
                </button>
              </th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">
                Category / Sub Category
              </th>
              <th className="px-2 py-2 text-right font-medium whitespace-nowrap">
                Amount / Mode
              </th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Status</th>
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Notes</th>
              <th className="py-2 pl-2 pr-3 font-medium whitespace-nowrap">
                Recon Source / ID
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginatedRecords.map((rec) => {
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
                  <td className="py-2 pl-3 pr-2 whitespace-nowrap">
                    {(() => {
                      const alloc = allocationMap?.get(expenseRecordKey(rec));
                      const isPartialLink = alloc?.status === 'partial';
                      const isFullLink =
                        alloc?.status === 'full' ||
                        (!alloc?.links.length &&
                          rec.reconSourceId.trim() !== '' &&
                          rec.isRecon === 'Yes');
                      const isReconLocked = isFullLink || isPartialLink;
                      const reconLockTitle =
                        isPartialLink && alloc
                          ? `Partially linked (${alloc.allocatedAmount.toLocaleString('en-US', {
                              style: 'currency',
                              currency: 'USD',
                            })} / ${alloc.totalAmount.toLocaleString('en-US', {
                              style: 'currency',
                              currency: 'USD',
                            })}) — allocate remaining ${alloc.remainingAmount.toLocaleString(
                              'en-US',
                              { style: 'currency', currency: 'USD' }
                            )} to mark Yes`
                          : isFullLink
                            ? 'Locked to Yes while fully linked to Bank_Ledger'
                            : `Set Is_Recon for ${rec.expId}`;
                      return (
                        <div className="space-y-1">
                          <div>
                            <button
                              type="button"
                              onClick={() => onEditRecord(rec)}
                              aria-label={`Edit ${rec.expId}`}
                              title={`Edit ${rec.expId}`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:text-teal-800"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </div>
                          <div>
                            <select
                              value={rec.isRecon === 'Yes' ? 'Yes' : 'No'}
                              onChange={(e) =>
                                onUpdateIsRecon(rec, e.target.value === 'Yes' ? 'Yes' : 'No')
                              }
                              disabled={updatingReconExpId === rec.expId || isReconLocked}
                              aria-label={`Is_Recon for ${rec.expId}`}
                              title={reconLockTitle}
                              className={`rounded border bg-white px-1.5 py-0.5 text-[11px] font-medium focus:border-teal-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                                rec.isRecon === 'Yes'
                                  ? 'border-emerald-300 text-emerald-800'
                                  : isPartialLink
                                    ? 'border-amber-300 text-amber-800'
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
                    <span
                      className={`text-[11px] ${
                        isStaged ? 'font-medium text-teal-700' : 'text-slate-500'
                      }`}
                      title={
                        isStaged
                          ? 'Loaded from an uploaded expense CSV and pending sync to Expense_Ledger'
                          : 'Already saved in the Expense_Ledger Google Sheet'
                      }
                    >
                      {isStaged ? 'Uploaded (rdy2sync)' : 'In Sheet'}
                    </span>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <div className="font-mono text-[12px] text-slate-800 tabular-nums">
                      {rec.date}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                      {rec.expId}
                    </div>
                  </td>
                  <td className="max-w-[165px] px-2 py-2">
                    <div className="truncate font-medium text-slate-800" title={rec.category}>
                      {rec.category || '—'}
                    </div>
                    {rec.subCategory && (
                      <div
                        className="mt-0.5 truncate text-[11px] text-slate-500"
                        title={rec.subCategory}
                      >
                        {rec.subCategory}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <div className="font-mono text-[12px] font-medium text-red-700 tabular-nums">
                      {rec.amount.toLocaleString('en-US', {
                        style: 'currency',
                        currency: 'USD',
                      })}
                    </div>
                    <div
                      className="mt-0.5 text-[11px] text-slate-500"
                      title={rec.paymentMode ? `Payment Mode: ${rec.paymentMode}` : undefined}
                    >
                      {rec.paymentMode || '—'}
                    </div>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`font-medium ${statusColor}`}>{rec.status || '—'}</span>
                  </td>
                  <td className="max-w-[260px] px-2 py-2">
                    <div className="truncate text-slate-800" title={rec.description}>
                      {rec.description || '—'}
                    </div>
                    {(rec.puja || rec.sourceFileName) && (
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">
                        {rec.puja && (
                          <span className="font-medium text-slate-600" title={`Puja: ${rec.puja}`}>
                            [{rec.puja}]
                          </span>
                        )}
                        {rec.sourceFileName && (
                          <span className="text-slate-400" title={rec.sourceFileName}>
                            {rec.puja ? ' · ' : ''}
                            {rec.sourceFileName}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[180px] px-2 py-2">
                    <div
                      className={`truncate ${
                        rec.notes ? 'font-medium text-slate-700' : 'text-slate-400'
                      }`}
                      title={rec.notes || undefined}
                    >
                      {rec.notes || '—'}
                    </div>
                  </td>
                  <td className="max-w-[180px] py-2 pl-2 pr-3">
                    <div className="truncate text-slate-700" title={rec.reconSource}>
                      {rec.reconSource || '—'}
                    </div>
                    {(rec.reconSourceId ||
                      (allocationMap?.get(expenseRecordKey(rec))?.links.length ?? 0) > 0) && (
                      <div className="mt-0.5">
                        <ReconLinkCell
                          summary={allocationMap?.get(expenseRecordKey(rec))}
                          fallbackId={rec.reconSourceId}
                          partnerLabel="Bank Unique_ID"
                          linkDirection="to-bank"
                          emptyLabel=""
                        />
                      </div>
                    )}
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
        singularLabel="expense record"
        pluralLabel="expense records"
        onPageChange={setCurrentPage}
        onPageSizeChange={(newSize) => {
          setPageSize(newSize);
          setCurrentPage(1);
        }}
      />
    </div>
  );
};
