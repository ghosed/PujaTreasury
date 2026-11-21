import {
  CheckRecord,
  CheckSheetMeta,
  CheckSyncPlan,
  CheckSyncResult,
  CheckTransactionType,
} from '../types/check';
import {
  buildCheckCanonicalKey,
  buildCheckRoutingKey,
  buildCheckUniqueId,
  deriveCheckTransactionType,
  normalizeCheckDate,
  normalizeRoutingNumber,
} from '../utils/checkProcessor';
import { SheetsApiError } from './googleSheets';
import { parseSignedAmount } from '../utils/statementProcessor';

export const CHECK_SPREADSHEET_ID = '1QsvwQevsqxk6f-9l-UKt1OUUjTScn116nI1VJQ31smc';

export const CANONICAL_CHECK_HEADERS = [
  'Unique ID',
  'Check Number',
  'Bank',
  'Date',
  'Amount',
  'Paid To',
  'Paid By',
  'Memo / For',
  'Transaction Type',
  'Is_Recon',
  'Routing Number',
  'Category',
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

type CheckFieldKey =
  | 'uniqueId'
  | 'checkNumber'
  | 'bank'
  | 'date'
  | 'amount'
  | 'paidTo'
  | 'paidBy'
  | 'memo'
  | 'transactionType'
  | 'isRecon'
  | 'routingNumber'
  | 'category';

const HEADER_TO_CHECK_FIELD: Record<string, CheckFieldKey> = {
  uniqueid: 'uniqueId',
  uniquetransactionid: 'uniqueId',
  checkid: 'uniqueId',
  id: 'uniqueId',
  checknumber: 'checkNumber',
  checkno: 'checkNumber',
  checknum: 'checkNumber',
  check: 'checkNumber',
  bank: 'bank',
  bankname: 'bank',
  date: 'date',
  checkdate: 'date',
  amount: 'amount',
  paidto: 'paidTo',
  payee: 'paidTo',
  payto: 'paidTo',
  paidby: 'paidBy',
  payer: 'paidBy',
  payor: 'paidBy',
  memo: 'memo',
  memofor: 'memo',
  for: 'memo',
  notes: 'memo',
  transactiontype: 'transactionType',
  type: 'transactionType',
  isrecon: 'isRecon',
  routingnumber: 'routingNumber',
  micrroutingnumber: 'routingNumber',
  micrrouting: 'routingNumber',
  routing: 'routingNumber',
  rtn: 'routingNumber',
  abarouting: 'routingNumber',
  category: 'category',
  cat: 'category',
};

function buildCheckFieldMap(headers: string[]): Map<CheckFieldKey, number> {
  const map = new Map<CheckFieldKey, number>();
  headers.forEach((header, idx) => {
    const norm = normalizeHeaderKey(header);
    const field = HEADER_TO_CHECK_FIELD[norm];
    if (field && !map.has(field)) {
      map.set(field, idx);
    }
  });
  return map;
}

function serializeCheckRow(
  record: CheckRecord,
  meta: Pick<
    CheckSheetMeta,
    | 'columnHeaders'
    | 'transactionTypeColIndex'
    | 'isReconColIndex'
    | 'routingNumberColIndex'
    | 'categoryColIndex'
  >
): Array<string | number> {
  const fieldToIdx = buildCheckFieldMap(meta.columnHeaders);
  const length = Math.max(
    meta.columnHeaders.length,
    CANONICAL_CHECK_HEADERS.length,
    meta.transactionTypeColIndex + 1,
    meta.isReconColIndex + 1,
    meta.routingNumberColIndex + 1,
    meta.categoryColIndex + 1
  );
  const row: Array<string | number> = record.rawRowValues
    ? [...record.rawRowValues]
    : new Array(length).fill('');

  while (row.length < length) {
    row.push('');
  }

  const setField = (field: CheckFieldKey, val: string | number, fallbackIdx: number) => {
    const idx = fieldToIdx.get(field) ?? fallbackIdx;
    row[idx] = val;
  };

  // Column A (index 0) is always Unique ID unless mapped elsewhere
  setField('uniqueId', record.uniqueId, 0);
  setField('checkNumber', record.checkNumber, 1);
  setField('bank', record.bank, 2);
  setField('date', record.date, 3);
  setField('amount', Number(record.amount.toFixed(2)), 4);
  setField('paidTo', record.paidTo, 5);
  setField('paidBy', record.paidBy, 6);
  setField('memo', record.memo, 7);
  setField('transactionType', record.transactionType, meta.transactionTypeColIndex);
  setField('isRecon', record.isRecon || 'No', meta.isReconColIndex);
  setField('routingNumber', record.routingNumber || '', meta.routingNumberColIndex);
  setField('category', record.category || '', meta.categoryColIndex);

  return row;
}

export interface LoadedCheckWorkspace {
  meta: CheckSheetMeta;
  records: CheckRecord[];
  existingIds: Set<string>;
  existingCanonicalKeys: Set<string>;
}

export async function fetchCheckLedger(
  accessToken: string,
  spreadsheetId: string = CHECK_SPREADSHEET_ID
): Promise<LoadedCheckWorkspace> {
  const metaResp = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=properties.title,sheets.properties`,
    accessToken
  );

  const spreadsheetTitle = metaResp.properties?.title || 'Check_Ledger';
  const sheetTitles =
    metaResp.sheets?.map((s) => s.properties?.title).filter((t): t is string => Boolean(t)) ?? [];

  const exactTab = sheetTitles.find((t) => {
    const k = normalizeHeaderKey(t);
    return k === 'checkledger' || k === 'checks' || k === 'check';
  });
  const matchedTab =
    exactTab ??
    sheetTitles.find((t) => normalizeHeaderKey(t).includes('check')) ??
    sheetTitles[0];

  const ledgerTabName = matchedTab || 'Check_Ledger';
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
  let columnHeaders: string[] = [...CANONICAL_CHECK_HEADERS];

  if (rows.length > 0) {
    const firstRow = rows[0].map((c) => String(c ?? '').trim());
    const hasHeaderSignature = firstRow.some((cell) => {
      const k = normalizeHeaderKey(cell);
      return (
        k === 'uniqueid' ||
        k === 'checknumber' ||
        k === 'checkno' ||
        k === 'paidto' ||
        k === 'paidby'
      );
    });
    if (hasHeaderSignature) {
      needsHeader = false;
      columnHeaders = firstRow.map((h, i) => h || `Column_${i + 1}`);
    }
  }

  const fieldIdx = buildCheckFieldMap(columnHeaders);
  let nextExtraIdx = Math.max(columnHeaders.length, 8);

  const hasTransactionTypeHeader = needsHeader ? true : fieldIdx.has('transactionType');
  const transactionTypeColIndex =
    fieldIdx.get('transactionType') ?? (needsHeader ? 8 : nextExtraIdx++);

  const hasIsReconHeader = needsHeader ? true : fieldIdx.has('isRecon');
  const isReconColIndex =
    fieldIdx.get('isRecon') ?? (needsHeader ? 9 : nextExtraIdx++);

  const hasRoutingNumberHeader = needsHeader ? true : fieldIdx.has('routingNumber');
  const routingNumberColIndex =
    fieldIdx.get('routingNumber') ?? (needsHeader ? 10 : nextExtraIdx++);

  const hasCategoryHeader = needsHeader ? true : fieldIdx.has('category');
  const categoryColIndex =
    fieldIdx.get('category') ?? (needsHeader ? 11 : nextExtraIdx++);

  const startRowIdx = needsHeader ? 0 : 1;
  const records: CheckRecord[] = [];
  const existingIds = new Set<string>();
  const existingCanonicalKeys = new Set<string>();

  for (let i = startRowIdx; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((cell) => String(cell ?? '').trim() === '')) {
      continue;
    }

    const readStr = (field: CheckFieldKey, fallbackIdx: number): string => {
      const idx = fieldIdx.get(field) ?? fallbackIdx;
      return String(row[idx] ?? '').trim();
    };

    const rawUniqueId = readStr('uniqueId', 0);
    const checkNumber = readStr('checkNumber', 1);
    const bank = readStr('bank', 2);
    const rawDate = readStr('date', 3);
    const date = normalizeCheckDate(rawDate);

    const amountIdx = fieldIdx.get('amount') ?? 4;
    const rawAmount = row[amountIdx];
    let amount: number | null = null;
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) {
      amount = Math.abs(rawAmount);
    } else if (rawAmount !== undefined && rawAmount !== null) {
      const parsed = parseSignedAmount(String(rawAmount));
      if (parsed !== null) amount = Math.abs(parsed);
    }

    const paidTo = readStr('paidTo', 5);
    const paidBy = readStr('paidBy', 6);
    const memo = readStr('memo', 7);
    const routingNumber = hasRoutingNumberHeader
      ? normalizeRoutingNumber(String(row[routingNumberColIndex] ?? ''))
      : '';

    if (!rawUniqueId && !checkNumber && !paidTo && !paidBy && amount === null) {
      continue;
    }

    const rawType = hasTransactionTypeHeader
      ? String(row[transactionTypeColIndex] ?? '').trim()
      : '';
    const transactionType: CheckTransactionType =
      rawType === 'Income' || rawType === 'Expense'
        ? rawType
        : deriveCheckTransactionType(paidBy);

    const rawIsRecon = hasIsReconHeader
      ? String(row[isReconColIndex] ?? '').trim()
      : '';
    const isRecon: 'Yes' | 'No' =
      rawIsRecon !== '' ? normalizeIsRecon(rawIsRecon) : 'No';
    const category = hasCategoryHeader
      ? String(row[categoryColIndex] ?? '').trim()
      : '';

    const deterministicId = buildCheckUniqueId(checkNumber, routingNumber, date, bank);
    const uniqueId = rawUniqueId || deterministicId;
    const canonicalKey = buildCheckCanonicalKey(checkNumber, bank, date);
    const routingKey = buildCheckRoutingKey(checkNumber, routingNumber, date);

    existingIds.add(uniqueId.toLowerCase());
    existingIds.add(deterministicId.toLowerCase());
    existingCanonicalKeys.add(canonicalKey);
    if (routingKey) {
      existingCanonicalKeys.add(routingKey);
    }

    const safeAmount = amount ?? 0;
    const amountCents = Math.round(safeAmount * 100);

    records.push({
      rowKey: `sheet-check-${i + 1}-${uniqueId}`,
      uniqueId,
      canonicalKey,
      routingKey,
      checkNumber,
      routingNumber,
      bank,
      date,
      amount: amountCents / 100,
      amountCents,
      paidTo,
      paidBy,
      memo,
      transactionType,
      isRecon,
      category,
      sourceOrigin: 'sheet',
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
      hasTransactionTypeHeader,
      hasIsReconHeader,
      hasRoutingNumberHeader,
      hasCategoryHeader,
      transactionTypeColIndex,
      isReconColIndex,
      routingNumberColIndex,
      categoryColIndex,
      columnHeaders,
    },
    records,
    existingIds,
    existingCanonicalKeys,
  };
}

async function ensureCheckExtraHeaders(
  accessToken: string,
  meta: CheckSheetMeta
): Promise<void> {
  if (!meta.ledgerTabExists || meta.needsHeader) return;
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const data: Array<{ range: string; values: string[][] }> = [];

  if (!meta.hasTransactionTypeHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.transactionTypeColIndex)}1`,
      values: [['Transaction Type']],
    });
  }
  if (!meta.hasIsReconHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.isReconColIndex)}1`,
      values: [['Is_Recon']],
    });
  }
  if (!meta.hasRoutingNumberHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.routingNumberColIndex)}1`,
      values: [['Routing Number']],
    });
  }
  if (!meta.hasCategoryHeader) {
    data.push({
      range: `${safeTab}!${colIndexToA1(meta.categoryColIndex)}1`,
      values: [['Category']],
    });
  }

  if (data.length === 0) return;

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
}

export async function prepareCheckSyncPlan(
  accessToken: string,
  spreadsheetId: string,
  candidateChecks: CheckRecord[]
): Promise<{ plan: CheckSyncPlan; workspace: LoadedCheckWorkspace }> {
  const workspace = await fetchCheckLedger(accessToken, spreadsheetId);
  const seenIds = new Set<string>(workspace.existingIds);
  const seenKeys = new Set<string>(workspace.existingCanonicalKeys);

  const toAppend: CheckRecord[] = [];
  let skippedDuplicatesCount = 0;

  for (const chk of candidateChecks) {
    const idLower = chk.uniqueId.toLowerCase();
    const rKey = chk.routingKey || buildCheckRoutingKey(chk.checkNumber, chk.routingNumber, chk.date);
    if (
      seenIds.has(idLower) ||
      seenKeys.has(chk.canonicalKey) ||
      (Boolean(rKey) && seenKeys.has(rKey))
    ) {
      skippedDuplicatesCount++;
      continue;
    }
    seenIds.add(idLower);
    seenKeys.add(chk.canonicalKey);
    if (rKey) {
      seenKeys.add(rKey);
    }
    toAppend.push(chk);
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

export async function executeCheckSyncPlan(
  accessToken: string,
  plan: CheckSyncPlan
): Promise<CheckSyncResult> {
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
    await ensureCheckExtraHeaders(accessToken, meta);
  }

  const rowsToWrite: Array<Array<string | number>> = [];
  if (meta.needsHeader) {
    rowsToWrite.push([...CANONICAL_CHECK_HEADERS]);
  }

  for (const chk of toAppend) {
    rowsToWrite.push(serializeCheckRow(chk, meta));
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

export async function updateCheckRecord(
  accessToken: string,
  meta: CheckSheetMeta,
  record: CheckRecord
): Promise<void> {
  if (!record.sheetRowNumber || record.sheetRowNumber < 1) {
    throw new Error('Cannot update a check record that has not been saved to Google Sheets.');
  }

  await ensureCheckExtraHeaders(accessToken, meta);

  const serializedRow = serializeCheckRow(record, meta);
  const endCol = colIndexToA1(
    Math.max(
      serializedRow.length,
      meta.columnHeaders.length,
      meta.transactionTypeColIndex + 1,
      meta.isReconColIndex + 1,
      meta.routingNumberColIndex + 1,
      meta.categoryColIndex + 1
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

export async function batchUpdateCheckUniqueIds(
  accessToken: string,
  meta: CheckSheetMeta,
  updates: Array<{ sheetRowNumber: number; uniqueId: string }>
): Promise<number> {
  if (updates.length === 0) return 0;
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const fieldIdx = buildCheckFieldMap(meta.columnHeaders);
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
          valueInputOption: 'USER_ENTERED',
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

export async function updateCheckIsRecon(
  accessToken: string,
  meta: CheckSheetMeta,
  sheetRowNumber: number,
  isRecon: 'Yes' | 'No'
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Is_Recon for an unsaved check record.');
  }

  await ensureCheckExtraHeaders(accessToken, meta);
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

export async function updateCheckCategory(
  accessToken: string,
  meta: CheckSheetMeta,
  sheetRowNumber: number,
  category: string
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Category for an unsaved check record.');
  }

  await ensureCheckExtraHeaders(accessToken, meta);
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

export async function batchUpdateCheckCategories(
  accessToken: string,
  meta: CheckSheetMeta,
  updates: Array<{ sheetRowNumber: number; category: string }>
): Promise<number> {
  const validUpdates = updates.filter(
    (u) => Number.isFinite(u.sheetRowNumber) && u.sheetRowNumber >= 1
  );
  if (validUpdates.length === 0) return 0;

  await ensureCheckExtraHeaders(accessToken, meta);
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
