import React, { useEffect, useState } from 'react';
import { FileSpreadsheet, X } from 'lucide-react';
import { CheckRecord, CheckTransactionType } from '../../types/check';
import {
  buildCheckCanonicalKey,
  buildCheckRoutingKey,
  buildCheckUniqueId,
  deriveCheckTransactionType,
  normalizeCheckDate,
  normalizeRoutingNumber,
} from '../../utils/checkProcessor';

interface CheckEntryModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  record: CheckRecord | null;
  isSaving: boolean;
  onClose: () => void;
  onSave: (nextRecord: CheckRecord, original: CheckRecord | null) => Promise<void> | void;
}

export const CheckEntryModal: React.FC<CheckEntryModalProps> = ({
  isOpen,
  mode,
  record,
  isSaving,
  onClose,
  onSave,
}) => {
  const [checkNumber, setCheckNumber] = useState('');
  const [routingNumber, setRoutingNumber] = useState('');
  const [bank, setBank] = useState('');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [memo, setMemo] = useState('');
  const [transactionType, setTransactionType] = useState<CheckTransactionType>('Income');
  const [isRecon, setIsRecon] = useState<'Yes' | 'No'>('No');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValidationError(null);
    if (mode === 'edit' && record) {
      setCheckNumber(record.checkNumber);
      setRoutingNumber(record.routingNumber || '');
      setBank(record.bank);
      setDate(record.date);
      setAmount(record.amount > 0 ? record.amount.toFixed(2) : '');
      setPaidTo(record.paidTo);
      setPaidBy(record.paidBy);
      setMemo(record.memo);
      setTransactionType(record.transactionType);
      setIsRecon(record.isRecon);
    } else {
      const today = new Date().toISOString().slice(0, 10);
      setCheckNumber('');
      setRoutingNumber('');
      setBank('');
      setDate(today);
      setAmount('');
      setPaidTo('');
      setPaidBy('');
      setMemo('');
      setTransactionType('Income');
      setIsRecon('No');
    }
  }, [isOpen, mode, record]);

  if (!isOpen) return null;

  const previewUniqueId = buildCheckUniqueId(checkNumber, routingNumber, date, bank);

  const handlePaidByChange = (nextPaidBy: string) => {
    setPaidBy(nextPaidBy);
    setTransactionType(deriveCheckTransactionType(nextPaidBy));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedCheck = checkNumber.trim().replace(/^#/, '');
    const cleanRouting = normalizeRoutingNumber(routingNumber);
    const trimmedBank = bank.trim();
    const normDate = normalizeCheckDate(date);
    const parsedAmount = Number.parseFloat(amount.replace(/[$,\s]/g, ''));

    if (!trimmedCheck) {
      setValidationError('Check Number is required.');
      return;
    }
    if (routingNumber.trim() && cleanRouting.length !== 9) {
      setValidationError('MICR Routing Number must be exactly 9 digits (or leave blank if unavailable).');
      return;
    }
    if (!trimmedBank) {
      setValidationError('Bank name is required.');
      return;
    }
    if (!normDate) {
      setValidationError('A valid check Date is required.');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setValidationError('Amount must be greater than zero.');
      return;
    }

    const amountCents = Math.round(Math.abs(parsedAmount) * 100);
    const nextUniqueId = buildCheckUniqueId(trimmedCheck, cleanRouting, normDate, trimmedBank);

    const nextRecord: CheckRecord = {
      rowKey:
        record?.rowKey ??
        `manual-check-${nextUniqueId}-${crypto.randomUUID().slice(0, 8)}`,
      uniqueId: nextUniqueId,
      canonicalKey: buildCheckCanonicalKey(trimmedCheck, trimmedBank, normDate),
      routingKey: buildCheckRoutingKey(trimmedCheck, cleanRouting, normDate),
      checkNumber: trimmedCheck,
      routingNumber: cleanRouting,
      bank: trimmedBank,
      date: normDate,
      amount: amountCents / 100,
      amountCents,
      paidTo: paidTo.trim(),
      paidBy: paidBy.trim(),
      memo: memo.trim(),
      transactionType,
      isRecon,
      sourceOrigin: record?.sourceOrigin ?? 'scan',
      sourceFileName: record?.sourceFileName ?? 'Manual Check Entry',
      isDuplicate: false,
      sheetRowNumber: record?.sheetRowNumber,
      rawRowValues: record?.rawRowValues,
    };

    await onSave(nextRecord, record);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="check-entry-modal-title"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="check-entry-modal-title" className="text-base font-semibold text-slate-900">
                {mode === 'edit'
                  ? `Edit Check Record${record?.sheetRowNumber ? ` (Row #${record.sheetRowNumber})` : ' (Staged)'}`
                  : 'Add Check Record'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Transaction Type automatically defaults to Expense when Paid By is Houston Durgabari Society.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close check editor modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5">
            <div>
              <div className="text-[11px] text-slate-500">
                Column A · 12-Char Deterministic Unique ID
              </div>
              <div className="mt-0.5 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                {previewUniqueId}
              </div>
            </div>
            <div className="text-[11px] text-slate-500">
              SHA-256(Date + Check # + 9-Digit MICR Routing #)
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="chk-number" className="block text-xs font-medium text-slate-700">
                Check Number <span className="text-red-600">*</span>
              </label>
              <input
                id="chk-number"
                type="text"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                disabled={isSaving}
                placeholder="e.g. 1042"
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-routing" className="block text-xs font-medium text-slate-700">
                9-Digit MICR Routing #
              </label>
              <input
                id="chk-routing"
                type="text"
                inputMode="numeric"
                maxLength={9}
                value={routingNumber}
                onChange={(e) => setRoutingNumber(e.target.value.replace(/\D/g, '').slice(0, 9))}
                disabled={isSaving}
                placeholder="e.g. 111000614"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-bank" className="block text-xs font-medium text-slate-700">
                Bank <span className="text-red-600">*</span>
              </label>
              <input
                id="chk-bank"
                type="text"
                value={bank}
                onChange={(e) => setBank(e.target.value)}
                disabled={isSaving}
                placeholder="e.g. Chase Bank"
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-date" className="block text-xs font-medium text-slate-700">
                Date <span className="text-red-600">*</span>
              </label>
              <input
                id="chk-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={isSaving}
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-amount" className="block text-xs font-medium text-slate-700">
                Amount (USD) <span className="text-red-600">*</span>
              </label>
              <input
                id="chk-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isSaving}
                placeholder="0.00"
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-paid-by" className="block text-xs font-medium text-slate-700">
                Paid By (Top-Left Corner)
              </label>
              <input
                id="chk-paid-by"
                type="text"
                value={paidBy}
                onChange={(e) => handlePaidByChange(e.target.value)}
                disabled={isSaving}
                placeholder="Houston Durgabari Society or donor name"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-paid-to" className="block text-xs font-medium text-slate-700">
                Paid To (Payee Line)
              </label>
              <input
                id="chk-paid-to"
                type="text"
                value={paidTo}
                onChange={(e) => setPaidTo(e.target.value)}
                disabled={isSaving}
                placeholder="Payee name"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="chk-type" className="block text-xs font-medium text-slate-700">
                Transaction Type
              </label>
              <select
                id="chk-type"
                value={transactionType}
                onChange={(e) => setTransactionType(e.target.value as CheckTransactionType)}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                <option value="Income">Income</option>
                <option value="Expense">Expense</option>
              </select>
            </div>

            <div>
              <label htmlFor="chk-is-recon" className="block text-xs font-medium text-slate-700">
                Is_Recon
              </label>
              <select
                id="chk-is-recon"
                value={isRecon}
                onChange={(e) => setIsRecon(e.target.value === 'Yes' ? 'Yes' : 'No')}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="chk-memo" className="block text-xs font-medium text-slate-700">
                Memo / For (Bottom-Left Corner)
              </label>
              <input
                id="chk-memo"
                type="text"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                disabled={isSaving}
                placeholder="Check memo or For note"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
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
                : mode === 'edit' && record?.sourceOrigin === 'sheet'
                  ? 'Save to Check_Ledger'
                  : mode === 'create'
                    ? 'Record Check to Sheet'
                    : 'Update Staged Check'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
