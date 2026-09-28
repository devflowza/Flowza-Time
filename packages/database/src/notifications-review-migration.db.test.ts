import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { NOTIFICATION_ROUTE_KEYS, NOTIFICATION_TYPES, notificationDataKeys } from '@flowza/contracts';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import { applyMigrations } from './tools/migrate.js';

/**
 * Migration 20260928001050 (notifications review fixes, HR portal Prompt 8 review) on notices written before it: the
 * pre-Prompt-8 relay stored the WHOLE event payload in `notifications.data` (recipient lists, other people's ids, free-form
 * fields). The migration scrubs every row down to what the current relay writes — the aggregate, the routing facts and the
 * catalogue's template variables of the type (the aggregate and the routing facts only for a type the catalogue does not
 * know) — in keyset batches, and a re-run changes nothing (8-P0-5).
 */
const MIGRATION = '20260928001050_notifications_review_fixes.sql';
const ORG = '0c000000-0000-0000-0000-00000000f001';
const USER = 'c0000000-0000-0000-0000-00000000f001';
const OTHER = 'c0000000-0000-0000-0000-00000000f002';
const REQUEST = '0c000000-0000-0000-0000-00000000f0a1';
const EMPLOYEE = '0c000000-0000-0000-0000-00000000f0e1';

let tdb: TestDatabase;

async function reapply(): Promise<void> {
  await sql`delete from app.migrations where name = ${MIGRATION}`.execute(tdb.adminDb);
  await applyMigrations(tdb.connectionString);
}

/** The whitelist literal of the migration (`notificationDataKeys()` of @flowza/contracts when it was written). */
function migrationWhitelist(): { base: string[]; types: Record<string, string[]> } {
  const file = readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${MIGRATION}`, import.meta.url)), 'utf8');
  const m = /v_keys constant jsonb := '([\s\S]*?)'::jsonb;/.exec(file);
  if (!m) throw new Error('the whitelist literal is missing from the migration');
  return JSON.parse(m[1]!) as { base: string[]; types: Record<string, string[]> };
}

beforeAll(async () => {
  tdb = await createTestDatabase(`flowza_dbpkg_p8fix_${process.pid}`);
  const a = tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${USER}::uuid, 'u@p8.local'), (${OTHER}::uuid, 'o@p8.local')`.execute(a);
  await a.insertInto('userProfiles').values([{ id: USER, email: 'u@p8.local', fullName: 'U' }, { id: OTHER, email: 'o@p8.local', fullName: 'O' }]).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'P8F', legalName: 'P8F', displayName: 'P8F', timezone: 'Asia/Muscat' }).execute();
});
afterAll(async () => { await tdb?.close(); });

describe('migration 20260928001050 on notices written before it', () => {
  it('8-P0-5 scrubs pre-Prompt-8 notifications.data down to the whitelist, in batches, and a re-run changes nothing', async () => {
    const a = tdb.adminDb;
    // the pre-Prompt-8 relay: data = { aggregateType, aggregateId, ...the whole event payload }
    const legacy = (extra: Record<string, unknown>) => ({
      aggregateType: 'approval_request', aggregateId: REQUEST, requestId: REQUEST, entityType: 'LEAVE', entityId: REQUEST, employeeId: EMPLOYEE,
      userIds: [USER, OTHER], userId: OTHER, requestedBy: OTHER, decidedBy: OTHER, employeeNumber: 'E-0042', secretNote: 'x', ...extra,
    });
    const rows = [
      { type: 'approval.decided', data: legacy({ decision: 'REJECTED', comment: 'No cover', employeeName: 'Sara', stepNo: 1, date: '2026-10-01', leaveTypeName: 'Annual' }) },
      { type: 'approval.reminder', data: legacy({ kind: 'digest', total: 3, counts: [{ entityType: 'LEAVE', count: 3 }], digestDate: '2026-09-15' }) },
      { type: 'leave.approved', data: { aggregateType: 'leave_record', aggregateId: REQUEST, userId: USER, employeeId: EMPLOYEE, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-02', decisionNote: 'ok', approvedBy: OTHER } },
      // no longer in the catalogue (review 8-P0-4): the aggregate and the routing facts only
      { type: 'attendance.correction_approved', data: { aggregateType: 'attendance_correction', aggregateId: REQUEST, userId: USER, employeeId: EMPLOYEE, attendanceDate: '2026-09-12', comment: 'fine', decidedBy: OTHER } },
      { type: 'legacy.unknown_type', data: { aggregateType: 'x', aggregateId: REQUEST, date: '2026-09-01', anything: 'goes', nested: { a: 1 } } },
      // not an object at all
      { type: 'device.offline', data: [1, 2, 3] },
      // already within the whitelist (written by the current relay): never touched
      { type: 'device.online', data: { aggregateType: 'device', aggregateId: REQUEST, deviceName: 'Gate', lastSeenAt: '2026-09-15T05:00:00Z' } },
    ];
    // enough rows for more than one keyset batch of 5 000
    const filler = Array.from({ length: 5_050 }, (_, i) => ({ type: 'sync.failed', data: { aggregateType: 'sync_job', aggregateId: REQUEST, jobType: 'PULL_ATTENDANCE', error: `e${i}`, userIds: [OTHER] } }));
    const all = [...rows, ...filler].map((r) => ({ organizationId: ORG, userId: USER, category: 'SYSTEM' as const, type: r.type, title: 't', data: JSON.stringify(r.data) }));
    for (let i = 0; i < all.length; i += 1_000) await a.insertInto('notifications').values(all.slice(i, i + 1_000)).execute();

    await reapply();

    const read = async (type: string) => (await a.selectFrom('notifications').select('data').where('organizationId', '=', ORG).where('type', '=', type).executeTakeFirstOrThrow()).data as Record<string, unknown>;
    expect(await read('approval.decided')).toEqual({ aggregateType: 'approval_request', aggregateId: REQUEST, requestId: REQUEST, entityType: 'LEAVE', entityId: REQUEST, employeeId: EMPLOYEE, decision: 'REJECTED', comment: 'No cover', employeeName: 'Sara', stepNo: 1, date: '2026-10-01', leaveTypeName: 'Annual' });
    expect(await read('approval.reminder')).toEqual({ aggregateType: 'approval_request', aggregateId: REQUEST, requestId: REQUEST, entityType: 'LEAVE', entityId: REQUEST, employeeId: EMPLOYEE, kind: 'digest', total: 3, counts: [{ entityType: 'LEAVE', count: 3 }], digestDate: '2026-09-15' });
    expect(await read('leave.approved')).toEqual({ aggregateType: 'leave_record', aggregateId: REQUEST, employeeId: EMPLOYEE, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-02', decisionNote: 'ok' });
    expect(await read('attendance.correction_approved')).toEqual({ aggregateType: 'attendance_correction', aggregateId: REQUEST, employeeId: EMPLOYEE });
    expect(await read('legacy.unknown_type')).toEqual({ aggregateType: 'x', aggregateId: REQUEST, date: '2026-09-01' });
    expect(await read('device.offline')).toEqual({});
    // nothing outside the whitelist is left anywhere — every filler row of the second batch included
    const leftovers = await sql<{ n: string }>`select count(*) as n from public.notifications n, jsonb_object_keys(n.data) k where n.organization_id = ${ORG}::uuid and k in ('userIds', 'userId', 'requestedBy', 'decidedBy', 'employeeNumber', 'secretNote', 'approvedBy')`.execute(a);
    expect(Number(leftovers.rows[0]!.n)).toBe(0);
    expect(await sql<{ n: string }>`select count(*) as n from public.notifications where organization_id = ${ORG}::uuid and type = 'sync.failed' and data = jsonb_build_object('aggregateType', 'sync_job', 'aggregateId', ${REQUEST}::text, 'jobType', 'PULL_ATTENDANCE', 'error', data ->> 'error')`.execute(a).then((r) => Number(r.rows[0]!.n))).toBe(5_050);

    // idempotent: a second run rewrites no row (the tuple versions stay the same)
    const versions = async () => (await sql<{ id: string; xmin: string }>`select id, xmin::text as xmin from public.notifications where organization_id = ${ORG}::uuid order by id`.execute(a)).rows;
    const before = await versions();
    await reapply();
    expect(await versions()).toEqual(before);
  });

  it('8-P0-5 the scrub keeps what the relay writes: the routing facts for every type, and never a key the catalogue does not declare', () => {
    const list = migrationWhitelist();
    expect(list.base).toEqual(notificationDataKeys('no.such_type'));
    expect(list.base).toEqual(expect.arrayContaining(['aggregateType', 'aggregateId', ...NOTIFICATION_ROUTE_KEYS]));
    // the literal was written from notificationDataKeys(): every key it keeps for a type is one the relay writes for that type
    // (a type or a variable the catalogue gains later has no pre-Prompt-8 rows to keep, so additions do not concern it)
    const catalogued = new Set<string>(NOTIFICATION_TYPES);
    expect(Object.keys(list.types).length).toBeGreaterThan(30);
    for (const [type, keys] of Object.entries(list.types)) {
      if (!catalogued.has(type)) continue;
      expect(notificationDataKeys(type), type).toEqual(expect.arrayContaining([...list.base, ...keys]));
    }
  });
});
