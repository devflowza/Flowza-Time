import { describe, expect, it } from 'vitest';
import enTeam from './en/team.json';
import arTeam from './ar/team.json';
import enAdmin from './en/attendance-admin.json';
import arAdmin from './ar/attendance-admin.json';
import enInvitation from './en/invitation.json';
import arInvitation from './ar/invitation.json';
import enDashboard from './en/dashboard.json';
import arDashboard from './ar/dashboard.json';
import enUsers from './en/users.json';
import arUsers from './ar/users.json';

type Tree = { [k: string]: string | Tree | unknown[] };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : Array.isArray(v) ? acc : { ...acc, ...flatten(v as Tree, `${prefix}${k}.`) }), {});
const PLURAL = /_(zero|one|two|few|many|other)$/;
/** Arabic carries more plural forms than English: compare the keys with the plural suffix folded away. */
const bases = (flat: Record<string, string>) => [...new Set(Object.keys(flat).map((k) => k.replace(PLURAL, '')))].sort();
const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))].sort();

/**
 * HR portal Prompt 5 / 6b: every string of the team workspace, the HR attendance admin pages, the invitation preview and the
 * strings added to the dashboard and users namespaces exists in English and Arabic, with the same interpolation variables.
 */
describe.each([
  ['team', enTeam as Tree, arTeam as Tree, null],
  ['attendance-admin', enAdmin as Tree, arAdmin as Tree, null],
  ['invitation', enInvitation as Tree, arInvitation as Tree, null],
  ['dashboard (team widgets)', enDashboard as Tree, arDashboard as Tree, ['awaiting.', 'team.']],
  ['users (resend, access)', enUsers as Tree, arUsers as Tree, ['resend.', 'access.']],
] as const)('%s locale parity', (_ns, en, ar, only) => {
  const pick = (flat: Record<string, string>) => (only ? Object.fromEntries(Object.entries(flat).filter(([k]) => only.some((p) => k.startsWith(p)))) : flat);
  const e = pick(flatten(en));
  const a = pick(flatten(ar));
  it('has the same keys in en and ar (plural forms folded)', () => { expect(bases(a)).toEqual(bases(e)); });
  it('keeps the interpolation variables of every non-plural string, and of every plural "other" form', () => {
    for (const [k, v] of Object.entries(e)) {
      if (PLURAL.test(k) && !k.endsWith('_other')) continue;
      expect([k, vars(a[k] ?? '')]).toEqual([k, vars(v)]);
    }
  });
  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });
});
