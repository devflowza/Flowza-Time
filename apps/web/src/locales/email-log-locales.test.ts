import { describe, expect, it } from 'vitest';
import en from './en/email-log.json';
import ar from './ar/email-log.json';
import enUsers from './en/users.json';
import arUsers from './ar/users.json';
import enCommon from './en/common.json';
import arCommon from './ar/common.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort();
// Arabic has six plural forms, English two: a plural key is compared by its stem, its variables by the `_other` form
const PLURAL = /_(zero|one|two|few|many|other)$/;
const stems = (flat: Record<string, string>) => [...new Set(Object.keys(flat).map((k) => k.replace(PLURAL, '')))].sort();

describe('e-mail log locale parity', () => {
  const e = flatten(en as Tree);
  const a = flatten(ar as Tree);
  it('has the same keys in en and ar', () => { expect(stems(a)).toEqual(stems(e)); });
  it('keeps the interpolation variables of every string', () => {
    for (const k of Object.keys(e).filter((key) => !PLURAL.test(key) || key.endsWith('_other'))) expect([k, vars(a[k] ?? '')]).toEqual([k, vars(e[k]!)]);
  });
  it('has every Arabic plural form of each plural string', () => {
    for (const stem of stems(e).filter((s) => `${s}_other` in e)) for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) expect([stem, form, `${stem}_${form}` in a]).toEqual([stem, form, true]);
  });
  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });
  it('labels the navigation item and the invitation links in both languages', () => {
    expect(enCommon.nav.emailLog && arCommon.nav.emailLog).toBeTruthy();
    for (const k of ['stale', 'openLog', 'log'] as const) expect([k, !!enUsers.delivery[k], !!arUsers.delivery[k]]).toEqual([k, true, true]);
  });
});
