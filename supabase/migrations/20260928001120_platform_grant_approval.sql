-- FlowZa Time · 20260928001120 · Security & quality gate — a write access grant starts only when its second approver
-- approves it (HR portal Prompt 10; docs/hr-portal/reports/10-security-gate.md).
--
-- Finding (P2): a platform administrator could give themselves WRITE access to any tenant by naming another active
-- administrator as `approvedBy` — the "second approver" never approved anything; the name was a claim the requester typed
-- (the API checked only that it named a different, active platform admin). The four-eyes rule of write grants was
-- therefore one pair of eyes.
--
-- Now a write grant is created PENDING: `approved_at` is null and its access window lies in the past (it never grants
-- anything: every reader — app.principal_snapshot, app.member_org_ids, app.org_ids_with_permission,
-- app.org_ids_with_any_permission, app.unrestricted_org_ids — requires now() inside [starts_at, expires_at)), with the
-- requested duration kept in `requested_hours`. Only the named approver, in their own session
-- (POST /api/v1/platform/access-grants/:id/approve), starts it: approved_at = now(), window = now() + requested hours.
-- The constraints below make an active, unapproved write grant impossible for every writer, not only the API.
--
-- Existing write grants were approved under the old rule: they are marked approved at their creation (they end within
-- 72 hours of it anyway).

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.platform_access_grants add column if not exists approved_at timestamptz;
alter table public.platform_access_grants add column if not exists requested_hours smallint;
comment on column public.platform_access_grants.approved_at is 'When the named second approver approved a write grant (its window starts then); null while pending. Read grants need no approval.';
comment on column public.platform_access_grants.requested_hours is 'Duration requested for a write grant, applied when it is approved (1–72).';

update public.platform_access_grants set approved_at = created_at where access_level = 'write' and approved_at is null and approved_by is not null;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.platform_access_grants'::regclass and conname = 'platform_access_grants_write_pending') then
    -- a write grant is either approved, or pending with a window that ended when it was created (it grants nothing)
    alter table public.platform_access_grants add constraint platform_access_grants_write_pending
      check (access_level = 'read' or approved_at is not null or (expires_at <= created_at and requested_hours between 1 and 72));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.platform_access_grants'::regclass and conname = 'platform_access_grants_approved_needs_approver') then
    alter table public.platform_access_grants add constraint platform_access_grants_approved_needs_approver
      check (approved_at is null or approved_by is not null);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.platform_access_grants'::regclass and conname = 'platform_access_grants_approver_distinct') then
    -- the approver is neither the grantee nor the granter (new rows; older rows are checked below and reported, not refused)
    alter table public.platform_access_grants add constraint platform_access_grants_approver_distinct
      check (approved_by is null or (approved_by <> platform_admin_user_id and (granted_by is null or approved_by <> granted_by))) not valid;
    begin
      alter table public.platform_access_grants validate constraint platform_access_grants_approver_distinct;
    exception when check_violation then
      raise warning 'platform_access_grants: older rows name the grantee or the granter as their approver; the rule applies to new rows';
    end;
  end if;
end $$;

-- post-verify
do $$
begin
  if exists (select 1 from public.platform_access_grants where access_level = 'write' and approved_at is null and revoked_at is null and now() >= starts_at and now() < expires_at) then
    raise exception 'security gate: an unapproved write grant is active';
  end if;
  if (select count(*) from pg_catalog.pg_constraint where conrelid = 'public.platform_access_grants'::regclass
      and conname in ('platform_access_grants_write_pending', 'platform_access_grants_approved_needs_approver', 'platform_access_grants_approver_distinct')) <> 3 then
    raise exception 'security gate: the write-grant approval constraints are missing';
  end if;
end $$;
