import path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { LedgerSnapshotPayload, SqlQueryAudit } from '../src/types/chatbot.ts';

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) =>
        path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
    });
  }
  return sqlJsPromise;
}

const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'REPLACE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'SAVEPOINT',
  'RELEASE',
  'ROLLBACK',
  'COMMIT',
  'BEGIN',
];

function stripSqlCommentsAndLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

export function validateReadOnlySql(rawSql: string): { valid: boolean; cleanedSql: string; error?: string } {
  const trimmed = rawSql
    .trim()
    .replace(/;+\s*$/, '')
    .trim();

  if (!trimmed) {
    return { valid: false, cleanedSql: '', error: 'SQL query is empty.' };
  }

  const sanitized = stripSqlCommentsAndLiterals(trimmed).trim();

  if (sanitized.includes(';')) {
    return {
      valid: false,
      cleanedSql: trimmed,
      error: 'Only a single read-only SELECT statement is allowed per query.',
    };
  }

  const firstWordMatch = /^([a-zA-Z_]+)/.exec(sanitized);
  const firstWord = firstWordMatch ? firstWordMatch[1].toUpperCase() : '';
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return {
      valid: false,
      cleanedSql: trimmed,
      error: `Only read-only SELECT or WITH queries are permitted (received "${firstWord || 'unknown'}").`,
    };
  }

  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(sanitized)) {
      return {
        valid: false,
        cleanedSql: trimmed,
        error: `Forbidden SQL keyword detected: ${kw}. Only read-only queries are allowed.`,
      };
    }
  }

  return { valid: true, cleanedSql: trimmed };
}

export interface SqlExecutionResult {
  columns: string[];
  rows: Array<Record<string, string | number>>;
  totalRowCount: number;
  truncated: boolean;
  audit: SqlQueryAudit;
}

export const SQL_SCHEMA_DESCRIPTION = `
Available SQLite tables (strictly read-only):

1. expense_ledger (rows from Expense_Ledger Google Sheet)
   - exp_id TEXT (unique ID, e.g. EXP-...)
   - puja TEXT (exact Puja tag from sheet, e.g. 'Puja', 'Regular', 'Durga Puja', etc.)
   - ledger_group TEXT ('Puja' or 'Regular')
   - date TEXT ('YYYY-MM-DD')
   - amount_cents INTEGER (exact amount in integer cents; ALWAYS aggregate with SUM(amount_cents) and divide by 100.0 for USD)
   - amount_usd REAL (exact dollar value = amount_cents / 100.0)
   - category TEXT
   - sub_category TEXT
   - status TEXT (exact status from sheet, e.g. 'Paid', 'Pending', 'Accepted')
   - normalized_status TEXT ('Paid', 'Pending', or 'Other')
   - payment_mode TEXT
   - description TEXT
   - recon_source TEXT
   - recon_source_id TEXT (Bank Unique Transaction ID when linked; empty string '' when unlinked)
   - is_linked INTEGER (1 if linked to Bank Ledger, 0 if unlinked)

2. bank_ledger (rows from Bank Statements Google Sheet 'Puja' and 'Regular' tabs)
   - unique_id TEXT (Bank Unique Transaction ID)
   - account_tab TEXT ('Puja' or 'Regular')
   - date TEXT ('YYYY-MM-DD')
   - amount_cents INTEGER (signed cents: negative for Expense, positive for Income)
   - abs_amount_cents INTEGER (positive integer cents magnitude; use this when summing expenses or income)
   - amount_usd REAL (positive dollar magnitude = abs_amount_cents / 100.0)
   - transaction_type TEXT ('Income' or 'Expense')
   - description TEXT
   - reference_number TEXT
   - source TEXT (e.g. 'Zelle', 'Check', 'Amazon', 'Home Depot', 'CARD9130', 'Deposit', 'Stripe', 'Other', etc.)
   - target_id TEXT (linked Exp_ID when reconciled; empty string '' when unlinked)
   - is_linked INTEGER (1 if linked to Expense Ledger, 0 if unlinked)

3. cat_subcat (mapping from CatSubcat tab)
   - category TEXT
   - sub_category TEXT
`.trim();

function buildInMemoryDatabase(SQL: SqlJsStatic, snapshot: LedgerSnapshotPayload): Database {
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE expense_ledger (
      exp_id TEXT,
      puja TEXT,
      ledger_group TEXT,
      date TEXT,
      amount_cents INTEGER,
      amount_usd REAL,
      category TEXT,
      sub_category TEXT,
      status TEXT,
      normalized_status TEXT,
      payment_mode TEXT,
      description TEXT,
      recon_source TEXT,
      recon_source_id TEXT,
      is_linked INTEGER
    );
    CREATE TABLE bank_ledger (
      unique_id TEXT,
      account_tab TEXT,
      date TEXT,
      amount_cents INTEGER,
      abs_amount_cents INTEGER,
      amount_usd REAL,
      transaction_type TEXT,
      description TEXT,
      reference_number TEXT,
      source TEXT,
      target_id TEXT,
      is_linked INTEGER
    );
    CREATE TABLE cat_subcat (
      category TEXT,
      sub_category TEXT
    );
  `);

  const expStmt = db.prepare(`
    INSERT INTO expense_ledger (
      exp_id, puja, ledger_group, date, amount_cents, amount_usd,
      category, sub_category, status, normalized_status,
      payment_mode, description, recon_source, recon_source_id, is_linked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.run('BEGIN TRANSACTION');
  try {
    for (const row of snapshot.expenses) {
      expStmt.run([
        row.expId,
        row.puja,
        row.ledgerGroup,
        row.date,
        row.amountCents,
        row.amountUsd,
        row.category,
        row.subCategory,
        row.status,
        row.normalizedStatus,
        row.paymentMode,
        row.description,
        row.reconSource,
        row.reconSourceId,
        row.isLinked ? 1 : 0,
      ]);
    }
    expStmt.free();

    const bankStmt = db.prepare(`
      INSERT INTO bank_ledger (
        unique_id, account_tab, date, amount_cents, abs_amount_cents,
        amount_usd, transaction_type, description, reference_number,
        source, target_id, is_linked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.bankTransactions) {
      bankStmt.run([
        row.uniqueId,
        row.accountTab,
        row.date,
        row.amountCents,
        row.absAmountCents,
        row.amountUsd,
        row.transactionType,
        row.description,
        row.referenceNumber,
        row.source,
        row.targetId,
        row.isLinked ? 1 : 0,
      ]);
    }
    bankStmt.free();

    const catStmt = db.prepare(`INSERT INTO cat_subcat (category, sub_category) VALUES (?, ?)`);
    for (const row of snapshot.catSubcats) {
      catStmt.run([row.category, row.subCategory]);
    }
    catStmt.free();

    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }

  return db;
}

const MAX_RETURNED_ROWS = 200;

export async function runReadOnlySqlOnSnapshot(
  snapshot: LedgerSnapshotPayload,
  rawSql: string,
  purpose: string
): Promise<SqlExecutionResult> {
  const startedAt = Date.now();
  const validation = validateReadOnlySql(rawSql);
  if (!validation.valid) {
    return {
      columns: [],
      rows: [],
      totalRowCount: 0,
      truncated: false,
      audit: {
        sql: rawSql,
        purpose,
        rowCount: 0,
        durationMs: Date.now() - startedAt,
        error: validation.error,
      },
    };
  }

  const SQL = await getSqlJs();
  const db = buildInMemoryDatabase(SQL, snapshot);

  try {
    const results = db.exec(validation.cleanedSql);
    const durationMs = Date.now() - startedAt;

    if (!results || results.length === 0) {
      return {
        columns: [],
        rows: [],
        totalRowCount: 0,
        truncated: false,
        audit: {
          sql: validation.cleanedSql,
          purpose,
          rowCount: 0,
          durationMs,
        },
      };
    }

    const firstResult = results[0];
    const columns = firstResult.columns;
    const totalRowCount = firstResult.values.length;
    const truncated = totalRowCount > MAX_RETURNED_ROWS;
    const slice = truncated ? firstResult.values.slice(0, MAX_RETURNED_ROWS) : firstResult.values;

    const rows: Array<Record<string, string | number>> = slice.map((vals) => {
      const obj: Record<string, string | number> = {};
      columns.forEach((col, idx) => {
        const val = vals[idx];
        if (val === null || val === undefined) {
          obj[col] = '';
        } else if (typeof val === 'number' || typeof val === 'string') {
          obj[col] = val;
        } else {
          obj[col] = String(val);
        }
      });
      return obj;
    });

    return {
      columns,
      rows,
      totalRowCount,
      truncated,
      audit: {
        sql: validation.cleanedSql,
        purpose,
        rowCount: totalRowCount,
        durationMs,
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorMsg = err instanceof Error ? err.message : 'SQL execution failed.';
    return {
      columns: [],
      rows: [],
      totalRowCount: 0,
      truncated: false,
      audit: {
        sql: validation.cleanedSql,
        purpose,
        rowCount: 0,
        durationMs,
        error: errorMsg,
      },
    };
  } finally {
    db.close();
  }
}
