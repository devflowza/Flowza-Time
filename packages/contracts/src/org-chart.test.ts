import { describe, expect, it } from 'vitest';
import { orgChartFilterSchema, orgChartQuerySchema } from './org-chart.js';

describe('orgChartQuerySchema', () => {
  it('reads the top of the chart, one page of 100, by default', () => {
    expect(orgChartQuerySchema.parse({})).toEqual({ view: 'top', page: 1, pageSize: 100 });
  });

  it('coerces paging from the query string and bounds it', () => {
    expect(orgChartQuerySchema.parse({ view: 'unassigned', page: '2', pageSize: '50', search: '  ali ' })).toEqual({ view: 'unassigned', page: 2, pageSize: 50, search: 'ali' });
    expect(orgChartQuerySchema.safeParse({ pageSize: '201' }).success).toBe(false);
    expect(orgChartQuerySchema.safeParse({ view: 'all' }).success).toBe(false);
    expect(orgChartQuerySchema.safeParse({ managerId: 'x' }).success).toBe(false);
  });

  it('the path read takes the chart filters only', () => {
    expect(orgChartFilterSchema.parse({ branchId: '00000000-0000-4000-8000-000000000001', page: '3' })).toEqual({ branchId: '00000000-0000-4000-8000-000000000001' });
  });
});
