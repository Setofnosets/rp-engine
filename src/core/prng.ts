import { RefereeError, ValidationError } from './errors.js';
import { ErrorAccumulator, Result, err, ok } from './result.js';

/**
 * Deterministic 128-bit `xoshiro128**` PRNG state.
 * All four 32-bit state words (`s0`..`s3`) are unsigned 32-bit integers with at least one non-zero word.
 */
export interface XoshiroRngState {
  readonly type: 'xoshiro128**';
  readonly s0: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
  readonly drawCount: number;
}

/**
 * Test-oracle PRNG state that yields pre-seeded floats from `queue` in `[0, 1)`
 * before falling back to a deterministic `xoshiro128**` stream.
 */
export interface QueuedRngState {
  readonly type: 'queued';
  readonly queue: readonly number[];
  readonly cursor: number;
  readonly fallback: XoshiroRngState;
  readonly drawCount: number;
}

/**
 * Serializable, immutable PRNG state discriminated union.
 */
export type RngState = XoshiroRngState | QueuedRngState;

/**
 * Result of drawing a floating-point sample from an {@link RngState}.
 */
export interface FloatStepResult {
  readonly value: number;
  readonly nextState: RngState;
}

/**
 * Result of drawing an integer sample from an {@link RngState}.
 */
export interface IntStepResult {
  readonly value: number;
  readonly nextState: RngState;
}

/**
 * Entry with a non-negative selection weight for {@link weightedPick}.
 */
export interface WeightedItem<T> {
  readonly item: T;
  readonly weight: number;
}

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
const UINT32_MOD = 0x100000000; // 2^32

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Compute a deterministic 32-bit unsigned FNV-1a hash of a string.
 * Processes UTF-16 code units as little-endian byte pairs so behavior is identical across JS engines.
 */
function fnv1a32(input: string): number {
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), FNV1A_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Advance a 32-bit SplitMix32 generator state by one step and return `{ value, nextSeed }`.
 */
function splitmix32(seed: number): { value: number; nextSeed: number } {
  const nextSeed = (seed + 0x9e3779b9) >>> 0;
  let mixed = nextSeed;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) >>> 0;
  mixed = (mixed ^ (mixed >>> 16)) >>> 0;
  return { value: mixed, nextSeed };
}

/**
 * Derive a deterministic 32-bit unsigned integer seed from a string or number.
 */
function seedToUint32(seed: string | number): number {
  if (typeof seed === 'string') {
    return fnv1a32(seed);
  }

  // Normalize -0 to +0 so 0 and -0 produce identical streams.
  const normalized = seed === 0 ? 0 : seed;
  if (Number.isInteger(normalized) && normalized >= 0 && normalized <= 0xffffffff) {
    return normalized >>> 0;
  }

  // Canonicalize IEEE-754 float64 bytes (big-endian) for non-32-bit or fractional numbers.
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Number.isNaN(normalized) ? Number.NaN : normalized, false);
  const hi = view.getUint32(0, false);
  const lo = view.getUint32(4, false);

  let hash = FNV1A_OFFSET_BASIS;
  hash = Math.imul(hash ^ (hi & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((hi >>> 8) & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((hi >>> 16) & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((hi >>> 24) & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ (lo & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((lo >>> 8) & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((lo >>> 16) & 0xff), FNV1A_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((lo >>> 24) & 0xff), FNV1A_PRIME) >>> 0;
  return hash >>> 0;
}

function nextNonZeroSplitMixWord(currentSeed: number): { word: number; nextSeed: number } {
  let seed = currentSeed;
  let word = 0;
  // Since SplitMix32 is a bijection on uint32, advancing past 0 takes at most one extra iteration.
  while (word === 0) {
    const step = splitmix32(seed);
    word = step.value;
    seed = step.nextSeed;
  }
  return { word, nextSeed: seed };
}

/**
 * Create a deterministic `xoshiro128**` PRNG state from a string or numeric seed.
 * All four 32-bit state words (`s0`..`s3`) are guaranteed to be non-zero.
 */
export function createSeededRng(seed: string | number): XoshiroRngState {
  let smSeed = seedToUint32(seed);

  // Mix numeric vs string domains by folding length into string expansion if string,
  // while keeping direct SplitMix32 expansion for uint32 seeds.
  if (typeof seed === 'string') {
    smSeed = (smSeed ^ Math.imul(seed.length, 0x9e3779b1)) >>> 0;
  }

  const w0 = nextNonZeroSplitMixWord(smSeed);
  const w1 = nextNonZeroSplitMixWord(w0.nextSeed);
  const w2 = nextNonZeroSplitMixWord(w1.nextSeed);
  const w3 = nextNonZeroSplitMixWord(w2.nextSeed);

  return {
    type: 'xoshiro128**',
    s0: w0.word,
    s1: w1.word,
    s2: w2.word,
    s3: w3.word,
    drawCount: 0,
  };
}

/**
 * Create a deterministic queued test-oracle PRNG state.
 * Draws values from `values` in order, then falls back to a seeded `xoshiro128**` stream.
 * Throws a {@link RefereeError} if any queued float is not a finite number in `[0, 1)`.
 */
export function createQueuedRng(
  values: readonly number[],
  fallbackSeed: string | number = 'queued-fallback'
): QueuedRngState {
  const validatedQueue: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (raw === undefined || typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw >= 1) {
      throw new RefereeError(
        `Queued RNG value at index ${i} must be a finite number in [0, 1); received ${String(raw)}`,
        {
          code: 'INVALID_RNG_QUEUE_VALUE',
          details: { index: i, value: raw },
        }
      );
    }
    validatedQueue.push(raw === 0 ? 0 : raw);
  }

  return {
    type: 'queued',
    queue: validatedQueue,
    cursor: 0,
    fallback: createSeededRng(fallbackSeed),
    drawCount: 0,
  };
}

function stepXoshiro(state: XoshiroRngState): { value: number; nextState: XoshiroRngState } {
  const s0 = state.s0 >>> 0;
  const s1 = state.s1 >>> 0;
  const s2 = state.s2 >>> 0;
  const s3 = state.s3 >>> 0;

  // Guard against a manually constructed or corrupted all-zero xoshiro128** state.
  if ((s0 | s1 | s2 | s3) === 0) {
    throw new RefereeError('xoshiro128** state words cannot all be zero', {
      code: 'INVALID_RNG_STATE',
    });
  }

  const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;

  let ns0 = s0;
  let ns1 = s1;
  let ns2 = (s2 ^ ns0) >>> 0;
  let ns3 = (s3 ^ ns1) >>> 0;

  ns1 = (ns1 ^ ns2) >>> 0;
  ns0 = (ns0 ^ ns3) >>> 0;
  ns2 = (ns2 ^ t) >>> 0;
  ns3 = rotl32(ns3, 11);

  return {
    value: result / UINT32_MOD,
    nextState: {
      type: 'xoshiro128**',
      s0: ns0,
      s1: ns1,
      s2: ns2,
      s3: ns3,
      drawCount: state.drawCount + 1,
    },
  };
}

/**
 * Draw a deterministic float in `[0, 1)` without mutating `state`.
 */
export function nextFloat(state: RngState): FloatStepResult {
  if (state.type === 'queued') {
    if (state.cursor < state.queue.length) {
      const queuedValue = state.queue[state.cursor];
      if (queuedValue === undefined || !Number.isFinite(queuedValue) || queuedValue < 0 || queuedValue >= 1) {
        throw new RefereeError(
          `Queued RNG value at cursor ${state.cursor} is invalid: ${String(queuedValue)}`,
          {
            code: 'INVALID_RNG_STATE',
            details: { cursor: state.cursor, value: queuedValue },
          }
        );
      }
      return {
        value: queuedValue,
        nextState: {
          type: 'queued',
          queue: state.queue,
          cursor: state.cursor + 1,
          fallback: state.fallback,
          drawCount: state.drawCount + 1,
        },
      };
    }

    const fallbackStep = stepXoshiro(state.fallback);
    return {
      value: fallbackStep.value,
      nextState: {
        type: 'queued',
        queue: state.queue,
        cursor: state.cursor,
        fallback: fallbackStep.nextState,
        drawCount: state.drawCount + 1,
      },
    };
  }

  return stepXoshiro(state);
}

/**
 * Draw a deterministic integer in `[minInclusive, maxInclusive]` without mutating `state`.
 * Throws a {@link RefereeError} if bounds are not safe integers or `minInclusive > maxInclusive`.
 */
export function nextInt(state: RngState, minInclusive: number, maxInclusive: number): IntStepResult {
  if (!Number.isSafeInteger(minInclusive) || !Number.isSafeInteger(maxInclusive)) {
    throw new RefereeError(
      `nextInt bounds must be safe integers; received [${String(minInclusive)}, ${String(maxInclusive)}]`,
      {
        code: 'INVALID_INT_RANGE',
        details: { minInclusive, maxInclusive },
      }
    );
  }
  if (minInclusive > maxInclusive) {
    throw new RefereeError(
      `nextInt minInclusive (${minInclusive}) cannot exceed maxInclusive (${maxInclusive})`,
      {
        code: 'INVALID_INT_RANGE',
        details: { minInclusive, maxInclusive },
      }
    );
  }

  const span = maxInclusive - minInclusive + 1;
  if (!Number.isSafeInteger(span) || span > UINT32_MOD) {
    throw new RefereeError(
      `nextInt span (${span}) exceeds supported 32-bit uniform integer range`,
      {
        code: 'INVALID_INT_RANGE',
        details: { minInclusive, maxInclusive, span },
      }
    );
  }

  const { value: floatVal, nextState } = nextFloat(state);
  // Clamp against maxInclusive in case IEEE-754 rounding on near-1 queued floats pushes floor(floatVal * span) == span.
  const offset = Math.min(span - 1, Math.floor(floatVal * span));
  return {
    value: minInclusive + offset,
    nextState,
  };
}

/**
 * Pick one element uniformly at random from `items` without mutating `items` or `state`.
 * Returns `{ item: undefined, nextState: state }` when `items` is empty.
 */
export function pickOne<T>(
  items: readonly T[],
  state: RngState
): { readonly item: T | undefined; readonly nextState: RngState } {
  if (items.length === 0) {
    return { item: undefined, nextState: state };
  }

  const { value: index, nextState } = nextInt(state, 0, items.length - 1);
  return { item: items[index], nextState };
}

/**
 * Pick one element using non-negative finite weights without mutating `itemsWithWeights` or `state`.
 */
export function weightedPick<T>(
  itemsWithWeights: readonly WeightedItem<T>[],
  state: RngState
): Result<{ readonly item: T; readonly nextState: RngState }, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (itemsWithWeights.length === 0) {
    acc.add('', 'EMPTY_WEIGHTED_ITEMS', 'Cannot perform weightedPick on an empty array');
    return err([...acc.errors]);
  }

  let totalWeight = 0;
  let lastPositiveIndex = -1;

  for (let i = 0; i < itemsWithWeights.length; i++) {
    const entry = itemsWithWeights[i];
    if (entry === undefined) {
      acc.add(`[${i}]`, 'MISSING_ITEM', 'Weighted item entry is missing');
      continue;
    }
    if (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight < 0) {
      acc.add(
        `[${i}].weight`,
        'INVALID_WEIGHT',
        `Weight at index ${i} must be a finite non-negative number; received ${String(entry.weight)}`
      );
      continue;
    }
    totalWeight += entry.weight;
    if (entry.weight > 0) {
      lastPositiveIndex = i;
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  if (!Number.isFinite(totalWeight)) {
    acc.add('', 'WEIGHT_OVERFLOW', 'Sum of weights must be finite');
    return err([...acc.errors]);
  }

  if (totalWeight <= 0 || lastPositiveIndex === -1) {
    acc.add('', 'ZERO_TOTAL_WEIGHT', 'Total weight must be greater than zero');
    return err([...acc.errors]);
  }

  const { value: floatVal, nextState } = nextFloat(state);
  const target = floatVal * totalWeight;
  let cumulative = 0;

  for (let i = 0; i < itemsWithWeights.length; i++) {
    const entry = itemsWithWeights[i];
    if (entry === undefined || entry.weight === 0) {
      continue;
    }
    cumulative += entry.weight;
    if (target < cumulative) {
      return ok({ item: entry.item, nextState });
    }
  }

  // Floating-point summation rounding fallback: always select the last item with positive weight.
  const fallbackEntry = itemsWithWeights[lastPositiveIndex];
  if (fallbackEntry === undefined) {
    throw new RefereeError('Internal weightedPick error: missing fallback positive entry', {
      code: 'INTERNAL_ERROR',
    });
  }
  return ok({ item: fallbackEntry.item, nextState });
}

/**
 * Return a new shuffled copy of `items` using the Fisher-Yates algorithm without mutating `items` or `state`.
 */
export function shuffle<T>(
  items: readonly T[],
  state: RngState
): { readonly shuffled: T[]; readonly nextState: RngState } {
  const copy = [...items];
  let currentState = state;

  for (let i = copy.length - 1; i > 0; i--) {
    const step = nextInt(currentState, 0, i);
    currentState = step.nextState;
    const j = step.value;
    if (i !== j) {
      const temp = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = temp;
    }
  }

  return { shuffled: copy, nextState: currentState };
}
