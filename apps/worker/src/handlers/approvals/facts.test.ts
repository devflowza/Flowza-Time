import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@flowza/database';
import { defaultRegistry } from '@flowza/device-providers';
import { createHarness, type TestHarness } from '../../test/harness.js';
import { approvalEntityFacts } from './facts.js';

/*
 * The facts an approval notice carries for a shift change request (Enterprise, module shift_requests): the range of days, read
 * from the request in the organisation's system context like every other entity's facts.
 */
const ORG = '0f500000-0000-4000-a000-000000000001';
const BRANCH = '0f500000-0000-4000-a000-00000000000b';
const EMP = '0f500000-0000-4000-a000-0000000000e1';
const SHIFT = '0f500000-0000-4000-a000-0000000000a1';
const CHANGE = '0f500000-0000-4000-a000-0000000000c1';

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness(`flowza_worker_facts_${process.pid}`, defaultRegistry());
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'FCT', legalName: 'Facts', displayName: 'Facts', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'D', name: 'Day', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).execute();
  await a.insertInto('employees').values({ id: EMP, organizationId: ORG, branchId: BRANCH, employeeNumber: '1', firstName: 'F', lastName: 'L', displayName: 'F L', joiningDate: '2025-01-01', deviceUserId: '1' }).execute();
  await a.insertInto('shiftChangeRequests').values({ id: CHANGE, organizationId: ORG, employeeId: EMP, branchId: BRANCH, kind: 'CHANGE', fromDate: '2026-10-12', toDate: '2026-10-14', requestedShiftId: SHIFT, reason: 'Childcare' }).execute();
});
afterAll(async () => { await h?.close(); });

describe('approvalEntityFacts', () => {
  it('a shift change request carries its first and last day', async () => {
    const facts = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => approvalEntityFacts(trx, ORG, 'SHIFT_CHANGE', CHANGE));
    expect(facts).toEqual({ date: '2026-10-12', endDate: '2026-10-14', leaveTypeName: null, leaveTypeNameAr: null });
  });
  it('an unknown request carries none', async () => {
    const facts = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => approvalEntityFacts(trx, ORG, 'SHIFT_CHANGE', '0f500000-0000-4000-a000-0000000000c9'));
    expect(facts).toEqual({ date: null, endDate: null, leaveTypeName: null, leaveTypeNameAr: null });
  });
});
