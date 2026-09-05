import { DateTime } from 'luxon';
import type { PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';

/**
 * Deterministic attendance stream: the same configuration always yields the same sequence of punches, so
 * cursors are replayable and tests are reproducible. Everything here is pure (no clock, no randomness).
 */
export interface MockStreamConfig {
  seed: number;
  employeeCount: number;
  /** Fixed punches per employee per day; 0 = deterministic 2–4 mix. */
  punchesPerDay: number;
  /** First local calendar date of the stream (YYYY-MM-DD). */
  startDate: string;
  timezone: string;
  /** Punches after this instant do not exist yet. */
  now: DateTime;
  /** Inject device user ids that are not in the employee list (~10% of employee-days). */
  unknownEmployees: boolean;
  deviceCode: string;
  scenario: string;
}

/**
 * Upper bound on simulated days. The cap is applied from `startDate` forwards (never by dropping the oldest days):
 * sequence numbers must stay stable for the lifetime of a cursor, so the window may only ever grow at its end.
 */
export const MAX_STREAM_DAYS = 400;

/** 32-bit FNV-1a over the integer parts, followed by a murmur3 finaliser. */
export function hash32(...parts: number[]): number {
  let h = 0x811c9dc5 >>> 0;
  for (const p of parts) {
    let x = Math.trunc(p) >>> 0;
    for (let i = 0; i < 4; i += 1) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      x >>>= 8;
    }
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic number in [0, 1). */
export const unit = (...parts: number[]): number => hash32(...parts) / 0x1_0000_0000;

export const employeeId = (index: number): string => `E${String(index).padStart(3, '0')}`;
export const ghostEmployeeId = (index: number): string => `GHOST-${index}`;

const FIRST_NAMES = ['Ahmed', 'Fatima', 'Salim', 'Maryam', 'Khalid', 'Aisha', 'Yousef', 'Noor', 'Hamad', 'Layla', 'Omar', 'Sara'];
const LAST_NAMES = ['Al Balushi', 'Al Harthi', 'Al Lawati', 'Al Rawahi', 'Al Siyabi', 'Al Zadjali', 'Al Hinai', 'Al Kindi'];
export function employeeName(seed: number, index: number): string {
  const f = FIRST_NAMES[hash32(seed, 7, index) % FIRST_NAMES.length] ?? 'Employee';
  const l = LAST_NAMES[hash32(seed, 8, index) % LAST_NAMES.length] ?? '';
  return `${f} ${l}`.trim();
}

export interface DayPunch {
  employeeIndex: number;
  deviceEmployeeId: string;
  at: DateTime; // UTC
  local: string; // wall clock in the device timezone, no offset
  verificationMethod: VerificationMethod;
  direction: PunchDirection;
}

const SALT = { count: 1, noDirection: 2, ghost: 3, time: 10, method: 30 } as const;
const TEMPLATES: Record<number, PunchDirection[]> = {
  2: ['in', 'out'],
  3: ['in', 'break_out', 'out'],
  4: ['in', 'break_out', 'break_in', 'out'],
};

export function punchesPerEmployee(cfg: MockStreamConfig, day: number, employee: number): number {
  if (cfg.punchesPerDay > 0) return cfg.punchesPerDay;
  return 2 + Math.floor(unit(cfg.seed, SALT.count, day, employee) * 3); // 2..4
}

function baseMinutes(direction: PunchDirection, i: number, k: number): number {
  if (direction === 'in') return 480;
  if (direction === 'out') return 1020;
  if (direction === 'break_out') return 720;
  if (direction === 'break_in') return 760;
  // Generic template for fixed counts > 4: spread evenly across the working day.
  return 480 + Math.round(((1020 - 480) * i) / Math.max(1, k - 1));
}

function jitterMinutes(cfg: MockStreamConfig, day: number, employee: number, i: number, direction: PunchDirection): number {
  const r = unit(cfg.seed, SALT.time + i, day, employee);
  if (direction === 'in') return -20 + r * 60;
  if (direction === 'out') return -10 + r * 70;
  return -10 + r * 30;
}

function methodFor(cfg: MockStreamConfig, day: number, employee: number, i: number): VerificationMethod {
  const r = unit(cfg.seed, SALT.method + i, day, employee);
  if (r < 0.6) return 'fingerprint';
  if (r < 0.85) return 'face';
  return 'card';
}

export function streamDays(cfg: MockStreamConfig): string[] {
  const start = DateTime.fromISO(cfg.startDate, { zone: cfg.timezone }).startOf('day');
  const today = cfg.now.setZone(cfg.timezone).startOf('day');
  if (!start.isValid || !today.isValid || start > today) return [];
  const total = Math.floor(today.diff(start, 'days').days) + 1;
  const count = Math.min(total, MAX_STREAM_DAYS);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(start.plus({ days: i }).toISODate() ?? '');
  return out;
}

/** All punches of one local calendar day, sorted by time (unfiltered by `now`). */
export function dayPunches(cfg: MockStreamConfig, dayIndex: number, date: string): DayPunch[] {
  const midnight = DateTime.fromISO(date, { zone: cfg.timezone }).startOf('day');
  const out: DayPunch[] = [];
  for (let e = 1; e <= cfg.employeeCount; e += 1) {
    const k = punchesPerEmployee(cfg, dayIndex, e);
    const noDirection = unit(cfg.seed, SALT.noDirection, dayIndex, e) < 0.25;
    const ghost = cfg.unknownEmployees && unit(cfg.seed, SALT.ghost, dayIndex, e) < 0.1;
    const template = TEMPLATES[k];
    let previous = 0;
    for (let i = 0; i < k; i += 1) {
      const direction: PunchDirection = template?.[i] ?? 'unknown';
      let minutes = baseMinutes(direction, i, k) + jitterMinutes(cfg, dayIndex, e, i, direction);
      if (minutes <= previous) minutes = previous + 1; // keep strictly increasing per employee
      previous = minutes;
      const local = midnight.plus({ minutes: Math.round(minutes) });
      out.push({
        employeeIndex: e,
        deviceEmployeeId: ghost ? ghostEmployeeId(e) : employeeId(e),
        at: local.toUTC(),
        local: local.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        verificationMethod: methodFor(cfg, dayIndex, e, i),
        direction: noDirection ? 'unknown' : direction,
      });
    }
  }
  out.sort((a, b) => a.at.toMillis() - b.at.toMillis() || a.employeeIndex - b.employeeIndex);
  return out;
}

function dayEnd(cfg: MockStreamConfig, date: string): DateTime {
  return DateTime.fromISO(date, { zone: cfg.timezone }).endOf('day').toUTC();
}

/** Punches of a day that already happened (at <= now). */
function visibleDayPunches(cfg: MockStreamConfig, dayIndex: number, date: string): DayPunch[] {
  const all = dayPunches(cfg, dayIndex, date);
  if (dayEnd(cfg, date) <= cfg.now) return all;
  return all.filter((p) => p.at <= cfg.now);
}

function visibleDayCount(cfg: MockStreamConfig, dayIndex: number, date: string): number {
  if (dayEnd(cfg, date) <= cfg.now) {
    let n = 0;
    for (let e = 1; e <= cfg.employeeCount; e += 1) n += punchesPerEmployee(cfg, dayIndex, e);
    return n;
  }
  return visibleDayPunches(cfg, dayIndex, date).length;
}

export function countStream(cfg: MockStreamConfig): number {
  return streamDays(cfg).reduce((acc, date, i) => acc + visibleDayCount(cfg, i, date), 0);
}

export function toRawTransaction(cfg: MockStreamConfig, punch: DayPunch, seq: number, dayIndex: number): RawTransaction {
  return {
    providerTransactionId: `mock-${cfg.deviceCode}-${seq}`,
    deviceEmployeeId: punch.deviceEmployeeId,
    punchedAt: punch.at.toISO({ suppressMilliseconds: true }) ?? '',
    deviceLocalTime: punch.local,
    verificationMethod: punch.verificationMethod,
    direction: punch.direction,
    rawPayload: { seq, dayIndex, employeeIndex: punch.employeeIndex, scenario: cfg.scenario, simulated: true },
  };
}

/** Items `[from, from + count)` of the stream plus the total number of items that exist right now. */
export function sliceStream(cfg: MockStreamConfig, from: number, count: number): { items: RawTransaction[]; total: number } {
  const days = streamDays(cfg);
  const items: RawTransaction[] = [];
  let offset = 0;
  const to = from + count;
  for (let i = 0; i < days.length; i += 1) {
    const date = days[i] ?? '';
    const n = visibleDayCount(cfg, i, date);
    const dayStart = offset;
    offset += n;
    if (offset <= from || dayStart >= to || n === 0) continue;
    const punches = visibleDayPunches(cfg, i, date);
    const lo = Math.max(from, dayStart);
    const hi = Math.min(to, offset);
    for (let seq = lo; seq < hi; seq += 1) {
      const p = punches[seq - dayStart];
      if (p) items.push(toRawTransaction(cfg, p, seq, i));
    }
  }
  return { items, total: offset };
}

/** Sequence number of the first punch at or after `since` (or the total when none). */
export function seqAtOrAfter(cfg: MockStreamConfig, since: DateTime): number {
  const days = streamDays(cfg);
  let offset = 0;
  for (let i = 0; i < days.length; i += 1) {
    const date = days[i] ?? '';
    const n = visibleDayCount(cfg, i, date);
    if (dayEnd(cfg, date) < since) { offset += n; continue; }
    const punches = visibleDayPunches(cfg, i, date);
    const idx = punches.findIndex((p) => p.at >= since);
    if (idx >= 0) return offset + idx;
    offset += n;
  }
  return offset;
}
