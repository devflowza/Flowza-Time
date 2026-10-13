import { describe, expect, it } from 'vitest';
import enEmployees from './en/employees.json';
import arEmployees from './ar/employees.json';
import enCommon from './en/common.json';
import arCommon from './ar/common.json';

type Tree = { [k: string]: string | Tree | unknown[] };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : Array.isArray(v) ? acc : { ...acc, ...flatten(v as Tree, `${prefix}${k}.`) }), {});
const PLURAL = /_(zero|one|two|few|many|other)$/;
/** Arabic carries more plural forms than English: compare the keys with the plural suffix folded away. */
const bases = (flat: Record<string, string>) => [...new Set(Object.keys(flat).map((k) => k.replace(PLURAL, '')))].sort();
const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))].sort();
const ARABIC = /[؀-ۿ]/;

/**
 * The org chart and the "Assign manager" action: every string exists in English and Arabic (in Arabic script, not an English
 * copy), with the same interpolation variables, and every Arabic plural form a count can select.
 */
describe.each([
  ['employees (org chart, assign manager)', enEmployees as Tree, arEmployees as Tree, ['orgChart.', 'assignManager.', 'bulk.assign_manager.', 'profile.viewInOrgChart']],
  ['common (navigation)', enCommon as Tree, arCommon as Tree, ['nav.orgChart']],
] as const)('%s locale parity', (_ns, en, ar, only) => {
  const pick = (flat: Record<string, string>) => Object.fromEntries(Object.entries(flat).filter(([k]) => only.some((p) => k.startsWith(p))));
  const e = pick(flatten(en));
  const a = pick(flatten(ar));
  it('has the same keys in en and ar (plural forms folded)', () => {
    expect(Object.keys(e).length).toBeGreaterThan(0);
    expect(bases(a)).toEqual(bases(e));
  });
  it('keeps the interpolation variables of every non-plural string, and of every plural "other" form', () => {
    for (const [k, v] of Object.entries(e)) {
      if (PLURAL.test(k) && !k.endsWith('_other')) continue;
      expect([k, vars(a[k] ?? '')]).toEqual([k, vars(v)]);
    }
  });
  it('translates every string (Arabic script) and has no empty strings', () => {
    for (const [k, v] of Object.entries(a)) expect([k, ARABIC.test(v)]).toEqual([k, true]);
    for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]);
  });
  it('gives every Arabic plural all six forms', () => {
    const plurals = new Set(Object.keys(a).filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')));
    for (const base of plurals) for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) expect(a).toHaveProperty([`${base}_${form}`]);
  });
});
