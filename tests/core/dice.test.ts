import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/index.js';
import { parseDiceNotation, rollDice } from '../../src/core/dice.js';
import { type RngState, createQueuedRng, createSeededRng } from '../../src/core/prng.js';

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

describe('parseDiceNotation', () => {
  it('parses standard, omitted-count, modifier, keep-highest, and keep-lowest notations', () => {
    const cases = [
      {
        input: 'd20',
        expected: { notation: 'd20', diceCount: 1, sides: 20, modifier: 0, keepMode: 'none' },
      },
      {
        input: '1d100',
        expected: { notation: '1d100', diceCount: 1, sides: 100, modifier: 0, keepMode: 'none' },
      },
      {
        input: '3d6+4',
        expected: { notation: '3d6+4', diceCount: 3, sides: 6, modifier: 4, keepMode: 'none' },
      },
      {
        input: '2d8 - 2',
        expected: { notation: '2d8 - 2', diceCount: 2, sides: 8, modifier: -2, keepMode: 'none' },
      },
      {
        input: '2d20kh1',
        expected: {
          notation: '2d20kh1',
          diceCount: 2,
          sides: 20,
          modifier: 0,
          keepMode: 'highest',
          keepCount: 1,
        },
      },
      {
        input: '2d20kl1',
        expected: {
          notation: '2d20kl1',
          diceCount: 2,
          sides: 20,
          modifier: 0,
          keepMode: 'lowest',
          keepCount: 1,
        },
      },
      {
        input: ' 4D6KH3 + 2 ',
        expected: {
          notation: '4D6KH3 + 2',
          diceCount: 4,
          sides: 6,
          modifier: 2,
          keepMode: 'highest',
          keepCount: 3,
        },
      },
      {
        input: '2d6kh2-0',
        expected: {
          notation: '2d6kh2-0',
          diceCount: 2,
          sides: 6,
          modifier: 0,
          keepMode: 'highest',
          keepCount: 2,
        },
      },
    ];

    for (const testCase of cases) {
      const parsed = parseDiceNotation(testCase.input);
      expect(isOk(parsed)).toBe(true);
      if (isOk(parsed)) {
        expect(parsed.value).toEqual(testCase.expected);
        expect(Object.is(parsed.value.modifier, -0)).toBe(false);
      }
    }
  });

  it('rejects invalid dice notations with descriptive ValidationError entries', () => {
    const invalidCases = [
      { input: '', expectedCode: 'EMPTY_NOTATION' },
      { input: '   ', expectedCode: 'EMPTY_NOTATION' },
      { input: '0d6', expectedCode: 'INVALID_DICE_COUNT' },
      { input: '2d0', expectedCode: 'INVALID_SIDES' },
      { input: '2d1', expectedCode: 'INVALID_SIDES' },
      { input: '2d6kh5', expectedCode: 'KEEP_COUNT_EXCEEDS_DICE' },
      { input: '2d6kh0', expectedCode: 'INVALID_KEEP_COUNT' },
      { input: '2d6kl0', expectedCode: 'INVALID_KEEP_COUNT' },
      { input: '2d6kh', expectedCode: 'INVALID_NOTATION' },
      { input: '-2d6', expectedCode: 'INVALID_NOTATION' },
      { input: '2d-6', expectedCode: 'INVALID_NOTATION' },
      { input: '2d6+', expectedCode: 'INVALID_NOTATION' },
      { input: '2d6+3+1', expectedCode: 'INVALID_NOTATION' },
      { input: 'not-dice', expectedCode: 'INVALID_NOTATION' },
      { input: '10001d6', expectedCode: 'DICE_COUNT_TOO_LARGE' },
      { input: '1d1000001', expectedCode: 'SIDES_TOO_LARGE' },
    ];

    for (const { input, expectedCode } of invalidCases) {
      const parsed = parseDiceNotation(input);
      expect(isErr(parsed)).toBe(true);
      if (isErr(parsed)) {
        expect(parsed.error.length).toBeGreaterThan(0);
        expect(parsed.error.some((e) => e.code === expectedCode)).toBe(true);
      }
    }

    // Multiple semantic errors accumulated simultaneously
    const multiErr = parseDiceNotation('0d0kh0');
    expect(isErr(multiErr)).toBe(true);
    if (isErr(multiErr)) {
      const codes = multiErr.error.map((e) => e.code);
      expect(codes).toContain('INVALID_DICE_COUNT');
      expect(codes).toContain('INVALID_SIDES');
      expect(codes).toContain('INVALID_KEEP_COUNT');
    }
  });
});

describe('rollDice', () => {
  it('computes exact rolls, modifiers, and audit trace with queued oracle RNG', () => {
    // 3d6: floor(0.0*6)+1=1, floor(0.5*6)+1=4, floor(0.99*6)+1=6 -> total 11 + 2 = 13
    const rng = createQueuedRng([0.0, 0.5, 0.99]);
    const result = rollDice('3d6+2', rng);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.rolls).toEqual([1, 4, 6]);
      expect(result.value.modifier).toBe(2);
      expect(result.value.total).toBe(13);
      expect(result.value.nextState.drawCount).toBe(3);
      expect(result.value.trace).toEqual({
        notation: '3d6+2',
        diceCount: 3,
        sides: 6,
        modifier: 2,
        keepMode: 'none',
        rawRolls: [1, 4, 6],
        keptRolls: [1, 4, 6],
        total: 13,
        seedBefore: rng,
        seedAfter: result.value.nextState,
      });
    }
  });

  it('handles advantage (2d20kh1) and disadvantage (2d20kl1) correctly', () => {
    // floats [0.1, 0.85] on d20 -> floor(2)+1=3, floor(17)+1=18
    const advRng = createQueuedRng([0.1, 0.85]);
    const advantage = rollDice('2d20kh1+4', advRng);

    expect(isOk(advantage)).toBe(true);
    if (isOk(advantage)) {
      expect(advantage.value.trace.rawRolls).toEqual([3, 18]);
      expect(advantage.value.trace.keptRolls).toEqual([18]);
      expect(advantage.value.rolls).toEqual([18]);
      expect(advantage.value.modifier).toBe(4);
      expect(advantage.value.total).toBe(22);
      expect(advantage.value.trace.keepMode).toBe('highest');
      expect(advantage.value.trace.keepCount).toBe(1);
    }

    const disRng = createQueuedRng([0.85, 0.1]);
    const disadvantage = rollDice('2d20kl1-1', disRng);

    expect(isOk(disadvantage)).toBe(true);
    if (isOk(disadvantage)) {
      expect(disadvantage.value.trace.rawRolls).toEqual([18, 3]);
      expect(disadvantage.value.trace.keptRolls).toEqual([3]);
      expect(disadvantage.value.rolls).toEqual([3]);
      expect(disadvantage.value.modifier).toBe(-1);
      expect(disadvantage.value.total).toBe(2);
      expect(disadvantage.value.trace.keepMode).toBe('lowest');
      expect(disadvantage.value.trace.keepCount).toBe(1);
    }
  });

  it('supports multi-die keep-highest (4d6kh3) and transitions cleanly from queued to fallback RNG', () => {
    // 4d6 rolls: [0.0->1, 0.99->6, 0.5->4, 0.35->3], then fallback generates next 1d100 roll
    const rng = createQueuedRng([0.0, 0.99, 0.5, 0.35], 'dice-fallback');
    const first = rollDice('4d6kh3', rng);
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) {
      return;
    }

    expect(first.value.trace.rawRolls).toEqual([1, 6, 4, 3]);
    expect(first.value.trace.keptRolls).toEqual([6, 4, 3]);
    expect(first.value.total).toBe(13);

    // Next roll uses fallback identically after JSON round-trip
    const serialized = JSON.parse(JSON.stringify(first.value.nextState)) as RngState;
    const secondA = rollDice('1d100', first.value.nextState);
    const secondB = rollDice('1d100', serialized);
    expect(isOk(secondA)).toBe(true);
    expect(isOk(secondB)).toBe(true);
    if (isOk(secondA) && isOk(secondB)) {
      expect(secondA.value).toEqual(secondB.value);
      expect(secondA.value.total).toBeGreaterThanOrEqual(1);
      expect(secondA.value.total).toBeLessThanOrEqual(100);
    }
  });

  it('produces deterministic rolls across seeded runs and stays within die bounds', () => {
    let stateA: RngState = createSeededRng('combat-encounter-1');
    let stateB: RngState = createSeededRng('combat-encounter-1');

    for (let i = 0; i < 500; i++) {
      const rollA = rollDice('2d10+3', stateA);
      const rollB = rollDice('2d10+3', stateB);
      expect(isOk(rollA)).toBe(true);
      expect(isOk(rollB)).toBe(true);
      if (isOk(rollA) && isOk(rollB)) {
        expect(rollA.value).toEqual(rollB.value);
        for (const r of rollA.value.trace.rawRolls) {
          expect(r).toBeGreaterThanOrEqual(1);
          expect(r).toBeLessThanOrEqual(10);
        }
        expect(rollA.value.total).toBeGreaterThanOrEqual(5);
        expect(rollA.value.total).toBeLessThanOrEqual(23);
        stateA = rollA.value.nextState;
        stateB = rollB.value.nextState;
      }
    }
  });

  it('returns Err for invalid notations and never mutates input state or leaked trace arrays', () => {
    const frozenState = deepFreeze(createSeededRng('immutable-dice'));
    const invalid = rollDice('2d6kh5', frozenState);
    expect(isErr(invalid)).toBe(true);

    const valid = rollDice('2d20kh1', frozenState);
    expect(isOk(valid)).toBe(true);
    if (isOk(valid)) {
      // Mutating top-level rolls array must not mutate trace.keptRolls or trace.rawRolls
      const originalKept = [...valid.value.trace.keptRolls];
      const originalRaw = [...valid.value.trace.rawRolls];
      valid.value.rolls.push(999);
      expect(valid.value.trace.keptRolls).toEqual(originalKept);
      expect(valid.value.trace.rawRolls).toEqual(originalRaw);
      expect(valid.value.trace.seedBefore).toEqual(frozenState);
    }
  });
});
