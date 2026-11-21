import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  CheckCategorizeRequest,
  CheckCategorizeResponse,
} from '../src/types/check.ts';
import { GOLD_CHECK_CATEGORY_EXAMPLES } from '../src/utils/checkCategorizer.ts';

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

async function generateWithRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('500') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('RESOURCE_EXHAUSTED');
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function buildCanonicalMap(values: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of values) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!map.has(key)) {
      map.set(key, trimmed);
    }
  }
  return map;
}

export async function categorizeChecksWithGemini(
  req: CheckCategorizeRequest
): Promise<CheckCategorizeResponse> {
  const checks = Array.isArray(req.checks) ? req.checks : [];
  if (checks.length === 0) {
    return { results: [] };
  }

  const expenseMap = buildCanonicalMap(req.expenseCategories ?? []);
  const incomeMap = buildCanonicalMap(req.incomeCategories ?? []);
  const expenseList = Array.from(expenseMap.values());
  const incomeList = Array.from(incomeMap.values());

  const resultsById = new Map<
    string,
    { id: string; category: string; confidence: 'high' | 'medium' | 'low'; reason: string }
  >();

  const toQuery: CheckCategorizeRequest['checks'] = [];

  for (const chk of checks) {
    const allowed = chk.transactionType === 'Income' ? incomeList : expenseList;
    const hasAnyText = Boolean(
      chk.memo?.trim() || chk.paidTo?.trim() || chk.paidBy?.trim()
    );
    if (allowed.length === 0 || !hasAnyText) {
      resultsById.set(chk.id, {
        id: chk.id,
        category: '',
        confidence: 'low',
        reason:
          allowed.length === 0
            ? `No LookUp categories available for ${chk.transactionType}.`
            : 'Abstained: Memo / For, Paid To, and Paid By are all empty.',
      });
    } else {
      toQuery.push(chk);
    }
  }

  if (toQuery.length === 0) {
    return {
      results: checks.map(
        (chk) =>
          resultsById.get(chk.id) ?? {
            id: chk.id,
            category: '',
            confidence: 'low',
            reason: 'Abstained.',
          }
      ),
    };
  }

  const ai = getGeminiClient();

  const mergedExamples = [
    ...GOLD_CHECK_CATEGORY_EXAMPLES.filter((ex) => {
      const map = ex.transactionType === 'Income' ? incomeMap : expenseMap;
      return map.has(ex.category.toLowerCase());
    }),
    ...(Array.isArray(req.historicalExamples) ? req.historicalExamples.slice(0, 20) : []),
  ];

  const CHUNK_SIZE = 25;
  for (let i = 0; i < toQuery.length; i += CHUNK_SIZE) {
    const chunk = toQuery.slice(i, i + CHUNK_SIZE);

    const promptPayload = {
      allowedExpenseCategories: expenseList,
      allowedIncomeCategories: incomeList,
      referenceExamples: mergedExamples,
      checksToCategorize: chunk.map((c) => ({
        id: c.id,
        transactionType: c.transactionType,
        amount: typeof c.amount === 'number' && Number.isFinite(c.amount) ? c.amount : null,
        memo: c.memo.trim(),
        paidTo: c.paidTo.trim(),
        paidBy: c.paidBy.trim(),
      })),
    };

    const response = await generateWithRetry(() =>
      ai.models.generateContent({
        model: DEFAULT_MODEL,
        contents: `Assign the exact LookUp Category for each check below without guessing or hallucinating.\n\n${JSON.stringify(
          promptPayload,
          null,
          2
        )}`,
        config: {
          systemInstruction: `You are a strict financial ledger check categorizer for Houston Durga Bari Society (HDBS).
For each item in checksToCategorize:
1. Primary signal is "memo" (Memo / For). Use "paidTo" and "paidBy" as supporting fallback context when "memo" is brief or sparse (for example, "KFC Grocery" + Paid To "World Food Warehouse" -> "Food", or "Ad" + Paid By LLC -> "Advertisement").
2. If transactionType is "Income", "paidTo" refers to Durga Bari (e.g., "HDBS", "Durga Bari", "Houston Durga Bari Society", "Houston Durgabari"), AND amount >= 1000, default to "Sponsorship" unless "memo" explicitly indicates another specific Income category such as "Advertisement" ("Ad"). Do NOT apply this default when amount < 1000.
3. Closed-set constraint:
   - If transactionType is "Expense", "category" MUST be copied verbatim from allowedExpenseCategories, or "" to abstain.
   - If transactionType is "Income", "category" MUST be copied verbatim from allowedIncomeCategories, or "" to abstain.
   - NEVER invent, reword, or combine category names, and NEVER pick an Expense category for an Income check or vice versa.
4. Strict abstention (NO HALLUCINATION):
   - If "memo" is empty, generic (e.g., "Payment", "Check", "Misc", "Reimbursement" with no category clue), or ambiguous across multiple categories (and does not match the Income + Paid To Durga Bari + amount >= 1000 -> Sponsorship rule), set "category" to "" and "confidence" to "low".
   - Only return "high" or "medium" confidence when there is clear semantic evidence pointing to a single category from the allowed list.
5. Keep "reason" concise (under 15 words).`,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              results: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    category: {
                      type: Type.STRING,
                      description:
                        'Exact category string from allowed list for this transactionType, or "" to abstain.',
                    },
                    confidence: {
                      type: Type.STRING,
                      enum: ['high', 'medium', 'low'],
                    },
                    reason: {
                      type: Type.STRING,
                      description: 'Short explanation of evidence or why abstained.',
                    },
                  },
                  required: ['id', 'category', 'confidence', 'reason'],
                },
              },
            },
            required: ['results'],
          },
        },
      })
    );

    const rawText = (response.text ?? '').trim();
    let parsed: { results?: Array<Record<string, unknown>> } = {};
    try {
      parsed = JSON.parse(rawText || '{"results":[]}');
    } catch {
      throw new Error('Check categorizer received invalid JSON output from Gemini.');
    }

    const chunkMap = new Map(chunk.map((c) => [c.id, c]));
    const items = Array.isArray(parsed.results) ? parsed.results : [];

    for (const item of items) {
      const id = String(item.id ?? '');
      const srcCheck = chunkMap.get(id);
      if (!srcCheck) continue;

      const allowedMap = srcCheck.transactionType === 'Income' ? incomeMap : expenseMap;
      const rawCat = String(item.category ?? '').trim();
      const canonicalCat = rawCat ? allowedMap.get(rawCat.toLowerCase()) ?? '' : '';

      const rawConf = String(item.confidence ?? '').toLowerCase();
      const confidence: 'high' | 'medium' | 'low' =
        rawConf === 'high' ? 'high' : rawConf === 'medium' ? 'medium' : 'low';

      const finalCat = canonicalCat && confidence !== 'low' ? canonicalCat : '';
      const reason =
        String(item.reason ?? '').trim() ||
        (finalCat
          ? `Matched "${finalCat}" from check details.`
          : 'Abstained: insufficient evidence.');

      resultsById.set(id, {
        id,
        category: finalCat,
        confidence: finalCat ? confidence : 'low',
        reason,
      });
    }
  }

  return {
    results: checks.map(
      (chk) =>
        resultsById.get(chk.id) ?? {
          id: chk.id,
          category: '',
          confidence: 'low',
          reason: 'Abstained: no result returned.',
        }
    ),
  };
}
