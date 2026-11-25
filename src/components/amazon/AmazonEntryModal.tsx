import React, { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, X } from 'lucide-react';
import { AmazonOrderRecord, AmazonOrderStatus } from '../../types/amazon';
import {
  buildAmazonDuplicateKey,
  buildAmazonUniqueId,
  normalizeAmazonDate,
  parseOptionalAmazonNumber,
} from '../../utils/amazonProcessor';

interface AmazonEntryModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  record: AmazonOrderRecord | null;
  expenseCategoryOptions: string[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (
    nextRecord: AmazonOrderRecord,
    original: AmazonOrderRecord | null
  ) => Promise<void> | void;
}

const STATUS_OPTIONS: Array<{ value: AmazonOrderStatus; label: string }> = [
  { value: '', label: '— (Leave Blank)' },
  { value: 'Ordered', label: 'Ordered' },
  { value: 'Delivered', label: 'Delivered' },
  { value: 'Cancelled', label: 'Cancelled' },
  { value: 'Returned', label: 'Returned' },
];

export const AmazonEntryModal: React.FC<AmazonEntryModalProps> = ({
  isOpen,
  mode,
  record,
  expenseCategoryOptions,
  isSaving,
  onClose,
  onSave,
}) => {
  const [orderNumber, setOrderNumber] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [itemPrice, setItemPrice] = useState('');
  const [total, setTotal] = useState('');
  const [shippedTo, setShippedTo] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [status, setStatus] = useState<AmazonOrderStatus>('');
  const [isRecon, setIsRecon] = useState<'Yes' | 'No'>('No');
  const [category, setCategory] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValidationError(null);
    if (mode === 'edit' && record) {
      setOrderNumber(record.orderNumber);
      setOrderDate(record.orderDate);
      setQuantity(record.quantity !== null ? String(record.quantity) : '');
      setItemDescription(record.itemDescription);
      setItemPrice(record.itemPrice !== null ? record.itemPrice.toFixed(2) : '');
      setTotal(record.total !== null ? record.total.toFixed(2) : '');
      setShippedTo(record.shippedTo);
      setPaymentMethod(record.paymentMethod);
      setStatus(record.status);
      setIsRecon(record.isRecon);
      setCategory((record.category ?? '').trim());
    } else {
      setOrderNumber('');
      setOrderDate(new Date().toISOString().slice(0, 10));
      setQuantity('');
      setItemDescription('');
      setItemPrice('');
      setTotal('');
      setShippedTo('');
      setPaymentMethod('');
      setStatus('Ordered');
      setIsRecon('No');
      setCategory('');
    }
  }, [isOpen, mode, record]);

  const effectiveCategories = useMemo(() => {
    const base = [...expenseCategoryOptions];
    const trimmed = category.trim();
    if (trimmed && !base.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      base.unshift(trimmed);
    }
    return base;
  }, [expenseCategoryOptions, category]);

  if (!isOpen) return null;

  const parsedPreviewQty = parseOptionalAmazonNumber(quantity, 0);
  const parsedPreviewPrice = parseOptionalAmazonNumber(itemPrice, 2);

  const previewUniqueId = buildAmazonUniqueId({
    orderNumber,
    orderDate,
    quantity: parsedPreviewQty !== null && parsedPreviewQty > 0 ? parsedPreviewQty : null,
    itemDescription,
    itemPrice: parsedPreviewPrice,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedOrder = orderNumber.trim();
    const normDate = normalizeAmazonDate(orderDate);
    const trimmedDesc = itemDescription.trim();

    if (!trimmedOrder && !trimmedDesc) {
      setValidationError('Enter at least an Order # or Item Description.');
      return;
    }

    let safeQty: number | null = null;
    if (quantity.trim() !== '') {
      const parsed = Number.parseFloat(quantity.replace(/[\s,]/g, ''));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setValidationError('Quantity must be a positive number (or leave blank).');
        return;
      }
      safeQty = Math.round(parsed);
    }

    let safePrice: number | null = null;
    if (itemPrice.trim() !== '') {
      const parsed = Number.parseFloat(itemPrice.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(parsed) || parsed < 0) {
        setValidationError('Item Price must be 0 or greater (or leave blank).');
        return;
      }
      safePrice = Math.round(parsed * 100) / 100;
    }

    let safeTotal: number | null = null;
    if (total.trim() !== '') {
      const parsed = Number.parseFloat(total.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(parsed) || parsed < 0) {
        setValidationError('Total must be 0 or greater (or leave blank).');
        return;
      }
      safeTotal = Math.round(parsed * 100) / 100;
    }

    const identityArgs = {
      orderNumber: trimmedOrder,
      orderDate: normDate,
      quantity: safeQty,
      itemDescription: trimmedDesc,
      itemPrice: safePrice,
    };

    const nextUniqueId = buildAmazonUniqueId(identityArgs);
    const duplicateKey = buildAmazonDuplicateKey(identityArgs);

    const nextRecord: AmazonOrderRecord = {
      rowKey:
        record?.rowKey ??
        `manual-amazon-${nextUniqueId}-${crypto.randomUUID().slice(0, 8)}`,
      uniqueId: nextUniqueId,
      duplicateKey,
      orderNumber: trimmedOrder,
      orderDate: normDate,
      quantity: safeQty,
      itemDescription: trimmedDesc,
      itemPrice: safePrice,
      total: safeTotal,
      shippedTo: shippedTo.trim(),
      paymentMethod: paymentMethod.trim(),
      status,
      isRecon,
      category: category.trim(),
      sourceOrigin: record?.sourceOrigin ?? 'scan',
      sourceFileName: record?.sourceFileName ?? 'Manual Amazon Order Entry',
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
      aria-labelledby="amazon-entry-modal-title"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-teal-700" aria-hidden="true" />
            <div>
              <h2
                id="amazon-entry-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                {mode === 'edit'
                  ? `Edit Amazon Order${
                      record?.sheetRowNumber ? ` (Row #${record.sheetRowNumber})` : ' (Staged)'
                    }`
                  : 'Add Amazon Order'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Leave optional fields blank if unavailable on your order summary or invoice.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Close Amazon order editor modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5">
            <div>
              <div className="text-[11px] text-slate-500">
                Column A · 12-Digit Deterministic Hash ID
              </div>
              <div className="mt-0.5 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                {previewUniqueId}
              </div>
            </div>
            <div className="text-[11px] text-slate-500">
              SHA-256(Order # + Date + Qty + Description + Item Price)
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="amz-order-number" className="block text-xs font-medium text-slate-700">
                Order #
              </label>
              <input
                id="amz-order-number"
                type="text"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                disabled={isSaving}
                placeholder="e.g. 111-0177387-1485024"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-order-date" className="block text-xs font-medium text-slate-700">
                Order Date
              </label>
              <input
                id="amz-order-date"
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="amz-description" className="block text-xs font-medium text-slate-700">
                Item Description
              </label>
              <input
                id="amz-description"
                type="text"
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                disabled={isSaving}
                placeholder="Product title / description"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-quantity" className="block text-xs font-medium text-slate-700">
                Quantity
              </label>
              <input
                id="amz-quantity"
                type="number"
                step="1"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={isSaving}
                placeholder="Blank if unavailable"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-item-price" className="block text-xs font-medium text-slate-700">
                Item Price (USD)
              </label>
              <input
                id="amz-item-price"
                type="number"
                step="0.01"
                min="0"
                value={itemPrice}
                onChange={(e) => setItemPrice(e.target.value)}
                disabled={isSaving}
                placeholder="Blank if unavailable"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-total" className="block text-xs font-medium text-slate-700">
                Total (USD)
              </label>
              <input
                id="amz-total"
                type="number"
                step="0.01"
                min="0"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                disabled={isSaving}
                placeholder="Blank if unavailable"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-shipped-to" className="block text-xs font-medium text-slate-700">
                Shipped To / Recipient
              </label>
              <input
                id="amz-shipped-to"
                type="text"
                value={shippedTo}
                onChange={(e) => setShippedTo(e.target.value)}
                disabled={isSaving}
                placeholder="Recipient name"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-payment" className="block text-xs font-medium text-slate-700">
                Payment Method
              </label>
              <input
                id="amz-payment"
                type="text"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                disabled={isSaving}
                placeholder="e.g. credit/debit, Visa ending in 1234"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amz-status" className="block text-xs font-medium text-slate-700">
                Status
              </label>
              <select
                id="amz-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as AmazonOrderStatus)}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.label} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="amz-is-recon" className="block text-xs font-medium text-slate-700">
                Is_Recon
              </label>
              <select
                id="amz-is-recon"
                value={isRecon}
                onChange={(e) => setIsRecon(e.target.value === 'Yes' ? 'Yes' : 'No')}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>

            <div>
              <label htmlFor="amz-category" className="block text-xs font-medium text-slate-700">
                Category (Expense)
              </label>
              <select
                id="amz-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={isSaving}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
              >
                <option value="">None / Uncategorized</option>
                {effectiveCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
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
                  ? 'Save to Amazon_Ledger'
                  : mode === 'create'
                    ? 'Record Order to Sheet'
                    : 'Update Staged Order'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
