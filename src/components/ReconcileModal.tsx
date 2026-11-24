import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { AccountType } from '../types/statement';
import { getAccessToken, clearCachedToken } from '../services/firebaseAuth';
import {
  BankReconcileRowUpdate,
  BankSheetColumnLayout,
  batchUpdateBankReconciliation,
  fetchSheetLedger,
  LoadedSheetLedger,
  SheetsApiError,
  TARGET_SPREADSHEET_ID,
} from '../services/googleSheets';
import {
  batchUpdateExpenseReconIds,
  EXPENSE_SPREADSHEET_ID,
  ExpenseReconUpdate,
  fetchExpenseWorkspace,
  LoadedExpenseWorkspace,
} from '../services/expenseSheets';
import { NewReconLinkInput, ReconLink } from '../types/reconciliation';
import { appendReconLinks, fetchReconLinks } from '../services/reconLinksSheets';
import { executeAddReconLinks } from '../services/reconCommits';
import {
  bankEntryKey,
  buildEffectiveReconLinks,
  computeBankAllocationMap,
  computeExpenseAllocationMap,
  expenseRecordKey,
  fromCents,
  parseExactAmountQueryCents,
  RECON_PENNY_TOLERANCE_CENTS,
  reconPairKey,
  toCents,
  validateNewReconLinks,
} from '../utils/reconAllocations';
import { buildFifoAllocationProposals } from '../utils/reconMutations';
import {
  BankLedgerEntry,
  findExpenseMatches,
  ReconciliationMatch,
} from '../utils/reconciler';

type ScopeOption = 'both' | 'Puja' | 'Regular';
type ModalTab = 'auto' | 'workbench';

interface EditableProposal {
  pairKey: string;
  bankEntry: BankLedgerEntry;
  expense: LoadedExpenseWorkspace['records'][number];
  amountStr: string;
  notes: string;
}

export interface ReconcileCompleteSummary {
  bankUpdatedCount: number;
  expenseUpdatedCount: number;
  linksAppendedCount?: number;
  updatedTabs: AccountType[];
}

interface ReconcileModalProps {
  isOpen: boolean;
  activeBankTab: AccountType;
  onClose: () => void;
  onAuthExpired: () => void;
  onReconciled: (summary: ReconcileCompleteSummary) => Promise<void> | void;
}

function formatUsd(val: number): string {
  return val.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export const ReconcileModal: React.FC<ReconcileModalProps> = ({
  isOpen,
  activeBankTab,
  onClose,
  onAuthExpired,
  onReconciled,
}) => {
  const [activeTab, setActiveTab] = useState<ModalTab>('auto');
  const [scope, setScope] = useState<ScopeOption>('both');
  const [dateToleranceDays, setDateToleranceDays] = useState<number | null>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [bankLedgers, setBankLedgers] = useState<Record<AccountType, LoadedSheetLedger> | null>(
    null
  );
  const [expenseWorkspace, setExpenseWorkspace] = useState<LoadedExpenseWorkspace | null>(null);
  const [reconLinks, setReconLinks] = useState<ReconLink[]>([]);
  const [deselectedKeys, setDeselectedKeys] = useState<Set<string>>(new Set());

  // Multi-Link Workbench state
  const [bankSearch, setBankSearch] = useState('');
  const [expenseSearch, setExpenseSearch] = useState('');
  const [selectedBankKeys, setSelectedBankKeys] = useState<Set<string>>(new Set());
  const [selectedExpKeys, setSelectedExpKeys] = useState<Set<string>>(new Set());
  const [proposals, setProposals] = useState<EditableProposal[]>([]);

  const resetWorkbenchSelections = useCallback(() => {
    setSelectedBankKeys(new Set());
    setSelectedExpKeys(new Set());
    setProposals([]);
    setBankSearch('');
    setExpenseSearch('');
  }, []);

  const loadComparisonData = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMsg('Sign in with Google to compare Bank Ledger and Expense Ledger sheets.');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    setDeselectedKeys(new Set());
    setSelectedBankKeys(new Set());
    setSelectedExpKeys(new Set());
    setProposals([]);

    try {
      const [pujaLedger, regularLedger, expWs, loadedLinks] = await Promise.all([
        fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Puja'),
        fetchSheetLedger(token, TARGET_SPREADSHEET_ID, 'Regular'),
        fetchExpenseWorkspace(token, EXPENSE_SPREADSHEET_ID),
        fetchReconLinks(token, TARGET_SPREADSHEET_ID).catch(() => null),
      ]);
      setBankLedgers({ Puja: pujaLedger, Regular: regularLedger });
      setExpenseWorkspace(expWs);
      setReconLinks(loadedLinks?.links ?? []);
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMsg('Google session expired or lacks permission. Please sign in again.');
      } else {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Unable to load Bank Ledger and Expense Ledger sheets.'
        );
      }
    } finally {
      setIsLoading(false);
    }
  }, [onAuthExpired]);

  useEffect(() => {
    if (isOpen) {
      void loadComparisonData();
    } else {
      setErrorMsg(null);
      setDeselectedKeys(new Set());
      resetWorkbenchSelections();
      setActiveTab('auto');
    }
  }, [isOpen, loadComparisonData, resetWorkbenchSelections]);

  const allBankEntries = useMemo<BankLedgerEntry[]>(() => {
    if (!bankLedgers) return [];
    const out: BankLedgerEntry[] = [];
    for (const tx of bankLedgers.Puja.transactions) {
      out.push({ tab: 'Puja', tx });
    }
    for (const tx of bankLedgers.Regular.transactions) {
      out.push({ tab: 'Regular', tx });
    }
    return out;
  }, [bankLedgers]);

  const scopedBankEntries = useMemo<BankLedgerEntry[]>(() => {
    if (!bankLedgers) return [];
    const entries: BankLedgerEntry[] = [];
    if (scope === 'both' || scope === 'Puja') {
      for (const tx of bankLedgers.Puja.transactions) {
        entries.push({ tab: 'Puja', tx });
      }
    }
    if (scope === 'both' || scope === 'Regular') {
      for (const tx of bankLedgers.Regular.transactions) {
        entries.push({ tab: 'Regular', tx });
      }
    }
    return entries;
  }, [bankLedgers, scope]);

  const analysis = useMemo(() => {
    if (!bankLedgers || !expenseWorkspace) return null;
    return findExpenseMatches(
      scopedBankEntries,
      expenseWorkspace.records,
      dateToleranceDays,
      reconLinks
    );
  }, [bankLedgers, expenseWorkspace, scopedBankEntries, dateToleranceDays, reconLinks]);

  const effectiveLinks = useMemo(() => {
    if (!expenseWorkspace) return reconLinks;
    return buildEffectiveReconLinks(
      reconLinks,
      allBankEntries,
      expenseWorkspace.records
    );
  }, [reconLinks, allBankEntries, expenseWorkspace]);

  const bankAllocMap = useMemo(
    () => computeBankAllocationMap(allBankEntries, effectiveLinks),
    [allBankEntries, effectiveLinks]
  );

  const expAllocMap = useMemo(
    () => computeExpenseAllocationMap(expenseWorkspace?.records ?? [], effectiveLinks),
    [expenseWorkspace, effectiveLinks]
  );

  const selectedMatches = useMemo<ReconciliationMatch[]>(() => {
    if (!analysis) return [];
    return analysis.matches.filter((m) => !deselectedKeys.has(m.matchKey));
  }, [analysis, deselectedKeys]);

  const tabsMissingHeaders = useMemo<Array<{ tab: AccountType; columns: string[] }>>(() => {
    if (!bankLedgers) return [];
    const tabsToCheck: AccountType[] =
      scope === 'both' ? ['Puja', 'Regular'] : [scope];
    const missing: Array<{ tab: AccountType; columns: string[] }> = [];
    for (const tab of tabsToCheck) {
      const ledger = bankLedgers[tab];
      if (!ledger.tabExists) continue;
      const cols: string[] = [];
      if (!ledger.hasTargetIdHeader) cols.push('Target ID');
      if (!ledger.hasIsReconHeader) cols.push('Is_Recon');
      if (!ledger.hasCategoryHeader) cols.push('Category');
      if (cols.length > 0) {
        missing.push({ tab, columns: cols });
      }
    }
    return missing;
  }, [bankLedgers, scope]);

  const expenseMissingIsReconHeader = Boolean(
    expenseWorkspace &&
      expenseWorkspace.meta.ledgerTabExists &&
      !expenseWorkspace.meta.needsHeader &&
      !expenseWorkspace.meta.hasIsReconHeader
  );

  // Eligible items for Multi-Link Workbench
  const workbenchBanks = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    const queryAmountCents = parseExactAmountQueryCents(bankSearch);
    return scopedBankEntries
      .filter((entry) => {
        if (
          entry.tx.transactionType !== 'Expense' ||
          entry.tx.reviewStatus === 'discarded' ||
          typeof entry.tx.sheetRowNumber !== 'number' ||
          entry.tx.sheetRowNumber < 1
        ) {
          return false;
        }
        const summary = bankAllocMap.get(bankEntryKey(entry));
        const rem = summary ? summary.remainingCents : Math.abs(entry.tx.amountCents);
        if (rem <= RECON_PENNY_TOLERANCE_CENTS) return false;
        if (!q) return true;
        const fullCents = Math.abs(entry.tx.amountCents);
        if (
          queryAmountCents !== null &&
          (rem === queryAmountCents || fullCents === queryAmountCents)
        ) {
          return true;
        }
        const hay =
          `${entry.tab} ${entry.tx.uniqueId} ${entry.tx.date} ${entry.tx.description} ${entry.tx.source} ${entry.tx.referenceNumber} ${entry.tx.notes ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        if (queryAmountCents !== null) {
          const aRem =
            bankAllocMap.get(bankEntryKey(a))?.remainingCents ??
            Math.abs(a.tx.amountCents);
          const bRem =
            bankAllocMap.get(bankEntryKey(b))?.remainingCents ??
            Math.abs(b.tx.amountCents);
          const aMatch =
            aRem === queryAmountCents || Math.abs(a.tx.amountCents) === queryAmountCents
              ? 1
              : 0;
          const bMatch =
            bRem === queryAmountCents || Math.abs(b.tx.amountCents) === queryAmountCents
              ? 1
              : 0;
          if (bMatch !== aMatch) return bMatch - aMatch;
        }
        return b.tx.date.localeCompare(a.tx.date);
      });
  }, [scopedBankEntries, bankAllocMap, bankSearch]);

  const workbenchExpenses = useMemo(() => {
    if (!expenseWorkspace) return [];
    const q = expenseSearch.trim().toLowerCase();
    const queryAmountCents = parseExactAmountQueryCents(expenseSearch);
    return expenseWorkspace.records
      .filter((exp) => {
        if (typeof exp.sheetRowNumber !== 'number' || exp.sheetRowNumber < 1) {
          return false;
        }
        const summary = expAllocMap.get(expenseRecordKey(exp));
        const rem = summary ? summary.remainingCents : toCents(Math.abs(exp.amount));
        if (rem <= RECON_PENNY_TOLERANCE_CENTS) return false;
        if (!q) return true;
        const fullCents = toCents(Math.abs(exp.amount));
        if (
          queryAmountCents !== null &&
          (rem === queryAmountCents || fullCents === queryAmountCents)
        ) {
          return true;
        }
        const hay =
          `${exp.expId} ${exp.date} ${exp.category} ${exp.subCategory} ${exp.description} ${exp.puja} ${exp.paymentMode}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        if (queryAmountCents !== null) {
          const aRem =
            expAllocMap.get(expenseRecordKey(a))?.remainingCents ??
            toCents(Math.abs(a.amount));
          const bRem =
            expAllocMap.get(expenseRecordKey(b))?.remainingCents ??
            toCents(Math.abs(b.amount));
          const aMatch =
            aRem === queryAmountCents || toCents(Math.abs(a.amount)) === queryAmountCents
              ? 1
              : 0;
          const bMatch =
            bRem === queryAmountCents || toCents(Math.abs(b.amount)) === queryAmountCents
              ? 1
              : 0;
          if (bMatch !== aMatch) return bMatch - aMatch;
        }
        return b.date.localeCompare(a.date);
      });
  }, [expenseWorkspace, expAllocMap, expenseSearch]);

  const regenerateFifoProposals = useCallback(
    (nextBankKeys: Set<string>, nextExpKeys: Set<string>) => {
      if (!expenseWorkspace) return;
      const pickedBanks = scopedBankEntries.filter((e) =>
        nextBankKeys.has(bankEntryKey(e))
      );
      const pickedExps = expenseWorkspace.records.filter((e) =>
        nextExpKeys.has(expenseRecordKey(e))
      );
      const fifo = buildFifoAllocationProposals(
        pickedBanks,
        pickedExps,
        bankAllocMap,
        expAllocMap,
        effectiveLinks
      );
      setProposals(
        fifo.map((item) => ({
          pairKey: item.pairKey,
          bankEntry: item.bankEntry,
          expense: item.expense,
          amountStr: item.allocatedAmount.toFixed(2),
          notes: item.notes,
        }))
      );
    },
    [expenseWorkspace, scopedBankEntries, bankAllocMap, expAllocMap, effectiveLinks]
  );

  const toggleWorkbenchBank = (entry: BankLedgerEntry) => {
    const key = bankEntryKey(entry);
    const next = new Set(selectedBankKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedBankKeys(next);
    regenerateFifoProposals(next, selectedExpKeys);
  };

  const toggleWorkbenchExpense = (exp: LoadedExpenseWorkspace['records'][number]) => {
    const key = expenseRecordKey(exp);
    const next = new Set(selectedExpKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedExpKeys(next);
    regenerateFifoProposals(selectedBankKeys, next);
  };

  const workbenchTotals = useMemo(() => {
    let bankRemCents = 0;
    for (const entry of scopedBankEntries) {
      if (!selectedBankKeys.has(bankEntryKey(entry))) continue;
      const summary = bankAllocMap.get(bankEntryKey(entry));
      bankRemCents += summary ? summary.remainingCents : Math.abs(entry.tx.amountCents);
    }

    let expRemCents = 0;
    for (const exp of expenseWorkspace?.records ?? []) {
      if (!selectedExpKeys.has(expenseRecordKey(exp))) continue;
      const summary = expAllocMap.get(expenseRecordKey(exp));
      expRemCents += summary ? summary.remainingCents : toCents(Math.abs(exp.amount));
    }

    let proposedCents = 0;
    for (const p of proposals) {
      const parsed = Number(p.amountStr);
      if (Number.isFinite(parsed) && parsed > 0) {
        proposedCents += toCents(parsed);
      }
    }

    const diffCents = Math.abs(bankRemCents - expRemCents);
    const isBalanced =
      selectedBankKeys.size > 0 &&
      selectedExpKeys.size > 0 &&
      diffCents <= RECON_PENNY_TOLERANCE_CENTS;

    return {
      bankRemAmount: fromCents(bankRemCents),
      expRemAmount: fromCents(expRemCents),
      proposedAmount: fromCents(proposedCents),
      diffAmount: fromCents(diffCents),
      isBalanced,
    };
  }, [
    scopedBankEntries,
    selectedBankKeys,
    bankAllocMap,
    expenseWorkspace,
    selectedExpKeys,
    expAllocMap,
    proposals,
  ]);

  const workbenchCandidateInputs = useMemo<NewReconLinkInput[]>(() => {
    return proposals.map((p) => ({
      bankTab: p.bankEntry.tab,
      bankUniqueId: p.bankEntry.tx.uniqueId,
      targetType: 'Expense',
      targetId: p.expense.expId,
      allocatedAmount: Number(p.amountStr) || 0,
      category: p.expense.category.trim(),
      linkMode: 'Manual',
      notes: p.notes.trim(),
    }));
  }, [proposals]);

  const workbenchValidation = useMemo(() => {
    if (!expenseWorkspace || workbenchCandidateInputs.length === 0) {
      return { valid: true, errors: [] as string[], normalizedLinks: [] };
    }
    return validateNewReconLinks(
      effectiveLinks,
      workbenchCandidateInputs,
      allBankEntries,
      expenseWorkspace.records
    );
  }, [expenseWorkspace, workbenchCandidateInputs, effectiveLinks, allBankEntries]);

  const toggleMatch = (matchKey: string) => {
    setDeselectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(matchKey)) {
        next.delete(matchKey);
      } else {
        next.add(matchKey);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (!analysis) return;
    if (selectedMatches.length === analysis.matches.length) {
      setDeselectedKeys(new Set(analysis.matches.map((m) => m.matchKey)));
    } else {
      setDeselectedKeys(new Set());
    }
  };

  const handleApplyAutoMatches = async () => {
    if (!bankLedgers || !expenseWorkspace) return;
    const hasHeaderInitialization =
      tabsMissingHeaders.length > 0 || expenseMissingIsReconHeader;
    if (selectedMatches.length === 0 && !hasHeaderInitialization) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMsg('Google session expired. Please sign in with Google again.');
      return;
    }

    setIsApplying(true);
    setErrorMsg(null);

    try {
      const explicitPairKeys = new Set(
        reconLinks.map((l) => reconPairKey(l.bankUniqueId, l.targetType, l.targetId))
      );
      const virtualLinksByBank = new Map<string, ReconLink[]>();
      const virtualLinksByExp = new Map<string, ReconLink[]>();

      for (const eff of effectiveLinks) {
        if (eff.sheetRowNumber !== null) continue;
        const bKey = eff.bankUniqueId.trim().toLowerCase();
        const eKey = eff.targetId.trim().toLowerCase();
        virtualLinksByBank.set(bKey, [...(virtualLinksByBank.get(bKey) ?? []), eff]);
        if (eff.targetType === 'Expense') {
          virtualLinksByExp.set(eKey, [...(virtualLinksByExp.get(eKey) ?? []), eff]);
        }
      }

      const linksToAppend: NewReconLinkInput[] = [];
      const queuedPairKeys = new Set<string>();
      const queueLink = (item: NewReconLinkInput) => {
        const pk = reconPairKey(item.bankUniqueId, item.targetType, item.targetId);
        if (explicitPairKeys.has(pk) || queuedPairKeys.has(pk)) return;
        queuedPairKeys.add(pk);
        linksToAppend.push(item);
      };

      const bankUpdatesByTab: Record<AccountType, BankReconcileRowUpdate[]> = {
        Puja: [],
        Regular: [],
      };
      const expenseUpdates: ExpenseReconUpdate[] = [];

      for (const match of selectedMatches) {
        const matchAmount =
          match.matchedAmount && match.matchedAmount > 0
            ? match.matchedAmount
            : Math.min(
                Math.abs(match.bankTx.amount),
                Math.abs(match.expense.amount)
              );

        queueLink({
          bankTab: match.bankTab,
          bankUniqueId: match.bankTx.uniqueId,
          targetType: 'Expense',
          targetId: match.expense.expId,
          allocatedAmount: matchAmount,
          category: match.expense.category.trim(),
          linkMode: 'Auto',
        });

        // Materialize any touched legacy virtual links so partial/1:N additions remain complete
        for (const v of virtualLinksByBank.get(match.bankTx.uniqueId.trim().toLowerCase()) ?? []) {
          queueLink({
            linkId: v.linkId,
            bankTab: v.bankTab,
            bankUniqueId: v.bankUniqueId,
            targetType: v.targetType,
            targetId: v.targetId,
            allocatedAmount: v.allocatedAmount,
            category: v.category,
            linkMode: v.linkMode,
          });
        }
        for (const v of virtualLinksByExp.get(match.expense.expId.trim().toLowerCase()) ?? []) {
          queueLink({
            linkId: v.linkId,
            bankTab: v.bankTab,
            bankUniqueId: v.bankUniqueId,
            targetType: v.targetType,
            targetId: v.targetId,
            allocatedAmount: v.allocatedAmount,
            category: v.category,
            linkMode: v.linkMode,
          });
        }

        if (match.needsBankUpdate && match.bankTx.sheetRowNumber) {
          const upd: BankReconcileRowUpdate = {
            sheetRowNumber: match.bankTx.sheetRowNumber,
          };
          if (match.needsBankTargetIdUpdate) {
            upd.targetId = match.resultingBankTargetId ?? match.expense.expId;
          }
          if (match.needsBankIsReconUpdate) {
            upd.isRecon = match.resultingBankIsRecon ?? 'Yes';
          }
          if (match.needsBankCategoryUpdate) {
            upd.category = match.resultingBankCategory ?? match.expense.category.trim();
          }
          bankUpdatesByTab[match.bankTab].push(upd);
        }
        if (match.needsExpenseUpdate && match.expense.sheetRowNumber) {
          const expUpd: ExpenseReconUpdate = {
            sheetRowNumber: match.expense.sheetRowNumber,
          };
          if (match.needsExpenseReconIdUpdate) {
            expUpd.reconSourceId = match.resultingExpenseReconId ?? match.bankTx.uniqueId;
          }
          if (match.needsExpenseIsReconUpdate) {
            expUpd.isRecon = match.resultingExpenseIsRecon ?? 'Yes';
          }
          expenseUpdates.push(expUpd);
        }
      }

      let linksAppendedCount = 0;
      if (linksToAppend.length > 0) {
        const res = await appendReconLinks(token, linksToAppend, TARGET_SPREADSHEET_ID);
        linksAppendedCount = res.appendedCount;
      }

      let bankUpdatedCount = 0;
      const updatedTabs: AccountType[] = [];

      for (const tab of ['Puja', 'Regular'] as AccountType[]) {
        const updates = bankUpdatesByTab[tab];
        const ledger = bankLedgers[tab];
        const needsHeaderInit =
          (scope === 'both' || scope === tab) &&
          ledger.tabExists &&
          (!ledger.hasTargetIdHeader || !ledger.hasIsReconHeader || !ledger.hasCategoryHeader);

        if (updates.length > 0 || needsHeaderInit) {
          const layout: BankSheetColumnLayout = {
            hasTargetIdHeader: ledger.hasTargetIdHeader,
            targetIdColIndex: ledger.targetIdColIndex,
            hasIsReconHeader: ledger.hasIsReconHeader,
            isReconColIndex: ledger.isReconColIndex,
            hasCategoryHeader: ledger.hasCategoryHeader,
            categoryColIndex: ledger.categoryColIndex,
            hasNotesHeader: ledger.hasNotesHeader,
            notesColIndex: ledger.notesColIndex,
          };
          const count = await batchUpdateBankReconciliation(
            token,
            TARGET_SPREADSHEET_ID,
            tab,
            layout,
            updates
          );
          bankUpdatedCount += count;
          updatedTabs.push(tab);
        }
      }

      let expenseUpdatedCount = 0;
      if (expenseUpdates.length > 0 || expenseMissingIsReconHeader) {
        expenseUpdatedCount = await batchUpdateExpenseReconIds(
          token,
          expenseWorkspace.meta,
          expenseUpdates
        );
      }

      await onReconciled({
        bankUpdatedCount,
        expenseUpdatedCount,
        linksAppendedCount,
        updatedTabs,
      });
      onClose();
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMsg('Google session expired while saving updates. Please sign in again.');
      } else {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Failed to update reconciliation fields in Google Sheets.'
        );
      }
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplyWorkbenchLinks = async () => {
    if (workbenchCandidateInputs.length === 0 || !workbenchValidation.valid) return;

    const token = await getAccessToken();
    if (!token) {
      onAuthExpired();
      setErrorMsg('Google session expired. Please sign in with Google again.');
      return;
    }

    setIsApplying(true);
    setErrorMsg(null);
    try {
      const result = await executeAddReconLinks(token, workbenchCandidateInputs);
      await onReconciled({
        bankUpdatedCount: result.bankUpdatedCount,
        expenseUpdatedCount: result.expenseUpdatedCount,
        linksAppendedCount: result.appendedLinksCount,
        updatedTabs: result.updatedTabs,
      });
      onClose();
    } catch (err) {
      if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
        clearCachedToken();
        onAuthExpired();
        setErrorMsg('Google session expired while saving links. Please sign in again.');
      } else {
        setErrorMsg(
          err instanceof Error ? err.message : 'Failed to apply Multi-Link reconciliation.'
        );
      }
    } finally {
      setIsApplying(false);
    }
  };

  if (!isOpen) return null;

  const canConfirmAuto =
    !isLoading &&
    !isApplying &&
    Boolean(analysis) &&
    (selectedMatches.length > 0 ||
      tabsMissingHeaders.length > 0 ||
      expenseMissingIsReconHeader);

  const canConfirmWorkbench =
    !isLoading &&
    !isApplying &&
    workbenchCandidateInputs.length > 0 &&
    workbenchValidation.valid;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reconcile-modal-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ArrowLeftRight className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2 id="reconcile-modal-title" className="text-base font-semibold text-slate-900">
                Reconcile Bank Ledger &amp; Expense Ledger
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Record 1:1, 1:N, N:1, or M:N allocations in <strong>Recon_Links</strong> and sync{' '}
                <strong>Target ID</strong>, <strong>Recon Source_ID</strong>,{' '}
                <strong>Is_Recon</strong>, and <strong>Category</strong>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isApplying}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close reconciliation modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher Tabs */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-6">
          <div className="flex items-center gap-1" role="tablist" aria-label="Reconciliation mode">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'auto'}
              onClick={() => setActiveTab('auto')}
              disabled={isApplying}
              className={`border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'auto'
                  ? 'border-teal-700 text-teal-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Auto-Match (1:1)
              {analysis && analysis.matches.length > 0 && (
                <span className="ml-1.5 rounded bg-teal-100 px-1.5 py-0.5 font-mono text-[10px] text-teal-800 tabular-nums">
                  {analysis.matches.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'workbench'}
              onClick={() => setActiveTab('workbench')}
              disabled={isApplying}
              className={`inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'workbench'
                  ? 'border-teal-700 text-teal-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Multi-Link Workbench (1:N / N:1 / M:N)
            </button>
          </div>

          <button
            type="button"
            onClick={() => void loadComparisonData()}
            disabled={isLoading || isApplying}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Re-scan Sheets
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {/* Shared Controls Row */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">Bank Tab Scope:</span>
                <div className="inline-flex rounded-md bg-slate-200/70 p-0.5">
                  {(
                    [
                      { id: 'both', label: 'Both (Puja & Regular)' },
                      { id: 'Puja', label: `Puja${activeBankTab === 'Puja' ? ' (Active)' : ''}` },
                      {
                        id: 'Regular',
                        label: `Regular${activeBankTab === 'Regular' ? ' (Active)' : ''}`,
                      },
                    ] as Array<{ id: ScopeOption; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setScope(opt.id);
                        setDeselectedKeys(new Set());
                        setSelectedBankKeys(new Set());
                        setProposals([]);
                      }}
                      disabled={isLoading || isApplying}
                      className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                        scope === opt.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {activeTab === 'auto' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-700">Date Tolerance:</span>
                  <div className="inline-flex rounded-md bg-slate-200/70 p-0.5">
                    {(
                      [
                        { days: 0, label: 'Exact Date' },
                        { days: 3, label: '±3 Days' },
                        { days: 7, label: '±7 Days' },
                        { days: null, label: 'None' },
                      ] as Array<{ days: number | null; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => {
                          setDateToleranceDays(opt.days);
                          setDeselectedKeys(new Set());
                        }}
                        disabled={isLoading || isApplying}
                        className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                          dateToleranceDays === opt.days
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {activeTab === 'workbench' && (
              <span className="text-[11px] text-slate-500">
                Select Bank items on the left and Expense items on the right to link 1:N, N:1, or M:N.
              </span>
            )}
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          {activeTab === 'auto' &&
            (tabsMissingHeaders.length > 0 || expenseMissingIsReconHeader) &&
            !isLoading && (
              <div className="space-y-1 rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
                {tabsMissingHeaders.map((item) => (
                  <div key={item.tab}>
                    Bank Ledger tab <strong>{item.tab}</strong> will initialize missing header{' '}
                    {item.columns.length === 1 ? 'column' : 'columns'}:{' '}
                    <strong>{item.columns.join(', ')}</strong>.
                  </div>
                ))}
                {expenseMissingIsReconHeader && (
                  <div>
                    Expense_Ledger tab <strong>{expenseWorkspace?.meta.ledgerTabName}</strong> will
                    initialize missing header column: <strong>Is_Recon</strong>.
                  </div>
                )}
              </div>
            )}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-teal-700" aria-hidden="true" />
              <p className="mt-3 text-xs font-medium text-slate-700">
                Loading Bank Ledger (Puja &amp; Regular), Expense_Ledger, and Recon_Links...
              </p>
            </div>
          ) : activeTab === 'auto' && analysis ? (
            <>
              {/* Auto-Match Summary Strip */}
              <div className="grid grid-cols-2 divide-y divide-slate-200 rounded-md border border-slate-200 bg-slate-50 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Selected Matches</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-teal-700 tabular-nums">
                    {selectedMatches.length.toLocaleString()} /{' '}
                    {analysis.matches.length.toLocaleString()}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Already Reconciled</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
                    {analysis.alreadyReconciledCount.toLocaleString()}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Bank Expenses Unlinked</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-slate-800 tabular-nums">
                    {analysis.unmatchedBankCount.toLocaleString()}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                    {formatUsd(analysis.unmatchedBankAmount)}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-slate-500">Expense Ledger Unlinked</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-slate-800 tabular-nums">
                    {analysis.unmatchedExpenseCount.toLocaleString()}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                    {formatUsd(analysis.unmatchedExpenseAmount)}
                  </div>
                </div>
              </div>

              {analysis.matches.length === 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-5 text-xs text-slate-700">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2
                      className="h-4 w-4 shrink-0 text-emerald-700"
                      aria-hidden="true"
                    />
                    <span>
                      {analysis.alreadyReconciledCount > 0 &&
                      analysis.unmatchedBankCount === 0 &&
                      analysis.unmatchedExpenseCount === 0
                        ? `All ${analysis.alreadyReconciledCount.toLocaleString()} matching expenses across the selected sheets are already reconciled.`
                        : dateToleranceDays === null
                          ? 'No new 1-to-1 exact remaining-balance matches were found. Use the Multi-Link Workbench for split (1:N), multi-payment (N:1), or M:N links.'
                          : 'No new 1-to-1 matches were found with the selected Date Tolerance. Expand the date window or switch to Multi-Link Workbench for 1:N / N:1 links.'}
                    </span>
                  </div>
                  {(analysis.unmatchedBankCount > 0 || analysis.unmatchedExpenseCount > 0) && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('workbench')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-teal-700 bg-white px-3 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-50 whitespace-nowrap"
                    >
                      <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Open Multi-Link Workbench
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
                    <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={
                          analysis.matches.length > 0 &&
                          selectedMatches.length === analysis.matches.length
                        }
                        onChange={handleToggleAll}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                      />
                      <span>
                        Proposed 1-to-1 Matches ({selectedMatches.length} of{' '}
                        {analysis.matches.length} selected)
                      </span>
                    </label>
                    <span className="text-[11px] text-slate-500">
                      {dateToleranceDays === null
                        ? 'Matched on exact remaining balance (date ignored)'
                        : 'Matched on exact remaining balance & date window'}
                    </span>
                  </div>

                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-slate-600 shadow-[inset_0_-1px_0_0_#e2e8f0]">
                        <tr>
                          <th className="w-10 px-3 py-2 font-medium">Use</th>
                          <th className="px-3 py-2 font-medium">Bank Ledger Expense</th>
                          <th className="px-3 py-2 text-right font-medium">Matched</th>
                          <th className="px-3 py-2 font-medium">Expense_Ledger Item</th>
                          <th className="px-3 py-2 font-medium">Match Signal &amp; Writes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {analysis.matches.map((m) => {
                          const checked = !deselectedKeys.has(m.matchKey);
                          const displayAmount = m.matchedAmount ?? Math.abs(m.bankTx.amount);
                          const bankTotal = Math.abs(m.bankTx.amount);
                          const isPartialLeg = Math.abs(displayAmount - bankTotal) > 0.01;
                          return (
                            <tr
                              key={m.matchKey}
                              className={
                                checked
                                  ? 'bg-white hover:bg-slate-50/80'
                                  : 'bg-slate-50/60 text-slate-400'
                              }
                            >
                              <td className="px-3 py-2.5 align-top">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMatch(m.matchKey)}
                                  aria-label={`Select match ${m.bankTx.uniqueId} and ${m.expense.expId}`}
                                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                                />
                              </td>
                              <td className="max-w-[260px] px-3 py-2.5 align-top">
                                <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                                  <span className="font-semibold text-slate-700">{m.bankTab}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{m.bankTx.date}</span>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-slate-500">{m.bankTx.source}</span>
                                </div>
                                <div
                                  className="mt-0.5 truncate font-medium text-slate-800"
                                  title={m.bankTx.description}
                                >
                                  {m.bankTx.description}
                                </div>
                                <div className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                                  ID: {m.bankTx.uniqueId}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-right align-top font-mono text-[12px] font-semibold text-slate-900 whitespace-nowrap tabular-nums">
                                <div>{formatUsd(displayAmount)}</div>
                                {isPartialLeg && (
                                  <div className="text-[10px] font-normal text-amber-700">
                                    of {formatUsd(bankTotal)}
                                  </div>
                                )}
                              </td>
                              <td className="max-w-[260px] px-3 py-2.5 align-top">
                                <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                                  <span className="font-semibold text-teal-700">
                                    {m.expense.expId}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span>{m.expense.date}</span>
                                </div>
                                <div
                                  className="mt-0.5 truncate font-medium text-slate-800"
                                  title={m.expense.description}
                                >
                                  {m.expense.description || '—'}
                                </div>
                                <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                  {m.expense.category || 'Uncategorized'}
                                  {m.expense.subCategory ? ` / ${m.expense.subCategory}` : ''}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 align-top">
                                <div className="text-[11px] font-medium text-slate-700">
                                  {m.reason}
                                </div>
                                <div className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-500">
                                  {m.needsBankTargetIdUpdate && (
                                    <div>
                                      Bank Target ID ←{' '}
                                      <span className="text-teal-700">
                                        {m.resultingBankTargetId ?? m.expense.expId}
                                      </span>
                                    </div>
                                  )}
                                  {m.needsBankIsReconUpdate && (
                                    <div>
                                      Bank Is_Recon ←{' '}
                                      <span className="text-emerald-700">
                                        {m.resultingBankIsRecon ?? 'Yes'}
                                      </span>
                                    </div>
                                  )}
                                  {m.needsBankCategoryUpdate && (
                                    <div>
                                      Bank Category ←{' '}
                                      <span className="text-teal-700">
                                        {m.resultingBankCategory ?? m.expense.category}
                                      </span>
                                    </div>
                                  )}
                                  {m.needsExpenseReconIdUpdate && (
                                    <div>
                                      Recon Source_ID ←{' '}
                                      <span className="text-slate-700">
                                        {m.resultingExpenseReconId ?? m.bankTx.uniqueId}
                                      </span>
                                    </div>
                                  )}
                                  {m.needsExpenseIsReconUpdate && (
                                    <div>
                                      Expense Is_Recon ←{' '}
                                      <span className="text-emerald-700">
                                        {m.resultingExpenseIsRecon ?? 'Yes'}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : activeTab === 'workbench' && bankLedgers && expenseWorkspace ? (
            <div className="space-y-4">
              {/* Two-Pane Selection Grid */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Left Pane: Bank Expenses */}
                <div className="flex flex-col overflow-hidden rounded-md border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="text-xs font-semibold text-slate-800">
                      Bank Ledger Expenses ({workbenchBanks.length} with balance)
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-teal-700 tabular-nums">
                      {selectedBankKeys.size} selected · {formatUsd(workbenchTotals.bankRemAmount)}
                    </span>
                  </div>
                  <div className="border-b border-slate-200 bg-white px-3 py-2">
                    <div className="relative">
                      <Search
                        className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                        aria-hidden="true"
                      />
                      <input
                        type="search"
                        value={bankSearch}
                        onChange={(e) => setBankSearch(e.target.value)}
                        placeholder="Search Bank Unique ID, exact amount, description, source, ref#..."
                        className="w-full rounded border border-slate-300 bg-white py-1.5 pr-2.5 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="max-h-[240px] divide-y divide-slate-100 overflow-y-auto bg-white">
                    {workbenchBanks.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-slate-500">
                        No open Bank Expense transactions match your search.
                      </div>
                    ) : (
                      workbenchBanks.map((entry) => {
                        const key = bankEntryKey(entry);
                        const checked = selectedBankKeys.has(key);
                        const summary = bankAllocMap.get(key);
                        const rem = summary
                          ? summary.remainingAmount
                          : Math.abs(entry.tx.amount);
                        const total = Math.abs(entry.tx.amount);
                        const isPartial = summary?.status === 'partial';
                        return (
                          <label
                            key={key}
                            className={`flex cursor-pointer items-start justify-between gap-3 px-3 py-2 text-xs transition-colors ${
                              checked ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex min-w-0 items-start gap-2.5">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleWorkbenchBank(entry)}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums">
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                                    {entry.tab}
                                  </span>
                                  <span className="font-semibold text-slate-800">
                                    {entry.tx.uniqueId}
                                  </span>
                                  <span className="text-slate-400">·</span>
                                  <span className="text-slate-600">{entry.tx.date}</span>
                                  <span className="text-slate-400">·</span>
                                  <span className="text-slate-500">{entry.tx.source}</span>
                                </div>
                                <div
                                  className="mt-0.5 truncate font-medium text-slate-800"
                                  title={entry.tx.description}
                                >
                                  {entry.tx.description}
                                </div>
                              </div>
                            </div>
                            <div className="shrink-0 text-right font-mono tabular-nums">
                              <div className="font-semibold text-slate-900">{formatUsd(rem)}</div>
                              {isPartial && (
                                <div className="text-[10px] text-amber-700">
                                  rem of {formatUsd(total)}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right Pane: Expense Ledger */}
                <div className="flex flex-col overflow-hidden rounded-md border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="text-xs font-semibold text-slate-800">
                      Expense_Ledger Items ({workbenchExpenses.length} with balance)
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-teal-700 tabular-nums">
                      {selectedExpKeys.size} selected · {formatUsd(workbenchTotals.expRemAmount)}
                    </span>
                  </div>
                  <div className="border-b border-slate-200 bg-white px-3 py-2">
                    <div className="relative">
                      <Search
                        className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                        aria-hidden="true"
                      />
                      <input
                        type="search"
                        value={expenseSearch}
                        onChange={(e) => setExpenseSearch(e.target.value)}
                        placeholder="Search Exp_ID, exact amount, category, description, payment mode..."
                        className="w-full rounded border border-slate-300 bg-white py-1.5 pr-2.5 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="max-h-[240px] divide-y divide-slate-100 overflow-y-auto bg-white">
                    {workbenchExpenses.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-slate-500">
                        No open Expense_Ledger items match your search.
                      </div>
                    ) : (
                      workbenchExpenses.map((exp) => {
                        const key = expenseRecordKey(exp);
                        const checked = selectedExpKeys.has(key);
                        const summary = expAllocMap.get(key);
                        const rem = summary ? summary.remainingAmount : Math.abs(exp.amount);
                        const total = Math.abs(exp.amount);
                        const isPartial = summary?.status === 'partial';
                        return (
                          <label
                            key={key}
                            className={`flex cursor-pointer items-start justify-between gap-3 px-3 py-2 text-xs transition-colors ${
                              checked ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex min-w-0 items-start gap-2.5">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleWorkbenchExpense(exp)}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums">
                                  <span className="font-semibold text-teal-700">{exp.expId}</span>
                                  <span className="text-slate-400">·</span>
                                  <span className="text-slate-600">{exp.date}</span>
                                  <span className="text-slate-400">·</span>
                                  <span className="font-sans text-slate-600">
                                    {exp.category || 'Uncategorized'}
                                  </span>
                                </div>
                                <div
                                  className="mt-0.5 truncate font-medium text-slate-800"
                                  title={exp.description}
                                >
                                  {exp.description || '—'}
                                </div>
                              </div>
                            </div>
                            <div className="shrink-0 text-right font-mono tabular-nums">
                              <div className="font-semibold text-slate-900">{formatUsd(rem)}</div>
                              {isPartial && (
                                <div className="text-[10px] text-amber-700">
                                  rem of {formatUsd(total)}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Balance & Proposed Links Builder */}
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-4 text-xs">
                    <div>
                      <span className="text-slate-500">Selected Bank: </span>
                      <strong className="font-mono text-slate-900 tabular-nums">
                        {formatUsd(workbenchTotals.bankRemAmount)}
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-500">Selected Expenses: </span>
                      <strong className="font-mono text-slate-900 tabular-nums">
                        {formatUsd(workbenchTotals.expRemAmount)}
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-500">Proposed Allocations: </span>
                      <strong className="font-mono text-teal-800 tabular-nums">
                        {formatUsd(workbenchTotals.proposedAmount)}
                      </strong>
                    </div>
                    {selectedBankKeys.size > 0 && selectedExpKeys.size > 0 && (
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                          workbenchTotals.isBalanced
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {workbenchTotals.isBalanced
                          ? 'Exact balance match'
                          : `${formatUsd(workbenchTotals.diffAmount)} partial difference`}
                      </span>
                    )}
                  </div>

                  {(selectedBankKeys.size > 0 || selectedExpKeys.size > 0) && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          regenerateFifoProposals(selectedBankKeys, selectedExpKeys)
                        }
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        Re-calculate FIFO
                      </button>
                      <button
                        type="button"
                        onClick={resetWorkbenchSelections}
                        className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
                      >
                        Clear Selection
                      </button>
                    </div>
                  )}
                </div>

                {proposals.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Check at least one Bank Expense transaction and one Expense_Ledger item above to
                    preview and edit allocation amounts.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded border border-slate-200 bg-white">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 shadow-[inset_0_-1px_0_0_#e2e8f0]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Bank Transaction</th>
                          <th className="px-3 py-2 font-medium">Expense Item</th>
                          <th className="px-3 py-2 font-medium">Category</th>
                          <th className="w-36 px-3 py-2 font-medium">Allocated ($)</th>
                          <th className="px-3 py-2 font-medium">Notes</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {proposals.map((prop, idx) => (
                          <tr key={prop.pairKey}>
                            <td className="px-3 py-2 align-middle">
                              <div className="font-mono text-[11px] font-semibold text-slate-800">
                                {prop.bankEntry.tab} · {prop.bankEntry.tx.uniqueId}
                              </div>
                              <div className="max-w-[220px] truncate text-[11px] text-slate-500">
                                {prop.bankEntry.tx.description}
                              </div>
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <div className="font-mono text-[11px] font-semibold text-teal-700">
                                {prop.expense.expId}
                              </div>
                              <div className="max-w-[220px] truncate text-[11px] text-slate-500">
                                {prop.expense.description}
                              </div>
                            </td>
                            <td className="px-3 py-2 align-middle text-slate-700">
                              {prop.expense.category || 'Uncategorized'}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <input
                                type="number"
                                step="0.01"
                                min="0.01"
                                value={prop.amountStr}
                                onChange={(e) => {
                                  const nextVal = e.target.value;
                                  setProposals((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, amountStr: nextVal } : item
                                    )
                                  );
                                }}
                                aria-label={`Allocated amount for ${prop.bankEntry.tx.uniqueId} to ${prop.expense.expId}`}
                                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none tabular-nums"
                              />
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <input
                                type="text"
                                value={prop.notes}
                                onChange={(e) => {
                                  const nextVal = e.target.value;
                                  setProposals((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, notes: nextVal } : item
                                    )
                                  );
                                }}
                                placeholder="Optional notes..."
                                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                              />
                            </td>
                            <td className="px-2 py-2 text-center align-middle">
                              <button
                                type="button"
                                onClick={() =>
                                  setProposals((prev) => prev.filter((_, i) => i !== idx))
                                }
                                title="Remove this allocation leg"
                                aria-label="Remove allocation leg"
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {!workbenchValidation.valid && workbenchValidation.errors.length > 0 && (
                  <div
                    role="alert"
                    className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-0.5"
                  >
                    {workbenchValidation.errors.map((err, i) => (
                      <div key={i}>{err}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <p className="text-[11px] text-slate-500">
            {activeTab === 'auto'
              ? 'Selected matches record links in Recon_Links and sync Target ID, Is_Recon, Category, and Recon Source_ID.'
              : 'Each proposed leg creates a row in Recon_Links and updates Is_Recon (Yes only when remaining ≤ $0.01) & Bank Category ("Multiple" if mixed).'}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isApplying}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              Cancel
            </button>
            {activeTab === 'auto' ? (
              <button
                type="button"
                onClick={handleApplyAutoMatches}
                disabled={!canConfirmAuto}
                className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 whitespace-nowrap"
              >
                {isApplying
                  ? 'Updating Google Sheets...'
                  : selectedMatches.length > 0
                    ? `Confirm & Update ${selectedMatches.length} Match${selectedMatches.length === 1 ? '' : 'es'}`
                    : tabsMissingHeaders.length > 0 || expenseMissingIsReconHeader
                      ? 'Initialize Missing Columns'
                      : 'No Updates Selected'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleApplyWorkbenchLinks}
                disabled={!canConfirmWorkbench}
                className="rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 whitespace-nowrap"
              >
                {isApplying
                  ? 'Saving Links to Google Sheets...'
                  : workbenchCandidateInputs.length > 0
                    ? `Apply ${workbenchCandidateInputs.length} Link${workbenchCandidateInputs.length === 1 ? '' : 's'}`
                    : 'Select Items to Link'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
