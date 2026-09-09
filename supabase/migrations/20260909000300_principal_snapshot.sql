-- The request principal in one round trip.
--
-- Every authenticated API request assembles the caller's memberships, permissions and branch scope from the database
-- (ADR-002/007: never from the JWT, so a role change or suspension applies at once). Doing that inside a user-context
-- transaction took up to ten sequential statements, and with the API in Singapore and the database in Mumbai each one
-- costs ~60 ms — half a second of pure latency before the endpoint's own work started. This definer function returns
-- the same data as a single jsonb document. It bypasses RLS by design, which is why only flowza_api may execute it
-- (never authenticated/anon, which PostgREST exposes) and why the API passes the subject of a verified JWT and nothing
-- else. Its output mirrors apps/api/src/lib/principal.ts:
--   profile, isPlatformAdmin, memberships[] (active, with role key, permissions and branch scope), grants[] (active
--   platform access grants of an active platform admin), allPermissions (only for a platform admin) and
--   mfaRequiredOrgIds (organisations whose security settings require MFA for every member).
create or replace function app.principal_snapshot(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with admin as (
    select exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id and pa.status = 'active') as is_admin
  ),
  grants as (
    select g.organization_id, g.access_level
    from public.platform_access_grants g, admin
    where admin.is_admin
      and g.platform_admin_user_id = p_user_id and g.revoked_at is null and now() >= g.starts_at and now() < g.expires_at
  ),
  member_orgs as (
    select m.organization_id from public.org_memberships m where m.user_id = p_user_id and m.status = 'active'
    union
    select organization_id from grants
  )
  select jsonb_build_object(
    'profile', (select jsonb_build_object('id', p.id, 'email', p.email, 'status', p.status) from public.user_profiles p where p.id = p_user_id),
    'isPlatformAdmin', (select is_admin from admin),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', m.id, 'organizationId', m.organization_id, 'roleId', m.role_id, 'roleKey', r.key,
        'allBranches', m.all_branches, 'employeeId', m.employee_id,
        'permissions', coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key) from public.role_permissions rp where rp.role_id = m.role_id), '[]'::jsonb),
        'branchIds', case when m.all_branches then '[]'::jsonb
                          else coalesce((select jsonb_agg(mb.branch_id) from public.membership_branches mb where mb.membership_id = m.id), '[]'::jsonb) end
      ) order by m.created_at, m.id)
      from public.org_memberships m
      join public.roles r on r.id = m.role_id
      where m.user_id = p_user_id and m.status = 'active'), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('organizationId', organization_id, 'accessLevel', access_level)) from grants), '[]'::jsonb),
    'allPermissions', case when (select is_admin from admin)
                           then coalesce((select jsonb_agg(k.key order by k.key) from public.permissions k), '[]'::jsonb)
                           else '[]'::jsonb end,
    'mfaRequiredOrgIds', coalesce((
      select jsonb_agg(s.organization_id) from public.organization_settings s
      where s.organization_id in (select organization_id from member_orgs) and s.security -> 'mfaRequired' = 'true'::jsonb), '[]'::jsonb)
  );
$$;

revoke all on function app.principal_snapshot(uuid) from public, anon, authenticated, flowza_system, flowza_worker;
grant execute on function app.principal_snapshot(uuid) to flowza_api;
