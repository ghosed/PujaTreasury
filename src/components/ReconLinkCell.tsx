import React, { useEffect, useRef, useState } from 'react';
import { AllocationSummary } from '../types/reconciliation';
import { parseIdList } from '../utils/reconAllocations';

interface ReconLinkCellProps {
  summary?: AllocationSummary;
  fallbackId?: string;
  partnerLabel: string;
  linkDirection: 'to-target' | 'to-bank';
  emptyLabel?: string;
}

function formatCompactCurrency(amount: number): string {
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
}

function formatFullCurrency(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export const ReconLinkCell: React.FC<ReconLinkCellProps> = ({
  summary,
  fallbackId,
  partnerLabel,
  linkDirection,
  emptyLabel = '—',
}) => {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const popoverWidth = 310;
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - popoverWidth - 12)
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow < 220 ? Math.max(8, rect.top - 8) : rect.bottom + 6;
    setPopoverPos({ top, left });
  };

  const openPopover = (pin: boolean) => {
    clearCloseTimer();
    updatePosition();
    setPopoverOpen(true);
    if (pin) setIsPinned(true);
  };

  const scheduleHoverClose = () => {
    if (isPinned) return;
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setPopoverOpen(false);
    }, 150);
  };

  useEffect(() => {
    if (!popoverOpen) return;

    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setPopoverOpen(false);
      setIsPinned(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPopoverOpen(false);
        setIsPinned(false);
      }
    };

    const handleScrollOrResize = () => {
      setPopoverOpen(false);
      setIsPinned(false);
    };

    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [popoverOpen]);

  useEffect(() => () => clearCloseTimer(), []);

  const links = summary?.links ?? [];

  // Fallback when no explicit Recon_Links rows exist for this record
  if (links.length === 0) {
    const parsedIds = parseIdList(fallbackId);
    if (parsedIds.length === 0) {
      return <span className="text-slate-400">{emptyLabel}</span>;
    }
    if (parsedIds.length === 1) {
      return (
        <span
          className="font-mono text-[11px] font-medium text-teal-700"
          title={`Linked ${partnerLabel}: ${parsedIds[0]}`}
        >
          {parsedIds[0]}
        </span>
      );
    }

    // Legacy / raw comma-separated IDs without Recon_Links details
    return (
      <div
        ref={triggerRef}
        className="relative inline-flex flex-wrap items-center gap-1.5"
        onMouseEnter={() => openPopover(false)}
        onMouseLeave={scheduleHoverClose}
      >
        <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-emerald-800">
          {parsedIds.length} links
        </span>
        <button
          type="button"
          onClick={() => {
            if (popoverOpen && isPinned) {
              setPopoverOpen(false);
              setIsPinned(false);
            } else {
              openPopover(true);
            }
          }}
          className="text-[11px] font-medium text-teal-700 underline decoration-dotted hover:text-teal-900"
        >
          More
        </button>

        {popoverOpen && popoverPos && (
          <div
            ref={popoverRef}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleHoverClose}
            style={{ top: popoverPos.top, left: popoverPos.left }}
            className="fixed z-50 w-[300px] rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-1.5">
              <span className="text-[11px] font-semibold text-slate-900">
                Linked {partnerLabel}s ({parsedIds.length})
              </span>
              {isPinned && (
                <button
                  type="button"
                  onClick={() => {
                    setPopoverOpen(false);
                    setIsPinned(false);
                  }}
                  className="text-[10px] text-slate-400 hover:text-slate-700"
                >
                  Close
                </button>
              )}
            </div>
            <ul className="max-h-44 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-700">
              {parsedIds.map((id) => (
                <li key={id} className="rounded bg-slate-50 px-2 py-1">
                  {id}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // 1 explicit link
  if (links.length === 1 && summary) {
    const singleLink = links[0];
    const singlePartnerId =
      linkDirection === 'to-target' ? singleLink.targetId : singleLink.bankUniqueId;
    const isPartial = summary.status === 'partial';

    return (
      <div
        ref={triggerRef}
        className="inline-flex flex-col items-start gap-0.5"
        onMouseEnter={() => {
          if (isPartial) openPopover(false);
        }}
        onMouseLeave={scheduleHoverClose}
      >
        <span
          className={`font-mono text-[11px] font-medium ${
            isPartial ? 'text-amber-800' : 'text-teal-700'
          }`}
          title={`Linked ${partnerLabel}: ${singlePartnerId} (${formatFullCurrency(
            singleLink.allocatedAmount
          )})`}
        >
          {singlePartnerId}
        </span>
        {isPartial && (
          <button
            type="button"
            onClick={() => {
              if (popoverOpen && isPinned) {
                setPopoverOpen(false);
                setIsPinned(false);
              } else {
                openPopover(true);
              }
            }}
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-800 hover:bg-amber-100"
          >
            Partial · {formatCompactCurrency(summary.allocatedAmount)}/
            {formatCompactCurrency(summary.totalAmount)}
          </button>
        )}

        {popoverOpen && popoverPos && (
          <div
            ref={popoverRef}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleHoverClose}
            style={{ top: popoverPos.top, left: popoverPos.left }}
            className="fixed z-50 w-[310px] rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-1.5">
              <span className="text-[11px] font-semibold text-slate-900">
                Partial Allocation (1 link)
              </span>
              {isPinned && (
                <button
                  type="button"
                  onClick={() => {
                    setPopoverOpen(false);
                    setIsPinned(false);
                  }}
                  className="text-[10px] text-slate-400 hover:text-slate-700"
                >
                  Close
                </button>
              )}
            </div>
            <div className="flex items-center justify-between rounded bg-slate-50 px-2 py-1.5 text-[11px]">
              <div className="min-w-0">
                <div className="font-mono font-medium text-slate-900">{singlePartnerId}</div>
                {singleLink.category && (
                  <div className="truncate text-[10px] text-slate-500">
                    {singleLink.category}
                  </div>
                )}
              </div>
              <span className="shrink-0 font-mono font-semibold text-slate-800">
                {formatFullCurrency(singleLink.allocatedAmount)}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 font-mono text-[10px] text-slate-600">
              <span>Allocated: {formatFullCurrency(summary.allocatedAmount)}</span>
              <span className="font-semibold text-amber-700">
                Remaining: {formatFullCurrency(summary.remainingAmount)}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2+ links
  const isPartial = summary?.status === 'partial';
  const showMoreLabel = links.length > 2;
  const allocatedStr = formatCompactCurrency(summary?.allocatedAmount ?? 0);
  const totalStr = formatCompactCurrency(summary?.totalAmount ?? 0);

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex flex-wrap items-center gap-1.5"
      onMouseEnter={() => openPopover(false)}
      onMouseLeave={scheduleHoverClose}
    >
      <button
        type="button"
        onClick={() => {
          if (popoverOpen && isPinned) {
            setPopoverOpen(false);
            setIsPinned(false);
          } else {
            openPopover(true);
          }
        }}
        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium transition-colors ${
          isPartial
            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
        }`}
        title={
          isPartial
            ? `Partial: ${formatFullCurrency(summary?.allocatedAmount ?? 0)} of ${formatFullCurrency(
                summary?.totalAmount ?? 0
              )} allocated`
            : `Fully linked (${links.length} links · ${formatFullCurrency(
                summary?.allocatedAmount ?? 0
              )})`
        }
      >
        <span>
          {links.length} links · {allocatedStr}/{totalStr}
        </span>
        {isPartial && <span className="font-sans text-[10px] font-semibold">(Partial)</span>}
      </button>

      {showMoreLabel && (
        <button
          type="button"
          onClick={() => {
            if (popoverOpen && isPinned) {
              setPopoverOpen(false);
              setIsPinned(false);
            } else {
              openPopover(true);
            }
          }}
          className="text-[11px] font-medium text-teal-700 underline decoration-dotted hover:text-teal-900"
        >
          More
        </button>
      )}

      {popoverOpen && popoverPos && summary && (
        <div
          ref={popoverRef}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleHoverClose}
          style={{ top: popoverPos.top, left: popoverPos.left }}
          className="fixed z-50 w-[310px] rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-1.5">
            <span className="text-[11px] font-semibold text-slate-900">
              {links.length} Linked {partnerLabel}s ({summary.matchCardinality})
            </span>
            {isPinned && (
              <button
                type="button"
                onClick={() => {
                  setPopoverOpen(false);
                  setIsPinned(false);
                }}
                className="text-[10px] text-slate-400 hover:text-slate-700"
              >
                Close
              </button>
            )}
          </div>

          <ul className="max-h-48 space-y-1.5 overflow-y-auto">
            {links.map((link) => {
              const partnerId =
                linkDirection === 'to-target' ? link.targetId : link.bankUniqueId;
              return (
                <li
                  key={link.linkId}
                  className="flex items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1.5 text-[11px]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono font-medium text-slate-900">
                      {partnerId}
                    </div>
                    <div className="truncate text-[10px] text-slate-500">
                      {link.bankTab}
                      {link.category ? ` · ${link.category}` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono font-semibold text-slate-800 tabular-nums">
                    {formatFullCurrency(link.allocatedAmount)}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 font-mono text-[10px] text-slate-600">
            <span>
              {formatFullCurrency(summary.allocatedAmount)} /{' '}
              {formatFullCurrency(summary.totalAmount)}
            </span>
            {summary.remainingCents > 1 ? (
              <span className="font-semibold text-amber-700">
                Remaining: {formatFullCurrency(summary.remainingAmount)}
              </span>
            ) : (
              <span className="font-semibold text-emerald-700">Fully Allocated</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
