import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HRMS_SETTINGS, HRMS_PRESETS, HRMS_PRESET_DEFINITIONS, apiKeyCreateSchema, effectiveHrmsMapping, hrmsBatchSchema, hrmsIntegrationInputSchema, hrmsIntegrationSettingsSchema,
  hrmsPresetPairs, orgUnitImportRowSchema, resolveHrmsSettings,
} from './hrms.js';
import { employeeImportUpdateRowSchema } from './employees.js';
import { organizationSettingsSchema } from './organizations.js';

describe('HRMS settings', () => {
  it('lives in the integrations group with defaults, and the group keeps its other keys out of the way', () => {
    expect(organizationSettingsSchema.shape.integrations.parse({})).toEqual({ hrms: DEFAULT_HRMS_SETTINGS });
    expect(DEFAULT_HRMS_SETTINGS).toMatchObject({ enabled: false, preset: 'generic', employeeMapping: [], defaultBranchCode: null });
  });

  it('PUT input: {} is refused (enabled and preset are required), a full body passes', () => {
    expect(hrmsIntegrationInputSchema.safeParse({}).success).toBe(false);
    expect(hrmsIntegrationInputSchema.parse({ enabled: true, preset: 'mawred_plus' })).toMatchObject({ enabled: true, preset: 'mawred_plus', employeeMapping: [] });
  });

  it('every preset is a valid mapping; the Mawred Plus preset covers the typical fields of an Omani HR record', () => {
    for (const p of HRMS_PRESETS) expect(hrmsIntegrationSettingsSchema.safeParse({ preset: p, ...hrmsPresetPairs(p) }).success).toBe(true);
    const targets = Object.values(HRMS_PRESET_DEFINITIONS.mawred_plus.employeeMapping);
    for (const f of ['civilId', 'employeeNumber', 'displayNameAr', 'firstName', 'lastName', 'departmentCode', 'designationCode', 'joiningDate', 'employmentStatus']) expect(targets).toContain(f);
    expect(Object.values(HRMS_PRESET_DEFINITIONS.mawred_plus.orgUnitMapping)).toEqual(expect.arrayContaining(['code', 'name', 'nameAr', 'parentCode']));
  });

  it('a stored list wins over the preset; an empty list falls back to it', () => {
    const s = resolveHrmsSettings({ preset: 'mawred_plus', employeeMapping: [{ source: 'emp_no', target: 'employeeNumber' }] });
    const m = effectiveHrmsMapping(s);
    expect(m.employeeMapping).toEqual({ emp_no: 'employeeNumber' });
    expect(m.orgUnitMapping).toEqual(HRMS_PRESET_DEFINITIONS.mawred_plus.orgUnitMapping);
    expect(m.statusMapping['مستقيل']).toBe('resigned');
  });

  it('refuses an unknown FlowZa field, a source named twice and a malformed stored value (resolved to the defaults)', () => {
    expect(hrmsIntegrationSettingsSchema.safeParse({ employeeMapping: [{ source: 'x', target: 'salary' }] }).success).toBe(false);
    expect(hrmsIntegrationSettingsSchema.safeParse({ employeeMapping: [{ source: 'Emp', target: 'firstName' }, { source: 'emp', target: 'lastName' }] }).success).toBe(false);
    expect(resolveHrmsSettings({ preset: 'unknown' })).toEqual(DEFAULT_HRMS_SETTINGS);
  });
});

describe('HRMS batches, API keys, import rows', () => {
  it('bounds a batch: 1–500 records, at most 80 scalar fields each', () => {
    expect(hrmsBatchSchema.safeParse({ records: [] }).success).toBe(false);
    expect(hrmsBatchSchema.safeParse({ records: Array.from({ length: 501 }, () => ({ a: 1 })) }).success).toBe(false);
    expect(hrmsBatchSchema.safeParse({ records: [{ a: { nested: true } }] }).success).toBe(false);
    expect(hrmsBatchSchema.safeParse({ records: [Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`f${i}`, 1]))] }).success).toBe(false);
    expect(hrmsBatchSchema.parse({ records: [{ EmployeeNo: 'E-1', Active: true, Grade: 7, Note: null }] }).records).toHaveLength(1);
  });

  it('API keys: known scopes, 1–730 days, 365 by default', () => {
    expect(apiKeyCreateSchema.parse({ name: 'Feed', scopes: ['hrms:write'] }).expiresInDays).toBe(365);
    expect(apiKeyCreateSchema.safeParse({ name: 'Feed', scopes: ['admin'] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ name: 'Feed', scopes: ['hrms:read'], expiresInDays: 731 }).success).toBe(false);
  });

  it('an update row carries what it names, no creation default (Zod .partial() pitfall)', () => {
    expect(employeeImportUpdateRowSchema.parse({ employeeNumber: 'E-1', employmentStatus: 'terminated' })).toEqual({ employeeNumber: 'E-1', employmentStatus: 'terminated' });
    expect(employeeImportUpdateRowSchema.parse({ employeeNumber: 'E-1' })).toEqual({ employeeNumber: 'E-1' });
  });

  it('org-unit rows: code and name required, archived status not importable', () => {
    expect(orgUnitImportRowSchema.safeParse({ code: 'HR' }).success).toBe(false);
    expect(orgUnitImportRowSchema.safeParse({ code: 'HR', name: 'HR', status: 'archived' }).success).toBe(false);
    expect(orgUnitImportRowSchema.parse({ code: 'HR', name: 'Human Resources', nameAr: 'الموارد البشرية', parentCode: 'ADM' })).toMatchObject({ code: 'HR', parentCode: 'ADM' });
  });
});
