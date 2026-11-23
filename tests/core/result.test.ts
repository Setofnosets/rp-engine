import { describe, expect, it, vi } from 'vitest';
import {
  ErrorAccumulator,
  RefereeError,
  type Result,
  type ValidationError,
  combineResults,
  err,
  formatValidationError,
  formatValidationErrors,
  isErr,
  isOk,
  isValidationError,
  mapResult,
  ok,
  toRefereeError,
  unwrap,
  validationError,
} from '../../src/index.js';

describe('Result primitives', () => {
  it('constructs ok and err values', () => {
    const success = ok(42);
    const emptySuccess = ok();
    const failure = err([validationError('name', 'REQUIRED', 'Name is required')]);

    expect(success).toEqual({ ok: true, value: 42 });
    expect(emptySuccess).toEqual({ ok: true, value: undefined });
    expect(failure).toEqual({
      ok: false,
      error: [{ path: 'name', code: 'REQUIRED', message: 'Name is required' }],
    });
  });

  it('narrows types accurately with isOk, isErr, and discriminant check', () => {
    const okResult: Result<number, string> = ok(10);
    const errResult: Result<number, string> = err('boom');

    if (isOk(okResult)) {
      const doubled: number = okResult.value * 2;
      expect(doubled).toBe(20);
    } else {
      expect.unreachable('Expected okResult to be Ok');
    }

    if (isErr(errResult)) {
      const msg: string = errResult.error.toUpperCase();
      expect(msg).toBe('BOOM');
    } else {
      expect.unreachable('Expected errResult to be Err');
    }

    const handled = okResult.ok ? okResult.value : -1;
    expect(handled).toBe(10);
  });

  it('unwraps Ok values and throws informative errors on Err', () => {
    expect(unwrap(ok('ready'))).toBe('ready');

    const validationFailure: Result<number> = err([
      validationError('stats.hp', 'OUT_OF_RANGE', 'HP must be >= 0'),
      validationError('', 'INVALID', 'Root invalid'),
    ]);
    expect(() => unwrap(validationFailure)).toThrow(RefereeError);
    try {
      unwrap(validationFailure);
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(RefereeError);
      const refErr = thrown as RefereeError;
      expect(refErr.code).toBe('VALIDATION_ERROR');
      expect(refErr.message).toContain('stats.hp [OUT_OF_RANGE]: HP must be >= 0');
      expect(refErr.message).toContain('<root> [INVALID]: Root invalid');
      expect(refErr.details).toEqual([
        { path: 'stats.hp', code: 'OUT_OF_RANGE', message: 'HP must be >= 0' },
        { path: '', code: 'INVALID', message: 'Root invalid' },
      ]);
    }

    const customError = new RefereeError('Custom failure', { code: 'CUSTOM' });
    expect(() => unwrap(err(customError))).toThrow(customError);

    expect(() => unwrap(err('plain failure'))).toThrow('plain failure');
    expect(() => unwrap(err({ reason: 123 }))).toThrow(RefereeError);
    expect(() => unwrap(err([] as ValidationError[]))).toThrow('Validation failed');
  });

  it('maps Ok values without executing mapper on Err', () => {
    const mapper = vi.fn((n: number) => `val:${n}`);

    const mappedOk = mapResult(ok(7), mapper);
    expect(mappedOk).toEqual({ ok: true, value: 'val:7' });
    expect(mapper).toHaveBeenCalledTimes(1);

    const originalErr: Result<number, string> = err('bad');
    const mappedErr = mapResult(originalErr, mapper);
    expect(mappedErr).toBe(originalErr);
    expect(mapper).toHaveBeenCalledTimes(1);
  });
});

describe('combineResults', () => {
  it('combines an empty list to an empty Ok array', () => {
    const combined = combineResults([]);
    expect(combined).toEqual({ ok: true, value: [] });
  });

  it('combines homogeneous Ok results and preserves tuple types', () => {
    const list: Result<number>[] = [ok(1), ok(2), ok(3)];
    const combinedList = combineResults(list);
    expect(combinedList).toEqual({ ok: true, value: [1, 2, 3] });

    const r1: Result<number> = ok(5);
    const r2: Result<string> = ok('alpha');
    const r3: Result<boolean> = ok(true);
    const combinedTuple = combineResults([r1, r2, r3]);

    expect(isOk(combinedTuple)).toBe(true);
    if (isOk(combinedTuple)) {
      const [num, str, flag]: [number, string, boolean] = combinedTuple.value;
      expect([num, str, flag]).toEqual([5, 'alpha', true]);
    }
  });

  it('flattens array-valued errors and preserves scalar errors in order', () => {
    const e1 = validationError('a', 'E1', 'First error');
    const e2 = validationError('b', 'E2', 'Second error');
    const e3 = validationError('c', 'E3', 'Third error');

    const combinedValidation = combineResults([
      ok(1),
      err([e1, e2]) as Result<number>,
      ok(2),
      err([e3]) as Result<number>,
    ]);
    expect(combinedValidation).toEqual({
      ok: false,
      error: [e1, e2, e3],
    });

    const scalarResults: Result<number, string>[] = [ok(1), err('first'), ok(2), err('second')];
    const combinedScalars = combineResults(scalarResults);
    expect(combinedScalars).toEqual({
      ok: false,
      error: ['first', 'second'],
    });
  });

  it('handles inline Ok-only literals cleanly and assigns to Result<T, ValidationError[]>', () => {
    const combined: Result<[number, string]> = combineResults([ok(1), ok('two')]);
    expect(combined).toEqual({ ok: true, value: [1, 'two'] });
  });
});

describe('ErrorAccumulator', () => {
  it('returns Ok when no errors were added', () => {
    const acc = new ErrorAccumulator();
    expect(acc.hasErrors()).toBe(false);
    expect(acc.count).toBe(0);
    expect(acc.errors).toEqual([]);

    expect(acc.toResult({ id: 'hero' })).toEqual({
      ok: true,
      value: { id: 'hero' },
    });
    expect(acc.toResult()).toEqual({ ok: true, value: undefined });
  });

  it('accumulates errors with nested path scoping and returns Err snapshot', () => {
    const acc = new ErrorAccumulator();
    acc.add('title', 'REQUIRED', 'Title missing');

    const actorScope = acc.scope('actors').scope('[0]');
    actorScope.add('name', 'EMPTY', 'Actor name cannot be empty');
    actorScope.add('', 'INVALID_ACTOR', 'Actor entry is malformed');
    actorScope.addError(validationError('stats.hp', 'RANGE', 'HP out of bounds'));

    const extraScope = new ErrorAccumulator('pack');
    extraScope.addAll([validationError('version', 'UNSUPPORTED', 'Bad version')]);
    const absorbed = acc.absorb(extraScope.toResult('unused'));
    expect(absorbed).toBeUndefined();

    const absorbedOk = acc.absorb(ok('accepted'));
    expect(absorbedOk).toBe('accepted');

    expect(acc.hasErrors()).toBe(true);
    expect(acc.count).toBe(5);

    const result = acc.toResult('final-value');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toEqual([
        { path: 'title', code: 'REQUIRED', message: 'Title missing' },
        { path: 'actors[0].name', code: 'EMPTY', message: 'Actor name cannot be empty' },
        { path: 'actors[0]', code: 'INVALID_ACTOR', message: 'Actor entry is malformed' },
        { path: 'actors[0].stats.hp', code: 'RANGE', message: 'HP out of bounds' },
        { path: 'pack.version', code: 'UNSUPPORTED', message: 'Bad version' },
      ]);
      // Mutating the returned array must not mutate the accumulator's internal list
      result.error.pop();
      expect(acc.count).toBe(5);
    }
  });
});

describe('RefereeError and error helpers', () => {
  it('creates RefereeError with default and custom options and preserves inheritance', () => {
    const base = new RefereeError('Something went wrong');
    expect(base).toBeInstanceOf(Error);
    expect(base).toBeInstanceOf(RefereeError);
    expect(base.name).toBe('RefereeError');
    expect(base.code).toBe('REFEREE_ERROR');
    expect(base.message).toBe('Something went wrong');
    expect(base.details).toBeUndefined();

    const rootCause = new Error('disk full');
    class CustomEngineError extends RefereeError {}
    const custom = new CustomEngineError('Save failed', {
      code: 'SAVE_IO',
      details: { slot: 3 },
      cause: rootCause,
    });

    expect(custom).toBeInstanceOf(Error);
    expect(custom).toBeInstanceOf(RefereeError);
    expect(custom).toBeInstanceOf(CustomEngineError);
    expect(custom.name).toBe('CustomEngineError');
    expect(custom.code).toBe('SAVE_IO');
    expect(custom.details).toEqual({ slot: 3 });
    expect(custom.cause).toBe(rootCause);
  });

  it('formats validation errors and normalizes unknown errors via toRefereeError', () => {
    const vErr = validationError('clock.day', 'MIN_VALUE', 'Day must be >= 1');
    expect(formatValidationError(vErr)).toBe('clock.day [MIN_VALUE]: Day must be >= 1');
    expect(formatValidationErrors([vErr, validationError('', 'ROOT', 'Bad root')])).toBe(
      'clock.day [MIN_VALUE]: Day must be >= 1; <root> [ROOT]: Bad root'
    );

    expect(isValidationError(vErr)).toBe(true);
    expect(isValidationError(null)).toBe(false);
    expect(isValidationError({ path: 'x', code: 123, message: 'bad' })).toBe(false);

    const existing = new RefereeError('Already wrapped', { code: 'KNOWN' });
    expect(toRefereeError(existing)).toBe(existing);

    const fromStdError = toRefereeError(new TypeError('bad type'), 'TYPE_ERR');
    expect(fromStdError).toBeInstanceOf(RefereeError);
    expect(fromStdError.code).toBe('TYPE_ERR');
    expect(fromStdError.message).toBe('bad type');
    expect(fromStdError.cause).toBeInstanceOf(TypeError);

    const fromString = toRefereeError('oops');
    expect(fromString.code).toBe('INTERNAL_ERROR');
    expect(fromString.message).toBe('oops');

    const fromValidationList = toRefereeError([vErr]);
    expect(fromValidationList.code).toBe('VALIDATION_ERROR');
    expect(fromValidationList.details).toEqual([vErr]);

    const fromUnknown = toRefereeError({ weird: true });
    expect(fromUnknown.code).toBe('INTERNAL_ERROR');
    expect(fromUnknown.details).toEqual({ weird: true });
  });
});
