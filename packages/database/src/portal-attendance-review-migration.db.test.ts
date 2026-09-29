import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import { applyMigrations } from './tools/migrate.js';

/**
 * Migration 20260928000840 (employee portal attendance review fixes, HR portal Prompt 4) on data written before it, and its
 * re-application: the database is migrated, rows of the shape the review found are written (swap requests without their
 * colleague as co-subject, special leave types that are still chargeable, two open swaps for one person and day), and the
 * migration is applied again. It must backfill the co-subjects (P0-2), mark the special leave types by code with one audit row
 * each and nothing else (ATT-82), refuse clearly while two open swaps collide (P2-12), and — with the upserts of every
 * provider-writing migration re-run — leave `device_providers` byte-identical (P2-19).
 */
const MIGRATION = '20260928000840_portal_attendance_review_fixes.sql';
const PROVIDER_MIGRATIONS = ['20260905001600_reference_data.sql', '20260928000450_finance_connector_fixes.sql', '20260928000500_portal_attendance_self_service.sql', MIGRATION, '20260929000100_hikvision_push_provider.sql', '20260929000200_device_provider_adapters.sql'];
/**
 * Rows a later migration rewrites (20260929000200 replaced the placeholders the reference data seeded): replaying the chain
 * really changes them twice (old row, then new row), so their stamp legitimately moves; their CONTENT must still come out identical.
 */
const SUPERSEDED = new Set(['zkteco_biotime', 'hikvision_isapi', 'suprema_biostar2', 'anviz_crosschex_cloud', 'essl_push', 'fingertec_push', 'matrix_cosec']);
const ORG = '0c000000-0000-0000-0000-000000000000';
const BRANCH = '0c000000-0000-0000-0000-00000000000b';
const E = { requester: '0c000000-0000-0000-0000-0000000000e1', colleague: '0c000000-0000-0000-0000-0000000000e2', third: '0c000000-0000-0000-0000-0000000000e3' };
const U = { requester: 'c0000000-0000-0000-0000-000000000001', colleague: 'c0000000-0000-0000-0000-000000000002', colleague2: 'c0000000-0000-0000-0000-000000000003' };
const SHIFT = { day: '0c000000-0000-0000-0000-0000000005a1', night: '0c000000-0000-0000-0000-0000000005a2' };
const SWAP = { legacy: '0c000000-0000-0000-0000-0000000006a1', clashA: '0c000000-0000-0000-0000-0000000006a2', clashB: '0c000000-0000-0000-0000-0000000006a3' };
const REQ = { legacy: '0c000000-0000-0000-0000-0000000007a1', done: '0c000000-0000-0000-0000-0000000007a2' };

let tdb: TestDatabase;

async function reapply(names: readonly string[]): Promise<void> {
  await sql`delete from app.migrations where name in (${sql.join(names.map((n) => sql`${n}`))})`.execute(tdb.adminDb);
  await applyMigrations(tdb.connectionString);
}
const providers = async () => (await sql<{ row: Record<string, unknown> }>`select to_jsonb(p) as row from public.device_providers p order by p.key`.execute(tdb.adminDb)).rows
  .map(({ row }) => (SUPERSEDED.has(String(row['key'])) ? { ...row, updatedAt: '(superseded)' } : row));
const providerStamp = async (key: string) => (await tdb.adminDb.selectFrom('deviceProviders').select('updatedAt').where('key', '=', key).executeTakeFirstOrThrow()).updatedAt.toISOString();

beforeAll(async () => {
  tdb = await createTestDatabase(`flowza_dbpkg_p4fix_${process.pid}`);
  const a = tdb.adminDb;
  await sql`insert into auth.users (id, email) values ${sql.join(Object.values(U).map((id) => sql`(${id}::uuid, ${`${id}@t.local`})`))}`.execute(a);
  await a.insertInto('userProfiles').values(Object.entries(U).map(([k, id]) => ({ id, email: `${id}@t.local`, fullName: k }))).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'P4F', legalName: 'P4F', displayName: 'P4F', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }).execute();
  await a.insertInto('employees').values([
    { id: E.requester, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E1', firstName: 'Req', lastName: 'Uester', displayName: 'Requester', joiningDate: '2024-01-01', deviceUserId: '1' },
    { id: E.colleague, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E2', firstName: 'Col', lastName: 'League', displayName: 'Colleague', joiningDate: '2024-01-01', deviceUserId: '2' },
    { id: E.third, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E3', firstName: 'Thi', lastName: 'Rd', displayName: 'Third', joiningDate: '2024-01-01', deviceUserId: '3' },
  ]).execute();
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: U.requester, roleId: '10000000-0000-0000-0000-000000000008', status: 'active', allBranches: true, employeeId: E.requester },
    // two logins linked to the colleague (one of them suspended): both are the colleague
    { organizationId: ORG, userId: U.colleague, roleId: '10000000-0000-0000-0000-000000000003', status: 'active', allBranches: true, employeeId: E.colleague },
    { organizationId: ORG, userId: U.colleague2, roleId: '10000000-0000-0000-0000-000000000004', status: 'suspended', allBranches: true, employeeId: E.colleague },
  ]).execute();
  await a.insertInto('shifts').values([
    { id: SHIFT.day, organizationId: ORG, code: 'DAY', name: 'Day', type: 'FIXED', startTime: '08:00', endTime: '17:00' },
    { id: SHIFT.night, organizationId: ORG, code: 'NIGHT', name: 'Night', type: 'FIXED', startTime: '20:00', endTime: '05:00' },
  ]).execute();
});
afterAll(async () => { await tdb?.close(); });

describe('migration 20260928000840 on data written before it', () => {
  it('4-P0-2 a swap request filed before the fix gets its colleague (every linked login) as co-subject; a set list is left alone', async () => {
    const a = tdb.adminDb;
    await a.insertInto('shiftSwapRequests').values({ id: SWAP.legacy, organizationId: ORG, requesterEmployeeId: E.requester, targetEmployeeId: E.colleague, branchId: BRANCH, swapDate: '2026-10-05', requesterShiftId: SHIFT.day, targetShiftId: SHIFT.night, reason: 'Family event', status: 'pending' }).execute();
    await a.insertInto('approvalRequests').values([
      { id: REQ.legacy, organizationId: ORG, entityType: 'SHIFT_SWAP', entityId: SWAP.legacy, branchId: BRANCH, employeeId: E.requester, subjectUserId: U.requester, requestedBy: U.requester, currentStep: 1, status: 'PENDING' },
    ]).execute();
    await reapply([MIGRATION]);
    const row = await a.selectFrom('approvalRequests').select(['coSubjectEmployeeIds', 'coSubjectUserIds']).where('id', '=', REQ.legacy).executeTakeFirstOrThrow();
    expect(row.coSubjectEmployeeIds).toEqual([E.colleague]);
    expect([...(row.coSubjectUserIds ?? [])].sort()).toEqual([U.colleague, U.colleague2].sort());
    // idempotent: a request whose co-subjects are already set keeps them
    await a.updateTable('approvalRequests').set({ coSubjectUserIds: [U.colleague] }).where('id', '=', REQ.legacy).execute();
    await reapply([MIGRATION]);
    expect((await a.selectFrom('approvalRequests').select('coSubjectUserIds').where('id', '=', REQ.legacy).executeTakeFirstOrThrow()).coSubjectUserIds).toEqual([U.colleague]);
  });

  it('4-ATT-82 marks existing marriage / bereavement / adoption / compassionate leave types special by code (one audit row each), nothing else', async () => {
    const a = tdb.adminDb;
    await a.insertInto('leaveTypes').values([
      { organizationId: ORG, code: 'marriage', name: 'Marriage', isPaid: true, annualAllowanceDays: 5 },
      { organizationId: ORG, code: 'Bereavement', name: 'Bereavement', isPaid: true, annualAllowanceDays: 3 },
      { organizationId: ORG, code: 'ADOPTION', name: 'Adoption', isPaid: true, annualAllowanceDays: 10 },
      { organizationId: ORG, code: 'compassionate', name: 'Compassionate', isPaid: true, annualAllowanceDays: 2 },
      // a tenant's own codes are never touched, whatever their names say
      { organizationId: ORG, code: 'MR', name: 'Marriage Leave', isPaid: true, annualAllowanceDays: 5 },
      { organizationId: ORG, code: 'AL', name: 'Annual Leave', isPaid: true, annualAllowanceDays: 30 },
    ]).execute();
    await reapply([MIGRATION]);
    const types = await a.selectFrom('leaveTypes').select(['code', 'isSpecial']).where('organizationId', '=', ORG).orderBy('code').execute();
    expect(Object.fromEntries(types.map((t) => [String(t.code), t.isSpecial]))).toEqual({ ADOPTION: true, AL: false, Bereavement: true, compassionate: true, marriage: true, MR: false });
    const audits = await a.selectFrom('audit.logs').select(['entityId', 'actorType', 'newValue']).where('action', '=', 'leave_type.marked_special').where('organizationId', '=', ORG).execute();
    expect(audits).toHaveLength(4);
    expect(audits.every((x) => x.actorType === 'SYSTEM' && (x.newValue as { isSpecial: boolean }).isSpecial)).toBe(true);
    await reapply([MIGRATION]);
    expect(await a.selectFrom('audit.logs').select('id').where('action', '=', 'leave_type.marked_special').where('organizationId', '=', ORG).execute()).toHaveLength(4);
  });

  it('4-P2-12 refuses, with a message saying what to do, while one person has two open swaps on one day; applies once one is withdrawn', async () => {
    const a = tdb.adminDb;
    // the state before the fix: no one-open-swap-per-person-and-day indexes
    await sql`drop index public.shift_swap_requests_open_target_day_idx`.execute(a);
    await sql`drop index public.shift_swap_requests_open_requester_day_idx`.execute(a);
    await a.insertInto('shiftSwapRequests').values([
      { id: SWAP.clashA, organizationId: ORG, requesterEmployeeId: E.requester, targetEmployeeId: E.third, branchId: BRANCH, swapDate: '2026-10-07', requesterShiftId: SHIFT.day, targetShiftId: SHIFT.night, reason: 'First request', status: 'pending' },
      { id: SWAP.clashB, organizationId: ORG, requesterEmployeeId: E.colleague, targetEmployeeId: E.third, branchId: BRANCH, swapDate: '2026-10-07', requesterShiftId: SHIFT.day, targetShiftId: SHIFT.night, reason: 'Second request', status: 'pending' },
    ]).execute();
    await expect(reapply([MIGRATION])).rejects.toThrow(/two pending \/ approved swaps for one person and day: decide or withdraw one of them/);
    await a.updateTable('shiftSwapRequests').set({ status: 'cancelled' }).where('id', '=', SWAP.clashB).execute();
    await reapply([MIGRATION]);
    const idx = await sql<{ indexname: string; indexdef: string }>`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'shift_swap_requests' and indexname like '%open_%_day_idx' order by indexname`.execute(a);
    expect(idx.rows.map((r) => r.indexname)).toEqual(['shift_swap_requests_open_requester_day_idx', 'shift_swap_requests_open_target_day_idx']);
    expect(idx.rows.every((r) => r.indexdef.startsWith('CREATE UNIQUE INDEX') && /WHERE .*pending.*approved/.test(r.indexdef))).toBe(true);
    await expect(a.insertInto('shiftSwapRequests').values({ organizationId: ORG, requesterEmployeeId: E.colleague, targetEmployeeId: E.third, branchId: BRANCH, swapDate: '2026-10-07', requesterShiftId: SHIFT.day, targetShiftId: SHIFT.night, reason: 'Third request', status: 'pending' }).execute()).rejects.toThrow(/shift_swap_requests_open_target_day_idx/);
  });

  it('4-P2-19 re-applying every provider-writing migration leaves device_providers byte-identical (a no-op upsert keeps updated_at)', async () => {
    const before = await providers();
    expect(before.length).toBeGreaterThan(3);
    await reapply(PROVIDER_MIGRATIONS);
    expect(await providers()).toEqual(before);
    // the control: without the trigger the same upsert moves the stamp — the test sees the difference
    await sql`drop trigger device_providers_keep_updated_at on public.device_providers`.execute(tdb.adminDb);
    const stamp = await providerStamp('self_service');
    await reapply(['20260928000500_portal_attendance_self_service.sql']);
    expect(await providerStamp('self_service')).not.toBe(stamp);
    await reapply([MIGRATION]);
    const settled = await providers();
    await reapply(PROVIDER_MIGRATIONS);
    expect(await providers()).toEqual(settled);
    // a real change written the way the upserts write it (`updated_at = now()`) still moves the stamp
    const settledStamp = await providerStamp('self_service');
    await tdb.adminDb.updateTable('deviceProviders').set({ description: 'changed on purpose', updatedAt: sql<Date>`now()` }).where('key', '=', 'self_service').execute();
    expect(await providerStamp('self_service')).not.toBe(settledStamp);
  });
});
