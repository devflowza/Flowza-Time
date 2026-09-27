/** Permission vocabulary. Must match supabase/migrations/*_reference_data.sql (+ the additive migrations that extend it). */
export const PERMISSIONS = [
  'dashboard.view',
  'organization.view', 'organization.manage', 'integration.manage',
  'user.view', 'user.manage', 'role.manage',
  'branch.view', 'branch.manage', 'department.view', 'department.manage',
  'employee.view', 'employee.view_sensitive', 'employee.create', 'employee.update', 'employee.delete', 'employee.import', 'employee.export',
  'device.view', 'device.create', 'device.update', 'device.manage', 'device.sync',
  'shift.view', 'shift.manage', 'shift.assign', 'shift.request_swap', 'holiday.view', 'holiday.manage',
  'leave.view', 'leave.manage', 'leave.request', 'leave.approve', 'leave.view_team',
  'attendance.view', 'attendance.view_own', 'attendance.view_team', 'attendance.view_raw', 'attendance.correct', 'attendance.approve',
  'attendance.manage_rules', 'attendance.recalculate', 'attendance.lock_period', 'attendance.request_correction',
  'attendance.checkin', 'attendance.note', 'attendance.review_notes', 'attendance.manage_geofences', 'attendance.manage_overtime',
  'payroll.view', 'payroll.finalize',
  'report.view', 'report.manage', 'report.export', 'report.schedule',
  'approval.manage', 'approval.delegate',
  'audit.view', 'notification.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLE_KEYS = ['owner', 'org_admin', 'hr_admin', 'hr_user', 'branch_manager', 'attendance_admin', 'payroll', 'employee', 'manager', 'auditor'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** Stable ids of the seeded system roles (see reference data migration + 20260928000100 for manager/auditor). */
export const SYSTEM_ROLE_IDS: Record<SystemRoleKey, string> = {
  owner: '10000000-0000-0000-0000-000000000001',
  org_admin: '10000000-0000-0000-0000-000000000002',
  hr_admin: '10000000-0000-0000-0000-000000000003',
  hr_user: '10000000-0000-0000-0000-000000000004',
  branch_manager: '10000000-0000-0000-0000-000000000005',
  attendance_admin: '10000000-0000-0000-0000-000000000006',
  payroll: '10000000-0000-0000-0000-000000000007',
  employee: '10000000-0000-0000-0000-000000000008',
  manager: '10000000-0000-0000-0000-000000000009',
  auditor: '10000000-0000-0000-0000-000000000010',
};

/**
 * Team-scoped read keys: a holder sees the rows of their DIRECT reports (employees whose primary or secondary manager is
 * one of the holder's own employee records) through the RLS team predicate, without holding the organisation-wide key.
 */
export const TEAM_PERMISSIONS = ['attendance.view_team', 'leave.view_team'] as const satisfies readonly Permission[];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
