/**
 * Structured diagnostic entry returned by schema loaders, reducers, and validators.
 */
export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

/**
 * Options for constructing a {@link RefereeError}.
 */
export interface RefereeErrorOptions {
  code?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Base error class for fatal or unexpected engine errors in Referee.
 */
export class RefereeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: RefereeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'REFEREE_ERROR';
    if (options.details !== undefined) {
      this.details = options.details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Construct a {@link ValidationError} diagnostic object.
 */
export function validationError(path: string, code: string, message: string): ValidationError {
  return { path, code, message };
}

/**
 * Format a {@link ValidationError} as a single human-readable diagnostic string.
 */
export function formatValidationError(error: ValidationError): string {
  const location = error.path.length > 0 ? error.path : '<root>';
  return `${location} [${error.code}]: ${error.message}`;
}

/**
 * Format a list of {@link ValidationError} diagnostics as a concise summary string.
 */
export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map(formatValidationError).join('; ');
}

/**
 * Type guard checking whether an unknown value conforms to {@link ValidationError}.
 */
export function isValidationError(value: unknown): value is ValidationError {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'path' in value &&
    'code' in value &&
    'message' in value &&
    typeof value.path === 'string' &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

/**
 * Normalize an unknown thrown value into a {@link RefereeError}.
 */
export function toRefereeError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): RefereeError {
  if (error instanceof RefereeError) {
    return error;
  }
  if (error instanceof Error) {
    return new RefereeError(error.message, {
      code: fallbackCode,
      cause: error,
    });
  }
  if (typeof error === 'string') {
    return new RefereeError(error, { code: fallbackCode });
  }
  if (Array.isArray(error) && error.length > 0 && error.every(isValidationError)) {
    return new RefereeError(formatValidationErrors(error), {
      code: 'VALIDATION_ERROR',
      details: error,
    });
  }
  return new RefereeError('An unexpected non-Error value was thrown', {
    code: fallbackCode,
    details: error,
  });
}
