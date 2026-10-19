-- Approval routing settings (organization_settings.approvals) — customer review of the approval inbox, October 2026.
--
-- 1. An `approvals` settings group: who decides leave, comp-off and attendance corrections when no approval workflow
--    applies (the requester's line manager — the new default — or the holders of the approve permission, as before), whether
--    the secondary manager is a backup or decides alongside the primary manager, what happens when neither manager can act
--    (the next manager up the reporting line, or HR), and who decides for somebody at the top of the organisation (HR admins,
--    a named approver, or automatic approval). Shape and defaults: `approvalSettingsSchema` in @flowza/contracts; the API
--    reads it through `resolveApprovalSettings`, so an empty object means the defaults.
-- 2. Its own column, like every other group (the API's putSettingsGroup writes by column name), client-updatable by column
--    grant as every settings group is (20260928001050 §2: a later group needs its own grant; the RLS suite asserts it). The
--    group guard trigger already demands organization.manage for any group other than notifications.
--
-- Additive with a default; no backfill (an empty group resolves to the defaults). Bounded lock wait on a hot table.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.organization_settings
  add column if not exists approvals jsonb not null default '{}'::jsonb check (jsonb_typeof(approvals) = 'object');

grant update (approvals) on public.organization_settings to authenticated;

comment on column public.organization_settings.approvals is 'Approval routing: default routing without a workflow (line manager / permission holders), secondary manager as backup or alongside, fallback when no manager can act, top-of-organisation requests (approvalSettingsSchema in @flowza/contracts).';
