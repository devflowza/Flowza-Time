-- FlowZa Time · 20261015000100 · Approval entity TIME_AWAY and record-history reason TIME_AWAY (docs/time-away.md). Neither
-- value is used in this file: `alter type … add value` must not be used in the transaction that adds it.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

alter type public.approval_entity add value if not exists 'TIME_AWAY';
-- a time-away decision recomputes the day it concerns (attendance_daily_record_history.reason)
alter type public.record_history_reason add value if not exists 'TIME_AWAY';
