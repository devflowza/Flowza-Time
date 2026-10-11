import { describe, expect, it } from 'vitest';
import { LOCATION_LEVEL_ICONS, LOCATION_LEVEL_ROLES, LOCATION_TEMPLATE_KEYS } from '@flowza/contracts';
import { IN_USE_KINDS } from '@/features/locations/conflicts';
import en from './en/locations.json';
import ar from './ar/locations.json';
import enOrganization from './en/organization.json';
import arOrganization from './ar/organization.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
/** i18next plural suffixes: English uses one / other, Arabic all six CLDR categories. */
const PLURAL = /_(zero|one|two|few|many|other)$/;
const base = (k: string) => k.replace(PLURAL, '');

const e = flatten(en as Tree);
const a = flatten(ar as Tree);

/** Organisation → Locations: every string exists in English and Arabic, plurals in every form the language has. */
describe('locations locale parity', () => {
  it('has the same keys in en and ar (plural forms aside)', () => {
    expect([...new Set(Object.keys(a).map(base))].sort()).toEqual([...new Set(Object.keys(e).map(base))].sort());
  });

  it('gives every plural English one / other and Arabic zero / one / two / few / many / other', () => {
    const plurals = [...new Set(Object.keys(e).filter((k) => PLURAL.test(k)).map(base))];
    expect(plurals.length).toBeGreaterThan(5);
    for (const p of plurals) {
      expect([p, ['one', 'other'].every((f) => `${p}_${f}` in e)]).toEqual([p, true]);
      expect([p, ['zero', 'one', 'two', 'few', 'many', 'other'].every((f) => `${p}_${f}` in a)]).toEqual([p, true]);
    }
  });

  it('keeps the interpolation variables of every string (an Arabic plural may spell the number out)', () => {
    for (const k of Object.keys(a)) {
      const en1 = e[k] ?? e[`${base(k)}_other`]!;
      const expected = vars(en1).filter((v) => !(PLURAL.test(k) && v === 'count'));
      expect([k, vars(a[k]!).filter((v) => !(PLURAL.test(k) && v === 'count'))]).toEqual([k, expected]);
    }
  });

  it('has no empty strings', () => { for (const [k, v] of Object.entries({ ...e, ...a })) expect([k, v.trim().length > 0]).toEqual([k, true]); });

  it('names every template, icon, role and in-use kind the screens display', () => {
    for (const lang of [e, a]) {
      for (const key of LOCATION_TEMPLATE_KEYS) { expect(lang[`templates.${key}.title`], key).toBeTruthy(); expect(lang[`templates.${key}.description`], key).toBeTruthy(); }
      for (const icon of LOCATION_LEVEL_ICONS) expect(lang[`icons.${icon}`], icon).toBeTruthy();
      for (const role of LOCATION_LEVEL_ROLES) { expect(lang[`roles.${role}`], role).toBeTruthy(); expect(lang[`roleNotes.${role}`], role).toBeTruthy(); }
      for (const kind of IN_USE_KINDS) expect(lang[`archive.items.${kind}_other`], kind).toBeTruthy();
    }
  });

  it('labels the Locations tab of the organisation page', () => {
    expect(enOrganization.tabs.locations).toBe('Locations');
    expect(arOrganization.tabs.locations).toBe('المواقع');
  });
});
