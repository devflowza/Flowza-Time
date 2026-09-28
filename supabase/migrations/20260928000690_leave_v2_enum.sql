-- Leave v2 (HR portal Prompt 7), part 1 of 2: the INFO_REQUESTED leave status.
--
-- A new enum value cannot be USED in the transaction that adds it (Postgres: "unsafe use of new value"), and the hosted
-- apply wraps each migration file in one transaction. The value therefore gets its own file, committed before
-- 20260928000700_leave_v2.sql, whose overlap exclusion constraint and self-service policies reference it.
--
-- INFO_REQUESTED: an approver asked the employee for more information (approval engine `requestInfo`); the leave waits
-- for the employee's reply, which puts it back to PENDING. It counts as pending in balances and blocks overlaps.
--
-- Additive and idempotent.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter type public.leave_status add value if not exists 'INFO_REQUESTED';
