import type { ApprovalEntity, ApprovalNotificationFacts } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { isoDate } from '../attendance/common.js';

const NONE: ApprovalNotificationFacts = { date: null, endDate: null, leaveTypeName: null };
const day = (v: Date | string | null | undefined): string | null => (v ? isoDate(v) : null);

/**
 * What a reminder / escalation / digest says about the document behind a request (HR portal Prompt 8, B-102): the day it is
 * about, or a leave's dates and type — the same facts the API derives from the inbox context (`approvalContextFacts` in
 * @flowza/contracts), read here straight from each entity's table in the organisation's system context. Entity types
 * without a document table (overtime, missing punch, shift change, manual attendance, overtime claims) carry no facts and
 * render with the entity label and the person only.
 */
export async function approvalEntityFacts(trx: Trx, orgId: string, entityType: ApprovalEntity, entityId: string): Promise<ApprovalNotificationFacts> {
  switch (entityType) {
    case 'LEAVE': {
      const l = await trx.selectFrom('leaveRecords as l').leftJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').select(['l.startDate', 'l.endDate', 't.name as leaveTypeName'])
        .where('l.organizationId', '=', orgId).where('l.id', '=', entityId).executeTakeFirst();
      return l ? { date: day(l.startDate), endDate: day(l.endDate), leaveTypeName: l.leaveTypeName ?? null } : NONE;
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
