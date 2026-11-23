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
 * Deterministic token approximation (`Math.ceil(normalized.length / 4)`) with
 * whitespace normalization so repeated spacing never inflates counts.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  const normalized = normalizeWhitespaceForTokens(text);
  if (normalized.length === 0) {
    return 0;
  }
  return Math.ceil(normalized.length / 4);
}

/**
 * Clip `text` cleanly at a word or line boundary so `estimateTokens(result) <= maxTokens`.
 */
export function clipTextToTokenBudget(text: string, maxTokens: number): string {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  const budget = normalizeNonNegativeBudget(maxTokens);
  if (budget === 0) {
    return '';
  }

  if (estimateTokens(text) <= budget) {
    return text;
  }

  const trimmed = text.trim();
  const maxChars = budget * 4;
  const ellipsis = maxChars >= 4 ? '...' : '';
  const usableChars = Math.max(0, maxChars - ellipsis.length);

  if (usableChars === 0) {
    return trimmed.slice(0, maxChars).trimEnd();
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
  // Guarantee invariant even when raw newlines/spaces shrink unevenly under normalization.
  while (candidate.length > ellipsis.length && estimateTokens(candidate) > budget) {
    const body = candidate.slice(0, candidate.length - ellipsis.length - 1).trimEnd();
    if (body.length === 0) {
      return '';
    }
    candidate = `${body}${ellipsis}`;
  }

  return estimateTokens(candidate) <= budget ? candidate : '';
}

/**
 * Greedily include highest-priority items in order without exceeding `maxTokens`.
 * When the very first item exceeds the entire positive budget, cleanly truncates it
 * instead of returning an empty result.
 */
export function fitItemsToBudget<T extends { text: string }>(
  items: readonly T[],
  maxTokens: number
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

    const cost = estimateTokens(item.text);

    if (included.length === 0 && usedTokens === 0 && cost > budget) {
      if (budget > 0) {
        const clippedText = clipTextToTokenBudget(item.text, budget);
        const clippedCost = estimateTokens(clippedText);
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
