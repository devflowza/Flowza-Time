-- FlowZa Time · 20261001000200 · A new shift's attendance day starts at 12:00 AM.
--
-- shifts.day_boundary (the local time at which a FLEXIBLE shift's attendance day starts) defaulted to 04:00; the contract
-- default (packages/contracts DEFAULT_SHIFT_DAY_BOUNDARY) and the engine fallback (packages/domain DEFAULT_DAY_BOUNDARY) are now
-- 00:00, a plain calendar day. Only the column default changes: every stored shift keeps the boundary it has, so no attendance
-- day moves and nothing is recalculated.
--
-- Idempotent, one transaction. Metadata-only (no row rewritten).

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

alter table public.shifts alter column day_boundary set default '00:00';
comment on column public.shifts.day_boundary is
  'FLEXIBLE: local time at which a new attendance day starts (a punch before it counts for the previous day). Default 00:00 (12:00 AM).';
