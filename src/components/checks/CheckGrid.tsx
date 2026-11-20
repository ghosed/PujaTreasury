import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, FileUp, Pencil, Plus } from 'lucide-react';
import { CheckRecord } from '../../types/check';
import { isValid12CharUniqueId } from '../../utils/checkProcessor';
import { GoogleSignInButton } from '../GoogleSignInButton';

export type CheckSortField = 'date' | 'checkNumber';

interface CheckGridProps {
  records: CheckRecord[];
  hasUploadedFiles: boolean;
  isLoading: boolean;
  needsAuth: boolean;
  isLoggingIn: boolean;
  sortField: CheckSortField;
  sortOrder: 'desc' | 'asc';
  updatingReconKey: string | null;
  onSignIn: () => void;
  onToggleSort: (field: CheckSortField) => void;
  onEditRecord: (record: CheckRecord) => void;
  onUpdateIsRecon: (record: CheckRecord, isRecon: 'Yes' | 'No') => void;
  onTriggerUpload: () => void;
  onOpenManualEntry: () => void;
  onResetFilters: () => void;
}

export const CheckGrid: React.FC<CheckGridProps> = ({
  records,
  hasUploadedFiles,
  isLoading,
  needsAuth,
  isLoggingIn,
  sortField,
  sortOrder,
  updatingReconKey,
  onSignIn,
  onToggleSort,
  onEditRecord,
  onUpdateIsRecon,
  onTriggerUpload,
  onOpenManualEntry,
  onResetFilters,
}) => {
  if (isLoading) {
    return (
      <div className="divide-y divide-slate-100">
        {Array.from({ length: 7 }).map((_, idx) => (
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

  if (!hasUploadedFiles && records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
          <FileUp className="h-5 w-5" aria-hidden="true" />
        </div>
        {needsAuth ? (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              Sign in to load your Check_Ledger Google Sheet
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Connect your Google account to load existing records from{' '}
              <strong>Check_Ledger</strong>, or upload check images / PDFs to scan and
              extract check details.
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
                Upload Check Images / PDFs
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              No check records found in Check_Ledger
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Upload single or multi-check images and PDFs from the sidebar to extract check
              number, 9-digit MICR routing number, bank, date, amount, paid to, paid by, and memo fields.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onTriggerUpload}
                className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 whitespace-nowrap"
              >
                Upload Check Images / PDFs
              </button>
              <button
                type="button"
                onClick={onOpenManualEntry}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Check Manually
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
          No check records match the current filter
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Adjust your search query or clear active filters to view scanned or saved checks.
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

  const renderSortIcon = (field: CheckSortField) => {
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
              <th className="px-4 py-2.5 font-medium whitespace-nowrap">State / Edit</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Is_Recon</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onToggleSort('date')}
                  className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900"
                  title="Sort by Check Date"
                >
                  <span>Date</span>
                  {renderSortIcon('date')}
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Unique ID</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onToggleSort('checkNumber')}
                  className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900"
                  title="Sort by Check #"
                >
                  <span>Check #</span>
                  {renderSortIcon('checkNumber')}
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Routing #</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Bank</th>
              <th className="px-3 py-2.5 font-medium whitespace-nowrap">Transaction Type</th>
              <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Amount</th>
              <th className="px-3 py-2.5 font-medium">Paid To</th>
              <th className="px-3 py-2.5 font-medium">Paid By</th>
              <th className="px-4 py-2.5 font-medium">Memo / For</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {records.map((rec) => {
              const isScanned = rec.sourceOrigin === 'scan';
              const isDup = Boolean(rec.isDuplicate);
              const isLegacyId = !isValid12CharUniqueId(rec.uniqueId);

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
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="inline-flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => onEditRecord(rec)}
                        disabled={isDup}
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 hover:text-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
                        title={
                          isDup
                            ? rec.duplicateReason || 'Duplicate check copy'
                            : `Edit ${rec.uniqueId}`
                        }
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        Edit
                      </button>
                      <span
                        className={`text-[11px] ${
                          isDup
                            ? 'font-medium text-amber-800'
                            : isScanned
                              ? 'font-medium text-teal-700'
                              : 'text-slate-500'
                        }`}
                        title={rec.duplicateReason}
                      >
                        {isDup
                          ? 'Duplicate Skipped'
                          : isScanned
                            ? 'Scanned (Ready)'
                            : 'In Sheet'}
                      </span>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <select
                      value={rec.isRecon === 'Yes' ? 'Yes' : 'No'}
                      onChange={(e) =>
                        onUpdateIsRecon(rec, e.target.value === 'Yes' ? 'Yes' : 'No')
                      }
                      disabled={isDup || updatingReconKey === rec.rowKey}
                      aria-label={`Is_Recon for ${rec.uniqueId}`}
                      className={`rounded border bg-white px-2 py-1 text-[11px] font-medium focus:border-teal-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                        rec.isRecon === 'Yes'
                          ? 'border-emerald-300 text-emerald-800'
                          : 'border-slate-300 text-slate-700'
                      }`}
                    >
                      <option value="No">No</option>
                      <option value="Yes">Yes</option>
                    </select>
                  </td>

                  <td className="px-3 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums">
                    {rec.date || '—'}
                  </td>

                  <td
                    className={`max-w-[160px] truncate px-3 py-2.5 font-mono text-[11px] tabular-nums ${
                      isLegacyId ? 'text-amber-700' : 'text-slate-700'
                    }`}
                    title={
                      isLegacyId
                        ? `${rec.uniqueId} (Legacy ID — use Replace Legacy Unique IDs to upgrade to 12-char hash)`
                        : rec.uniqueId
                    }
                  >
                    {rec.uniqueId}
                  </td>

                  <td className="px-3 py-2.5 font-mono text-[12px] text-slate-800 whitespace-nowrap tabular-nums">
                    {rec.checkNumber || '—'}
                  </td>

                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                    {rec.routingNumber || '—'}
                  </td>

                  <td className="max-w-[160px] truncate px-3 py-2.5 text-slate-700" title={rec.bank}>
                    {rec.bank || '—'}
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span
                      className={`font-medium ${
                        rec.transactionType === 'Income'
                          ? 'text-emerald-700'
                          : 'text-red-700'
                      }`}
                    >
                      {rec.transactionType}
                    </span>
                  </td>

                  <td className="px-3 py-2.5 text-right font-mono text-[12px] font-medium text-slate-900 whitespace-nowrap tabular-nums">
                    {rec.amount.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                    })}
                  </td>

                  <td className="max-w-[180px] truncate px-3 py-2.5 text-slate-800" title={rec.paidTo}>
                    {rec.paidTo || '—'}
                  </td>

                  <td className="max-w-[190px] px-3 py-2.5">
                    <div className="truncate text-slate-800" title={rec.paidBy}>
                      {rec.paidBy || '—'}
                    </div>
                    {rec.sourceFileName && (
                      <div className="mt-0.5 truncate text-[11px] text-slate-400">
                        {rec.sourceFileName}
                      </div>
                    )}
                  </td>

                  <td className="max-w-[220px] truncate px-4 py-2.5 text-slate-600" title={rec.memo}>
                    {rec.memo || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-2 text-xs text-slate-500">
        <span className="font-mono tabular-nums">
          Showing {records.length.toLocaleString()}{' '}
          {records.length === 1 ? 'check record' : 'check records'}
        </span>
      </div>
    </div>
  );
};
