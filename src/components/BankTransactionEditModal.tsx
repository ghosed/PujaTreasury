import React, { useEffect, useMemo, useState } from 'react';
import {
  FileSpreadsheet,
  Link2,
  Loader2,
  Lock,
  Plus,
  Search,
  Unlink,
  X,
} from 'lucide-react';
import { ExpenseRecord } from '../types/expense';
import { AllocationSummary, ReconLink } from '../types/reconciliation';
import { NormalizedTransaction } from '../types/statement';
import {
  expenseRecordKey,
  fromCents,
  MULTIPLE_CATEGORY_LABEL,
  parseExactAmountQueryCents,
  RECON_PENNY_TOLERANCE_CENTS,
  reconPairKey,
  toCents,
} from '../utils/reconAllocations';

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
  allocationSummary?: AllocationSummary;
  allExpenseRecords?: ExpenseRecord[];
  expenseAllocMap?: Map<string, AllocationSummary>;
  isLoadingPartnerRecords?: boolean;
  isMutatingLink?: boolean;
  onClose: () => void;
  onSave: (
    transaction: NormalizedTransaction,
    updates: BankTransactionEditPayload
  ) => Promise<void> | void;
  onAddLink?: (
    transaction: NormalizedTransaction,
    expense: ExpenseRecord,
    allocatedAmount: number,
    notes: string
  ) => Promise<void>;
  onUnlink?: (
    transaction: NormalizedTransaction,
    link: ReconLink
  ) => Promise<void>;
}

function formatUsd(val: number): string {
  return val.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export const BankTransactionEditModal: React.FC<BankTransactionEditModalProps> = ({
  isOpen,
  transaction,
  expenseCategoryOptions,
  incomeCategoryOptions,
  isSaving,
  allocationSummary,
  allExpenseRecords = [],
  expenseAllocMap,
  isLoadingPartnerRecords = false,
  isMutatingLink = false,
  onClose,
  onSave,
  onAddLink,
  onUnlink,
}) => {
  const [description, setDescription] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [source, setSource] = useState('');
  const [targetId, setTargetId] = useState('');
  const [isRecon, setIsRecon] = useState<'Yes' | 'No'>('No');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Add-link picker state
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [expSearch, setExpSearch] = useState('');
  const [pickedExpense, setPickedExpense] = useState<ExpenseRecord | null>(null);
  const [allocAmountStr, setAllocAmountStr] = useState('');
  const [linkNotes, setLinkNotes] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !transaction) return;
    setValidationError(null);
    setLinkError(null);
    setShowAddPicker(false);
    setPickedExpense(null);
    setAllocAmountStr('');
    setLinkNotes('');
    setExpSearch('');
    setDescription(transaction.description);
    setReferenceNumber(transaction.referenceNumber);
    setSource(transaction.source);
    setTargetId(transaction.targetId ?? '');
    if (allocationSummary && allocationSummary.links.length > 0) {
      setIsRecon(allocationSummary.derivedIsRecon);
      setCategory(
        allocationSummary.derivedCategory ?? (transaction.category ?? '').trim()
      );
    } else {
      setIsRecon(
        transaction.isRecon === 'Yes' || Boolean(transaction.targetId?.trim())
          ? 'Yes'
          : 'No'
      );
      setCategory((transaction.category ?? '').trim());
    }
    setNotes((transaction.notes ?? '').trim());
  }, [isOpen, transaction, allocationSummary]);

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

  const expenseByIdMap = useMemo(() => {
    const m = new Map<string, ExpenseRecord>();
    for (const exp of allExpenseRecords) {
      const k = exp.expId.trim().toLowerCase();
      if (k && !m.has(k)) m.set(k, exp);
    }
    return m;
  }, [allExpenseRecords]);

  const bankRemainingCents = useMemo(() => {
    if (!transaction) return 0;
    if (allocationSummary) return allocationSummary.remainingCents;
    return Math.abs(transaction.amountCents);
  }, [transaction, allocationSummary]);

  const candidateExpenses = useMemo(() => {
    if (!transaction) return [];
    const existingPairs = new Set(
      (allocationSummary?.links ?? []).map((l) =>
        reconPairKey(l.bankUniqueId, l.targetType, l.targetId)
      )
    );
    const q = expSearch.trim().toLowerCase();
    const queryAmountCents = parseExactAmountQueryCents(expSearch);

    return allExpenseRecords
      .filter((exp) => {
        if (typeof exp.sheetRowNumber !== 'number' || exp.sheetRowNumber < 1) return false;
        const pKey = reconPairKey(transaction.uniqueId, 'Expense', exp.expId);
        if (existingPairs.has(pKey)) return false;

        const expSummary = expenseAllocMap?.get(expenseRecordKey(exp));
        const rem = expSummary ? expSummary.remainingCents : toCents(Math.abs(exp.amount));
        if (rem <= RECON_PENNY_TOLERANCE_CENTS) return false;

        if (!q) return true;
        const fullCents = toCents(Math.abs(exp.amount));
        const matchesExactAmount =
          queryAmountCents !== null &&
          (rem === queryAmountCents || fullCents === queryAmountCents);
        if (matchesExactAmount) return true;

        const hay =
          `${exp.expId} ${exp.date} ${exp.category} ${exp.subCategory} ${exp.description}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        // Prioritize exact searched amount match, then exact bank remaining match, then same date, then newest date
        const aSummary = expenseAllocMap?.get(expenseRecordKey(a));
        const aRem = aSummary ? aSummary.remainingCents : toCents(Math.abs(a.amount));
        const bSummary = expenseAllocMap?.get(expenseRecordKey(b));
        const bRem = bSummary ? bSummary.remainingCents : toCents(Math.abs(b.amount));

        if (queryAmountCents !== null) {
          const aQueryMatch =
            aRem === queryAmountCents || toCents(Math.abs(a.amount)) === queryAmountCents
              ? 1
              : 0;
          const bQueryMatch =
            bRem === queryAmountCents || toCents(Math.abs(b.amount)) === queryAmountCents
              ? 1
              : 0;
          if (bQueryMatch !== aQueryMatch) return bQueryMatch - aQueryMatch;
        }

        const aExact = Math.abs(aRem - bankRemainingCents) <= 1 ? 1 : 0;
        const bExact = Math.abs(bRem - bankRemainingCents) <= 1 ? 1 : 0;
        if (bExact !== aExact) return bExact - aExact;
        const aSameDate = a.date === transaction.date ? 1 : 0;
        const bSameDate = b.date === transaction.date ? 1 : 0;
        if (bSameDate !== aSameDate) return bSameDate - aSameDate;
        return b.date.localeCompare(a.date);
      })
      .slice(0, 60);
  }, [transaction, allocationSummary, allExpenseRecords, expenseAllocMap, expSearch, bankRemainingCents]);

  if (!isOpen || !transaction) return null;

  const hasManagedLinks = (allocationSummary?.links.length ?? 0) > 0;
  const isFullLinked = allocationSummary?.status === 'full';
  const isPartialLinked = allocationSummary?.status === 'partial';
  const isMultipleCategory =
    allocationSummary?.derivedCategory === MULTIPLE_CATEGORY_LABEL;
  const isLegacyUnmanagedLinked = !hasManagedLinks && targetId.trim() !== '';
  const isIsReconLocked = isFullLinked || isPartialLinked || isLegacyUnmanagedLinked;
  const lockedIsReconValue: 'Yes' | 'No' = isPartialLinked
    ? 'No'
    : isFullLinked || isLegacyUnmanagedLinked
      ? 'Yes'
      : isRecon;

  const canManageSheetLinks =
    Boolean(transaction.sheetRowNumber) &&
    transaction.transactionType === 'Expense' &&
    Boolean(onAddLink) &&
    Boolean(onUnlink);

  const handleTargetIdChange = (nextVal: string) => {
    setTargetId(nextVal);
    if (nextVal.trim() !== '' && !hasManagedLinks) {
      setIsRecon('Yes');
    }
  };

  const handleSelectPartnerExpense = (exp: ExpenseRecord) => {
    setLinkError(null);
    setPickedExpense(exp);
    const expSummary = expenseAllocMap?.get(expenseRecordKey(exp));
    const expRemCents = expSummary ? expSummary.remainingCents : toCents(Math.abs(exp.amount));
    const suggestedCents = Math.min(bankRemainingCents, expRemCents);
    setAllocAmountStr(fromCents(suggestedCents).toFixed(2));
  };

  const handleConfirmAddLink = async () => {
    if (!pickedExpense || !onAddLink) return;
    const parsed = Number(allocAmountStr);
    const allocCents = toCents(parsed);
    if (!Number.isFinite(parsed) || allocCents <= 0) {
      setLinkError('Enter a positive Allocated Amount.');
      return;
    }
    if (allocCents > bankRemainingCents + RECON_PENNY_TOLERANCE_CENTS) {
      setLinkError(
        `Amount exceeds Bank remaining balance (${formatUsd(fromCents(bankRemainingCents))}).`
      );
      return;
    }
    const expSummary = expenseAllocMap?.get(expenseRecordKey(pickedExpense));
    const expRemCents = expSummary
      ? expSummary.remainingCents
      : toCents(Math.abs(pickedExpense.amount));
    if (allocCents > expRemCents + RECON_PENNY_TOLERANCE_CENTS) {
      setLinkError(
        `Amount exceeds Expense remaining balance (${formatUsd(fromCents(expRemCents))}).`
      );
      return;
    }

    setLinkError(null);
    try {
      await onAddLink(transaction, pickedExpense, fromCents(allocCents), linkNotes.trim());
      setShowAddPicker(false);
      setPickedExpense(null);
      setAllocAmountStr('');
      setLinkNotes('');
      setExpSearch('');
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to add link.');
    }
  };

  const handleUnlinkClick = async (link: ReconLink) => {
    if (!onUnlink) return;
    setLinkError(null);
    try {
      await onUnlink(transaction, link);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to unlink item.');
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
      isRecon: isIsReconLocked ? lockedIsReconValue : isRecon,
      category: isMultipleCategory ? MULTIPLE_CATEGORY_LABEL : category.trim(),
      notes: notes.trim(),
    });
  };

  const busy = isSaving || isMutatingLink;

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
                Manage linked Expense allocations, category, and metadata for Bank_Ledger.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
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
                {formatUsd(transaction.amount)}
              </div>
            </div>
          </div>

          {/* Linked Allocations Panel (for sheet-saved Bank Expense rows) */}
          {canManageSheetLinks && (
            <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link2 className="h-4 w-4 text-teal-700" aria-hidden="true" />
                  <span className="text-xs font-semibold text-slate-900">
                    Linked Expense Allocations
                  </span>
                  {isFullLinked ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                      Fully Reconciled ({formatUsd(allocationSummary?.allocatedAmount ?? 0)})
                    </span>
                  ) : isPartialLinked ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      Partial · {formatUsd(allocationSummary?.allocatedAmount ?? 0)} /{' '}
                      {formatUsd(Math.abs(transaction.amount))} (
                      {formatUsd(allocationSummary?.remainingAmount ?? 0)} remaining)
                    </span>
                  ) : (
                    <span className="rounded bg-slate-200/80 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      Unlinked · {formatUsd(Math.abs(transaction.amount))} remaining
                    </span>
                  )}
                </div>

                {bankRemainingCents > RECON_PENNY_TOLERANCE_CENTS && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setShowAddPicker((v) => !v);
                      setLinkError(null);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-teal-700 bg-white px-2.5 py-1 text-[11px] font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    {showAddPicker ? 'Hide Picker' : 'Add Expense Link'}
                  </button>
                )}
              </div>

              {linkError && (
                <div
                  role="alert"
                  className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
                >
                  {linkError}
                </div>
              )}

              {hasManagedLinks && (
                <div className="divide-y divide-slate-200 overflow-hidden rounded border border-slate-200 bg-white">
                  {allocationSummary!.links.map((link) => {
                    const partner = expenseByIdMap.get(link.targetId.trim().toLowerCase());
                    return (
                      <div
                        key={link.linkId}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                            <span className="font-semibold text-teal-700">{link.targetId}</span>
                            {partner && (
                              <>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-600">{partner.date}</span>
                              </>
                            )}
                            {link.category && (
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-700">
                                {link.category}
                              </span>
                            )}
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-500">
                              {link.linkMode}
                            </span>
                          </div>
                          {partner && (
                            <div className="mt-0.5 truncate text-[11px] text-slate-600">
                              {partner.description}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                            {formatUsd(link.allocatedAmount)}
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleUnlinkClick(link)}
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                            title={`Unlink ${link.targetId}`}
                          >
                            <Unlink className="h-3 w-3" aria-hidden="true" />
                            Unlink
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {showAddPicker && (
                <div className="space-y-3 rounded border border-teal-200 bg-white p-3">
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={expSearch}
                      onChange={(e) => setExpSearch(e.target.value)}
                      placeholder="Search Expense_Ledger by Exp_ID, exact amount, description, category, date..."
                      className="w-full rounded border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  {isLoadingPartnerRecords ? (
                    <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin text-teal-700" />
                      Loading Expense_Ledger records...
                    </div>
                  ) : candidateExpenses.length === 0 ? (
                    <div className="py-3 text-center text-xs text-slate-500">
                      No open Expense_Ledger items match your search.
                    </div>
                  ) : (
                    <div className="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
                      {candidateExpenses.map((exp) => {
                        const isPicked = pickedExpense?.expId === exp.expId;
                        const expSummary = expenseAllocMap?.get(expenseRecordKey(exp));
                        const rem = expSummary
                          ? expSummary.remainingAmount
                          : Math.abs(exp.amount);
                        return (
                          <button
                            key={expenseRecordKey(exp)}
                            type="button"
                            onClick={() => handleSelectPartnerExpense(exp)}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                              isPicked ? 'bg-teal-50 text-teal-950' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                                <span className="font-semibold text-teal-700">{exp.expId}</span>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-600">{exp.date}</span>
                                <span className="text-slate-400">·</span>
                                <span className="font-sans text-slate-600">
                                  {exp.category || 'Uncategorized'}
                                </span>
                              </div>
                              <div className="truncate text-[11px] text-slate-700">
                                {exp.description}
                              </div>
                            </div>
                            <span className="shrink-0 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                              {formatUsd(rem)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {pickedExpense && (
                    <div className="grid grid-cols-1 gap-2 rounded border border-slate-200 bg-slate-50 p-2.5 sm:grid-cols-3">
                      <div>
                        <label
                          htmlFor="bank-add-link-amt"
                          className="block text-[11px] font-medium text-slate-700"
                        >
                          Allocated Amount ($)
                        </label>
                        <input
                          id="bank-add-link-amt"
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={allocAmountStr}
                          onChange={(e) => setAllocAmountStr(e.target.value)}
                          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none tabular-nums"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="bank-add-link-notes"
                          className="block text-[11px] font-medium text-slate-700"
                        >
                          Link Notes
                        </label>
                        <input
                          id="bank-add-link-notes"
                          type="text"
                          value={linkNotes}
                          onChange={(e) => setLinkNotes(e.target.value)}
                          placeholder="Optional..."
                          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                        />
                      </div>
                      <div className="flex items-end justify-end">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleConfirmAddLink()}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-50"
                        >
                          {isMutatingLink ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Linking...
                            </>
                          ) : (
                            `Link ${pickedExpense.expId}`
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Reconciliation & Category */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bank-edit-is-recon" className="block text-xs font-medium text-slate-700">
                Is_Recon
                {isFullLinked && (
                  <span className="ml-1.5 font-normal text-emerald-700">
                    (Locked to Yes while fully linked)
                  </span>
                )}
                {isPartialLinked && (
                  <span className="ml-1.5 font-normal text-amber-700">
                    (Locked to No while partially linked)
                  </span>
                )}
                {isLegacyUnmanagedLinked && (
                  <span className="ml-1.5 font-normal text-emerald-700">
                    (Locked to Yes while linked)
                  </span>
                )}
              </label>
              <select
                id="bank-edit-is-recon"
                value={lockedIsReconValue}
                onChange={(e) => setIsRecon(e.target.value === 'Yes' ? 'Yes' : 'No')}
                disabled={busy || isIsReconLocked}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-600"
              >
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>

            <div>
              <label htmlFor="bank-edit-category" className="block text-xs font-medium text-slate-700">
                Category
                {isMultipleCategory && (
                  <span className="ml-1.5 font-normal text-slate-500">
                    (Multiple categories across links)
                  </span>
                )}
              </label>
              {isMultipleCategory ? (
                <input
                  id="bank-edit-category"
                  type="text"
                  value={MULTIPLE_CATEGORY_LABEL}
                  disabled
                  className="mt-1 w-full rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600"
                />
              ) : (
                <select
                  id="bank-edit-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={busy}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:opacity-60"
                >
                  <option value="">None / Uncategorized</option>
                  {effectiveCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label htmlFor="bank-edit-target-id" className="block text-xs font-medium text-slate-700">
                Target ID (Linked Exp_ID)
                {hasManagedLinks && (
                  <span className="ml-1.5 font-normal text-slate-500">
                    (Synced from Linked Allocations)
                  </span>
                )}
              </label>
              <input
                id="bank-edit-target-id"
                type="text"
                value={targetId}
                onChange={(e) => handleTargetIdChange(e.target.value)}
                disabled={busy || hasManagedLinks}
                placeholder="Optional Expense Exp_ID (e.g. 1794090597)"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-600"
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
                disabled={busy}
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
                disabled={busy}
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
                disabled={busy}
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
                disabled={busy}
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
              disabled={busy}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
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
