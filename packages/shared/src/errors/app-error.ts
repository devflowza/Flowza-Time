/**
 * Standardised application error. Every error that can cross a boundary (HTTP, job) is an AppError.
 * `code` is stable and machine-readable; `message` is safe to show to users; `details` is optional
 * structured context (never stack traces or secrets).
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ENTITLEMENT_EXCEEDED'
  | 'FEATURE_DISABLED'
  | 'PERIOD_LOCKED'
  | 'INVALID_STATE'
  | 'DEVICE_OFFLINE'
  | 'DEVICE_UNSUPPORTED_OPERATION'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NOT_IMPLEMENTED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_CONFLICT: 409,
  ENTITLEMENT_EXCEEDED: 402,
  FEATURE_DISABLED: 403,
  PERIOD_LOCKED: 409,
  INVALID_STATE: 409,
  DEVICE_OFFLINE: 503,
  DEVICE_UNSUPPORTED_OPERATION: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_AUTH_FAILED: 502,
  PROVIDER_RATE_LIMITED: 503,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_NOT_IMPLEMENTED: 501,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Whether a job runner may retry the operation. Defaults to false. */
  retryable?: boolean;
  retryAfterMs?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  static is(err: unknown): err is AppError {
    return err instanceof AppError || (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AppError');
  }

  toJSON(requestId?: string) {
    return {
      code: this.code,
      message: this.message,
      ...(requestId ? { requestId } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) => new AppError('VALIDATION_ERROR', message, { details }),
  unauthenticated: (message = 'Authentication required.') => new AppError('UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action.') => new AppError('FORBIDDEN', message),
  notFound: (entity: string, id?: string) => new AppError('NOT_FOUND', `${entity} not found.`, id ? { details: { id } } : {}),
  conflict: (message: string, details?: Record<string, unknown>) => new AppError('CONFLICT', message, { details }),
  invalidState: (message: string, details?: Record<string, unknown>) => new AppError('INVALID_STATE', message, { details }),
  periodLocked: (message = 'The attendance period is locked.') => new AppError('PERIOD_LOCKED', message),
  entitlement: (metric: string, limit: number) => new AppError('ENTITLEMENT_EXCEEDED', `Your plan limit for ${metric} (${limit}) has been reached.`, { details: { metric, limit } }),
  featureDisabled: (feature: string) => new AppError('FEATURE_DISABLED', `The feature "${feature}" is not enabled for this organisation.`, { details: { feature } }),
  internal: (message = 'An unexpected error occurred.', cause?: unknown) => new AppError('INTERNAL_ERROR', message, { cause }),
  dependency: (name: string, cause?: unknown) => new AppError('DEPENDENCY_UNAVAILABLE', `${name} is currently unavailable.`, { cause, retryable: true }),
};

/** Convert any thrown value into an AppError without leaking internals. */
export function toAppError(err: unknown): AppError {
  if (AppError.is(err)) return err as AppError;
  return errors.internal(undefined, err);
}
