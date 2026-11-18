import React, { useEffect, useMemo, useState } from 'react';
import { Lock, Receipt, X } from 'lucide-react';
import { ExpenseLookups, ExpenseRecord } from '../../types/expense';
import { generateManualExpenseId, getSubCategoryOptions } from '../../utils/expenseProcessor';

interface ExpenseEntryModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  initialRecord: ExpenseRecord | null;
  lookups: ExpenseLookups;
  existingIds: Set<string>;
  onClose: () => void;
  onSubmit: (record: ExpenseRecord, original: ExpenseRecord | null) => void;
}

export const ExpenseEntryModal: React.FC<ExpenseEntryModalProps> = ({
  isOpen,
  mode,
  initialRecord,
  lookups,
  existingIds,
  onClose,
  onSubmit,
}) => {
  const [expId, setExpId] = useState('');
  const [date, setDate] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [category, setCategory] = useState('');
  const [subCategory, setSubCategory] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('');
  const [puja, setPuja] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const [reconSource, setReconSource] = useState('');
  const [reconSourceId, setReconSourceId] = useState('');
  const [isRecon, setIsRecon] = useState<'Yes' | 'No'>('No');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValidationError(null);

    if (mode === 'edit' && initialRecord) {
      setExpId(initialRecord.expId);
      setDate(initialRecord.date);
      setAmountStr(String(initialRecord.amount));
      setCategory(initialRecord.category);
      setSubCategory(initialRecord.subCategory);
      setDescription(initialRecord.description);
      setStatus(initialRecord.status);
      setPuja(initialRecord.puja);
      setPaymentMode(initialRecord.paymentMode);
      setReconSource(initialRecord.reconSource);
      setReconSourceId(initialRecord.reconSourceId);
      setIsRecon(initialRecord.isRecon === 'Yes' ? 'Yes' : 'No');
    } else {
      const generatedId = generateManualExpenseId(existingIds);
      const today = new Date().toISOString().slice(0, 10);
      setExpId(generatedId);
      setDate(today);
      setAmountStr('');
      setCategory(lookups.categories[0] ?? '');
      setSubCategory('');
      setDescription('');
      setStatus(
        lookups.statuses.find((s) => s.toLowerCase() === 'paid') ??
          lookups.statuses[0] ??
          'Paid'
      );
      setPuja('');
      setPaymentMode('');
      setReconSource('');
      setReconSourceId('');
      setIsRecon('No');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, initialRecord]);

  const subCategoryOptions = useMemo(
    () => getSubCategoryOptions(category, lookups.catSubcatMap),
    [category, lookups.catSubcatMap]
  );

  // Preserve current value in dropdown if editing a legacy row whose value isn't in LookUp
  const categoryOptions = useMemo(() => {
    const base = [...lookups.categories];
    if (category && !base.some((c) => c.toLowerCase() === category.toLowerCase())) {
      base.unshift(category);
    }
    return base;
  }, [lookups.categories, category]);

  const statusOptions = useMemo(() => {
    const base = [...lookups.statuses];
    if (status && !base.some((s) => s.toLowerCase() === status.toLowerCase())) {
      base.unshift(status);
    }
    return base;
  }, [lookups.statuses, status]);

  const pujaOptions = useMemo(() => {
    const base = [...lookups.pujas];
    if (puja && !base.some((p) => p.toLowerCase() === puja.toLowerCase())) {
      base.unshift(puja);
    }
    return base;
  }, [lookups.pujas, puja]);

  const paymentModeOptions = useMemo(() => {
    const base = [...lookups.paymentModes];
    if (paymentMode && !base.some((p) => p.toLowerCase() === paymentMode.toLowerCase())) {
      base.unshift(paymentMode);
    }
    return base;
  }, [lookups.paymentModes, paymentMode]);

  const effectiveSubCatOptions = useMemo(() => {
    const base = [...subCategoryOptions];
    if (subCategory && !base.some((s) => s.toLowerCase() === subCategory.toLowerCase())) {
      base.unshift(subCategory);
    }
    return base;
  }, [subCategoryOptions, subCategory]);

  if (!isOpen) return null;

  const handleCategoryChange = (nextCategory: string) => {
    setCategory(nextCategory);
    const nextSubs = getSubCategoryOptions(nextCategory, lookups.catSubcatMap);
    if (
      subCategory &&
      !nextSubs.some((opt) => opt.toLowerCase() === subCategory.toLowerCase())
    ) {
      setSubCategory('');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedDate = date.trim();
    const parsedAmount = Number(amountStr.replace(/[$,\s]/g, ''));
    const trimmedCat = category.trim();
    const trimmedDesc = description.trim();
    const trimmedStatus = status.trim();

    if (!trimmedDate) {
      setValidationError('Date is required.');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setValidationError('Enter a valid positive Amount.');
      return;
    }
    if (!trimmedCat) {
      setValidationError('Category is required.');
      return;
    }
    if (!trimmedDesc) {
      setValidationError('Description is required.');
      return;
    }
    if (!trimmedStatus) {
      setValidationError('Status is required.');
      return;
    }

    const nextRecord: ExpenseRecord = {
      sheetRowNumber: mode === 'edit' ? (initialRecord?.sheetRowNumber ?? null) : null,
      expId: mode === 'edit' && initialRecord ? initialRecord.expId : expId,
      date: trimmedDate,
      amount: parsedAmount,
      category: trimmedCat,
      subCategory: subCategory.trim(),
      description: trimmedDesc,
      status: trimmedStatus,
      puja: puja.trim(),
      paymentMode: paymentMode.trim(),
      reconSource: reconSource.trim(),
      reconSourceId: reconSourceId.trim(),
      isRecon: reconSourceId.trim() ? 'Yes' : isRecon,
      rawRowValues: mode === 'edit' ? initialRecord?.rawRowValues : undefined,
      sourceOrigin:
        mode === 'edit' && initialRecord ? initialRecord.sourceOrigin : 'manual',
      sourceFileName: mode === 'edit' ? initialRecord?.sourceFileName : undefined,
    };

    onSubmit(nextRecord, initialRecord);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expense-entry-modal-title"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Receipt className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="expense-entry-modal-title" className="text-base font-semibold text-slate-900">
                {mode === 'edit'
                  ? `Edit Expense Record${
                      initialRecord?.sheetRowNumber
                        ? ` (Sheet Row ${initialRecord.sheetRowNumber})`
                        : ''
                    }`
                  : 'Add Expense Item Manually'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {mode === 'edit'
                  ? 'Unique ID (Exp_ID) is locked. All other fields save back to Expense_Ledger.'
                  : 'Enter expense details below. Sub Category options update dynamically by Category.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            aria-label="Close expense entry modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {/* Exp_ID (Always Read-Only) */}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">
                Exp_ID (Unique Identifier)
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                <Lock className="h-3 w-3" aria-hidden="true" />
                {mode === 'edit' ? 'Read-only' : 'Auto-generated'}
              </span>
            </div>
            <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
              {expId}
            </div>
          </div>

          {/* Mandatory Fields */}
          <div>
            <div className="mb-3 text-xs font-semibold text-slate-900">Mandatory Fields</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="exp-date" className="block text-xs font-medium text-slate-700">
                  Date <span className="text-red-600">*</span>
                </label>
                <input
                  id="exp-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="exp-amount" className="block text-xs font-medium text-slate-700">
                  Amount (USD) <span className="text-red-600">*</span>
                </label>
                <input
                  id="exp-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  required
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="exp-category" className="block text-xs font-medium text-slate-700">
                  Category <span className="text-red-600">*</span>
                </label>
                {categoryOptions.length > 0 ? (
                  <select
                    id="exp-category"
                    value={category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    required
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">Select Category...</option>
                    {categoryOptions.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="exp-category"
                    type="text"
                    value={category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    placeholder="Enter Category"
                    required
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                )}
              </div>

              <div>
                <label htmlFor="exp-status" className="block text-xs font-medium text-slate-700">
                  Status <span className="text-red-600">*</span>
                </label>
                {statusOptions.length > 0 ? (
                  <select
                    id="exp-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    required
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">Select Status...</option>
                    {statusOptions.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="exp-status"
                    type="text"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    placeholder="Accepted or Paid"
                    required
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                )}
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="exp-desc" className="block text-xs font-medium text-slate-700">
                  Description <span className="text-red-600">*</span>
                </label>
                <input
                  id="exp-desc"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Vendor, item, or expense details..."
                  required
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Optional Fields */}
          <div className="border-t border-slate-200 pt-4">
            <div className="mb-3 text-xs font-semibold text-slate-900">Optional Fields</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="exp-subcat" className="block text-xs font-medium text-slate-700">
                  Sub Category{' '}
                  <span className="font-normal text-slate-400">
                    ({category ? `for ${category}` : 'select Category first'})
                  </span>
                </label>
                {effectiveSubCatOptions.length > 0 ? (
                  <select
                    id="exp-subcat"
                    value={subCategory}
                    onChange={(e) => setSubCategory(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">None / Unspecified</option>
                    {effectiveSubCatOptions.map((sub) => (
                      <option key={sub} value={sub}>
                        {sub}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="exp-subcat"
                    type="text"
                    value={subCategory}
                    onChange={(e) => setSubCategory(e.target.value)}
                    placeholder={
                      category
                        ? 'No CatSubcat options mapped (optional text)'
                        : 'Select Category first'
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                )}
              </div>

              <div>
                <label htmlFor="exp-puja" className="block text-xs font-medium text-slate-700">
                  Puja
                </label>
                {pujaOptions.length > 0 ? (
                  <select
                    id="exp-puja"
                    value={puja}
                    onChange={(e) => setPuja(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">None / Unspecified</option>
                    {pujaOptions.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="exp-puja"
                    type="text"
                    value={puja}
                    onChange={(e) => setPuja(e.target.value)}
                    placeholder="Optional Puja name"
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                )}
              </div>

              <div>
                <label htmlFor="exp-paymode" className="block text-xs font-medium text-slate-700">
                  Payment Mode
                </label>
                {paymentModeOptions.length > 0 ? (
                  <select
                    id="exp-paymode"
                    value={paymentMode}
                    onChange={(e) => setPaymentMode(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="">None / Unspecified</option>
                    {paymentModeOptions.map((pm) => (
                      <option key={pm} value={pm}>
                        {pm}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="exp-paymode"
                    type="text"
                    value={paymentMode}
                    onChange={(e) => setPaymentMode(e.target.value)}
                    placeholder="Optional Payment Mode"
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                )}
              </div>

              <div>
                <label htmlFor="exp-recon-src" className="block text-xs font-medium text-slate-700">
                  Recon Source
                </label>
                <input
                  id="exp-recon-src"
                  type="text"
                  value={reconSource}
                  onChange={(e) => setReconSource(e.target.value)}
                  placeholder="Optional reconciliation source"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="exp-recon-id" className="block text-xs font-medium text-slate-700">
                  Recon Source ID
                </label>
                <input
                  id="exp-recon-id"
                  type="text"
                  value={reconSourceId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setReconSourceId(next);
                    if (next.trim() !== '') {
                      setIsRecon('Yes');
                    }
                  }}
                  placeholder="Optional reconciliation reference or transaction ID"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="exp-is-recon" className="block text-xs font-medium text-slate-700">
                  Is_Recon
                  {reconSourceId.trim() !== '' && (
                    <span className="ml-1.5 font-normal text-emerald-700">
                      (Yes while linked)
                    </span>
                  )}
                </label>
                <select
                  id="exp-is-recon"
                  value={reconSourceId.trim() ? 'Yes' : isRecon}
                  onChange={(e) =>
                    setIsRecon(e.target.value === 'Yes' ? 'Yes' : 'No')
                  }
                  disabled={reconSourceId.trim() !== ''}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-600"
                >
                  <option value="No">No</option>
                  <option value="Yes">Yes</option>
                </select>
              </div>
            </div>
          </div>

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
              {mode === 'edit'
                ? initialRecord?.sheetRowNumber
                  ? 'Review & Save to Sheet'
                  : 'Update Staged Row'
                : 'Review & Add to Sheet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
