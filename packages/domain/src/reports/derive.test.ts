import { describe, expect, it } from 'vitest';
import { deriveHours, pairPunches } from './derive.js';

const base = { status: 'PRESENT', flags: [] as string[], firstInAt: '2017-11-01T03:30:00Z', lastOutAt: '2017-11-01T14:30:00Z', workedMinutes: 600, scheduledMinutes: 540, overtimeMinutes: 60, overtimeCategory: 'REGULAR' as string | null };

describe('deriveHours', () => {
  it('splits a present day into span, worked, base, OT1 and no under time', () => {
    // 07:30 → 18:30 Muscat = 11:00 span; 10.00 worked after a one-hour break; 9.00 base → OT1 1.00
    expect(deriveHours(base)).toEqual({ span: 660, worked: 600, scheduled: 540, ot1: 60, ot2: 0, ut: 0 });
  });
  it('reports under time when the day was short and no overtime', () => {
    expect(deriveHours({ ...base, lastOutAt: '2017-11-01T14:09:00Z', workedMinutes: 408, overtimeMinutes: 0 })).toEqual({ span: 639, worked: 408, scheduled: 540, ot1: 0, ot2: 0, ut: 132 });
  });
  it('puts weekly-off and holiday overtime in OT2', () => {
    expect(deriveHours({ ...base, status: 'WEEKLY_OFF', flags: ['WORKED_ON_WEEKLY_OFF'], scheduledMinutes: 0, workedMinutes: 300, overtimeMinutes: 300, overtimeCategory: 'WEEKLY_OFF' })).toEqual({ span: 660, worked: 300, scheduled: 0, ot1: 0, ot2: 300, ut: 0 });
  });
  it('treats a single punch as a whole base of under time, which is how the Daily sample prints it', () => {
    expect(deriveHours({ ...base, status: 'MISSING_PUNCH', flags: ['MISSING_OUT'], lastOutAt: null, workedMinutes: 0, overtimeMinutes: 0 })).toEqual({ span: null, worked: 0, scheduled: 540, ot1: 0, ot2: 0, ut: 540 });
  });
  it('has nothing to say about an absence, a leave or a plain day off', () => {
    for (const status of ['ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'PENDING']) {
      expect(deriveHours({ ...base, status, firstInAt: null, lastOutAt: null, workedMinutes: 0, overtimeMinutes: 0 })).toEqual({ span: null, worked: null, scheduled: null, ot1: null, ot2: null, ut: null });
    }
  });
});

describe('pairPunches', () => {
  it('pairs IN with the OUT that follows and keeps lone punches as half-pairs', () => {
    const pairs = pairPunches([
      { punchedAt: '2017-11-01T01:32:00Z', role: 'IN' },
      { punchedAt: '2017-11-01T02:00:00Z', role: 'IN' },
      { punchedAt: '2017-11-01T17:16:00Z', role: 'OUT' },
      { punchedAt: '2017-11-01T09:00:00Z', role: 'IGNORED' },
    ]);
    expect(pairs).toEqual([{ inAt: '2017-11-01T01:32:00Z', outAt: null }, { inAt: '2017-11-01T02:00:00Z', outAt: '2017-11-01T17:16:00Z' }]);
  });
  it('yields exactly one pair under FIRST_LAST, where the trace has one IN and one OUT', () => {
    expect(pairPunches([{ punchedAt: '2017-11-01T04:39:00Z', role: 'IN' }, { punchedAt: '2017-11-01T14:41:00Z', role: 'OUT' }, { punchedAt: '2017-11-01T09:00:00Z', role: 'DUPLICATE' }])).toHaveLength(1);
  });
  it('records an OUT without an IN as an OUT-only row', () => {
    expect(pairPunches([{ punchedAt: '2017-11-01T02:42:00Z', role: 'OUT' }])).toEqual([{ inAt: null, outAt: '2017-11-01T02:42:00Z' }]);
  });
});
