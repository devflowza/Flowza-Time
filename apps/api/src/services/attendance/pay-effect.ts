import { resolveAttendanceSettings, type DayMarkSource } from '@flowza/contracts';
import { chargeUnexcusedDay, reverseUnexcusedCharge, type ChargeUnexcusedResult, type ReverseChargeResult, type Trx } from '@flowza/database';
import type { ApiDeps } from '../../deps.js';
import type { Actor } from '../../lib/service.js';
import { loadSettings } from '../../lib/settings.js';
import { systemStep } from '../features/context.js';

/**
 * The pay-effect charger as the API uses it (HR portal Prompt 3): the manager's rejection of a note (Prompt 4) and HR's
 * PAY_EFFECT marks charge an unexcused day through `chargeUnexcusedDay` from `@flowza/database` — the same function the
 * day-close sweep runs — so paid leave is always charged in the tenant's priority order and loss of pay is written the
 * same way whoever decided it. Both helpers run inside a system step of the caller's transaction: the leave row is an
 * APPROVED system decision, which the user-level RLS reserves for `leave.manage` holders, while the caller's own
 * authorization (attendance.approve, team scope, branch scope) is checked by the calling service first.
 */
export { chargeUnexcusedDay, reverseUnexcusedCharge, AUTO_CHARGE_NOTE } from '@flowza/database';
export type { ChargeUnexcusedInput, ChargeUnexcusedResult, ChargeOutcome, ReverseChargeInput, ReverseChargeResult } from '@flowza/database';

export interface ChargeDayInput { employeeId: string; date: string; payEffectDays: number; sourceKind: DayMarkSource; sourceId?: string | null; reason?: string | null; halfDayPart?: 'FIRST_HALF' | 'SECOND_HALF' }

/** Charge a day on behalf of `actor` (already authorised by the caller) with the organisation's unexcused-day policy. */
export async function chargeDayAsSystem(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, input: ChargeDayInput): Promise<ChargeUnexcusedResult> {
  const settings = resolveAttendanceSettings((await loadSettings(trx, orgId)).attendance);
  return systemStep(trx, orgId, (t) => chargeUnexcusedDay(t, deps.queue, { organizationId: orgId, employeeId: input.employeeId, date: input.date, payEffectDays: input.payEffectDays, sourceKind: input.sourceKind, sourceId: input.sourceId ?? null, createdBy: actor.userId, reason: input.reason ?? null, ...(input.halfDayPart ? { halfDayPart: input.halfDayPart } : {}) }, settings.unexcused, { correlationId: actor.requestId }));
}

/** Undo the charge(s) of a day on behalf of `actor` (already authorised by the caller): the internal leave row is cancelled, the PAY_EFFECT / LOP marks revoked. */
export async function reverseChargeAsSystem(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, input: { employeeId: string; date: string; reason: string; sourceId?: string | null }): Promise<ReverseChargeResult> {
  return systemStep(trx, orgId, (t) => reverseUnexcusedCharge(t, deps.queue, { organizationId: orgId, employeeId: input.employeeId, date: input.date, revokedBy: actor.userId, reason: input.reason, sourceId: input.sourceId ?? null }, { correlationId: actor.requestId }));
}
