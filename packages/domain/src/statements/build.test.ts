import { describe, expect, it } from 'vitest';
import { buildStatementSnapshot, signedHours, type StatementBuildInput, type StatementDayRecordInput } from './build.js';

const LT = [
  { code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true },
  { code: 'CO', name: 'Comp Off', nameAr: null, isPaid: true },
];

function rec(date: string, extra: Partial<StatementDayRecordInput> = {}): StatementDayRecordInput {
  return {
    date,
    status: 'PRESENT',
    flags: [],
    firstInAt: `${date}T04:39:00Z`, // 08:39 in Muscat (+04)
    lastOutAt: `${date}T13:45:00Z`, // 17:45
    workedMinutes: 546,
    scheduledMinutes: 540,
    lateMinutes: 0,
    earlyDepartureMinutes: 0,
    overtimeMinutes: 0,
    overtimeCategory: null,
    leave: null,
    ...extra,
  };
}

function input(records: StatementDayRecordInput[], overrides: Partial<StatementBuildInput['employee']> = {}): StatementBuildInput {
  return {
    organization: {
      name: 'Acme Trading LLC',
      timezone: 'Asia/Muscat',
      locale: 'en',
      hoursNotation: 'h.mm',
      timeFormat: '24h',
      datePattern: 'dd/MM/yyyy',
      codeOverrides: {},
    },
    period: { start: '2026-08-01', end: '2026-08-31' },
    employee: {
      id: '00000000-0000-0000-0000-00000000e001',
      displayName: 'Aisha Al Busaidi',
      employeeNumber: '2041',
      branchName: 'Muscat HQ',
      departmentName: 'Finance',
      designationName: 'Accountant',
      joiningDate: '2024-01-01',
      exitDate: null,
      ...overrides,
    },
    records,
    leaveTypes: LT,
    now: new Date('2026-09-03T05:00:00Z'),
  };
}

describe('buildStatementSnapshot', () => {
  it('emits one row per calendar day with sign-in/out clocks in the organisation zone', () => {
    const snap = buildStatementSnapshot(input([rec('2026-08-02'), rec('2026-08-03', { lateMinutes: 24, workedMinutes: 522 })]));
    expect(snap.days).toHaveLength(31);
    const d2 = snap.days.find((d) => d.date === '2026-08-02');
    expect(d2).toMatchObject({ signIn: '08:39', signOut: '17:45', code: 'PR', workedLabel: '9.06', commentable: true });
    // a day the engine has not produced yet is visible as pending, not silently missing
    const d4 = snap.days.find((d) => d.date === '2026-08-04');
    expect(d4).toMatchObject({ status: 'PENDING', signIn: '-', signOut: '-', code: '-', commentable: true });
  });

  it('computes the summary block: required vs worked with signed difference, total delay, leave by type', () => {
    const records = [
      rec('2026-08-02'),
      rec('2026-08-03', { lateMinutes: 24, workedMinutes: 522 }),
      rec('2026-08-04', { status: 'LEAVE', workedMinutes: 0, scheduledMinutes: 540, firstInAt: null, lastOutAt: null, leave: { code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true, treatAsPresent: false } }),
      rec('2026-08-05', { status: 'LEAVE', workedMinutes: 0, scheduledMinutes: 540, firstInAt: null, lastOutAt: null, leave: { code: 'CO', name: 'Comp Off', nameAr: null, isPaid: true, treatAsPresent: false } }),
      rec('2026-08-07', { status: 'WEEKLY_OFF', workedMinutes: 0, scheduledMinutes: 0, firstInAt: null, lastOutAt: null }),
      rec('2026-08-09', { status: 'ABSENT', workedMinutes: 0, firstInAt: null, lastOutAt: null }),
    ];
    const t = buildStatementSnapshot(input(records)).totals;
    expect(t.requiredMinutes).toBe(540 * 5); // five scheduled days (weekly off carries 0)
    expect(t.workedMinutes).toBe(546 + 522);
    expect(t.differenceMinutes).toBe(546 + 522 - 540 * 5);
    expect(t.differenceLabel).toBe('-27.12'); // 1632 - 2700 = -1068 min
    expect(t.delayMinutes).toBe(24);
    expect(t.delayLabel).toBe('0.24');
    expect(t.lateDays).toBe(1);
    expect(t.leaveByType).toEqual([
      { code: 'CO', name: 'Comp Off', nameAr: null, isPaid: true, days: 1 },
      { code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true, days: 1 },
    ]);
    expect(t.presentDays).toBe(2 + 1); // two present + one weekly off
    expect(t.absentDays).toBe(1);
    expect(t.leaveDays).toBe(2);
    expect(t.workingDays).toBe(5);
  });

  it('closes commenting outside the employment window and marks those days NOT_JOINED / EXITED', () => {
    const snap = buildStatementSnapshot(
      input([rec('2026-08-12')], { joiningDate: '2026-08-10', exitDate: '2026-08-20' })
    );
    expect(snap.days.find((d) => d.date === '2026-08-05')).toMatchObject({ status: 'NOT_JOINED', commentable: false });
    expect(snap.days.find((d) => d.date === '2026-08-12')).toMatchObject({ status: 'PRESENT', commentable: true });
    expect(snap.days.find((d) => d.date === '2026-08-25')).toMatchObject({ status: 'EXITED', commentable: false });
  });

  it('validates against the contracts snapshot schema and freezes display strings at build time', async () => {
    const { statementSnapshotSchema } = await import('@flowza/contracts');
    const snap = buildStatementSnapshot(input([rec('2026-08-02')]));
    const parsed = statementSnapshotSchema.safeParse(snap);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect(snap.period.label).toBe('August 2026');
    expect(snap.generatedAt).toBe('2026-09-03T05:00:00.000Z');
  });
});

describe('signedHours', () => {
  it('prefixes the sign and keeps the tenant notation', () => {
    expect(signedHours(135, 'h.mm')).toBe('+2.15');
    expect(signedHours(-270, 'hh:mm')).toBe('-4:30');
    expect(signedHours(0, 'h.mm')).toBe('0.00');
  });
});
