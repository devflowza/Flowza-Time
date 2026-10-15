import { describe, expect, it } from 'vitest';
import { APPROVAL_ENTITIES, ATTENDANCE_FLAGS, AWAY_INTERVAL_KINDS, TIME_AWAY_KINDS, TIME_AWAY_SOURCES, TIME_AWAY_STATUSES } from '@flowza/contracts';
import enPortal from './en/portal-attendance.json';
import arPortal from './ar/portal-attendance.json';
import enEmployees from './en/employees.json';
import arEmployees from './ar/employees.json';
import enApprovals from './en/approvals.json';
import arApprovals from './ar/approvals.json';
import enSchedule from './en/schedule.json';
import arSchedule from './ar/schedule.json';
import enSettings from './en/settings.json';
import arSettings from './ar/settings.json';
import enTeam from './en/team.json';
import arTeam from './ar/team.json';
import enAttendance from './en/attendance.json';
import arAttendance from './ar/attendance.json';

type Tree = { [k: string]: string | Tree | unknown[] };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : Array.isArray(v) ? acc : { ...acc, ...flatten(v as Tree, `${prefix}${k}.`) }), {});
const PLURAL = /_(zero|one|two|few|many|other)$/;
const bases = (flat: Record<string, string>) => [...new Set(Object.keys(flat).map((k) => k.replace(PLURAL, '')))].sort();
const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))].sort();

/**
 * Time away inside the working day (docs/time-away.md): every string the portal, the activity view, the approvals, the policy
 * editor, the settings and the team workspace added exists in English and Arabic, with the same interpolation variables.
 */
describe.each([
  ['portal-attendance', enPortal as Tree, arPortal as Tree, ['timeAway.', 'checkin.direction.', 'requests.tabs.']],
  ['employees (activity)', enEmployees as Tree, arEmployees as Tree, ['activity.away.', 'activity.legend.', 'activity.chart.']],
  ['approvals', enApprovals as Tree, arApprovals as Tree, ['context.timeAway.', 'entity.']],
  ['schedule (policy editor)', enSchedule as Tree, arSchedule as Tree, ['policyEditor.timeAway.', 'policyEditor.returnBy.', 'policyEditor.fields.', 'policyEditor.hints.', 'policyEditor.sections.', 'policyEditor.tabs.']],
  ['settings (team scope)', enSettings as Tree, arSettings as Tree, ['attendance.team.']],
  ['team (relations)', enTeam as Tree, arTeam as Tree, ['relation.']],
  ['attendance (flags)', enAttendance as Tree, arAttendance as Tree, ['flags.']],
] as const)('%s locale parity', (_ns, en, ar, only) => {
  const pick = (flat: Record<string, string>) => Object.fromEntries(Object.entries(flat).filter(([k]) => only.some((p) => k.startsWith(p))));
  const e = pick(flatten(en));
  const a = pick(flatten(ar));
  it('has the same keys in en and ar (plural forms folded)', () => { expect(bases(a)).toEqual(bases(e)); });
  it('keeps the interpolation variables', () => {
    for (const [k, v] of Object.entries(e)) {
      if (PLURAL.test(k) && !k.endsWith('_other')) continue;
      expect([k, vars(a[k] ?? '')]).toEqual([k, vars(v)]);
    }
  });
  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });
});

describe('time away labels cover the contract enums', () => {
  it('names every attendance flag, approval entity, time-away kind, source, status and interval kind', () => {
    for (const [en, ar] of [[enAttendance, arAttendance], [enApprovals, arApprovals]] as const) {
      const fe = flatten(en as Tree); const fa = flatten(ar as Tree);
      if ('flags' in en) for (const f of ATTENDANCE_FLAGS) expect([f, !!fe[`flags.${f}`], !!fa[`flags.${f}`]]).toEqual([f, true, true]);
      else for (const x of APPROVAL_ENTITIES) expect([x, !!fe[`entity.${x}`], !!fa[`entity.${x}`]]).toEqual([x, true, true]);
    }
    const pe = flatten(enPortal as Tree);
    for (const k of TIME_AWAY_KINDS) expect(pe[`timeAway.kinds.${k}`]).toBeTruthy();
    for (const k of TIME_AWAY_SOURCES) expect(pe[`timeAway.source.${k}`]).toBeTruthy();
    for (const k of TIME_AWAY_STATUSES) expect(pe[`timeAway.status.${k}`]).toBeTruthy();
    for (const k of AWAY_INTERVAL_KINDS) {
      expect(pe[`timeAway.intervalKinds.${k}`]).toBeTruthy();
      expect(flatten(enEmployees as Tree)[`activity.away.kinds.${k}`]).toBeTruthy();
    }
  });
});
