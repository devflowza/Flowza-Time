import { describe, expect, it } from 'vitest';
import { modulesForPath } from './module-gate.js';

describe('modulesForPath (routes relative to /orgs/:orgId/)', () => {
  it.each([
    ['devices', ['devices']], ['devices/abc/commands', ['devices']], ['device-groups', ['devices']], ['pin-mappings/1', ['devices']], ['sync/jobs', ['devices']],
    ['employees/e1/devices', ['devices']], ['employees/e1/portal-access', ['self_service']],
    ['me/overview', ['self_service']], ['me/leave', ['self_service', 'leave']], ['me/comp-off/preview', ['self_service', 'leave']],
    ['me/punch/status', ['self_service', 'geofences']], ['me/selfie-checkins', ['self_service', 'geofences']], ['me/team/leave', ['self_service', 'leave', 'manager_workspace']],
    ['geofences/g1/assignments', ['geofences']], ['attendance/selfie-checkins', ['geofences']],
    ['leave-types', ['leave']], ['leave-records/r1/comments', ['leave']], ['leave-balances/export', ['leave']], ['leave-calendar', ['leave']],
    ['team/summary', ['manager_workspace']], ['team/leave', ['leave', 'manager_workspace']], ['payroll/periods', ['payroll']],
    ['report-schedules/s1/run-now', ['report_schedules']], ['reports/share', ['report_schedules']], ['integrations/finance/status', ['finance_integration']],
  ])('%s → %j', (path, modules) => {
    expect(modulesForPath(path).sort()).toEqual([...modules].sort());
  });

  it.each(['employees', 'employees/e1', 'attendance/daily', 'attendance/regularisations', 'attendance/notes', 'shifts', 'holidays', 'reports', 'reports/r1/download',
    'approvals/inbox', 'team/pending-counts', 'teams', 'teams/t1', 'settings/leave', 'dashboard/summary', 'audit', 'members', 'roles'])('%s is the core: no module', (path) => {
    expect(modulesForPath(path)).toEqual([]);
  });
});
