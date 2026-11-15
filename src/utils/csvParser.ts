import { ColumnMapping } from '../types/statement';

export interface ParsedCsvResult {
  headers: string[];
  rows: Record<string, string>[];
  skippedPreambleLines: number;
}

function detectDelimiter(sampleLines: string[]): string {
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = sampleLines
      .filter((l) => l.trim().length > 0)
      .slice(0, 10)
      .map((l) => splitCsvLine(l, delim).length);
    if (counts.length === 0) continue;
    const maxCols = Math.max(...counts);
    const consistent = counts.filter((c) => c === maxCols && c > 1).length;
    const score = maxCols > 1 ? consistent * 10 + maxCols : 0;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseRawRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  const cleanText = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const next = cleanText[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && next === '\n') {
        i++;
      }
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        records.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }

  currentRow.push(currentField.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    records.push(currentRow);
  }

  return records;
}

function looksLikeHeaderRow(cells: string[]): boolean {
  if (cells.length < 2) return false;
  const joined = cells.map((c) => c.toLowerCase()).join(' | ');
  const hasDate = /\b(date|posted|posting|trans)\b/.test(joined);
  const hasDescOrAmt =
    /\b(description|details|memo|payee|narrative|amount|debit|credit|withdrawal|deposit)\b/.test(
      joined
    );
  return hasDate && hasDescOrAmt;
}

export function parseCsvText(text: string): ParsedCsvResult {
  const sampleLines = text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 20);
  const delimiter = detectDelimiter(sampleLines);
  const records = parseRawRecords(text, delimiter);

  if (records.length === 0) {
    return { headers: [], rows: [], skippedPreambleLines: 0 };
  }

  // Skip bank metadata preamble lines (e.g., "Account Number: ...", "Balance: ...")
  let headerIndex = 0;
  const searchLimit = Math.min(records.length, 15);
  for (let i = 0; i < searchLimit; i++) {
    if (looksLikeHeaderRow(records[i])) {
      headerIndex = i;
      break;
    }
  }

  // If no semantic header match, pick the first row that has >= 3 non-empty columns
  if (headerIndex === 0 && records[0].length < 3) {
    for (let i = 0; i < searchLimit; i++) {
      if (records[i].filter((c) => c.length > 0).length >= 3) {
        headerIndex = i;
        break;
      }
    }
  }

  const rawHeaders = records[headerIndex];
  const seenCounts = new Map<string, number>();
  const headers = rawHeaders.map((h, idx) => {
    const base = h.trim() || `Column ${idx + 1}`;
    const count = (seenCounts.get(base) || 0) + 1;
    seenCounts.set(base, count);
    return count > 1 ? `${base} (${count})` : base;
  });

  const rows: Record<string, string>[] = [];
  for (let i = headerIndex + 1; i < records.length; i++) {
    const cells = records[i];
    // Skip repeated header lines if concatenated statements appear mid-file
    if (
      cells.length === rawHeaders.length &&
      cells.every((c, idx) => c.toLowerCase() === rawHeaders[idx].toLowerCase())
    ) {
      continue;
    }
    const rowObj: Record<string, string> = {};
    headers.forEach((header, idx) => {
      rowObj[header] = cells[idx] ?? '';
    });
    rows.push(rowObj);
  }

  return {
    headers,
    rows,
    skippedPreambleLines: headerIndex,
  };
}

function findBestMatch(headers: string[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = headers.find((h) => pattern.test(h.trim().toLowerCase()));
    if (match) return match;
  }
  return '';
}

export function detectColumnMapping(headers: string[]): {
  mapping: ColumnMapping;
  status: 'auto' | 'needs-mapping';
} {
  const dateCol = findBestMatch(headers, [
    /^(transaction\s*date|trans\.?\s*date|posting\s*date|post\s*date|date)$/,
    /\b(trans(action)?\s*date|post(ing)?\s*date)\b/,
    /\bdate\b/,
  ]);

  const descriptionCol = findBestMatch(headers, [
    /^(description|transaction\s*description|memo|details|narrative|payee|merchant)$/,
    /\b(description|details|memo|payee|merchant|narrative)\b/,
    /\bname\b/,
  ]);

  const amountCol = findBestMatch(headers, [
    /^(amount|transaction\s*amount|amt|net\s*amount)$/,
    /\b(amount|amt)\b/,
  ]);

  const debitCol = findBestMatch(headers, [
    /^(debit|debit\s*amount|withdrawal|withdrawals|outflow|money\s*out)$/,
    /\b(debit|withdrawal)\b/,
  ]);

  const creditCol = findBestMatch(headers, [
    /^(credit|credit\s*amount|deposit|deposits|inflow|money\s*in)$/,
    /\b(credit|deposit)\b/,
  ]);

  const checkCol = findBestMatch(headers, [
    /^(check\s*#|check\s*number|check\s*no\.?|cheque\s*#|cheque\s*number|check)$/,
    /\b(check\s*#|check\s*num(ber)?|check\s*no|cheque)\b/,
  ]);

  const hasSplitCols = Boolean(debitCol && creditCol && debitCol !== creditCol);
  const amountMode: 'single' | 'split' = !amountCol && hasSplitCols ? 'split' : 'single';

  const mapping: ColumnMapping = {
    dateCol,
    descriptionCol,
    amountMode,
    amountCol,
    debitCol,
    creditCol,
    checkCol,
  };

  const hasValidAmount =
    amountMode === 'single' ? Boolean(amountCol) : Boolean(debitCol && creditCol);

  const isComplete =
    Boolean(dateCol) &&
    Boolean(descriptionCol) &&
    hasValidAmount &&
    dateCol !== descriptionCol;

  return {
    mapping,
    status: isComplete ? 'auto' : 'needs-mapping',
  };
}
