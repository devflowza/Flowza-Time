import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '../common.js';

export const dashboardSummaryQuerySchema = z.object({ date: isoDateSchema.optional(), branchId: uuidSchema.optional() });
export const dashboardTrendsQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema, branchId: uuidSchema.optional() })
  .refine((v) => v.to >= v.from, { message: 'to must be on/after from', path: ['to'] });
export const dashboardBranchesQuerySchema = z.object({ date: isoDateSchema.optional() });

export const dashboardTrendPointSchema = z.object({
  date: isoDateSchema,
  present: z.number().int(),
  absent: z.number().int(),
  late: z.number().int(),
  onLeave: z.number().int(),
  missingPunch: z.number().int(),
  overtimeMinutes: z.number().int(),
});
export type DashboardTrendPoint = z.infer<typeof dashboardTrendPointSchema>;

export const dashboardBranchRowSchema = z.object({
  branchId: uuidSchema,
  branchCode: z.string(),
  branchName: z.string(),
  employees: z.number().int(),
  present: z.number().int(),
  absent: z.number().int(),
  late: z.number().int(),
  onLeave: z.number().int(),
  missingPunch: z.number().int(),
  devicesOnline: z.number().int(),
  devicesOffline: z.number().int(),
});
export type DashboardBranchRow = z.infer<typeof dashboardBranchRowSchema>;
