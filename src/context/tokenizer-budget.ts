import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';

/**
 * Per-section and total token caps used when compiling narrator prompts.
 */
export interface SectionTokenBudgets {
  system?: number;
  card?: number;
  state: number;
  combatOutcome: number;
  plot: number;
  world: number;
  totalMaxTokens: number;
}

/**
 * Default token budgets applied when caller omits or partially specifies `budgets`.
 */
export const DEFAULT_TOKEN_BUDGETS: Readonly<SectionTokenBudgets> = Object.freeze({
  state: 700,
  combatOutcome: 300,
  plot: 350,
  world: 500,
  totalMaxTokens: 6000,
});

function normalizeWhitespaceForTokens(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeNonNegativeBudget(maxTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return 0;
  }
  return Math.floor(maxTokens);
}

/**
 * Supported BPE encodings for exact token counting.
 */
export type TokenizerEncoding = 'o200k_base' | 'cl100k_base';

/**
 * Token counting mode: exact BPE (`'bpe'`) or character-length heuristic (`'heuristic'`).
 */
export type TokenizerMode = 'bpe' | 'heuristic';

/**
 * Options controlling token estimation.
 */
export interface EstimateTokensOptions {
  mode?: TokenizerMode;
  encoding?: TokenizerEncoding;
}

const LRU_CACHE_MAX_ENTRIES = 2048;
const tokenCountCache = new Map<string, number>();
const encoderCache = new Map<TokenizerEncoding, Tiktoken>();

function getBpeEncoder(encoding: TokenizerEncoding): Tiktoken {
  const cached = encoderCache.get(encoding);
  if (cached !== undefined) {
    return cached;
  }
  const encoder = getEncoding(encoding);
  encoderCache.set(encoding, encoder);
  return encoder;
}

function getCachedTokenCount(key: string): number | undefined {
  const value = tokenCountCache.get(key);
  if (value === undefined) {
    return undefined;
  }
  // Refresh LRU position
  tokenCountCache.delete(key);
  tokenCountCache.set(key, value);
  return value;
}

function setCachedTokenCount(key: string, count: number): void {
  if (tokenCountCache.has(key)) {
    tokenCountCache.delete(key);
  } else if (tokenCountCache.size >= LRU_CACHE_MAX_ENTRIES) {
    const oldestKey = tokenCountCache.keys().next().value;
    if (oldestKey !== undefined) {
      tokenCountCache.delete(oldestKey);
    }
  }
  tokenCountCache.set(key, count);
}

/**
 * Deterministic token counter: defaults to exact BPE counting (`o200k_base`)
 * with a bounded 2048-entry LRU cache, or `'heuristic'` (`Math.ceil(normalized.length / 4)`).
 */
export function estimateTokens(text: string, options?: EstimateTokensOptions): number {
  if (typeof text !== 'string' || text.length === 0 || text.trim().length === 0) {
    return 0;
  }

  if (options?.mode === 'heuristic') {
    const normalized = normalizeWhitespaceForTokens(text);
    return Math.ceil(normalized.length / 4);
  }

  const encoding: TokenizerEncoding =
    options?.encoding === 'cl100k_base' ? 'cl100k_base' : 'o200k_base';
  const cacheKey = `${encoding}\0${text}`;
  const cached = getCachedTokenCount(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const count = getBpeEncoder(encoding).encode(text).length;
  setCachedTokenCount(cacheKey, count);
  return count;
}

/**
 * Clip `text` cleanly at a word or line boundary so `estimateTokens(result, options) <= maxTokens`.
 */
export function clipTextToTokenBudget(
  text: string,
  maxTokens: number,
  options?: EstimateTokensOptions
): string {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  const budget = normalizeNonNegativeBudget(maxTokens);
  if (budget === 0) {
    return '';
  }

  if (estimateTokens(text, options) <= budget) {
    return text;
  }

  const trimmed = text.trim();
  const maxChars = budget * 4;
  const ellipsis = maxChars >= 4 ? '...' : '';
  const usableChars = Math.max(0, maxChars - ellipsis.length);

  if (usableChars === 0) {
    const single = trimmed.slice(0, maxChars).trimEnd();
    return estimateTokens(single, options) <= budget ? single : '';
  }

  // Collapse excessive whitespace if raw text spans far past maxChars due to formatting runs.
  const source = trimmed.length > usableChars * 2 ? normalizeWhitespaceForTokens(trimmed) : trimmed;
  let cut = source.slice(0, usableChars);

  const lastSpace = cut.lastIndexOf(' ');
  const lastNewline = cut.lastIndexOf('\n');
  const boundary = Math.max(lastSpace, lastNewline);
  if (boundary >= Math.floor(usableChars * 0.6)) {
    cut = cut.slice(0, boundary);
  }

  let candidate = `${cut.trimEnd()}${ellipsis}`;
  if (estimateTokens(candidate, options) <= budget) {
    return candidate;
  }

  // Binary search the longest prefix of `cut` that fits within `budget` with `ellipsis`.
  let low = 0;
  let high = cut.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = cut.slice(0, mid).trimEnd();
    if (prefix.length === 0) {
      low = mid + 1;
      continue;
    }
    const probe = `${prefix}${ellipsis}`;
    if (estimateTokens(probe, options) <= budget) {
      best = probe;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best.length > 0) {
    return best;
  }

  candidate = cut.slice(0, 1).trimEnd();
  return candidate.length > 0 && estimateTokens(candidate, options) <= budget ? candidate : '';
}

/**
 * Greedily include highest-priority items in order without exceeding `maxTokens`.
 * When the very first item exceeds the entire positive budget, cleanly truncates it
 * instead of returning an empty result.
 */
export function fitItemsToBudget<T extends { text: string }>(
  items: readonly T[],
  maxTokens: number,
  options?: EstimateTokensOptions
): { included: T[]; droppedCount: number; usedTokens: number } {
  const budget = normalizeNonNegativeBudget(maxTokens);
  const included: T[] = [];
  let usedTokens = 0;
  let droppedCount = 0;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined || typeof item.text !== 'string') {
      droppedCount += 1;
      continue;
    }

    const cost = estimateTokens(item.text, options);

    if (included.length === 0 && usedTokens === 0 && cost > budget) {
      if (budget > 0) {
        const clippedText = clipTextToTokenBudget(item.text, budget, options);
        const clippedCost = estimateTokens(clippedText, options);
        if (clippedText.length > 0 && clippedCost <= budget) {
          included.push({ ...item, text: clippedText });
          usedTokens += clippedCost;
          continue;
        }
      }
      droppedCount += 1;
      continue;
    }

    if (usedTokens + cost <= budget) {
      included.push(item);
      usedTokens += cost;
    } else {
      droppedCount += 1;
    }
  }

  return {
    included,
    droppedCount,
    usedTokens,
  };
}

/**
 * Validate partial {@link SectionTokenBudgets} and resolve defaults using {@link Result}.
 */
export function validateTokenBudgets(
  budgets?: Partial<SectionTokenBudgets>,
  basePath = 'budgets'
): Result<SectionTokenBudgets, ValidationError[]> {
  const acc = new ErrorAccumulator(basePath);

  if (budgets !== undefined && (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets))) {
    return err([validationError(basePath, 'INVALID_TYPE', 'budgets must be a plain object')]);
  }

  const resolved: SectionTokenBudgets = {
    state: DEFAULT_TOKEN_BUDGETS.state,
    combatOutcome: DEFAULT_TOKEN_BUDGETS.combatOutcome,
    plot: DEFAULT_TOKEN_BUDGETS.plot,
    world: DEFAULT_TOKEN_BUDGETS.world,
    totalMaxTokens: DEFAULT_TOKEN_BUDGETS.totalMaxTokens,
  };

  if (budgets === undefined) {
    return ok(resolved);
  }

  const checkOptionalPositiveOrZero = (
    key: keyof SectionTokenBudgets,
    value: number | undefined,
    assign: (n: number) => void
  ): void => {
    if (value === undefined) {
      return;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      acc.add(key, 'INVALID_BUDGET', `${key} must be a non-negative finite number`);
      return;
    }
    assign(Math.floor(value));
  };

  checkOptionalPositiveOrZero('system', budgets.system, (n) => {
    resolved.system = n;
  });
  checkOptionalPositiveOrZero('card', budgets.card, (n) => {
    resolved.card = n;
  });
  checkOptionalPositiveOrZero('state', budgets.state, (n) => {
    resolved.state = n;
  });
  checkOptionalPositiveOrZero('combatOutcome', budgets.combatOutcome, (n) => {
    resolved.combatOutcome = n;
  });
  checkOptionalPositiveOrZero('plot', budgets.plot, (n) => {
    resolved.plot = n;
  });
  checkOptionalPositiveOrZero('world', budgets.world, (n) => {
    resolved.world = n;
  });
  checkOptionalPositiveOrZero('totalMaxTokens', budgets.totalMaxTokens, (n) => {
    resolved.totalMaxTokens = n;
  });

  return acc.toResult(resolved);
}

/**
 * Per-section token usage and budget utilization entry.
 */
export interface SectionBudgetReportEntry {
  section: string;
  tokens: number;
  budget: number;
  utilizationPct: number;
  truncated: boolean;
  droppedItems: number;
}

/**
 * Aggregate context-budget inspection report across all sections.
 */
export interface ContextBudgetReport {
  totalTokens: number;
  totalBudget: number;
  overBudget: boolean;
  sections: SectionBudgetReportEntry[];
}

/**
 * Input value for a single section passed to {@link inspectContextBudget}.
 */
export type ContextBudgetSectionInput =
  | string
  | {
      text: string;
      truncated?: boolean;
      droppedItems?: number;
    };

/**
 * Inspect per-section token counts, budget utilization, and overall budget compliance.
 */
export function inspectContextBudget(
  sections: Readonly<Record<string, ContextBudgetSectionInput | undefined>>,
  budgets: Partial<SectionTokenBudgets> & Readonly<Record<string, number | undefined>> = {},
  options?: EstimateTokensOptions
): ContextBudgetReport {
  const entries: SectionBudgetReportEntry[] = [];
  let totalTokens = 0;

  for (const [section, rawInput] of Object.entries(sections)) {
    if (rawInput === undefined) {
      continue;
    }

    const text = typeof rawInput === 'string' ? rawInput : rawInput.text;
    const tokens = estimateTokens(text, options);
    const rawBudget = Object.prototype.hasOwnProperty.call(budgets, section)
      ? budgets[section]
      : undefined;
    const budget = normalizeNonNegativeBudget(rawBudget ?? 0);

    let utilizationPct = 0;
    if (budget > 0) {
      const pct = Math.round(((tokens / budget) * 100) * 100) / 100;
      utilizationPct = pct === 0 ? 0 : pct;
    } else if (tokens > 0) {
      utilizationPct = 100;
    }

    const truncated =
      typeof rawInput === 'string' ? budget > 0 && tokens > budget : Boolean(rawInput.truncated);
    const rawDropped = typeof rawInput === 'string' ? 0 : (rawInput.droppedItems ?? 0);
    const droppedItems = normalizeNonNegativeBudget(rawDropped);

    totalTokens += tokens;
    entries.push({
      section,
      tokens,
      budget,
      utilizationPct,
      truncated,
      droppedItems,
    });
  }

  const totalBudget = normalizeNonNegativeBudget(
    budgets.totalMaxTokens ?? DEFAULT_TOKEN_BUDGETS.totalMaxTokens
  );
  const overBudget =
    totalTokens > totalBudget || entries.some((entry) => entry.budget > 0 && entry.tokens > entry.budget);

  return {
    totalTokens,
    totalBudget,
    overBudget,
    sections: entries,
  };
}
