import { emitDomainEvent, type ConnectionStatus, type Trx } from '@flowza/database';
import type { DeviceRow } from './types.js';

/** Consecutive failed observations before a device is declared offline (hysteresis, AGENTS.md notifications rule). */
export const OFFLINE_AFTER_FAILURES = 3;

export interface HealthObservation {
  online: boolean;
  /** When the device was last seen according to the provider (falls back to now for a positive observation). */
  lastSeenAt?: Date | null;
  clockSkewSeconds?: number | null;
  firmwareVersion?: string | null;
  errorCode?: string | null;
  error?: string | null;
  /** Free-form details for the device_logs row (never secrets). */
  details?: Record<string, unknown>;
  /** device_logs event name. */
  event?: string;
  jobId?: string | null;
}

export interface HealthOutcome { previous: ConnectionStatus; current: ConnectionStatus; consecutiveFailures: number; transition: 'online' | 'offline' | null }

/**
 * Applies one health observation to `devices` with hysteresis: a positive observation resets the failure counter and marks the
 * device online (emitting `device.online` if it was offline); a negative one increments `consecutive_failures` and only the
 * third consecutive failure flips the device to `offline` (emitting `device.offline` once). `vendor_degraded` (open circuit)
 * is owned by the circuit breaker and is not overwritten by failures.
 */
export async function applyHealth(trx: Trx, device: DeviceRow, obs: HealthObservation, now: Date): Promise<HealthOutcome> {
  const previous = device.connectionStatus;
  let current: ConnectionStatus = previous;
  let consecutiveFailures = device.consecutiveFailures;
  let transition: HealthOutcome['transition'] = null;
  const patch: Record<string, unknown> = { lastClockSkewSeconds: obs.clockSkewSeconds ?? device.lastClockSkewSeconds ?? null };
  if (obs.firmwareVersion) patch['firmwareVersion'] = obs.firmwareVersion;
  if (obs.online) {
    consecutiveFailures = 0;
    current = 'online';
    const seen = obs.lastSeenAt ?? now;
    Object.assign(patch, { connectionStatus: 'online', consecutiveFailures: 0, lastHeartbeatAt: seen, lastSuccessfulCommunicationAt: seen, lastErrorCode: null, lastError: null });
    if (previous === 'offline') transition = 'online';
  } else {
    consecutiveFailures += 1;
    Object.assign(patch, { consecutiveFailures, lastErrorCode: obs.errorCode ?? 'DEVICE_OFFLINE', lastError: (obs.error ?? 'device did not respond').slice(0, 500), lastErrorAt: now });
    if (previous !== 'vendor_degraded') {
      if (consecutiveFailures >= OFFLINE_AFTER_FAILURES) {
        current = 'offline';
        if (previous !== 'offline') transition = 'offline';
      } else if (previous !== 'offline') {
        current = 'degraded';
      }
      patch['connectionStatus'] = current;
    }
  }
  await trx.updateTable('devices').set(patch as never).where('id', '=', device.id).execute();
  await trx.insertInto('deviceLogs').values({
    organizationId: device.organizationId, deviceId: device.id, level: obs.online ? 'info' : transition === 'offline' ? 'error' : 'warn', event: obs.event ?? 'health_check', jobId: obs.jobId ?? null,
    message: obs.online ? 'device reachable' : `device unreachable (${consecutiveFailures} consecutive failures)`,
    details: JSON.stringify({ online: obs.online, previous, current, consecutiveFailures, clockSkewSeconds: obs.clockSkewSeconds ?? null, errorCode: obs.errorCode ?? null, ...(obs.details ?? {}) }),
  }).execute();
  if (transition) {
    const lastSeenAt = (obs.online ? (obs.lastSeenAt ?? now) : (device.lastSuccessfulCommunicationAt ?? device.lastHeartbeatAt ?? null));
    await emitDomainEvent(trx, {
      organizationId: device.organizationId, eventType: transition === 'offline' ? 'device.offline' : 'device.online', aggregateType: 'device', aggregateId: device.id,
      payload: { deviceId: device.id, deviceName: device.name, branchId: device.branchId, lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null },
    });
  }
  return { previous, current, consecutiveFailures, transition };
}
