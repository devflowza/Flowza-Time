import { describe, expect, it } from 'vitest';
import { ATTENDEE_STATUSES, DEVICE_PUNCH_ROLES, TIME_AWAY_KINDS, TIME_AWAY_SOURCES, TIME_AWAY_STATUSES } from '@flowza/contracts';
import enMeetings from './en/meetings.json';
import arMeetings from './ar/meetings.json';
import enTimeAway from './en/time-away.json';
import arTimeAway from './ar/time-away.json';
import enDevices from './en/devices.json';
import arDevices from './ar/devices.json';
import enCommon from './en/common.json';
import arCommon from './ar/common.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Meeting rooms & the time-away report (docs/time-away.md): every string in English and Arabic, with the same variables. */
describe.each([
  ['meetings', enMeetings as Tree, arMeetings as Tree],
  ['time-away', enTimeAway as Tree, arTimeAway as Tree],
  ['devices.punchRole', (enDevices as unknown as { punchRole: Tree }).punchRole, (arDevices as unknown as { punchRole: Tree }).punchRole],
])('%s locale parity', (_ns, en, ar) => {
  const e = flatten(en);
  const a = flatten(ar);
  it('has the same keys in en and ar', () => { expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort()); });
  it('keeps the interpolation variables of every string', () => { for (const k of Object.keys(e)) expect([k, vars(a[k] ?? '')]).toEqual([k, vars(e[k]!)]); });
  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });
});

describe('every enum the screens display has a label', () => {
  const m = flatten(enMeetings as Tree);
  const ta = flatten(enTimeAway as Tree);
  const d = flatten((enDevices as unknown as { punchRole: Tree }).punchRole);
  it('attendee statuses, phases, time-away kinds / statuses / sources, punch roles', () => {
    for (const s of ATTENDEE_STATUSES) expect(m[`attendeeStatus.${s}`], s).toBeTruthy();
    for (const p of ['upcoming', 'in_progress', 'over', 'cancelled']) expect(m[`phase.${p}`], p).toBeTruthy();
    for (const k of TIME_AWAY_KINDS) expect(ta[`kinds.${k}`], k).toBeTruthy();
    for (const s of TIME_AWAY_STATUSES) expect(ta[`statuses.${s}`], s).toBeTruthy();
    for (const s of TIME_AWAY_SOURCES) expect(ta[`sources.${s}`], s).toBeTruthy();
    for (const r of DEVICE_PUNCH_ROLES) for (const g of ['options', 'descriptions', 'badge']) expect(d[`${g}.${r}`], `${g}.${r}`).toBeTruthy();
  });
  it('the meeting_rooms module is named in both languages', () => {
    expect(enCommon.modules.meeting_rooms.name).toBeTruthy();
    expect(arCommon.modules.meeting_rooms.name).toBeTruthy();
  });
});
