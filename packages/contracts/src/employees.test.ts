import { describe, expect, it } from 'vitest';
import { bulkEmployeeActionSchema, updateEmployeeSchema } from './employees.js';

/**
 * `PATCH /employees/:id`. The profile form sends only the changed keys and `null` for a field the user emptied, so the
 * schema must take `null` for every nullable column (a refused `null` was a bare "Request validation failed." on Save)
 * and keep refusing it for the columns that cannot be empty.
 */
describe('updateEmployeeSchema', () => {
  it('takes null to clear every optional column', () => {
    const cleared = {
      displayName: null, middleName: null, displayNameAr: null, dateOfBirth: null, nationalityCode: null, email: null, phone: null,
      departmentId: null, designationId: null, managerEmployeeId: null, secondaryManagerEmployeeId: null, cardNumber: null, weeklyOffDays: null, exitDate: null,
    };
    expect(updateEmployeeSchema.parse(cleared)).toEqual(cleared);
  });

  it('refuses null for the required columns', () => {
    for (const key of ['employeeNumber', 'firstName', 'lastName', 'gender', 'joiningDate', 'employmentStatus', 'employmentType', 'branchId', 'deviceUserId', 'pin']) {
      expect(updateEmployeeSchema.safeParse({ [key]: null }).success, key).toBe(false);
    }
  });

  it('still validates a value that is sent, and passes a one-field update through alone', () => {
    expect(updateEmployeeSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({ weeklyOffDays: [7] }).success).toBe(false);
    expect(updateEmployeeSchema.parse({ cardNumber: ' 00123 ' })).toEqual({ cardNumber: '00123' });
    expect(updateEmployeeSchema.parse({ nationalityCode: 'om' })).toEqual({ nationalityCode: 'OM' });
    expect(updateEmployeeSchema.parse({})).toEqual({});
  });
});

describe('bulkEmployeeActionSchema — assign_manager', () => {
  const ids = ['00000000-0000-4000-8000-000000000001'];
  const manager = '00000000-0000-4000-8000-000000000002';

  it('defaults to the primary line and takes null to remove the manager', () => {
    expect(bulkEmployeeActionSchema.parse({ action: 'assign_manager', employeeIds: ids, managerEmployeeId: manager })).toEqual({ action: 'assign_manager', employeeIds: ids, managerEmployeeId: manager, line: 'primary' });
    expect(bulkEmployeeActionSchema.parse({ action: 'assign_manager', employeeIds: ids, managerEmployeeId: null, line: 'secondary', effectiveFrom: '2026-10-01' })).toEqual({ action: 'assign_manager', employeeIds: ids, managerEmployeeId: null, line: 'secondary', effectiveFrom: '2026-10-01' });
  });

  it('requires the manager key, at least one employee and a known line', () => {
    expect(bulkEmployeeActionSchema.safeParse({ action: 'assign_manager', employeeIds: ids }).success).toBe(false);
    expect(bulkEmployeeActionSchema.safeParse({ action: 'assign_manager', employeeIds: [], managerEmployeeId: manager }).success).toBe(false);
    expect(bulkEmployeeActionSchema.safeParse({ action: 'assign_manager', employeeIds: ids, managerEmployeeId: manager, line: 'dotted' }).success).toBe(false);
    expect(bulkEmployeeActionSchema.safeParse({ action: 'assign_manager', employeeIds: ids, managerEmployeeId: 'not-a-uuid' }).success).toBe(false);
  });
});
