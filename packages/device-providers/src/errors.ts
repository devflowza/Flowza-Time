import { ProviderError } from './types.js';

/**
 * Raised by push-protocol handlers and webhook parsers when a device/vendor sends something that does
 * not match the protocol (missing serial, malformed line, unknown enum value…). Never retryable: the
 * same bytes will fail again. `httpStatus` is the response the API route should send back.
 */
export class ProtocolError extends ProviderError {
  readonly httpStatus: number;
  constructor(message: string, opts: { details?: Record<string, unknown>; httpStatus?: number; cause?: unknown } = {}) {
    super('PROTOCOL_ERROR', message, { retryable: false, details: opts.details, cause: opts.cause });
    this.name = 'ProtocolError';
    this.httpStatus = opts.httpStatus ?? 400;
  }
  static override is(e: unknown): e is ProtocolError {
    return e instanceof ProtocolError || (ProviderError.is(e) && e.code === 'PROTOCOL_ERROR');
  }
}

export function notImplemented(providerName: string): ProviderError {
  return new ProviderError('NOT_IMPLEMENTED', `Provider ${providerName} requires vendor credentials/hardware verification — see docs/device-integrations.md`, {
    retryable: false,
    details: { provider: providerName },
  });
}

export function unsupported(operation: string, reason: string): ProviderError {
  return new ProviderError('UNSUPPORTED', `${operation} is not supported: ${reason}`, { retryable: false, details: { operation } });
}

/**
 * `details.reason` of the ProviderError a provider raises when it cannot read a stored sync cursor. The worker rewinds a cursor
 * ONLY on this marker: a missing password, a refused URL or an odd vendor answer (also INVALID_CONFIG / PROTOCOL_ERROR) must
 * fail the run and keep the cursor, or every unpulled row older than the rewind window would be skipped.
 */
export const INVALID_CURSOR_REASON = 'invalid_cursor';
export function invalidCursor(message: string, details: Record<string, unknown> = {}): ProviderError {
  return new ProviderError('INVALID_CONFIG', message, { retryable: false, details: { ...details, reason: INVALID_CURSOR_REASON } });
}
export function isInvalidCursorError(err: unknown): err is ProviderError {
  return ProviderError.is(err) && err.details?.['reason'] === INVALID_CURSOR_REASON;
}
