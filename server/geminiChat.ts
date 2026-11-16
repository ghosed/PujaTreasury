import {
  type Content,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
  ThinkingLevel,
  Type,
} from '@google/genai';
import type {
  ChatApiRequest,
  ChatApiResponse,
  ChatTableData,
  DynamicChartSpec,
  SqlQueryAudit,
} from '../src/types/chatbot.ts';
import { runReadOnlySqlOnSnapshot, SQL_SCHEMA_DESCRIPTION } from './sqlEngine.ts';

const DEFAULT_MODEL = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const runSqlQueryTool: FunctionDeclaration = {
  name: 'run_sql_query',
  description:
    'Execute a read-only SQLite SELECT or WITH query over expense_ledger, bank_ledger, and cat_subcat. Always aggregate monetary columns using amount_cents or abs_amount_cents (exact integer cents) and convert via ROUND(SUM(...) / 100.0, 2).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      sql: {
        type: Type.STRING,
        description:
          'Single valid SQLite SELECT or WITH statement. Never use INSERT/UPDATE/DELETE/PRAGMA.',
      },
      purpose: {
        type: Type.STRING,
        description: 'Brief 4-10 word description of what this query measures.',
      },
    },
    required: ['sql', 'purpose'],
  },
};

const setVisualOutputTool: FunctionDeclaration = {
  name: 'set_visual_output',
  description:
    'Optional UI tool to attach an interactive chart (bar, pie, or line), a structured exportable table, and 2-3 follow-up prompts grounded in the SQL query outputs.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      chartType: {
        type: Type.STRING,
        description: "One of 'bar', 'pie', 'line', or 'none'.",
      },
      chartTitle: {
        type: Type.STRING,
        description: 'Short descriptive chart title.',
      },
      chartSubtitle: {
        type: Type.STRING,
        description: 'Optional subtitle indicating filter scope or period.',
      },
      xKey: {
        type: Type.STRING,
        description: 'Property name in chartData rows used as label/category/month.',
      },
      valueKey: {
        type: Type.STRING,
        description: 'Primary numeric property name in chartData rows.',
      },
      secondaryValueKey: {
        type: Type.STRING,
        description: 'Optional second numeric property name for grouped bar/line comparison.',
      },
      valueFormat: {
        type: Type.STRING,
        description: "Either 'currency' or 'count'.",
      },
      chartDataJson: {
        type: Type.STRING,
        description:
          'JSON array string of objects matching xKey and valueKey (e.g. [{"category":"Decorations","amount_usd":1250.5}]).',
      },
      tableColumns: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Ordered column names for an inline exportable table.',
      },
      currencyColumns: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Subset of tableColumns containing USD dollar numbers.',
      },
      tableRowsJson: {
        type: Type.STRING,
        description: 'JSON array string of row objects matching tableColumns.',
      },
      followUpPrompts: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: '2 to 3 concise follow-up questions the user might ask next.',
      },
    },
  },
};

function buildSystemInstruction(req: ChatApiRequest): string {
  const { filters, expenses, bankTransactions, categories, pujas } = req.snapshot;

  return `You are LedgerSync's financial analytics assistant for the Puja & Regular Expense and Bank Statement ledgers.
You operate in STRICTLY READ-ONLY mode. You NEVER invent, estimate, or mentally add dollar figures.

${SQL_SCHEMA_DESCRIPTION}

Current Loaded Snapshot Stats:
- expense_ledger rows: ${expenses.length}
- bank_ledger rows: ${bankTransactions.length}
- Categories in LookUp: ${categories.slice(0, 30).join(', ') || 'None'}
- Distinct Puja tags: ${pujas.join(', ') || 'Puja, Regular'}

Active Dashboard Filters (apply these by default in your SQL WHERE clauses UNLESS the user explicitly asks to compare across all tabs/statuses/links or asks for overall unfiltered totals):
- ledgerScope: ${filters.ledgerScope} (matches expense_ledger.ledger_group and bank_ledger.account_tab when not 'All')
- pujaTag: ${filters.pujaTag} (matches LOWER(expense_ledger.puja) when not 'all')
- paymentStatus: ${filters.paymentStatus} (matches expense_ledger.normalized_status when not 'All')
- linkState: ${filters.linkState} (matches is_linked = 1 for 'Linked' or is_linked = 0 for 'Unlinked' when not 'All')
- startDate: ${filters.startDate || 'none'}
- endDate: ${filters.endDate || 'none'}

Rules:
1. ALWAYS call \`run_sql_query\` before answering any question about counts, totals, categories, sub-categories, bank sources, reconciliation gaps, or specific transactions.
2. ALWAYS aggregate monetary sums on \`amount_cents\` (or \`abs_amount_cents\` on bank_ledger) and format USD via \`ROUND(SUM(amount_cents) / 100.0, 2)\` in SQL so numbers are penny-exact.
3. For Bank Expenses vs Bank Income, always check \`transaction_type = 'Expense'\` vs \`transaction_type = 'Income'\` on \`bank_ledger\`.
4. If a SQL query returns an error, read the error message, fix your SQL syntax or column name, and call \`run_sql_query\` again.
5. Whenever the user asks for a chart (bar chart, pie chart, trend line) OR your query returns a multi-row breakdown/list that benefits from visualization or CSV export, call \`set_visual_output\` with the exact values returned by \`run_sql_query\` plus 2–3 helpful follow-up prompts.
6. Keep your final text response concise, factual, and formatted in clean Markdown with exact USD amounts ($X,XXX.XX). Never fabricate columns or numbers not observed in tool results.`;
}

function safeParseJsonArray(raw: unknown): Array<Record<string, string | number>> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is Record<string, string | number> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item))
    );
  } catch {
    return null;
  }
}

function inferCurrencyColumns(columns: string[]): string[] {
  return columns.filter((col) => {
    const lower = col.toLowerCase();
    return (
      lower.includes('usd') ||
      lower.includes('amount') ||
      lower.includes('total') ||
      lower.includes('paid') ||
      lower.includes('pending') ||
      lower.includes('unlinked') ||
      lower.includes('linked') ||
      lower.includes('balance') ||
      lower.includes('spend') ||
      lower.includes('income') ||
      lower.includes('expense')
    ) && !lower.includes('cents') && !lower.includes('count') && !lower.includes('pct');
  });
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (rawMessage.includes('403') || rawMessage.includes('PERMISSION_DENIED')) {
    return {
      status: 403,
      message: 'Gemini API permission denied. Please verify GEMINI_API_KEY in Settings > Secrets.',
    };
  }
  if (rawMessage.includes('400') || rawMessage.includes('API_KEY_INVALID')) {
    return {
      status: 400,
      message: 'Gemini API request or API key is invalid. Check Settings > Secrets.',
    };
  }
  if (rawMessage.includes('429') || rawMessage.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message: 'Gemini API rate limit reached. Please wait a moment and try again.',
    };
  }
  if (rawMessage.includes('404') || rawMessage.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: 'Configured Gemini model was not found. Please check server model configuration.',
    };
  }
  return {
    status: 500,
    message: rawMessage || 'Unexpected error communicating with Gemini.',
  };
}

export async function handleChatRequest(req: ChatApiRequest): Promise<ChatApiResponse> {
  const ai = getGeminiClient();
  const systemInstruction = buildSystemInstruction(req);

  const contents: Content[] = [];
  const recentHistory = (req.history ?? []).slice(-10);
  for (const item of recentHistory) {
    if (!item.text?.trim()) continue;
    contents.push({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: item.text }],
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: req.message }],
  });

  const sqlQueries: SqlQueryAudit[] = [];
  let lastSuccessfulTable: ChatTableData | null = null;
  let explicitChartSpec: DynamicChartSpec | null = null;
  let explicitTableData: ChatTableData | null = null;
  let followUpPrompts: string[] = [];

  const MAX_TOOL_TURNS = 6;
  let finalAnswer = '';

  for (let step = 0; step < MAX_TOOL_TURNS; step++) {
    const response = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        tools: [{ functionDeclarations: [runSqlQueryTool, setVisualOutputTool] }],
      },
    });

    const candidateContent = response.candidates?.[0]?.content;
    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      finalAnswer = (response.text ?? '').trim();
      break;
    }

    if (candidateContent) {
      contents.push(candidateContent);
    }

    const functionResponseParts: Part[] = [];

    for (const fc of functionCalls) {
      const args = (fc.args ?? {}) as Record<string, unknown>;

      if (fc.name === 'run_sql_query') {
        const sql = String(args.sql ?? '');
        const purpose = String(args.purpose ?? 'Query ledger data');
        const result = await runReadOnlySqlOnSnapshot(req.snapshot, sql, purpose);
        sqlQueries.push(result.audit);

        if (!result.audit.error && result.columns.length > 0 && result.rows.length > 0) {
          lastSuccessfulTable = {
            columns: result.columns,
            currencyColumns: inferCurrencyColumns(result.columns),
            rows: result.rows,
          };
        }

        const responsePayload = result.audit.error
          ? {
              ok: false,
              error: result.audit.error,
              schemaHint: SQL_SCHEMA_DESCRIPTION,
            }
          : {
              ok: true,
              columns: result.columns,
              totalRowCount: result.totalRowCount,
              truncated: result.truncated,
              rows: result.rows,
            };

        functionResponseParts.push({
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: responsePayload,
          },
        });
      } else if (fc.name === 'set_visual_output') {
        const chartTypeRaw = String(args.chartType ?? 'none').toLowerCase();
        const chartData = safeParseJsonArray(args.chartDataJson);

        if (
          (chartTypeRaw === 'bar' || chartTypeRaw === 'pie' || chartTypeRaw === 'line') &&
          chartData &&
          chartData.length > 0
        ) {
          const xKey = String(args.xKey ?? Object.keys(chartData[0])[0] ?? 'label');
          const valueKey = String(args.valueKey ?? Object.keys(chartData[0])[1] ?? 'value');
          const secondaryValueKey = args.secondaryValueKey
            ? String(args.secondaryValueKey)
            : undefined;
          const valueFormat = args.valueFormat === 'count' ? 'count' : 'currency';

          explicitChartSpec = {
            chartType: chartTypeRaw,
            title: String(args.chartTitle ?? 'Ledger Breakdown'),
            subtitle: args.chartSubtitle ? String(args.chartSubtitle) : undefined,
            xKey,
            valueKey,
            secondaryValueKey,
            valueFormat,
            data: chartData,
          };
        }

        const tableRows = safeParseJsonArray(args.tableRowsJson);
        const tableCols = Array.isArray(args.tableColumns)
          ? args.tableColumns.map(String).filter(Boolean)
          : tableRows && tableRows.length > 0
            ? Object.keys(tableRows[0])
            : [];

        if (tableRows && tableRows.length > 0 && tableCols.length > 0) {
          const explicitCurrencyCols = Array.isArray(args.currencyColumns)
            ? args.currencyColumns.map(String)
            : inferCurrencyColumns(tableCols);
          explicitTableData = {
            columns: tableCols,
            currencyColumns: explicitCurrencyCols,
            rows: tableRows,
          };
        }

        if (Array.isArray(args.followUpPrompts)) {
          followUpPrompts = args.followUpPrompts
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 3);
        }

        functionResponseParts.push({
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: { ok: true, attached: true },
          },
        });
      }
    }

    contents.push({
      role: 'user',
      parts: functionResponseParts,
    });
  }

  if (!finalAnswer) {
    const fallbackResp = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    finalAnswer = (fallbackResp.text ?? 'Query completed.').trim();
  }

  const finalTable = explicitTableData ?? lastSuccessfulTable;

  if (followUpPrompts.length === 0) {
    followUpPrompts = [
      'Show unlinked Bank expenses grouped by Source',
      'Compare Paid vs Pending expenses by Category',
      'Plot monthly spending trend as a bar chart',
    ];
  }

  return {
    answer: finalAnswer,
    sqlQueries,
    chartSpec: explicitChartSpec,
    tableData: finalTable,
    followUpPrompts,
  };
}

export { formatGeminiError };
