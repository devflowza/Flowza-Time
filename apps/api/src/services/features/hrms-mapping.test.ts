import { describe, expect, it } from 'vitest';
import { effectiveHrmsMapping, resolveHrmsSettings } from '@flowza/contracts';
import { mapHrmsRecord } from './hrms-mapping.js';
import { excelSerialToIsoDate } from '../../lib/xlsx.js';
import { normaliseValues } from '../imports.service.js';

describe('mapHrmsRecord', () => {
  const mawred = effectiveHrmsMapping(resolveHrmsSettings({ preset: 'mawred_plus' }));
  const generic = effectiveHrmsMapping(resolveHrmsSettings({ preset: 'generic' }));

  it('translates an HR record with the preset: field names case-insensitively, Arabic / English labels, numbers as text', () => {
    const out = mapHrmsRecord('EMPLOYEES', { civilid: 12345678, EmployeeNo: 'M-1', FullNameAr: 'فاطمة', EmploymentStatus: 'مستقيل', Gender: 'F', ContractType: 'Permanent', Salary: 900, Blank: '  ', Missing: null }, mawred);
    expect(out.object).toEqual({ civilId: '12345678', employeeNumber: 'M-1', displayNameAr: 'فاطمة', employmentStatus: 'resigned', gender: 'female', employmentType: 'full_time' });
    expect(out.ignored).toEqual(['Salary', 'Blank', 'Missing']);
  });

  it('generic: FlowZa field names are taken as they are; org units use their own mapping', () => {
    expect(mapHrmsRecord('EMPLOYEES', { employeeNumber: 'E-1', EMPLOYMENTSTATUS: 'terminated', organizationId: 'x' }, generic)).toEqual({ object: { employeeNumber: 'E-1', employmentStatus: 'terminated' }, ignored: ['organizationId'] });
    expect(mapHrmsRecord('ORG_UNITS', { UnitCode: 'HR', UnitNameEn: 'HR', ParentUnitCode: 'ADM', EmployeeNo: 'x' }, mawred).object).toEqual({ code: 'HR', name: 'HR', parentCode: 'ADM' });
  });

  it('dates are normalised (DD/MM/YYYY, ISO date-times, Excel serials from a workbook) and enum labels folded', () => {
    expect(normaliseValues({ joiningDate: '5/1/2026', exitDate: '2026-02-03T00:00:00', employmentType: 'Part Time' })).toEqual({ joiningDate: '2026-01-05', exitDate: '2026-02-03', employmentType: 'part_time' });
    expect(normaliseValues({ joiningDate: '46023' }, { excelSerials: true }).joiningDate).toBe('2026-01-01');
    expect(normaliseValues({ joiningDate: '46023' }).joiningDate).toBe('46023'); // a CSV number is not a date
    expect(excelSerialToIsoDate(1)).toBe('1900-01-01');
    expect(excelSerialToIsoDate(61)).toBe('1900-03-01');
    expect(excelSerialToIsoDate(0, true)).toBeNull();
  });
});
