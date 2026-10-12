import { z } from 'zod';
import { EMPLOYMENT_STATUSES } from './enums.js';
import { uuidSchema } from './common.js';

/**
 * Org chart (GET /orgs/:orgId/org-chart): the reporting lines of the organisation, one level at a time. The chart follows the
 * PRIMARY manager; the secondary (dotted-line) manager is shown on the card. Every read is limited to the caller's branch scope
 * and to the optional branch / department filter — together "the chart's set"; employees who left are not on the chart.
 *
 * - `managerId` set → that employee's direct reports in the set.
 * - otherwise `view: 'top'` → the heads of the chart: employees in the set whose manager is outside it (or none) and who have
 *   at least one direct report in it.
 * - `view: 'unassigned'` → employees in the set with no manager in it and no direct report in it (not on the chart yet);
 *   `search` narrows this list (number, name).
 */
export const ORG_CHART_VIEWS = ['top', 'unassigned'] as const;
export const ORG_CHART_PAGE_SIZE = 100;

export const orgChartQuerySchema = z.object({
  managerId: uuidSchema.optional(),
  view: z.enum(ORG_CHART_VIEWS).default('top'),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(ORG_CHART_PAGE_SIZE),
});
export type OrgChartQuery = z.infer<typeof orgChartQuerySchema>;

/** The filters of the chart's set, shared by the path read. */
export const orgChartFilterSchema = orgChartQuerySchema.pick({ branchId: true, departmentId: true });
export type OrgChartFilter = z.infer<typeof orgChartFilterSchema>;

/** One card of the chart: who the employee is and how many direct reports (primary line, in the chart's set) sit below. */
export const orgChartNodeSchema = z.object({
  id: uuidSchema,
  employeeNumber: z.string(),
  displayName: z.string(),
  displayNameAr: z.string().nullable(),
  photoUrl: z.string().nullable(),
  designationName: z.string().nullable(),
  departmentName: z.string().nullable(),
  branchId: uuidSchema,
  branchName: z.string().nullable(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  managerEmployeeId: uuidSchema.nullable(),
  secondaryManagerEmployeeId: uuidSchema.nullable(),
  secondaryManagerName: z.string().nullable(),
  directReportCount: z.number().int().min(0),
});
export type OrgChartNodeDto = z.infer<typeof orgChartNodeSchema>;

/**
 * Where one employee sits on the chart (GET /orgs/:orgId/org-chart/path/:employeeId): `ancestorIds` lists their managers in the
 * chart's set from the top of the chart down to the direct manager (empty for a head of the chart or an unassigned employee).
 * `placement: 'unassigned'` = no manager and no report in the set (the employee is found in the unassigned list, not in the tree).
 */
export const orgChartPathSchema = z.object({
  employeeId: uuidSchema,
  placement: z.enum(['tree', 'unassigned']),
  ancestorIds: z.array(uuidSchema),
});
export type OrgChartPathDto = z.infer<typeof orgChartPathSchema>;
