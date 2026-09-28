import { describe, expect, it } from 'vitest';
import type { AttendanceNoteDto } from '@flowza/contracts';
import { createMemoryStore, queuedPunches, replayQueue, type QueuedPunch } from './offline-queue';
import { distanceMeters, fmtDistance, nearestFence } from './geo';
import { activeNotesByDate, needsReason, suggestedCategory } from './notes-model';
import { swappableDays } from './shift-format';

const punch = (key: string, at: string, orgId = 'org-1'): QueuedPunch => ({ key, orgId, direction: 'in', clientQueuedAt: at, attempts: 0, lastError: null });

describe('offline punch queue', () => {
  it('replays in the order the punches were taken and keeps only the other organisation\'s', async () => {
    const store = createMemoryStore();
    await store.put(punch('b', '2026-09-27T05:00:00Z'));
    await store.put(punch('a', '2026-09-27T04:00:00Z'));
    await store.put(punch('x', '2026-09-27T03:00:00Z', 'org-2'));
    const sent: string[] = [];
    const res = await replayQueue(store, 'org-1', async (p) => { sent.push(p.key); return { kind: 'sent' }; });
    expect(sent).toEqual(['a', 'b']);
    expect(res).toMatchObject({ sent: 2, remaining: 0, stoppedEarly: false, refused: [] });
    expect((await store.all()).map((p) => p.key)).toEqual(['x']);
  });

  it('drops a refused punch (the server judged it) but stops at the first retryable failure', async () => {
    const store = createMemoryStore();
    for (const [k, at] of [['a', '04'], ['b', '05'], ['c', '06']] as const) await store.put(punch(k, `2026-09-27T${at}:00:00Z`));
    const res = await replayQueue(store, 'org-1', async (p) => (p.key === 'a' ? { kind: 'refused', reason: 'DUPLICATE_PUNCH' } : { kind: 'retry', error: 'offline' }));
    expect(res.refused.map((r) => [r.punch.key, r.reason])).toEqual([['a', 'DUPLICATE_PUNCH']]);
    expect(res.stoppedEarly).toBe(true);
    const left = await queuedPunches(store, 'org-1');
    expect(left.map((p) => p.key)).toEqual(['b', 'c']);
    expect(left[0]).toMatchObject({ attempts: 1, lastError: 'offline' });
  });
});

describe('geo helpers', () => {
  it('measures great-circle distances and finds the nearest fence edge', () => {
    expect(Math.round(distanceMeters({ lat: 23.588, lng: 58.3829 }, { lat: 23.588, lng: 58.3929 }))).toBe(1019);
    const fences = [
      { id: 'a', name: 'HQ', latitude: 23.588, longitude: 58.3829, radiusM: 150, hasPolygon: false, enforcement: 'soft_warn' as const, scope: 'org' as const },
      { id: 'b', name: 'Yard', latitude: 23.6, longitude: 58.4, radiusM: 100, hasPolygon: false, enforcement: 'soft_warn' as const, scope: 'org' as const },
    ];
    expect(nearestFence({ lat: 23.5881, lng: 58.383 }, fences)).toMatchObject({ fence: { id: 'a' }, edgeDistanceM: 0 });
    expect(nearestFence({ lat: 23.6, lng: 58.4015 }, fences)?.fence.id).toBe('b');
    expect(nearestFence({ lat: 0, lng: 0 }, [])).toBeNull();
    expect(fmtDistance(85.4)).toBe('85 m');
    expect(fmtDistance(1234)).toBe('1.2 km');
    expect(fmtDistance(null)).toBe('—');
  });
});

describe('reasons model', () => {
  const n = (over: Partial<AttendanceNoteDto>): AttendanceNoteDto => ({ id: 'n', employeeId: 'e', attendanceDate: '2026-09-20', category: 'other', note: 'x', status: 'pending', submittedAt: '2026-09-20T05:00:00Z', reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, reviewVia: null, infoRequestMessage: null, infoRequestedAt: null, payEffectDays: null, lossOfPay: false, deductedLeaveTypeCode: null, deductedLeaveTypeName: null, approvalRequestId: null, approvalStatus: null, approvalCurrentStep: null, approvalStepCount: null, excusedAt: null, createdAt: '2026-09-20T05:00:00Z', updatedAt: '2026-09-20T05:00:00Z', ...over });

  it('the active note speaks for the day; a rejected one only when nothing newer is active', () => {
    const map = activeNotesByDate([n({ id: 'old', status: 'rejected', submittedAt: '2026-09-20T05:00:00Z' }), n({ id: 'new', status: 'pending', submittedAt: '2026-09-21T05:00:00Z' }), n({ id: 'r', attendanceDate: '2026-09-19', status: 'rejected' })]);
    expect(map.get('2026-09-20')?.id).toBe('new');
    expect(map.get('2026-09-19')?.id).toBe('r');
  });

  it('asks for a reason on absent / late / missing-punch days and suggests the category', () => {
    expect(needsReason('ABSENT', [])).toBe(true);
    expect(needsReason('PRESENT', ['LATE'])).toBe(true);
    expect(needsReason('PRESENT', ['OVERTIME'])).toBe(false);
    expect(suggestedCategory('PRESENT', ['LATE'])).toBe('late_reason');
    expect(suggestedCategory('ABSENT')).toBe('absence_reason');
    expect(suggestedCategory('PRESENT')).toBe('other');
  });

  it('offers only working days without leave, holiday or a swap for a swap', () => {
    const shift = { id: 's', code: 'D', name: 'Day', type: 'FIXED' as const, startTime: '08:00', endTime: '17:00', requiredMinutes: 480, graceInMinutes: 10, crossesMidnight: false, color: null, breakMinutes: 60 };
    const day = (date: string, over = {}) => ({ date, shift, source: 'ASSIGNMENT' as const, isOff: false, holidayName: null, onLeave: false, swap: null, ...over });
    expect(swappableDays([day('2026-10-01'), day('2026-10-02', { isOff: true }), day('2026-10-03', { onLeave: true }), day('2026-10-04', { holidayName: 'X' }), day('2026-10-05', { swap: { id: 'w', status: 'pending', withEmployeeName: null } }), day('2026-10-06', { shift: null })]).map((d) => d.date)).toEqual(['2026-10-01']);
  });
});
