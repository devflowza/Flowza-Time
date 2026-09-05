import { beforeEach, describe, expect, it } from 'vitest';
import { attributeEvents, sortEvents } from './attribute.js';
import { computePunchWindow } from './window.js';
import { DATE, MUSCAT, event, fixedShift, flexibleShift, nightShift, punch, resetIds } from './testing.js';

const D1 = '2026-03-11';
const D2 = '2026-03-12';

describe('attributeEvents', () => {
  beforeEach(resetIds);

  it('attributes 21:57 (D) and 06:08 (D+1) of a 22:00–06:00 shift to D', () => {
    const shift = nightShift();
    const windows = [DATE, D1].map((d) => computePunchWindow(shift, d, MUSCAT));
    const inD = punch(DATE, '21:57');
    const outD1 = punch(D1, '06:08');
    const { byDate, decisions } = attributeEvents([outD1, inD], windows);
    expect(byDate.get(DATE)?.map((e) => e.id)).toEqual([inD.id, outD1.id]);
    expect(byDate.get(D1)).toEqual([]);
    expect(decisions.every((d) => d.reason === 'SINGLE_WINDOW')).toBe(true);
  });

  it('keeps two consecutive cross-midnight nights apart', () => {
    const shift = nightShift();
    const windows = [DATE, D1, D2].map((d) => computePunchWindow(shift, d, MUSCAT));
    const n1 = [punch(DATE, '21:57'), punch(D1, '06:08')];
    const n2 = [punch(D1, '21:50'), punch(D2, '06:02')];
    const { byDate } = attributeEvents([...n2, ...n1], windows);
    expect(byDate.get(DATE)?.map((e) => e.id)).toEqual(n1.map((e) => e.id));
    expect(byDate.get(D1)?.map((e) => e.id)).toEqual(n2.map((e) => e.id));
    expect(byDate.get(D2)).toEqual([]);
  });

  it('resolves overlapping windows by the nearest scheduled start and records it', () => {
    // 12h margins make the night windows overlap between 10:00 and 18:00 on D+1.
    const shift = nightShift({ punchInWindowBeforeMinutes: 720, punchOutWindowAfterMinutes: 720 });
    const windows = [DATE, D1].map((d) => computePunchWindow(shift, d, MUSCAT));
    const lateOut = punch(D1, '11:00'); // 13h after 22:00 D, 11h before 22:00 D+1 → D+1
    const morningOut = punch(D1, '06:08'); // 8h08 after 22:00 D → D
    const { byDate, decisions } = attributeEvents([lateOut, morningOut], windows);
    expect(byDate.get(DATE)?.map((e) => e.id)).toEqual([morningOut.id]);
    expect(byDate.get(D1)?.map((e) => e.id)).toEqual([lateOut.id]);
    const decision = decisions.find((d) => d.eventId === lateOut.id);
    expect(decision?.reason).toBe('NEAREST_SCHEDULED_START');
    expect(decision?.candidates).toEqual([DATE, D1]);
    expect(decision?.distanceMinutes).toBe(11 * 60);
  });

  it('breaks exact ties towards the earlier date', () => {
    const shift = fixedShift({ startTime: '09:00', endTime: '17:00', punchInWindowBeforeMinutes: 720, punchOutWindowAfterMinutes: 720 });
    const windows = [DATE, D1].map((d) => computePunchWindow(shift, d, MUSCAT));
    const midpoint = punch(DATE, '21:00'); // 12h after 09:00 D and 12h before 09:00 D+1
    const { byDate } = attributeEvents([midpoint], windows);
    expect(byDate.get(DATE)?.map((e) => e.id)).toEqual([midpoint.id]);
  });

  it('assigns a 02:00 punch to the previous flexible day (04:00 boundary)', () => {
    const shift = flexibleShift();
    const windows = [DATE, D1].map((d) => computePunchWindow(shift, d, MUSCAT));
    const earlyMorning = punch(D1, '02:00');
    const afterBoundary = punch(D1, '04:00');
    const { byDate } = attributeEvents([earlyMorning, afterBoundary], windows);
    expect(byDate.get(DATE)?.map((e) => e.id)).toEqual([earlyMorning.id]);
    expect(byDate.get(D1)?.map((e) => e.id)).toEqual([afterBoundary.id]);
  });

  it('reports voided and out-of-window events without attributing them', () => {
    const windows = [computePunchWindow(fixedShift(), DATE, MUSCAT)];
    const voided = punch(DATE, '09:00', 'PUNCH', MUSCAT, { voided: true });
    const outside = punch(DATE, '03:00');
    const { byDate, decisions } = attributeEvents([voided, outside], windows);
    expect(byDate.get(DATE)).toEqual([]);
    expect(decisions.map((d) => d.reason)).toEqual(['OUT_OF_WINDOW', 'VOIDED']);
  });

  it('orders events by punchedAt then id for stable output', () => {
    const a = event('2026-03-10T05:00:00Z', { id: 'b' });
    const b = event('2026-03-10T05:00:00Z', { id: 'a' });
    const c = event('2026-03-10T04:00:00Z', { id: 'z' });
    expect(sortEvents([a, b, c]).map((e) => e.id)).toEqual(['z', 'a', 'b']);
  });
});
