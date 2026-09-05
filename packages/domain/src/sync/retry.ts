import { DEFAULT_RETRY_POLICY, type AdaptivePollingState, type RetryDecision, type RetryPolicy, type SyncErrorCode } from './types.js';

/** Classification of every provider error code (§F.4). */
export type ErrorClass = 'RETRYABLE' | 'OFFLINE' | 'RATE_LIMITED' | 'TERMINAL_FAILED' | 'TERMINAL_UNSUPPORTED';

export const ERROR_CLASSES: Record<SyncErrorCode, ErrorClass> = {
  AUTH_FAILED: 'TERMINAL_FAILED',
  INVALID_CONFIG: 'TERMINAL_FAILED',
  PROTOCOL_ERROR: 'TERMINAL_FAILED',
  NOT_FOUND: 'TERMINAL_FAILED',
  CONFLICT: 'TERMINAL_FAILED',
  UNSUPPORTED: 'TERMINAL_UNSUPPORTED',
  NOT_IMPLEMENTED: 'TERMINAL_UNSUPPORTED',
  DEVICE_OFFLINE: 'OFFLINE',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'RETRYABLE',
  VENDOR_ERROR: 'RETRYABLE',
  INTERNAL: 'RETRYABLE',
};

export function classifyError(code: SyncErrorCode): ErrorClass {
  return ERROR_CLASSES[code];
}

/** FNV-1a 32-bit hash → [0, 1). Deterministic so retry schedules are reproducible in tests and audits. */
export function unitHash(seed: string | number): number {
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** Exponential backoff without jitter for the given attempt (1-based: the attempt that just failed). */
export function baseBackoffMs(attempt: number, policy: RetryPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** exponent);
}

/** Symmetric jitter of ±`jitterRatio` applied deterministically from `seed`; result is never below zero. */
export function applyJitter(delayMs: number, jitterRatio: number, seed: string | number | undefined): number {
  if (jitterRatio <= 0 || seed === undefined) return Math.round(delayMs);
  const offset = (unitHash(seed) * 2 - 1) * jitterRatio; // [-ratio, +ratio)
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

/**
 * Decide what happens to a sync item after a failure (§F.4, §63, §79).
 *
 * @param attempt  Number of attempts made so far, including the one that just failed (1-based).
 * @param retryAfterMs  Provider-supplied wait (RATE_LIMITED); honoured verbatim and never shortened.
 * @param seed  Any stable value (job id, `${itemId}:${attempt}`) that makes jitter deterministic; without a
 *              seed the un-jittered backoff is returned.
 */
export function decideRetry(
  errorCode: SyncErrorCode,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs?: number | null,
  seed?: string | number,
): RetryDecision {
  const klass = classifyError(errorCode);
  if (klass === 'TERMINAL_FAILED') return { retry: false, delayMs: 0, itemStatus: 'FAILED' };
  if (klass === 'TERMINAL_UNSUPPORTED') return { retry: false, delayMs: 0, itemStatus: 'UNSUPPORTED' };

  const exhausted = attempt >= policy.maxAttempts;
  if (exhausted) return { retry: false, delayMs: 0, itemStatus: klass === 'OFFLINE' ? 'OFFLINE' : 'FAILED' };

  const backoff = applyJitter(baseBackoffMs(attempt, policy), policy.jitterRatio, seed);
  if (klass === 'RATE_LIMITED' && typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return { retry: true, delayMs: Math.max(Math.round(retryAfterMs), backoff), itemStatus: 'RETRYING' };
  }
  return { retry: true, delayMs: backoff, itemStatus: klass === 'OFFLINE' ? 'OFFLINE' : 'RETRYING' };
}

/** Empty polls before the interval doubles (§F.3). */
export const ADAPTIVE_EMPTY_POLLS_PER_STEP = 3;

export interface AdaptivePollingResult {
  state: AdaptivePollingState;
  /** Minutes until the next poll. */
  intervalMinutes: number;
}

/**
 * Adaptive polling: `base × 2^floor(emptyPolls / 3)`, capped at `maxIntervalMinutes`; any poll that returns
 * data resets the counter and the interval to the base.
 */
export function nextAdaptiveInterval(state: AdaptivePollingState, hadData: boolean): AdaptivePollingResult {
  const base = Math.max(1, state.baseIntervalMinutes);
  const max = Math.max(base, state.maxIntervalMinutes);
  const emptyPollCount = hadData ? 0 : state.emptyPollCount + 1;
  const steps = Math.floor(emptyPollCount / ADAPTIVE_EMPTY_POLLS_PER_STEP);
  const intervalMinutes = Math.min(max, base * 2 ** steps);
  return { state: { ...state, emptyPollCount }, intervalMinutes };
}
