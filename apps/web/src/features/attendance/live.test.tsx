import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { realtimeChannels, supabaseMock, testState } from '@/features/employees/test-mocks';
import { LIVE_ENTITIES, LIVE_POLL_MS, LIVE_SIGNAL_COALESCE_MS, useAttendanceLive } from './live';

function setup(enabled = true) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ on }) => useAttendanceLive(on), { wrapper, initialProps: { on: enabled } });
  /** Entities refreshed so far, one entry per invalidateQueries call. */
  const refreshed = () => invalidate.mock.calls.map(([f]) => (f as { queryKey: readonly unknown[] }).queryKey[2]);
  /** Number of full register refreshes so far. */
  const refreshes = () => invalidate.mock.calls.length / LIVE_ENTITIES.length;
  return { hook, invalidate, refreshed, refreshes };
}

describe('useAttendanceLive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testState.orgId = 'org-1';
    realtimeChannels.length = 0;
    supabaseMock.channel.mockClear(); supabaseMock.removeChannel.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('subscribes to the organisation’s private attendance channel and refreshes the register once per burst of signals', () => {
    const { hook, invalidate, refreshed } = setup();
    expect(supabaseMock.channel).toHaveBeenCalledWith('org:org-1:attendance', { config: { private: true } });
    expect(hook.result.current).toBe('live');
    const ch = realtimeChannels[0]!;
    expect(invalidate).not.toHaveBeenCalled(); // the first SUBSCRIBED is not a catch-up

    ch.emit('attendance.created');
    ch.emit('attendance.updated');
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIVE_SIGNAL_COALESCE_MS);
    expect(refreshed()).toEqual([...LIVE_ENTITIES]); // both signals → one refresh of every register entity
    expect(refreshed()).toContain('attendance-daily');
    expect(refreshed()).not.toContain('attendance-preview'); // a proposal the user is typing is never refetched under them
  });

  it('ignores signals that are not attendance changes', () => {
    const { invalidate } = setup();
    realtimeChannels[0]!.emit('approval.decided');
    vi.advanceTimersByTime(LIVE_SIGNAL_COALESCE_MS * 2);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('keeps polling every 15 s while live: a joined channel does not prove the worker publishes', () => {
    const { hook, refreshes } = setup();
    expect(hook.result.current).toBe('live');
    vi.advanceTimersByTime(LIVE_POLL_MS - 1);
    expect(refreshes()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(refreshes()).toBe(1);
    vi.advanceTimersByTime(LIVE_POLL_MS * 2);
    expect(refreshes()).toBe(3);
  });

  it('shows polling while the socket is down, and catches up once when it is back', () => {
    const { hook, refreshes } = setup();
    const ch = realtimeChannels[0]!;
    act(() => ch.status('CHANNEL_ERROR'));
    expect(hook.result.current).toBe('polling');
    vi.advanceTimersByTime(LIVE_POLL_MS);
    expect(refreshes()).toBe(1);
    vi.advanceTimersByTime(LIVE_POLL_MS);
    expect(refreshes()).toBe(2);

    act(() => ch.status('SUBSCRIBED'));
    expect(hook.result.current).toBe('live');
    vi.advanceTimersByTime(LIVE_SIGNAL_COALESCE_MS);
    expect(refreshes()).toBe(3); // signals may have been missed while disconnected
  });

  it('does not poll a hidden tab, and refreshes when it becomes visible again', () => {
    const { refreshes } = setup();
    act(() => realtimeChannels[0]!.status('TIMED_OUT'));
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(LIVE_POLL_MS * 3);
    expect(refreshes()).toBe(0);
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refreshes()).toBe(1);
    state.mockRestore();
  });

  it('removes the channel and stops polling on unmount', () => {
    const { hook, invalidate } = setup();
    const ch = realtimeChannels[0]!;
    hook.unmount();
    expect(supabaseMock.removeChannel).toHaveBeenCalledWith(ch);
    vi.advanceTimersByTime(LIVE_POLL_MS * 3);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const { hook, invalidate } = setup(false);
    expect(supabaseMock.channel).not.toHaveBeenCalled();
    expect(hook.result.current).toBe('polling');
    vi.advanceTimersByTime(LIVE_POLL_MS * 3);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('polls every 15 s when realtime cannot be opened', () => {
    supabaseMock.channel.mockImplementationOnce(() => { throw new Error('realtime unavailable'); });
    const { hook, refreshes } = setup();
    expect(hook.result.current).toBe('polling');
    vi.advanceTimersByTime(LIVE_POLL_MS);
    expect(refreshes()).toBe(1);
  });
});
