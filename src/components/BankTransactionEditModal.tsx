import React, { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, Lock, X } from 'lucide-react';
import { NormalizedTransaction } from '../types/statement';

export interface BankTransactionEditPayload {
  description: string;
  referenceNumber: string;
  source: string;
  targetId: string;
  isRecon: 'Yes' | 'No';
  category: string;
  notes: string;
}

interface BankTransactionEditModalProps {
  isOpen: boolean;
  transaction: NormalizedTransaction | null;
  expenseCategoryOptions: string[];
  incomeCategoryOptions: string[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (
    transaction: NormalizedTransaction,
    updates: BankTransactionEditPayload
  ) => Promise<void> | void;
}

export const BankTransactionEditModal: React.FC<BankTransactionEditModalProps> = ({
  isOpen,
  transaction,
  expenseCategoryOptions,
  incomeCategoryOptions,
  isSaving,
  onClose,
  onSave,
}) => {
  const [description, setDescription] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [source, setSource] = useState('');
  const [targetId, setTargetId] = useState('');
  const [isRecon, setIsRecon] = useState<'Yes' | 'No'>('No');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !transaction) return;
    setValidationError(null);
    setDescription(transaction.description);
    setReferenceNumber(transaction.referenceNumber);
    setSource(transaction.source);
    setTargetId(transaction.targetId ?? '');
    setIsRecon(
      transaction.isRecon === 'Yes' || Boolean(transaction.targetId?.trim())
        ? 'Yes'
        : 'No'
    );
    setCategory((transaction.category ?? '').trim());
    setNotes((transaction.notes ?? '').trim());
  }, [isOpen, transaction]);

  const effectiveCategories = useMemo(() => {
    const base =
      transaction?.transactionType === 'Income'
        ? [...incomeCategoryOptions]
        : [...expenseCategoryOptions];
    const trimmed = category.trim();
    if (trimmed && !base.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      base.unshift(trimmed);
    }
    return base;
  }, [transaction?.transactionType, expenseCategoryOptions, incomeCategoryOptions, category]);

  if (!isOpen || !transaction) return null;

  const isLinked = targetId.trim() !== '';

  const handleTargetIdChange = (nextVal: string) => {
    setTargetId(nextVal);
    if (nextVal.trim() !== '') {
      setIsRecon('Yes');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedDesc = description.trim();
    const trimmedSrc = source.trim();
    const trimmedTarget = targetId.trim();

    if (!trimmedDesc) {
      setValidationError('Description is required.');
      return;
    }
    if (!trimmedSrc) {
      setValidationError('Source is required.');
      return;
    }

    await onSave(transaction, {
      description: trimmedDesc,
      referenceNumber: referenceNumber.trim(),
      source: trimmedSrc,
      targetId: trimmedTarget,
      isRecon: trimmedTarget ? 'Yes' : isRecon,
      category: category.trim(),
      notes: notes.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bank-edit-modal-title"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="bank-edit-modal-title" className="text-base font-semibold text-slate-900">
                Edit Bank Transaction
                {transaction.sheetRowNumber
                  ? ` (Sheet Row #${transaction.sheetRowNumber})`
                  : ' (Staged Row)'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Update reconciliation fields, category, and metadata for Bank_Ledger.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close transaction edit modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {/* Immutable Ledger Identity */}
          <div className="grid grid-cols-2 gap-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 sm:grid-cols-4">
            <div className="col-span-2 sm:col-span-1">
              <div className="flex items-center gap-1 text-[11px] text-slate-500">
                <Lock className="h-3 w-3" aria-hidden="true" />
                <span>Unique ID</span>
              </div>
              <div
                className="mt-0.5 truncate font-mono text-xs font-semibold text-slate-900 tabular-nums"
                title={transaction.uniqueId}
              >
                {transaction.uniqueId}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">Date</div>
              <div className="mt-0.5 font-mono text-xs font-medium text-slate-900 tabular-nums">
                {transaction.date}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">Type</div>
              <div
                className={`mt-0.5 text-xs font-medium ${
                  transaction.transactionType === 'Income'
                    ? 'text-emerald-700'
                    : 'text-red-700'
                }`}
              >
                {transaction.transactionType}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">Amount</div>
              <div className="mt-0.5 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                {transaction.amount.toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                })}
              </div>
            </div>
          </div>

          {/* Reconciliation & Category */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bank-edit-is-recon" className="block text-xs font-medium text-slate-700">
                Is_Recon
                {isLinked && (
                  <span className="ml-1.5 font-normal text-emerald-700">
                    (Locked to Yes while linked)
                  </span>
                )}
              </label>
              <select
                id="bank-edit-is-recon"
                value={isLinked ? 'Yes' : isRecon}
                onChange={(e) => setIsRecon(e.target.value === 'Yes' ? 'Yes' : 'No')}
                disabled={isSaving || isLinked}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-600"
              >
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>

            <div>
              <label htmlFor="bank-edit-category" className="block text-xs font-medium text-slate-700">
                Category
              </label>
              <select
                id="bank-edit-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
              >
                <option value="">None / Uncategorized</option>
                {effectiveCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="bank-edit-target-id" className="block text-xs font-medium text-slate-700">
                Target ID (Linked Exp_ID)
              </label>
              <input
                id="bank-edit-target-id"
                type="text"
                value={targetId}
                onChange={(e) => handleTargetIdChange(e.target.value)}
                disabled={isSaving}
                placeholder="Optional Expense Exp_ID (e.g. EXP-...)"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
              />
            </div>

            <div>
              <label htmlFor="bank-edit-source" className="block text-xs font-medium text-slate-700">
                Source <span className="text-red-600">*</span>
              </label>
              <input
                id="bank-edit-source"
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={isSaving}
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
              />
            </div>

            <div>
              <label htmlFor="bank-edit-ref" className="block text-xs font-medium text-slate-700">
                Reference #
              </label>
              <input
                id="bank-edit-ref"
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                disabled={isSaving}
                placeholder="Check #, confirmation, or trace ID"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
              />
            </div>

            <div>
              <label htmlFor="bank-edit-notes" className="block text-xs font-medium text-slate-700">
                Notes
              </label>
              <input
                id="bank-edit-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={isSaving}
                placeholder="e.g. Amazon or Home Depot"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="bank-edit-desc" className="block text-xs font-medium text-slate-700">
                Description <span className="text-red-600">*</span>
              </label>
              <input
                id="bank-edit-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isSaving}
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
              />
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
              disabled={isSaving}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap"
            >
              {isSaving
                ? 'Saving...'
                : transaction.sheetRowNumber
                  ? 'Save to Google Sheet'
                  : 'Update Staged Row'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
