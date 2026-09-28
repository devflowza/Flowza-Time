import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { useMe } from '@/features/me/use-me';
import { PA_NS } from './attendance-i18n';
import { postPunch } from './attendance-api';
import { SELF } from './api';
import { discardOwn, punchQueueStore, purgeUnattributed, queuedPunches, replayQueue, type QueuedPunch, type SendOutcome } from './offline-queue';

/** A failure that no response answered (offline, DNS, timeout) or a server-side hiccup: keep the punch and retry later. */
export const isRetryable = (e: unknown): boolean => !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

/**
 * How a replayed punch ended (Finance B-30). A failure nobody answered is retried later. DUPLICATE_PUNCH means the server
 * already holds a punch inside the duplicate window: it counts as sent ONLY when the duplicate is of this punch's own
 * direction (`details.direction`, HR portal Prompt 4 review P1-4) — the first tap went through before the connection dropped.
 * A duplicate of the other direction is not this punch: it stays queued with the server's message and is sent again later.
 * Any other refusal is the server's judgement of this punch (outside the fence, window closed…): it is dropped from the
 * queue and the employee is told.
 */
export function sendOutcomeOf(e: unknown, punch?: Pick<QueuedPunch, 'direction'>): SendOutcome {
  if (isRetryable(e)) return { kind: 'retry', error: e instanceof Error ? e.message : String(e) };
  const reason = e instanceof ApiError ? String(e.details?.['reason'] ?? e.code) : 'UNKNOWN';
  if (reason === 'DUPLICATE_PUNCH') {
    const direction = e instanceof ApiError ? e.details?.['direction'] : undefined;
    if (punch && direction === punch.direction) return { kind: 'sent' };
    return { kind: 'retry', error: e instanceof Error ? e.message : String(e) };
  }
  return { kind: 'refused', reason };
}

/**
 * The signed-in user's queued offline punches in the organisation plus the actions on them (review P0-3: nobody else's are
 * shown, sent or discarded here). The queue is replayed automatically when the browser reports it is back online and
 * whenever the check-in page opens; "Sync now" replays on demand. Without a known user (the session is still loading) the
 * queue is left alone.
 */
export function useOfflinePunches(orgId: string) {
  const { t } = useTranslation(PA_NS);
  const qc = useQueryClient();
  const userId = useMe().data?.user.id ?? null;
  const store = punchQueueStore();
  // the list is kept with the session it was read for: another user (or none) never sees it, not even for one render
  const owner = userId ? `${orgId}:${userId}` : null;
  const [queue, setQueue] = useState<{ owner: string | null; items: QueuedPunch[] }>({ owner: null, items: [] });
  const items = owner !== null && queue.owner === owner ? queue.items : [];
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => { setQueue({ owner, items: userId ? await queuedPunches(store, orgId, userId) : [] }); }, [store, orgId, userId, owner]);

  const sync = useCallback(async () => {
    if (inFlight.current || !userId) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      const result = await replayQueue(store, orgId, userId, async (p): Promise<SendOutcome> => {
        try {
          await postPunch(orgId, { direction: p.direction, lat: p.lat, lng: p.lng, accuracy: p.accuracy, clientQueuedAt: p.clientQueuedAt, idempotencyKey: p.key });
          return { kind: 'sent' };
        } catch (e) {
          return sendOutcomeOf(e, p);
        }
      });
      if (result.sent > 0) toast.success(t('checkin.offline.synced', { count: result.sent }));
      for (const r of result.refused) toast.error(t('checkin.offline.refused', { reason: t(`checkin.refusal.${r.reason}`, { defaultValue: r.reason }) }));
      if (result.sent > 0 || result.refused.length > 0) void qc.invalidateQueries({ queryKey: qk.entity(orgId, SELF) });
    } finally {
      inFlight.current = false;
      setSyncing(false);
      await refresh();
    }
  }, [store, orgId, userId, qc, refresh, t]);

  const enqueue = useCallback(async (p: Omit<QueuedPunch, 'orgId' | 'userId' | 'attempts' | 'lastError'>): Promise<boolean> => {
    if (!userId) return false;
    await store.put({ ...p, userId, orgId, attempts: 0, lastError: null });
    await refresh();
    return true;
  }, [store, orgId, userId, refresh]);
  const discard = useCallback(async (key: string) => { if (userId) await discardOwn(store, orgId, userId, key); await refresh(); }, [store, orgId, userId, refresh]);

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    void (async () => {
      // punches saved before the queue recorded its users: nobody's to send (removed once, with a notice)
      const removed = await purgeUnattributed(store);
      if (removed > 0) toast.warning(t('checkin.offline.legacyDiscarded', { count: removed }));
      const queued = await queuedPunches(store, orgId, userId);
      if (!alive) return;
      setQueue({ owner, items: queued });
      if (queued.length > 0 && (typeof navigator === 'undefined' || navigator.onLine !== false)) void sync();
    })();
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => { alive = false; window.removeEventListener('online', online); };
  }, [store, orgId, userId, owner, sync, t]);

  return { items, syncing, sync, enqueue, discard };
}
