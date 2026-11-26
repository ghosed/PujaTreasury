import React, { useEffect, useState } from 'react';
import { Columns3, X } from 'lucide-react';
import { ExpenseCsvColumnMapping, UploadedExpenseCsv } from '../../types/expense';
import { TREAT_AS_ACTUAL_SENTINEL } from '../../utils/expenseProcessor';

interface ExpenseCsvMappingModalProps {
  csvFile: UploadedExpenseCsv | null;
  onClose: () => void;
  onSave: (fileId: string, mapping: ExpenseCsvColumnMapping) => void;
}

export const ExpenseCsvMappingModal: React.FC<ExpenseCsvMappingModalProps> = ({
  csvFile,
  onClose,
  onSave,
}) => {
  const [mapping, setMapping] = useState<ExpenseCsvColumnMapping>({
    expIdCol: '',
    dateCol: '',
    amountCol: '',
    categoryCol: '',
    subCategoryCol: '',
    descriptionCol: '',
    statusCol: '',
    requestTypeCol: '',
    pujaCol: '',
    paymentModeCol: '',
    reconSourceCol: '',
    reconSourceIdCol: '',
    notesCol: '',
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (csvFile) {
      setMapping(csvFile.mapping);
      setValidationError(null);
    }
  }, [csvFile]);

  if (!csvFile) return null;

  const headers = csvFile.rawHeaders;
  const previewRows = csvFile.rawRows.slice(0, 4);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !mapping.dateCol ||
      !mapping.amountCol ||
      !mapping.categoryCol ||
      !mapping.descriptionCol ||
      !mapping.statusCol ||
      !mapping.requestTypeCol
    ) {
      setValidationError(
        'Please map all mandatory CSV columns: Date, Amount, Category, Description, Status, and Request Type.'
      );
      return;
    }
    onSave(csvFile.id, mapping);
    onClose();
  };

  const renderSelect = (
    id: string,
    label: string,
    value: string,
    onChange: (val: string) => void,
    required: boolean,
    emptyLabel: string,
    extraOptions?: Array<{ value: string; label: string }>
  ) => (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
      >
        <option value="">{emptyLabel}</option>
        {extraOptions?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expense-csv-mapping-title"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Columns3 className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="expense-csv-mapping-title" className="text-base font-semibold text-slate-900">
                Map Expense Tracker CSV Columns
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {csvFile.fileName} · {csvFile.rawRows.length.toLocaleString()} raw rows
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            aria-label="Close mapping dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {renderSelect(
              'exp-map-id',
              'Exp_ID / Unique ID',
              mapping.expIdCol,
              (v) => setMapping((m) => ({ ...m, expIdCol: v })),
              false,
              'Auto-generate unique ID if absent'
            )}
            {renderSelect(
              'exp-map-date',
              'Date',
              mapping.dateCol,
              (v) => setMapping((m) => ({ ...m, dateCol: v })),
              true,
              'Select Date column...'
            )}
            {renderSelect(
              'exp-map-amount',
              'Amount',
              mapping.amountCol,
              (v) => setMapping((m) => ({ ...m, amountCol: v })),
              true,
              'Select Amount column...'
            )}
            {renderSelect(
              'exp-map-category',
              'Category',
              mapping.categoryCol,
              (v) => setMapping((m) => ({ ...m, categoryCol: v })),
              true,
              'Select Category column...'
            )}
            {renderSelect(
              'exp-map-description',
              'Description',
              mapping.descriptionCol,
              (v) => setMapping((m) => ({ ...m, descriptionCol: v })),
              true,
              'Select Description column...'
            )}
            {renderSelect(
              'exp-map-status',
              'Status (filters Accepted / Paid)',
              mapping.statusCol,
              (v) => setMapping((m) => ({ ...m, statusCol: v })),
              true,
              'Select Status column...'
            )}
            {renderSelect(
              'exp-map-reqtype',
              'Request Type (filters Actual)',
              mapping.requestTypeCol,
              (v) => setMapping((m) => ({ ...m, requestTypeCol: v })),
              true,
              'Select Request Type column...',
              [
                {
                  value: TREAT_AS_ACTUAL_SENTINEL,
                  label: 'No Request Type column (treat all rows as Actual)',
                },
              ]
            )}
            {renderSelect(
              'exp-map-subcat',
              'Sub Category',
              mapping.subCategoryCol,
              (v) => setMapping((m) => ({ ...m, subCategoryCol: v })),
              false,
              'None / Optional'
            )}
            {renderSelect(
              'exp-map-puja',
              'Puja',
              mapping.pujaCol,
              (v) => setMapping((m) => ({ ...m, pujaCol: v })),
              false,
              'None / Optional'
            )}
            {renderSelect(
              'exp-map-paymode',
              'Payment Mode',
              mapping.paymentModeCol,
              (v) => setMapping((m) => ({ ...m, paymentModeCol: v })),
              false,
              'None / Optional'
            )}
            {renderSelect(
              'exp-map-reconsrc',
              'Recon Source',
              mapping.reconSourceCol,
              (v) => setMapping((m) => ({ ...m, reconSourceCol: v })),
              false,
              'None / Optional'
            )}
            {renderSelect(
              'exp-map-reconid',
              'Recon Source ID',
              mapping.reconSourceIdCol,
              (v) => setMapping((m) => ({ ...m, reconSourceIdCol: v })),
              false,
              'None / Optional'
            )}
            {renderSelect(
              'exp-map-notes',
              'Notes (Supplier / Vendor)',
              mapping.notesCol ?? '',
              (v) => setMapping((m) => ({ ...m, notesCol: v })),
              false,
              'Auto-detect from Description if absent'
            )}
          </div>

          {previewRows.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-slate-600">
                Sample Rows from CSV (first {previewRows.length})
              </div>
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      {headers.map((h) => (
                        <th
                          key={h}
                          className="border-b border-slate-200 px-3 py-2 font-medium whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewRows.map((row, idx) => (
                      <tr key={idx} className="text-slate-700">
                        {headers.map((h) => (
                          <td
                            key={h}
                            className="max-w-[180px] truncate px-3 py-2 font-mono text-[11px]"
                          >
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

          {validationError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              {validationError}
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
