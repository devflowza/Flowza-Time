import { describe, expect, it } from 'vitest';
import { updateEmployeeSchema } from './employees.js';

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
