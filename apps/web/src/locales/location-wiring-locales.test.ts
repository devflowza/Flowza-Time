import { describe, expect, it } from 'vitest';
import enDevices from './en/devices.json';
import arDevices from './ar/devices.json';
import enEmployees from './en/employees.json';
import arEmployees from './ar/employees.json';
import enReview from './en/attendance-review.json';
import arReview from './ar/attendance-review.json';
import enUsers from './en/users.json';
import arUsers from './ar/users.json';
import enDashboard from './en/dashboard.json';
import arDashboard from './ar/dashboard.json';
import enReports from './en/reports.json';
import arReports from './ar/reports.json';

/** A locale file (nested strings, and the odd array such as the dashboard's quotes). */
type Json = { [k: string]: unknown };
const get = (t: Json, path: string): string | undefined => {
  const v = path.split('.').reduce<unknown>((node, k) => (node && typeof node === 'object' ? (node as Json)[k] : undefined), t);
  return typeof v === 'string' ? v : undefined;
};
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
const ARABIC = /[؀-ۿ]/;

/** The location strings of the devices, employees, geofences, members, dashboard and reports screens (docs/locations.md §2). */
const KEYS: Array<[string, Json, Json, string[]]> = [
  ['devices', enDevices, arDevices, ['list.locationFilter', 'columns.location', 'fields.location', 'fields.locationHint']],
  ['employees', enEmployees, arEmployees, ['list.location', 'list.locationFilter', 'fields.workLocation', 'fields.workLocationHint']],
  ['attendance-review', enReview, arReview, ['geofences.filterLocation', 'geofences.allLocations', 'geofences.columns.location', 'geofences.fields.location', 'geofences.fields.locationHint', 'geofences.fields.locationNeedsSite']],
  ['users', enUsers, arUsers, ['fields.byLocation', 'fields.byLocationPlaceholder', 'fields.byLocationIdle', 'fields.byLocationNote']],
  ['dashboard', enDashboard, arDashboard, ['location.all', 'location.filter']],
  ['reports', enReports, arReports, ['request.location', 'request.allLocations', 'request.locationHint', 'list.oneLocation']],
];

describe.each(KEYS)('%s location strings', (_ns, en, ar, keys) => {
  it('exist in English and Arabic with the same interpolation variables', () => {
    for (const key of keys) {
      const e = get(en, key);
      const a = get(ar, key);
      expect([key, !!e?.trim()]).toEqual([key, true]);
      expect([key, !!a?.trim() && ARABIC.test(a)]).toEqual([key, true]);
      expect([key, vars(a!)]).toEqual([key, vars(e!)]);
    }
  });
});

describe('users "add branches by location" plurals', () => {
  it('has the English and the six Arabic plural forms, every one naming the location where it is announced', () => {
    for (const base of ['fields.byLocationAdd', 'fields.byLocationAdded']) {
      for (const form of ['one', 'other']) expect([base, form, !!get(enUsers, `${base}_${form}`)]).toEqual([base, form, true]);
      for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) expect([base, form, ARABIC.test(get(arUsers, `${base}_${form}`) ?? '')]).toEqual([base, form, true]);
    }
    for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) expect(vars(get(arUsers, `fields.byLocationAdded_${form}`)!)).toContain('name');
    for (const form of ['one', 'other']) expect(vars(get(enUsers, `fields.byLocationAdded_${form}`)!)).toEqual(['count', 'name']);
  });
});
