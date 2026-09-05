import { sql } from 'kysely';
import { rawTransactionSchema, type RawTransaction } from '@flowza/contracts';
import { withContext, type Trx } from '@flowza/database';
import { ProviderError, type AttendancePullResult, type SyncCursor } from '@flowza/device-providers';
import { nextAdaptiveInterval } from '@flowza/domain';
import { AppError, event } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { checkCircuit } from './circuit.js';
import { capabilitiesOf, circuitOpenError, handleProviderFailure, handleProviderSuccess, loadDeviceOrThrow, requireCapability } from './common.js';
import { buildProviderContext, loadOrgSyncSettings } from './context.js';
import { applyHealth } from './health.js';
import { ingestRawTransactions, type IngestResult } from './ingest.js';
import { runItem } from './items.js';
import type { DeviceRow } from './types.js';

export const DEFAULT_MAX_PAGES = 20;
export const INVALID_CURSOR_REWIND_DAYS = 7;
export const FULL_RESYNC_FLOOR_DAYS = 365;
const CURSOR_RESET_CODES = new Set(['INVALID_CONFIG', 'PROTOCOL_ERROR']);

function num(v: unknown, fallback: number, min = 1, max = 10_000): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

const cursorOrNull = (c: unknown): SyncCursor | null => (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c as object).length > 0 ? (c as SyncCursor) : null);

async function saveCursor(trx: Trx, device: DeviceRow, cursor: SyncCursor, transactions: RawTransaction[], now: Date): Promise<void> {
  const latest = transactions.reduce<Date | null>((acc, t) => { const d = new Date(t.punchedAt); return !acc || d > acc ? d : acc; }, null);
  await trx.insertInto('syncCursors').values({ organizationId: device.organizationId, deviceId: device.id, stream: 'attendance', cursor: JSON.stringify(cursor), lastPulledAt: now, lastTransactionAt: latest })
    .onConflict((oc) => oc.columns(['deviceId', 'stream']).doUpdateSet({ cursor: JSON.stringify(cursor), lastPulledAt: now, lastTransactionAt: latest ? sql`greatest(coalesce(sync_cursors.last_transaction_at, ${latest}), ${latest})` : sql`sync_cursors.last_transaction_at` })).execute();
}

/** Unparseable cursor → time-based rewind (last 7 days), history kept on the row, warning in device_logs (AGENTS.md cursor rule). */
async function resetInvalidCursor(trx: Trx, device: DeviceRow, previous: SyncCursor, err: ProviderError, now: Date): Promise<void> {
  await trx.insertInto('syncCursors').values({ organizationId: device.organizationId, deviceId: device.id, stream: 'attendance', cursor: '{}', previousCursor: JSON.stringify(previous), invalidSince: now, rewoundAt: now, rewindReason: `invalid_cursor:${err.code}` })
    .onConflict((oc) => oc.columns(['deviceId', 'stream']).doUpdateSet({ cursor: '{}', previousCursor: JSON.stringify(previous), invalidSince: now, rewoundAt: now, rewoundBy: null, rewindReason: `invalid_cursor:${err.code}` })).execute();
  await trx.insertInto('deviceLogs').values({ organizationId: device.organizationId, deviceId: device.id, level: 'warn', event: 'cursor_reset', message: `attendance cursor rejected by provider (${err.code}); rewound ${INVALID_CURSOR_REWIND_DAYS} days`, details: JSON.stringify({ code: err.code, previousCursor: previous }) }).execute();
}

/**
 * PULL_ATTENDANCE for one device: circuit check → cursor → page loop (`provider.pullAttendance` outside any transaction, each
 * page ingested + cursor advanced in its own transaction) → adaptive next poll. DEVICE_PUSH devices never get pulled: the item
 * only refreshes health from the last heartbeat.
 */
export async function pullAttendance(ctx: JobContext) {
  const { deps, log } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const maxPages = num(payload.options['maxPages'], DEFAULT_MAX_PAGES, 1, 500);
    const pageSize = typeof payload.options['pageSize'] === 'number' ? num(payload.options['pageSize'], 200, 1, 5000) : undefined;
    const fullResync = payload.options['fullResync'] === true;
    const prep = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      const settings = await loadOrgSyncSettings(trx, payload.organizationId);
      if (device.integrationType === 'DEVICE_PUSH') {
        const online = !!device.lastHeartbeatAt && now.getTime() - new Date(device.lastHeartbeatAt).getTime() <= device.offlineThresholdMinutes * 60_000;
        const health = await applyHealth(trx, device, { online, lastSeenAt: device.lastHeartbeatAt, event: 'push_health_refresh', jobId: item.syncJobId }, now);
        return { push: true as const, online, health };
      }
      const provider = deps.providers.get(device.providerKey);
      requireCapability(capabilitiesOf(device, provider), 'attendancePull', 'pullAttendance');
      const built = await buildProviderContext(trx, deps, device, ctx.job.id, ctx.signal, { log, provider });
      const circuit = await checkCircuit(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey: built.accountKey }, now);
      const cursorRow = await trx.selectFrom('syncCursors').select(['cursor']).where('deviceId', '=', device.id).where('stream', '=', 'attendance').executeTakeFirst();
      return { push: false as const, device, settings, built, circuit, cursor: cursorOrNull(cursorRow?.cursor) };
    });
    if (prep.push) return { result: { mode: 'push', pending: true, online: prep.online, connectionStatus: prep.health.current } };
    const { device, settings, built } = prep;
    if (!prep.circuit.allow) { built.dispose(); throw circuitOpenError(prep.circuit.halfOpenAt, now); }
    const key = { organizationId: device.organizationId, providerKey: device.providerKey, accountKey: built.accountKey };
    const totals: IngestResult = { inserted: 0, duplicates: 0, quarantined: 0, held: 0, ids: [] };
    let pages = 0;
    let hasMore = false;
    let cursorResets = 0;
    let cursor = fullResync ? null : prep.cursor;
    let since: string | undefined = fullResync ? new Date(now.getTime() - FULL_RESYNC_FLOOR_DAYS * 86_400_000).toISOString() : undefined;
    try {
      for (let i = 0; i < maxPages; i++) {
        let page: AttendancePullResult;
        try {
          page = await built.provider.pullAttendance(built.ctx, cursor, { ...(pageSize !== undefined ? { pageSize } : {}), ...(since !== undefined ? { since } : {}) });
        } catch (err) {
          if (!(i === 0 && cursor !== null && ProviderError.is(err) && CURSOR_RESET_CODES.has(err.code))) throw err;
          const bad = cursor;
          await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, (trx) => resetInvalidCursor(trx, device, bad, err, deps.now()));
          log.warn(event('sync_cursor_reset', { deviceId: device.id, code: err.code }));
          cursorResets++;
          cursor = null;
          since = new Date(now.getTime() - INVALID_CURSOR_REWIND_DAYS * 86_400_000).toISOString();
          page = await built.provider.pullAttendance(built.ctx, null, { ...(pageSize !== undefined ? { pageSize } : {}), since });
        }
        const transactions = page.transactions.flatMap((t) => { const p = rawTransactionSchema.safeParse(t); return p.success ? [p.data] : []; });
        const ingested = await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
          const r = await ingestRawTransactions(trx, { organizationId: device.organizationId, device, source: 'POLL', syncJobId: item.syncJobId, transactions, now: deps.now(), settings, queue: deps.queue });
          await saveCursor(trx, device, page.nextCursor, transactions, deps.now());
          return r;
        });
        pages++;
        totals.inserted += ingested.inserted; totals.duplicates += ingested.duplicates; totals.quarantined += ingested.quarantined; totals.held += ingested.held;
        cursor = page.nextCursor;
        since = undefined;
        hasMore = page.hasMore;
        if (!page.hasMore) break;
        ctx.signal.throwIfAborted();
      }
      const adaptive = await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
        const base = Math.max(1, device.syncIntervalMinutes);
        const max = settings.adaptivePolling ? Math.max(base, settings.maxIntervalMinutes) : base;
        const next = nextAdaptiveInterval({ baseIntervalMinutes: base, emptyPollCount: device.emptyPollCount, maxIntervalMinutes: max }, totals.inserted > 0);
        const intervalMinutes = hasMore ? 1 : next.intervalMinutes; // more pages waiting → come back right away
        const at = deps.now();
        await trx.updateTable('devices').set({ nextAttendanceSyncAt: new Date(at.getTime() + intervalMinutes * 60_000), adaptiveIntervalMinutes: next.intervalMinutes, emptyPollCount: next.state.emptyPollCount }).where('id', '=', device.id).execute();
        await handleProviderSuccess(trx, device, built.accountKey);
        return { intervalMinutes, emptyPollCount: next.state.emptyPollCount };
      });
      return { recordsIngested: totals.inserted, result: { pages, inserted: totals.inserted, duplicates: totals.duplicates, quarantined: totals.quarantined, held: totals.held, hasMore, cursorResets, fullResync, nextIntervalMinutes: adaptive.intervalMinutes, emptyPollCount: adaptive.emptyPollCount } };
    } catch (err) {
      await handleProviderFailure(ctx, device, key.accountKey, err);
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new AppError('PROVIDER_TIMEOUT', err.message, { retryable: true, cause: err });
      throw err;
    } finally {
      built.dispose();
    }
  });
}
