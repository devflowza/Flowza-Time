import { sql } from 'kysely';
import type { ApprovalEntity, ApprovalNotificationFacts } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { isoDate } from '../attendance/common.js';

const NONE: ApprovalNotificationFacts = { date: null, endDate: null, leaveTypeName: null, leaveTypeNameAr: null };
const day = (v: Date | string | null | undefined): string | null => (v ? isoDate(v) : null);
const text = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * What a notice says about the document behind a request (HR portal Prompt 8, B-102): the day it is about, or a leave's dates
 * and type in both languages (review 8-P2-2 — the recipient's language picks the name) — read straight from each entity's
 * table in the organisation's system context. The relay derives every approval notice's facts from here (review 8-P0-1: never
 * from the event's payload); the reminders and escalations use them too. Entity types without a document table (overtime,
 * missing punch, shift change, manual attendance, overtime claims) carry no facts and render with the entity label and the
 * person only.
 */
export async function approvalEntityFacts(trx: Trx, orgId: string, entityType: ApprovalEntity, entityId: string): Promise<ApprovalNotificationFacts> {
  switch (entityType) {
    case 'LEAVE': {
      const l = await trx.selectFrom('leaveRecords as l').leftJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').select(['l.startDate', 'l.endDate', 't.name as leaveTypeName', 't.nameAr as leaveTypeNameAr'])
        .where('l.organizationId', '=', orgId).where('l.id', '=', entityId).executeTakeFirst();
      return l ? { date: day(l.startDate), endDate: day(l.endDate), leaveTypeName: text(l.leaveTypeName), leaveTypeNameAr: text(l.leaveTypeNameAr) } : NONE;
    }
    case 'ATTENDANCE_CORRECTION': {
      const r = await trx.selectFrom('attendanceCorrections').select('attendanceDate').where('organizationId', '=', orgId).where('id', '=', entityId).executeTakeFirst();
      return { ...NONE, date: day(r?.attendanceDate) };
    }
    case 'ATTENDANCE_NOTE': {
      const r = await trx.selectFrom('attendanceNotes').select('attendanceDate').where('organizationId', '=', orgId).where('id', '=', entityId).executeTakeFirst();
      return { ...NONE, date: day(r?.attendanceDate) };
    }
    case 'REGULARISATION': {
      const r = await trx.selectFrom('attendanceRegularisationRequests').select('attendanceDate').where('organizationId', '=', orgId).where('id', '=', entityId).executeTakeFirst();
      return { ...NONE, date: day(r?.attendanceDate) };
    }
    case 'SHIFT_SWAP': {
      const r = await trx.selectFrom('shiftSwapRequests').select('swapDate').where('organizationId', '=', orgId).where('id', '=', entityId).executeTakeFirst();
      return { ...NONE, date: day(r?.swapDate) };
    }
    case 'COMP_OFF': {
      const r = await trx.selectFrom('compOffCredits').select('workedOn').where('organizationId', '=', orgId).where('id', '=', entityId).executeTakeFirst();
      return { ...NONE, date: day(r?.workedOn) };
    }
    default:
      return NONE;
  }
}

export interface LeaveTypeNames { leaveTypeName: string | null; leaveTypeNameAr: string | null }

/**
 * A leave type's names in both languages (review 8-P2-2), by the leave record a notice is about or by the type's code (a
 * rejected attendance reason charged to a leave balance carries the code only). Null when there is no such leave / type.
 * Organisation system context.
 */
export async function leaveTypeNamesOf(trx: Trx, orgId: string, ref: { leaveRecordId?: string | null; code?: string | null }): Promise<LeaveTypeNames | null> {
  if (ref.leaveRecordId) {
    const t = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').select(['t.name', 't.nameAr'])
      .where('l.organizationId', '=', orgId).where('l.id', '=', ref.leaveRecordId).executeTakeFirst();
    if (t) return { leaveTypeName: text(t.name), leaveTypeNameAr: text(t.nameAr) };
  }
  const code = ref.code?.trim();
  if (code) {
    // the code is unique per organisation, case-insensitively (citext)
    const { rows } = await sql<{ name: string; nameAr: string | null }>`select name, name_ar as "nameAr" from public.leave_types
      where organization_id = ${orgId}::uuid and lower(code::text) = lower(${code}) limit 1`.execute(trx);
    const t = rows[0];
    if (t) return { leaveTypeName: text(t.name), leaveTypeNameAr: text(t.nameAr) };
  }
  return null;
}
