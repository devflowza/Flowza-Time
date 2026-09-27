import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { sha256Hex } from '@flowza/shared';
import { statementSnapshotSchema } from '@flowza/contracts';
import { defaultRegistry } from '@flowza/device-providers';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { issueMonthlyStatements, sendStatementEmail } from './issue.js';
import { sweepMonthlyStatements } from './tasks.js';

const ORG = '0c000000-0000-4000-a000-000000000001';
const ORG_OFF = '0c000000-0000-4000-a000-000000000002';
const OWNER = 'c0000000-0000-4000-a000-000000000001';
const BRANCH = '0c000000-0000-4000-a000-00000000000a';
const SHIFT = '0c000000-0000-4000-a000-0000000000a1';
const RULES = '0c000000-0000-4000-a000-0000000000f1';
const LT_SL = '0c000000-0000-4000-a000-00000000001a';
const E1 = '0c000000-0000-4000-a000-0000000000e1'; // present + late + sick leave; has email
const E2 = '0c000000-0000-4000-a000-0000000000e2'; // present; no email
const E3 = '0c000000-0000-4000-a000-0000000000e3'; // no records at all
const MONTH = '2017-11';
const MUSCAT = 'Asia/Muscat';
const NOW = new Date('2017-12-03T06:00:00Z');
const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();

let h: TestHarness;
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: { ...fakeJob(jobType, payload, ORG) }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal });

beforeAll(async () => {
  h = await createHarness(`flowza_worker_stmt_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner@stmt.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER, email: 'owner@stmt.local', fullName: 'Owner' }).execute();
  await a.insertInto('organizations').values([
    { id: ORG, companyCode: 'STMT', legalName: 'Statement Co LLC', displayName: 'Statement Co', timezone: MUSCAT, weeklyOffDays: [5, 6] },
    { id: ORG_OFF, companyCode: 'OFF', legalName: 'Disabled Co', displayName: 'Disabled Co', timezone: MUSCAT },
  ]).execute();
  await a.insertInto('organizationSettings').values([
    { organizationId: ORG, general: JSON.stringify({ timeFormat: '24h', dateFormat: 'DD/MM/YYYY' }), reports: JSON.stringify({ hoursNotation: 'h.mm', monthlyStatements: { enabled: true, sendDay: 3 } }) },
    { organizationId: ORG_OFF, reports: JSON.stringify({ monthlyStatements: { enabled: false } }) },
  ]).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'Head Office', timezone: MUSCAT }).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'STD', name: 'Standard', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: JSON.stringify([]) }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT, effectiveFrom: '2017-01-01' }).execute();
  await a.insertInto('attendanceRuleSets').values({ id: RULES, organizationId: ORG, name: 'POLICY', effectiveFrom: '2017-01-01', ramadanMode: JSON.stringify({}) }).execute();
  await a.insertInto('leaveTypes').values({ id: LT_SL, organizationId: ORG, code: 'SL', name: 'Sick Leave', isPaid: true }).execute();
  const emp = (id: string, n: string, name: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, employeeNumber: n, firstName: name, lastName: '.', displayName: name, joiningDate: '2015-01-01', branchId: BRANCH, deviceUserId: n, customFields: JSON.stringify({}), ...extra });
  await a.insertInto('employees').values([
    emp(E1, '1001', 'Aisha', { email: 'aisha@stmt.local' }),
    emp(E2, '1002', 'Bilal'),
    emp(E3, '1003', 'NoRecords', { email: 'norec@stmt.local' }),
  ]).execute();
  await a.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH, leaveTypeId: LT_SL, startDate: '2017-11-07', endDate: '2017-11-07', status: 'APPROVED', approvedBy: OWNER, approvedAt: NOW }).execute();
  const rec = (employeeId: string, date: string, values: Record<string, unknown>) => ({ organizationId: ORG, employeeId, attendanceDate: date, branchId: BRANCH, timezone: MUSCAT, shiftId: SHIFT, ruleSetId: RULES, scheduledMinutes: 540, engineVersion: 'test', trace: JSON.stringify({ punches: [] }), ...values });
  await a.insertInto('attendanceDailyRecords').values([
    rec(E1, '2017-11-01', { status: 'PRESENT', firstInAt: at('2017-11-01', '08:00'), lastOutAt: at('2017-11-01', '17:00'), workedMinutes: 540, punchCount: 2 }),
    rec(E1, '2017-11-02', { status: 'PRESENT', flags: ['LATE'], firstInAt: at('2017-11-02', '08:24'), lastOutAt: at('2017-11-02', '17:00'), workedMinutes: 516, lateMinutes: 24, punchCount: 2 }),
    rec(E1, '2017-11-07', { status: 'LEAVE', firstInAt: null, lastOutAt: null, workedMinutes: 0, punchCount: 0 }),
    rec(E2, '2017-11-01', { status: 'PRESENT', firstInAt: at('2017-11-01', '07:58'), lastOutAt: at('2017-11-01', '17:05'), workedMinutes: 547, punchCount: 2 }),
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('ISSUE_MONTHLY_STATEMENTS', () => {
  it('creates one statement per employee with records, emails the review link, and skips the rest', async () => {
    const res = await issueMonthlyStatements(ctx('ISSUE_MONTHLY_STATEMENTS', { organizationId: ORG, month: MONTH, requestedBy: OWNER }));
    expect(res).toMatchObject({ month: MONTH, created: 2, skippedExisting: 0, skippedNoRecords: 1, emailed: 1, emailFailed: 0, noEmail: 1 });
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.to).toBe('aisha@stmt.local');
    expect(h.emails[0]!.subject).toContain('November 2017');

    const rows = await h.tdb.adminDb.selectFrom('attendanceStatements').selectAll().where('organizationId', '=', ORG).orderBy('createdAt').execute();
    expect(rows).toHaveLength(2);
    const aisha = rows.find((r) => r.employeeId === E1)!;
    expect(aisha.status).toBe('ISSUED');
    expect(aisha.emailSentAt).not.toBeNull();
    expect(aisha.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const snap = statementSnapshotSchema.parse(aisha.snapshot);
    expect(snap.days).toHaveLength(30);
    expect(snap.days.find((d) => d.date === '2017-11-02')).toMatchObject({ signIn: '08:24', signOut: '17:00', lateMinutes: 24 });
    expect(snap.days.find((d) => d.date === '2017-11-07')).toMatchObject({ code: 'SL' });
    expect(snap.totals).toMatchObject({ requiredMinutes: 1620, workedMinutes: 1056, delayMinutes: 24, lateDays: 1 });
    expect(snap.totals.leaveByType).toEqual([{ code: 'SL', name: 'Sick Leave', nameAr: null, isPaid: true, days: 1 }]);

    const bilal = rows.find((r) => r.employeeId === E2)!;
    expect(bilal.emailError).toBe('NO_EMAIL');
    expect(bilal.emailSentAt).toBeNull();
  });

  it('is idempotent per employee: a re-run skips live statements and sends nothing new', async () => {
    const res = await issueMonthlyStatements(ctx('ISSUE_MONTHLY_STATEMENTS', { organizationId: ORG, month: MONTH }));
    expect(res).toMatchObject({ created: 0, skippedExisting: 2, emailed: 0 });
    expect(h.emails).toHaveLength(1);
  });

  it('SEND_STATEMENT_EMAIL rotates the token and re-emails; the old link dies with the old hash', async () => {
    const before = await h.tdb.adminDb.selectFrom('attendanceStatements').select(['id', 'tokenHash']).where('employeeId', '=', E1).executeTakeFirstOrThrow();
    const res = await sendStatementEmail(ctx('SEND_STATEMENT_EMAIL', { organizationId: ORG, statementId: before.id }));
    expect(res.sent).toBe(true);
    const after = await h.tdb.adminDb.selectFrom('attendanceStatements').select(['tokenHash', 'emailAttempts']).where('id', '=', before.id).executeTakeFirstOrThrow();
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(after.emailAttempts).toBe(2);
    expect(h.emails).toHaveLength(2);
    const link = /token=([^\s"&]+)/; // the email carries `<org>.<secret>`; its sha256 must be the stored hash
    void link;
  });

  it('the emailed token hashes to the stored token_hash (and only the hash is stored)', async () => {
    // send once more through a capturing mailer to inspect the link
    let captured = '';
    const mailer = h.deps.mailer;
    h.deps.mailer = { async send(msg) { captured = msg.html; return { id: 'x', provider: 'test' }; } };
    const row = await h.tdb.adminDb.selectFrom('attendanceStatements').select(['id']).where('employeeId', '=', E1).executeTakeFirstOrThrow();
    await sendStatementEmail(ctx('SEND_STATEMENT_EMAIL', { organizationId: ORG, statementId: row.id }));
    h.deps.mailer = mailer;
    const m = /token=([A-Za-z0-9.%_-]+)/.exec(captured);
    expect(m).not.toBeNull();
    const token = decodeURIComponent(m![1]!);
    const [orgPart, secret] = [token.slice(0, token.indexOf('.')), token.slice(token.indexOf('.') + 1)];
    expect(orgPart).toBe(ORG);
    const stored = await h.tdb.adminDb.selectFrom('attendanceStatements').select('tokenHash').where('id', '=', row.id).executeTakeFirstOrThrow();
    expect(stored.tokenHash).toBe(sha256Hex(secret));
  });
});

describe('statements-monthly-sweep', () => {
  it('enqueues the previous month for enabled organisations past their local send day, with a per-month dedupe key', async () => {
    const res = await sweepMonthlyStatements(h.deps); // NOW = 3 Dec Muscat, sendDay 3
    expect(res).toMatchObject({ organizations: 1, enqueued: 1 });
    const job = await h.tdb.adminDb.selectFrom('jobs.queue' as never).selectAll().where('jobType' as never, '=', 'ISSUE_MONTHLY_STATEMENTS' as never).executeTakeFirst() as { payload: { month: string }; dedupeKey: string } | undefined;
    expect(job).toBeDefined();
    expect(job!.payload).toMatchObject({ organizationId: ORG, month: '2017-11' });
    expect(job!.dedupeKey).toBe(`statements:${ORG}:2017-11`);
  });
});
