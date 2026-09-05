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
