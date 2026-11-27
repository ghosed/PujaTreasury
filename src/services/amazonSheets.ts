import {
  AmazonOrderRecord,
  AmazonOrderStatus,
  AmazonSheetMeta,
  AmazonSyncPlan,
  AmazonSyncResult,
} from '../types/amazon';
import {
  buildAmazonDuplicateKey,
  buildAmazonUniqueId,
  normalizeAmazonDate,
  normalizeAmazonPaymentMethod,
  normalizeAmazonStatus,
  parseOptionalAmazonNumber,
} from '../utils/amazonProcessor';
import { SheetsApiError } from './googleSheets';

export const AMAZON_SPREADSHEET_ID = '1gUfilv92MEzQXxHwPuElhd2kin8TDU4APyWwdj9nO4E';
export const AMAZON_DEFAULT_TAB = 'AmzOrders';

export const CANONICAL_AMAZON_HEADERS = [
  'Unique ID',
  'Order #',
  'Order Date',
  'Quantity',
  'Item Description',
  'Item Price',
  'Total',
  'Shipped To',
  'Payment Method',
  'Status',
  'Is_Recon',
  'Category',
  'Exp_ID',
  'Bank_ID',
  'Source File',
] as const;

interface SpreadsheetMetadata {
  properties?: { title?: string };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
}

function normalizeHeaderKey(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function colIndexToA1(index: number): string {
  let col = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
}

function normalizeIsRecon(raw: unknown): 'Yes' | 'No' {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === 'y') return 'Yes';
  return 'No';
}

async function sheetsFetch<T>(
  url: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let errorMessage = `Google Sheets API error (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) {
        errorMessage = errBody.error.message;
      }
    } catch {
      // keep fallback message
    }
    throw new SheetsApiError(errorMessage, res.status);
  }

  return (await res.json()) as T;
}

type AmazonFieldKey =
  | 'uniqueId'
  | 'orderNumber'
  | 'orderDate'
  | 'quantity'
  | 'itemDescription'
  | 'itemPrice'
  | 'total'
  | 'shippedTo'
  | 'paymentMethod'
  | 'status'
  | 'isRecon'
  | 'category'
  | 'expId'
  | 'bankId'
  | 'sourceFileName';

const HEADER_TO_AMAZON_FIELD: Record<string, AmazonFieldKey> = {
  uniqueid: 'uniqueId',
  uniquetransactionid: 'uniqueId',
  id: 'uniqueId',
  order: 'orderNumber',
  orderno: 'orderNumber',
  ordernum: 'orderNumber',
  ordernumber: 'orderNumber',
  orderid: 'orderNumber',
  orderdate: 'orderDate',
  date: 'orderDate',
  orderplaced: 'orderDate',
  quantity: 'quantity',
  qty: 'quantity',
  itemdescription: 'itemDescription',
  description: 'itemDescription',
  item: 'itemDescription',
  items: 'itemDescription',
  product: 'itemDescription',
  itemprice: 'itemPrice',
  unitprice: 'itemPrice',
  price: 'itemPrice',
  total: 'total',
  ordertotal: 'total',
  linetotal: 'total',
  amount: 'total',
  shippedto: 'shippedTo',
  shipto: 'shippedTo',
  shippedtoorrecipient: 'shippedTo',
  recipient: 'shippedTo',
  paymentmethod: 'paymentMethod',
  payment: 'paymentMethod',
  status: 'status',
  orderstatus: 'status',
  isrecon: 'isRecon',
  category: 'category',
  cat: 'category',
  expid: 'expId',
  expenseid: 'expId',
  expenseledgerid: 'expId',
  linkedexpid: 'expId',
  matchingexpid: 'expId',
  bankid: 'bankId',
  bankstatementid: 'bankId',
  banktransactionid: 'bankId',
  bankledgerid: 'bankId',
  linkedbankid: 'bankId',
  matchingbankid: 'bankId',
  sourcefile: 'sourceFileName',
  sourcefilename: 'sourceFileName',
  filename: 'sourceFileName',
};

function buildAmazonFieldMap(headers: string[]): Map<AmazonFieldKey, number> {
  const map = new Map<AmazonFieldKey, number>();
  headers.forEach((header, idx) => {
    const norm = normalizeHeaderKey(header);
    const field = HEADER_TO_AMAZON_FIELD[norm];
    if (field && !map.has(field)) {
      map.set(field, idx);
    }
  });
  return map;
}

function serializeAmazonRow(
  record: AmazonOrderRecord,
  meta: Pick<
    AmazonSheetMeta,
    | 'columnHeaders'
    | 'isReconColIndex'
    | 'categoryColIndex'
    | 'expIdColIndex'
    | 'bankIdColIndex'
    | 'sourceFileColIndex'
  >
): Array<string | number> {
  const fieldToIdx = buildAmazonFieldMap(meta.columnHeaders);
  const length = Math.max(
    meta.columnHeaders.length,
    CANONICAL_AMAZON_HEADERS.length,
    meta.isReconColIndex + 1,
    meta.categoryColIndex + 1,
    meta.expIdColIndex + 1,
    meta.bankIdColIndex + 1,
    meta.sourceFileColIndex + 1
  );
  const row: Array<string | number> = record.rawRowValues
    ? [...record.rawRowValues]
    : new Array(length).fill('');

  while (row.length < length) {
    row.push('');
  }

  const setField = (field: AmazonFieldKey, val: string | number, fallbackIdx: number) => {
    const idx = fieldToIdx.get(field) ?? fallbackIdx;
    row[idx] = val;
  };

  setField('uniqueId', record.uniqueId, 0);
  setField('orderNumber', record.orderNumber, 1);
  setField('orderDate', record.orderDate, 2);
  setField(
    'quantity',
    record.quantity !== null && Number.isFinite(record.quantity)
      ? Math.round(record.quantity)
      : '',
    3
  );
  setField('itemDescription', record.itemDescription, 4);
  setField(
    'itemPrice',
    record.itemPrice !== null && Number.isFinite(record.itemPrice)
      ? Number(record.itemPrice.toFixed(2))
      : '',
    5
  );
  setField(
    'total',
    record.total !== null && Number.isFinite(record.total)
      ? Number(record.total.toFixed(2))
      : '',
    6
  );
  setField('shippedTo', record.shippedTo, 7);
  setField('paymentMethod', normalizeAmazonPaymentMethod(record.paymentMethod), 8);
  setField('status', record.status, 9);
  setField('isRecon', record.isRecon || 'No', meta.isReconColIndex);
  setField('category', record.category || '', meta.categoryColIndex);
  setField('expId', (record.expId ?? '').trim(), meta.expIdColIndex);
  setField('bankId', (record.bankId ?? '').trim(), meta.bankIdColIndex);
  setField('sourceFileName', (record.sourceFileName ?? '').trim(), meta.sourceFileColIndex);

  return row;
}

export interface LoadedAmazonWorkspace {
  meta: AmazonSheetMeta;
  records: AmazonOrderRecord[];
  existingIds: Set<string>;
  existingDuplicateKeys: Set<string>;
  existingFileNames: Set<string>;
}

export async function fetchAmazonLedger(
  accessToken: string,
  spreadsheetId: string = AMAZON_SPREADSHEET_ID
): Promise<LoadedAmazonWorkspace> {
  const metaResp = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=properties.title,sheets.properties`,
    accessToken
  );

  const spreadsheetTitle = metaResp.properties?.title || 'Amazon_Ledger';
  const sheetTitles =
    metaResp.sheets?.map((s) => s.properties?.title).filter((t): t is string => Boolean(t)) ?? [];

  const exactTab = sheetTitles.find((t) => normalizeHeaderKey(t) === 'amzorders');
  const matchedTab =
    exactTab ??
    sheetTitles.find((t) => normalizeHeaderKey(t).includes('amzorder')) ??
    sheetTitles.find((t) => normalizeHeaderKey(t).includes('amazon'));

  const ledgerTabName = matchedTab || AMAZON_DEFAULT_TAB;
  const ledgerTabExists = Boolean(matchedTab);

  let rows: Array<Array<string | number>> = [];
  if (ledgerTabExists) {
    const safeTab = `'${ledgerTabName.replace(/'/g, "''")}'`;
    const encodedRange = encodeURIComponent(`${safeTab}!A:Z`);
    const valuesResp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodedRange}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      accessToken
    );
    rows = valuesResp.values ?? [];
  }

  let needsHeader = true;
  let columnHeaders: string[] = [...CANONICAL_AMAZON_HEADERS];

  if (rows.length > 0) {
    const firstRow = rows[0].map((c) => String(c ?? '').trim());
    const hasHeaderSignature = firstRow.some((cell) => {
      const k = normalizeHeaderKey(cell);
      return (
        k === 'uniqueid' ||
        k === 'ordernumber' ||
        k === 'order' ||
        k === 'orderdate' ||
        k === 'itemdescription'
      );
    });
    if (hasHeaderSignature) {
      needsHeader = false;
      columnHeaders = firstRow.map((h, i) => h || `Column_${i + 1}`);
    }
  }

  const fieldIdx = buildAmazonFieldMap(columnHeaders);
  let nextExtraIdx = Math.max(columnHeaders.length, 10);

  const hasIsReconHeader = needsHeader ? true : fieldIdx.has('isRecon');
  const isReconColIndex =
    fieldIdx.get('isRecon') ?? (needsHeader ? 10 : nextExtraIdx++);

  const hasCategoryHeader = needsHeader ? true : fieldIdx.has('category');
  const categoryColIndex =
    fieldIdx.get('category') ?? (needsHeader ? 11 : nextExtraIdx++);

  const hasExpIdHeader = needsHeader ? true : fieldIdx.has('expId');
  const expIdColIndex =
    fieldIdx.get('expId') ?? (needsHeader ? 12 : nextExtraIdx++);

  const hasBankIdHeader = needsHeader ? true : fieldIdx.has('bankId');
  const bankIdColIndex =
    fieldIdx.get('bankId') ?? (needsHeader ? 13 : nextExtraIdx++);

  const hasSourceFileHeader = needsHeader ? true : fieldIdx.has('sourceFileName');
  const sourceFileColIndex =
    fieldIdx.get('sourceFileName') ?? (needsHeader ? 14 : nextExtraIdx++);

  const startRowIdx = needsHeader ? 0 : 1;
  const records: AmazonOrderRecord[] = [];
  const existingIds = new Set<string>();
  const existingDuplicateKeys = new Set<string>();
  const existingFileNames = new Set<string>();

  for (let i = startRowIdx; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((cell) => String(cell ?? '').trim() === '')) {
      continue;
    }

    const readStr = (field: AmazonFieldKey, fallbackIdx: number): string => {
      const idx = fieldIdx.get(field) ?? fallbackIdx;
      return String(row[idx] ?? '').trim();
    };

    const rawUniqueId = readStr('uniqueId', 0);
    const orderNumber = readStr('orderNumber', 1);
    const rawOrderDate = readStr('orderDate', 2);
    const orderDate = normalizeAmazonDate(rawOrderDate);

    const qtyIdx = fieldIdx.get('quantity') ?? 3;
    const rawQty = parseOptionalAmazonNumber(row[qtyIdx], 0);
    const quantity = rawQty !== null && rawQty > 0 ? rawQty : null;

    const itemDescription = readStr('itemDescription', 4);
    const itemPrice = parseOptionalAmazonNumber(row[fieldIdx.get('itemPrice') ?? 5], 2);
    const total = parseOptionalAmazonNumber(row[fieldIdx.get('total') ?? 6], 2);
    const shippedTo = readStr('shippedTo', 7);
    const paymentMethod = normalizeAmazonPaymentMethod(readStr('paymentMethod', 8));
    const status: AmazonOrderStatus = normalizeAmazonStatus(readStr('status', 9));

    if (
      !rawUniqueId &&
      !orderNumber &&
      !itemDescription &&
      itemPrice === null &&
      total === null
    ) {
      continue;
    }

    const rawIsRecon = hasIsReconHeader
      ? String(row[isReconColIndex] ?? '').trim()
      : '';
    const isRecon: 'Yes' | 'No' =
      rawIsRecon !== '' ? normalizeIsRecon(rawIsRecon) : 'No';
    const category = hasCategoryHeader
      ? String(row[categoryColIndex] ?? '').trim()
      : '';
    const expId = hasExpIdHeader
      ? String(row[expIdColIndex] ?? '').trim()
      : '';
    const bankId = hasBankIdHeader
      ? String(row[bankIdColIndex] ?? '').trim()
      : '';
    const sourceFileName = hasSourceFileHeader
      ? String(row[sourceFileColIndex] ?? '').trim()
      : '';

    const keyArgs = {
      orderNumber,
      orderDate,
      quantity,
      itemDescription,
      itemPrice,
      status,
    };
    const deterministicId = buildAmazonUniqueId(keyArgs);
    const uniqueId = rawUniqueId || deterministicId;
    const duplicateKey = buildAmazonDuplicateKey(keyArgs);

    existingIds.add(uniqueId);
    existingIds.add(deterministicId);
    existingDuplicateKeys.add(duplicateKey);
    if (sourceFileName && sourceFileName !== 'Manual Amazon Order Entry') {
      existingFileNames.add(sourceFileName);
    }

    records.push({
      rowKey: `sheet-amazon-${i + 1}-${uniqueId}`,
      uniqueId,
      duplicateKey,
      orderNumber,
      orderDate,
      quantity,
      itemDescription,
      itemPrice,
      total,
      shippedTo,
      paymentMethod,
      status,
      isRecon,
      category,
      expId,
      bankId,
      sourceOrigin: 'sheet',
      sourceFileName: sourceFileName || undefined,
      sheetRowNumber: i + 1,
      rawRowValues: row,
    });
  }

  return {
    meta: {
      spreadsheetId,
      spreadsheetTitle,
      ledgerTabName,
      ledgerTabExists,
      needsHeader,
      hasIsReconHeader,
      hasCategoryHeader,
      hasExpIdHeader,
      hasBankIdHeader,
      hasSourceFileHeader,
      isReconColIndex,
      categoryColIndex,
      expIdColIndex,
      bankIdColIndex,
      sourceFileColIndex,
      columnHeaders,
    },
    records,
    existingIds,
    existingDuplicateKeys,
    existingFileNames,
  };
}

export async function ensureAmazonExtraHeaders(
  accessToken: string,
  meta: AmazonSheetMeta
): Promise<AmazonSheetMeta> {
  if (!meta.ledgerTabExists || meta.needsHeader) return meta;
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const data: Array<{ range: string; values: string[][] }> = [];

  if (!meta.hasIsReconHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.isReconColIndex)}1`,
      values: [['Is_Recon']],
    });
  }
  if (!meta.hasCategoryHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.categoryColIndex)}1`,
      values: [['Category']],
    });
  }
  if (!meta.hasExpIdHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.expIdColIndex)}1`,
      values: [['Exp_ID']],
    });
  }
  if (!meta.hasBankIdHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.bankIdColIndex)}1`,
      values: [['Bank_ID']],
    });
  }
  if (!meta.hasSourceFileHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.sourceFileColIndex)}1`,
      values: [['Source File']],
    });
  }

  if (data.length === 0) return meta;

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}/values:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data,
      }),
    }
  );

  const nextHeaders = [...meta.columnHeaders];
  while (
    nextHeaders.length <=
    Math.max(
      meta.isReconColIndex,
      meta.categoryColIndex,
      meta.expIdColIndex,
      meta.bankIdColIndex,
      meta.sourceFileColIndex
    )
  ) {
    nextHeaders.push('');
  }
  if (!meta.hasIsReconHeader) nextHeaders[meta.isReconColIndex] = 'Is_Recon';
  if (!meta.hasCategoryHeader) nextHeaders[meta.categoryColIndex] = 'Category';
  if (!meta.hasExpIdHeader) nextHeaders[meta.expIdColIndex] = 'Exp_ID';
  if (!meta.hasBankIdHeader) nextHeaders[meta.bankIdColIndex] = 'Bank_ID';
  if (!meta.hasSourceFileHeader) nextHeaders[meta.sourceFileColIndex] = 'Source File';

  return {
    ...meta,
    hasIsReconHeader: true,
    hasCategoryHeader: true,
    hasExpIdHeader: true,
    hasBankIdHeader: true,
    hasSourceFileHeader: true,
    columnHeaders: nextHeaders,
  };
}

export async function prepareAmazonSyncPlan(
  accessToken: string,
  spreadsheetId: string,
  candidateOrders: AmazonOrderRecord[]
): Promise<{ plan: AmazonSyncPlan; workspace: LoadedAmazonWorkspace }> {
  const workspace = await fetchAmazonLedger(accessToken, spreadsheetId);
  const seenIds = new Set<string>(workspace.existingIds);

  const toAppend: AmazonOrderRecord[] = [];
  let skippedDuplicatesCount = 0;

  for (const order of candidateOrders) {
    const trimmedFileName = (order.sourceFileName ?? '').trim();
    const isManual = trimmedFileName === 'Manual Amazon Order Entry';
    if (
      order.isDuplicate ||
      (trimmedFileName && !isManual && workspace.existingFileNames.has(trimmedFileName))
    ) {
      skippedDuplicatesCount++;
      continue;
    }

    let nextUniqueId = order.uniqueId;
    let occurrenceIndex = 0;
    while (!nextUniqueId || seenIds.has(nextUniqueId)) {
      occurrenceIndex++;
      nextUniqueId = buildAmazonUniqueId({
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        quantity: order.quantity,
        itemDescription: order.itemDescription,
        itemPrice: order.itemPrice,
        status: order.status,
        occurrenceIndex,
      });
    }

    seenIds.add(nextUniqueId);
    toAppend.push(
      nextUniqueId === order.uniqueId
        ? order
        : {
            ...order,
            uniqueId: nextUniqueId,
          }
    );
  }

  return {
    plan: {
      meta: workspace.meta,
      existingIdsCount: workspace.existingIds.size,
      toAppend,
      skippedDuplicatesCount,
    },
    workspace,
  };
}

export async function executeAmazonSyncPlan(
  accessToken: string,
  plan: AmazonSyncPlan
): Promise<AmazonSyncResult> {
  const { meta, toAppend, skippedDuplicatesCount } = plan;

  if (!meta.ledgerTabExists) {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: meta.ledgerTabName,
                },
              },
            },
          ],
        }),
      }
    );
  } else {
    await ensureAmazonExtraHeaders(accessToken, meta);
  }

  const rowsToWrite: Array<Array<string | number>> = [];
  if (meta.needsHeader) {
    rowsToWrite.push([...CANONICAL_AMAZON_HEADERS]);
  }

  for (const order of toAppend) {
    rowsToWrite.push(serializeAmazonRow(order, meta));
  }

  if (rowsToWrite.length > 0) {
    const CHUNK_SIZE = 500;
    const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
    const range = encodeURIComponent(`${safeTab}!A1`);

    for (let i = 0; i < rowsToWrite.length; i += CHUNK_SIZE) {
      const chunk = rowsToWrite.slice(i, i + CHUNK_SIZE);
      await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          meta.spreadsheetId
        )}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            majorDimension: 'ROWS',
            values: chunk,
          }),
        }
      );
    }
  }

  return {
    tabName: meta.ledgerTabName,
    spreadsheetId: meta.spreadsheetId,
    appendedCount: toAppend.length,
    skippedCount: skippedDuplicatesCount,
    syncedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

export async function updateAmazonRecord(
  accessToken: string,
  meta: AmazonSheetMeta,
  record: AmazonOrderRecord
): Promise<void> {
  if (!record.sheetRowNumber || record.sheetRowNumber < 1) {
    throw new Error('Cannot update an Amazon order record that has not been saved to Google Sheets.');
  }

  await ensureAmazonExtraHeaders(accessToken, meta);

  const serializedRow = serializeAmazonRow(record, meta);
  const endCol = colIndexToA1(
    Math.max(
      serializedRow.length,
      meta.columnHeaders.length,
      meta.isReconColIndex + 1,
      meta.categoryColIndex + 1,
      meta.expIdColIndex + 1,
      meta.bankIdColIndex + 1,
      meta.sourceFileColIndex + 1
    ) - 1
  );
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(
    `${safeTab}!A${record.sheetRowNumber}:${endCol}${record.sheetRowNumber}`
  );

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}/values/${range}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [serializedRow],
      }),
    }
  );
}

export async function batchUpdateAmazonUniqueIds(
  accessToken: string,
  meta: AmazonSheetMeta,
  updates: Array<{ sheetRowNumber: number; uniqueId: string }>
): Promise<number> {
  if (updates.length === 0) return 0;
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const fieldIdx = buildAmazonFieldMap(meta.columnHeaders);
  const uniqueIdColA1 = colIndexToA1(fieldIdx.get('uniqueId') ?? 0);

  const CHUNK_SIZE = 200;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: chunk.map((u) => ({
            range: `${safeTab}!${uniqueIdColA1}${u.sheetRowNumber}`,
            values: [[u.uniqueId]],
          })),
        }),
      }
    );
  }
  return updates.length;
}

export async function updateAmazonIsRecon(
  accessToken: string,
  meta: AmazonSheetMeta,
  sheetRowNumber: number,
  isRecon: 'Yes' | 'No'
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Is_Recon for an unsaved Amazon order record.');
  }

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const colA1 = colIndexToA1(meta.isReconColIndex);
  const range = encodeURIComponent(`${safeTab}!${colA1}${sheetRowNumber}`);

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}/values/${range}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [[isRecon]],
      }),
    }
  );
}

export async function updateAmazonCategory(
  accessToken: string,
  meta: AmazonSheetMeta,
  sheetRowNumber: number,
  category: string
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Category for an unsaved Amazon order record.');
  }

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const colA1 = colIndexToA1(meta.categoryColIndex);
  const range = encodeURIComponent(`${safeTab}!${colA1}${sheetRowNumber}`);

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}/values/${range}?valueInputOption=RAW`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [[category]],
      }),
    }
  );
}

export async function batchUpdateAmazonCategories(
  accessToken: string,
  meta: AmazonSheetMeta,
  updates: Array<{ sheetRowNumber: number; category: string }>
): Promise<number> {
  const validUpdates = updates.filter(
    (u) => Number.isFinite(u.sheetRowNumber) && u.sheetRowNumber >= 1
  );
  if (validUpdates.length === 0) return 0;

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const colA1 = colIndexToA1(meta.categoryColIndex);

  const CHUNK_SIZE = 200;
  for (let i = 0; i < validUpdates.length; i += CHUNK_SIZE) {
    const chunk = validUpdates.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: chunk.map((u) => ({
            range: `${safeTab}!${colA1}${u.sheetRowNumber}`,
            values: [[u.category.trim()]],
          })),
        }),
      }
    );
  }

  return validUpdates.length;
}

export async function updateAmazonExpId(
  accessToken: string,
  meta: AmazonSheetMeta,
  sheetRowNumber: number,
  expId: string
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Exp_ID for an unsaved Amazon order record.');
  }

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const colA1 = colIndexToA1(meta.expIdColIndex);
  const range = encodeURIComponent(`${safeTab}!${colA1}${sheetRowNumber}`);

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}/values/${range}?valueInputOption=RAW`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [[expId.trim()]],
      }),
    }
  );
}

export async function batchUpdateAmazonExpIds(
  accessToken: string,
  meta: AmazonSheetMeta,
  updates: Array<{ sheetRowNumber: number; expId: string }>
): Promise<number> {
  const validUpdates = updates.filter(
    (u) => Number.isFinite(u.sheetRowNumber) && u.sheetRowNumber >= 1
  );
  if (validUpdates.length === 0) return 0;

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const colA1 = colIndexToA1(meta.expIdColIndex);

  const CHUNK_SIZE = 200;
  for (let i = 0; i < validUpdates.length; i += CHUNK_SIZE) {
    const chunk = validUpdates.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: chunk.map((u) => ({
            range: `${safeTab}!${colA1}${u.sheetRowNumber}`,
            values: [[u.expId.trim()]],
          })),
        }),
      }
    );
  }

  return validUpdates.length;
}

export async function updateAmazonBankId(
  accessToken: string,
  meta: AmazonSheetMeta,
  sheetRowNumber: number,
  bankId: string
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Bank_ID for an unsaved Amazon order record.');
  }

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const colA1 = colIndexToA1(meta.bankIdColIndex);
  const range = encodeURIComponent(`${safeTab}!${colA1}${sheetRowNumber}`);

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}/values/${range}?valueInputOption=RAW`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [[bankId.trim()]],
      }),
    }
  );
}

export async function batchUpdateAmazonBankRecon(
  accessToken: string,
  meta: AmazonSheetMeta,
  updates: Array<{ sheetRowNumber: number; bankId: string; isRecon: 'Yes' | 'No' }>
): Promise<number> {
  const validUpdates = updates.filter(
    (u) => Number.isFinite(u.sheetRowNumber) && u.sheetRowNumber >= 1
  );
  if (validUpdates.length === 0) return 0;

  await ensureAmazonExtraHeaders(accessToken, meta);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const bankColA1 = colIndexToA1(meta.bankIdColIndex);
  const isReconColA1 = colIndexToA1(meta.isReconColIndex);

  const CHUNK_SIZE = 100;
  for (let i = 0; i < validUpdates.length; i += CHUNK_SIZE) {
    const chunk = validUpdates.slice(i, i + CHUNK_SIZE);
    const data: Array<{ range: string; values: string[][] }> = [];
    for (const u of chunk) {
      data.push({
        range: `${safeTab}!${bankColA1}${u.sheetRowNumber}`,
        values: [[u.bankId.trim()]],
      });
      data.push({
        range: `${safeTab}!${isReconColA1}${u.sheetRowNumber}`,
        values: [[u.isRecon]],
      });
    }
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data,
        }),
      }
    );
  }

  return validUpdates.length;
}

export async function deleteAmazonRows(
  accessToken: string,
  meta: AmazonSheetMeta,
  sheetRowNumbers: number[]
): Promise<number> {
  if (!meta.ledgerTabExists) return 0;

  const minDataRow = meta.needsHeader ? 1 : 2;
  const uniqueRowsDesc = Array.from(
    new Set(
      sheetRowNumbers.filter((n) => Number.isInteger(n) && n >= minDataRow)
    )
  ).sort((a, b) => b - a);

  if (uniqueRowsDesc.length === 0) return 0;

  const metaResp = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId
    )}?fields=sheets.properties`,
    accessToken
  );

  const sheetId = metaResp.sheets?.find(
    (s) => s.properties?.title === meta.ledgerTabName
  )?.properties?.sheetId;

  if (sheetId === undefined) {
    throw new Error(`Tab "${meta.ledgerTabName}" was not found in Amazon_Ledger.`);
  }

  // Group contiguous row numbers into descending ranges so bottom-up deletion keeps earlier indices valid
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let rangeEndRow = uniqueRowsDesc[0];
  let rangeStartRow = uniqueRowsDesc[0];

  for (let i = 1; i < uniqueRowsDesc.length; i++) {
    const rowNum = uniqueRowsDesc[i];
    if (rowNum === rangeStartRow - 1) {
      rangeStartRow = rowNum;
    } else {
      ranges.push({
        startIndex: rangeStartRow - 1,
        endIndex: rangeEndRow,
      });
      rangeEndRow = rowNum;
      rangeStartRow = rowNum;
    }
  }
  ranges.push({
    startIndex: rangeStartRow - 1,
    endIndex: rangeEndRow,
  });

  const requests = ranges.map((r) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: r.startIndex,
        endIndex: r.endIndex,
      },
    },
  }));

  const CHUNK_SIZE = 500;
  for (let i = 0; i < requests.length; i += CHUNK_SIZE) {
    const chunk = requests.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ requests: chunk }),
      }
    );
  }

  return uniqueRowsDesc.length;
}

