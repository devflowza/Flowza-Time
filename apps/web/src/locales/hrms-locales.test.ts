import { describe, expect, it } from 'vitest';
import { API_KEY_SCOPES, EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, GENDERS, HRMS_EMPLOYEE_FIELDS, HRMS_ORG_UNIT_FIELDS, HRMS_PRESETS, IMPORT_KINDS, IMPORT_STATUSES, ROLE_TEMPLATE_KEYS } from '@flowza/contracts';
import en from './en/hrms.json';
import ar from './ar/hrms.json';
import enUsers from './en/users.json';
import arUsers from './ar/users.json';
import enEmployees from './en/employees.json';
import arEmployees from './ar/employees.json';
import enSettings from './en/settings.json';
import arSettings from './ar/settings.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort();

describe('HRMS / import kinds / role templates locale parity (en + ar)', () => {
  const e = flatten(en as Tree);
  const a = flatten(ar as Tree);
  it('the hrms namespace has the same keys and variables in both languages, none empty', () => {
    expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort());
    for (const k of Object.keys(e)) expect([k, vars(a[k] ?? '')]).toEqual([k, vars(e[k]!)]);
    for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]);
  });

  it('labels every field, value, preset, scope and batch status the section shows', () => {
    for (const f of [...HRMS_EMPLOYEE_FIELDS, ...HRMS_ORG_UNIT_FIELDS]) expect([f, !!e[`fields.${f}`], !!a[`fields.${f}`]]).toEqual([f, true, true]);
    for (const v of [...EMPLOYMENT_STATUSES, ...GENDERS, ...EMPLOYMENT_TYPES]) expect([v, !!e[`values.${v}`], !!a[`values.${v}`]]).toEqual([v, true, true]);
    for (const p of HRMS_PRESETS) expect([p, !!e[`presets.${p}`], !!a[`presets.${p}`]]).toEqual([p, true, true]);
    for (const s of API_KEY_SCOPES) expect([s, !!e[`keys.scopeNames.${s.replace(':', '_')}`], !!a[`keys.scopeNames.${s.replace(':', '_')}`]]).toEqual([s, true, true]);
    for (const s of IMPORT_STATUSES) expect([s, !!e[`batches.status.${s}`], !!a[`batches.status.${s}`]]).toEqual([s, true, true]);
  });

  it('names the settings section, the import kinds and the role templates in both languages', () => {
    expect(enSettings.nav.hrms && arSettings.nav.hrms).toBeTruthy();
    for (const k of IMPORT_KINDS) expect([k, !!enEmployees.import.kinds[k], !!arEmployees.import.kinds[k]]).toEqual([k, true, true]);
    for (const k of ROLE_TEMPLATE_KEYS) {
      expect([k, !!enUsers.roles.templates[k].name, !!arUsers.roles.templates[k].name, !!enUsers.roles.templates[k].description, !!arUsers.roles.templates[k].description]).toEqual([k, true, true, true, true]);
    }
    expect(vars(arUsers.roles.templates.skipped)).toEqual(vars(enUsers.roles.templates.skipped));
  });
});
