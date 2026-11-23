import {
  LoadedReconLinks,
  NewReconLinkInput,
  ReconLink,
  ReconLinkMode,
  ReconTargetType,
} from '../types/reconciliation';
import { AccountType } from '../types/statement';
import {
  fromCents,
  generateLinkId,
  reconPairKey,
  toCents,
} from '../utils/reconAllocations';
import { parseSignedAmount } from '../utils/statementProcessor';
import { SheetsApiError, TARGET_SPREADSHEET_ID } from './googleSheets';

export const RECON_LINKS_TAB_NAME = 'Recon_Links';

export const RECON_LINKS_HEADERS = [
  'Link_ID',
  'Bank_Tab',
  'Bank_Unique_ID',
  'Target_Type',
  'Target_ID',
  'Allocated_Amount',
  'Category',
  'Link_Mode',
  'Linked_At',
  'Notes',
] as const;

interface SpreadsheetMetadata {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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
      // keep fallback
    }
    throw new SheetsApiError(errorMessage, res.status);
  }

  return (await res.json()) as T;
}

function resolveReconLinksColumns(headerRow: Array<string | number>) {
  const norm = headerRow.map((cell) => normalizeHeader(String(cell ?? '')));
  const findCol = (aliases: string[], fallback: number): number => {
    const idx = norm.findIndex((h) => aliases.includes(h));
    return idx !== -1 ? idx : fallback;
  };

  return {
    linkIdIdx: findCol(['linkid', 'id'], 0),
    bankTabIdx: findCol(['banktab', 'tab', 'account'], 1),
    bankUniqueIdIdx: findCol(['bankuniqueid', 'uniquetransactionid', 'uniqueid'], 2),
    targetTypeIdx: findCol(['targettype', 'type'], 3),
    targetIdIdx: findCol(['targetid', 'expid'], 4),
    allocatedAmountIdx: findCol(['allocatedamount', 'amount'], 5),
    categoryIdx: findCol(['category'], 6),
    linkModeIdx: findCol(['linkmode', 'matchtype', 'mode'], 7),
    linkedAtIdx: findCol(['linkedat', 'createdat', 'timestamp'], 8),
    notesIdx: findCol(['notes', 'note'], 9),
  };
}

function parseBankTab(raw: unknown): AccountType {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'puja' ? 'Puja' : 'Regular';
}

function parseTargetType(raw: unknown): ReconTargetType {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'income' ? 'Income' : 'Expense';
}

function parseLinkMode(raw: unknown): ReconLinkMode {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'auto' || v === '1:1' ? 'Auto' : 'Manual';
}

function parsePositiveAmount(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.abs(raw);
  }
  if (raw !== undefined && raw !== null) {
    const parsed = parseSignedAmount(String(raw));
    if (parsed !== null && Number.isFinite(parsed)) {
      return Math.abs(parsed);
    }
  }
  return null;
}

export async function fetchReconLinks(
  accessToken: string,
  spreadsheetId: string = TARGET_SPREADSHEET_ID
): Promise<LoadedReconLinks> {
  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties`,
    accessToken
  );

  const matchingSheet = meta.sheets?.find(
    (s) => s.properties?.title === RECON_LINKS_TAB_NAME
  );

  if (!matchingSheet) {
    return {
      spreadsheetId,
      tabName: RECON_LINKS_TAB_NAME,
      tabExists: false,
      hasHeader: false,
      links: [],
      existingLinkIds: new Set(),
    };
  }

  const safeTab = `'${RECON_LINKS_TAB_NAME.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(`${safeTab}!A:Z`);
  const valuesResp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    accessToken
  );

  const rows = valuesResp.values ?? [];
  if (rows.length === 0) {
    return {
      spreadsheetId,
      tabName: RECON_LINKS_TAB_NAME,
      tabExists: true,
      hasHeader: false,
      links: [],
      existingLinkIds: new Set(),
    };
  }

  const firstRow = rows[0] ?? [];
  const c0 = normalizeHeader(String(firstRow[0] ?? ''));
  const c2 = normalizeHeader(String(firstRow[2] ?? ''));
  const hasHeader = c0 === 'linkid' || c2 === 'bankuniqueid';
  const cols = hasHeader
    ? resolveReconLinksColumns(firstRow)
    : resolveReconLinksColumns([]);

  const links: ReconLink[] = [];
  const existingLinkIds = new Set<string>();

  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => String(cell ?? '').trim() === '')) {
      continue;
    }

    const bankUniqueId = String(row[cols.bankUniqueIdIdx] ?? '').trim();
    const targetId = String(row[cols.targetIdIdx] ?? '').trim();
    const amount = parsePositiveAmount(row[cols.allocatedAmountIdx]);
    if (!bankUniqueId || !targetId || amount === null) continue;

    const allocCents = toCents(amount);
    if (allocCents <= 0) continue;

    const targetType = parseTargetType(row[cols.targetTypeIdx]);
    const rawLinkId = String(row[cols.linkIdIdx] ?? '').trim();
    const linkId = rawLinkId || generateLinkId(bankUniqueId, targetType, targetId);

    existingLinkIds.add(linkId);
    links.push({
      linkId,
      sheetRowNumber: i + 1,
      bankTab: parseBankTab(row[cols.bankTabIdx]),
      bankUniqueId,
      targetType,
      targetId,
      allocatedAmount: fromCents(allocCents),
      allocatedCents: allocCents,
      category: String(row[cols.categoryIdx] ?? '').trim(),
      linkMode: parseLinkMode(row[cols.linkModeIdx]),
      linkedAt: String(row[cols.linkedAtIdx] ?? '').trim(),
      notes: String(row[cols.notesIdx] ?? '').trim(),
    });
  }

  return {
    spreadsheetId,
    tabName: RECON_LINKS_TAB_NAME,
    tabExists: true,
    hasHeader,
    links,
    existingLinkIds,
  };
}

export async function ensureReconLinksTabExists(
  accessToken: string,
  spreadsheetId: string = TARGET_SPREADSHEET_ID
): Promise<{ sheetId: number; created: boolean }> {
  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties`,
    accessToken
  );

  const existing = meta.sheets?.find(
    (s) => s.properties?.title === RECON_LINKS_TAB_NAME
  );

  let sheetId = existing?.properties?.sheetId;
  let created = false;

  if (sheetId === undefined) {
    const addResp = await sheetsFetch<{
      replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
    }>(
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
                  title: RECON_LINKS_TAB_NAME,
                },
              },
            },
          ],
        }),
      }
    );
    sheetId = addResp.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
    created = true;
  }

  const safeTab = `'${RECON_LINKS_TAB_NAME.replace(/'/g, "''")}'`;
  const headerRange = encodeURIComponent(`${safeTab}!A1:J1`);
  const existingHeaderResp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${headerRange}`,
    accessToken
  );

  const firstCell = normalizeHeader(String(existingHeaderResp.values?.[0]?.[0] ?? ''));
  if (firstCell !== 'linkid') {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${headerRange}?valueInputOption=RAW`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({
          values: [[...RECON_LINKS_HEADERS]],
        }),
      }
    );
  }

  return { sheetId, created };
}

export async function appendReconLinks(
  accessToken: string,
  newLinks: NewReconLinkInput[],
  spreadsheetId: string = TARGET_SPREADSHEET_ID
): Promise<{ appendedCount: number; skippedDuplicates: number }> {
  if (newLinks.length === 0) {
    return { appendedCount: 0, skippedDuplicates: 0 };
  }

  await ensureReconLinksTabExists(accessToken, spreadsheetId);
  const current = await fetchReconLinks(accessToken, spreadsheetId);

  const existingPairs = new Set<string>(
    current.links.map((l) => reconPairKey(l.bankUniqueId, l.targetType, l.targetId))
  );

  const nowIso = new Date().toISOString();
  const rowsToAppend: Array<Array<string | number>> = [];
  let skippedDuplicates = 0;

  for (const item of newLinks) {
    const bankUniqueId = item.bankUniqueId.trim();
    const targetId = item.targetId.trim();
    const allocCents = toCents(item.allocatedAmount);
    if (!bankUniqueId || !targetId || allocCents <= 0) continue;

    const pKey = reconPairKey(bankUniqueId, item.targetType, targetId);
    if (existingPairs.has(pKey)) {
      skippedDuplicates++;
      continue;
    }
    existingPairs.add(pKey);

    const linkId =
      item.linkId?.trim() || generateLinkId(bankUniqueId, item.targetType, targetId);

    rowsToAppend.push([
      linkId,
      item.bankTab,
      bankUniqueId,
      item.targetType,
      targetId,
      Number(fromCents(allocCents).toFixed(2)),
      item.category.trim(),
      item.linkMode ?? 'Manual',
      item.linkedAt ?? nowIso,
      (item.notes ?? '').trim(),
    ]);
  }

  if (rowsToAppend.length === 0) {
    return { appendedCount: 0, skippedDuplicates };
  }

  const safeTab = `'${RECON_LINKS_TAB_NAME.replace(/'/g, "''")}'`;
  const appendRange = encodeURIComponent(`${safeTab}!A1:J1`);
  const CHUNK_SIZE = 200;

  for (let i = 0; i < rowsToAppend.length; i += CHUNK_SIZE) {
    const chunk = rowsToAppend.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
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

  return {
    appendedCount: rowsToAppend.length,
    skippedDuplicates,
  };
}

export async function deleteReconLinksByRowNumbers(
  accessToken: string,
  sheetRowNumbers: number[],
  spreadsheetId: string = TARGET_SPREADSHEET_ID
): Promise<number> {
  const uniqueRows = Array.from(
    new Set(sheetRowNumbers.filter((n) => Number.isInteger(n) && n >= 2))
  ).sort((a, b) => b - a); // Descending so row deletions don't shift earlier row numbers

  if (uniqueRows.length === 0) return 0;

  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties`,
    accessToken
  );

  const sheetId = meta.sheets?.find(
    (s) => s.properties?.title === RECON_LINKS_TAB_NAME
  )?.properties?.sheetId;

  if (sheetId === undefined) return 0;

  const requests = uniqueRows.map((rowNum) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: rowNum - 1,
        endIndex: rowNum,
      },
    },
  }));

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ requests }),
    }
  );

  return uniqueRows.length;
}

export interface ReconLinkRowPatch {
  sheetRowNumber: number;
  allocatedAmount?: number;
  category?: string;
  notes?: string;
}

export async function updateReconLinkRows(
  accessToken: string,
  patches: ReconLinkRowPatch[],
  spreadsheetId: string = TARGET_SPREADSHEET_ID
): Promise<number> {
  if (patches.length === 0) return 0;

  const safeTab = `'${RECON_LINKS_TAB_NAME.replace(/'/g, "''")}'`;
  const headerRange = encodeURIComponent(`${safeTab}!A1:Z1`);
  const headerResp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${headerRange}`,
    accessToken
  );

  const cols = resolveReconLinksColumns(headerResp.values?.[0] ?? []);
  const data: Array<{ range: string; values: Array<Array<string | number>> }> = [];
  let updatedCount = 0;

  for (const patch of patches) {
    if (!patch.sheetRowNumber || patch.sheetRowNumber < 2) continue;
    let touched = false;
    if (patch.allocatedAmount !== undefined) {
      data.push({
        range: `${safeTab}!${colIndexToA1(cols.allocatedAmountIdx)}${patch.sheetRowNumber}`,
        values: [[Number(fromCents(toCents(patch.allocatedAmount)).toFixed(2))]],
      });
      touched = true;
    }
    if (patch.category !== undefined) {
      data.push({
        range: `${safeTab}!${colIndexToA1(cols.categoryIdx)}${patch.sheetRowNumber}`,
        values: [[patch.category.trim()]],
      });
      touched = true;
    }
    if (patch.notes !== undefined) {
      data.push({
        range: `${safeTab}!${colIndexToA1(cols.notesIdx)}${patch.sheetRowNumber}`,
        values: [[patch.notes.trim()]],
      });
      touched = true;
    }
    if (touched) updatedCount++;
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
        valueInputOption: 'RAW',
        data,
      }),
    }
  );

  return updatedCount;
}
