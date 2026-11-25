import React, { useEffect, useMemo, useState } from 'react';
import { CheckSquare, FileSpreadsheet, Sparkles, X } from 'lucide-react';
import { AmazonCategorizeSuggestion, AmazonOrderRecord } from '../../types/amazon';

export interface AmazonCategorizeReviewItem {
  record: AmazonOrderRecord;
  suggestion: AmazonCategorizeSuggestion;
}

interface AmazonCategorizeModalProps {
  isOpen: boolean;
  items: AmazonCategorizeReviewItem[];
  expenseCategoryOptions: string[];
  isApplying: boolean;
  onClose: () => void;
  onApply: (updates: Array<{ sheetRowNumber: number; category: string }>) => Promise<void> | void;
}

const METHOD_BADGE_LABELS: Record<AmazonCategorizeSuggestion['method'], string> = {
  'deterministic-exact': 'Rule (Exact)',
  'deterministic-keyword': 'Rule (Keyword)',
  'historical-description': 'History (Item)',
  llm: 'AI Match',
  abstained: 'Abstained',
};

export const AmazonCategorizeModal: React.FC<AmazonCategorizeModalProps> = ({
  isOpen,
  items,
  expenseCategoryOptions,
  isApplying,
  onClose,
  onApply,
}) => {
  const [draftCategories, setDraftCategories] = useState<Record<string, string>>({});
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    const nextCats: Record<string, string> = {};
    const nextSelected = new Set<string>();
    for (const item of items) {
      const cat = item.suggestion.category.trim();
      nextCats[item.record.rowKey] = cat;
      if (cat) {
        nextSelected.add(item.record.rowKey);
      }
    }
    setDraftCategories(nextCats);
    setSelectedKeys(nextSelected);
  }, [isOpen, items]);

  const metrics = useMemo(() => {
    let deterministicCount = 0;
    let aiCount = 0;
    let abstainedCount = 0;
    let selectedCount = 0;

    for (const item of items) {
      const m = item.suggestion.method;
      if (m === 'abstained' || !item.suggestion.category) {
        abstainedCount++;
      } else if (m === 'llm') {
        aiCount++;
      } else {
        deterministicCount++;
      }

      const cat = (draftCategories[item.record.rowKey] ?? '').trim();
      if (selectedKeys.has(item.record.rowKey) && cat && item.record.sheetRowNumber) {
        selectedCount++;
      }
    }

    return { deterministicCount, aiCount, abstainedCount, selectedCount };
  }, [items, draftCategories, selectedKeys]);

  if (!isOpen) return null;

  const toggleRow = (rowKey: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  const handleCategoryChange = (rowKey: string, nextCat: string) => {
    setDraftCategories((prev) => ({ ...prev, [rowKey]: nextCat }));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (nextCat.trim()) {
        next.add(rowKey);
      } else {
        next.delete(rowKey);
      }
      return next;
    });
  };

  const handleConfirm = async () => {
    const updates: Array<{ sheetRowNumber: number; category: string }> = [];
    for (const item of items) {
      const sheetRowNumber = item.record.sheetRowNumber;
      const cat = (draftCategories[item.record.rowKey] ?? '').trim();
      if (sheetRowNumber && selectedKeys.has(item.record.rowKey) && cat) {
        updates.push({ sheetRowNumber, category: cat });
      }
    }
    if (updates.length === 0) return;
    await onApply(updates);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="amazon-categorize-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2
                id="amazon-categorize-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                Auto-Categorize Uncategorized Amazon Orders
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Matches Item Description against expense categories listed in the LookUp tab.
                Ambiguous rows abstain without guessing.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isApplying}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close auto-categorize review modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Summary Strip */}
        <div className="grid grid-cols-2 gap-3 border-b border-slate-200 bg-slate-50/70 px-6 py-3 sm:grid-cols-4">
          <div className="rounded border border-slate-200 bg-white px-3 py-2">
            <div className="text-[11px] text-slate-500">Uncategorized Reviewed</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 tabular-nums">
              {items.length}
            </div>
          </div>
          <div className="rounded border border-slate-200 bg-white px-3 py-2">
            <div className="text-[11px] text-slate-500">Deterministic / History</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-emerald-700 tabular-nums">
              {metrics.deterministicCount}
            </div>
          </div>
          <div className="rounded border border-slate-200 bg-white px-3 py-2">
            <div className="text-[11px] text-slate-500">Strict Constrained AI</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-teal-700 tabular-nums">
              {metrics.aiCount}
            </div>
          </div>
          <div className="rounded border border-slate-200 bg-white px-3 py-2">
            <div className="text-[11px] text-slate-500">Abstained (Kept Blank)</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-slate-600 tabular-nums">
              {metrics.abstainedCount}
            </div>
          </div>
        </div>

        {/* Review Table */}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="w-10 px-4 py-2.5 text-center font-medium">
                  <CheckSquare className="mx-auto h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                </th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Order Date</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Order #</th>
                <th className="px-3 py-2.5 font-medium">Item Description</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Total</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Source</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Assigned Category</th>
                <th className="px-4 py-2.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map(({ record, suggestion }) => {
                const draftCat = draftCategories[record.rowKey] ?? '';
                const isChecked = selectedKeys.has(record.rowKey) && draftCat.trim() !== '';
                const effectiveOptions =
                  draftCat &&
                  !expenseCategoryOptions.some(
                    (c) => c.toLowerCase() === draftCat.toLowerCase()
                  )
                    ? [draftCat, ...expenseCategoryOptions]
                    : expenseCategoryOptions;

                const isAbstained = suggestion.method === 'abstained' || !suggestion.category;

                return (
                  <tr
                    key={record.rowKey}
                    className={
                      isAbstained ? 'bg-slate-50/60 text-slate-500' : 'hover:bg-slate-50/80'
                    }
                  >
                    <td className="px-4 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(record.rowKey)}
                        disabled={!draftCat.trim() || isApplying}
                        onChange={() => toggleRow(record.rowKey)}
                        aria-label={`Apply category for order ${record.orderNumber || record.uniqueId}`}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap tabular-nums">
                      {record.orderDate || '—'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] font-medium text-slate-800 whitespace-nowrap tabular-nums">
                      {record.orderNumber || '—'}
                    </td>
                    <td
                      className="max-w-[260px] truncate px-3 py-2.5 text-slate-800"
                      title={record.itemDescription}
                    >
                      {record.itemDescription || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[11px] whitespace-nowrap tabular-nums">
                      {record.total !== null
                        ? record.total.toLocaleString('en-US', {
                            style: 'currency',
                            currency: 'USD',
                          })
                        : record.itemPrice !== null
                          ? record.itemPrice.toLocaleString('en-US', {
                              style: 'currency',
                              currency: 'USD',
                            })
                          : '—'}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
                          suggestion.method === 'llm'
                            ? 'bg-teal-50 text-teal-800'
                            : isAbstained
                              ? 'bg-slate-100 text-slate-600'
                              : 'bg-emerald-50 text-emerald-800'
                        }`}
                      >
                        {METHOD_BADGE_LABELS[suggestion.method]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <select
                        value={draftCat}
                        onChange={(e) => handleCategoryChange(record.rowKey, e.target.value)}
                        disabled={isApplying}
                        aria-label={`Category for order ${record.orderNumber || record.uniqueId}`}
                        className={`max-w-[180px] rounded border bg-white px-2 py-1 text-[11px] focus:border-teal-700 focus:outline-none ${
                          isChecked
                            ? 'border-teal-500 font-medium text-slate-900'
                            : 'border-slate-300 text-slate-600'
                        }`}
                      >
                        <option value="">— (Leave Blank)</option>
                        {effectiveOptions.map((cat) => (
                          <option key={cat} value={cat}>
                            {cat}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td
                      className="max-w-[240px] truncate px-4 py-2.5 text-[11px] text-slate-500"
                      title={suggestion.reason}
                    >
                      {suggestion.reason}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
          <div className="text-xs text-slate-600">
            <strong className="font-mono text-slate-900 tabular-nums">
              {metrics.selectedCount}
            </strong>{' '}
            {metrics.selectedCount === 1 ? 'order' : 'orders'} selected to update in{' '}
            <span className="font-medium text-slate-800">Amazon_Ledger</span>.
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isApplying}
              className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={isApplying || metrics.selectedCount === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
              {isApplying
                ? 'Saving Categories...'
                : `Apply ${metrics.selectedCount} ${
                    metrics.selectedCount === 1 ? 'Category' : 'Categories'
                  } to Amazon_Ledger`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
