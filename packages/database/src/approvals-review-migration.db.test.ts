import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import { applyMigrations } from './tools/migrate.js';

/**
 * Migration 20260928000800 (approval engine v2 review fixes) on data written before it: the database is migrated, the
 * three objects the migration adds to protect the data (the self-approval CHECK, the canonical applies_to trigger, the
 * canonical default index) are removed to recreate the state the review probed, legacy rows are written, and the migration
 * is applied again. It must clear self-approval (P0-3), canonicalise applies_to and deactivate the duplicates it reveals
 * (P2-8), close the PENDING levels of closed requests (P2-10) — each with its audit trail — and be a no-op the second time.
 */
const MIGRATION = '20260928000800_approval_engine_v2_review_fixes.sql';
const ORG = '0d000000-0000-0000-0000-000000000000';
const USER = 'd0000000-0000-0000-0000-000000000001';
const BRANCH_A = '0d000000-0000-0000-0000-00000000000a';
const BRANCH_B = '0d000000-0000-0000-0000-00000000000b';
const W = { old: '0d000000-0000-0000-0000-0000000000f1', dup: '0d000000-0000-0000-0000-0000000000f2', other: '0d000000-0000-0000-0000-0000000000f3' };
const R = { rejected: '0d000000-0000-0000-0000-0000000000a1', cancelled: '0d000000-0000-0000-0000-0000000000a2', pending: '0d000000-0000-0000-0000-0000000000a3' };
const S = { r1l1: '0d000000-0000-0000-0000-0000000000b1', r1l2: '0d000000-0000-0000-0000-0000000000b2', r2l1: '0d000000-0000-0000-0000-0000000000b3', r3l1: '0d000000-0000-0000-0000-0000000000b4' };
const STEPS = JSON.stringify([{ order: 1, approverType: 'MANAGER', mode: 'ANY' }]);

let tdb: TestDatabase;

async function reapply(): Promise<void> {
  await sql`delete from app.migrations where name = ${MIGRATION}`.execute(tdb.adminDb);
  await applyMigrations(tdb.connectionString);
}

beforeAll(async () => {
  tdb = await createTestDatabase(`flowza_dbpkg_apprfix_${process.pid}`);
  const a = tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${USER}, 'hr-d@test.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: USER, email: 'hr-d@test.local', fullName: 'HR D' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'DBT-D', legalName: 'D', displayName: 'D' }).execute();
  await a.insertInto('branches').values([{ id: BRANCH_A, organizationId: ORG, code: 'A', name: 'A' }, { id: BRANCH_B, organizationId: ORG, code: 'B', name: 'B' }]).execute();
  // the state before the fix: no CHECK, no canonicalising trigger, no canonical index
  await sql`alter table public.approval_workflows drop constraint approval_workflows_no_self_approval`.execute(a);
  await sql`drop trigger approval_workflows_canonical_applies_to on public.approval_workflows`.execute(a);
  await sql`drop index public.approval_workflows_default_v3_idx`.execute(a);
  // two active defaults that are the same workflow once canonical ([B, A] and [a, b, a]), one of them allowing self-approval
  await sql`insert into public.approval_workflows (id, organization_id, entity_type, name, steps, applies_to, is_default, status, allow_self_approval, created_at) values
    (${W.old}, ${ORG}, 'LEAVE', 'Old', ${STEPS}::jsonb, ${JSON.stringify({ branchIds: [BRANCH_B.toUpperCase(), BRANCH_A] })}::jsonb, true, 'active', true, now() - interval '2 days'),
    (${W.dup}, ${ORG}, 'LEAVE', 'Copy', ${STEPS}::jsonb, ${JSON.stringify({ branchIds: [BRANCH_A, BRANCH_B, BRANCH_A], departmentIds: [] })}::jsonb, true, 'active', false, now() - interval '1 day'),
    (${W.other}, ${ORG}, 'LEAVE', 'Branch A only', ${STEPS}::jsonb, ${JSON.stringify({ branchIds: [BRANCH_A] })}::jsonb, true, 'active', false, now())`.execute(a);
  // v1-shaped requests closed while levels were still PENDING (the v2 migration stamped activated_at on every level)
  await a.insertInto('approvalRequests').values([
    { id: R.rejected, organizationId: ORG, entityType: 'LEAVE', entityId: '0d000000-0000-0000-0000-0000000001c1', branchId: BRANCH_A, currentStep: 1, status: 'REJECTED', requestedBy: USER },
    { id: R.cancelled, organizationId: ORG, entityType: 'LEAVE', entityId: '0d000000-0000-0000-0000-0000000001c2', branchId: BRANCH_A, currentStep: 1, status: 'CANCELLED', requestedBy: USER },
    { id: R.pending, organizationId: ORG, entityType: 'LEAVE', entityId: '0d000000-0000-0000-0000-0000000001c3', branchId: BRANCH_A, currentStep: 1, status: 'PENDING', requestedBy: USER },
  ]).execute();
  await a.insertInto('approvalSteps').values([
    { id: S.r1l1, organizationId: ORG, requestId: R.rejected, stepNo: 1, approverType: 'MANAGER', mode: 'ANY', status: 'REJECTED', activatedAt: new Date('2026-09-01T08:00:00Z') },
    { id: S.r1l2, organizationId: ORG, requestId: R.rejected, stepNo: 2, approverType: 'HR_ADMIN', mode: 'ANY', status: 'PENDING', activatedAt: new Date('2026-09-01T08:00:00Z') },
    { id: S.r2l1, organizationId: ORG, requestId: R.cancelled, stepNo: 1, approverType: 'MANAGER', mode: 'ANY', status: 'PENDING', activatedAt: new Date('2026-09-02T08:00:00Z') },
    { id: S.r3l1, organizationId: ORG, requestId: R.pending, stepNo: 1, approverType: 'MANAGER', mode: 'ANY', status: 'PENDING', activatedAt: new Date('2026-09-03T08:00:00Z') },
  ]).execute();
  await a.insertInto('approvalStepActors').values([
    { organizationId: ORG, stepId: S.r1l1, userId: USER, decision: 'REJECTED', decidedAt: new Date('2026-09-01T09:00:00Z'), comment: 'No cover' },
    { organizationId: ORG, stepId: S.r1l2, userId: USER, decision: 'PENDING' },
    { organizationId: ORG, stepId: S.r2l1, userId: USER, decision: 'PENDING' },
    { organizationId: ORG, stepId: S.r3l1, userId: USER, decision: 'PENDING' },
  ]).execute();
  await a.insertInto('approvalRequestEvents').values([
    { organizationId: ORG, requestId: R.rejected, kind: 'submitted', actorUserId: USER },
    { organizationId: ORG, requestId: R.rejected, kind: 'rejected', actorUserId: USER },
  ]).execute();
  await reapply();
});
afterAll(async () => { await tdb?.close(); });

const audits = (action: string) => tdb.adminDb.selectFrom('audit.logs').select(['entityId', 'oldValue', 'newValue', 'actorType']).where('action', '=', action).where('organizationId', '=', ORG).execute();

describe('migration 20260928000800 on legacy data', () => {
  it('P0-3 clears self-approval on every workflow (audited) and pins it with a CHECK', async () => {
    const rows = await tdb.adminDb.selectFrom('approvalWorkflows').select(['id', 'allowSelfApproval']).where('organizationId', '=', ORG).execute();
    expect(rows.every((r) => r.allowSelfApproval === false)).toBe(true);
    const audited = await audits('approval_workflow.self_approval_removed');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ entityId: W.old, actorType: 'SYSTEM', newValue: { allowSelfApproval: false } });
    await expect(sql`update public.approval_workflows set allow_self_approval = true where id = ${W.other}`.execute(tdb.adminDb)).rejects.toThrow(/approval_workflows_no_self_approval/);
  });

  it('P2-8 canonicalises applies_to and deactivates the newer duplicate it reveals (audited); the index then refuses a reordered copy', async () => {
    const rows = await tdb.adminDb.selectFrom('approvalWorkflows').select(['id', 'status', 'appliesTo']).where('organizationId', '=', ORG).orderBy('createdAt').execute();
    expect(rows).toEqual([
      { id: W.old, status: 'active', appliesTo: { branchIds: [BRANCH_A, BRANCH_B] } },
      { id: W.dup, status: 'inactive', appliesTo: { branchIds: [BRANCH_A, BRANCH_B] } },
      { id: W.other, status: 'active', appliesTo: { branchIds: [BRANCH_A] } },
    ]);
    const audited = await audits('approval_workflow.duplicate_deactivated');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ entityId: W.dup, newValue: { status: 'inactive', duplicateOf: W.old } });
    await expect(sql`insert into public.approval_workflows (organization_id, entity_type, name, steps, applies_to, is_default, status) values (${ORG}, 'LEAVE', 'Again', ${STEPS}::jsonb, ${JSON.stringify({ branchIds: [BRANCH_B, BRANCH_A] })}::jsonb, true, 'active')`.execute(tdb.adminDb)).rejects.toThrow(/approval_workflows_default_v3_idx/);
  });

  it('P2-10 closes the PENDING levels of closed requests, keeps their history and leaves open requests alone', async () => {
    const steps = await tdb.adminDb.selectFrom('approvalSteps').select(['id', 'status', 'activatedAt']).where('organizationId', '=', ORG).orderBy('id').execute();
    const byId = new Map(steps.map((s) => [s.id, s]));
    expect(byId.get(S.r1l1)).toMatchObject({ status: 'REJECTED' });
    expect(byId.get(S.r1l2)).toMatchObject({ status: 'SKIPPED', activatedAt: null }); // never reached: the invented activation goes
    expect(byId.get(S.r2l1)?.status).toBe('SKIPPED');
    expect(byId.get(S.r2l1)?.activatedAt?.toISOString()).toBe('2026-09-02T08:00:00.000Z'); // the current level keeps it
    expect(byId.get(S.r3l1)).toMatchObject({ status: 'PENDING' });
    const actors = await tdb.adminDb.selectFrom('approvalStepActors').select(['stepId', 'decision', 'comment']).where('organizationId', '=', ORG).execute();
    const decisionOf = (stepId: string) => actors.find((x) => x.stepId === stepId);
    expect(decisionOf(S.r1l1)).toMatchObject({ decision: 'REJECTED', comment: 'No cover' });
    expect(decisionOf(S.r1l2)?.decision).toBe('SKIPPED');
    expect(decisionOf(S.r2l1)?.decision).toBe('SKIPPED');
    expect(decisionOf(S.r3l1)?.decision).toBe('PENDING');
    const statuses = await tdb.adminDb.selectFrom('approvalRequests').select(['id', 'status']).where('organizationId', '=', ORG).orderBy('id').execute();
    expect(statuses.map((r) => r.status)).toEqual(['REJECTED', 'CANCELLED', 'PENDING']);
    expect((await tdb.adminDb.selectFrom('approvalRequestEvents').select('kind').where('requestId', '=', R.rejected).orderBy('id').execute()).map((e) => e.kind)).toEqual(['submitted', 'rejected']);
  });

  it('is idempotent: applied again, it changes nothing and audits nothing new', async () => {
    const snapshot = async () => ({
      workflows: await tdb.adminDb.selectFrom('approvalWorkflows').select(['id', 'status', 'appliesTo', 'allowSelfApproval']).where('organizationId', '=', ORG).orderBy('id').execute(),
      steps: await tdb.adminDb.selectFrom('approvalSteps').select(['id', 'status', 'activatedAt']).where('organizationId', '=', ORG).orderBy('id').execute(),
      audits: (await tdb.adminDb.selectFrom('audit.logs').select('id').where('organizationId', '=', ORG).execute()).length,
    });
    const before = await snapshot();
    await reapply();
    expect(await snapshot()).toEqual(before);
  });
});
