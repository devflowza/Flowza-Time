import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { PA_NS } from './attendance-i18n';
import { postPunch } from './attendance-api';
import { SELF } from './api';
import { punchQueueStore, queuedPunches, replayQueue, type QueuedPunch, type SendOutcome } from './offline-queue';

/** A failure that no response answered (offline, DNS, timeout) or a server-side hiccup: keep the punch and retry later. */
export const isRetryable = (e: unknown): boolean => !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

/**
 * How a replayed punch ended (Finance B-30). A failure nobody answered is retried later. DUPLICATE_PUNCH means the server
 * already holds a punch of that direction inside the duplicate window (the first tap went through before the connection
 * dropped, or the employee tapped again): the punch is on record, so it counts as sent. Any other refusal is the server's
 * judgement of this punch (outside the fence, window closed…): it is dropped from the queue and the employee is told.
 */
export function sendOutcomeOf(e: unknown): SendOutcome {
  if (isRetryable(e)) return { kind: 'retry', error: e instanceof Error ? e.message : String(e) };
  const reason = e instanceof ApiError ? String(e.details?.['reason'] ?? e.code) : 'UNKNOWN';
  return reason === 'DUPLICATE_PUNCH' ? { kind: 'sent' } : { kind: 'refused', reason };
}

/**
 * The organisation's queued offline punches plus the actions on them. The queue is replayed automatically when the browser
 * reports it is back online and whenever the check-in page opens; "Sync now" replays on demand.
 */
export function useOfflinePunches(orgId: string) {
  const { t } = useTranslation(PA_NS);
  const qc = useQueryClient();
  const store = punchQueueStore();
  const [items, setItems] = useState<QueuedPunch[]>([]);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => { setItems(await queuedPunches(store, orgId)); }, [store, orgId]);

  const sync = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      const result = await replayQueue(store, orgId, async (p): Promise<SendOutcome> => {
        try {
          await postPunch(orgId, { direction: p.direction, lat: p.lat, lng: p.lng, accuracy: p.accuracy, clientQueuedAt: p.clientQueuedAt, idempotencyKey: p.key });
          return { kind: 'sent' };
        } catch (e) {
          return sendOutcomeOf(e);
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
  }, [store, orgId, qc, refresh, t]);

  const enqueue = useCallback(async (p: Omit<QueuedPunch, 'orgId' | 'attempts' | 'lastError'>) => {
    await store.put({ ...p, orgId, attempts: 0, lastError: null });
    await refresh();
  }, [store, orgId, refresh]);
  const discard = useCallback(async (key: string) => { await store.remove(key); await refresh(); }, [store, refresh]);

  useEffect(() => {
    void (async () => {
      const queued = await queuedPunches(store, orgId);
      setItems(queued);
      if (queued.length > 0 && (typeof navigator === 'undefined' || navigator.onLine !== false)) void sync();
    })();
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [store, orgId, sync]);

  return { items, syncing, sync, enqueue, discard };
}
