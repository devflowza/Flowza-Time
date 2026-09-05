/** Permission vocabulary. Must match supabase/migrations/*_reference_data.sql. */
export const PERMISSIONS = [
  'dashboard.view',
  'organization.view', 'organization.manage',
  'user.view', 'user.manage', 'role.manage',
  'branch.view', 'branch.manage', 'department.view', 'department.manage',
  'employee.view', 'employee.view_sensitive', 'employee.create', 'employee.update', 'employee.delete', 'employee.import', 'employee.export',
  'device.view', 'device.create', 'device.update', 'device.manage', 'device.sync',
  'shift.view', 'shift.manage', 'shift.assign', 'holiday.view', 'holiday.manage', 'leave.view', 'leave.manage',
  'attendance.view', 'attendance.view_own', 'attendance.view_raw', 'attendance.correct', 'attendance.approve',
  'attendance.manage_rules', 'attendance.recalculate', 'attendance.lock_period',
  'payroll.view', 'payroll.finalize',
  'report.view', 'report.manage', 'report.export',
  'audit.view', 'notification.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLE_KEYS = ['owner', 'org_admin', 'hr_admin', 'hr_user', 'branch_manager', 'attendance_admin', 'payroll', 'employee'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** Stable ids of the seeded system roles (see reference data migration). */
export const SYSTEM_ROLE_IDS: Record<SystemRoleKey, string> = {
  owner: '10000000-0000-0000-0000-000000000001',
  org_admin: '10000000-0000-0000-0000-000000000002',
  hr_admin: '10000000-0000-0000-0000-000000000003',
  hr_user: '10000000-0000-0000-0000-000000000004',
  branch_manager: '10000000-0000-0000-0000-000000000005',
  attendance_admin: '10000000-0000-0000-0000-000000000006',
  payroll: '10000000-0000-0000-0000-000000000007',
  employee: '10000000-0000-0000-0000-000000000008',
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
