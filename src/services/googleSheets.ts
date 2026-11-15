import {
  AccountType,
  NormalizedTransaction,
  SyncPlan,
  SyncResult,
} from '../types/statement';

export const TARGET_SPREADSHEET_ID = '14lgrbcSnwPGu1nJei2_ndru9Qp0HzQwNR4mhUX6xY7s';

export const SHEET_HEADERS = [
  'Unique Transaction ID',
  'Date',
  'Amount',
  'Transaction Type',
  'Description',
  'Reference #',
  'Source',
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

  if (tabExists) {
    const range = encodeURIComponent(`${tabName}!A:A`);
    const valuesResp = await sheetsFetch<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${range}`,
      accessToken
    );

    const colA = valuesResp.values ?? [];
    if (colA.length > 0 && colA[0]?.[0]?.trim()) {
      const firstCell = colA[0][0].trim().toLowerCase();
      needsHeader =
        firstCell !== 'unique transaction id' && firstCell !== 'unique_transaction_id';
      for (const row of colA) {
        const val = row[0]?.trim();
        if (val && val.toLowerCase() !== 'unique transaction id') {
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
  const { spreadsheetId, tabName, tabExists, needsHeader, toAppend, skippedAlreadySynced } =
    plan;

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
  }

  const rowsToWrite: Array<Array<string | number>> = [];
  if (needsHeader) {
    rowsToWrite.push([...SHEET_HEADERS]);
  }

  for (const tx of toAppend) {
    rowsToWrite.push([
      tx.uniqueId,
      tx.date,
      tx.amount,
      tx.transactionType,
      tx.description,
      tx.referenceNumber,
      tx.source,
    ]);
  }

  if (rowsToWrite.length > 0) {
    const CHUNK_SIZE = 500;
    const range = encodeURIComponent(`${tabName}!A1`);

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
