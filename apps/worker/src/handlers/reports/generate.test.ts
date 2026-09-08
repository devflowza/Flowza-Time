import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { exportEmployeesHandler, generateReportHandler } from './generate.js';

const ORG = '0b000000-0000-4000-a000-000000000001';
const OWNER = 'b0000000-0000-4000-a000-000000000001';
const BRANCH = '0b000000-0000-4000-a000-00000000000a';
const BRANCH_B = '0b000000-0000-4000-a000-00000000000b';
const DEPT_ADMIN = '0b000000-0000-4000-a000-0000000000d1';
const DEPT_ELBEIT = '0b000000-0000-4000-a000-0000000000d2';
const DESIG = '0b000000-0000-4000-a000-0000000000c1';
const SHIFT = '0b000000-0000-4000-a000-0000000000a1';
const RULES = '0b000000-0000-4000-a000-0000000000f1';
const LT_AL = '0b000000-0000-4000-a000-00000000001a';
const LT_SD = '0b000000-0000-4000-a000-00000000001b';
const E1 = '0b000000-0000-4000-a000-0000000000e1'; // 2010 ABDUL SATTHAR — admin, one IN only
const E2 = '0b000000-0000-4000-a000-0000000000e2'; // 2076 SALEH — admin, two visits (paired)
const E3 = '0b000000-0000-4000-a000-0000000000e3'; // 2011 FAISAL — El Beit, present full day
const E4 = '0b000000-0000-4000-a000-0000000000e4'; // 2192 Masoom — El Beit, annual leave
const E5 = '0b000000-0000-4000-a000-0000000000e5'; // 2328 — no department, absent, other branch
const E6 = '0b000000-0000-4000-a000-0000000000e6'; // 9001 — terminated, no record
const DATE = '2017-11-01';
const MUSCAT = 'Asia/Muscat';
const NOW = new Date('2018-01-14T07:28:23Z'); // 11:28:23 am Muscat, the sample's generation stamp
const at = (time: string) => DateTime.fromISO(`${DATE}T${time}`, { zone: MUSCAT }).toJSDate();
const punch = (time: string, role: 'IN' | 'OUT' | 'IGNORED') => ({ punchedAt: at(time).toISOString(), role });

let h: TestHarness;
const ctx = (jobType: string, payload: Record<string, unknown>, attempts = 1) => ({ job: { ...fakeJob(jobType, payload, ORG), attempts, maxAttempts: 3 }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const request = async (reportType: string, format: 'csv' | 'xlsx' | 'pdf', parameters: Record<string, unknown>) => (await h.tdb.adminDb.insertInto('reportRequests').values({ organizationId: ORG, reportType, format, parameters: JSON.stringify(parameters), status: 'QUEUED', requestedBy: OWNER }).returning('id').executeTakeFirstOrThrow()).id;
const row = (id: string) => h.tdb.adminDb.selectFrom('reportRequests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const fileText = (path: string) => h.files.get(`reports/${path}`)!.toString('utf8');

beforeAll(async () => {
  h = await createHarness(`flowza_worker_rep_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner@rep.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER, email: 'owner@rep.local', fullName: 'Owner' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'DEMO', legalName: 'Demo Company LLC', displayName: 'DEMO COMPANY', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG, general: JSON.stringify({ timeFormat: '12h', dateFormat: 'MM/DD/YYYY' }) }).execute();
  await a.insertInto('branches').values([{ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'Head Office', timezone: MUSCAT }, { id: BRANCH_B, organizationId: ORG, code: 'B2', name: 'Site', timezone: MUSCAT }]).execute();
  await a.insertInto('departments').values([{ id: DEPT_ADMIN, organizationId: ORG, code: 'ADMIN', name: 'ADMIN' }, { id: DEPT_ELBEIT, organizationId: ORG, code: 'ELBEIT', name: 'EL BEIT' }]).execute();
  await a.insertInto('designations').values({ id: DESIG, organizationId: ORG, code: 'CARP', name: 'Carpenter' }).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'STAFF', name: 'STAFF', type: 'FIXED', startTime: '08:00', endTime: '18:00', breaks: JSON.stringify([{ minutes: 60, paid: false }]) }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT, effectiveFrom: '2017-01-01' }).execute();
  await a.insertInto('attendanceRuleSets').values({ id: RULES, organizationId: ORG, name: 'STAFF POLICY', effectiveFrom: '2017-01-01', ramadanMode: JSON.stringify({}) }).execute();
  await a.insertInto('leaveTypes').values([{ id: LT_AL, organizationId: ORG, code: 'AL', name: 'Annual Leave', isPaid: true }, { id: LT_SD, organizationId: ORG, code: 'SD', name: 'Site Duty', isPaid: true, treatAsPresent: true }]).execute();
  const emp = (id: string, n: string, name: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, employeeNumber: n, firstName: name, lastName: '.', displayName: name, joiningDate: '2010-03-01', branchId: BRANCH, departmentId: DEPT_ADMIN, deviceUserId: n, customFields: JSON.stringify({}), ...extra });
  await a.insertInto('employees').values([
    emp(E1, '2010', 'ABDUL SATTHAR', { cardNumber: '2010' }),
    emp(E2, '2076', 'SALEH AL AGHBARI'),
    emp(E3, '2011', 'FAISAL', { departmentId: DEPT_ELBEIT, designationId: DESIG }),
    emp(E4, '2192', 'Masoom', { departmentId: DEPT_ELBEIT }),
    emp(E5, '2328', 'Chrishantha Rohitha', { departmentId: null, branchId: BRANCH_B }),
    emp(E6, '9001', 'Left Already', { employmentStatus: 'terminated', exitDate: '2017-06-30' }),
  ]).execute();
  await a.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E4, branchId: BRANCH, leaveTypeId: LT_AL, startDate: '2017-10-30', endDate: '2017-11-03', status: 'APPROVED', approvedBy: OWNER, approvedAt: NOW }).execute();
  const rec = (employeeId: string, values: Record<string, unknown>) => ({ organizationId: ORG, employeeId, attendanceDate: DATE, branchId: BRANCH, departmentId: DEPT_ADMIN, timezone: MUSCAT, shiftId: SHIFT, ruleSetId: RULES, scheduledMinutes: 540, engineVersion: 'test', trace: JSON.stringify({ punches: [] }), ...values });
  await a.insertInto('attendanceDailyRecords').values([
    // IN only → one row: 2:49 pm, dashes, base 9.00, UT 9.00
    rec(E1, { status: 'MISSING_PUNCH', flags: ['MISSING_OUT'], firstInAt: at('14:49'), lastOutAt: null, workedMinutes: 0, punchCount: 1, trace: JSON.stringify({ punches: [punch('14:49', 'IN')] }) }),
    // two visits: 5:32 am (in only) then 6:00 am – 9:16 pm → worked 14.15 after a one-hour break, OT1 5.15
    rec(E2, { status: 'PRESENT', flags: ['OVERTIME'], firstInAt: at('05:32'), lastOutAt: at('21:16'), workedMinutes: 855, overtimeMinutes: 315, overtimeCategory: 'REGULAR', punchCount: 3, trace: JSON.stringify({ punches: [punch('05:32', 'IN'), punch('06:00', 'IN'), punch('21:16', 'OUT')] }) }),
    // El Beit present: 8:39 am – 6:09 pm, 9:30 span, 8.30 worked, UT 0.30
    rec(E3, { departmentId: DEPT_ELBEIT, status: 'PRESENT', flags: [], firstInAt: at('08:39'), lastOutAt: at('18:09'), workedMinutes: 510, punchCount: 2, trace: JSON.stringify({ punches: [punch('08:39', 'IN'), punch('18:09', 'OUT')] }) }),
    rec(E4, { departmentId: DEPT_ELBEIT, status: 'LEAVE', flags: [], firstInAt: null, lastOutAt: null, workedMinutes: 0, punchCount: 0 }),
    rec(E5, { departmentId: null, branchId: BRANCH_B, status: 'ABSENT', flags: [], firstInAt: null, lastOutAt: null, workedMinutes: 0, punchCount: 0 }),
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('GENERATE_REPORT · daily_attendance', () => {
  it('renders the Daily Report as CSV with the sample values, grouped by department and sorted naturally', async () => {
    const id = await request('daily_attendance', 'csv', { from: DATE });
    const res = await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
    expect(res.status).toBe('COMPLETED');
    const r = await row(id);
    expect(r.status).toBe('COMPLETED');
    expect(r.filePath).toBe(`${ORG}/${id}.csv`);
    expect(r.rowCount).toBe(6); // E1 one row, E2 two rows, E3, E4, E5
    expect(Number(r.fileSizeBytes)).toBeGreaterThan(100);
    expect(r.expiresAt!.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
    const csv = fileText(r.filePath!);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('Department,Emp ID,Emp Name,Desg,Att Code,IN Time,OUT Time,Wrk Hrs,Tot Hrs,Base Hrs,OT1,OT2,UT');
    // departments alphabetically (ADMIN, EL BEIT, N/A), employees in natural order inside each, hours on the final visit only
    expect(lines.slice(1)).toEqual([
      'ADMIN,2010,ABDUL SATTHAR,,PR,2:49 pm,,,,540,0,0,540',
      'ADMIN,2076,SALEH AL AGHBARI,,PR,5:32 am,,,,,,,',
      'ADMIN,2076,SALEH AL AGHBARI,,PR,6:00 am,9:16 pm,916,855,540,315,0,0',
      'EL BEIT,2011,FAISAL,Carpenter,PR,8:39 am,6:09 pm,570,510,540,0,0,30',
      'EL BEIT,2192,Masoom,,AL,,,,,,,,',
      'N/A,2328,Chrishantha Rohitha,,AB,,,,,,,,',
    ]);
    const ready = await h.tdb.adminDb.selectFrom('domainEvents').selectAll().where('eventType', '=', 'report.ready').execute();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.payload).toMatchObject({ reportId: id, reportType: 'daily_attendance', userId: OWNER, rowCount: 6 });
  });

  it('prints the PDF layout: header, period, department bars, h.mm hours, coloured codes, legend with the tenant leave types', async () => {
    const id = await request('daily_attendance', 'pdf', { from: DATE });
    await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
    const html = fileText(`${ORG}/${id}.pdf`);
    expect(html).toContain('<div class="company">DEMO COMPANY</div>');
    expect(html).toContain('<div class="title">Daily Report</div>');
    expect(html).toContain('Wednesday, 1 November, 2017');
    expect(html).toContain('<span class="label">Dept:</span><span class="value">ADMIN</span>');
    // 15:16 span, 14.15 worked, 9.00 base, 5.15 OT1 — the sample's row for 2076
    expect(html).toMatch(/9:16 pm<\/td><td class="end mono">15:16<\/td><td class="end mono">14\.15<\/td><td class="end mono">9\.00<\/td><td class="end mono">5\.15<\/td><td class="end mono">-<\/td><td class="end mono">-<\/td>/);
    // 2010: single punch → dashes and UT of the whole base
    expect(html).toMatch(/2:49 pm<\/td><td><\/td><td class="end mono">-<\/td><td class="end mono">-<\/td><td class="end mono">9\.00<\/td><td class="end mono">-<\/td><td class="end mono">-<\/td><td class="end mono">9\.00<\/td>/);
    expect(html).toContain('style="color:#15803d;font-weight:700">AL</td>');
    expect(html).toContain('style="color:#b91c1c;font-weight:700">AB</td>');
    expect(html).toContain('NOTE : ATTENDANCE CODE');
    expect(html).toContain('PR - Present</span> ; <span>AB - Absent</span> ; <span>OF - OFF</span> ; <span>HL - Holiday</span> ; <span>AL - Annual Leave</span> ; <span>SD - Site Duty</span>');
    expect(html).toContain('dir="ltr"');
  });

  it('honours the requester\'s injected branch scope and the tenant\'s hh:mm notation in XLSX', async () => {
    await h.tdb.adminDb.updateTable('organizationSettings').set({ reports: JSON.stringify({ hoursNotation: 'hh:mm' }) }).where('organizationId', '=', ORG).execute();
    const id = await request('daily_attendance', 'xlsx', { from: DATE, branchScope: [BRANCH_B] });
    const res = await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
    expect(res).toMatchObject({ status: 'COMPLETED', rowCount: 1 });
    const bytes = h.files.get(`reports/${ORG}/${id}.xlsx`)!;
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // a real zip container
    await h.tdb.adminDb.updateTable('organizationSettings').set({ reports: JSON.stringify({}) }).where('organizationId', '=', ORG).execute();
  });

  it('renders in Arabic when asked: RTL document, localised headings, leave-type names as stored', async () => {
    const id = await request('daily_attendance', 'pdf', { from: DATE, locale: 'ar', departmentId: DEPT_ADMIN });
    await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
    const html = fileText(`${ORG}/${id}.pdf`);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('التقرير اليومي');
    expect(html).toContain('<th>رمز الموظف</th>'.replace('رمز الموظف', 'رقم الموظف'));
    expect(html).not.toContain('EL BEIT');
  });
});

describe('GENERATE_REPORT · failure paths', () => {
  it('fails a request for a type without a generator and tells the requester why', async () => {
    const id = await request('payroll_summary', 'csv', { from: DATE, to: DATE });
    const res = await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
    expect(res.status).toBe('FAILED');
    const r = await row(id);
    expect(r.status).toBe('FAILED');
    expect(r.error).toBe('This report type is not available yet.');
    const failed = await h.tdb.adminDb.selectFrom('domainEvents').selectAll().where('eventType', '=', 'report.failed').execute();
    expect(failed.some((e) => (e.payload as { reportId: string }).reportId === id)).toBe(true);
  });
  it('fails on missing parameters instead of retrying', async () => {
    const id = await request('daily_attendance', 'csv', {});
    expect((await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }))).status).toBe('FAILED');
    expect((await row(id)).error).toBe('Missing report parameters.');
  });
  it('leaves a cancelled request alone', async () => {
    const id = await request('daily_attendance', 'csv', { from: DATE });
    await h.tdb.adminDb.updateTable('reportRequests').set({ status: 'CANCELLED' }).where('id', '=', id).execute();
    expect((await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }))).status).toBe('SKIPPED');
    expect((await row(id)).status).toBe('CANCELLED');
  });
  it('rejects a malformed payload without touching the database', async () => {
    await expect(generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG }))).rejects.toThrow('Invalid job payload.');
  });
});

describe('employee_directory and EXPORT_EMPLOYEES', () => {
  it('lists active employees by department with shift and policy in force today', async () => {
    const id = await request('employee_directory', 'csv', {});
    const res = await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
    expect(res).toMatchObject({ status: 'COMPLETED', rowCount: 5 });
    const lines = fileText(`${ORG}/${id}.csv`).replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('Department,ID,Card No.,Emp Name,Hire Date,Designation,Status,Shift,Policy');
    expect(lines[1]).toBe('ADMIN,2010,2010,ABDUL SATTHAR,03/01/2010,,Active,STAFF,STAFF POLICY');
    expect(lines.some((l) => l.startsWith('N/A,2328'))).toBe(true);
    expect(lines.some((l) => l.includes('9001'))).toBe(false);
  });
  it('lists inactive employees when asked', async () => {
    const id = await request('employee_directory', 'csv', { employmentStatus: 'inactive' });
    expect((await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }))).rowCount).toBe(1);
    expect(fileText(`${ORG}/${id}.csv`)).toContain('9001,,Left Already,03/01/2010,,Inactive');
  });
  it('EXPORT_EMPLOYEES creates its own report request so the file appears under My reports', async () => {
    const res = await exportEmployeesHandler(ctx('EXPORT_EMPLOYEES', { employeeIds: [E1, E3], branchIds: null, format: 'xlsx', requestedBy: OWNER }));
    expect(res.status).toBe('COMPLETED');
    const r = await row(res.reportRequestId);
    expect(r).toMatchObject({ reportType: 'employee_directory', format: 'xlsx', status: 'COMPLETED', requestedBy: OWNER, rowCount: 2 });
    expect(r.parameters).toMatchObject({ employeeIds: [E1, E3], employmentStatus: 'all' });
  });
});
