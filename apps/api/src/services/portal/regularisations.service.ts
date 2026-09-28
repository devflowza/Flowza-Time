import type { ApprovalRequestStatus, RegularisationDto, RegularisationStatus, SelfRegularisationInput } from '@flowza/contracts';
import { effectiveBranchOn, type Trx } from '@flowza/database';
import { addDays, AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { cancelForEntity, submit } from '../approvals/engine.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';
import { attendancePolicy, isPeriodLocked, isWorking, loadEmployeeCtx, localDate, localInstant, lockEmployee, portalSelf } from './common.js';
import { seatSecondaryManager } from './line-manager.js';
import { loadRegularisation, REGULARISATION_COLUMNS, type RegularisationRow } from './regularisation-effects.js';

/**
 * Regularisation requests (HR portal Prompt 4): "my day is wrong, please fix it" — a missed punch, a wrong punch, work from
 * home that was not marked, a system downtime. Filed by the employee (attendance.note or attendance.request_correction),
 * routed by the approval engine (REGULARISATION workflow, else the line manager with the secondary standing in), applied on
 * approval THROUGH attendance corrections (regularisation-effects.ts). One open request per day; the employee may withdraw
 * a pending one. The organisation turns the feature off with Settings → Attendance → self-service → "Regularisation
 * requests" (`selfService.regularisation`, on by default — review P2-9), independently of direct self-service corrections.
 */

const REG_KEYS = ['attendance.note', 'attendance.request_correction'] as const;

async function toDtos(trx: Trx, orgId: string, rows: RegularisationRow[]): Promise<RegularisationDto[]> {
  if (rows.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const reqs = requestIds.length ? await t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : [];
    const counts = requestIds.length ? await t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', requestIds).groupBy('requestId').execute() : [];
    const userIds = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => !!x))];
    const users = userIds.length ? await t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : [];
    const reqOf = new Map(reqs.map((r) => [r.id, r])); const nameOf = new Map(users.map((u) => [u.id, u.fullName || u.email]));
    return rows.map((r): RegularisationDto => {
      const req = r.approvalRequestId ? reqOf.get(r.approvalRequestId) : undefined;
      return {
        id: r.id, employeeId: r.employeeId, attendanceDate: isoDate(r.attendanceDate), type: r.type, proposedInAt: isoDateTimeOrNull(r.proposedInAt), proposedOutAt: isoDateTimeOrNull(r.proposedOutAt), reason: r.reason,
        status: r.status, approvalRequestId: r.approvalRequestId, approvalStatus: req ? (req.status as ApprovalRequestStatus) : null, approvalCurrentStep: req?.currentStep ?? null,
        approvalStepCount: req ? Number(counts.find((c) => c.requestId === req.id)?.n ?? 0) : null, appliedCorrectionId: r.appliedCorrectionId, appliedAt: isoDateTimeOrNull(r.appliedAt),
        decidedByName: r.decidedBy ? nameOf.get(r.decidedBy) ?? null : null, decidedAt: isoDateTimeOrNull(r.decidedAt), decisionNote: r.decisionNote, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
      };
    });
  });
}

export async function listMyRegularisations(deps: ApiDeps, actor: Actor, orgId: string, q: { from?: string | undefined; to?: string | undefined; status?: RegularisationStatus | undefined }): Promise<RegularisationDto[]> {
  const self = portalSelf(actor, orgId, ...REG_KEYS, 'attendance.view_own');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceRegularisationRequests').select(REGULARISATION_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId);
    if (q.from) base = base.where('attendanceDate', '>=', dv(q.from));
    if (q.to) base = base.where('attendanceDate', '<=', dv(q.to));
    if (q.status) base = base.where('status', '=', q.status);
    return toDtos(trx, orgId, (await base.orderBy('attendanceDate', 'desc').orderBy('createdAt', 'desc').limit(500).execute()) as RegularisationRow[]);
  });
}

export async function submitRegularisation(deps: ApiDeps, actor: Actor, orgId: string, input: SelfRegularisationInput): Promise<RegularisationDto> {
  const self = portalSelf(actor, orgId, ...REG_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployee(trx, 'regularisation', self.employeeId);
    if (!(await attendancePolicy(trx, orgId)).selfService.regularisation) throw new AppError('FORBIDDEN', 'Regularisation requests are turned off for this organisation.', { details: { reason: 'REGULARISATION_DISABLED' } });
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const now = new Date();
    const today = localInstant(now, emp.timezone).date;
    if (!isWorking(emp, today)) throw errors.forbidden('Your employment is not active.');
    if (input.date > today) throw errors.validation('A day can be regularised once it has started.', { issues: [{ path: 'date', message: 'Future date' }] });
    if (input.date < emp.joiningDate) throw errors.validation('This date is before your joining date.', { issues: [{ path: 'date', message: 'Before joining date' }] });
    // proposed times belong to the day (a night shift may reach into the next / previous calendar day) and are not in the future
    for (const [key, value] of [['proposedInAt', input.proposedInAt], ['proposedOutAt', input.proposedOutAt]] as const) {
      if (!value) continue;
      const at = new Date(value);
      if (at.getTime() > now.getTime() + 5 * 60_000) throw errors.validation('A proposed time cannot be in the future.', { issues: [{ path: key, message: 'In the future' }] });
      const d = localDate(at, emp.timezone);
      if (d < addDays(input.date, -1) || d > addDays(input.date, 1)) throw errors.validation('The proposed time must fall on (or next to) the regularised day.', { issues: [{ path: key, message: 'Outside the day' }] });
    }
    const branchId = (await withSystemScope(trx, orgId, (t) => effectiveBranchOn(t, orgId, emp.id, input.date))) ?? emp.branchId;
    if (await isPeriodLocked(trx, orgId, branchId, input.date)) throw errors.periodLocked('The attendance period of this date is locked.');
    const open = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceRegularisationRequests').select('id').where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('attendanceDate', '=', dv(input.date)).where('status', '=', 'pending').executeTakeFirst());
    if (open) throw errors.conflict('A regularisation for this day is already waiting for a decision.', { regularisationId: open.id });
    const row = await systemStep(trx, orgId, (t) => t.insertInto('attendanceRegularisationRequests').values({
      organizationId: orgId, employeeId: emp.id, branchId, attendanceDate: input.date, type: input.type, proposedInAt: input.proposedInAt ? new Date(input.proposedInAt) : null, proposedOutAt: input.proposedOutAt ? new Date(input.proposedOutAt) : null,
      reason: input.reason, status: 'pending', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow());
    const submitted = await submit(deps, trx, actor, orgId, { entityType: 'REGULARISATION', entityId: row.id, employeeId: emp.id, branchId, departmentId: emp.departmentId, units: null, requestedBy: actor.userId, noWorkflow: { kind: 'MANAGER' } });
    await systemStep(trx, orgId, async (t) => {
      await seatSecondaryManager(t, actor, orgId, { requestId: submitted.requestId, entityType: 'REGULARISATION', entityId: row.id, employeeId: emp.id, secondaryManagerEmployeeId: emp.secondaryManagerEmployeeId, employeeName: emp.displayName });
      await t.updateTable('attendanceRegularisationRequests').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute();
    });
    await audit(trx, actor, orgId, 'attendance.regularisation_submitted', 'attendance_regularisation', { entityId: row.id, branchId, newValue: input });
    return (await toDtos(trx, orgId, [(await withSystemScope(trx, orgId, (t) => loadRegularisation(t, orgId, row.id)))!]))[0]!;
  });
}

export async function cancelMyRegularisation(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason?: string): Promise<RegularisationDto> {
  const self = portalSelf(actor, orgId, ...REG_KEYS);
  const why = reason && reason.trim().length >= 3 ? reason.trim() : 'Withdrawn by the employee';
  return runUser(deps.db, actor, async (trx) => {
    const before = await withSystemScope(trx, orgId, (t) => loadRegularisation(t, orgId, id));
    if (!before || before.employeeId !== self.employeeId) throw errors.notFound('Regularisation', id);
    if (before.status !== 'pending') throw errors.invalidState(`Only a pending regularisation can be withdrawn (current: ${before.status}).`);
    await systemStep(trx, orgId, async (t) => {
      const res = await t.updateTable('attendanceRegularisationRequests').set({ status: 'cancelled', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: why }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The regularisation changed meanwhile. Please refresh.');
      await cancelForEntity(deps, t, actor, orgId, 'REGULARISATION', id, why, { source: 'self_service' });
    });
    await audit(trx, actor, orgId, 'attendance.regularisation_withdrawn', 'attendance_regularisation', { entityId: id, branchId: before.branchId, reason: why });
    return (await toDtos(trx, orgId, [(await withSystemScope(trx, orgId, (t) => loadRegularisation(t, orgId, id)))!]))[0]!;
  });
}
