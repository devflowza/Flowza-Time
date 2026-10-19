-- FlowZa Time · 20261019000300 · Short leave, part 1 of 2: the SHORT_LEAVE approval entity.
--
-- A new enum value cannot be USED in the transaction that adds it (Postgres: "unsafe use of new value"), and the hosted apply
-- wraps each migration file in one transaction. The value therefore gets its own file, committed before
-- 20261019000310_short_leave.sql (like 20260928000690_leave_v2_enum.sql did for INFO_REQUESTED).
--
-- SHORT_LEAVE: an hourly permission, official assignment or remote-work window of one day (`time_off_requests`), routed through
-- the approval engine like leave.
--
-- Additive and idempotent.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter type public.approval_entity add value if not exists 'SHORT_LEAVE';
