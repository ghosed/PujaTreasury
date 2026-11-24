import React, { useEffect, useMemo, useState } from 'react';
import {
  Link2,
  Loader2,
  Lock,
  Plus,
  Receipt,
  Search,
  Unlink,
  X,
} from 'lucide-react';
import { ExpenseLookups, ExpenseRecord } from '../../types/expense';
import { AllocationSummary, ReconLink } from '../../types/reconciliation';
import { generateManualExpenseId, getSubCategoryOptions } from '../../utils/expenseProcessor';
import {
  bankEntryKey,
  fromCents,
  parseExactAmountQueryCents,
  RECON_PENNY_TOLERANCE_CENTS,
  reconPairKey,
  toCents,
} from '../../utils/reconAllocations';
import { BankLedgerEntry } from '../../utils/reconciler';

interface ExpenseEntryModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  initialRecord: ExpenseRecord | null;
  lookups: ExpenseLookups;
  existingIds: Set<string>;
  allocationSummary?: AllocationSummary;
  allBankEntries?: BankLedgerEntry[];
  bankAllocMap?: Map<string, AllocationSummary>;
  isLoadingPartnerRecords?: boolean;
  isMutatingLink?: boolean;
  onClose: () => void;
  onSubmit: (record: ExpenseRecord, original: ExpenseRecord | null) => void;
  onAddLink?: (
    expense: ExpenseRecord,
    bankEntry: BankLedgerEntry,
    allocatedAmount: number,
    notes: string
  ) => Promise<void>;
  onUnlink?: (expense: ExpenseRecord, link: ReconLink) => Promise<void>;
}

function formatUsd(val: number): string {
  return val.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export const ExpenseEntryModal: React.FC<ExpenseEntryModalProps> = ({
  isOpen,
  mode,
  initialRecord,
  lookups,
  existingIds,
  allocationSummary,
  allBankEntries = [],
  bankAllocMap,
  isLoadingPartnerRecords = false,
  isMutatingLink = false,
  onClose,
  onSubmit,
  onAddLink,
  onUnlink,
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

  // Add-link picker state
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [pickedBank, setPickedBank] = useState<BankLedgerEntry | null>(null);
  const [allocAmountStr, setAllocAmountStr] = useState('');
  const [linkNotes, setLinkNotes] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValidationError(null);
    setLinkError(null);
    setShowAddPicker(false);
    setPickedBank(null);
    setAllocAmountStr('');
    setLinkNotes('');
    setBankSearch('');

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
  }, [isOpen, mode, initialRecord?.expId]);

  // Keep Recon_Source_ID & Is_Recon synced when live link/unlink actions update allocationSummary
  useEffect(() => {
    if (!isOpen || mode !== 'edit' || !initialRecord) return;
    if (allocationSummary && allocationSummary.links.length > 0) {
      setReconSourceId(allocationSummary.partnerIds.join(', '));
      setIsRecon(allocationSummary.derivedIsRecon);
    } else {
      setReconSourceId(initialRecord.reconSourceId);
      setIsRecon(initialRecord.isRecon === 'Yes' ? 'Yes' : 'No');
    }
  }, [isOpen, mode, initialRecord, allocationSummary]);

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

  const bankByIdMap = useMemo(() => {
    const m = new Map<string, BankLedgerEntry>();
    for (const entry of allBankEntries) {
      const k = entry.tx.uniqueId.trim().toLowerCase();
      if (k && !m.has(k)) m.set(k, entry);
    }
    return m;
  }, [allBankEntries]);

  const expRemainingCents = useMemo(() => {
    if (!initialRecord) return 0;
    if (allocationSummary) return allocationSummary.remainingCents;
    return toCents(Math.abs(initialRecord.amount));
  }, [initialRecord, allocationSummary]);

  const candidateBanks = useMemo(() => {
    if (!initialRecord) return [];
    const existingPairs = new Set(
      (allocationSummary?.links ?? []).map((l) =>
        reconPairKey(l.bankUniqueId, l.targetType, l.targetId)
      )
    );
    const q = bankSearch.trim().toLowerCase();
    const queryAmountCents = parseExactAmountQueryCents(bankSearch);

    return allBankEntries
      .filter((entry) => {
        if (
          entry.tx.transactionType !== 'Expense' ||
          entry.tx.reviewStatus === 'discarded' ||
          typeof entry.tx.sheetRowNumber !== 'number' ||
          entry.tx.sheetRowNumber < 1
        ) {
          return false;
        }
        const pKey = reconPairKey(entry.tx.uniqueId, 'Expense', initialRecord.expId);
        if (existingPairs.has(pKey)) return false;

        const bSummary = bankAllocMap?.get(bankEntryKey(entry));
        const rem = bSummary ? bSummary.remainingCents : Math.abs(entry.tx.amountCents);
        if (rem <= RECON_PENNY_TOLERANCE_CENTS) return false;

        if (!q) return true;
        const fullCents = Math.abs(entry.tx.amountCents);
        const matchesExactAmount =
          queryAmountCents !== null &&
          (rem === queryAmountCents || fullCents === queryAmountCents);
        if (matchesExactAmount) return true;

        const hay =
          `${entry.tab} ${entry.tx.uniqueId} ${entry.tx.date} ${entry.tx.description} ${entry.tx.source} ${entry.tx.referenceNumber} ${entry.tx.notes ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const aSummary = bankAllocMap?.get(bankEntryKey(a));
        const aRem = aSummary ? aSummary.remainingCents : Math.abs(a.tx.amountCents);
        const bSummary = bankAllocMap?.get(bankEntryKey(b));
        const bRem = bSummary ? bSummary.remainingCents : Math.abs(b.tx.amountCents);

        if (queryAmountCents !== null) {
          const aQueryMatch =
            aRem === queryAmountCents || Math.abs(a.tx.amountCents) === queryAmountCents
              ? 1
              : 0;
          const bQueryMatch =
            bRem === queryAmountCents || Math.abs(b.tx.amountCents) === queryAmountCents
              ? 1
              : 0;
          if (bQueryMatch !== aQueryMatch) return bQueryMatch - aQueryMatch;
        }

        const aExact = Math.abs(aRem - expRemainingCents) <= 1 ? 1 : 0;
        const bExact = Math.abs(bRem - expRemainingCents) <= 1 ? 1 : 0;
        if (bExact !== aExact) return bExact - aExact;
        const aSameDate = a.tx.date === initialRecord.date ? 1 : 0;
        const bSameDate = b.tx.date === initialRecord.date ? 1 : 0;
        if (bSameDate !== aSameDate) return bSameDate - aSameDate;
        return b.tx.date.localeCompare(a.tx.date);
      })
      .slice(0, 60);
  }, [initialRecord, allocationSummary, allBankEntries, bankAllocMap, bankSearch, expRemainingCents]);

  if (!isOpen) return null;

  const hasManagedLinks = (allocationSummary?.links.length ?? 0) > 0;
  const isFullLinked = allocationSummary?.status === 'full';
  const isPartialLinked = allocationSummary?.status === 'partial';
  const isLegacyUnmanagedLinked = !hasManagedLinks && reconSourceId.trim() !== '';
  const isIsReconLocked = isFullLinked || isPartialLinked || isLegacyUnmanagedLinked;
  const lockedIsReconValue: 'Yes' | 'No' = isPartialLinked
    ? 'No'
    : isFullLinked || isLegacyUnmanagedLinked
      ? 'Yes'
      : isRecon;

  const canManageSheetLinks =
    mode === 'edit' &&
    initialRecord?.sourceOrigin === 'sheet' &&
    Boolean(initialRecord?.sheetRowNumber) &&
    Boolean(onAddLink) &&
    Boolean(onUnlink);

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

  const handleSelectPartnerBank = (entry: BankLedgerEntry) => {
    setLinkError(null);
    setPickedBank(entry);
    const bSummary = bankAllocMap?.get(bankEntryKey(entry));
    const bankRemCents = bSummary
      ? bSummary.remainingCents
      : Math.abs(entry.tx.amountCents);
    const suggestedCents = Math.min(expRemainingCents, bankRemCents);
    setAllocAmountStr(fromCents(suggestedCents).toFixed(2));
  };

  const handleConfirmAddLink = async () => {
    if (!initialRecord || !pickedBank || !onAddLink) return;
    const parsed = Number(allocAmountStr);
    const allocCents = toCents(parsed);
    if (!Number.isFinite(parsed) || allocCents <= 0) {
      setLinkError('Enter a positive Allocated Amount.');
      return;
    }
    if (allocCents > expRemainingCents + RECON_PENNY_TOLERANCE_CENTS) {
      setLinkError(
        `Amount exceeds Expense remaining balance (${formatUsd(fromCents(expRemainingCents))}).`
      );
      return;
    }
    const bSummary = bankAllocMap?.get(bankEntryKey(pickedBank));
    const bankRemCents = bSummary
      ? bSummary.remainingCents
      : Math.abs(pickedBank.tx.amountCents);
    if (allocCents > bankRemCents + RECON_PENNY_TOLERANCE_CENTS) {
      setLinkError(
        `Amount exceeds Bank remaining balance (${formatUsd(fromCents(bankRemCents))}).`
      );
      return;
    }

    setLinkError(null);
    try {
      await onAddLink(initialRecord, pickedBank, fromCents(allocCents), linkNotes.trim());
      setShowAddPicker(false);
      setPickedBank(null);
      setAllocAmountStr('');
      setLinkNotes('');
      setBankSearch('');
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to add Bank link.');
    }
  };

  const handleUnlinkClick = async (link: ReconLink) => {
    if (!initialRecord || !onUnlink) return;
    setLinkError(null);
    try {
      await onUnlink(initialRecord, link);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to unlink item.');
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
      isRecon: isIsReconLocked ? lockedIsReconValue : isRecon,
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
                  ? 'Manage linked Bank payments and expense details for Expense_Ledger.'
                  : 'Enter expense details below. Sub Category options update dynamically by Category.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isMutatingLink}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
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

          {/* Linked Bank Allocations Panel (for sheet-saved Expense records) */}
          {canManageSheetLinks && initialRecord && (
            <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link2 className="h-4 w-4 text-teal-700" aria-hidden="true" />
                  <span className="text-xs font-semibold text-slate-900">
                    Linked Bank Payments
                  </span>
                  {isFullLinked ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                      Fully Reconciled ({formatUsd(allocationSummary?.allocatedAmount ?? 0)})
                    </span>
                  ) : isPartialLinked ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      Partial · {formatUsd(allocationSummary?.allocatedAmount ?? 0)} /{' '}
                      {formatUsd(initialRecord.amount)} (
                      {formatUsd(allocationSummary?.remainingAmount ?? 0)} remaining)
                    </span>
                  ) : (
                    <span className="rounded bg-slate-200/80 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      Unlinked · {formatUsd(initialRecord.amount)} remaining
                    </span>
                  )}
                </div>

                {expRemainingCents > RECON_PENNY_TOLERANCE_CENTS && (
                  <button
                    type="button"
                    disabled={isMutatingLink}
                    onClick={() => {
                      setShowAddPicker((v) => !v);
                      setLinkError(null);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-teal-700 bg-white px-2.5 py-1 text-[11px] font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    {showAddPicker ? 'Hide Picker' : 'Add Bank Link'}
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
                    const partner = bankByIdMap.get(link.bankUniqueId.trim().toLowerCase());
                    return (
                      <div
                        key={link.linkId}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-slate-700">
                              {link.bankTab}
                            </span>
                            <span className="font-semibold text-teal-700">
                              {link.bankUniqueId}
                            </span>
                            {partner && (
                              <>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-600">{partner.tx.date}</span>
                                <span className="text-slate-400">·</span>
                                <span className="font-sans text-slate-600">
                                  {partner.tx.source}
                                </span>
                              </>
                            )}
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-500">
                              {link.linkMode}
                            </span>
                          </div>
                          {partner && (
                            <div className="mt-0.5 truncate text-[11px] text-slate-600">
                              {partner.tx.description}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                            {formatUsd(link.allocatedAmount)}
                          </span>
                          <button
                            type="button"
                            disabled={isMutatingLink}
                            onClick={() => void handleUnlinkClick(link)}
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                            title={`Unlink ${link.bankUniqueId}`}
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
                      value={bankSearch}
                      onChange={(e) => setBankSearch(e.target.value)}
                      placeholder="Search Bank Ledger (Puja & Regular) by ID, exact amount, description, check#, source..."
                      className="w-full rounded border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  {isLoadingPartnerRecords ? (
                    <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin text-teal-700" />
                      Loading Bank Ledger (Puja &amp; Regular)...
                    </div>
                  ) : candidateBanks.length === 0 ? (
                    <div className="py-3 text-center text-xs text-slate-500">
                      No open Bank Expense transactions match your search.
                    </div>
                  ) : (
                    <div className="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
                      {candidateBanks.map((entry) => {
                        const isPicked = pickedBank?.tx.uniqueId === entry.tx.uniqueId;
                        const bSummary = bankAllocMap?.get(bankEntryKey(entry));
                        const rem = bSummary
                          ? bSummary.remainingAmount
                          : Math.abs(entry.tx.amount);
                        return (
                          <button
                            key={bankEntryKey(entry)}
                            type="button"
                            onClick={() => handleSelectPartnerBank(entry)}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                              isPicked ? 'bg-teal-50 text-teal-950' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-slate-700">
                                  {entry.tab}
                                </span>
                                <span className="font-semibold text-teal-700">
                                  {entry.tx.uniqueId}
                                </span>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-600">{entry.tx.date}</span>
                                <span className="text-slate-400">·</span>
                                <span className="font-sans text-slate-600">
                                  {entry.tx.source}
                                </span>
                              </div>
                              <div className="truncate text-[11px] text-slate-700">
                                {entry.tx.description}
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

                  {pickedBank && (
                    <div className="grid grid-cols-1 gap-2 rounded border border-slate-200 bg-slate-50 p-2.5 sm:grid-cols-3">
                      <div>
                        <label
                          htmlFor="exp-add-link-amt"
                          className="block text-[11px] font-medium text-slate-700"
                        >
                          Allocated Amount ($)
                        </label>
                        <input
                          id="exp-add-link-amt"
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
                          htmlFor="exp-add-link-notes"
                          className="block text-[11px] font-medium text-slate-700"
                        >
                          Link Notes
                        </label>
                        <input
                          id="exp-add-link-notes"
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
                          disabled={isMutatingLink}
                          onClick={() => void handleConfirmAddLink()}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-50"
                        >
                          {isMutatingLink ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Linking...
                            </>
                          ) : (
                            'Link Bank Row'
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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
                  {hasManagedLinks && (
                    <span className="ml-1.5 font-normal text-slate-500">
                      (Synced from Linked Payments)
                    </span>
                  )}
                </label>
                <input
                  id="exp-recon-id"
                  type="text"
                  value={reconSourceId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setReconSourceId(next);
                    if (next.trim() !== '' && !hasManagedLinks) {
                      setIsRecon('Yes');
                    }
                  }}
                  disabled={hasManagedLinks}
                  placeholder="Optional reconciliation reference or transaction ID"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-600"
                />
              </div>

              <div>
                <label htmlFor="exp-is-recon" className="block text-xs font-medium text-slate-700">
                  Is_Recon
                  {isFullLinked && (
                    <span className="ml-1.5 font-normal text-emerald-700">
                      (Locked to Yes while fully linked)
                    </span>
                  )}
                  {isPartialLinked && (
                    <span className="ml-1.5 font-normal text-amber-700">
                      (No while partially linked)
                    </span>
                  )}
                  {isLegacyUnmanagedLinked && (
                    <span className="ml-1.5 font-normal text-emerald-700">
                      (Yes while linked)
                    </span>
                  )}
                </label>
                <select
                  id="exp-is-recon"
                  value={lockedIsReconValue}
                  onChange={(e) =>
                    setIsRecon(e.target.value === 'Yes' ? 'Yes' : 'No')
                  }
                  disabled={isIsReconLocked}
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
              disabled={isMutatingLink}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isMutatingLink}
              className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap"
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
