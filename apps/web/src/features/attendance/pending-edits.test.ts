import { afterEach, describe, expect, it, vi } from 'vitest';
import { PENDING_EDIT_TIMEOUT_MS, awaitsRecalculation, pendingEditKey, usePendingEdits } from './pending-edits';

const FILED = '2026-09-17T08:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
  usePendingEdits.setState({ edits: {} });
});

describe('pending record edits (field report 2026-10-02: the register showed the old outcome until the recalculation finished)', () => {
  it('a day waits until its record was computed after the edit was filed', () => {
    usePendingEdits.getState().mark('e1', '2026-09-17', FILED);
    const edit = usePendingEdits.getState().edits[pendingEditKey('e1', '2026-09-17')];
    expect(edit?.filedAt).toBe(Date.parse(FILED));
    expect(awaitsRecalculation(edit, null)).toBe(true);
    expect(awaitsRecalculation(edit, '2026-09-17T07:59:59.000Z')).toBe(true);
    expect(awaitsRecalculation(edit, '2026-09-17T08:00:01.000Z')).toBe(false);
    expect(awaitsRecalculation(undefined, null)).toBe(false);
  });

  it('settles only the keys it is given', () => {
    const { mark } = usePendingEdits.getState();
    mark('e1', '2026-09-17', FILED);
    mark('e2', '2026-09-17', FILED);
    usePendingEdits.getState().settle([pendingEditKey('e1', '2026-09-17')]);
    expect(Object.keys(usePendingEdits.getState().edits)).toEqual([pendingEditKey('e2', '2026-09-17')]);
  });

  it('gives up after the timeout, but a newer edit of the same day keeps its own clock', () => {
    vi.useFakeTimers();
    const { mark } = usePendingEdits.getState();
    mark('e1', '2026-09-17', FILED);
    vi.advanceTimersByTime(PENDING_EDIT_TIMEOUT_MS / 2);
    mark('e1', '2026-09-17', '2026-09-17T08:00:30.000Z');
    vi.advanceTimersByTime(PENDING_EDIT_TIMEOUT_MS / 2);
    expect(usePendingEdits.getState().edits[pendingEditKey('e1', '2026-09-17')]?.filedAt).toBe(Date.parse('2026-09-17T08:00:30.000Z'));
    vi.advanceTimersByTime(PENDING_EDIT_TIMEOUT_MS / 2);
    expect(usePendingEdits.getState().edits).toEqual({});
  });
});
