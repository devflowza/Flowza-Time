import { sql } from 'kysely';
import type { CircuitState, Trx } from '@flowza/database';
import { accountKeyFor } from './context.js';

export interface CircuitKey { organizationId: string; providerKey: string; accountKey: string }
export interface CircuitPolicy { failureThreshold: number; openMs: number }
export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = { failureThreshold: 5, openMs: 5 * 60_000 };

/** Error codes that indicate the vendor/account is unhealthy (as opposed to one device or one bad credential). */
export const VENDOR_ERROR_CODES = new Set(['VENDOR_ERROR', 'TIMEOUT', 'RATE_LIMITED']);

export interface CircuitDecision { state: CircuitState; halfOpenAt: Date | null; failureCount: number; /** true when the caller may talk to the vendor (closed, or the half-open probe). */ allow: boolean }

interface CircuitRow { state: CircuitState; halfOpenAt: Date | null; failureCount: number }

async function loadRow(trx: Trx, key: CircuitKey): Promise<CircuitRow | null> {
  const row = await trx.selectFrom('providerCircuitStates').select(['state', 'halfOpenAt', 'failureCount'])
    .where('organizationId', '=', key.organizationId).where('providerKey', '=', key.providerKey).where('accountKey', '=', key.accountKey).executeTakeFirst();
  return row ?? null;
}

/**
 * Circuit breaker check before a vendor call (§F.6, AGENTS.md). `open` → the caller reschedules to `halfOpenAt`;
 * when `halfOpenAt` has passed the circuit moves to `half_open` and exactly this caller gets the probe.
 */
export async function checkCircuit(trx: Trx, key: CircuitKey, now: Date, policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY): Promise<CircuitDecision> {
  const row = await loadRow(trx, key);
  if (!row || row.state === 'closed') return { state: 'closed', halfOpenAt: null, failureCount: row?.failureCount ?? 0, allow: true };
  if (row.state === 'open' && row.halfOpenAt && row.halfOpenAt.getTime() <= now.getTime()) {
    const probe = await trx.updateTable('providerCircuitStates').set({ state: 'half_open', halfOpenAt: now })
      .where('organizationId', '=', key.organizationId).where('providerKey', '=', key.providerKey).where('accountKey', '=', key.accountKey).where('state', '=', 'open')
      .returning('id').executeTakeFirst();
    // Another worker may have flipped it first and is already probing; only one probe per half-open window.
    return { state: 'half_open', halfOpenAt: row.halfOpenAt, failureCount: row.failureCount, allow: probe !== undefined };
  }
  if (row.state === 'half_open') {
    // `half_open_at` is stamped when the probe was handed out. A probe whose worker died (or whose outcome never reached the
    // breaker) would otherwise pin the circuit half-open forever; after a full open window a new probe may be handed out.
    const probeExpired = !row.halfOpenAt || row.halfOpenAt.getTime() + policy.openMs <= now.getTime();
    if (!probeExpired) return { state: 'half_open', halfOpenAt: row.halfOpenAt, failureCount: row.failureCount, allow: false };
    const probe = await trx.updateTable('providerCircuitStates').set({ halfOpenAt: now })
      .where('organizationId', '=', key.organizationId).where('providerKey', '=', key.providerKey).where('accountKey', '=', key.accountKey).where('state', '=', 'half_open')
      .where((eb) => eb.or([eb('halfOpenAt', 'is', null), eb('halfOpenAt', '<=', new Date(now.getTime() - policy.openMs))]))
      .returning('id').executeTakeFirst();
    return { state: 'half_open', halfOpenAt: row.halfOpenAt, failureCount: row.failureCount, allow: probe !== undefined };
  }
  return { state: 'open', halfOpenAt: row.halfOpenAt, failureCount: row.failureCount, allow: false };
}

/** Devices belonging to the same vendor account (account key derived from config, so filtered in JS). */
async function accountDeviceIds(trx: Trx, key: CircuitKey): Promise<string[]> {
  const rows = await trx.selectFrom('devices').select(['id', 'config', 'endpointUrl', 'serialNumber', 'integrationType'])
    .where('organizationId', '=', key.organizationId).where('providerKey', '=', key.providerKey).where('status', '=', 'active').execute();
  return rows.filter((d) => accountKeyFor(d) === key.accountKey).map((d) => d.id);
}

/**
 * Records a vendor-level failure. Opens the circuit after `failureThreshold` consecutive failures (or immediately when a
 * half-open probe fails); open circuits mark the account's devices `vendor_degraded` — an outage is not "device offline".
 */
export async function recordFailure(trx: Trx, key: CircuitKey, err: { code: string; message: string }, now: Date, policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY): Promise<{ state: CircuitState; failureCount: number; opened: boolean }> {
  const row = await loadRow(trx, key);
  const failureCount = (row?.failureCount ?? 0) + 1;
  const wasOpenish = row?.state === 'half_open' || row?.state === 'open';
  const open = wasOpenish || failureCount >= policy.failureThreshold;
  const halfOpenAt = open ? new Date(now.getTime() + policy.openMs) : null;
  const state: CircuitState = open ? 'open' : 'closed';
  const lastError = err.message.slice(0, 500);
  await trx.insertInto('providerCircuitStates')
    .values({ organizationId: key.organizationId, providerKey: key.providerKey, accountKey: key.accountKey, state, failureCount, lastErrorCode: err.code, lastError, openedAt: open ? now : null, halfOpenAt })
    .onConflict((oc) => oc.columns(['organizationId', 'providerKey', 'accountKey']).doUpdateSet({
      state, failureCount, lastErrorCode: err.code, lastError, halfOpenAt,
      // keep the original opened_at while the circuit stays open; a fresh opening stamps now
      openedAt: open ? sql`case when provider_circuit_states.state = 'open' then provider_circuit_states.opened_at else ${now} end` : null,
    })).execute();
  const opened = open && row?.state !== 'open';
  if (opened) {
    const ids = await accountDeviceIds(trx, key);
    if (ids.length > 0) await trx.updateTable('devices').set({ connectionStatus: 'vendor_degraded' }).where('id', 'in', ids).where('connectionStatus', '<>', 'offline').execute();
  }
  return { state: open ? 'open' : 'closed', failureCount, opened };
}

/** A successful vendor call closes the circuit and lifts `vendor_degraded` from the account's devices. */
export async function recordSuccess(trx: Trx, key: CircuitKey): Promise<{ closed: boolean }> {
  const row = await loadRow(trx, key);
  if (!row) return { closed: false };
  if (row.state === 'closed' && row.failureCount === 0) return { closed: false };
  await trx.updateTable('providerCircuitStates').set({ state: 'closed', failureCount: 0, halfOpenAt: null, openedAt: null })
    .where('organizationId', '=', key.organizationId).where('providerKey', '=', key.providerKey).where('accountKey', '=', key.accountKey).execute();
  const wasOpen = row.state !== 'closed';
  if (wasOpen) {
    const ids = await accountDeviceIds(trx, key);
    if (ids.length > 0) await trx.updateTable('devices').set({ connectionStatus: 'unknown' }).where('id', 'in', ids).where('connectionStatus', '=', 'vendor_degraded').execute();
  }
  return { closed: wasOpen };
}
