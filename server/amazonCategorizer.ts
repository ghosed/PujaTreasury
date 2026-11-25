import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AmazonCategorizeRequest,
  AmazonCategorizeResponse,
} from '../src/types/amazon.ts';

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

export async function categorizeAmazonWithGemini(
  req: AmazonCategorizeRequest
): Promise<AmazonCategorizeResponse> {
  const items = Array.isArray(req.items) ? req.items : [];
  if (items.length === 0) {
    return { results: [] };
  }

  const expenseMap = buildCanonicalMap(req.expenseCategories ?? []);
  const expenseList = Array.from(expenseMap.values());

  const resultsById = new Map<
    string,
    { id: string; category: string; confidence: 'high' | 'medium' | 'low'; reason: string }
  >();

  const toQuery: AmazonCategorizeRequest['items'] = [];

  for (const item of items) {
    if (expenseList.length === 0 || !item.itemDescription?.trim()) {
      resultsById.set(item.id, {
        id: item.id,
        category: '',
        confidence: 'low',
        reason:
          expenseList.length === 0
            ? 'No expense categories found in LookUp tab.'
            : 'Abstained: Item Description is blank.',
      });
    } else {
      toQuery.push(item);
    }
  }

  if (toQuery.length === 0) {
    return {
      results: items.map(
        (it) =>
          resultsById.get(it.id) ?? {
            id: it.id,
            category: '',
            confidence: 'low',
            reason: 'Abstained.',
          }
      ),
    };
  }

  const ai = getGeminiClient();

  const CHUNK_SIZE = 25;
  for (let i = 0; i < toQuery.length; i += CHUNK_SIZE) {
    const chunk = toQuery.slice(i, i + CHUNK_SIZE);

    const promptPayload = {
      allowedExpenseCategories: expenseList,
      historicalExamples: Array.isArray(req.historicalExamples)
        ? req.historicalExamples.slice(0, 25)
        : [],
      ordersToCategorize: chunk.map((it) => ({
        id: it.id,
        itemDescription: it.itemDescription.trim(),
        total: typeof it.total === 'number' && Number.isFinite(it.total) ? it.total : null,
        shippedTo: (it.shippedTo ?? '').trim(),
      })),
    };

    const response = await generateWithRetry(() =>
      ai.models.generateContent({
        model: DEFAULT_MODEL,
        contents: `Assign the exact LookUp Expense Category for each Amazon order item based on its Item Description.\n\n${JSON.stringify(
          promptPayload,
          null,
          2
        )}`,
        config: {
          systemInstruction: `You are a strict financial ledger item categorizer for Houston Durga Bari Society (HDBS).
For each item in ordersToCategorize:
1. Primary signal is "itemDescription" (e.g., Neon signs/banners/garlands -> Decoration or Cultural/Registration if matching LookUp; kitchen/snacks/food/plates -> Food; puja supplies -> Puja / Temple; etc., strictly choosing from allowedExpenseCategories).
2. Closed-set constraint:
   - "category" MUST be copied verbatim from allowedExpenseCategories, or "" to abstain.
   - NEVER invent, reword, or combine category names.
3. Strict abstention:
   - If itemDescription is too generic or ambiguous to map cleanly to one allowed category, return "" with confidence "low".
   - Only return "high" or "medium" confidence when semantic evidence clearly points to a single category from allowedExpenseCategories.
4. Keep "reason" concise (under 15 words).`,
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
                        'Exact category string from allowedExpenseCategories, or "" to abstain.',
                    },
                    confidence: {
                      type: Type.STRING,
                      enum: ['high', 'medium', 'low'],
                    },
                    reason: {
                      type: Type.STRING,
                      description: 'Short explanation or why abstained.',
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
      throw new Error('Amazon categorizer received invalid JSON output from Gemini.');
    }

    const chunkMap = new Map(chunk.map((c) => [c.id, c]));
    const respItems = Array.isArray(parsed.results) ? parsed.results : [];

    for (const item of respItems) {
      const id = String(item.id ?? '');
      const src = chunkMap.get(id);
      if (!src) continue;

      const rawCat = String(item.category ?? '').trim();
      const canonicalCat = rawCat ? expenseMap.get(rawCat.toLowerCase()) ?? '' : '';

      const rawConf = String(item.confidence ?? '').toLowerCase();
      const confidence: 'high' | 'medium' | 'low' =
        rawConf === 'high' ? 'high' : rawConf === 'medium' ? 'medium' : 'low';

      const finalCat = canonicalCat && confidence !== 'low' ? canonicalCat : '';
      const reason =
        String(item.reason ?? '').trim() ||
        (finalCat
          ? `Matched "${finalCat}" from item description.`
          : 'Abstained: item description too ambiguous.');

      resultsById.set(id, {
        id,
        category: finalCat,
        confidence: finalCat ? confidence : 'low',
        reason,
      });
    }
  }

  return {
    results: items.map(
      (it) =>
        resultsById.get(it.id) ?? {
          id: it.id,
          category: '',
          confidence: 'low',
          reason: 'Abstained: no result returned.',
        }
    ),
  };
}
