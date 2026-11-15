import React, { useEffect, useState } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { ColumnMapping, UploadedStatement } from '../types/statement';

interface ColumnMappingModalProps {
  statement: UploadedStatement | null;
  onClose: () => void;
  onSave: (statementId: string, mapping: ColumnMapping) => void;
}

export const ColumnMappingModal: React.FC<ColumnMappingModalProps> = ({
  statement,
  onClose,
  onSave,
}) => {
  const [draft, setDraft] = useState<ColumnMapping>({
    dateCol: '',
    descriptionCol: '',
    amountMode: 'single',
    amountCol: '',
    debitCol: '',
    creditCol: '',
    checkCol: '',
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (statement) {
      setDraft({ ...statement.mapping });
      setValidationError(null);
    }
  }, [statement]);

  if (!statement) return null;

  const sampleRows = statement.rawRows.slice(0, 3);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.dateCol || !draft.descriptionCol) {
      setValidationError('Please select both a Date column and a Description column.');
      return;
    }
    if (draft.amountMode === 'single' && !draft.amountCol) {
      setValidationError('Please select an Amount column.');
      return;
    }
    if (draft.amountMode === 'split' && (!draft.debitCol || !draft.creditCol)) {
      setValidationError('Please select both Debit and Credit columns.');
      return;
    }
    onSave(statement.id, draft);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mapping-modal-title"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 id="mapping-modal-title" className="text-base font-semibold text-slate-900">
              Map Statement Columns
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {statement.fileName} · {statement.rawRows.length.toLocaleString()} rows
              {statement.skippedPreambleLines > 0
                ? ` · ${statement.skippedPreambleLines} preamble line(s) skipped`
                : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-teal-700"
            aria-label="Close mapping dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {validationError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{validationError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="map-date">
                Transaction Date Column
              </label>
              <select
                id="map-date"
                value={draft.dateCol}
                onChange={(e) => setDraft({ ...draft, dateCol: e.target.value })}
                className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                <option value="">Select column...</option>
                {statement.rawHeaders.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="map-desc">
                Description / Memo Column
              </label>
              <select
                id="map-desc"
                value={draft.descriptionCol}
                onChange={(e) => setDraft({ ...draft, descriptionCol: e.target.value })}
                className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                <option value="">Select column...</option>
                {statement.rawHeaders.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">Amount Format</span>
              <div className="flex items-center gap-1 rounded-md bg-slate-100 p-0.5">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, amountMode: 'single' })}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                    draft.amountMode === 'single'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Single Amount Column
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, amountMode: 'split' })}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                    draft.amountMode === 'split'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Separate Debit & Credit
                </button>
              </div>
            </div>

            {draft.amountMode === 'single' ? (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="map-amt">
                    Signed Amount Column
                  </label>
                  <select
                    id="map-amt"
                    value={draft.amountCol}
                    onChange={(e) => setDraft({ ...draft, amountCol: e.target.value })}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">Select column...</option>
                    {statement.rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="map-chk">
                    Check # Column (Optional)
                  </label>
                  <select
                    id="map-chk"
                    value={draft.checkCol}
                    onChange={(e) => setDraft({ ...draft, checkCol: e.target.value })}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">None / Extract from description</option>
                    {statement.rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="map-debit">
                    Debit (Expense) Column
                  </label>
                  <select
                    id="map-debit"
                    value={draft.debitCol}
                    onChange={(e) => setDraft({ ...draft, debitCol: e.target.value })}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">Select column...</option>
                    {statement.rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="map-credit">
                    Credit (Income) Column
                  </label>
                  <select
                    id="map-credit"
                    value={draft.creditCol}
                    onChange={(e) => setDraft({ ...draft, creditCol: e.target.value })}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">Select column...</option>
                    {statement.rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="map-chk-split">
                    Check # Column (Optional)
                  </label>
                  <select
                    id="map-chk-split"
                    value={draft.checkCol}
                    onChange={(e) => setDraft({ ...draft, checkCol: e.target.value })}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">None / Extract from description</option>
                    {statement.rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {sampleRows.length > 0 && (
            <div className="border-t border-slate-100 pt-4">
              <div className="mb-2 text-xs font-medium text-slate-700">
                Sample Raw CSV Rows (First {sampleRows.length})
              </div>
              <div className="max-h-40 overflow-auto rounded-md border border-slate-200">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-slate-600">
                    <tr>
                      {statement.rawHeaders.map((h) => (
                        <th key={h} className="border-b border-slate-200 px-2.5 py-1.5 font-medium whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px] text-slate-700">
                    {sampleRows.map((row, idx) => (
                      <tr key={idx}>
                        {statement.rawHeaders.map((h) => (
                          <td key={h} className="max-w-[180px] truncate px-2.5 py-1.5">
                            {row[h] || '—'}
                          </td>
                        ))}
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
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 whitespace-nowrap"
            >
              Apply Column Mapping
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
