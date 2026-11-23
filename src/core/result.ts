import {
  RefereeError,
  ValidationError,
  formatValidationErrors,
  isValidationError,
  validationError,
} from './errors.js';

/**
 * Successful variant of a {@link Result}.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * Failure variant of a {@link Result}.
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Discriminated union representing either a success value `T` or a structured error `E`.
 */
export type Result<T, E = ValidationError[]> = Ok<T> | Err<E>;

/**
 * Extract the non-array item error type when combining multiple results.
 */
export type CombinedErrorItem<E> = E extends readonly (infer Item)[] ? Item : E;

/**
 * Extract the value tuple or array type when combining multiple results.
 */
export type CombinedValues<R extends readonly Result<unknown, unknown>[]> = {
  -readonly [K in keyof R]: R[K] extends Result<infer T, unknown> ? T : never;
};

/**
 * Extract the error union item from a single {@link Result} type, flattening one array level.
 */
export type ExtractResultError<R> = R extends Err<infer E> ? CombinedErrorItem<E> : never;

/**
 * Construct a successful {@link Result}.
 */
export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T> {
  return { ok: true, value: value as T };
}

/**
 * Construct a failed {@link Result}.
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Type guard narrowing a {@link Result} to {@link Ok}.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/**
 * Type guard narrowing a {@link Result} to {@link Err}.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Return the inner value of an {@link Ok} result, or throw a descriptive error on {@link Err}.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }

  const error: unknown = result.error;
  if (error instanceof Error) {
    throw error;
  }
  if (Array.isArray(error) && error.every(isValidationError)) {
    const summary = error.length > 0 ? formatValidationErrors(error) : 'Validation failed';
    throw new RefereeError(summary, {
      code: 'VALIDATION_ERROR',
      details: error,
    });
  }
  if (typeof error === 'string') {
    throw new RefereeError(error, { code: 'RESULT_UNWRAP_ERROR' });
  }
  throw new RefereeError('Attempted to unwrap an Err result', {
    code: 'RESULT_UNWRAP_ERROR',
    details: error,
  });
}

/**
 * Transform the value of an {@link Ok} result while preserving {@link Err} untouched.
 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Combine an array or tuple of {@link Result} values into a single {@link Result}.
 *
 * When all inputs are {@link Ok}, returns `ok` with the ordered values.
 * When any input is {@link Err}, accumulates all errors in order (flattening array-valued
 * errors such as `ValidationError[]`).
 */
export function combineResults<const R extends readonly Result<unknown, unknown>[]>(
  results: R
): Result<CombinedValues<R>, ExtractResultError<R[number]>[]> {
  const values: unknown[] = [];
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.ok) {
      values.push(result.value);
    } else if (Array.isArray(result.error)) {
      errors.push(...result.error);
    } else {
      errors.push(result.error);
    }
  }

  if (errors.length > 0) {
    return err(errors as ExtractResultError<R[number]>[]);
  }

  return ok(values as unknown as CombinedValues<R>);
}

function joinDiagnosticPath(prefix: string, path: string): string {
  if (prefix.length === 0) {
    return path;
  }
  if (path.length === 0) {
    return prefix;
  }
  if (path.startsWith('[') || path.startsWith('.')) {
    return `${prefix}${path}`;
  }
  return `${prefix}.${path}`;
}

/**
 * Mutable builder for collecting {@link ValidationError} entries with optional path scoping.
 */
export class ErrorAccumulator {
  private readonly target: ValidationError[];
  private readonly basePath: string;

  constructor(basePath = '', sharedTarget?: ValidationError[]) {
    this.basePath = basePath;
    this.target = sharedTarget ?? [];
  }

  /**
   * Append a validation error, prefixing `path` with this accumulator's scope if configured.
   */
  add(path: string, code: string, message: string): this {
    this.target.push(validationError(joinDiagnosticPath(this.basePath, path), code, message));
    return this;
  }

  /**
   * Append a pre-built {@link ValidationError}, applying this accumulator's path prefix.
   */
  addError(error: ValidationError): this {
    return this.add(error.path, error.code, error.message);
  }

  /**
   * Append multiple {@link ValidationError} entries, applying this accumulator's path prefix.
   */
  addAll(errors: readonly ValidationError[]): this {
    for (const error of errors) {
      this.addError(error);
    }
    return this;
  }

  /**
   * Create a child accumulator sharing the same backing error list under a nested path segment.
   */
  scope(subPath: string): ErrorAccumulator {
    return new ErrorAccumulator(joinDiagnosticPath(this.basePath, subPath), this.target);
  }

  /**
   * Merge a validation {@link Result} into this accumulator, returning its value when `Ok`
   * or recording its errors and returning `undefined` when `Err`.
   */
  absorb<T>(result: Result<T, readonly ValidationError[]>): T | undefined {
    if (result.ok) {
      return result.value;
    }
    this.addAll(result.error);
    return undefined;
  }

  /**
   * Return `true` when at least one validation error has been recorded.
   */
  hasErrors(): boolean {
    return this.target.length > 0;
  }

  /**
   * Return the number of recorded validation errors.
   */
  get count(): number {
    return this.target.length;
  }

  /**
   * Return a snapshot array of all recorded validation errors.
   */
  get errors(): readonly ValidationError[] {
    return [...this.target];
  }

  /**
   * Convert accumulated diagnostics into `ok(value)` when error-free, or `err(errors)` otherwise.
   */
  toResult(): Result<void, ValidationError[]>;
  toResult<T>(value: T): Result<T, ValidationError[]>;
  toResult<T>(value?: T): Result<T, ValidationError[]> {
    if (this.target.length > 0) {
      return err([...this.target]);
    }
    return ok(value as T);
  }
}
