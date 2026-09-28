import { z } from 'zod';
import { CONNECTION_STATUSES, SYNC_JOB_TYPES, SYNC_STATUSES, SYNC_TRIGGERS } from './enums.js';
import { isoDateTimeSchema, uuidSchema } from './common.js';

/**
 * Flowza Finance ↔ FlowZa Time attendance connector (docs/integrations/flowza-finance.md).
 *
 * One credential pair — the serial + push token of a Finance *virtual device* (`attendance_devices`, `agent_rest`) — drives
 * both directions: the worker PULLS Finance punches through `attendance-export` and PUSHES FlowZa Time punches to
 * `attendance-ingest`. In FlowZa Time the connector is one `devices` row per organisation with provider `flowza_finance`;
 * the token lives in `device_credentials` (DeviceCredentialsStore) and never reaches a client.
 */
export const FLOWZA_FINANCE_PROVIDER_KEY = 'flowza_finance';
/** Finance's Supabase functions root: `<base>/attendance-export` and `<base>/attendance-ingest`. */
export const FINANCE_DEFAULT_BASE_URL = 'https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1';
/** Which employee field is sent to Finance as the punch PIN (and matched on pull). Finance maps PIN = employee number by default. */
export const FINANCE_PIN_KEYS = ['employee_number', 'device_user_id', 'card_number'] as const;
export type FinancePinKey = (typeof FINANCE_PIN_KEYS)[number];
export const FINANCE_SYNC_DIRECTIONS = ['pull', 'push', 'both'] as const;
export type FinanceSyncDirection = (typeof FINANCE_SYNC_DIRECTIONS)[number];
/** Poll cadence bounds (minutes). Finance shows the connector Online below 5 min and Stale below 60 min between contacts. */
export const FINANCE_POLL_MINUTES = { min: 5, max: 60, default: 10 } as const;
/** Default start date of a new connector: this many days before the day it is set up (organisation timezone). */
export const FINANCE_SYNC_FROM_DEFAULT_DAYS = 30;
/**
 * Attempts of a push batch Finance answers 2xx but with per-punch errors: retried (same batch, position not advanced) until this
 * many attempts, then skipped as poison — recorded, alerted, never sent again (docs/integrations/flowza-finance.md §6).
 */
export const FINANCE_PUSH_BATCH_MAX_ATTEMPTS = 5;
/**
 * `details.reason` of the 409 the generic device endpoints answer for the connector: it is managed only in Settings → Integrations
 * (behind integration.manage), never through device.update / device.manage / device.sync.
 */
export const CONNECTOR_MANAGED_IN_INTEGRATIONS = 'CONNECTOR_MANAGED_IN_INTEGRATIONS';

export const financeBaseUrlSchema = z.url().max(300);
export const financeDeviceSerialSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'Letters, digits, - _ . only');
export const financeTokenSchema = z.string().trim().min(8).max(256);
/** A calendar day (`YYYY-MM-DD`) in the organisation timezone. */
export const financeSyncFromSchema = z.iso.date();

/** PUT /orgs/:orgId/integrations/finance — a full replacement, so defaults are fine here (no PATCH semantics). */
export const financeIntegrationInputSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: financeBaseUrlSchema.default(FINANCE_DEFAULT_BASE_URL),
  deviceSerial: financeDeviceSerialSchema,
  /** Required when the connector is created or when baseUrl/deviceSerial change; omitted = keep the stored token. */
  token: financeTokenSchema.optional(),
  direction: z.enum(FINANCE_SYNC_DIRECTIONS).default('both'),
  pinKey: z.enum(FINANCE_PIN_KEYS).default('employee_number'),
  pollMinutes: z.number().int().min(FINANCE_POLL_MINUTES.min).max(FINANCE_POLL_MINUTES.max).default(FINANCE_POLL_MINUTES.default),
  /**
   * Start date: punches before it are never synchronised, and the first pull / first push start there instead of at the beginning
   * of history. Omitted = keep the stored date (or, on creation, FINANCE_SYNC_FROM_DEFAULT_DAYS before today). Never in the future.
   * Moving it EARLIER re-reads Finance and re-sends FlowZa Time punches from the new date (both sides dedupe).
   */
  syncFrom: financeSyncFromSchema.optional(),
  /** Branch the connector device is attached to (default: the organisation's first active branch). */
  branchId: uuidSchema.optional(),
});
export type FinanceIntegrationInput = z.infer<typeof financeIntegrationInputSchema>;

/** POST /orgs/:orgId/integrations/finance/test — values not supplied come from the stored connector (the token is never echoed). */
export const financeIntegrationTestSchema = z.object({
  baseUrl: financeBaseUrlSchema.optional(),
  deviceSerial: financeDeviceSerialSchema.optional(),
  token: financeTokenSchema.optional(),
});
export type FinanceIntegrationTestInput = z.infer<typeof financeIntegrationTestSchema>;

export const financeIntegrationDtoSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  deviceId: uuidSchema.nullable(),
  branchId: uuidSchema.nullable(),
  baseUrl: z.string(),
  deviceSerial: z.string().nullable(),
  direction: z.enum(FINANCE_SYNC_DIRECTIONS),
  pinKey: z.enum(FINANCE_PIN_KEYS),
  pollMinutes: z.number().int(),
  /** Start date (`YYYY-MM-DD`); for an unconfigured connector, the default a new one would get. */
  syncFrom: z.string(),
  hasToken: z.boolean(),
  /** Masked (`****abcd`) — the token itself is never returned. */
  tokenMasked: z.string().nullable(),
  connectionStatus: z.enum([...CONNECTION_STATUSES, 'vendor_degraded']).nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type FinanceIntegrationDto = z.infer<typeof financeIntegrationDtoSchema>;

export interface FinanceIntegrationTestDto {
  ok: boolean;
  message: string;
  latencyMs: number;
  code: string | null;
  retryable: boolean;
  /** Finance's `server_time` from the export response. */
  serverTime: string | null;
  /** `time_utc` of the first punch the export returned (null when Finance holds no punches yet). */
  firstPunchAt: string | null;
  usedStoredCredentials: boolean;
}

export interface FinanceSyncNowDto {
  pullJobId: string | null;
  pushJobId: string | null;
  message: string;
}

export const financeSyncStateDtoSchema = z.object({
  lastPushedEventId: uuidSchema.nullable(),
  lastPushedEventAt: isoDateTimeSchema.nullable(),
  /** Push window anchor: every eligible event created up to this instant has been examined. */
  pushPositionAt: isoDateTimeSchema.nullable(),
  /** Attempts of a batch Finance answered with per-punch errors (0 = none pending; skipped after 5). */
  pushRetryAttempts: z.number().int(),
  lastPushAt: isoDateTimeSchema.nullable(),
  lastPushCount: z.number().int(),
  nextPushAt: isoDateTimeSchema.nullable(),
  lastPullAt: isoDateTimeSchema.nullable(),
  lastPullCount: z.number().int(),
  lastError: z.string().nullable(),
  lastErrorAt: isoDateTimeSchema.nullable(),
  consecutiveFailures: z.number().int(),
  updatedAt: isoDateTimeSchema,
});
export type FinanceSyncStateDto = z.infer<typeof financeSyncStateDtoSchema>;

export const financeRecentJobDtoSchema = z.object({
  id: uuidSchema,
  jobType: z.enum(SYNC_JOB_TYPES),
  trigger: z.enum(SYNC_TRIGGERS),
  status: z.enum(SYNC_STATUSES),
  createdAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  recordsIngested: z.number().int(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  /** Result of the connector's item (pages / inserted / pushed …), when the item finished. */
  itemResult: z.record(z.string(), z.unknown()).nullable(),
});
export type FinanceRecentJobDto = z.infer<typeof financeRecentJobDtoSchema>;

export interface FinanceIntegrationStatusDto {
  configured: boolean;
  enabled: boolean;
  deviceId: string | null;
  connectionStatus: string | null;
  state: FinanceSyncStateDto | null;
  cursor: { lastPulledAt: string | null; lastTransactionAt: string | null } | null;
  circuit: { state: string; halfOpenAt: string | null; failureCount: number } | null;
  /** Pulled Finance punches whose employee could not be resolved (reconciliation triage). */
  unmatchedCount: number;
  /** Pulled Finance punches still waiting for the normaliser. */
  pendingCount: number;
  lastJobs: FinanceRecentJobDto[];
}
