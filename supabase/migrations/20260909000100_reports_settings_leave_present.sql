-- Reports engine (docs/reports.md).
--
-- 1. A `reports` settings group: hours notation (h.mm vs hh:mm), per-tenant attendance-code overrides, default format,
--    legend toggle. Added as its own column to match the existing one-column-per-group layout of organization_settings,
--    which the API's putSettingsGroup writes by column name.
-- 2. `leave_types.treat_as_present`: a leave type such as Site Duty is a paid day away from the terminal that the
--    Summary report counts with present days (T/PR), not with leave. Off by default; nothing existing changes.
--
-- Both are additive with defaults; no backfill. Hot-table rule: bounded lock wait so a busy tenant is never blocked.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.organization_settings
  add column if not exists reports jsonb not null default '{}'::jsonb check (jsonb_typeof(reports) = 'object');

alter table public.leave_types
  add column if not exists treat_as_present boolean not null default false;
