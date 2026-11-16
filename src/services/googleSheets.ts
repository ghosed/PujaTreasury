import {
  AccountType,
  NormalizedTransaction,
  SyncPlan,
  SyncResult,
  TransactionType,
} from '../types/statement';
import {
  categorizeSource,
  normalizeDate,
  parseSignedAmount,
} from '../utils/statementProcessor';

export const TARGET_SPREADSHEET_ID = '14lgrbcSnwPGu1nJei2_ndru9Qp0HzQwNR4mhUX6xY7s';

export const SHEET_HEADERS = [
  'Unique Transaction ID',
  'Date',
  'Amount',
  'Transaction Type',
  'Description',
  'Reference #',
  'Source',
  'Target ID',
] as const;

export class SheetsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SheetsApiError';
    this.status = status;
  }
}

interface SpreadsheetMetadata {
  properties?: { title?: string };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
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

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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

export interface LoadedSheetLedger {
  spreadsheetTitle: string;
  tabExists: boolean;
  hasTargetIdHeader: boolean;
  targetIdColIndex: number;
  transactions: NormalizedTransaction[];
  existingIds: Set<string>;
}

export async function fetchSheetLedger(
  accessToken: string,
  spreadsheetId: string,
  tabName: AccountType
): Promise<LoadedSheetLedger> {
  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=properties.title,sheets.properties`,
    accessToken
  );

  const spreadsheetTitle = meta.properties?.title || 'Bank Statements';
  const existingTabs = meta.sheets?.map((s) => s.properties?.title).filter(Boolean) ?? [];
  const tabExists = existingTabs.includes(tabName);

  const existingIds = new Set<string>();
  const transactions: NormalizedTransaction[] = [];

  if (!tabExists) {
    return {
      spreadsheetTitle,
      tabExists: false,
      hasTargetIdHeader: false,
      targetIdColIndex: 7,
      transactions,
      existingIds,
    };
  }

  const safeTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(`${safeTab}!A:Z`);
  const valuesResp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    accessToken
  );

  const rows = valuesResp.values ?? [];
  let hasHeaderRow = false;
  let hasTargetIdHeader = false;
  let targetIdColIndex = 7;

  if (rows.length > 0) {
    const firstRow = rows[0] ?? [];
    const c0 = normalizeHeader(String(firstRow[0] ?? ''));
    const c1 = normalizeHeader(String(firstRow[1] ?? ''));
    if (c0 === 'uniquetransactionid' || c1 === 'date') {
      hasHeaderRow = true;
      const foundTargetIdx = firstRow.findIndex(
        (cell) => normalizeHeader(String(cell ?? '')) === 'targetid'
      );
      if (foundTargetIdx !== -1) {
        hasTargetIdHeader = true;
        targetIdColIndex = foundTargetIdx;
      } else {
        targetIdColIndex = Math.max(firstRow.length, 7);
      }
    }
  }

  for (let i = hasHeaderRow ? 1 : 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => String(cell ?? '').trim() === '')) {
      continue;
    }

    const col0 = String(row[0] ?? '').trim();
    const col1 = String(row[1] ?? '').trim();

    const normalizedDate = normalizeDate(col1) || col1;
    const rawAmount = row[2];
    let amount: number | null = null;
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) {
      amount = rawAmount;
    } else if (rawAmount !== undefined && rawAmount !== null) {
      amount = parseSignedAmount(String(rawAmount));
    }

    if (!normalizedDate || amount === null) {
      continue;
    }

    const rawType = String(row[3] ?? '').trim();
    const transactionType: TransactionType =
      rawType === 'Income' || rawType === 'Expense'
        ? rawType
        : amount >= 0
          ? 'Income'
          : 'Expense';

    const description = String(row[4] ?? '').trim();
    const referenceNumber = String(row[5] ?? '').trim();
    const rawSource = String(row[6] ?? '').trim();
    const source = rawSource || categorizeSource(description);
    const targetId = String(row[targetIdColIndex] ?? '').trim();
    const uniqueId = col0 || `SHEET-${tabName.toUpperCase()}-${i + 1}`;

    if (col0) {
      existingIds.add(col0);
    }

    transactions.push({
      rowKey: `sheet-${tabName}-${i}-${uniqueId}`,
      flagKey: uniqueId,
      uniqueId,
      date: normalizedDate,
      amount,
      amountCents: Math.round(amount * 100),
      transactionType,
      description,
      referenceNumber,
      source,
      sourceFile: `Google Sheet (${tabName})`,
      occurrenceIndex: 1,
      reviewStatus: 'ok',
      syncStatus: 'already-in-sheet',
      targetId,
      sheetRowNumber: i + 1,
    });
  }

  return {
    spreadsheetTitle,
    tabExists: true,
    hasTargetIdHeader,
    targetIdColIndex,
    transactions,
    existingIds,
  };
}

export async function prepareSyncPlan(
  accessToken: string,
  spreadsheetId: string,
  tabName: AccountType,
  transactions: NormalizedTransaction[]
): Promise<{ plan: SyncPlan; existingIds: Set<string> }> {
  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=properties.title,sheets.properties`,
    accessToken
  );

  const spreadsheetTitle = meta.properties?.title || 'Bank Statements';
  const existingTabs = meta.sheets?.map((s) => s.properties?.title).filter(Boolean) ?? [];
  const tabExists = existingTabs.includes(tabName);

  const existingIds = new Set<string>();
  let needsHeader = true;
  let needsTargetIdHeader = false;
  let targetIdColIndex = 7;

  if (tabExists) {
    const safeTab = `'${tabName.replace(/'/g, "''")}'`;
    const range = encodeURIComponent(`${safeTab}!A:Z`);
    const valuesResp = await sheetsFetch<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${range}`,
      accessToken
    );

    const rows = valuesResp.values ?? [];
    if (rows.length > 0 && rows[0]?.[0]?.trim()) {
      const firstCell = normalizeHeader(rows[0][0]);
      needsHeader = firstCell !== 'uniquetransactionid';

      if (!needsHeader) {
        const foundTargetIdx = rows[0].findIndex(
          (cell) => normalizeHeader(String(cell ?? '')) === 'targetid'
        );
        if (foundTargetIdx !== -1) {
          targetIdColIndex = foundTargetIdx;
          needsTargetIdHeader = false;
        } else {
          targetIdColIndex = Math.max(rows[0].length, 7);
          needsTargetIdHeader = true;
        }
      }

      for (const row of rows) {
        const val = row[0]?.trim();
        if (val && normalizeHeader(val) !== 'uniquetransactionid') {
          existingIds.add(val);
        }
      }
    }
  }

  const unresolvedFlaggedCount = transactions.filter(
    (tx) => tx.reviewStatus === 'flagged-duplicate'
  ).length;

  const eligible = transactions.filter(
    (tx) => tx.reviewStatus === 'ok' || tx.reviewStatus === 'kept-distinct'
  );

  const toAppend: NormalizedTransaction[] = [];
  const skippedAlreadySynced: NormalizedTransaction[] = [];

  for (const tx of eligible) {
    if (existingIds.has(tx.uniqueId)) {
      skippedAlreadySynced.push(tx);
    } else {
      toAppend.push(tx);
    }
  }

  return {
    plan: {
      spreadsheetId,
      spreadsheetTitle,
      tabName,
      tabExists,
      needsHeader,
      needsTargetIdHeader,
      targetIdColIndex,
      existingIdsCount: existingIds.size,
      toAppend,
      skippedAlreadySynced,
      unresolvedFlaggedCount,
    },
    existingIds,
  };
}

export async function executeSyncPlan(
  accessToken: string,
  plan: SyncPlan
): Promise<SyncResult> {
  const {
    spreadsheetId,
    tabName,
    tabExists,
    needsHeader,
    needsTargetIdHeader,
    targetIdColIndex = 7,
    toAppend,
    skippedAlreadySynced,
  } = plan;

  if (!tabExists) {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: tabName,
                },
              },
            },
          ],
        }),
      }
    );
  } else if (!needsHeader && needsTargetIdHeader) {
    const safeTab = `'${tabName.replace(/'/g, "''")}'`;
    const colA1 = colIndexToA1(targetIdColIndex);
    const headerRange = encodeURIComponent(`${safeTab}!${colA1}1`);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${headerRange}?valueInputOption=USER_ENTERED`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({
          majorDimension: 'ROWS',
          values: [['Target ID']],
        }),
      }
    );
  }

  const rowsToWrite: Array<Array<string | number>> = [];
  if (needsHeader) {
    rowsToWrite.push([...SHEET_HEADERS]);
  }

  for (const tx of toAppend) {
    const row: Array<string | number> = [
      tx.uniqueId,
      tx.date,
      tx.amount,
      tx.transactionType,
      tx.description,
      tx.referenceNumber,
      tx.source,
    ];
    while (row.length < targetIdColIndex) {
      row.push('');
    }
    row[targetIdColIndex] = tx.targetId ?? '';
    rowsToWrite.push(row);
  }

  if (rowsToWrite.length > 0) {
    const CHUNK_SIZE = 500;
    const safeTab = `'${tabName.replace(/'/g, "''")}'`;
    const range = encodeURIComponent(`${safeTab}!A1`);

    for (let i = 0; i < rowsToWrite.length; i += CHUNK_SIZE) {
      const chunk = rowsToWrite.slice(i, i + CHUNK_SIZE);
      await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
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
    tabName,
    spreadsheetId,
    appendedCount: toAppend.length,
    skippedCount: skippedAlreadySynced.length,
    syncedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

export interface BankTargetIdUpdate {
  sheetRowNumber: number;
  targetId: string;
}

export async function batchUpdateBankTargetIds(
  accessToken: string,
  spreadsheetId: string,
  tabName: AccountType,
  targetIdColIndex: number,
  ensureTargetIdHeader: boolean,
  updates: BankTargetIdUpdate[]
): Promise<number> {
  const colA1 = colIndexToA1(targetIdColIndex);
  const safeTab = `'${tabName.replace(/'/g, "''")}'`;
  const data: Array<{ range: string; values: string[][] }> = [];

  if (ensureTargetIdHeader) {
    data.push({
      range: `${safeTab}!${colA1}1`,
      values: [['Target ID']],
    });
  }

  for (const upd of updates) {
    if (!upd.sheetRowNumber || upd.sheetRowNumber < 1) continue;
    data.push({
      range: `${safeTab}!${colA1}${upd.sheetRowNumber}`,
      values: [[upd.targetId]],
    });
  }

  if (data.length === 0) return 0;

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
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

  return updates.length;
}
