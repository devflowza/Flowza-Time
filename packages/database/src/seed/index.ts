/**
 * Deterministic seed (§93): 1 organisation, 5 branches, 20 departments, 500 employees, 20 devices across vendors,
 * shifts/patterns/rules/holidays/leave, 30 days of raw transactions → events → daily records (via the real engine),
 * sync history with failures, offline devices, corrections, notifications, audit entries.
 * Runs with the admin connection (bypasses RLS on purpose — it is a fixture loader, not application code).
 */
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { calculateDailyRecord, resolveShift, DEFAULT_RETRY_POLICY, type EngineEvent, type EngineShift, type EngineShiftAssignment, type EngineShiftPattern } from '@flowza/domain';
import { DEFAULT_ATTENDANCE_RULES, SYSTEM_ROLE_IDS, type AttendanceRules } from '@flowza/contracts';
import { createDatabase, type Database } from '../client.js';
import { SecretsCipher } from '../secrets.js';
import { Prng } from './prng.js';
import { BRANCHES, DEPARTMENTS, DESIGNATIONS, DEVICES, FIRST_NAMES_F, FIRST_NAMES_M, HOLIDAYS_2026, LAST_NAMES, LEAVE_TYPES, NATIONALITIES, ORG, SEED_PASSWORD, SHIFTS, USERS } from './data.js';

export interface SeedOptions { connectionString: string; days?: number; today?: string; masterKey?: string; log?: (m: string) => void }
export interface SeedSummary { organizations: number; branches: number; departments: number; employees: number; devices: number; rawTransactions: number; events: number; dailyRecords: number; syncJobs: number }

const TZ = ORG.timezone;

export async function runSeed(opts: SeedOptions): Promise<SeedSummary> {
  const log = opts.log ?? (() => {});
  const rng = new Prng(20260905);
  const days = opts.days ?? 30;
  const today = opts.today ?? DateTime.now().setZone(TZ).toISODate()!;
  const { db, pool } = createDatabase({ connectionString: opts.connectionString, max: 4, applicationName: 'flowza-seed', statementTimeoutMs: 600_000 });
  try {
    await sql`select set_config('flowza.bypass_period_lock', 'on', false)`.execute(db);
    await wipe(db);
    const ids = await seedTenant(db, rng);
    const employees = await seedEmployees(db, rng, ids, today);
    const devices = await seedDevices(db, rng, ids, opts.masterKey);
    await seedDeviceEmployeeStates(db, rng, ids, employees, devices);
    const shifts = await seedShifts(db, rng, ids, employees);
    const attendance = await seedAttendance(db, rng, ids, employees, devices, shifts, days, today, log);
    const syncJobs = await seedSyncHistory(db, rng, ids, devices, employees, days, today);
    await seedExtras(db, rng, ids, employees, today);
    return { organizations: 1, branches: BRANCHES.length, departments: DEPARTMENTS.length, employees: employees.length, devices: devices.length, ...attendance, syncJobs };
  } finally {
    await db.destroy();
    await pool.end().catch(() => undefined);
  }
}

async function wipe(db: Database) {
  await sql`delete from public.organizations where id = ${ORG.id}::uuid`.execute(db);
  await sql`delete from public.user_profiles where email like '%@albahja.example'`.execute(db);
  await sql`delete from auth.users where email like '%@albahja.example'`.execute(db);
  await sql`delete from jobs.queue where organization_id = ${ORG.id}::uuid`.execute(db);
  await sql`delete from jobs.queue_archive where organization_id = ${ORG.id}::uuid`.execute(db);
  await sql`delete from audit.logs where organization_id = ${ORG.id}::uuid`.execute(db);
}

interface Ids { branches: Record<string, string>; departments: string[]; designations: string[]; users: Record<string, string>; holidayCalendarId: string; leaveTypes: string[]; ruleSetId: string }

async function seedTenant(db: Database, rng: Prng): Promise<Ids> {
  await db.insertInto('organizations').values({ id: ORG.id, companyCode: ORG.companyCode, legalName: ORG.legalName, displayName: ORG.displayName, countryCode: ORG.country, timezone: TZ, currencyCode: ORG.currency, locale: 'en', weeklyOffDays: [5, 6], status: 'active',
    contact: JSON.stringify({ email: 'info@albahja.example', phone: '+968 2456 7890' }), address: JSON.stringify({ line1: 'Building 12, Al Khuwair', city: 'Muscat', country: 'OM' }) }).execute();
  await db.insertInto('organizationSettings').values({ organizationId: ORG.id, attendance: JSON.stringify({ processingDelaySeconds: 30, payrollPeriod: 'calendar_month' }), sync: JSON.stringify({ defaultIntervalMinutes: 5, adaptivePolling: true, offlineThresholdMinutes: 15 }) }).execute();
  const plan = await db.selectFrom('plans').select('id').where('key', '=', 'business').executeTakeFirstOrThrow();
  await db.insertInto('subscriptions').values({ organizationId: ORG.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: DateTime.now().plus({ years: 1 }).toJSDate() }).execute();
  await db.insertInto('organizationFeatureFlags').values([{ organizationId: ORG.id, flagKey: 'advanced_reports', enabled: true }, { organizationId: ORG.id, flagKey: 'provider_hikvision', enabled: true }, { organizationId: ORG.id, flagKey: 'provider_suprema', enabled: true }]).execute();

  const branches: Record<string, string> = {};
  for (const b of BRANCHES) {
    const id = rng.uuid();
    branches[b.code] = id;
    await db.insertInto('branches').values({ id, organizationId: ORG.id, code: b.code, name: b.name, nameAr: b.nameAr, countryCode: 'OM', city: b.city, timezone: TZ, latitude: String(b.lat), longitude: String(b.lng), geofenceRadiusM: 150, status: 'active', address: JSON.stringify({ city: b.city, country: 'OM' }), contact: JSON.stringify({}) }).execute();
  }
  const departments: string[] = [];
  for (const [i, name] of DEPARTMENTS.entries()) {
    const id = rng.uuid();
    departments.push(id);
    await db.insertInto('departments').values({ id, organizationId: ORG.id, code: `D${String(i + 1).padStart(2, '0')}`, name, status: 'active' }).execute();
  }
  const designations: string[] = [];
  for (const [code, name, level] of DESIGNATIONS) {
    const id = rng.uuid();
    designations.push(id);
    await db.insertInto('designations').values({ id, organizationId: ORG.id, code, name, level, status: 'active' }).execute();
  }
  const holidayCalendarId = rng.uuid();
  await db.insertInto('holidayCalendars').values({ id: holidayCalendarId, organizationId: ORG.id, name: 'Oman Public Holidays', countryCode: 'OM', isDefault: true }).execute();
  await db.updateTable('branches').set({ holidayCalendarId }).where('organizationId', '=', ORG.id).execute();
  for (const h of HOLIDAYS_2026) {
    await db.insertInto('holidays').values({ organizationId: ORG.id, calendarId: holidayCalendarId, name: h.name, date: h.date, endDate: 'end' in h ? h.end : null, type: h.type, isTentative: h.tentative }).execute();
  }
  const leaveTypes: string[] = [];
  for (const [code, name, nameAr, isPaid] of LEAVE_TYPES) {
    const id = rng.uuid();
    leaveTypes.push(id);
    await db.insertInto('leaveTypes').values({ id, organizationId: ORG.id, code, name, nameAr, isPaid, status: 'active' }).execute();
  }
  const ruleSetId = rng.uuid();
  await db.insertInto('attendanceRuleSets').values({ id: ruleSetId, organizationId: ORG.id, name: 'Company default', effectiveFrom: '2025-01-01', graceInMinutes: 10, graceOutMinutes: 5, lateThresholdMinutes: 0, minFullDayMinutes: 420, halfDayThresholdMinutes: 240, overtimeStartAfterMinutes: 30, overtimeMinBlockMinutes: 30, overtimeRoundingMinutes: 15, punchInterpretation: 'FIRST_LAST', missingPunchBehavior: 'FLAG_ONLY' }).execute();

  // users (auth.users directly — local/dev only; hosted projects create users through the Auth admin API)
  const users: Record<string, string> = {};
  for (const u of USERS) {
    const id = rng.uuid();
    users[u.email] = id;
    await sql`insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
      values (${id}::uuid, ${u.email}, extensions.crypt(${SEED_PASSWORD}, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, ${JSON.stringify({ full_name: u.name })}::jsonb)`.execute(db);
    await db.insertInto('userProfiles').values({ id, email: u.email, fullName: u.name, locale: 'en' }).execute();
    const membershipId = rng.uuid();
    await db.insertInto('orgMemberships').values({ id: membershipId, organizationId: ORG.id, userId: id, roleId: SYSTEM_ROLE_IDS[u.role], status: 'active', allBranches: u.allBranches, joinedAt: new Date() }).execute();
    for (const code of u.branches) await db.insertInto('membershipBranches').values({ membershipId, branchId: branches[code]! }).execute();
  }
  return { branches, departments, designations, users, holidayCalendarId, leaveTypes, ruleSetId };
}

export interface SeedEmployee { id: string; number: string; branchCode: string; branchId: string; departmentId: string; deviceUserId: string; joiningDate: string; exitDate: string | null; status: 'active' | 'terminated'; nightShift: boolean; flexible: boolean; security: boolean }

async function seedEmployees(db: Database, rng: Prng, ids: Ids, today: string): Promise<SeedEmployee[]> {
  const total = 500;
  const weights = BRANCHES.map((b) => b.weight);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const rows: SeedEmployee[] = [];
  const securityDept = ids.departments[DEPARTMENTS.indexOf('Security')]!;
  const itDept = ids.departments[DEPARTMENTS.indexOf('Information Technology')]!;
  const warehouseDept = ids.departments[DEPARTMENTS.indexOf('Warehouse')]!;
  let seq = 1;
  for (let i = 0; i < total; i++) {
    let r = rng.next() * wsum; let bi = 0;
    while (r > weights[bi]! && bi < weights.length - 1) { r -= weights[bi]!; bi++; }
    const branch = BRANCHES[bi]!;
    const female = rng.chance(0.3);
    const first = rng.pick(female ? FIRST_NAMES_F : FIRST_NAMES_M);
    const last = rng.pick(LAST_NAMES);
    let n = rng.next(); let nat = 'OM';
    for (const [code, p] of NATIONALITIES) { if (n < p) { nat = code; break; } n -= p; }
    const number = `EMP-${String(10000 + seq++)}`;
    const departmentId = rng.pick(ids.departments);
    const terminated = i >= total - 15;
    const recentJoiner = !terminated && i >= total - 25;
    const joiningDate = recentJoiner ? DateTime.fromISO(today).minus({ days: rng.int(3, 20) }).toISODate()! : DateTime.fromISO(today).minus({ days: rng.int(60, 2400) }).toISODate()!;
    const exitDate = terminated ? DateTime.fromISO(today).minus({ days: rng.int(2, 25) }).toISODate()! : null;
    const emp: SeedEmployee = { id: rng.uuid(), number, branchCode: branch.code, branchId: ids.branches[branch.code]!, departmentId, deviceUserId: String(seq), joiningDate, exitDate, status: terminated ? 'terminated' : 'active', nightShift: departmentId === securityDept ? false : rng.chance(0.06), flexible: departmentId === itDept && rng.chance(0.5), security: departmentId === securityDept };
    if (departmentId === warehouseDept) emp.nightShift = false;
    rows.push(emp);
    const dob = DateTime.fromISO(today).minus({ years: rng.int(22, 58), days: rng.int(0, 364) }).toISODate()!;
    await db.insertInto('employees').values({
      id: emp.id, organizationId: ORG.id, employeeNumber: number, firstName: first, lastName: last, displayName: `${first} ${last}`, gender: female ? 'female' : 'male', dateOfBirth: dob, nationalityCode: nat,
      email: `${first}.${last}`.toLowerCase().replace(/\s+/g, '') + `${seq}@albahja.example`, phone: `+968 9${rng.int(1000000, 9999999)}`, joiningDate, exitDate, employmentStatus: terminated ? 'terminated' : 'active',
      employmentType: rng.chance(0.9) ? 'full_time' : 'contract', branchId: emp.branchId, departmentId, designationId: rng.pick(ids.designations), deviceUserId: emp.deviceUserId, cardNumber: rng.chance(0.7) ? String(rng.int(100000000, 999999999)) : null,
      fingerprintEnrolled: rng.chance(0.85), faceEnrolled: rng.chance(0.6), customFields: JSON.stringify({}),
    }).execute();
    await db.insertInto('employmentHistory').values({ organizationId: ORG.id, employeeId: emp.id, effectiveFrom: joiningDate, effectiveTo: exitDate ? DateTime.fromISO(exitDate).plus({ days: 1 }).toISODate()! : null, branchId: emp.branchId, departmentId, employmentType: 'full_time', employmentStatus: terminated ? 'terminated' : 'active', reason: 'Joined' }).execute();
  }
  // link the self-service user to one active HQ employee
  const selfServiceUser = ids.users['employee@albahja.example']!;
  const target = rows.find((e) => e.branchCode === 'MCT-HQ' && e.status === 'active' && !e.nightShift && !e.flexible)!;
  await db.updateTable('employees').set({ userId: selfServiceUser, displayName: 'Ahmed Al Hinai', firstName: 'Ahmed', lastName: 'Al Hinai' }).where('id', '=', target.id).execute();
  await db.updateTable('orgMemberships').set({ employeeId: target.id }).where('userId', '=', selfServiceUser).execute();
  // managers: first employee per department manages it
  for (const dep of ids.departments) {
    const mgr = rows.find((e) => e.departmentId === dep && e.status === 'active');
    if (mgr) await db.updateTable('departments').set({ managerEmployeeId: mgr.id }).where('id', '=', dep).execute();
  }
  return rows;
}

export interface SeedDevice { id: string; code: string; branchCode: string; branchId: string; provider: string; online: boolean; scenario: string | null }

async function seedDevices(db: Database, rng: Prng, ids: Ids, masterKey?: string): Promise<SeedDevice[]> {
  const providers = new Map((await db.selectFrom('deviceProviders').select(['key', 'integrationType', 'capabilities']).execute()).map((p) => [p.key, p]));
  const cipher = new SecretsCipher([{ id: 'seed', material: Buffer.from(masterKey ?? 'c2VlZC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWRldi1vbmx5ISE=', 'base64') }]);
  const out: SeedDevice[] = [];
  for (const d of DEVICES) {
    const prov = providers.get(d.provider);
    if (!prov) throw new Error(`provider ${d.provider} not seeded`);
    const id = rng.uuid();
    const online = d.provider === 'mock' && d.scenario !== 'offline';
    const placeholder = d.provider !== 'mock';
    out.push({ id, code: d.code, branchCode: d.branch, branchId: ids.branches[d.branch]!, provider: d.provider, online, scenario: d.scenario });
    const lastSeen = online ? DateTime.now().minus({ minutes: rng.int(0, 4) }).toJSDate() : d.scenario === 'offline' ? DateTime.now().minus({ hours: rng.int(3, 40) }).toJSDate() : null;
    await db.insertInto('devices').values({
      id, organizationId: ORG.id, branchId: ids.branches[d.branch]!, code: d.code, name: d.name, providerKey: d.provider, manufacturer: d.manufacturer, modelName: d.model, serialNumber: `${d.manufacturer.slice(0, 3).toUpperCase()}${rng.int(100000000, 999999999)}`,
      timezone: TZ, integrationType: prov.integrationType, config: JSON.stringify(d.scenario ? { scenario: d.scenario, employeeCount: 30, seed: rng.int(1, 9999) } : {}), capabilities: JSON.stringify(prov.capabilities),
      status: 'active', connectionStatus: online ? 'online' : placeholder ? (d.provider === 'zkteco_push' ? 'unknown' : 'error') : 'offline',
      lastHeartbeatAt: lastSeen, lastAttendanceSyncAt: lastSeen, lastEmployeeSyncAt: lastSeen ? DateTime.fromJSDate(lastSeen).minus({ hours: 6 }).toJSDate() : null, lastSuccessfulCommunicationAt: lastSeen,
      lastErrorCode: online ? null : placeholder ? (d.provider === 'zkteco_push' ? null : 'NOT_IMPLEMENTED') : 'DEVICE_OFFLINE',
      lastError: online ? null : placeholder ? (d.provider === 'zkteco_push' ? 'Waiting for the device to contact FlowZa (push protocol)' : 'Provider requires vendor credentials/hardware verification') : 'Connection timed out',
      lastErrorAt: online ? null : new Date(), firmwareVersion: online ? `${rng.int(1, 8)}.${rng.int(0, 9)}.${rng.int(0, 20)}` : null,
      autoSyncEnabled: d.provider === 'mock', syncIntervalMinutes: 5, nextAttendanceSyncAt: online ? DateTime.now().plus({ minutes: rng.int(1, 5)}).toJSDate() : null, tags: [d.manufacturer.toLowerCase(), d.branch.toLowerCase(), 'biometric'],
    }).execute();
    if (d.provider === 'mock') {
      const secretsObj = { apiKey: `mock-${rng.uuid()}` };
      const blob = cipher.encrypt(secretsObj, { organizationId: ORG.id, deviceId: id });
      await db.insertInto('deviceCredentials').values({ deviceId: id, organizationId: ORG.id, keyId: blob.keyId, nonce: blob.nonce, ciphertext: blob.ciphertext, authTag: blob.authTag, masked: JSON.stringify({ apiKey: `****${secretsObj.apiKey.slice(-4)}` }) }).execute();
    }
  }
  const groupId = rng.uuid();
  await db.insertInto('deviceGroups').values({ id: groupId, organizationId: ORG.id, name: 'Entrances', description: 'All main entrance terminals', color: '#1f9873' }).execute();
  await db.insertInto('deviceGroupMembers').values(out.filter((d) => /ENT|GT/.test(d.code)).map((d) => ({ groupId, deviceId: d.id, organizationId: ORG.id }))).execute();
  return out;
}

async function seedDeviceEmployeeStates(db: Database, rng: Prng, ids: Ids, employees: SeedEmployee[], devices: SeedDevice[]) {
  const rows: Array<Record<string, unknown>> = [];
  for (const d of devices) {
    if (d.provider !== 'mock') continue;
    for (const e of employees.filter((x) => x.branchCode === d.branchCode)) {
      const p = rng.next();
      const status = e.status === 'terminated' ? (rng.chance(0.7) ? 'REMOVED' : 'REMOVING') : !d.online ? 'OFFLINE' : p < 0.9 ? 'IN_SYNC' : p < 0.95 ? 'PENDING' : p < 0.98 ? 'FAILED' : 'OUT_OF_SYNC';
      rows.push({ organizationId: ORG.id, deviceId: d.id, employeeId: e.id, branchId: d.branchId, deviceUserId: e.deviceUserId, syncStatus: status, desired: e.status !== 'terminated', cloudHash: 'h1', deviceHash: status === 'IN_SYNC' ? 'h1' : status === 'OUT_OF_SYNC' ? 'h0' : null,
        lastSyncAt: DateTime.now().minus({ hours: rng.int(1, 72) }).toJSDate(), lastSuccessAt: status === 'IN_SYNC' ? DateTime.now().minus({ hours: rng.int(1, 72) }).toJSDate() : null, lastErrorCode: status === 'FAILED' ? 'VENDOR_ERROR' : null, lastError: status === 'FAILED' ? 'Device returned error 0x4F: user storage full' : null,
        fingerprintCount: rng.int(0, 2), faceEnrolled: rng.chance(0.6), cardEnrolled: rng.chance(0.7) });
    }
    // one unknown user on the "unknown_employees" device
    if (d.scenario === 'unknown_employees') rows.push({ organizationId: ORG.id, deviceId: d.id, employeeId: null, branchId: d.branchId, deviceUserId: '9901', syncStatus: 'OUT_OF_SYNC', desired: false, deviceHash: 'x', deviceRecord: JSON.stringify({ name: 'TEMP WORKER' }) });
  }
  for (let i = 0; i < rows.length; i += 500) await db.insertInto('deviceEmployeeStates').values(rows.slice(i, i + 500) as never).execute();
}

interface SeedShifts { shifts: Record<string, EngineShift>; assignments: EngineShiftAssignment[]; patterns: EngineShiftPattern[]; byCode: Record<string, string> }

async function seedShifts(db: Database, rng: Prng, ids: Ids, employees: SeedEmployee[]): Promise<SeedShifts> {
  const shifts: Record<string, EngineShift> = {};
  const byCode: Record<string, string> = {};
  for (const s of SHIFTS) {
    const id = rng.uuid();
    byCode[s.code] = id;
    await db.insertInto('shifts').values({ id, organizationId: ORG.id, code: s.code, name: s.name, nameAr: s.nameAr, type: s.type, startTime: s.start, endTime: s.end, requiredMinutes: 'requiredMinutes' in s ? s.requiredMinutes : null, coreStart: 'coreStart' in s ? s.coreStart : null, coreEnd: 'coreEnd' in s ? s.coreEnd : null, breaks: JSON.stringify(s.breaks), color: s.color, status: 'active' }).execute();
    shifts[id] = { id, code: s.code, name: s.name, type: s.type, startTime: s.start, endTime: s.end, requiredMinutes: 'requiredMinutes' in s ? s.requiredMinutes : null, coreStart: 'coreStart' in s ? s.coreStart : null, coreEnd: 'coreEnd' in s ? s.coreEnd : null, dayBoundary: '04:00', breaks: [...s.breaks] as EngineShift['breaks'], punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, graceInMinutes: null, graceOutMinutes: null };
  }
  const patternId = rng.uuid();
  const sequence = [{ day: 0, shiftId: byCode['MORNING']! }, { day: 1, shiftId: byCode['MORNING']! }, { day: 2, shiftId: byCode['EVENING']! }, { day: 3, shiftId: byCode['EVENING']! }, { day: 4, shiftId: byCode['NIGHT']! }, { day: 5, shiftId: byCode['NIGHT']! }, { day: 6, off: true as const }, { day: 7, off: true as const }];
  await db.insertInto('shiftPatterns').values({ id: patternId, organizationId: ORG.id, code: 'SEC-ROT', name: 'Security rotation (2M-2E-2N-2Off)', cycleLengthDays: 8, sequence: JSON.stringify(sequence), anchorDate: '2026-01-01', status: 'active' }).execute();
  const patterns: EngineShiftPattern[] = [{ id: patternId, cycleLengthDays: 8, anchorDate: '2026-01-01', sequence }];
  const assignments: EngineShiftAssignment[] = [];
  const add = async (a: Omit<EngineShiftAssignment, 'id'>, branchId: string | null) => {
    const id = rng.uuid();
    assignments.push({ id, ...a });
    await db.insertInto('shiftAssignments').values({ id, organizationId: ORG.id, targetType: a.targetType, targetId: a.targetId, branchId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo }).execute();
  };
  await add({ targetType: 'ORGANIZATION', targetId: ORG.id, shiftId: byCode['MORNING']!, shiftPatternId: null, effectiveFrom: '2025-01-01', effectiveTo: null }, null);
  await add({ targetType: 'BRANCH', targetId: ids.branches['SUR']!, shiftId: byCode['EARLY']!, shiftPatternId: null, effectiveFrom: '2025-01-01', effectiveTo: null }, ids.branches['SUR']!);
  await add({ targetType: 'DEPARTMENT', targetId: ids.departments[DEPARTMENTS.indexOf('Warehouse')]!, shiftId: byCode['EARLY']!, shiftPatternId: null, effectiveFrom: '2025-01-01', effectiveTo: null }, null);
  await add({ targetType: 'DEPARTMENT', targetId: ids.departments[DEPARTMENTS.indexOf('Security')]!, shiftId: null, shiftPatternId: patternId, effectiveFrom: '2025-01-01', effectiveTo: null }, null);
  for (const e of employees) {
    if (e.nightShift) await add({ targetType: 'EMPLOYEE', targetId: e.id, shiftId: byCode['NIGHT']!, shiftPatternId: null, effectiveFrom: e.joiningDate, effectiveTo: null }, e.branchId);
    else if (e.flexible) await add({ targetType: 'EMPLOYEE', targetId: e.id, shiftId: byCode['FLEX8']!, shiftPatternId: null, effectiveFrom: e.joiningDate, effectiveTo: null }, e.branchId);
  }
  return { shifts, assignments, patterns, byCode };
}

const VERIFY = ['fingerprint', 'face', 'card'] as const;

async function seedAttendance(db: Database, rng: Prng, ids: Ids, employees: SeedEmployee[], devices: SeedDevice[], shifts: SeedShifts, days: number, today: string, log: (m: string) => void) {
  const rules: AttendanceRules = { ...DEFAULT_ATTENDANCE_RULES, graceInMinutes: 10, graceOutMinutes: 5, overtimeStartAfterMinutes: 30, overtimeMinBlockMinutes: 30, overtimeRoundingMinutes: 15 };
  const holidays = new Map<string, { id: string; name: string; isHalfDay: boolean }>();
  for (const h of await db.selectFrom('holidays').select(['id', 'name', 'date', 'endDate', 'isHalfDay']).where('organizationId', '=', ORG.id).execute()) {
    let d = DateTime.fromISO(String(h.date).slice(0, 10)); const end = h.endDate ? DateTime.fromISO(String(h.endDate).slice(0, 10)) : d;
    while (d <= end) { holidays.set(d.toISODate()!, { id: h.id, name: h.name, isHalfDay: h.isHalfDay }); d = d.plus({ days: 1 }); }
  }
  // a company holiday inside the window so the demo shows HOLIDAY status
  const companyHoliday = DateTime.fromISO(today).minus({ days: 12 }).toISODate()!;
  const chId = rng.uuid();
  await db.insertInto('holidays').values({ id: chId, organizationId: ORG.id, calendarId: ids.holidayCalendarId, name: 'Company Foundation Day', nameAr: 'يوم تأسيس الشركة', date: companyHoliday, type: 'COMPANY' }).execute();
  holidays.set(companyHoliday, { id: chId, name: 'Company Foundation Day', isHalfDay: false });

  // leave: ~40 approved leave records inside the window
  const leaves = new Map<string, { id: string; code: string; isPaid: boolean; isHalfDay: boolean; halfDayPart: 'FIRST_HALF' | 'SECOND_HALF' | null }>();
  const active = employees.filter((e) => e.status === 'active');
  for (let i = 0; i < 40; i++) {
    const e = rng.pick(active);
    const start = DateTime.fromISO(today).minus({ days: rng.int(1, days - 1) });
    const len = rng.chance(0.3) ? 1 : rng.int(2, 5);
    const half = len === 1 && rng.chance(0.3);
    const typeIdx = rng.int(0, 2);
    const id = rng.uuid();
    await db.insertInto('leaveRecords').values({ id, organizationId: ORG.id, employeeId: e.id, branchId: e.branchId, leaveTypeId: ids.leaveTypes[typeIdx]!, startDate: start.toISODate()!, endDate: start.plus({ days: len - 1 }).toISODate()!, isHalfDay: half, halfDayPart: half ? 'SECOND_HALF' : null, status: 'APPROVED', source: 'INTERNAL', approvedBy: ids.users['hr@albahja.example']!, approvedAt: new Date(), reason: 'Seeded leave' }).execute();
    for (let k = 0; k < len; k++) leaves.set(`${e.id}|${start.plus({ days: k }).toISODate()}`, { id, code: LEAVE_TYPES[typeIdx]![0], isPaid: LEAVE_TYPES[typeIdx]![3], isHalfDay: half, halfDayPart: half ? 'SECOND_HALF' : null });
  }

  const branchDevices = new Map<string, SeedDevice[]>();
  for (const d of devices) { if (d.provider !== 'mock') continue; const arr = branchDevices.get(d.branchCode) ?? []; arr.push(d); branchDevices.set(d.branchCode, arr); }
  const secDept = ids.departments[DEPARTMENTS.indexOf('Security')]!;
  const startDate = DateTime.fromISO(today).minus({ days: days - 1 });
  const now = DateTime.now().toUTC();

  let rawCount = 0, eventCount = 0, recordCount = 0, txSeq = 1;
  let rawBatch: Array<Record<string, unknown>> = [];
  let eventBatch: Array<Record<string, unknown>> = [];
  let recordBatch: Array<Record<string, unknown>> = [];
  const flush = async () => {
    for (let i = 0; i < rawBatch.length; i += 1000) await db.insertInto('attendanceRawTransactions').values(rawBatch.slice(i, i + 1000) as never).execute();
    for (let i = 0; i < eventBatch.length; i += 1000) await db.insertInto('attendanceEvents').values(eventBatch.slice(i, i + 1000) as never).execute();
    for (let i = 0; i < recordBatch.length; i += 500) await db.insertInto('attendanceDailyRecords').values(recordBatch.slice(i, i + 500) as never).execute();
    rawBatch = []; eventBatch = []; recordBatch = [];
  };

  for (const [ei, e] of employees.entries()) {
    const devs = branchDevices.get(e.branchCode) ?? [];
    const scope = { employeeId: e.id, teamIds: [] as string[], departmentId: e.departmentId, branchId: e.branchId, organizationId: ORG.id };
    // deterministic per-employee behaviour profile
    const profile = { lateProne: rng.chance(0.15), otProne: rng.chance(0.2), absentProne: rng.chance(0.05) };
    for (let d = 0; d < days; d++) {
      const date = startDate.plus({ days: d }).toISODate()!;
      const res = resolveShift(shifts.assignments, shifts.patterns, scope, date);
      const shift = res.shiftId ? shifts.shifts[res.shiftId] ?? null : null;
      const dow = DateTime.fromISO(date).weekday % 7;
      const weeklyOff = res.isPatternOff || (e.departmentId !== secDept && [5, 6].includes(dow));
      const holiday = holidays.get(date) ?? null;
      const leave = leaves.get(`${e.id}|${date}`) ?? null;
      const events: EngineEvent[] = [];
      const employed = date >= e.joiningDate && (!e.exitDate || date <= e.exitDate);
      const working = employed && !weeklyOff && !holiday && (!leave || leave.isHalfDay) && shift;
      if (working && devs.length > 0 && !(profile.absentProne && rng.chance(0.3)) && !rng.chance(0.02)) {
        const dev = rng.pick(devs);
        const startLocal = shift.type === 'FIXED' ? DateTime.fromISO(`${date}T${shift.startTime}`, { zone: TZ }) : DateTime.fromISO(`${date}T09:00`, { zone: TZ });
        let endLocal = shift.type === 'FIXED' ? DateTime.fromISO(`${date}T${shift.endTime}`, { zone: TZ }) : startLocal.plus({ minutes: (shift.requiredMinutes ?? 480) + 45 });
        if (endLocal <= startLocal) endLocal = endLocal.plus({ days: 1 });
        const late = profile.lateProne ? (rng.chance(0.5) ? rng.int(5, 45) : rng.int(-10, 8)) : rng.chance(0.08) ? rng.int(11, 40) : rng.int(-15, 8);
        const inAt = startLocal.plus({ minutes: late });
        const ot = profile.otProne && rng.chance(0.5) ? rng.int(35, 150) : rng.chance(0.06) ? rng.int(35, 90) : 0;
        const early = !ot && rng.chance(0.05) ? rng.int(10, 40) : 0;
        const outAt = endLocal.plus({ minutes: ot - early + rng.int(-3, 6) });
        const missingOut = rng.chance(0.02);
        const punches: DateTime[] = [inAt];
        if (leave?.isHalfDay) punches.push(startLocal.plus({ hours: 4, minutes: rng.int(0, 10) })); else if (!missingOut) punches.push(outAt);
        // occasional extra mid-day punches (lunch)
        if (!leave && !missingOut && rng.chance(0.25) && shift.type === 'FIXED') { punches.push(startLocal.plus({ hours: 5, minutes: rng.int(0, 15) })); punches.push(startLocal.plus({ hours: 6, minutes: rng.int(0, 15) })); }
        for (const p of punches.sort((a, b) => a.toMillis() - b.toMillis())) {
          if (p.toUTC() > now) continue;
          const utc = p.toUTC();
          const method = rng.pick(VERIFY);
          const txId = `mock-${dev.code}-${txSeq++}`;
          const rawId = rawCount + 1; // identity values start at 1 in a wiped-per-org partition set? we cannot rely on it; use returned ids instead
          void rawId;
          const dedupe = createHash('sha256').update(`${dev.id}|${e.deviceUserId}|${utc.toISO()}|${method}|unknown`).digest('hex');
          rawBatch.push({ organizationId: ORG.id, deviceId: dev.id, branchId: e.branchId, providerKey: 'mock', providerTransactionId: txId, deviceEmployeeId: e.deviceUserId, employeeId: e.id, punchedAt: utc.toJSDate(), deviceLocalTime: p.toFormat('yyyy-MM-dd HH:mm:ss'), verificationMethod: method, direction: 'unknown', rawPayload: JSON.stringify({ pin: e.deviceUserId, time: p.toFormat('yyyy-MM-dd HH:mm:ss'), verify: method }), receivedAt: utc.plus({ minutes: rng.int(1, 6) }).toJSDate(), source: 'POLL', dedupeHash: dedupe, processingStatus: 'normalized', processedAt: utc.plus({ minutes: 6 }).toJSDate() });
          rawCount++;
          const evId = rng.uuid();
          eventBatch.push({ id: evId, organizationId: ORG.id, employeeId: e.id, branchId: e.branchId, deviceId: dev.id, source: 'DEVICE', eventType: 'PUNCH', punchedAt: utc.toJSDate(), verificationMethod: method });
          eventCount++;
          events.push({ id: evId, punchedAt: utc.toISO()!, eventType: 'PUNCH', source: 'DEVICE', verificationMethod: method, deviceId: dev.id, voided: false });
        }
      }
      if (!employed && date < e.joiningDate && d < days - 1 && !recentEnough(date, e.joiningDate)) continue; // skip long-before-joining days to keep volume sane
      const result = calculateDailyRecord({
        employeeId: e.id, attendanceDate: date, timezone: TZ, shift, rules, ruleSetId: ids.ruleSetId, shiftAssignmentId: res.assignment?.id ?? null,
        weeklyOffDays: e.departmentId === secDept ? [] : [5, 6], holiday: holiday ? { id: holiday.id, name: holiday.name, isHalfDay: holiday.isHalfDay } : null,
        leave: leave ? { id: leave.id, leaveTypeCode: leave.code, isPaid: leave.isPaid, isHalfDay: leave.isHalfDay, halfDayPart: leave.halfDayPart } : null,
        events, employment: { joiningDate: e.joiningDate, exitDate: e.exitDate, status: e.status }, now: now.toISO()!,
      });
      recordBatch.push({ organizationId: ORG.id, employeeId: e.id, attendanceDate: date, branchId: e.branchId, departmentId: e.departmentId, shiftId: result.shiftId, shiftAssignmentId: result.shiftAssignmentId, ruleSetId: ids.ruleSetId, timezone: TZ,
        expectedStartAt: result.expectedStartAt ? new Date(result.expectedStartAt) : null, expectedEndAt: result.expectedEndAt ? new Date(result.expectedEndAt) : null, scheduledMinutes: result.scheduledMinutes,
        firstInAt: result.firstInAt ? new Date(result.firstInAt) : null, lastOutAt: result.lastOutAt ? new Date(result.lastOutAt) : null, workedMinutes: result.workedMinutes, breakMinutes: result.breakMinutes, lateMinutes: result.lateMinutes,
        earlyDepartureMinutes: result.earlyDepartureMinutes, overtimeMinutes: result.overtimeMinutes, overtimeCategory: result.overtimeCategory, status: result.status, flags: result.flags, punchCount: result.punchCount, calculationVersion: 1, engineVersion: result.trace.engineVersion, trace: JSON.stringify(result.trace), computedAt: new Date() });
      recordCount++;
    }
    if (rawBatch.length > 4000 || recordBatch.length > 2000) { await flush(); log(`attendance: ${ei + 1}/${employees.length} employees`); }
  }
  await flush();
  // link events to raw transactions (raw ids are assigned by identity; match by dedupe hash)
  await sql`update public.attendance_events e set raw_transaction_id = r.id from public.attendance_raw_transactions r
    where e.organization_id = ${ORG.id}::uuid and r.organization_id = e.organization_id and r.employee_id = e.employee_id and r.device_id = e.device_id and r.punched_at = e.punched_at and e.raw_transaction_id is null`.execute(db);
  return { rawTransactions: rawCount, events: eventCount, dailyRecords: recordCount };
}

function recentEnough(date: string, joining: string): boolean { return DateTime.fromISO(joining).diff(DateTime.fromISO(date), 'days').days <= 7; }

async function seedSyncHistory(db: Database, rng: Prng, ids: Ids, devices: SeedDevice[], employees: SeedEmployee[], days: number, today: string): Promise<number> {
  const mockDevices = devices.filter((d) => d.provider === 'mock');
  let count = 0;
  const start = DateTime.fromISO(today).minus({ days: days - 1 });
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < 2; k++) {
      const at = start.plus({ days: d, hours: 6 + k * 9, minutes: rng.int(0, 50) }).toUTC();
      if (at > DateTime.now().toUTC()) continue;
      const jobId = rng.uuid();
      const items = mockDevices.map((dev) => {
        const failed = !dev.online || (dev.scenario === 'flaky' && rng.chance(0.4));
        return { dev, status: !dev.online ? 'OFFLINE' : failed ? 'FAILED' : 'SUCCESS', records: failed ? 0 : rng.int(5, 120) };
      });
      const failedN = items.filter((i) => i.status === 'FAILED').length; const offlineN = items.filter((i) => i.status === 'OFFLINE').length;
      await db.insertInto('syncJobs').values({ id: jobId, organizationId: ORG.id, jobType: 'PULL_ATTENDANCE', trigger: 'SCHEDULED', scope: JSON.stringify({ all: true }), status: failedN + offlineN === 0 ? 'SUCCESS' : failedN + offlineN === items.length ? 'FAILED' : 'PARTIAL_SUCCESS', priority: 3,
        itemsTotal: items.length, itemsSuccess: items.length - failedN - offlineN, itemsFailed: failedN, itemsOffline: offlineN, recordsIngested: items.reduce((a, i) => a + i.records, 0), correlationId: `seed_${jobId.slice(0, 8)}`, queuedAt: at.toJSDate(), startedAt: at.plus({ seconds: 2 }).toJSDate(), finishedAt: at.plus({ seconds: rng.int(20, 240) }).toJSDate(), createdAt: at.toJSDate() }).execute();
      for (const it of items) {
        const itemId = rng.uuid();
        await db.insertInto('syncJobItems').values({ id: itemId, organizationId: ORG.id, syncJobId: jobId, deviceId: it.dev.id, branchId: it.dev.branchId, operation: 'PULL_ATTENDANCE', status: it.status as never, attempts: it.status === 'SUCCESS' ? 1 : 3, recordsIngested: it.records,
          lastErrorCode: it.status === 'FAILED' ? 'VENDOR_ERROR' : it.status === 'OFFLINE' ? 'DEVICE_OFFLINE' : null, lastError: it.status === 'FAILED' ? 'Vendor API returned HTTP 502' : it.status === 'OFFLINE' ? 'Connection timed out after 30s' : null,
          startedAt: at.plus({ seconds: 3 }).toJSDate(), finishedAt: at.plus({ seconds: rng.int(5, 200) }).toJSDate(), createdAt: at.toJSDate() }).execute();
        await db.insertInto('syncAttempts').values({ organizationId: ORG.id, syncJobItemId: itemId, attemptNo: 1, status: it.status === 'SUCCESS' ? 'SUCCESS' : 'RETRYING', errorCode: it.status === 'SUCCESS' ? null : it.status === 'OFFLINE' ? 'DEVICE_OFFLINE' : 'VENDOR_ERROR', durationMs: rng.int(300, 9000), workerId: 'seed-worker', startedAt: at.toJSDate(), finishedAt: at.plus({ seconds: 5 }).toJSDate() }).execute();
      }
      count++;
    }
  }
  // cursors
  for (const dev of mockDevices) await db.insertInto('syncCursors').values({ organizationId: ORG.id, deviceId: dev.id, stream: 'attendance', cursor: JSON.stringify({ lastSeq: rng.int(1000, 90000) }), lastTransactionAt: new Date(), lastPulledAt: new Date() }).execute();
  // one employee push job with mixed results (the §33 example)
  const emp = employees.find((e) => e.branchCode === 'MCT-HQ' && e.status === 'active')!;
  const jobId = rng.uuid();
  const hq = devices.filter((d) => d.branchCode === 'MCT-HQ');
  const statuses = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILED', 'SUCCESS', 'SUCCESS', 'UNSUPPORTED', 'UNSUPPORTED'];
  await db.insertInto('syncJobs').values({ id: jobId, organizationId: ORG.id, jobType: 'PUSH_EMPLOYEE', trigger: 'MANUAL', scope: JSON.stringify({ employeeIds: [emp.id] }), branchId: emp.branchId, status: 'PARTIAL_SUCCESS', priority: 7, itemsTotal: hq.length, itemsSuccess: statuses.filter((s) => s === 'SUCCESS').length, itemsFailed: 1, itemsUnsupported: 2, requestedBy: ids.users['hr@albahja.example']!, correlationId: `seed_push_${jobId.slice(0, 8)}`, queuedAt: new Date(), startedAt: new Date(), finishedAt: new Date() }).execute();
  for (const [i, dev] of hq.entries()) {
    const st = statuses[i] ?? 'SUCCESS';
    await db.insertInto('syncJobItems').values({ organizationId: ORG.id, syncJobId: jobId, deviceId: dev.id, branchId: dev.branchId, employeeId: emp.id, operation: 'PUSH_EMPLOYEE', status: st as never, attempts: st === 'FAILED' ? 6 : 1, maxAttempts: 6, lastErrorCode: st === 'FAILED' ? 'VENDOR_ERROR' : st === 'UNSUPPORTED' ? 'NOT_IMPLEMENTED' : null, lastError: st === 'FAILED' ? 'Device rejected user: fingerprint template capacity exceeded' : st === 'UNSUPPORTED' ? 'Provider requires vendor credentials/hardware verification' : null, startedAt: new Date(), finishedAt: new Date() }).execute();
  }
  // a dead-lettered queue job for visibility
  await sql`insert into jobs.queue_archive (id, queue_name, job_type, organization_id, payload, priority, status, run_at, attempts, max_attempts, lock_timeout_seconds, last_error_code, last_error, created_at, completed_at)
    values (900001, 'sync', 'PULL_ATTENDANCE', ${ORG.id}::uuid, ${JSON.stringify({ deviceId: mockDevices.find((d) => !d.online)?.id })}::jsonb, 5, 'dead', now() - interval '1 day', 6, 6, 600, 'DEVICE_OFFLINE', 'Connection timed out after 30s', now() - interval '1 day', now() - interval '20 hours') on conflict (id) do nothing`.execute(db);
  return count + 1;
}

async function seedExtras(db: Database, rng: Prng, ids: Ids, employees: SeedEmployee[], today: string) {
  const hr = ids.users['hr@albahja.example']!; const owner = ids.users['owner@albahja.example']!; const bm = ids.users['sohar.manager@albahja.example']!;
  // approval workflow + corrections
  const wfId = rng.uuid();
  await db.insertInto('approvalWorkflows').values({ id: wfId, organizationId: ORG.id, entityType: 'ATTENDANCE_CORRECTION', name: 'Manager → HR', steps: JSON.stringify([{ order: 1, approver_type: 'MANAGER' }, { order: 2, approver_type: 'ROLE', role_id: SYSTEM_ROLE_IDS.hr_admin }]), isDefault: true, status: 'active' }).execute();
  const candidates = employees.filter((e) => e.status === 'active').slice(0, 15);
  for (const [i, e] of candidates.entries()) {
    const date = DateTime.fromISO(today).minus({ days: rng.int(1, 10) }).toISODate()!;
    const status = i < 6 ? 'PENDING' : i < 12 ? 'APPROVED' : 'REJECTED';
    const reqId = rng.uuid();
    await db.insertInto('approvalRequests').values({ id: reqId, organizationId: ORG.id, workflowId: wfId, entityType: 'ATTENDANCE_CORRECTION', entityId: rng.uuid(), branchId: e.branchId, employeeId: e.id, currentStep: status === 'PENDING' ? 1 : 2, status: status === 'PENDING' ? 'PENDING' : status === 'APPROVED' ? 'APPROVED' : 'REJECTED', requestedBy: hr, completedAt: status === 'PENDING' ? null : new Date() }).execute();
    await db.insertInto('approvalSteps').values([{ organizationId: ORG.id, requestId: reqId, stepNo: 1, approverType: 'USER', approverUserId: e.branchCode === 'SOH' ? bm : owner, status: status === 'PENDING' ? 'PENDING' : status === 'REJECTED' ? 'REJECTED' : 'APPROVED', actedBy: status === 'PENDING' ? null : owner, actedAt: status === 'PENDING' ? null : new Date(), comment: status === 'REJECTED' ? 'No supporting evidence' : null }, { organizationId: ORG.id, requestId: reqId, stepNo: 2, approverType: 'ROLE', approverRoleId: SYSTEM_ROLE_IDS.hr_admin, status: status === 'APPROVED' ? 'APPROVED' : 'PENDING', actedBy: status === 'APPROVED' ? hr : null, actedAt: status === 'APPROVED' ? new Date() : null }]).execute();
    await db.insertInto('attendanceCorrections').values({ organizationId: ORG.id, employeeId: e.id, branchId: e.branchId, attendanceDate: date, type: 'ADD_PUNCH', proposedPunchedAt: DateTime.fromISO(`${date}T17:05`, { zone: TZ }).toUTC().toJSDate(), proposedEventType: 'PUNCH_OUT', reason: 'Forgot to punch out — left at 17:05 (confirmed by supervisor)', requestedBy: hr, status: status as never, approvalRequestId: reqId, rejectionReason: status === 'REJECTED' ? 'No supporting evidence' : null }).execute();
  }
  // notifications for the owner + hr
  const notif = [
    { userId: owner, category: 'DEVICE', type: 'device.offline', title: 'Device offline: Sohar Warehouse (SOH-WH-01)', body: 'No heartbeat for 3 hours.', link: '/devices' },
    { userId: owner, category: 'ATTENDANCE', type: 'sync.failed', title: 'Attendance sync failed for HQ 5th Floor', body: 'Vendor API returned HTTP 502 (attempt 3/6).', link: '/sync' },
    { userId: hr, category: 'APPROVAL', type: 'approval.pending', title: '6 corrections awaiting approval', body: 'Corrections submitted in the last 10 days.', link: '/approvals' },
    { userId: hr, category: 'SYSTEM', type: 'report.ready', title: 'Monthly attendance report is ready', body: 'Generated for last month, 500 employees.', link: '/reports' },
  ];
  await db.insertInto('notifications').values(notif.map((n) => ({ organizationId: ORG.id, ...n, data: JSON.stringify({}) }) as never)).execute();
  // audit trail samples
  await db.insertInto('audit.logs').values([
    { organizationId: ORG.id, actorUserId: owner, actorType: 'USER', action: 'organization.created', entityType: 'organization', entityId: ORG.id, newValue: JSON.stringify({ displayName: ORG.displayName }) },
    { organizationId: ORG.id, actorUserId: hr, actorType: 'USER', action: 'employee.imported', entityType: 'import_job', entityId: rng.uuid(), newValue: JSON.stringify({ rows: employees.length, imported: employees.length }) },
    { organizationId: ORG.id, actorUserId: ids.users['devices@albahja.example']!, actorType: 'USER', action: 'device.credentials_changed', entityType: 'device', entityId: rng.uuid(), reason: 'Initial registration' },
  ]).execute();
  // retention policies (disabled = keep forever by default)
  await db.insertInto('dataRetentionPolicies').values([{ organizationId: ORG.id, dataClass: 'raw_transactions', retentionDays: 1095, enabled: false }, { organizationId: ORG.id, dataClass: 'device_logs', retentionDays: 90, enabled: true }, { organizationId: ORG.id, dataClass: 'sync_logs', retentionDays: 90, enabled: true }]).execute();
  void DEFAULT_RETRY_POLICY;
}
