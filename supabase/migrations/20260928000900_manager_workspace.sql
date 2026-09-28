-- Manager workspace (HR portal Prompt 5) + HR admin parity (Prompt 6b) — the one schema change they need: invitations.
--
-- The team workspace, the regularisation register and the comments report read existing tables under the existing RLS; no
-- table or policy of theirs changes here.
--
-- Invitations (Finance B-67 … B-71, B-74):
-- 1. Soft revocation: `revoked_at` / `revoked_by` / `revoke_reason`. A revoked invitation keeps its row, so a token that was
--    revoked can be REPORTED as revoked by the public validation (B-70) instead of reading as unknown; acceptance refuses
--    it. Before this change a revocation deleted the row. A CHECK keeps the three columns consistent and keeps an accepted
--    invitation from being revoked afterwards.
-- 2. The resend chain: resending revokes the pending invitation (reason `resent`) and issues a new one; `replaced_by_id`
--    points from the old row to the new one (audit trail; nothing reads it for authorisation).
-- 3. E-mail delivery: the worker mints the token it e-mails when it sends the invitation and stores ONLY its sha256 in
--    `delivery_token_hash` (unique) — the plain token exists in the e-mail and nowhere else, the same pattern as the
--    approval one-click links. The link the inviting administrator may copy keeps its own hash in `token_hash`; either
--    token accepts the same single-use invitation. `delivery_sent_at` records the send.
-- 4. Index for the open-invitation lookups by employee (profile card, link-clash guard, offboarding).
-- 5. `invitations.role_id` becomes ON DELETE CASCADE, so a CLOSED invitation (accepted, or revoked — which item 1 now keeps)
--    no longer blocks deleting the custom role it named; roles.service still refuses while a member or an OPEN invitation
--    uses the role. The constraint is re-created in place under its own name only while it lacks the cascade action.
--
-- Idempotent and one transaction (no CONCURRENTLY, no enum change). Additive except item 5's delete action on one FK.

set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

alter table public.invitations add column if not exists revoked_at timestamptz;
alter table public.invitations add column if not exists revoked_by uuid references public.user_profiles(id) on delete set null;
alter table public.invitations add column if not exists revoke_reason text;
alter table public.invitations add column if not exists replaced_by_id uuid references public.invitations(id) on delete set null;
alter table public.invitations add column if not exists delivery_token_hash text;
alter table public.invitations add column if not exists delivery_sent_at timestamptz;

comment on column public.invitations.revoked_at is 'Set when the invitation was revoked (by an administrator, by a resend, by revoking portal access or by the employee leaving). A revoked invitation cannot be accepted; validation reports it as revoked.';
comment on column public.invitations.revoke_reason is 'Why it was revoked: revoked | resent | access_revoked | employee_left | superseded (free text up to 500 characters).';
comment on column public.invitations.replaced_by_id is 'The invitation that replaced this one when it was resent.';
comment on column public.invitations.delivery_token_hash is 'sha256 (hex) of the token e-mailed by the worker; the plain token is never stored.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invitations_revocation_shape' and conrelid = 'public.invitations'::regclass) then
    alter table public.invitations add constraint invitations_revocation_shape check (
      (revoked_at is not null or (revoked_by is null and revoke_reason is null))
      and (revoke_reason is null or char_length(revoke_reason) <= 500)
      and not (revoked_at is not null and accepted_at is not null)
    );
  end if;
end $$;

create unique index if not exists invitations_delivery_token_hash_key on public.invitations (delivery_token_hash) where delivery_token_hash is not null;
create index if not exists invitations_org_employee_open_idx on public.invitations (organization_id, employee_id) where accepted_at is null and revoked_at is null and employee_id is not null;

-- 5. A closed invitation (accepted, or revoked — now kept) no longer blocks deleting the custom role it named: the role
--    delete refuses while a member or an OPEN invitation uses the role (roles.service), and the history rows go with the role
--    (the audit log keeps the trail). Before, the FK had no action, so deleting a role that an accepted invitation once
--    named failed with a foreign-key error.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'invitations_role_id_fkey' and conrelid = 'public.invitations'::regclass and confdeltype <> 'c') then
    alter table public.invitations drop constraint invitations_role_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invitations_role_id_fkey' and conrelid = 'public.invitations'::regclass) then
    alter table public.invitations add constraint invitations_role_id_fkey foreign key (role_id) references public.roles(id) on delete cascade;
  end if;
end $$;

-- post-verify ------------------------------------------------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*) into v_count from information_schema.columns
  where table_schema = 'public' and table_name = 'invitations'
    and column_name in ('revoked_at', 'revoked_by', 'revoke_reason', 'replaced_by_id', 'delivery_token_hash', 'delivery_sent_at');
  if v_count <> 6 then raise exception 'invitations: % of 6 new columns present', v_count; end if;
  if not exists (select 1 from pg_constraint where conname = 'invitations_revocation_shape' and conrelid = 'public.invitations'::regclass) then
    raise exception 'invitations_revocation_shape missing';
  end if;
  select count(*) into v_count from pg_indexes where schemaname = 'public' and indexname in ('invitations_delivery_token_hash_key', 'invitations_org_employee_open_idx');
  if v_count <> 2 then raise exception 'invitation indexes missing (%/2)', v_count; end if;
  if not exists (select 1 from pg_constraint where conname = 'invitations_role_id_fkey' and conrelid = 'public.invitations'::regclass and confdeltype = 'c') then
    raise exception 'invitations_role_id_fkey is not ON DELETE CASCADE';
  end if;
  -- the table stays tenant-scoped and never readable by anon
  if not exists (select 1 from pg_class where oid = 'public.invitations'::regclass and relrowsecurity) then raise exception 'invitations lost row level security'; end if;
  if has_table_privilege('anon', 'public.invitations', 'select') then raise exception 'anon can read invitations'; end if;
end $$;
