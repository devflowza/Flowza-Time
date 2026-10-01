import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { useOrgId } from '@/features/me/use-me';

/**
 * What a new punch (or its recompute) changes on the attendance register: the lists, totals and the read-only day views.
 * The record-edit preview is left alone — it runs the engine on a proposal the user is typing.
 */
export const LIVE_ENTITIES = [
  'attendance-daily', 'attendance-monthly', 'attendance-calendar', 'attendance-summary', 'attendance-manual', 'attendance-raw', 'attendance-unmatched',
  'attendance-records', 'attendance-events', 'attendance-activity', 'attendance-timeline',
] as const;
/**
 * Polling baseline, also while realtime is connected: a joined channel proves the browser can listen, not that the worker
 * publishes (no service key on the worker, a broadcast the server refused), so a signal only ever makes the refresh sooner.
 */
export const LIVE_POLL_MS = 15_000;
/** The relay sends `attendance.created` and `attendance.updated` separately for one run: one refetch for both. */
export const LIVE_SIGNAL_COALESCE_MS = 500;

/** `live`: the realtime channel is joined (a new punch shows within seconds); `polling`: only the LIVE_POLL_MS refresh runs. */
export type LiveMode = 'live' | 'polling';

/**
 * Keeps the attendance register current without "Sync punches". A device push is stored at once; the worker normalises it,
 * recomputes the day (at once unless it was recalculated within the processing-delay window) and the outbox relay broadcasts
 * `attendance.*` on the private `org:<orgId>:attendance` channel (ids only). A signal refetches the register's active queries
 * through the API. Polling is the baseline (AGENTS.md: realtime is an accelerator, never the only path): every 15 s, never
 * in a hidden tab, and once when the tab becomes visible again.
 * The subscription is removed on unmount / organisation change. Returns the mode for the page's live indicator.
 */
export function useAttendanceLive(enabled = true): LiveMode {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // keyed by organisation so a switch never shows the previous organisation's connection as live
  const [connected, setConnected] = useState<{ orgId: string; live: boolean }>({ orgId, live: false });
  useEffect(() => {
    if (!enabled || !orgId) return;
    let disposed = false;
    const refresh = () => { for (const e of LIVE_ENTITIES) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    let pending: ReturnType<typeof setTimeout> | null = null;
    const signal = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; refresh(); }, LIVE_SIGNAL_COALESCE_MS);
    };
    const setLive = (live: boolean) => { if (!disposed) setConnected({ orgId, live }); };

    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      let subscribedOnce = false;
      channel = supabase.channel(`org:${orgId}:attendance`, { config: { private: true } });
      channel
        .on('broadcast', { event: '*' }, (msg: { event?: string }) => { if (typeof msg.event !== 'string' || msg.event.startsWith('attendance.')) signal(); })
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            setLive(true);
            if (subscribedOnce) signal(); // a re-subscription after a dropped socket may have missed signals: catch up once
            subscribedOnce = true;
          } else {
            setLive(false); // CHANNEL_ERROR / TIMED_OUT / CLOSED: only the poll runs until the socket is back
          }
        });
    } catch {
      channel = null; // realtime unavailable: polling below keeps the register current
    }

    const poll = setInterval(() => { if (visible()) refresh(); }, LIVE_POLL_MS);
    const onVisibility = () => { if (visible()) refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      clearInterval(poll);
      if (pending) clearTimeout(pending);
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled, orgId, qc]);
  return enabled && connected.orgId === orgId && connected.live ? 'live' : 'polling';
}
