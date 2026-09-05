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
}
