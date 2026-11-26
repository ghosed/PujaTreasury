import {
  ExpenseLookups,
  ExpenseRecord,
  ExpenseSheetMeta,
} from '../types/expense';
import { SheetsApiError } from './googleSheets';
import { normalizeDate, parseSignedAmount } from '../utils/statementProcessor';

export const EXPENSE_SPREADSHEET_ID = '1cHUFKpyeZNhBuHFx8R2OSZhA9br4Oc1-DNq0w_IgP2k';

export const CANONICAL_EXPENSE_HEADERS = [
  'Exp_ID',
  'Date',
  'Amount',
  'Category',
  'Sub Category',
  'Description',
  'Status',
  'Puja',
  'Payment Mode',
  'Recon Source',
  'Recon Source_ID',
  'Is_Recon',
  'Notes',
] as const;

function normalizeIsRecon(raw: unknown): 'Yes' | 'No' {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === 'y') return 'Yes';
  return 'No';
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

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

function parseLookUpTab(rows: Array<Array<string | number>>): Omit<ExpenseLookups, 'catSubcatMap'> {
  const categories: string[] = [];
  const statuses: string[] = [];
  const pujas: string[] = [];
  const paymentModes: string[] = [];

  const nonEmptyRows = rows.filter((r) =>
    (r ?? []).some((cell) => String(cell ?? '').trim() !== '')
  );
  if (nonEmptyRows.length === 0) {
    return { categories, statuses, pujas, paymentModes };
  }

  const findHeaderCols = (headerRow: string[]) => {
    const findCol = (
      exactAliases: string[],
      includesAliases: string[],
      excludeIncludes: string[] = []
    ): number => {
      for (const alias of exactAliases) {
        const idx = headerRow.findIndex((h) => h === alias);
        if (idx !== -1) return idx;
      }
      for (const alias of includesAliases) {
        const idx = headerRow.findIndex(
          (h) =>
            h.includes(alias) &&
            !excludeIncludes.some((ex) => h.includes(ex))
        );
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const catCol = findCol(
      ['expensecategory', 'expensecategories', 'category', 'categories'],
      ['expensecat', 'category', 'categories'],
      ['subcat', 'subcategory', 'incomecat', 'code', 'id']
    );
    const statusCol = findCol(
      ['expensestatus', 'status', 'statuses'],
      ['status']
    );
    const pujaCol = findCol(
      ['puja', 'pujas', 'pujaname'],
      ['puja']
    );
    const paymentCol = findCol(
      ['paymentmode', 'paymentmodes', 'paymentmethod', 'paymentmethods', 'paymode'],
      ['paymentmode', 'paymentmethod', 'paymode']
    );

    const matchedCount = [catCol, statusCol, pujaCol, paymentCol].filter(
      (idx) => idx !== -1
    ).length;

    return { catCol, statusCol, pujaCol, paymentCol, matchedCount };
  };

  // Search up to first 6 non-empty rows to locate the LookUp header row
  let bestHeaderRowIdx = -1;
  let bestCols = { catCol: -1, statusCol: -1, pujaCol: -1, paymentCol: -1, matchedCount: 0 };
  const scanLimit = Math.min(nonEmptyRows.length, 6);

  for (let r = 0; r < scanLimit; r++) {
    const candidateHeader = (nonEmptyRows[r] ?? []).map((c) =>
      normalizeHeaderKey(String(c ?? ''))
    );
    const cols = findHeaderCols(candidateHeader);
    if (cols.matchedCount > bestCols.matchedCount) {
      bestCols = cols;
      bestHeaderRowIdx = r;
    }
  }

  if (bestHeaderRowIdx !== -1 && bestCols.matchedCount > 0) {
    const { catCol, statusCol, pujaCol, paymentCol } = bestCols;
    for (let r = bestHeaderRowIdx + 1; r < nonEmptyRows.length; r++) {
      const row = nonEmptyRows[r] ?? [];
      if (catCol !== -1 && row[catCol] !== undefined) {
        categories.push(String(row[catCol] ?? ''));
      }
      if (statusCol !== -1 && row[statusCol] !== undefined) {
        statuses.push(String(row[statusCol] ?? ''));
      }
      if (pujaCol !== -1 && row[pujaCol] !== undefined) {
        pujas.push(String(row[pujaCol] ?? ''));
      }
      if (paymentCol !== -1 && row[paymentCol] !== undefined) {
        paymentModes.push(String(row[paymentCol] ?? ''));
      }
    }
  } else {
    // Fallback: row-oriented lookup where col A is field name and cols B..N are values
    for (const row of nonEmptyRows) {
      const label = normalizeHeaderKey(String(row[0] ?? ''));
      const vals = row.slice(1).map((c) => String(c ?? ''));
      if (
        label === 'expensecategory' ||
        label === 'expensecategories' ||
        label === 'category' ||
        label === 'categories'
      ) {
        categories.push(...vals);
      } else if (label === 'status' || label === 'statuses') {
        statuses.push(...vals);
      } else if (label === 'puja' || label === 'pujas') {
        pujas.push(...vals);
      } else if (
        label === 'paymentmode' ||
        label === 'paymentmodes' ||
        label === 'paymentmethod'
      ) {
        paymentModes.push(...vals);
      }
    }
  }

  return {
    categories: uniqueNonEmpty(categories),
    statuses: uniqueNonEmpty(statuses),
    pujas: uniqueNonEmpty(pujas),
    paymentModes: uniqueNonEmpty(paymentModes),
  };
}

function parseCatSubcatTab(
  rows: Array<Array<string | number>>,
  knownCategories: string[] = []
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const nonEmptyRows = rows.filter((r) =>
    (r ?? []).some((cell) => String(cell ?? '').trim() !== '')
  );
  if (nonEmptyRows.length === 0) return map;

  // Skip an isolated 1-cell banner/title row if row 1 has >= 2 populated cells
  let startIdx = 0;
  if (
    nonEmptyRows.length > 1 &&
    nonEmptyRows[0].filter((c) => String(c ?? '').trim() !== '').length === 1 &&
    nonEmptyRows[1].filter((c) => String(c ?? '').trim() !== '').length >= 2
  ) {
    startIdx = 1;
  }

  const slicedRows = nonEmptyRows.slice(startIdx);
  if (slicedRows.length === 0) return map;

  // Trim completely empty leading columns (e.g., if table starts in Column B)
  let firstPopulatedCol = Infinity;
  for (const row of slicedRows) {
    for (let c = 0; c < row.length; c++) {
      if (String(row[c] ?? '').trim() !== '') {
        if (c < firstPopulatedCol) firstPopulatedCol = c;
        break;
      }
    }
  }
  const workingRows =
    Number.isFinite(firstPopulatedCol) && firstPopulatedCol > 0
      ? slicedRows.map((r) => r.slice(firstPopulatedCol))
      : slicedRows;

  const knownCatSet = new Set(
    knownCategories.map((c) => c.trim().toLowerCase()).filter(Boolean)
  );

  const addMapping = (catRaw: string, subRaw: string) => {
    const cat = catRaw.replace(/\s+/g, ' ').trim();
    if (!cat) return;
    const parts = subRaw.split(/\r?\n|,/);
    for (const part of parts) {
      const sub = part.replace(/\s+/g, ' ').trim();
      if (!sub) continue;
      const existingKey = Object.keys(map).find(
        (k) => k.toLowerCase() === cat.toLowerCase()
      );
      const key = existingKey ?? cat;
      if (!map[key]) {
        map[key] = [];
      }
      if (!map[key].some((s) => s.toLowerCase() === sub.toLowerCase())) {
        map[key].push(sub);
      }
    }
  };

  const headerCells = workingRows[0].map((c) => String(c ?? '').trim());
  const normalizedHeaders = headerCells.map(normalizeHeaderKey);

  const isSubHeader = (h: string) => h.includes('subcat');
  const isCatHeader = (h: string) =>
    !isSubHeader(h) &&
    (h === 'cat' ||
      h === 'cats' ||
      /^cat\d*$/.test(h) ||
      h.includes('category') ||
      h.includes('categories'));

  const catIdx = normalizedHeaders.findIndex(isCatHeader);
  const subIdx = normalizedHeaders.findIndex(isSubHeader);

  // 1. Explicit header row with Category & Sub Category columns
  if (catIdx !== -1 && subIdx !== -1) {
    const maxRowWidth = workingRows.reduce((max, r) => Math.max(max, r.length), 0);
    const subCols: number[] = [];
    for (let c = 0; c < maxRowWidth; c++) {
      if (c === catIdx) continue;
      const h = normalizedHeaders[c] ?? '';
      if (isSubHeader(h) || (subIdx > catIdx && c > subIdx && h === '')) {
        subCols.push(c);
      }
    }

    let lastCategory = '';
    for (let r = 1; r < workingRows.length; r++) {
      const row = workingRows[r] ?? [];
      const catCell = String(row[catIdx] ?? '').trim();
      if (catCell) {
        lastCategory = catCell;
      }
      const targetCat = subCols.length === 1 ? lastCategory : catCell || lastCategory;
      if (!targetCat) continue;
      for (const sc of subCols) {
        const subCell = String(row[sc] ?? '').trim();
        if (subCell) {
          addMapping(targetCat, subCell);
        }
      }
    }
    return map;
  }

  // 2. Explicit "Category" header in col 0 followed by unlabelled/generic subcategory columns
  if (catIdx === 0 && headerCells.length >= 2) {
    for (let r = 1; r < workingRows.length; r++) {
      const row = workingRows[r] ?? [];
      const catCell = String(row[0] ?? '').trim();
      if (!catCell) continue;
      for (let c = 1; c < row.length; c++) {
        const subCell = String(row[c] ?? '').trim();
        if (subCell) {
          addMapping(catCell, subCell);
        }
      }
    }
    return map;
  }

  // 3. No explicit header keywords: compare LookUp Category hits in Row 0 vs Column 0
  const row0CatHits = headerCells.filter((c) => knownCatSet.has(c.toLowerCase())).length;
  const row0OtherCatHits = headerCells
    .slice(1)
    .filter((c) => knownCatSet.has(c.toLowerCase())).length;
  const col0CatHits = workingRows.filter((r) =>
    knownCatSet.has(String(r[0] ?? '').trim().toLowerCase())
  ).length;

  const isRowOriented =
    col0CatHits > row0CatHits ||
    (row0OtherCatHits === 0 && col0CatHits >= 1 && workingRows.length === 1) ||
    (row0OtherCatHits === 0 &&
      col0CatHits >= 1 &&
      workingRows.slice(1).some((r) => knownCatSet.has(String(r[0] ?? '').trim().toLowerCase())));

  if (isRowOriented) {
    for (const row of workingRows) {
      const catCell = String(row[0] ?? '').trim();
      if (!catCell) continue;
      for (let c = 1; c < row.length; c++) {
        const subCell = String(row[c] ?? '').trim();
        if (subCell) {
          addMapping(catCell, subCell);
        }
      }
    }
    return map;
  }

  // 4. Column-per-Category matrix: Row 0 has Category headers, rows below hold Sub Categories
  for (let col = 0; col < headerCells.length; col++) {
    const categoryName = headerCells[col];
    if (!categoryName) continue;
    for (let r = 1; r < workingRows.length; r++) {
      const subCell = String(workingRows[r]?.[col] ?? '').trim();
      if (subCell) {
        addMapping(categoryName, subCell);
      }
    }
  }

  return map;
}

type ExpenseFieldKey =
  | 'expId'
  | 'date'
  | 'amount'
  | 'category'
  | 'subCategory'
  | 'description'
  | 'status'
  | 'puja'
  | 'paymentMode'
  | 'reconSource'
  | 'reconSourceId'
  | 'isRecon'
  | 'notes';

const HEADER_TO_FIELD: Record<string, ExpenseFieldKey> = {
  expid: 'expId',
  expenseid: 'expId',
  uniqueid: 'expId',
  id: 'expId',
  date: 'date',
  expensedate: 'date',
  amount: 'amount',
  category: 'category',
  subcategory: 'subCategory',
  subcat: 'subCategory',
  description: 'description',
  desc: 'description',
  status: 'status',
  puja: 'puja',
  paymentmode: 'paymentMode',
  paymentmethod: 'paymentMode',
  paymode: 'paymentMode',
  reconsource: 'reconSource',
  reconsourceid: 'reconSourceId',
  isrecon: 'isRecon',
  notes: 'notes',
  note: 'notes',
  vendor: 'notes',
  supplier: 'notes',
  suppliervendor: 'notes',
  vendorname: 'notes',
  suppliername: 'notes',
};

function buildColumnFieldMap(headers: string[]): Map<ExpenseFieldKey, number> {
  const map = new Map<ExpenseFieldKey, number>();
  headers.forEach((header, idx) => {
    const norm = normalizeHeaderKey(header);
    const field = HEADER_TO_FIELD[norm];
    if (field && !map.has(field)) {
      map.set(field, idx);
    }
  });
  return map;
}

function serializeExpenseRow(
  record: ExpenseRecord,
  columnHeaders: string[],
  isReconColIndex: number = 11,
  notesColIndex: number = 12
): Array<string | number> {
  const fieldToIdx = buildColumnFieldMap(columnHeaders);
  const length = Math.max(
    columnHeaders.length,
    CANONICAL_EXPENSE_HEADERS.length,
    isReconColIndex + 1,
    notesColIndex + 1
  );
  const row: Array<string | number> = record.rawRowValues
    ? [...record.rawRowValues]
    : new Array(length).fill('');

  while (row.length < length) {
    row.push('');
  }

  const setField = (field: ExpenseFieldKey, val: string | number, fallbackIdx?: number) => {
    const idx = fieldToIdx.get(field) ?? fallbackIdx;
    if (idx !== undefined) {
      row[idx] = val;
    }
  };

  setField('expId', record.expId);
  setField('date', record.date);
  setField('amount', Number(record.amount.toFixed(2)));
  setField('category', record.category);
  setField('subCategory', record.subCategory);
  setField('description', record.description);
  setField('status', record.status);
  setField('puja', record.puja);
  setField('paymentMode', record.paymentMode);
  setField('reconSource', record.reconSource);
  setField('reconSourceId', record.reconSourceId);
  setField('isRecon', record.isRecon || 'No', isReconColIndex);
  setField('notes', (record.notes ?? '').trim(), notesColIndex);

  return row;
}

export interface LoadedExpenseWorkspace {
  meta: ExpenseSheetMeta;
  lookups: ExpenseLookups;
  records: ExpenseRecord[];
  existingIds: Set<string>;
}

export async function fetchExpenseWorkspace(
  accessToken: string,
  spreadsheetId: string = EXPENSE_SPREADSHEET_ID
): Promise<LoadedExpenseWorkspace> {
  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=properties.title,sheets.properties`,
    accessToken
  );

  const spreadsheetTitle = meta.properties?.title || 'Expense_Ledger';
  const sheetTitles =
    meta.sheets?.map((s) => s.properties?.title).filter((t): t is string => Boolean(t)) ?? [];

  const lookUpTabName =
    sheetTitles.find((t) => normalizeHeaderKey(t) === 'lookup') ??
    sheetTitles.find((t) => normalizeHeaderKey(t).includes('lookup')) ??
    null;

  const catSubcatTabName =
    sheetTitles.find((t) => normalizeHeaderKey(t) === 'catsubcat') ??
    sheetTitles.find((t) => {
      const k = normalizeHeaderKey(t);
      return k.includes('cat') && k.includes('sub');
    }) ??
    null;

  const nonLookupTabs = sheetTitles.filter(
    (t) => t !== lookUpTabName && t !== catSubcatTabName
  );

  const exactLedgerTab = nonLookupTabs.find((t) => {
    const k = normalizeHeaderKey(t);
    return k === 'expenseledger' || k === 'expenses' || k === 'ledger';
  });
  const matchedLedgerTab =
    exactLedgerTab ??
    nonLookupTabs.find((t) => {
      const k = normalizeHeaderKey(t);
      return k.includes('expense') || k.includes('ledger');
    }) ??
    nonLookupTabs[0];

  const ledgerTabName = matchedLedgerTab || 'Expense_Ledger';
  const ledgerTabExists = Boolean(matchedLedgerTab);

  // Read LookUp, CatSubcat, and Ledger tabs concurrently
  const readRange = async (tab: string | null, rangeSuffix: string) => {
    if (!tab) return [];
    const safeTab = `'${tab.replace(/'/g, "''")}'`;
    const encodedRange = encodeURIComponent(`${safeTab}!${rangeSuffix}`);
    const resp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodedRange}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      accessToken
    );
    return resp.values ?? [];
  };

  const [lookUpRows, catSubcatRows, ledgerRows] = await Promise.all([
    readRange(lookUpTabName, 'A:ZZ'),
    readRange(catSubcatTabName, 'A:ZZ'),
    ledgerTabExists ? readRange(ledgerTabName, 'A:ZZ') : Promise.resolve([]),
  ]);

  const baseLookups = parseLookUpTab(lookUpRows);
  const catSubcatMap = parseCatSubcatTab(catSubcatRows, baseLookups.categories);

  // Determine headers from ledger row 1 or canonical default
  let needsHeader = true;
  let columnHeaders: string[] = [...CANONICAL_EXPENSE_HEADERS];

  if (ledgerRows.length > 0) {
    const firstRow = ledgerRows[0].map((c) => String(c ?? '').trim());
    const hasHeaderSignature = firstRow.some((cell) => {
      const k = normalizeHeaderKey(cell);
      return k === 'expid' || k === 'expenseid' || k === 'date' || k === 'category';
    });
    if (hasHeaderSignature) {
      needsHeader = false;
      columnHeaders = firstRow.map((h, i) => h || `Column_${i + 1}`);
    }
  }

  const fieldIdx = buildColumnFieldMap(columnHeaders);
  const hasIsReconHeader = needsHeader ? true : fieldIdx.has('isRecon');
  const hasNotesHeader = needsHeader ? true : fieldIdx.has('notes');

  const usedExtra = new Set<number>();
  if (fieldIdx.has('isRecon')) usedExtra.add(fieldIdx.get('isRecon')!);
  if (fieldIdx.has('notes')) usedExtra.add(fieldIdx.get('notes')!);
  const allocExtraIdx = (minIdx: number): number => {
    let idx = Math.max(columnHeaders.length, minIdx);
    while (usedExtra.has(idx)) idx++;
    usedExtra.add(idx);
    return idx;
  };

  const isReconColIndex = fieldIdx.get('isRecon') ?? allocExtraIdx(11);
  const notesColIndex = fieldIdx.get('notes') ?? allocExtraIdx(12);
  const startRowIdx = needsHeader ? 0 : 1;

  const records: ExpenseRecord[] = [];
  const existingIds = new Set<string>();

  for (let i = startRowIdx; i < ledgerRows.length; i++) {
    const row = ledgerRows[i] ?? [];
    if (row.every((cell) => String(cell ?? '').trim() === '')) {
      continue;
    }

    const readStr = (field: ExpenseFieldKey, fallbackIdx: number): string => {
      const idx = fieldIdx.get(field) ?? fallbackIdx;
      return String(row[idx] ?? '').trim();
    };

    const rawExpId = readStr('expId', 0);
    const rawDate = readStr('date', 1);
    const amountIdx = fieldIdx.get('amount') ?? 2;
    const rawAmount = row[amountIdx];

    let amount: number | null = null;
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) {
      amount = rawAmount;
    } else if (rawAmount !== undefined && rawAmount !== null) {
      amount = parseSignedAmount(String(rawAmount));
    }

    const category = readStr('category', 3);
    const subCategory = readStr('subCategory', 4);
    const description = readStr('description', 5);
    const status = readStr('status', 6);
    const puja = readStr('puja', 7);
    const paymentMode = readStr('paymentMode', 8);
    const reconSource = readStr('reconSource', 9);
    const reconSourceId = readStr('reconSourceId', 10);
    const rawIsRecon = hasIsReconHeader ? readStr('isRecon', isReconColIndex) : '';
    const isRecon: 'Yes' | 'No' =
      rawIsRecon !== '' ? normalizeIsRecon(rawIsRecon) : 'No';
    const notes = hasNotesHeader ? readStr('notes', notesColIndex) : '';

    // Skip rows missing basic identifiable data
    if (!rawExpId && !rawDate && amount === null && !description) {
      continue;
    }

    const normalizedDate = normalizeDate(rawDate) || rawDate;
    const expId = rawExpId || `EXP-ROW-${i + 1}`;
    existingIds.add(expId.toLowerCase());

    records.push({
      sheetRowNumber: i + 1,
      expId,
      date: normalizedDate,
      amount: amount ?? 0,
      category,
      subCategory,
      description,
      status,
      puja,
      paymentMode,
      reconSource,
      reconSourceId,
      isRecon,
      notes,
      rawRowValues: row,
      sourceOrigin: 'sheet',
    });
  }

  // Merge Category names from CatSubcat if LookUp categories were missing
  const mergedCategories =
    baseLookups.categories.length > 0
      ? baseLookups.categories
      : uniqueNonEmpty([
          ...Object.keys(catSubcatMap),
          ...records.map((r) => r.category),
        ]);

  const lookups: ExpenseLookups = {
    categories: mergedCategories,
    statuses:
      baseLookups.statuses.length > 0
        ? baseLookups.statuses
        : uniqueNonEmpty([...records.map((r) => r.status), 'Accepted', 'Paid']),
    pujas:
      baseLookups.pujas.length > 0
        ? baseLookups.pujas
        : uniqueNonEmpty(records.map((r) => r.puja)),
    paymentModes:
      baseLookups.paymentModes.length > 0
        ? baseLookups.paymentModes
        : uniqueNonEmpty(records.map((r) => r.paymentMode)),
    catSubcatMap,
  };

  return {
    meta: {
      spreadsheetId,
      spreadsheetTitle,
      ledgerTabName,
      ledgerTabExists,
      needsHeader,
      hasIsReconHeader,
      isReconColIndex,
      hasNotesHeader,
      notesColIndex,
      columnHeaders,
      lookUpTabName,
      catSubcatTabName,
    },
    lookups,
    records,
    existingIds,
  };
}

export async function fetchExpenseCategories(
  accessToken: string,
  spreadsheetId: string = EXPENSE_SPREADSHEET_ID
): Promise<string[]> {
  const meta = await sheetsFetch<SpreadsheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties`,
    accessToken
  );

  const sheetTitles =
    meta.sheets?.map((s) => s.properties?.title).filter((t): t is string => Boolean(t)) ?? [];

  const lookUpTabName =
    sheetTitles.find((t) => normalizeHeaderKey(t) === 'lookup') ??
    sheetTitles.find((t) => normalizeHeaderKey(t).includes('lookup')) ??
    null;

  if (!lookUpTabName) return [];

  const safeTab = `'${lookUpTabName.replace(/'/g, "''")}'`;
  const encodedRange = encodeURIComponent(`${safeTab}!A:ZZ`);
  const resp = await sheetsFetch<{ values?: Array<Array<string | number>> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodedRange}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    accessToken
  );

  return parseLookUpTab(resp.values ?? []).categories;
}

async function ensureExpenseExtraHeaders(
  accessToken: string,
  meta: ExpenseSheetMeta,
  options: { ensureIsRecon?: boolean; ensureNotes?: boolean }
): Promise<ExpenseSheetMeta> {
  if (!meta.ledgerTabExists || meta.needsHeader) return meta;
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const data: Array<{ range: string; values: string[][] }> = [];
  let nextMeta = meta;

  if (options.ensureIsRecon && !meta.hasIsReconHeader) {
    const colA1 = colIndexToA1(meta.isReconColIndex);
    data.push({
      range: `${safeTab}!${colA1}1`,
      values: [['Is_Recon']],
    });
    nextMeta = { ...nextMeta, hasIsReconHeader: true };
  }

  if (options.ensureNotes && !meta.hasNotesHeader) {
    const colA1 = colIndexToA1(meta.notesColIndex);
    data.push({
      range: `${safeTab}!${colA1}1`,
      values: [['Notes']],
    });
    nextMeta = { ...nextMeta, hasNotesHeader: true };
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

  return nextMeta;
}

export async function appendExpenseRecords(
  accessToken: string,
  meta: ExpenseSheetMeta,
  records: ExpenseRecord[]
): Promise<{ appendedCount: number }> {
  const {
    spreadsheetId,
    ledgerTabName,
    ledgerTabExists,
    needsHeader,
    columnHeaders,
    isReconColIndex,
    notesColIndex,
  } = meta;

  if (!ledgerTabExists) {
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
                  title: ledgerTabName,
                },
              },
            },
          ],
        }),
      }
    );
  } else {
    await ensureExpenseExtraHeaders(accessToken, meta, {
      ensureIsRecon: true,
      ensureNotes: true,
    });
  }

  const rowsToWrite: Array<Array<string | number>> = [];
  if (needsHeader) {
    rowsToWrite.push([...CANONICAL_EXPENSE_HEADERS]);
  }

  for (const record of records) {
    rowsToWrite.push(
      serializeExpenseRow(record, columnHeaders, isReconColIndex, notesColIndex)
    );
  }

  if (rowsToWrite.length > 0) {
    const CHUNK_SIZE = 500;
    const safeTab = `'${ledgerTabName.replace(/'/g, "''")}'`;
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

  return { appendedCount: records.length };
}

export async function updateExpenseRecord(
  accessToken: string,
  meta: ExpenseSheetMeta,
  record: ExpenseRecord
): Promise<void> {
  if (!record.sheetRowNumber || record.sheetRowNumber < 1) {
    throw new Error('Cannot update an expense record that has not been saved to Google Sheets.');
  }

  await ensureExpenseExtraHeaders(accessToken, meta, {
    ensureIsRecon: true,
    ensureNotes: true,
  });

  const serializedRow = serializeExpenseRow(
    record,
    meta.columnHeaders,
    meta.isReconColIndex,
    meta.notesColIndex
  );
  const endCol = colIndexToA1(
    Math.max(
      serializedRow.length,
      meta.columnHeaders.length,
      meta.isReconColIndex + 1,
      meta.notesColIndex + 1
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

export async function updateExpenseIsRecon(
  accessToken: string,
  meta: ExpenseSheetMeta,
  sheetRowNumber: number,
  isRecon: 'Yes' | 'No'
): Promise<void> {
  if (!sheetRowNumber || sheetRowNumber < 1) {
    throw new Error('Cannot update Is_Recon for an unsaved expense record.');
  }

  await ensureExpenseExtraHeaders(accessToken, meta, { ensureIsRecon: true });
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

export async function batchUpdateExpenseNotes(
  accessToken: string,
  meta: ExpenseSheetMeta,
  updates: Array<{ sheetRowNumber: number; notes: string }>
): Promise<number> {
  if (updates.length === 0 && meta.hasNotesHeader) return 0;

  await ensureExpenseExtraHeaders(accessToken, meta, { ensureNotes: true });

  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const notesColA1 = colIndexToA1(meta.notesColIndex);
  const data: Array<{ range: string; values: string[][] }> = [];

  let updatedRowCount = 0;
  for (const upd of updates) {
    if (!upd.sheetRowNumber || upd.sheetRowNumber < 1) continue;
    data.push({
      range: `${safeTab}!${notesColA1}${upd.sheetRowNumber}`,
      values: [[upd.notes]],
    });
    updatedRowCount++;
  }

  if (data.length === 0) return 0;

  const CHUNK_SIZE = 1000;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: chunk,
        }),
      }
    );
  }

  return updatedRowCount;
}

export interface ExpenseReconUpdate {
  sheetRowNumber: number;
  reconSourceId?: string;
  isRecon?: 'Yes' | 'No';
}

export async function batchUpdateExpenseReconIds(
  accessToken: string,
  meta: ExpenseSheetMeta,
  updates: ExpenseReconUpdate[]
): Promise<number> {
  if (updates.length === 0 && meta.hasIsReconHeader) return 0;

  const fieldIdx = buildColumnFieldMap(meta.columnHeaders);
  let reconIdColIndex = fieldIdx.get('reconSourceId');
  let ensureReconIdHeader = false;

  if (reconIdColIndex === undefined) {
    reconIdColIndex = Math.max(meta.columnHeaders.length, 10);
    ensureReconIdHeader = !meta.needsHeader;
  }

  let isReconColIndex = fieldIdx.get('isRecon');
  let ensureIsReconHeader = false;
  if (isReconColIndex === undefined) {
    isReconColIndex = Math.max(
      meta.isReconColIndex,
      reconIdColIndex === meta.isReconColIndex ? reconIdColIndex + 1 : meta.isReconColIndex,
      11
    );
    ensureIsReconHeader = !meta.needsHeader;
  }

  const reconColA1 = colIndexToA1(reconIdColIndex);
  const isReconColA1 = colIndexToA1(isReconColIndex);
  const safeTab = `'${meta.ledgerTabName.replace(/'/g, "''")}'`;
  const data: Array<{ range: string; values: string[][] }> = [];

  if (ensureReconIdHeader) {
    data.push({
      range: `${safeTab}!${reconColA1}1`,
      values: [['Recon Source_ID']],
    });
  }
  if (ensureIsReconHeader) {
    data.push({
      range: `${safeTab}!${isReconColA1}1`,
      values: [['Is_Recon']],
    });
  }

  let updatedRowCount = 0;
  for (const upd of updates) {
    if (!upd.sheetRowNumber || upd.sheetRowNumber < 1) continue;
    let touched = false;
    if (upd.reconSourceId !== undefined) {
      data.push({
        range: `${safeTab}!${reconColA1}${upd.sheetRowNumber}`,
        values: [[upd.reconSourceId]],
      });
      touched = true;
    }
    if (upd.isRecon !== undefined) {
      data.push({
        range: `${safeTab}!${isReconColA1}${upd.sheetRowNumber}`,
        values: [[upd.isRecon]],
      });
      touched = true;
    }
    if (touched) updatedRowCount++;
  }

  if (data.length === 0) return 0;

  const CHUNK_SIZE = 1000;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        meta.spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: chunk,
        }),
      }
    );
  }

  return updatedRowCount;
}
