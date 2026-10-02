import type { HandlerRegistry } from '../types.js';
import { registerNormalizeHandlers } from './normalize.js';
import { registerRecomputeHandlers } from './recompute.js';
import { registerRecalculateHandlers } from './recalculate.js';
import { registerPeriodSummaryHandlers } from './period-summary.js';
import { registerCorrectionHandlers } from './corrections.js';
import { registerDayCloseHandlers } from './day-close.js';
import { registerMaterializeHandlers } from './materialize.js';

/**
 * Attendance processing (docs/attendance-engine.md "Worker integration contract"):
 *   NORMALIZE_RAW         raw punches → events (+ throttled recomputes)
 *   RECOMPUTE_DAILY       one (employee, date) through the pure engine → daily record (+ history, domain events)
 *   RECALCULATE_RANGE     explicit recalculation request over a scope × date range
 *   BUILD_PERIOD_SUMMARY  payroll period summaries (+ finalisation under a period lock)
 *   APPLY_CORRECTION      approved correction → void/add events → recompute
 *   ATTENDANCE_DAY_CLOSE  day-close sweep: unexplained days past the grace period → UNEXCUSED marks (+ optional pay effect)
 *   ATTENDANCE_MATERIALIZE_DAYS  every employee-day of the last days (up to yesterday) gets a record; stale PENDING days are judged
 */
export function registerAttendanceHandlers(registry: HandlerRegistry): void {
  registerNormalizeHandlers(registry);
  registerRecomputeHandlers(registry);
  registerRecalculateHandlers(registry);
  registerPeriodSummaryHandlers(registry);
  registerCorrectionHandlers(registry);
  registerDayCloseHandlers(registry);
  registerMaterializeHandlers(registry);
}

export { attendanceTasks } from './tasks.js';
export { normalizeRaw, normalizeBatch, eventTypeForDirection, eventSourceForRaw, historyOn, neighbourReach, type NeighbourReach } from './normalize.js';
export { loadDailyInputs, type LoadedDailyInputs } from './load-inputs.js';
export { recomputeDaily, recomputeDailyHandler, isPeriodLocked, type RecomputeOptions, type RecomputeOutcome } from './recompute.js';
export { recalculateRange, enqueueRecalculationForScope, recalculationScopeSchema, type RecalculationScope, type RecalculationSummary } from './recalculate.js';
export { buildPeriodSummaries, buildPeriodSummaryHandler, periodSummaryPayloadSchema, type PeriodSummaryPayload, type PeriodSummaryResult } from './period-summary.js';
export { applyApprovedCorrection, applyCorrectionHandler, applyCorrectionPayloadSchema, type ApplyCorrectionOptions, type ApplyCorrectionResult } from './corrections.js';
export { materializeHandler, materializePayloadSchema, materializeDedupeKey, pairsToMaterialize, MATERIALIZE_JOB_TYPE, MATERIALIZE_LOOKBACK_DAYS, MATERIALIZE_MAX_PAIRS, type MaterializePayload, type MaterializeSummary } from './materialize.js';
export { runDayClose, dayCloseHandler, dayClosePayloadSchema, dayCloseDedupeKey, dayCloseRecipients, assessDay, DAY_CLOSE_JOB_TYPE, DAY_CLOSE_MAX_DAYS, DAY_CLOSE_LOOKBACK_DAYS, type DayClosePayload, type DayCloseSummary } from './day-close.js';
export { enqueueRecompute, enqueueNormalizeRaw, recomputeDedupeKey, normalizeDedupeKey, recomputePayloadSchema, IMMEDIATE_RECOMPUTE_REASONS, loadAttendanceSettings, type RecomputeReason, type EnqueueRecomputeInput } from './common.js';
