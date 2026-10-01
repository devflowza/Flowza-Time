import { useEffect } from 'react';
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
/** Polling baseline: the register still refreshes when realtime is off (no service key on the worker) or the socket drops. */
export const LIVE_POLL_MS = 30_000;
/** The relay sends `attendance.created` and `attendance.updated` separately for one run: one refetch for both. */
export const LIVE_SIGNAL_COALESCE_MS = 1_000;

/**
 * Keeps the attendance register current without "Sync punches". A device push is stored at once; the worker normalises it,
 * recomputes the day after the organisation's processing delay and the outbox relay broadcasts `attendance.*` on the private
 * `org:<orgId>:attendance` channel (ids only). A signal refetches the register's active queries through the API; polling
 * every 30 s while the tab is visible — and once when it becomes visible again — is the baseline (AGENTS.md: realtime is
 * an accelerator, never the only path). The subscription is removed on unmount / organisation change.
 */
export function useAttendanceLive(enabled = true): void {
  const orgId = useOrgId();
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !orgId) return;
    const refresh = () => { for (const e of LIVE_ENTITIES) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    let pending: ReturnType<typeof setTimeout> | null = null;
    const signal = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; refresh(); }, LIVE_SIGNAL_COALESCE_MS);
    };

    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      let subscribedOnce = false;
      channel = supabase.channel(`org:${orgId}:attendance`, { config: { private: true } });
      channel
        .on('broadcast', { event: '*' }, (msg: { event?: string }) => { if (typeof msg.event !== 'string' || msg.event.startsWith('attendance.')) signal(); })
        // a re-subscription after a dropped socket may have missed signals: catch up once
        .subscribe((status: string) => { if (status === 'SUBSCRIBED') { if (subscribedOnce) signal(); subscribedOnce = true; } });
    } catch {
      channel = null; // realtime unavailable: polling below still keeps the register current
    }

    const poll = setInterval(() => { if (visible()) refresh(); }, LIVE_POLL_MS);
    const onVisibility = () => { if (visible()) refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(poll);
      if (pending) clearTimeout(pending);
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled, orgId, qc]);
}
