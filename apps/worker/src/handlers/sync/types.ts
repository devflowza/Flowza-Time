import type { Selectable } from 'kysely';
import type { Devices, SyncJobItems, SyncJobs } from '@flowza/database';
import type { SyncJobType } from '@flowza/contracts';

export type DeviceRow = Selectable<Devices>;
export type SyncJobRow = Selectable<SyncJobs>;
export type SyncJobItemRow = Selectable<SyncJobItems>;

/**
 * Queue payload of every per-item sync job (queue `sync`, jobType = `operation`). Produced by `createSyncJob()`
 * (handlers/sync/api.ts) and by the PUSH_EMPLOYEES / RECONCILIATION fan-outs. `options` is operation specific
 * (PULL_ATTENDANCE: { fullResync?, maxPages?, pageSize? }; PUSH_EMPLOYEE: { force?, pin? }; RECONCILIATION: { repair? }).
 */
export interface SyncItemPayload {
  syncJobId: string;
  syncJobItemId: string;
  organizationId: string;
  deviceId: string | null;
  employeeId: string | null;
  operation: SyncJobType;
  options: Record<string, unknown>;
}

export interface OrgSyncSettings {
  defaultIntervalMinutes: number;
  adaptivePolling: boolean;
  offlineThresholdMinutes: number;
  reconciliationIntervalHours: number;
  /** Ceiling for the adaptive polling interval (minutes). Not part of the public settings schema yet. */
  maxIntervalMinutes: number;
  /** Device clock skew beyond which punches are quarantined (minutes). Not part of the public settings schema yet. */
  maxClockSkewMinutes: number;
}

export const DEFAULT_ORG_SYNC_SETTINGS: OrgSyncSettings = {
  defaultIntervalMinutes: 5,
  adaptivePolling: true,
  offlineThresholdMinutes: 15,
  reconciliationIntervalHours: 24,
  maxIntervalMinutes: 60,
  maxClockSkewMinutes: 60,
};

export const FINAL_ITEM_STATUSES = ['SUCCESS', 'FAILED', 'UNSUPPORTED', 'CANCELLED', 'SKIPPED'] as const;
export const IN_FLIGHT_ITEM_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'RETRYING'] as const;
