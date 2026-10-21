import type { Permission } from './permissions.js';

/**
 * Starting points for a custom role (Users → Roles → New role → "Start from a template"). A template only pre-fills the
 * permission matrix: the creator still sees and edits every key, keys they do not hold themselves are left out (the server
 * and the `role_permissions_no_escalation` trigger refuse them anyway), and nothing about the role is stored as "from a
 * template". Names and descriptions are translated in the web app (`users.roles.templates.<key>`).
 */
export const ROLE_TEMPLATE_KEYS = ['employee_relations', 'line_manager', 'hr_viewer'] as const;
export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export interface RoleTemplate {
  key: RoleTemplateKey;
  /** Suggested role key (the creator may change it). */
  roleKey: string;
  permissions: readonly Permission[];
}

export const ROLE_TEMPLATES: Readonly<Record<RoleTemplateKey, RoleTemplate>> = {
  /**
   * Employee Relations department: follows up attendance and leave of the whole organisation — reviews notes and excuses,
   * corrects and approves attendance, approves leave, reports — without changing employee records, structure or settings.
   */
  employee_relations: {
    key: 'employee_relations',
    roleKey: 'employee_relations',
    permissions: [
      'dashboard.view', 'employee.view', 'department.view', 'branch.view',
      'attendance.view', 'attendance.review_notes', 'attendance.correct', 'attendance.approve', 'attendance.request_correction',
      'leave.view', 'leave.approve', 'holiday.view', 'shift.view',
      'report.view', 'report.export', 'approval.delegate',
    ],
  },
  /** A line manager: their direct reports only (team keys), approvals for them, their own attendance and leave. */
  line_manager: {
    key: 'line_manager',
    roleKey: 'line_manager',
    permissions: [
      'dashboard.view', 'employee.view_team', 'attendance.view_team', 'attendance.view_own', 'attendance.approve', 'attendance.correct',
      'attendance.checkin', 'attendance.note', 'attendance.request_correction', 'leave.view_team', 'leave.approve', 'leave.request',
      'holiday.view', 'shift.view', 'shift.assign_team', 'report.view', 'approval.delegate',
    ],
  },
  /** Read-only HR: sees employees, structure, attendance and leave, and runs reports; changes nothing. */
  hr_viewer: {
    key: 'hr_viewer',
    roleKey: 'hr_viewer',
    permissions: [
      'dashboard.view', 'organization.view', 'employee.view', 'department.view', 'branch.view',
      'attendance.view', 'leave.view', 'holiday.view', 'shift.view', 'report.view',
    ],
  },
};
