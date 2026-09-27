import type { Permission } from '@flowza/contracts';

/** What the API knows about the caller after bootstrapping from the database (never from the JWT). */
export interface Principal {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
  memberships: MembershipGrant[];
}
export interface MembershipGrant {
  membershipId: string;
  organizationId: string;
  roleId: string;
  roleKey: string;
  permissions: Permission[];
  allBranches: boolean;
  branchIds: string[];
  employeeId: string | null;
  /**
   * Direct reports of the membership's employee record (primary OR secondary manager), resolved through
   * org_memberships.employee_id — the same rule as `app.team_employee_ids()` in RLS. Empty when the membership is not
   * linked to an employee or nobody reports to that employee.
   */
  teamEmployeeIds: string[];
}
