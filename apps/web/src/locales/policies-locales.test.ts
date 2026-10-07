import { describe, expect, it } from 'vitest';
import { COMPLIANCE_WARNING_CODES, DISCIPLINE_ACTIONS, ATTENDANCE_POINT_KINDS } from '@flowza/contracts';
import enPolicies from './en/policies.json';
import arPolicies from './ar/policies.json';
import enSchedule from './en/schedule.json';
import arSchedule from './ar/schedule.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Global attendance policies (Enterprise): every string exists in English and Arabic, with the same interpolation variables. */
describe.each([
  ['policies', enPolicies as Tree, arPolicies as Tree],
  ['schedule', enSchedule as unknown as Tree, arSchedule as unknown as Tree],
])('%s locale parity', (_ns, en, ar) => {
  const e = flatten(en);
  const a = flatten(ar);
  it('has the same keys in en and ar', () => { expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort()); });
  it('keeps the interpolation variables of every string', () => { for (const k of Object.keys(e)) expect([k, vars(a[k] ?? '')]).toEqual([k, vars(e[k]!)]); });
  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });
});

describe('every enum the policy screens display has a label', () => {
  const s = flatten(enSchedule as unknown as Tree);
  const p = flatten(enPolicies as Tree);
  it('compliance warnings, discipline actions and point kinds', () => {
    for (const c of COMPLIANCE_WARNING_CODES) expect(s[`policyEditor.compliance.codes.${c}`], c).toBeTruthy();
    for (const a of DISCIPLINE_ACTIONS) { expect(s[`policyEditor.actions.${a}`], a).toBeTruthy(); expect(p[`points.actions.${a}`], a).toBeTruthy(); }
    for (const k of ATTENDANCE_POINT_KINDS) expect(p[`points.kinds.${k}`], k).toBeTruthy();
  });
});
