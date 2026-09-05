# ADR-005: Layered, immutable attendance model with versioned recomputation

**Status:** Accepted · **Date:** 2026-09-05

## Problem
Attendance is payroll-sensitive. Final values must be explainable from source data, corrections must not
destroy originals, rules and shifts change over time, and recalculation must be safe.

## Options
1. Single `attendance` table updated in place by triggers.
2. Event-sourced ledger with projections rebuilt on read.
3. **Layered tables**: immutable raw transactions → immutable events (void, never delete) → computed daily
   records with a calculation trace and append-only history → corrections/approvals as first-class
   entities → locked period summaries for payroll.

## Decision
Option 3, with the calculation implemented as a pure function in `packages/domain` (no IO), fed by
effective-dated shift assignments, rule sets, holidays, weekly offs and approved leave.

## Reasons
- Option 1 loses provenance; option 2 makes every read expensive and complicates reporting.
- Layering keeps each concern separately testable; the pure engine is exhaustively unit-tested
  (cross-midnight, late/early/OT, rounding, missing punches, holidays, leave, Ramadan).
- Attendance date attribution via shift punch windows solves overnight shifts deterministically.
- Period locks and versioned summaries give payroll a frozen, disputable artefact.

## Trade-offs
- More tables and a processing step between punch and visible attendance (seconds, not minutes —
  processing is queued per employee/date with debouncing).
- Storage grows (history snapshots); governed by retention policies.
