import { describe, expect, it } from 'vitest';
import { RefereeError, isErr, isOk } from '../../src/index.js';
import {
  type RngState,
  createQueuedRng,
  createSeededRng,
  nextFloat,
  nextInt,
  pickOne,
  shuffle,
  weightedPick,
} from '../../src/core/prng.js';

function drawFloatSequence(initialState: RngState, count: number): { values: number[]; finalState: RngState } {
  const values: number[] = [];
  let state = initialState;
  for (let i = 0; i < count; i++) {
    const step = nextFloat(state);
    values.push(step.value);
    state = step.nextState;
  }
  return { values, finalState: state };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      deepFreeze(prop);
    }
  }
  return value;
}

describe('createSeededRng and xoshiro128** determinism', () => {
  it('initializes all 4 32-bit state words to non-zero unsigned integers for diverse seeds', () => {
    const seeds: Array<string | number> = [
      0,
      -0,
      1,
      -1,
      42,
      0xffffffff,
      0.5,
      0.25,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '',
      '0',
      'referee-seed',
      'unicode-🎲-seed',
      'a'.repeat(500),
    ];

    for (const seed of seeds) {
      const state = createSeededRng(seed);
      expect(state.type).toBe('xoshiro128**');
      expect(state.drawCount).toBe(0);
      for (const word of [state.s0, state.s1, state.s2, state.s3]) {
        expect(Number.isInteger(word)).toBe(true);
        expect(word).toBeGreaterThan(0);
        expect(word).toBeLessThanOrEqual(0xffffffff);
      }
    }
  });

  it('produces distinct initial states for distinct seeds and identical states for 0 vs -0', () => {
    expect(createSeededRng(0)).toEqual(createSeededRng(-0));
    expect(createSeededRng(1)).toEqual(createSeededRng(1.0));

    expect(createSeededRng(0)).not.toEqual(createSeededRng(1));
    expect(createSeededRng('alpha')).not.toEqual(createSeededRng('beta'));
    expect(createSeededRng(42)).not.toEqual(createSeededRng('42'));
    expect(createSeededRng(-1)).not.toEqual(createSeededRng(0xffffffff));
    expect(createSeededRng(0.5)).not.toEqual(createSeededRng(0.25));
    expect(createSeededRng(0.5)).not.toEqual(createSeededRng(0));
  });

  it('matches across 10,000 draws from fixed string and numeric seeds across restarts and mid-stream JSON round-trips', () => {
    const seeds: Array<string | number> = ['campaign-seed-10k', 987654321];

    for (const seed of seeds) {
      const startA = createSeededRng(seed);
      const startB = createSeededRng(seed);
      const fullA = drawFloatSequence(startA, 10_000);
      const fullB = drawFloatSequence(startB, 10_000);

      expect(fullA.values).toEqual(fullB.values);
      expect(fullA.finalState.drawCount).toBe(10_000);

      // Verify bounds across all 10,000 draws.
      for (const val of fullA.values) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }

      // Mid-stream JSON round-trip checkpoints: split 10,000 draws across serialized restarts.
      const checkpoints = [137, 2500, 7777, 10_000];
      let current: RngState = createSeededRng(seed);
      const stitched: number[] = [];
      let drawnSoFar = 0;

      for (const targetCount of checkpoints) {
        const chunk = drawFloatSequence(current, targetCount - drawnSoFar);
        stitched.push(...chunk.values);
        drawnSoFar = targetCount;

        // Simulate persisting state to JSON and hydrating in a fresh process.
        current = JSON.parse(JSON.stringify(chunk.finalState)) as RngState;
        expect(current.drawCount).toBe(targetCount);
      }

      expect(stitched).toEqual(fullA.values);
      expect(current).toEqual(fullA.finalState);
    }
  });

  it('throws RefereeError if a manually constructed xoshiro128** state has all zero words', () => {
    const broken: RngState = {
      type: 'xoshiro128**',
      s0: 0,
      s1: 0,
      s2: 0,
      s3: 0,
      drawCount: 0,
    };
    expect(() => nextFloat(broken)).toThrow(RefereeError);
  });
});

describe('createQueuedRng oracle and fallback', () => {
  it('yields pinned floats in order and transitions seamlessly to seeded fallback when queue drains', () => {
    const queuedValues = [0, 0.25, 0.5, 0.999999999];
    const fallbackSeed = 'oracle-fallback';
    const rng = createQueuedRng(queuedValues, fallbackSeed);

    const expectedFallback = drawFloatSequence(createSeededRng(fallbackSeed), 5).values;
    const actual = drawFloatSequence(rng, queuedValues.length + 5);

    expect(actual.values.slice(0, queuedValues.length)).toEqual(queuedValues);
    expect(actual.values.slice(queuedValues.length)).toEqual(expectedFallback);
    expect(actual.finalState.drawCount).toBe(9);
  });

  it('survives mid-queue and post-drain JSON round-trips deterministically', () => {
    const rng = createQueuedRng([0.1, 0.2, 0.3], 42);
    const full = drawFloatSequence(rng, 20);

    // Pause mid-queue (after 2 draws) and serialize
    const firstTwo = drawFloatSequence(rng, 2);
    const resumedMidQueue = JSON.parse(JSON.stringify(firstTwo.finalState)) as RngState;

    // Pause post-drain (after 4 more draws, 6 total) and serialize
    const nextFour = drawFloatSequence(resumedMidQueue, 4);
    const resumedPostDrain = JSON.parse(JSON.stringify(nextFour.finalState)) as RngState;

    const rest = drawFloatSequence(resumedPostDrain, 14);
    expect([...firstTwo.values, ...nextFour.values, ...rest.values]).toEqual(full.values);
    expect(rest.finalState).toEqual(full.finalState);
  });

  it('clones the input array and normalizes -0 to 0', () => {
    const mutable = [-0, 0.5];
    const rng = createQueuedRng(mutable);
    mutable[0] = 0.9;
    mutable.push(0.8);

    const first = nextFloat(rng);
    expect(Object.is(first.value, 0)).toBe(true);

    const second = nextFloat(first.nextState);
    expect(second.value).toBe(0.5);

    // 3rd draw should come from fallback, NOT pushed 0.8
    const third = nextFloat(second.nextState);
    expect(third.value).not.toBe(0.8);
  });

  it('rejects out-of-range or non-finite floats cleanly with RefereeError', () => {
    const invalidInputs = [[-0.0001], [1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [0.2, 1]];
    for (const input of invalidInputs) {
      expect(() => createQueuedRng(input)).toThrow(RefereeError);
    }
  });
});

describe('nextInt, pickOne, weightedPick, and shuffle', () => {
  it('draws inclusive integers within [minInclusive, maxInclusive] including negative and singleton ranges', () => {
    let rng: RngState = createSeededRng('int-test');
    const counts = new Map<number, number>();
    for (let i = 0; i < 1000; i++) {
      const step = nextInt(rng, -2, 2);
      expect(Number.isInteger(step.value)).toBe(true);
      expect(step.value).toBeGreaterThanOrEqual(-2);
      expect(step.value).toBeLessThanOrEqual(2);
      counts.set(step.value, (counts.get(step.value) ?? 0) + 1);
      rng = step.nextState;
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);

    const singleton = nextInt(rng, 7, 7);
    expect(singleton.value).toBe(7);
    expect(singleton.nextState.drawCount).toBe(rng.drawCount + 1);

    // Near-1.0 float from queued RNG never overflows maxInclusive
    const edgeRng = createQueuedRng([1 - Number.EPSILON / 2]);
    expect(nextInt(edgeRng, 1, 3).value).toBe(3);
  });

  it('throws RefereeError for invalid nextInt bounds', () => {
    const rng = createSeededRng('bad-bounds');
    expect(() => nextInt(rng, 5, 4)).toThrow(RefereeError);
    expect(() => nextInt(rng, 1.5, 5)).toThrow(RefereeError);
    expect(() => nextInt(rng, 1, Number.POSITIVE_INFINITY)).toThrow(RefereeError);
    expect(() => nextInt(rng, 0, 0x100000000)).toThrow(RefereeError);
  });

  it('pickOne selects deterministically and handles empty lists', () => {
    const rng = createQueuedRng([0, 0.49, 0.99]);
    const items = ['sword', 'shield', 'potion'] as const;

    const emptyPick = pickOne([], rng);
    expect(emptyPick.item).toBeUndefined();
    expect(emptyPick.nextState).toBe(rng);

    const p1 = pickOne(items, rng);
    const p2 = pickOne(items, p1.nextState);
    const p3 = pickOne(items, p2.nextState);
    expect([p1.item, p2.item, p3.item]).toEqual(['sword', 'shield', 'potion']);
  });

  it('weightedPick selects according to weights, skips zero weights, and validates inputs via Result', () => {
    const items = [
      { item: 'never-leading', weight: 0 },
      { item: 'common', weight: 70 },
      { item: 'rare', weight: 30 },
      { item: 'never-trailing', weight: 0 },
    ] as const;

    // 0.0 -> first positive-weight item ('common'), NOT 'never-leading'
    const atZero = weightedPick(items, createQueuedRng([0]));
    expect(isOk(atZero)).toBe(true);
    if (isOk(atZero)) {
      expect(atZero.value.item).toBe('common');
    }

    // 0.699 -> 'common' (target 69.9 < 70)
    const beforeBoundary = weightedPick(items, createQueuedRng([0.699]));
    expect(isOk(beforeBoundary)).toBe(true);
    if (isOk(beforeBoundary)) {
      expect(beforeBoundary.value.item).toBe('common');
    }

    // 0.7 -> 'rare' (target 70 < 100)
    const atBoundary = weightedPick(items, createQueuedRng([0.7]));
    expect(isOk(atBoundary)).toBe(true);
    if (isOk(atBoundary)) {
      expect(atBoundary.value.item).toBe('rare');
    }

    // Near 1.0 -> 'rare' (last positive-weight item), NOT 'never-trailing'
    const nearOne = weightedPick(items, createQueuedRng([1 - Number.EPSILON / 2]));
    expect(isOk(nearOne)).toBe(true);
    if (isOk(nearOne)) {
      expect(nearOne.value.item).toBe('rare');
    }

    // Validation errors
    const rng = createSeededRng('weight-errors');
    const emptyErr = weightedPick([], rng);
    expect(isErr(emptyErr)).toBe(true);
    if (isErr(emptyErr)) {
      expect(emptyErr.error[0]?.code).toBe('EMPTY_WEIGHTED_ITEMS');
    }

    const negErr = weightedPick(
      [
        { item: 'a', weight: -1 },
        { item: 'b', weight: Number.NaN },
      ],
      rng
    );
    expect(isErr(negErr)).toBe(true);
    if (isErr(negErr)) {
      expect(negErr.error).toHaveLength(2);
      expect(negErr.error[0]?.path).toBe('[0].weight');
      expect(negErr.error[1]?.path).toBe('[1].weight');
    }

    const zeroTotalErr = weightedPick(
      [
        { item: 'a', weight: 0 },
        { item: 'b', weight: 0 },
      ],
      rng
    );
    expect(isErr(zeroTotalErr)).toBe(true);
    if (isErr(zeroTotalErr)) {
      expect(zeroTotalErr.error[0]?.code).toBe('ZERO_TOTAL_WEIGHT');
    }
  });

  it('shuffle produces deterministic permutations without mutating input array or RngState', () => {
    const deck = deepFreeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const stateA = deepFreeze(createSeededRng('deck-shuffle'));
    const stateB = createSeededRng('deck-shuffle');

    const resA = shuffle(deck, stateA);
    const resB = shuffle(deck, stateB);

    expect(resA.shuffled).toEqual(resB.shuffled);
    expect(resA.nextState).toEqual(resB.nextState);
    expect(resA.shuffled).not.toEqual(deck);
    expect([...resA.shuffled].sort((a, b) => a - b)).toEqual([...deck]);
    expect(deck).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Empty and singleton arrays
    expect(shuffle([], stateA)).toEqual({ shuffled: [], nextState: stateA });
    expect(shuffle(['only'], stateA)).toEqual({ shuffled: ['only'], nextState: stateA });
  });

  it('never mutates frozen input state or arrays across all PRNG functions', () => {
    const frozenSeeded = deepFreeze(createSeededRng('frozen'));
    const frozenQueued = deepFreeze(createQueuedRng([0.1, 0.8]));
    const frozenItems = deepFreeze(['a', 'b', 'c']);
    const frozenWeights = deepFreeze([
      { item: 'x', weight: 1 },
      { item: 'y', weight: 2 },
    ]);

    expect(() => nextFloat(frozenSeeded)).not.toThrow();
    expect(() => nextFloat(frozenQueued)).not.toThrow();
    expect(() => nextInt(frozenSeeded, 1, 20)).not.toThrow();
    expect(() => pickOne(frozenItems, frozenSeeded)).not.toThrow();
    expect(() => weightedPick(frozenWeights, frozenSeeded)).not.toThrow();
    expect(() => shuffle(frozenItems, frozenSeeded)).not.toThrow();
  });
});
