import {
  AmazonCategorizeHistoricalExample,
  AmazonCategorizeInput,
  AmazonCategorizeResponse,
  AmazonCategorizeSuggestion,
  AmazonOrderRecord,
} from '../types/amazon';

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCanonicalMap(options: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of options) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!map.has(key)) {
      map.set(key, trimmed);
    }
  }
  return map;
}

function findMatchingAllowedCategory(
  allowedMap: Map<string, string>,
  candidates: string[]
): string | null {
  for (const cand of candidates) {
    const exact = allowedMap.get(cand.trim().toLowerCase());
    if (exact) return exact;
  }
  for (const [, exactCat] of allowedMap.entries()) {
    const lowerCat = exactCat.toLowerCase();
    if (candidates.some((c) => lowerCat.startsWith(c.toLowerCase()))) {
      return exactCat;
    }
  }
  return null;
}

export interface AmazonCategorizationHistory {
  descriptionMap: Map<string, Set<string>>;
  llmExamples: AmazonCategorizeHistoricalExample[];
}

export function buildAmazonCategorizationHistory(
  records: AmazonOrderRecord[],
  expenseCategories: string[]
): AmazonCategorizationHistory {
  const allowedMap = buildCanonicalMap(expenseCategories);
  const descriptionMap = new Map<string, Set<string>>();
  const llmExamples: AmazonCategorizeHistoricalExample[] = [];
  const seenExampleKeys = new Set<string>();

  for (const rec of records) {
    if (rec.isDuplicate) continue;
    const rawCat = (rec.category ?? '').trim();
    if (!rawCat) continue;
    const canonicalCat = allowedMap.get(rawCat.toLowerCase());
    if (!canonicalCat) continue;

    const normDesc = normalizeText(rec.itemDescription);
    if (normDesc.length < 3) continue;

    const set = descriptionMap.get(normDesc) ?? new Set<string>();
    set.add(canonicalCat);
    descriptionMap.set(normDesc, set);

    const exKey = `${normDesc}::${canonicalCat.toLowerCase()}`;
    if (!seenExampleKeys.has(exKey) && llmExamples.length < 25) {
      seenExampleKeys.add(exKey);
      llmExamples.push({
        itemDescription: rec.itemDescription.trim(),
        category: canonicalCat,
      });
    }
  }

  return { descriptionMap, llmExamples };
}

export function runDeterministicAmazonCategorizer(
  input: AmazonCategorizeInput,
  expenseCategories: string[],
  history: AmazonCategorizationHistory
): AmazonCategorizeSuggestion | null {
  const allowedMap = buildCanonicalMap(expenseCategories);
  if (allowedMap.size === 0) {
    return {
      id: input.id,
      category: '',
      confidence: 'low',
      method: 'abstained',
      reason: 'No expense categories found in LookUp tab.',
    };
  }

  const rawDesc = input.itemDescription.trim();
  const normDesc = normalizeText(rawDesc);

  if (!normDesc) {
    return {
      id: input.id,
      category: '',
      confidence: 'low',
      method: 'abstained',
      reason: 'Item Description is blank.',
    };
  }

  // 1. Exact LookUp category match
  for (const [, exactCat] of allowedMap.entries()) {
    if (normalizeText(exactCat) === normDesc) {
      return {
        id: input.id,
        category: exactCat,
        confidence: 'high',
        method: 'deterministic-exact',
        reason: `Item matches LookUp category "${exactCat}".`,
      };
    }
  }

  // 2. Unambiguous historical Item Description match from Amazon_Ledger
  const histSet = history.descriptionMap.get(normDesc);
  if (histSet && histSet.size === 1) {
    const cat = Array.from(histSet)[0];
    return {
      id: input.id,
      category: cat,
      confidence: 'high',
      method: 'historical-description',
      reason: `Matches prior categorized order with identical item description.`,
    };
  }

  // 3. Unique whole-word LookUp category inclusion inside Item Description
  const includedCats: string[] = [];
  for (const [, exactCat] of allowedMap.entries()) {
    const catNorm = normalizeText(exactCat);
    if (catNorm.length < 3) continue;
    const rx = new RegExp(`(?:^|\\s)${escapeRegExp(catNorm)}(?:\\s|$)`, 'i');
    if (rx.test(normDesc)) {
      includedCats.push(exactCat);
    }
  }
  if (includedCats.length === 1) {
    return {
      id: input.id,
      category: includedCats[0],
      confidence: 'high',
      method: 'deterministic-exact',
      reason: `Item Description directly contains "${includedCats[0]}".`,
    };
  }

  // 4. Domain keyword rules calibrated to LookUp categories
  const keywordRules: Array<{
    pattern: RegExp;
    candidates: string[];
    reason: string;
  }> = [
    {
      pattern: /\bregistrat|\bbadge|\bwristband|\blanyard/i,
      candidates: ['Registration'],
      reason: 'Item Description indicates Registration supplies/signage.',
    },
    {
      pattern: /\bneon sign|\bled\b.*\bsign|\bdecor|\bbanner|\bgarland|\bflower|\bbunch|\bfestoon|\blichting\b|\bbackdrop|\bcurtain\b/i,
      candidates: ['Decoration', 'Decorations'],
      reason: 'Item Description indicates Decoration / signage.',
    },
    {
      pattern: /\bsnack|\bfood|\bkitchen|\bpantry|\bgrocer|\bplate|\bnapkin|\bcup\b|\bcups\b|\bcutlery|\bfork|\bspoon|\butensil|\bchafing|\bfood tray|\bwater bottle|\bbeverage/i,
      candidates: ['Food', 'Food & Prasad', 'Prasad'],
      reason: 'Item Description indicates Food / Kitchen / Serving supplies.',
    },
    {
      pattern: /\bpuja|\bpooja|\bpujo|\bdiya|\bincense|\bagarbatti|\bcamphor|\baarti|\bkalash|\bmurti|\bidol|\bthali/i,
      candidates: ['Puja', 'Puja Items', 'Temple'],
      reason: 'Item Description indicates Puja / Temple supplies.',
    },
    {
      pattern: /\bclean|\btrash bag|\bgarbage bag|\bdisinfect|\bsanitizer|\bpaper towel|\bmop|\bbroom/i,
      candidates: ['Cleaning', 'Maintenance', 'Supplies', 'Facility'],
      reason: 'Item Description indicates Cleaning / Maintenance supplies.',
    },
  ];

  for (const rule of keywordRules) {
    if (rule.pattern.test(normDesc)) {
      const match = findMatchingAllowedCategory(allowedMap, rule.candidates);
      if (match) {
        return {
          id: input.id,
          category: match,
          confidence: 'high',
          method: 'deterministic-keyword',
          reason: rule.reason,
        };
      }
    }
  }

  return null;
}

export async function categorizeAmazonHybrid(params: {
  items: AmazonCategorizeInput[];
  expenseCategories: string[];
  existingRecords: AmazonOrderRecord[];
}): Promise<Map<string, AmazonCategorizeSuggestion>> {
  const { items, expenseCategories, existingRecords } = params;
  const results = new Map<string, AmazonCategorizeSuggestion>();
  if (items.length === 0) return results;

  const allowedMap = buildCanonicalMap(expenseCategories);
  const history = buildAmazonCategorizationHistory(existingRecords, expenseCategories);

  const unresolvedForLlm: AmazonCategorizeInput[] = [];

  for (const item of items) {
    const deterministic = runDeterministicAmazonCategorizer(
      item,
      expenseCategories,
      history
    );
    if (deterministic) {
      results.set(item.id, deterministic);
    } else {
      unresolvedForLlm.push(item);
    }
  }

  if (unresolvedForLlm.length === 0) {
    return results;
  }

  const resp = await fetch('/api/amazon/categorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: unresolvedForLlm,
      expenseCategories: Array.from(allowedMap.values()),
      historicalExamples: history.llmExamples,
    }),
  });

  const payload = (await resp.json().catch(() => ({}))) as Partial<AmazonCategorizeResponse> & {
    error?: string;
  };
  if (!resp.ok) {
    throw new Error(payload.error || `Auto-categorization failed (${resp.status})`);
  }

  const llmItems = Array.isArray(payload.results) ? payload.results : [];
  const llmById = new Map(llmItems.map((it) => [it.id, it]));

  for (const item of unresolvedForLlm) {
    const raw = llmById.get(item.id);
    if (!raw) {
      results.set(item.id, {
        id: item.id,
        category: '',
        confidence: 'low',
        method: 'abstained',
        reason: 'Abstained: no match returned.',
      });
      continue;
    }

    const canonical = raw.category
      ? allowedMap.get(String(raw.category).trim().toLowerCase()) ?? ''
      : '';
    const conf =
      raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low';

    if (!canonical || conf === 'low') {
      results.set(item.id, {
        id: item.id,
        category: '',
        confidence: 'low',
        method: 'abstained',
        reason:
          raw.reason?.trim() ||
          'Abstained: item description too ambiguous to assign safely.',
      });
    } else {
      results.set(item.id, {
        id: item.id,
        category: canonical,
        confidence: conf,
        method: 'llm',
        reason: raw.reason?.trim() || 'Matched via strict constrained AI.',
      });
    }
  }

  return results;
}
