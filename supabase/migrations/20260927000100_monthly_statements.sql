-- Monthly attendance statements (docs/statements.md).
--
-- Every month each employee receives their sign-in/sign-out statement by email as a tokenized review link: they
-- verify the days, may comment on sign-in/out discrepancies (one comment per day), and digitally sign. A signature
-- without comments finalises the statement immediately; comments route it to the reporting manager (resolved like
-- correction approvals: manager's membership, hr_admin role as fallback) whose approval finalises it. The statement
-- body is an immutable snapshot (jsonb) of the daily records at issue time, so what was signed can never drift when
-- records are later recomputed; recomputation-then-reissue goes through void + supersede, never update.
--
-- New: statement_status enum, attendance_statements + attendance_statement_comments (append-only), statement.*
-- permissions with system-role grants, and a platform-context read of organization_settings for the scheduler's
-- monthly sweep. Review-link tokens follow the invitations pattern: `<org id>.<secret>`, only sha256(secret) stored.
-- New tables only; the one hot-table touch (organization_settings policy) is bounded by the lock wait.
set lock_timeout = '5s';
set statement_timeout = '60s';

create type public.statement_status as enum ('ISSUED', 'PENDING_APPROVAL', 'FINALIZED', 'VOID');

create table public.attendance_statements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null, -- employee's branch when issued (RLS scope)
  period_start date not null,
  period_end date not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  record_versions jsonb, -- {record_id: calculation_version} of the daily records the snapshot was built from
  status public.statement_status not null default 'ISSUED',
  -- Review-link token: >= 128 bits random, only the sha256 hex stored (invitations pattern). Rotated on resend.
  token_hash text not null unique,
  token_expires_at timestamptz not null,
  email_to extensions.citext,
  email_sent_at timestamptz,
  email_error text,
  email_attempts int not null default 0 check (email_attempts >= 0),
  issued_at timestamptz not null default now(),
  first_viewed_at timestamptz,
  submitted_at timestamptz,
  -- Digital signature: typed full name plus capture metadata, immutable once set (trigger below).
  signed_name text check (signed_name is null or char_length(signed_name) between 2 and 120),
  signed_ip inet,
  signed_user_agent text,
  comment_count int not null default 0 check (comment_count >= 0),
  -- Resolved approver: the manager's user when they hold a membership, else the hr_admin role (corrections pattern).
  approver_user_id uuid references public.user_profiles(id) on delete set null,
  approver_role_id uuid references public.roles(id),
  approved_by uuid references public.user_profiles(id) on delete set null,
  approved_at timestamptz,
  approval_note text check (approval_note is null or char_length(approval_note) <= 1000),
  finalized_at timestamptz,
  finalized_reason text check (finalized_reason in ('EMPLOYEE_CONFIRMED', 'MANAGER_APPROVED')),
  voided_at timestamptz,
  voided_by uuid references public.user_profiles(id) on delete set null,
  void_reason text,
  superseded_by_statement_id uuid references public.attendance_statements(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id), -- composite FK target for comments (same-org guarantee)
  constraint attendance_statements_range check (period_end >= period_start),
  -- State-machine integrity: a submitted statement carries its signature; a finalised one says how; approval implies approver.
  constraint attendance_statements_submitted check (submitted_at is null or signed_name is not null),
  constraint attendance_statements_pending check (status <> 'PENDING_APPROVAL' or submitted_at is not null),
  constraint attendance_statements_finalized check (
    status <> 'FINALIZED' or (submitted_at is not null and finalized_at is not null and finalized_reason is not null)),
  constraint attendance_statements_approved check (finalized_reason is distinct from 'MANAGER_APPROVED' or approved_by is not null),
  constraint attendance_statements_voided check (status <> 'VOID' or voided_at is not null)
);

-- One live statement per employee per period; voided ones stay for the audit trail.
create unique index attendance_statements_period_uq
  on public.attendance_statements (organization_id, employee_id, period_start) where status <> 'VOID';
create index attendance_statements_org_period_idx
  on public.attendance_statements (organization_id, period_start desc, status);
create index attendance_statements_approver_idx
  on public.attendance_statements (approver_user_id) where status = 'PENDING_APPROVAL';
create trigger attendance_statements_updated_at
  before update on public.attendance_statements for each row execute function app.set_updated_at();

-- The signature and the snapshot are what the employee attested to: immutable once written. Comments are counted
-- forward only. Void is terminal; a finalised statement can never change again.
create or replace function app.attendance_statements_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.snapshot is distinct from new.snapshot then
    raise exception 'attendance_statements.snapshot is immutable; void and reissue instead' using errcode = 'P0001';
  end if;
  if old.signed_name is not null and (new.signed_name is distinct from old.signed_name
      or new.signed_ip is distinct from old.signed_ip or new.signed_user_agent is distinct from old.signed_user_agent
      or new.submitted_at is distinct from old.submitted_at) then
    raise exception 'attendance_statements signature fields are immutable once signed' using errcode = 'P0001';
  end if;
  if old.status in ('FINALIZED', 'VOID') and new.status is distinct from old.status then
    raise exception 'attendance_statements: % is a terminal status', old.status using errcode = 'P0001';
  end if;
  if new.comment_count < old.comment_count then
    raise exception 'attendance_statements.comment_count cannot decrease' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger attendance_statements_guard
  before update on public.attendance_statements for each row execute function app.attendance_statements_guard();

-- The employee's per-day remarks (sign-in/out disputes only, by product rule; the UI and API enforce the scope).
-- Append-only: they are the employee's testimony on the signed document.
create table public.attendance_statement_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  statement_id uuid not null,
  employee_id uuid not null, -- denormalised from the statement for self-service RLS
  branch_id uuid not null,   -- denormalised from the statement for branch-scoped RLS
  attendance_date date not null,
  comment text not null check (char_length(comment) between 1 and 1000),
  created_at timestamptz not null default now(),
  foreign key (statement_id, organization_id) references public.attendance_statements(id, organization_id) on delete cascade,
  unique (statement_id, attendance_date)
);
create index attendance_statement_comments_statement_idx
  on public.attendance_statement_comments (organization_id, statement_id);
create trigger attendance_statement_comments_append_only
  before update or delete on public.attendance_statement_comments for each row execute function app.reject_modification();

-- Permissions (category mirrors report.*; keys must match @flowza/contracts PERMISSIONS).
insert into public.permissions (key, category, description, sort_order) values
  ('statement.view',    'reports', 'View monthly attendance statements', 103),
  ('statement.issue',   'reports', 'Issue, resend and void monthly attendance statements', 104),
  ('statement.approve', 'reports', 'Approve monthly attendance statements', 105)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

insert into public.role_permissions (role_id, permission_key)
  select r.id, p.key from (values
    ('10000000-0000-0000-0000-000000000001'::uuid), ('10000000-0000-0000-0000-000000000002'::uuid),
    ('10000000-0000-0000-0000-000000000003'::uuid)) as r(id)
  cross join (values ('statement.view'), ('statement.issue'), ('statement.approve')) as p(key)
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-0000-0000-000000000004', 'statement.view'),
  ('10000000-0000-0000-0000-000000000005', 'statement.view'),
  ('10000000-0000-0000-0000-000000000005', 'statement.approve'),
  ('10000000-0000-0000-0000-000000000006', 'statement.view'),
  ('10000000-0000-0000-0000-000000000007', 'statement.view')
on conflict do nothing;

-- RLS. Read: statement.view within branch scope, or the employee's own rows (self-service); write: statement.issue.
-- System context (worker jobs, the API's post-token-lookup context) gets full access scoped to its organisation.
call app.apply_tenant_policies('public.attendance_statements', 'statement.view', 'statement.issue', 'branch_id', 'employee_id');
call app.apply_tenant_policies('public.attendance_statement_comments', 'statement.view', 'statement.issue', 'branch_id', 'employee_id');

-- The resolved approver sees and decides their own pending statements even without any statement.* permission
-- (a line manager is often a plain employee); statement.approve holders cover the hr_admin fallback.
create policy attendance_statements_assignee_select on public.attendance_statements
  for select to authenticated using (approver_user_id = (select app.uid()));
create policy attendance_statements_assignee_update on public.attendance_statements
  for update to authenticated
  using (approver_user_id = (select app.uid()) and status = 'PENDING_APPROVAL')
  with check (approver_user_id = (select app.uid()));
create policy attendance_statements_approve_perm_update on public.attendance_statements
  for update to authenticated
  using (organization_id = any ((select app.org_ids_with_permission('statement.approve'))::uuid[]) and status = 'PENDING_APPROVAL')
  with check (organization_id = any ((select app.org_ids_with_permission('statement.approve'))::uuid[]));
create policy attendance_statement_comments_assignee_select on public.attendance_statement_comments
  for select to authenticated using (exists (
    select 1 from public.attendance_statements s
    where s.id = statement_id and s.organization_id = attendance_statement_comments.organization_id
      and s.approver_user_id = (select app.uid())));

-- Public review endpoints carry only the token. Like invitation tokens, a statement token is
-- `<organization_id>.<secret>` with only sha256(secret) stored, so the API can enter system-for-org context from the
-- token itself and resolve the row under ordinary RLS — no cross-tenant lookup path exists.

-- The worker's monthly sweep (platform context, enqueue-only) reads which organisations enabled statements and on
-- which local day to send; settings hold configuration, not personal data (same class as devices/organizations reads).
create policy organization_settings_platform_ctx on public.organization_settings
  for select to flowza_system using ((select app.is_platform_context()));
