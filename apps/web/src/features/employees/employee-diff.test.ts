import { describe, expect, it } from 'vitest';
import { updateEmployeeSchema } from '@flowza/contracts';
import { diffEmployee, EFFECTIVE_DATED_FIELDS, toFormValues } from './employee-diff';
import type { EmployeeDetail } from './api';

const employee: EmployeeDetail = {
  id: 'e1', organizationId: 'org-1', employeeNumber: 'E001', firstName: 'Ali', middleName: null, lastName: 'Said', displayName: 'Ali Said', displayNameAr: null, photoPath: null, photoUrl: null,
  gender: 'male', dateOfBirth: null, nationalityCode: 'OM', email: 'ali@acme.om', phone: null, joiningDate: '2024-01-15', exitDate: null, employmentStatus: 'active', employmentType: 'full_time',
  branchId: 'b1', branchName: 'Muscat', departmentId: null, designationId: 'd1', managerEmployeeId: null, userId: null, deviceUserId: '1', cardNumber: null, fingerprintEnrolled: false, faceEnrolled: false,
  weeklyOffDays: null, customFields: {}, deletedAt: null, createdAt: '2024-01-15T00:00:00Z', updatedAt: '2024-01-15T00:00:00Z', currentHistory: null,
};

describe('employee-diff', () => {
  it('maps nullable DTO fields to form values and never round-trips the PIN', () => {
    const v = toFormValues(employee);
    expect(v.middleName).toBeUndefined();
    expect(v.branchId).toBe('b1');
    expect(v.pin).toBeUndefined();
  });
  it('sends only changed keys and nulls cleared optional fields', () => {
    const before = toFormValues(employee);
    const patch = diffEmployee(before, { ...before, email: undefined, phone: '+968 9000 0000', branchId: 'b2', employeeNumber: 'E001' } as never);
    expect(patch).toEqual({ email: null, phone: '+968 9000 0000', branchId: 'b2' });
  });
  it('ignores an unchanged form (including the read-only employee number)', () => {
    const before = toFormValues(employee);
    expect(diffEmployee(before, { ...before } as never)).toEqual({});
  });
  it('flags effective-dated fields so the UI can ask for an effective date', () => {
    const before = toFormValues(employee);
    const patch = diffEmployee(before, { ...before, designationId: 'd2', firstName: 'Aly' } as never);
    const effective = EFFECTIVE_DATED_FIELDS.filter((f) => f in patch);
    expect(effective).toEqual(['designationId']);
  });
  it('round-trips the secondary manager and treats it as a plain (not effective-dated) change; clearing sends null', () => {
    const withSecondary = toFormValues({ ...employee, managerEmployeeId: 'm1', secondaryManagerEmployeeId: 'm2' });
    expect(withSecondary.secondaryManagerEmployeeId).toBe('m2');
    const patch = diffEmployee(withSecondary, { ...withSecondary, secondaryManagerEmployeeId: 'm3' } as never);
    expect(patch).toEqual({ secondaryManagerEmployeeId: 'm3' });
    expect(EFFECTIVE_DATED_FIELDS.filter((f) => f in patch)).toEqual([]);
    expect(diffEmployee(withSecondary, { ...withSecondary, secondaryManagerEmployeeId: undefined, managerEmployeeId: undefined } as never)).toEqual({ managerEmployeeId: null, secondaryManagerEmployeeId: null });
  });
  it('every optional field the form can empty produces a PATCH the API accepts (Save used to fail with "Request validation failed.")', () => {
    const full = toFormValues({
      ...employee, middleName: 'bin', displayNameAr: 'علي', dateOfBirth: '1990-05-01', phone: '+968 9000 0000', departmentId: 'dep1', managerEmployeeId: 'm1', secondaryManagerEmployeeId: 'm2',
      cardNumber: '00123', weeklyOffDays: [5, 6], exitDate: '2026-12-31',
    });
    const optional = ['displayName', 'middleName', 'displayNameAr', 'dateOfBirth', 'nationalityCode', 'email', 'phone', 'departmentId', 'designationId', 'managerEmployeeId', 'secondaryManagerEmployeeId', 'cardNumber', 'weeklyOffDays', 'exitDate'] as const;
    for (const key of optional) {
      const patch = diffEmployee(full, { ...full, [key]: undefined } as never);
      expect(patch, key).toEqual({ [key]: null });
      expect(updateEmployeeSchema.safeParse(patch).success, key).toBe(true);
    }
  });
});
