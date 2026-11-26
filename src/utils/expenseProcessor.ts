import {
  ExpenseCsvColumnMapping,
  ExpenseLookups,
  ExpenseRecord,
  StagedExpenseBatchSummary,
  UploadedExpenseCsv,
} from '../types/expense';
import { normalizeDate, parseSignedAmount } from './statementProcessor';

export const TREAT_AS_ACTUAL_SENTINEL = '__TREAT_AS_ACTUAL__';

function findBestHeader(headers: string[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = headers.find((h) => pattern.test(h.trim().toLowerCase()));
    if (match) return match;
  }
  return '';
}

export function detectExpenseCsvMapping(headers: string[]): {
  mapping: ExpenseCsvColumnMapping;
  status: 'auto' | 'needs-mapping';
} {
  const expIdCol = findBestHeader(headers, [
    /^(exp_?id|expense_?id|unique_?id|item_?id|request_?id|record_?id)$/,
    /\b(exp_?id|expense\s*id|unique\s*id)\b/,
    /^id$/,
  ]);

  const dateCol = findBestHeader(headers, [
    /^(date|expense\s*date|transaction\s*date|paid\s*date|submitted\s*date)$/,
    /\bdate\b/,
  ]);

  const amountCol = findBestHeader(headers, [
    /^(amount|expense\s*amount|total\s*amount|cost|amt)$/,
    /\b(amount|amt|total|cost)\b/,
  ]);

  const categoryCol = findBestHeader(headers, [
    /^(category|expense\s*category|cat)$/,
    /\bcategory\b/,
  ]);

  const subCategoryCol = findBestHeader(headers, [
    /^(sub[\s_-]*category|sub[\s_-]*cat)$/,
    /\bsub[\s_-]*cat/,
  ]);

  const descriptionCol = findBestHeader(headers, [
    /^(description|expense\s*description|item\s*description|details|memo|purpose)$/,
    /\b(description|details|memo|purpose|item)\b/,
    /^notes?$/,
  ]);

  const statusCol = findBestHeader(headers, [
    /^(status|payment\s*status|expense\s*status|approval\s*status)$/,
    /\bstatus\b/,
  ]);

  const requestTypeCol = findBestHeader(headers, [
    /^(request[\s_-]*type|req[\s_-]*type|expense[\s_-]*type|record[\s_-]*type)$/,
    /\brequest[\s_-]*type\b/,
    /^type$/,
  ]);

  const pujaCol = findBestHeader(headers, [
    /^(puja|puja\s*name|event|occasion)$/,
    /\bpuja\b/,
  ]);

  const paymentModeCol = findBestHeader(headers, [
    /^(payment[\s_-]*mode|payment[\s_-]*method|pay[\s_-]*mode|mode)$/,
    /\bpayment[\s_-]*(mode|method)\b/,
  ]);

  const reconSourceCol = findBestHeader(headers, [
    /^(recon[\s_-]*source)$/,
    /\brecon[\s_-]*source\b/,
  ]);

  const reconSourceIdCol = findBestHeader(headers, [
    /^(recon[\s_-]*source[\s_-]*id)$/,
    /\brecon[\s_-]*source[\s_-]*id\b/,
  ]);

  const rawNotesCol = findBestHeader(headers, [
    /^(notes?|vendor|supplier|merchant)$/,
    /\b(notes?|vendor|supplier|merchant)\b/,
  ]);
  const notesCol = rawNotesCol && rawNotesCol !== descriptionCol ? rawNotesCol : '';

  const mapping: ExpenseCsvColumnMapping = {
    expIdCol,
    dateCol,
    amountCol,
    categoryCol,
    subCategoryCol,
    descriptionCol,
    statusCol,
    requestTypeCol,
    pujaCol,
    paymentModeCol,
    reconSourceCol,
    reconSourceIdCol,
    notesCol,
  };

  const isComplete =
    Boolean(dateCol) &&
    Boolean(amountCol) &&
    Boolean(categoryCol) &&
    Boolean(descriptionCol) &&
    Boolean(statusCol) &&
    Boolean(requestTypeCol);

  return {
    mapping,
    status: isComplete ? 'auto' : 'needs-mapping',
  };
}

async function sha256Hex12(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 12).toUpperCase();
}

function matchLookupCasing(value: string, allowed: string[]): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = allowed.find((opt) => opt.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}

export function getSubCategoryOptions(
  category: string,
  catSubcatMap: Record<string, string[]>
): string[] {
  const cat = category.replace(/\s+/g, ' ').trim();
  if (!cat) return [];
  const lower = cat.toLowerCase();
  const keys = Object.keys(catSubcatMap);

  const exactKey = keys.find((k) => k.replace(/\s+/g, ' ').trim().toLowerCase() === lower);
  if (exactKey) return catSubcatMap[exactKey];

  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (!compact) return [];
  const fuzzyKey = keys.find(
    (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === compact
  );
  return fuzzyKey ? catSubcatMap[fuzzyKey] : [];
}

export function generateManualExpenseId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const randPart = crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase();
    const candidate = `EXP-${timePart}-${randPart}`;
    if (!existingIds.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `EXP-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

const EXPENSE_VENDOR_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Amazon', pattern: /\bamazon(?:\.com)?\b|\bamzn\b/i },
  { label: 'Home Depot', pattern: /\b(?:the\s+)?home\s*depot\b|\bhomedepot\b/i },
  { label: "Lowe's", pattern: /\blowe'?s\b/i },
  { label: 'Walmart', pattern: /\bwal[-\s]*mart\b/i },
  { label: 'Costco', pattern: /\bcostco\b/i },
  { label: "Sam's Club", pattern: /\bsam'?s\s*club\b/i },
  { label: "BJ's Wholesale", pattern: /\bbj'?s(?:\s+wholesale)?\b/i },
  {
    label: 'Target',
    pattern: /\btarget\b(?!(?:\s+(?:goal|amount|date|budget|is|was|for\s+this)))/i,
  },
  { label: 'Best Buy', pattern: /\bbest\s*buy\b/i },
  { label: 'Staples', pattern: /\bstaples\b/i },
  { label: 'Office Depot', pattern: /\boffice\s*depot\b/i },
  { label: 'OfficeMax', pattern: /\bofficemax\b/i },
  { label: 'IKEA', pattern: /\bikea\b/i },
  { label: 'Michaels', pattern: /\bmichaels\b/i },
  { label: 'Hobby Lobby', pattern: /\bhobby\s*lobby\b/i },
  { label: 'Joann', pattern: /\bjo-?ann\b/i },
  { label: 'Dollar Tree', pattern: /\bdollar\s*tree\b/i },
  { label: 'Dollar General', pattern: /\bdollar\s*general\b/i },
  { label: 'Five Below', pattern: /\bfive\s*below\b/i },
  { label: 'Harbor Freight', pattern: /\bharbor\s*freight\b/i },
  { label: 'Ace Hardware', pattern: /\bace\s*hardware\b/i },
  { label: 'Uline', pattern: /\buline\b/i },
  { label: 'WebstaurantStore', pattern: /\bwebstaurant(?:store)?\b/i },
  { label: 'Restaurant Depot', pattern: /\brestaurant\s*depot\b/i },
  { label: 'Smart & Final', pattern: /\bsmart\s*(?:&|and)\s*final\b/i },
  { label: 'Walgreens', pattern: /\bwalgreens\b/i },
  { label: 'CVS', pattern: /\bcvs\b/i },
  { label: 'Party City', pattern: /\bparty\s*city\b/i },
  { label: 'Etsy', pattern: /\betsy\b/i },
  { label: 'eBay', pattern: /\bebay\b/i },
  { label: 'Temu', pattern: /\btemu\b/i },
  { label: 'AliExpress', pattern: /\baliexpress\b/i },
  { label: 'Wayfair', pattern: /\bwayfair\b/i },
  { label: 'FedEx', pattern: /\bfedex\b/i },
  { label: 'UPS', pattern: /\bups(?:\s+store)?\b/i },
  { label: 'USPS', pattern: /\busps\b/i },
  { label: 'Vistaprint', pattern: /\bvista\s*print\b/i },
  { label: 'Kroger', pattern: /\bkroger\b/i },
  { label: 'HEB', pattern: /\bh[\s-]*e[\s-]*b\b/i },
  { label: 'Randalls', pattern: /\brandalls\b/i },
  { label: 'Aldi', pattern: /\baldi\b/i },
  { label: "Trader Joe's", pattern: /\btrader\s*joe'?s\b/i },
  { label: 'Whole Foods', pattern: /\bwhole\s*foods\b/i },
  { label: 'Sprouts', pattern: /\bsprouts\b/i },
  { label: 'Safeway', pattern: /\bsafeway\b/i },
  { label: 'Publix', pattern: /\bpublix\b/i },
  { label: 'Meijer', pattern: /\bmeijer\b/i },
  { label: 'Wegmans', pattern: /\bwegmans\b/i },
  { label: 'Vishala', pattern: /\bvishala\b/i },
  { label: 'Patel Brothers', pattern: /\bpatel\s*(?:brothers|bros\.?)\b/i },
  { label: 'Subzi Mandi', pattern: /\bsubzi\s*mandi\b/i },
  { label: 'India Bazaar', pattern: /\bindia\s*bazaar\b/i },
  { label: 'Keemat', pattern: /\bkeemat\b/i },
  { label: 'Raja Foods', pattern: /\braja\s*foods?\b/i },
  { label: 'U-Haul', pattern: /\bu-?haul\b/i },
  { label: 'Penske', pattern: /\bpenske\b/i },
  { label: 'United Rentals', pattern: /\bunited\s*rentals\b/i },
  { label: 'Sunbelt Rentals', pattern: /\bsunbelt(?:\s+rentals)?\b/i },
  { label: 'Canva', pattern: /\bcanva\b/i },
  { label: 'Adobe', pattern: /\badobe\b/i },
  { label: 'Zoom', pattern: /\bzoom\b/i },
  { label: 'QuickBooks', pattern: /\bquickbooks\b/i },
  { label: 'GoDaddy', pattern: /\bgodaddy\b/i },
  { label: 'Mailchimp', pattern: /\bmailchimp\b/i },
  { label: 'Chick-fil-A', pattern: /\bchick-?fil-?a\b/i },
  { label: 'Chipotle', pattern: /\bchipotle\b/i },
  { label: 'Panera', pattern: /\bpanera(?:\s+bread)?\b/i },
  { label: 'Pizza Hut', pattern: /\bpizza\s*hut\b/i },
  { label: "Domino's", pattern: /\bdomino'?s\b/i },
  { label: "Papa John's", pattern: /\bpapa\s*john'?s\b/i },
  { label: 'Starbucks', pattern: /\bstarbucks\b/i },
  { label: "Dunkin'", pattern: /\bdunkin\b/i },
  { label: 'Subway', pattern: /\bsubway\b/i },
  { label: 'Sysco', pattern: /\bsysco\b/i },
  { label: 'US Foods', pattern: /\bus\s*foods\b/i },
  { label: 'AT&T', pattern: /\bat\s*&\s*t\b/i },
  { label: 'Verizon', pattern: /\bverizon\b/i },
  { label: 'T-Mobile', pattern: /\bt-?mobile\b/i },
  { label: 'Xfinity', pattern: /\bxfinity\b|\bcomcast\b/i },
  { label: 'CenterPoint', pattern: /\bcenterpoint\b/i },
  { label: 'Reliant', pattern: /\breliant\b/i },
];

const VENDOR_LEADING_STOP_WORDS = new Set([
  'for',
  'during',
  'from',
  'at',
  'by',
  'with',
  'and',
  'the',
  'all',
  'puja',
  'pujo',
  'temple',
  'online',
  'local',
  'new',
  'extra',
  'additional',
  'other',
  'misc',
]);

export function extractExpenseVendorNotes(description: string): string {
  const raw = String(description ?? '').trim();
  if (!raw) return '';

  const found: Array<{ index: number; label: string }> = [];
  const seen = new Set<string>();

  const pushVendor = (label: string, index: number) => {
    const clean = label.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ index, label: clean });
  };

  // 1. Curated canonical supplier / vendor rules
  for (const rule of EXPENSE_VENDOR_RULES) {
    const m = rule.pattern.exec(raw);
    if (m) {
      pushVendor(rule.label, m.index);
    }
  }

  // 2. Explicit "Vendor: ..." or "Supplier: ..." tag
  const explicitTagRegex =
    /\b(?:vendor|supplier|merchant)\s*[:\-]\s*([^,;\n|()]+?)(?=\s+[-–—]\s+|[,;\n|()]|$)/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = explicitTagRegex.exec(raw)) !== null) {
    const candidate = tagMatch[1].trim().slice(0, 50).trim();
    const candLower = candidate.toLowerCase();
    if (
      candidate &&
      !Array.from(seen).some((k) => candLower.includes(k) || k.includes(candLower))
    ) {
      pushVendor(candidate, tagMatch.index);
    }
  }

  // 3. Multi-word named supplier/business entities (e.g. "ABC Party Rentals", "Taj Catering LLC")
  const namedBusinessRegex =
    /\b([A-Z][A-Za-z0-9&'.-]*(?:\s+(?:&|and|[A-Z][A-Za-z0-9&'.-]*)){0,3}\s+(?:LLC|Inc\.?|Corp\.?|Grocers|Groceries|Supermarket|Bazaar|Catering|Bakery|Rentals|Printing|Graphics|Florist|Hardware|Wholesale|Enterprises))\b/g;
  let bizMatch: RegExpExecArray | null;
  while ((bizMatch = namedBusinessRegex.exec(raw)) !== null) {
    const words = bizMatch[1].trim().split(/\s+/);
    while (words.length > 1 && VENDOR_LEADING_STOP_WORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    if (words.length < 2) continue;
    const candidate = words.join(' ');
    const candLower = candidate.toLowerCase();
    if (!Array.from(seen).some((k) => candLower.includes(k) || k.includes(candLower))) {
      pushVendor(candidate, bizMatch.index);
    }
  }

  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.label).join(', ');
}

export function findExpenseNotesBackfillUpdates(
  records: ExpenseRecord[]
): Array<{ sheetRowNumber: number; notes: string }> {
  const updates: Array<{ sheetRowNumber: number; notes: string }> = [];
  for (const rec of records) {
    if (rec.sourceOrigin !== 'sheet' || !rec.sheetRowNumber) continue;
    if ((rec.notes ?? '').trim() !== '') continue;
    const detected = extractExpenseVendorNotes(rec.description);
    if (detected) {
      updates.push({
        sheetRowNumber: rec.sheetRowNumber,
        notes: detected,
      });
    }
  }
  return updates;
}

export async function processExpenseCsvs(
  files: UploadedExpenseCsv[],
  existingSheetIds: Set<string>,
  lookups: ExpenseLookups
): Promise<{
  stagedRecords: ExpenseRecord[];
  summary: StagedExpenseBatchSummary;
}> {
  let totalRawRows = 0;
  let filteredOutByTypeOrStatus = 0;
  let skippedInvalidRows = 0;
  let duplicateIdsRemoved = 0;

  const seenIds = new Set<string>();
  for (const id of existingSheetIds) {
    seenIds.add(id.toLowerCase());
  }

  const stagedRecords: ExpenseRecord[] = [];

  for (const file of files) {
    if (file.mappingStatus === 'needs-mapping') {
      totalRawRows += file.rawRows.length;
      continue;
    }

    const { mapping } = file;
    const perFileIdentityCounts = new Map<string, number>();

    for (const row of file.rawRows) {
      totalRawRows++;

      const requestTypeRaw =
        mapping.requestTypeCol === TREAT_AS_ACTUAL_SENTINEL
          ? 'Actual'
          : (row[mapping.requestTypeCol] ?? '').trim();
      const statusRaw = (row[mapping.statusCol] ?? '').trim();

      const reqNorm = requestTypeRaw.toLowerCase();
      const statusNorm = statusRaw.toLowerCase();

      // Task 8: Filter only Request Type === "Actual" AND Status === "Accepted" or "Paid"
      const passesFilter =
        reqNorm === 'actual' && (statusNorm === 'accepted' || statusNorm === 'paid');

      if (!passesFilter) {
        filteredOutByTypeOrStatus++;
        continue;
      }

      const rawDate = (row[mapping.dateCol] ?? '').trim();
      const normalizedDate = normalizeDate(rawDate);
      const amount = parseSignedAmount(row[mapping.amountCol] ?? '');
      const description = (row[mapping.descriptionCol] ?? '').trim().replace(/\s+/g, ' ');
      const categoryRaw = (row[mapping.categoryCol] ?? '').trim();

      if (!normalizedDate || amount === null || !description || !categoryRaw) {
        skippedInvalidRows++;
        continue;
      }

      const category = matchLookupCasing(categoryRaw, lookups.categories);
      const status = matchLookupCasing(statusRaw, lookups.statuses);

      const subCatRaw = mapping.subCategoryCol ? (row[mapping.subCategoryCol] ?? '').trim() : '';
      const subCatOptions = getSubCategoryOptions(category, lookups.catSubcatMap);
      const subCategory = matchLookupCasing(subCatRaw, subCatOptions);

      const pujaRaw = mapping.pujaCol ? (row[mapping.pujaCol] ?? '').trim() : '';
      const puja = matchLookupCasing(pujaRaw, lookups.pujas);

      const payModeRaw = mapping.paymentModeCol ? (row[mapping.paymentModeCol] ?? '').trim() : '';
      const paymentMode = matchLookupCasing(payModeRaw, lookups.paymentModes);

      const reconSource = mapping.reconSourceCol
        ? (row[mapping.reconSourceCol] ?? '').trim()
        : '';
      const reconSourceId = mapping.reconSourceIdCol
        ? (row[mapping.reconSourceIdCol] ?? '').trim()
        : '';
      const rawNotes = mapping.notesCol ? (row[mapping.notesCol] ?? '').trim() : '';
      const notes = rawNotes || extractExpenseVendorNotes(description);

      const providedId = mapping.expIdCol ? (row[mapping.expIdCol] ?? '').trim() : '';
      let expId = providedId;

      if (!expId) {
        const amountCents = Math.round(amount * 100);
        const identity = `${normalizedDate}|${amountCents}|${category.toUpperCase()}|${description.toUpperCase()}`;
        const occ = (perFileIdentityCounts.get(identity) || 0) + 1;
        perFileIdentityCounts.set(identity, occ);
        const hash = await sha256Hex12(`${identity}|${occ}`);
        expId = `EXP-${hash}`;
      }

      const idKey = expId.toLowerCase();
      if (seenIds.has(idKey)) {
        duplicateIdsRemoved++;
        continue;
      }
      seenIds.add(idKey);

      stagedRecords.push({
        sheetRowNumber: null,
        expId,
        date: normalizedDate,
        amount: Math.abs(amount),
        category,
        subCategory,
        description,
        status,
        puja,
        paymentMode,
        reconSource,
        reconSourceId,
        isRecon: reconSourceId ? 'Yes' : 'No',
        notes,
        sourceOrigin: 'csv',
        sourceFileName: file.fileName,
      });
    }
  }

  return {
    stagedRecords,
    summary: {
      totalRawRows,
      filteredOutByTypeOrStatus,
      skippedInvalidRows,
      duplicateIdsRemoved,
      readyToSync: stagedRecords.length,
    },
  };
}
