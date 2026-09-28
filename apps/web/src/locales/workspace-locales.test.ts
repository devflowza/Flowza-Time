import { describe, expect, it } from 'vitest';
import enWorkspace from './en/attendance-workspace.json';
import arWorkspace from './ar/attendance-workspace.json';
import enSchedules from './en/report-schedules.json';
import arSchedules from './ar/report-schedules.json';
import enCommon from './en/common.json';
import arCommon from './ar/common.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** HR portal Prompt 6a: every string of the new namespaces exists in English and Arabic, with the same interpolation variables. */
describe.each([
  ['attendanceWorkspace', enWorkspace as Tree, arWorkspace as Tree],
  ['reportSchedules', enSchedules as Tree, arSchedules as Tree],
])('%s locale parity', (_ns, en, ar) => {
  const e = flatten(en);
  const a = flatten(ar);
  it('has the same keys in en and ar', () => { expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort()); });
  it('keeps the interpolation variables of every string', () => { for (const k of Object.keys(e)) expect([k, vars(a[k] ?? '')]).toEqual([k, vars(e[k]!)]); });
  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });
});

describe('navigation labels of the workspace pages', () => {
  it('exist in both languages', () => {
    for (const k of ['attendanceSummary', 'unmatchedPunches'] as const) {
      expect(enCommon.nav[k]).toBeTruthy();
      expect(arCommon.nav[k]).toBeTruthy();
    }
  });
});
