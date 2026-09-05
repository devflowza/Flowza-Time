/** Provider-agnostic retry policy inputs (§63, §79). */
export interface RetryPolicy {
  baseDelayMs: number;      // 30_000
  factor: number;           // 2
  maxDelayMs: number;       // 1_800_000
  maxAttempts: number;      // 6
  jitterRatio: number;      // 0.2 → ±20%
}
export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseDelayMs: 30_000, factor: 2, maxDelayMs: 1_800_000, maxAttempts: 6, jitterRatio: 0.2 };

export type SyncErrorCode = 'AUTH_FAILED' | 'DEVICE_OFFLINE' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNSUPPORTED' | 'NOT_FOUND' | 'INVALID_CONFIG' | 'VENDOR_ERROR' | 'NOT_IMPLEMENTED' | 'PROTOCOL_ERROR' | 'CONFLICT' | 'INTERNAL';

export interface RetryDecision { retry: boolean; delayMs: number; itemStatus: 'RETRYING' | 'FAILED' | 'OFFLINE' | 'UNSUPPORTED' }

/** Adaptive polling state per device (§F.3). */
export interface AdaptivePollingState { baseIntervalMinutes: number; emptyPollCount: number; maxIntervalMinutes: number }
