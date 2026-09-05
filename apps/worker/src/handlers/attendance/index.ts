import type { HandlerRegistry } from '../types.js';
import { registerNormalizeHandlers } from './normalize.js';
import { registerRecomputeHandlers } from './recompute.js';
import { registerRecalculateHandlers } from './recalculate.js';
import { registerPeriodSummaryHandlers } from './period-summary.js';
import { registerCorrectionHandlers } from './corrections.js';

/**
 * Attendance processing (docs/attendance-engine.md "Worker integration contract"):
 *   NORMALIZE_RAW         raw punches → events (+ debounced recomputes)
 *   RECOMPUTE_DAILY       one (employee, date) through the pure engine → daily record (+ history, domain events)
 *   RECALCULATE_RANGE     explicit recalculation request over a scope × date range
 *   BUILD_PERIOD_SUMMARY  payroll period summaries (+ finalisation under a period lock)
 *   APPLY_CORRECTION      approved correction → void/add events → recompute
 */
export function registerAttendanceHandlers(registry: HandlerRegistry): void {
  registerNormalizeHandlers(registry);
  registerRecomputeHandlers(registry);
  registerRecalculateHandlers(registry);
  registerPeriodSummaryHandlers(registry);
  registerCorrectionHandlers(registry);
}

export { attendanceTasks } from './tasks.js';
export { normalizeRaw, normalizeBatch, eventTypeForDirection, eventSourceForRaw, historyOn, neighbourReach, type NeighbourReach } from './normalize.js';
export { loadDailyInputs, type LoadedDailyInputs } from './load-inputs.js';
export { recomputeDaily, recomputeDailyHandler, isPeriodLocked, type RecomputeOptions, type RecomputeOutcome } from './recompute.js';
export { recalculateRange, enqueueRecalculationForScope, recalculationScopeSchema, type RecalculationScope, type RecalculationSummary } from './recalculate.js';
export { buildPeriodSummaries, buildPeriodSummaryHandler, periodSummaryPayloadSchema, type PeriodSummaryPayload, type PeriodSummaryResult } from './period-summary.js';
export { applyApprovedCorrection, applyCorrectionHandler, applyCorrectionPayloadSchema, type ApplyCorrectionOptions, type ApplyCorrectionResult } from './corrections.js';
export { enqueueRecompute, enqueueNormalizeRaw, recomputeDedupeKey, normalizeDedupeKey, recomputePayloadSchema, IMMEDIATE_RECOMPUTE_REASONS, type RecomputeReason, type EnqueueRecomputeInput } from './common.js';
