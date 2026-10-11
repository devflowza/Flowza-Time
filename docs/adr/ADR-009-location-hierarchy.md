# ADR-009: The location hierarchy is one tree of customer-named levels, anchored on the existing branches

**Status:** Accepted · **Date:** 2026-10-10

## Problem
Customers describe their estate as a hierarchy with their own words — Headquarters → Branch 1, 2, 3, 5 → Site A, B, C →
Floor → Zone; Region → Store; Site → Building → Floor → Zone. FlowZa Time had a flat list of branches (and a functional
department tree that describes reporting lines, not places). Terminals were tagged `floor-2` as a workaround. About 40
tables, the RLS data scope (`app.allowed_branch_ids()`, 33 policies), the sync engine, payroll and reports key on
`branch_id`.

## Options
1. **Replace branches by a generic location tree** (every `branch_id` becomes a `location_id`). Cleanest end state, but an
   expand → backfill → contract over 40 tables, the security model and the device protocol — months of risk.
2. **Two trees**: groups above branches in one table, places below in another, branches in between. No new rows for
   branches, but every subtree, breadcrumb and move query spans three tables and two path spaces.
3. **One tree whose branch-level nodes reference the branches** (a node per branch, created by trigger; name, code and
   status stay on the branch). Group and place nodes are ordinary rows.

## Decision
Option 3.
- `location_levels`: 1–8 customer-named levels (en/ar), exactly one with role `branch`; roles above = `group`, below =
  `place`. Templates seed common structures (ISO 16739 / IFC facilities, IEC 62264 / ISA-95 plants, retail, healthcare…).
- `locations`: adjacency list + materialised `path` maintained by triggers that derive role, branch and path from the
  level and the parent (never from the client). One subtree query (`path @> array[id]`) serves filters, roll-ups, policy
  resolution and the muster list.
- Branches, their references and the RLS branch scope are untouched; place references (`devices.location_id`,
  `employees.work_location_id`, `geofences.location_id`, coverage targets, policies) use composite foreign keys
  `(location_id, branch_id, organization_id)` so a reference can never point into another branch.

## Consequences
- Additive migration, no data rewrite; organisations without a hierarchy see no change.
- Region-level access is a picker convenience (explicit branches) until dynamic location grants are designed with RLS.
- The word "Branch" in the UI stays fixed for now; the organisation's name for the level appears in the location screens,
  pickers, filters and reports.
