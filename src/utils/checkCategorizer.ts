import {
  CheckCategorizeHistoricalExample,
  CheckCategorizeInput,
  CheckCategorizeResponse,
  CheckCategorizeSuggestion,
  CheckRecord,
  CheckTransactionType,
} from '../types/check';

export const GOLD_CHECK_CATEGORY_EXAMPLES: CheckCategorizeHistoricalExample[] = [
  {
    memo: 'Ad',
    transactionType: 'Income',
    paidTo: 'Durga Bari',
    paidBy: 'SUKOON HOSPITALITY LLC',
    category: 'Advertisement',
  },
  {
    memo: 'Decoration',
    transactionType: 'Expense',
    paidTo: 'Nivedita Hati',
    paidBy: 'Houston Durga Bari Society',
    category: 'Decoration',
  },
  {
    memo: 'Registration & Printing',
    transactionType: 'Expense',
    paidTo: 'Subhas Das',
    paidBy: 'Houston Durga Bari Society',
    category: 'Registration',
  },
  {
    memo: 'KFC Grocery',
    transactionType: 'Expense',
    paidTo: 'World Food Warehouse',
    paidBy: 'Houston Durga Bari Society',
    category: 'Food',
  },
  {
    memo: 'FOR CHURO $8,000 AND GENERAL FUND $2,000',
    transactionType: 'Income',
    paidTo: 'HDBS',
    paidBy: 'ASOKE KUMAR DEYSARKAR',
    category: 'Sponsorship',
  },
];

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

export interface CheckCategorizationHistory {
  memoMap: Map<string, Set<string>>;
  counterpartyMap: Map<string, Set<string>>;
  llmExamples: CheckCategorizeHistoricalExample[];
}

export function buildCheckCategorizationHistory(
  records: CheckRecord[],
  expenseCategories: string[],
  incomeCategories: string[]
): CheckCategorizationHistory {
  const expenseMap = buildCanonicalMap(expenseCategories);
  const incomeMap = buildCanonicalMap(incomeCategories);

  const memoMap = new Map<string, Set<string>>();
  const counterpartyMap = new Map<string, Set<string>>();
  const llmExamples: CheckCategorizeHistoricalExample[] = [];
  const seenExampleKeys = new Set<string>();

  for (const rec of records) {
    if (rec.isDuplicate) continue;
    const rawCat = (rec.category ?? '').trim();
    if (!rawCat) continue;

    const allowedMap = rec.transactionType === 'Income' ? incomeMap : expenseMap;
    const canonicalCat = allowedMap.get(rawCat.toLowerCase());
    if (!canonicalCat) continue;

    const normMemo = normalizeText(rec.memo);
    const normPaidTo = normalizeText(rec.paidTo);
    const normPaidBy = normalizeText(rec.paidBy);

    if (normMemo.length >= 2) {
      const mKey = `${rec.transactionType}::${normMemo}`;
      const set = memoMap.get(mKey) ?? new Set<string>();
      set.add(canonicalCat);
      memoMap.set(mKey, set);

      const exKey = `${rec.transactionType}::${normMemo}::${canonicalCat.toLowerCase()}`;
      if (!seenExampleKeys.has(exKey) && llmExamples.length < 20) {
        seenExampleKeys.add(exKey);
        llmExamples.push({
          transactionType: rec.transactionType,
          memo: rec.memo.trim(),
          paidTo: rec.paidTo.trim(),
          paidBy: rec.paidBy.trim(),
          category: canonicalCat,
        });
      }
    }

    if (normPaidTo || normPaidBy) {
      const cKey = `${rec.transactionType}::${normPaidTo}::${normPaidBy}`;
      const set = counterpartyMap.get(cKey) ?? new Set<string>();
      set.add(canonicalCat);
      counterpartyMap.set(cKey, set);
    }
  }

  return { memoMap, counterpartyMap, llmExamples };
}

function isMemoSparse(memo: string): boolean {
  const norm = normalizeText(memo);
  if (!norm) return true;
  if (norm.length <= 3) return true;
  if (/^(check|chk|payment|pay|for|misc|other|na|n a|none)$/i.test(norm)) {
    return true;
  }
  return false;
}

function isDurgaBariPayee(normPaidTo: string): boolean {
  if (!normPaidTo) return false;
  const compact = normPaidTo.replace(/\s+/g, '');
  return (
    compact.includes('durgabari') ||
    /\bdurga\s*bari\b/i.test(normPaidTo) ||
    /\bhdbs\b/i.test(normPaidTo)
  );
}

export function runDeterministicCheckCategorizer(
  input: CheckCategorizeInput,
  allowedCategories: string[],
  history: CheckCategorizationHistory
): CheckCategorizeSuggestion | null {
  const allowedMap = buildCanonicalMap(allowedCategories);
  if (allowedMap.size === 0) {
    return {
      id: input.id,
      category: '',
      confidence: 'low',
      method: 'abstained',
      reason: `No LookUp categories loaded for ${input.transactionType}.`,
    };
  }

  const rawMemo = input.memo.trim();
  const normMemo = normalizeText(rawMemo);
  const normPaidTo = normalizeText(input.paidTo);
  const normPaidBy = normalizeText(input.paidBy);

  // If all fields are empty, abstain deterministically without calling the LLM
  if (!normMemo && !normPaidTo && !normPaidBy) {
    return {
      id: input.id,
      category: '',
      confidence: 'low',
      method: 'abstained',
      reason: 'Memo / For, Paid To, and Paid By are all blank.',
    };
  }

  if (normMemo) {
    // 1. Exact LookUp category match in Memo / For
    for (const [, exactCat] of allowedMap.entries()) {
      if (normalizeText(exactCat) === normMemo) {
        return {
          id: input.id,
          category: exactCat,
          confidence: 'high',
          method: 'deterministic-exact',
          reason: `Memo "${rawMemo}" exactly matches LookUp category "${exactCat}".`,
        };
      }
    }

    // 2. Unique whole-word/phrase LookUp category inclusion in Memo / For
    const includedCats: string[] = [];
    for (const [, exactCat] of allowedMap.entries()) {
      const catNorm = normalizeText(exactCat);
      if (catNorm.length < 3) continue;
      const rx = new RegExp(`(?:^|\\s)${escapeRegExp(catNorm)}(?:\\s|$)`, 'i');
      if (rx.test(normMemo)) {
        includedCats.push(exactCat);
      }
    }
    if (includedCats.length === 1) {
      return {
        id: input.id,
        category: includedCats[0],
        confidence: 'high',
        method: 'deterministic-exact',
        reason: `Memo "${rawMemo}" directly contains "${includedCats[0]}".`,
      };
    }

    // 3. Explicit domain rules calibrated from LookUp examples
    if (input.transactionType === 'Income') {
      if (/\bads?\b|\badvertis/i.test(normMemo)) {
        const match = findMatchingAllowedCategory(allowedMap, [
          'Advertisement',
          'Advertising',
          'Ads',
        ]);
        if (match) {
          return {
            id: input.id,
            category: match,
            confidence: 'high',
            method: 'deterministic-keyword',
            reason: `Income memo "${rawMemo}" indicates Advertisement.`,
          };
        }
      }
      if (/\bchuro\b|\bsponsor|\bgeneral fund\b/i.test(normMemo)) {
        const match = findMatchingAllowedCategory(allowedMap, ['Sponsorship', 'Sponsor']);
        if (match) {
          return {
            id: input.id,
            category: match,
            confidence: 'high',
            method: 'deterministic-keyword',
            reason: `Income memo "${rawMemo}" matches Sponsorship fund pattern.`,
          };
        }
      }
    } else {
      if (/\bdecorat/i.test(normMemo)) {
        const match = findMatchingAllowedCategory(allowedMap, ['Decoration', 'Decorations']);
        if (match) {
          return {
            id: input.id,
            category: match,
            confidence: 'high',
            method: 'deterministic-keyword',
            reason: `Expense memo "${rawMemo}" indicates Decoration.`,
          };
        }
      }
      if (/\bregistrat/i.test(normMemo)) {
        const match = findMatchingAllowedCategory(allowedMap, ['Registration']);
        if (match) {
          return {
            id: input.id,
            category: match,
            confidence: 'high',
            method: 'deterministic-keyword',
            reason: `Expense memo "${rawMemo}" indicates Registration.`,
          };
        }
      }
      if (/\bgrocer|\bfood\b|\bprasad|\bbhog|\bcater|\bkfc\b/i.test(normMemo)) {
        const match = findMatchingAllowedCategory(allowedMap, ['Food', 'Food & Prasad', 'Prasad']);
        if (match) {
          return {
            id: input.id,
            category: match,
            confidence: 'high',
            method: 'deterministic-keyword',
            reason: `Expense memo "${rawMemo}" indicates Food / Grocery.`,
          };
        }
      }
    }

    // 4. Unambiguous historical Memo match in Check_Ledger
    const histMemoSet = history.memoMap.get(`${input.transactionType}::${normMemo}`);
    if (histMemoSet && histMemoSet.size === 1) {
      const cat = Array.from(histMemoSet)[0];
      return {
        id: input.id,
        category: cat,
        confidence: 'high',
        method: 'historical-memo',
        reason: `Matches prior categorized check with memo "${rawMemo}".`,
      };
    }
  }

  // 5. Fallback context: sparse Memo + unambiguous historical Paid To / Paid By
  if (isMemoSparse(rawMemo) && (normPaidTo || normPaidBy)) {
    const cKey = `${input.transactionType}::${normPaidTo}::${normPaidBy}`;
    const histPartySet = history.counterpartyMap.get(cKey);
    if (histPartySet && histPartySet.size === 1) {
      const cat = Array.from(histPartySet)[0];
      return {
        id: input.id,
        category: cat,
        confidence: 'medium',
        method: 'historical-counterparty',
        reason: `Sparse memo; matches prior check history for ${input.transactionType === 'Expense' ? input.paidTo || input.paidBy : input.paidBy || input.paidTo}.`,
      };
    }

    // Expense fallback vendor signal for food warehouse when memo is sparse
    if (input.transactionType === 'Expense' && /\bfood warehouse\b|\bgrocery\b/i.test(normPaidTo)) {
      const match = findMatchingAllowedCategory(allowedMap, ['Food', 'Food & Prasad']);
      if (match) {
        return {
          id: input.id,
          category: match,
          confidence: 'medium',
          method: 'deterministic-keyword',
          reason: `Sparse memo with grocery/food vendor "${input.paidTo.trim()}".`,
        };
      }
    }
  }

  // 6. Income + Paid To is Durga Bari / HDBS + Amount >= $1,000 -> Sponsorship
  // (when Memo / For did not match a more specific category like Ad -> Advertisement)
  const hasMinSponsorshipAmount =
    typeof input.amount === 'number' &&
    Number.isFinite(input.amount) &&
    Math.abs(input.amount) >= 1000;

  if (
    input.transactionType === 'Income' &&
    hasMinSponsorshipAmount &&
    isDurgaBariPayee(normPaidTo)
  ) {
    const match = findMatchingAllowedCategory(allowedMap, ['Sponsorship', 'Sponsor']);
    if (match) {
      return {
        id: input.id,
        category: match,
        confidence: 'high',
        method: 'deterministic-keyword',
        reason: `Income check >= $1,000 Paid To "${input.paidTo.trim()}" (Durga Bari) matches Sponsorship rule.`,
      };
    }
  }

  return null;
}

export async function categorizeChecksHybrid(params: {
  checks: CheckCategorizeInput[];
  expenseCategories: string[];
  incomeCategories: string[];
  existingRecords: CheckRecord[];
}): Promise<Map<string, CheckCategorizeSuggestion>> {
  const { checks, expenseCategories, incomeCategories, existingRecords } = params;
  const results = new Map<string, CheckCategorizeSuggestion>();
  if (checks.length === 0) return results;

  const expenseMap = buildCanonicalMap(expenseCategories);
  const incomeMap = buildCanonicalMap(incomeCategories);
  const history = buildCheckCategorizationHistory(
    existingRecords,
    expenseCategories,
    incomeCategories
  );

  const unresolvedForLlm: CheckCategorizeInput[] = [];

  for (const chk of checks) {
    const allowedList =
      chk.transactionType === 'Income' ? incomeCategories : expenseCategories;
    const deterministic = runDeterministicCheckCategorizer(chk, allowedList, history);
    if (deterministic) {
      results.set(chk.id, deterministic);
    } else {
      unresolvedForLlm.push(chk);
    }
  }

  if (unresolvedForLlm.length === 0) {
    return results;
  }

  const resp = await fetch('/api/checks/categorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checks: unresolvedForLlm,
      expenseCategories: Array.from(expenseMap.values()),
      incomeCategories: Array.from(incomeMap.values()),
      historicalExamples: history.llmExamples,
    }),
  });

  const payload = (await resp.json().catch(() => ({}))) as Partial<CheckCategorizeResponse> & {
    error?: string;
  };
  if (!resp.ok) {
    throw new Error(payload.error || `Auto-categorization failed (${resp.status})`);
  }

  const llmItems = Array.isArray(payload.results) ? payload.results : [];
  const llmById = new Map(llmItems.map((item) => [item.id, item]));

  for (const chk of unresolvedForLlm) {
    const allowedMap: Map<string, string> =
      chk.transactionType === 'Income' ? incomeMap : expenseMap;
    const raw = llmById.get(chk.id);
    if (!raw) {
      results.set(chk.id, {
        id: chk.id,
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
      results.set(chk.id, {
        id: chk.id,
        category: '',
        confidence: 'low',
        method: 'abstained',
        reason: raw.reason?.trim() || 'Abstained: memo/context too ambiguous to assign safely.',
      });
    } else {
      results.set(chk.id, {
        id: chk.id,
        category: canonical,
        confidence: conf,
        method: 'llm',
        reason: raw.reason?.trim() || 'Matched via strict constrained AI.',
      });
    }
  }

  return results;
}
