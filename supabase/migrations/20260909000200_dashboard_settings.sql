-- Tenant-selectable dashboard style (docs/design.md §11).
--
-- A `dashboard` settings group: the colour style of the app shell and dashboard (sidebar, accents, chart palette), the
-- dashboard layout, the trend range and the greeting / quote / highlight toggles an organisation picks under
-- Settings → Dashboard. Its own column, like every other group, because the API's putSettingsGroup writes by column
-- name. Additive with a default; no backfill. Hot-table rule: bounded lock wait so a busy tenant is never blocked.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.organization_settings
  add column if not exists dashboard jsonb not null default '{}'::jsonb check (jsonb_typeof(dashboard) = 'object');
