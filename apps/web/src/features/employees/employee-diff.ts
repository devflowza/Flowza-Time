import type { UpdateEmployeeInput } from '@flowza/contracts';
import type { EmployeeDetail } from './api';
import type { EmployeeFormValues } from './components/employee-form-fields';

/** Fields whose change closes the current employment_history row and opens a new one (API contract). */
export const EFFECTIVE_DATED_FIELDS = ['branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'employmentType', 'employmentStatus'] as const;

export function toFormValues(e: EmployeeDetail): EmployeeFormValues {
  return {
    employeeNumber: e.employeeNumber, firstName: e.firstName, middleName: e.middleName ?? undefined, lastName: e.lastName, displayName: e.displayName, displayNameAr: e.displayNameAr ?? undefined,
    gender: e.gender, dateOfBirth: e.dateOfBirth ?? undefined, nationalityCode: e.nationalityCode ?? undefined, email: e.email ?? undefined, phone: e.phone ?? undefined,
    joiningDate: e.joiningDate, exitDate: e.exitDate, employmentStatus: e.employmentStatus, employmentType: e.employmentType,
    branchId: e.branchId, departmentId: e.departmentId ?? undefined, designationId: e.designationId ?? undefined, managerEmployeeId: e.managerEmployeeId ?? undefined,
    deviceUserId: e.deviceUserId, cardNumber: e.cardNumber ?? undefined, pin: undefined, weeklyOffDays: e.weeklyOffDays ?? undefined,
  };
}

/** Only changed keys are sent (PATCH); `pin` is write-only and never round-trips. */
export function diffEmployee(before: EmployeeFormValues, after: UpdateEmployeeInput): UpdateEmployeeInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    const prev = (before as Record<string, unknown>)[k];
    const norm = (x: unknown) => (x === undefined || x === '' ? null : Array.isArray(x) ? JSON.stringify(x) : x);
    if (norm(prev) !== norm(v)) out[k] = v === undefined ? null : v;
  }
  delete out['employeeNumber'];
  if (out['pin'] === null) delete out['pin'];
  return out as UpdateEmployeeInput;
}

