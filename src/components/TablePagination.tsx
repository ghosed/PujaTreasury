import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 150, 200] as const;

interface TablePaginationProps {
  totalItems: number;
  pageSize: number;
  currentPage: number;
  singularLabel: string;
  pluralLabel: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

function getVisiblePages(current: number, total: number): Array<number | 'ellipsis-left' | 'ellipsis-right'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx + 1);
  }

  const pages: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [1];

  if (current > 3) {
    pages.push('ellipsis-left');
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let p = start; p <= end; p++) {
    pages.push(p);
  }

  if (current < total - 2) {
    pages.push('ellipsis-right');
  }

  pages.push(total);
  return pages;
}

export const TablePagination: React.FC<TablePaginationProps> = ({
  totalItems,
  pageSize,
  currentPage,
  singularLabel,
  pluralLabel,
  onPageChange,
  onPageSizeChange,
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const startRow = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endRow = Math.min(safePage * pageSize, totalItems);
  const visiblePages = getVisiblePages(safePage, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-xs text-slate-600">
      <div className="font-mono text-slate-500 tabular-nums">
        Showing{' '}
        <span className="font-medium text-slate-700">
          {startRow.toLocaleString()}–{endRow.toLocaleString()}
        </span>{' '}
        of{' '}
        <span className="font-medium text-slate-700">
          {totalItems.toLocaleString()}
        </span>{' '}
        {totalItems === 1 ? singularLabel : pluralLabel}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
          <span className="whitespace-nowrap">Rows per page:</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rows per page"
            title="Select how many rows to display per page"
            className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <nav aria-label="Table pagination" className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(1)}
            disabled={safePage <= 1}
            title="First page"
            aria-label="First page"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronsLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => onPageChange(safePage - 1)}
            disabled={safePage <= 1}
            title="Previous page"
            aria-label="Previous page"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          {visiblePages.map((entry) =>
            typeof entry === 'string' ? (
              <span
                key={entry}
                className="px-1 font-mono text-xs text-slate-400 select-none"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                onClick={() => onPageChange(entry)}
                aria-current={entry === safePage ? 'page' : undefined}
                title={`Page ${entry} of ${totalPages}`}
                className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded border px-2 font-mono text-xs tabular-nums transition-colors ${
                  entry === safePage
                    ? 'border-teal-700 bg-teal-700 font-semibold text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                {entry}
              </button>
            )
          )}

          <button
            type="button"
            onClick={() => onPageChange(safePage + 1)}
            disabled={safePage >= totalPages}
            title="Next page"
            aria-label="Next page"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => onPageChange(totalPages)}
            disabled={safePage >= totalPages}
            title="Last page"
            aria-label="Last page"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </nav>
      </div>
    </div>
  );
};
