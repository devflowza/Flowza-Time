/**
 * Generates the two reports the video walks through, with the product's own code end to end:
 *   raw punches → NORMALIZE_RAW → RECOMPUTE_DAILY (the attendance engine) → GENERATE_REPORT → Chromium PDF.
 *
 * Demo data: the IT team of the "Majan Gulf" demo tenant (supabase/seeds/demo-tenant), Office Hours 08:00–17:00 with an
 * unpaid lunch hour, the company rule set, Oman holidays, Fri/Sat weekly off, 1 Jan 2025 – 30 Sep 2026.
 *
 * make.sh copies this file to apps/worker/.media-gen/ and runs it there (the worker's packages resolve from that folder):
 *   tsx .media-gen/gen-reports.ts <out-dir>
 * Needs the local Postgres of scripts/local-pg.sh and CHROMIUM_PATH (a Chromium binary) for the PDFs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { createLogger } from '@flowza/shared';
import { createHarness, fakeJob, type TestHarness } from '../src/test/harness.js';
import { normalizeRaw } from '../src/handlers/attendance/normalize.js';
import { recomputeDailyHandler } from '../src/handlers/attendance/recompute.js';
import { applyCorrectionHandler } from '../src/handlers/attendance/corrections.js';
import { generateReportHandler } from '../src/handlers/reports/generate.js';
import { createPdfRenderer } from '../src/lib/pdf.js';
import type { WorkerConfig } from '../src/config.js';

const OUT = process.argv[2] ?? 'out';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
mkdirSync(OUT, { recursive: true });

const ORG = '27bfe270-5dea-4587-aec3-0f5c23113261';
const OWNER = 'a1000000-0000-4000-a000-000000000001';
const BRANCH = 'a1000000-0000-4000-a000-00000000000a';
const DEPT_IT = 'a1000000-0000-4000-a000-0000000000d1';
const CAL = 'a1000000-0000-4000-a000-0000000000c1';
const SHIFT = 'a1000000-0000-4000-a000-0000000000a1';
const RULES = 'a1000000-0000-4000-a000-0000000000f1';
const DEVICE = 'a1000000-0000-4000-a000-0000000000b1';
const LT = { AL: 'a1000000-0000-4000-a000-00000000001a', SL: 'a1000000-0000-4000-a000-00000000001b' };
const MUSCAT = 'Asia/Muscat';
/** "Today" of the video: Tuesday 13 October 2026, 9:42 am in Muscat. */
const NOW = new Date('2026-10-13T05:42:00Z');
const FROM = '2025-01-01';
const TO = '2026-09-30';

const DESIG: Record<string, { id: string; code: string; name: string }> = {
  TL: { id: 'a1000000-0000-4000-a000-0000000000e1', code: 'TL', name: 'Team Lead' },
  SSE: { id: 'a1000000-0000-4000-a000-0000000000e2', code: 'SSE', name: 'Senior Software Engineer' },
  SE: { id: 'a1000000-0000-4000-a000-0000000000e3', code: 'SE', name: 'Software Engineer' },
  ITSE: { id: 'a1000000-0000-4000-a000-0000000000e4', code: 'ITSE', name: 'IT Support Engineer' },
};
// MG-10xx of supabase/seeds/demo-tenant/02_people.sql (number, names, joining date, designation, device PIN, card)
const PEOPLE = [
  { id: 'a1000000-0000-4000-a000-000000001010', num: 'MG-1010', first: 'Arun', last: 'Menon', joined: '2019-02-24', desig: 'TL', pin: '1010', card: '0100000010' },
  { id: 'a1000000-0000-4000-a000-000000001011', num: 'MG-1011', first: 'Salim', last: 'Al Hinai', joined: '2020-08-09', desig: 'SSE', pin: '1011', card: '0100000011' },
  { id: 'a1000000-0000-4000-a000-000000001012', num: 'MG-1012', first: 'Priya', last: 'Sharma', joined: '2022-05-15', desig: 'SE', pin: '1012', card: '0100000012' },
  { id: 'a1000000-0000-4000-a000-000000001013', num: 'MG-1013', first: 'Mohammed', last: 'Al Farsi', joined: '2024-01-07', desig: 'SE', pin: '1013', card: '0100000013' },
  { id: 'a1000000-0000-4000-a000-000000001014', num: 'MG-1014', first: 'Joseph', last: 'Santos', joined: '2021-10-03', desig: 'ITSE', pin: '1014', card: '0100000014' },
] as const;
const ARUN = PEOPLE[0].id;
const SALIM = PEOPLE[1].id;

const HOLIDAYS: Array<[string, string, string?]> = [
  ['New Year\'s Day', '2025-01-01'], ['Isra and Mi\'raj', '2025-01-27'], ['Eid al-Fitr', '2025-03-30', '2025-04-02'], ['Company Foundation Day', '2025-04-15'],
  ['Eid al-Adha', '2025-06-05', '2025-06-09'], ['Islamic New Year', '2025-06-26'], ['Prophet\'s Birthday', '2025-09-04'], ['National Day', '2025-11-20', '2025-11-21'],
  ['New Year\'s Day', '2026-01-01'], ['Accession Day', '2026-01-11'], ['Isra and Mi\'raj', '2026-01-16'], ['Eid al-Fitr', '2026-03-19', '2026-03-23'], ['Company Foundation Day', '2026-04-15'],
  ['Eid al-Adha', '2026-05-26', '2026-05-29'], ['Islamic New Year', '2026-06-16'], ['Prophet\'s Birthday', '2026-08-25'],
];
// approved leave: [employee, type, from, to]
const LEAVE: Array<[string, keyof typeof LT, string, string]> = [
  [PEOPLE[0].id, 'AL', '2025-08-03', '2025-08-14'], [PEOPLE[0].id, 'SL', '2025-11-11', '2025-11-11'], [PEOPLE[0].id, 'AL', '2026-07-05', '2026-07-16'], [PEOPLE[0].id, 'SL', '2026-09-22', '2026-09-22'],
  [PEOPLE[1].id, 'SL', '2025-02-17', '2025-02-17'], [PEOPLE[1].id, 'AL', '2025-07-13', '2025-07-24'], [PEOPLE[1].id, 'AL', '2025-12-28', '2025-12-31'], [PEOPLE[1].id, 'SL', '2025-10-14', '2025-10-15'], [PEOPLE[1].id, 'AL', '2026-03-24', '2026-03-26'],
  [PEOPLE[2].id, 'AL', '2025-12-21', '2025-12-25'], [PEOPLE[2].id, 'SL', '2026-09-21', '2026-09-21'], [PEOPLE[2].id, 'AL', '2025-05-18', '2025-05-22'],
  [PEOPLE[3].id, 'AL', '2025-10-05', '2025-10-09'], [PEOPLE[3].id, 'AL', '2026-09-13', '2026-09-17'],
  [PEOPLE[4].id, 'AL', '2025-04-20', '2025-05-01'], [PEOPLE[4].id, 'SL', '2026-09-28', '2026-09-28'],
];
type Day = 'absent' | { in?: string; out?: string };
/** Days pinned so the pages the video explains show every code and every hours column. */
const PINNED: Record<string, Day> = {
  // Arun, September 2026 (page 1 of the monthly report)
  [`${ARUN}|2026-09-01`]: { in: '07:52', out: '17:06' },
  [`${ARUN}|2026-09-02`]: { in: '08:27', out: '17:12' },   // late
  [`${ARUN}|2026-09-03`]: { in: '07:49', out: '19:18' },   // overtime (OT1)
  [`${ARUN}|2026-09-05`]: { in: '09:04', out: '13:41' },   // Saturday: weekly-off work (OT2)
  [`${ARUN}|2026-09-06`]: { in: '07:55', out: '17:03' },
  [`${ARUN}|2026-09-07`]: { in: '07:58' },                 // missed punch (no OUT)
  [`${ARUN}|2026-09-08`]: { in: '07:47', out: '17:10' },
  [`${ARUN}|2026-09-09`]: { in: '07:56', out: '16:12' },   // left early (UT)
  [`${ARUN}|2026-09-14`]: 'absent',
  // Salim, 2025 (the yearly Detail Report)
  [`${SALIM}|2025-01-02`]: { in: '07:51', out: '17:04' },
  [`${SALIM}|2025-01-05`]: { in: '08:31', out: '17:15' },
  [`${SALIM}|2025-01-06`]: { in: '07:48', out: '18:52' },
  [`${SALIM}|2025-01-09`]: { in: '07:57' },
  [`${SALIM}|2025-01-11`]: { in: '09:10', out: '13:25' },
  [`${SALIM}|2025-01-13`]: { in: '07:54', out: '16:05' },
  [`${SALIM}|2025-01-14`]: { in: '07:55' },                // check-out forgotten — corrected below, with a reason
  [`${SALIM}|2025-01-20`]: 'absent',
};

/** Deterministic PRNG (mulberry32) so every run produces the same demo month. */
function prng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const between = (r: () => number, a: number, b: number) => a + Math.floor(r() * (b - a + 1));

function dayFor(r: () => number, isOff: boolean): Day | null {
  if (isOff) return r() < 0.025 ? { in: hhmm(between(r, 8 * 60 + 50, 9 * 60 + 20)), out: hhmm(between(r, 13 * 60 + 10, 14 * 60 + 30)) } : null;
  const x = r();
  if (x < 0.012) return 'absent';
  const late = r() < 0.07;
  const inAt = late ? between(r, 8 * 60 + 14, 8 * 60 + 46) : between(r, 7 * 60 + 41, 8 * 60 + 8);
  if (x < 0.024) return { in: hhmm(inAt) };
  const y = r();
  const outAt = y < 0.025 ? between(r, 16 * 60 + 5, 16 * 60 + 45) : y < 0.12 ? between(r, 18 * 60 + 5, 19 * 60 + 50) : between(r, 17 * 60, 17 * 60 + 24);
  return { in: hhmm(inAt), out: hhmm(outAt) };
}

const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();
const eachDate = (from: string, to: string) => { const out: string[] = []; for (let d = DateTime.fromISO(from); d.toISODate()! <= to; d = d.plus({ days: 1 })) out.push(d.toISODate()!); return out; };

let h: TestHarness;
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: { ...fakeJob(jobType, payload, ORG), attempts: 1, maxAttempts: 3 }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal });

async function seed() {
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'hradmin@majangulf.om')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER, email: 'hradmin@majangulf.om', fullName: 'Fatma Al Balushi' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'MAJAN', legalName: 'Majan Gulf Trading & Contracting LLC', displayName: 'Majan Gulf', countryCode: 'OM', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG, general: JSON.stringify({ dateFormat: 'DD/MM/YYYY', timeFormat: '12h', firstDayOfWeek: 0 }),
    // work on a weekly off or holiday counts as overtime (OT2) — the organisation setting the engine reads
    attendance: JSON.stringify({ nonWorkingDay: { action: 'overtime' } }), reports: JSON.stringify({ hoursNotation: 'h.mm', codeOverrides: {}, defaultFormat: 'pdf', showLegend: true }) }).execute();
  await a.insertInto('holidayCalendars').values({ id: CAL, organizationId: ORG, name: 'Oman', countryCode: 'OM', isDefault: true }).execute();
  await a.insertInto('holidays').values(HOLIDAYS.flatMap(([name, from, to]) => eachDate(from, to ?? from).map((date) => ({ organizationId: ORG, calendarId: CAL, name, date, type: 'PUBLIC' as const })))).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'MCT-HQ', name: 'Head Office – Muscat', city: 'Muscat', timezone: MUSCAT, holidayCalendarId: CAL }).execute();
  await a.insertInto('departments').values({ id: DEPT_IT, organizationId: ORG, code: 'IT', name: 'Information Technology' }).execute();
  await a.insertInto('designations').values(Object.values(DESIG).map((d) => ({ id: d.id, organizationId: ORG, code: d.code, name: d.name }))).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'OFFICE', name: 'Office Hours 08:00–17:00', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: JSON.stringify([{ start: '13:00', end: '14:00', paid: false }]), punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360 }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT, effectiveFrom: '2018-01-01' }).execute();
  // the demo tenant's "Company standard" rule set (01_structure.sql), without its Ramadan window
  await a.insertInto('attendanceRuleSets').values({
    id: RULES, organizationId: ORG, name: 'Company standard', effectiveFrom: '2018-01-01', graceInMinutes: 10, graceOutMinutes: 5, lateThresholdMinutes: 0, earlyDepartureThresholdMinutes: 0,
    minFullDayMinutes: 420, halfDayThresholdMinutes: 240, overtimeEnabled: true, overtimeStartAfterMinutes: 30, overtimeMinBlockMinutes: 30, overtimeRoundingMinutes: 15, overtimeMaxMinutesPerDay: 240,
    countEarlyInAsOvertime: false, punchInterpretation: 'FIRST_LAST', duplicatePunchWindowSeconds: 60, missingPunchBehavior: 'FLAG_ONLY', autoAbsentWithoutPunches: true,
    weeklyOffWorkCountsAsOvertime: true, holidayWorkCountsAsOvertime: true, ramadanMode: JSON.stringify({}),
  }).execute();
  await a.insertInto('leaveTypes').values([{ id: LT.AL, organizationId: ORG, code: 'AL', name: 'Annual Leave', isPaid: true }, { id: LT.SL, organizationId: ORG, code: 'SL', name: 'Sick Leave', isPaid: true }]).execute();
  await a.insertInto('employees').values(PEOPLE.map((p) => ({
    id: p.id, organizationId: ORG, employeeNumber: p.num, firstName: p.first, lastName: p.last, displayName: `${p.first} ${p.last}`, joiningDate: p.joined, branchId: BRANCH, departmentId: DEPT_IT,
    designationId: DESIG[p.desig]!.id, deviceUserId: p.pin, cardNumber: p.card, customFields: JSON.stringify({}),
  }))).execute();
  await a.insertInto('employmentHistory').values(PEOPLE.map((p) => ({ organizationId: ORG, employeeId: p.id, effectiveFrom: p.joined, branchId: BRANCH, departmentId: DEPT_IT, designationId: DESIG[p.desig]!.id, employmentType: 'full_time' as const, employmentStatus: 'active' as const }))).execute();
  await a.insertInto('leaveRecords').values(LEAVE.map(([employeeId, type, startDate, endDate]) => ({ organizationId: ORG, employeeId, branchId: BRANCH, leaveTypeId: LT[type], startDate, endDate, status: 'APPROVED' as const, approvedBy: OWNER, approvedAt: NOW }))).execute();
  await a.insertInto('devices').values({ id: DEVICE, organizationId: ORG, branchId: BRANCH, code: 'MCT-D01', name: 'HQ Main Entrance', providerKey: 'mock', manufacturer: 'ZKTeco', integrationType: 'VENDOR_CLOUD_PULL', timezone: MUSCAT }).execute();

  // raw punches, as a terminal would deliver them
  const holidays = new Set(HOLIDAYS.flatMap(([, from, to]) => eachDate(from, to ?? from)));
  const onLeave = new Set(LEAVE.flatMap(([e, , from, to]) => eachDate(from, to).map((d) => `${e}|${d}`)));
  const raw: Array<{ deviceUserId: string; punchedAt: Date; direction: 'in' | 'out' }> = [];
  for (const [i, p] of PEOPLE.entries()) {
    const r = prng(1000 + i);
    for (const date of eachDate(FROM, TO)) {
      const dow = DateTime.fromISO(date).weekday; // 5 = Friday, 6 = Saturday
      const pinned = PINNED[`${p.id}|${date}`];
      const day = pinned ?? (onLeave.has(`${p.id}|${date}`) || holidays.has(date) ? null : dayFor(r, dow === 5 || dow === 6));
      if (!day || day === 'absent') continue;
      if (day.in) raw.push({ deviceUserId: p.pin, punchedAt: at(date, day.in), direction: 'in' });
      if (day.out) raw.push({ deviceUserId: p.pin, punchedAt: at(date, day.out), direction: 'out' });
    }
  }
  for (let i = 0; i < raw.length; i += 1000) {
    await a.insertInto('attendanceRawTransactions').values(raw.slice(i, i + 1000).map((x, j) => ({
      organizationId: ORG, deviceId: DEVICE, branchId: BRANCH, providerKey: 'mock', providerTransactionId: `tx-${i + j}`, deviceEmployeeId: x.deviceUserId, punchedAt: x.punchedAt,
      verificationMethod: 'fingerprint', direction: x.direction, rawPayload: JSON.stringify({}), source: 'POLL' as const, dedupeHash: `demo-${i + j}`, processingStatus: 'pending' as const,
    }))).execute();
  }
  console.log(`seeded ${PEOPLE.length} employees, ${raw.length} punches`);
}

async function processAll() {
  for (let n = 0; n < 50; n += 1) {
    const res = await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    if (!res.requeued) break;
  }
  const dates = eachDate(FROM, TO);
  let done = 0;
  for (const p of PEOPLE) {
    for (const date of dates) {
      await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: p.id, date }));
      if (++done % 500 === 0) console.log(`recomputed ${done} / ${PEOPLE.length * dates.length} days`);
    }
  }
  // a forgotten check-out, corrected by HR with a reason (the Detail Report prints it under Remarks)
  const c = await h.tdb.adminDb.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: SALIM, branchId: BRANCH, attendanceDate: '2025-01-14', type: 'ADD_PUNCH', proposedPunchedAt: at('2025-01-14', '17:06'), proposedEventType: 'PUNCH_OUT', reason: 'Forgot to punch out', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
  await applyCorrectionHandler(ctx('APPLY_CORRECTION', { organizationId: ORG, correctionId: c.id, appliedBy: OWNER }));
  await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: SALIM, date: '2025-01-14' }));
  // the queue the normaliser filled is not needed: every day was just computed
  await sql`delete from jobs.queue`.execute(h.tdb.adminDb);
}

async function report(name: string, reportType: string, parameters: Record<string, unknown>) {
  const id = (await h.tdb.adminDb.insertInto('reportRequests').values({ organizationId: ORG, reportType, format: 'pdf', parameters: JSON.stringify(parameters), status: 'QUEUED', requestedBy: OWNER }).returning('id').executeTakeFirstOrThrow()).id;
  const res = await generateReportHandler(ctx('GENERATE_REPORT', { organizationId: ORG, reportRequestId: id }));
  if (res.status !== 'COMPLETED') throw new Error(`${name}: ${JSON.stringify(res)}`);
  const row = await h.tdb.adminDb.selectFrom('reportRequests').select(['filePath', 'rowCount', 'fileSizeBytes']).where('id', '=', id).executeTakeFirstOrThrow();
  writeFileSync(join(OUT, `${name}.pdf`), h.files.get(`reports/${row.filePath}`)!);
  console.log(`${name}: ${row.rowCount} rows, ${row.fileSizeBytes} bytes`);
  return { rowCount: row.rowCount, bytes: Number(row.fileSizeBytes) };
}

h = await createHarness(`flowza_media_reports_${process.pid}`, defaultRegistry(), () => NOW);
try {
  // keep the HTML each PDF is printed from (it is what the video highlights), and print the real PDF with Chromium
  const htmls: string[] = [];
  const chromium = CHROMIUM_PATH ? createPdfRenderer({ CHROMIUM_PATH } as WorkerConfig, createLogger({ name: 'media', level: 'silent' })) : null;
  h.deps.pdf = { async render(html, opts) { htmls.push(html); return chromium ? chromium.render(html, opts) : Buffer.from(html, 'utf8'); } };
  await seed();
  await processAll();
  const facts: Record<string, unknown> = {};
  facts.monthly = await report('monthly-attendance-detailed-2026-09', 'monthly_attendance', { month: '2026-09', layout: 'detailed', departmentId: DEPT_IT });
  writeFileSync(join(OUT, 'monthly-attendance-detailed-2026-09.html'), htmls.at(-1)!);
  facts.yearly = await report('detail-report-2025', 'employee_attendance', { from: '2025-01-01', to: '2025-12-31', employeeIds: [SALIM] });
  writeFileSync(join(OUT, 'detail-report-2025.html'), htmls.at(-1)!);
  // the figures the narration quotes, read back from the computed records
  const rec = (employeeId: string, date: string) => h.tdb.adminDb.selectFrom('attendanceDailyRecords').select(['status', 'flags', 'workedMinutes', 'overtimeMinutes', 'overtimeCategory', 'lateMinutes', 'earlyDepartureMinutes', 'scheduledMinutes']).where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).executeTakeFirst();
  facts.arun = Object.fromEntries(await Promise.all(eachDate('2026-09-01', '2026-09-14').map(async (d) => [d, await rec(ARUN, d)])));
  facts.salim = Object.fromEntries(await Promise.all(eachDate('2025-01-01', '2025-01-31').map(async (d) => [d, await rec(SALIM, d)])));
  writeFileSync(join(OUT, 'facts.json'), JSON.stringify(facts, null, 2));
} finally {
  await h.close();
}
// the PDF renderer keeps its Chromium open for the next job; this is a one-shot run
process.exit(0);
