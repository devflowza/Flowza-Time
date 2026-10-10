-- Location hierarchy (migration 20261010000100, docs/locations.md). Runs as superuser AFTER rls_isolation.sql (it reuses that
-- suite's organisations, branches, logins and roles):
--   Org A: branches A-HQ, A-2 (+ whatever earlier suites committed); owner-a (all branches), bm-a (branch manager, A-2 only —
--          promoted to org admin where a block needs a branch-scoped member holding branch.manage), emp-a (employee role),
--          auditor-a (read-only). Org B: owner-b.
-- Self-contained: every block inserts its fixtures through pg_temp.fixtures() and rolls back.
-- Rules under test:
--   * every organisation has one branch level, every branch one node, created by triggers;
--   * the shape rules hold (role from the level, place under a branch or a place, deeper than the parent, no cycle, place
--     branch derived from the parent), a move re-derives the subtree, the level list stays well formed at commit;
--   * place references cannot point into another branch / organisation, are cleared when the row changes branch, and must
--     be places; a referenced place cannot move to another branch;
--   * RLS: read with branch.view (group nodes + nodes of an allowed branch), write with branch.manage — levels, group and
--     branch nodes for members with every branch only, places for members whose scope holds the branch; tenants isolated.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
end $$;
create or replace function pg_temp.assert_rows(sqltext text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute sqltext; get diagnostics n = row_count;
  if n <> expected then raise exception 'ASSERT FAILED: % — expected % affected rows, got %', label, expected, n; end if;
end $$;
create or replace function pg_temp.assert_sqlstate(sqltext text, expected_state text, label text) returns void language plpgsql as $$
declare v_state text;
begin
  begin
    execute sqltext;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> expected_state then raise exception 'ASSERT FAILED: % — expected SQLSTATE %, got %', label, expected_state, v_state; end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % — expected SQLSTATE %', label, expected_state;
end $$;

-- fixtures: A = Headquarters (group) → A-HQ, A-2 (branches) → Site A (under A-HQ), Site 2 → Floor 2 (under A-2); a device of A-HQ
-- on Site A; B keeps its single branch level
create or replace function pg_temp.fixtures() returns void language plpgsql as $$
begin
  update public.location_levels set position = 2 where organization_id = '0a000000-0000-0000-0000-000000000000' and role = 'branch';
  insert into public.location_levels (id, organization_id, position, role, name, icon) values
    ('0a000000-0000-0000-0000-000000001001', '0a000000-0000-0000-0000-000000000000', 1, 'group', 'Headquarters', 'headquarters'),
    ('0a000000-0000-0000-0000-000000001003', '0a000000-0000-0000-0000-000000000000', 3, 'place', 'Site', 'site'),
    ('0a000000-0000-0000-0000-000000001004', '0a000000-0000-0000-0000-000000000000', 4, 'place', 'Floor', 'floor');
  insert into public.locations (id, organization_id, level_id, code, name, path) values
    ('0a000000-0000-0000-0000-000000002001', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001001', 'HQ', 'Muscat HQ', '{}');
  update public.locations set parent_id = '0a000000-0000-0000-0000-000000002001'
  where organization_id = '0a000000-0000-0000-0000-000000000000' and role = 'branch' and branch_id in ('0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-00000000000c');
  insert into public.locations (id, organization_id, level_id, parent_id, code, name, path) values
    ('0a000000-0000-0000-0000-000000002011', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003',
     (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000b' and role = 'branch'), 'SA', 'Site A', '{}'),
    ('0a000000-0000-0000-0000-000000002021', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003',
     (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000c' and role = 'branch'), 'S2', 'Site 2', '{}');
  insert into public.locations (id, organization_id, level_id, parent_id, code, name, path) values
    ('0a000000-0000-0000-0000-000000002022', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001004', '0a000000-0000-0000-0000-000000002021', 'F2', 'Floor 2', '{}');
  update public.devices set location_id = '0a000000-0000-0000-0000-000000002011' where id = '0a000000-0000-0000-0000-0000000000d1';
  set constraints location_levels_check immediate;
  set constraints location_levels_check deferred;
end $$;

-- what each member should see, computed as superuser (other suites may have committed more branches in A)
create temp table loc_expect (a_nodes bigint, a_levels bigint, b_nodes bigint, a2_nodes bigint) on commit preserve rows;
grant select on loc_expect to public;
create or replace function pg_temp.expectations() returns void language plpgsql as $$
begin
  delete from loc_expect;
  insert into loc_expect select
    (select count(*) from public.locations where organization_id = '0a000000-0000-0000-0000-000000000000'),
    (select count(*) from public.location_levels where organization_id = '0a000000-0000-0000-0000-000000000000'),
    (select count(*) from public.locations where organization_id = '0b000000-0000-0000-0000-000000000000'),
    -- what bm-a (A-2 only) sees: group nodes + the A-2 node and its places
    (select count(*) from public.locations where organization_id = '0a000000-0000-0000-0000-000000000000' and (branch_id is null or branch_id = '0a000000-0000-0000-0000-00000000000c'));
end $$;

-- ---------- schema facts and shape rules ----------
begin;
select pg_temp.fixtures();
select pg_temp.assert_eq((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity and c.relforcerowsecurity
  and c.relname in ('location_levels', 'locations')), 2, 'both tables have RLS enabled and forced');
select pg_temp.assert_eq((select count(*) from public.organizations o where (select count(*) from public.location_levels l where l.organization_id = o.id and l.role = 'branch') <> 1), 0, 'every organisation has exactly one branch level');
select pg_temp.assert_eq((select count(*) from public.branches b where (select count(*) from public.locations l where l.branch_id = b.id and l.role = 'branch') <> 1), 0, 'every branch has exactly one node');
-- a new branch gets its node at the top
insert into public.branches (id, organization_id, code, name) values ('0a000000-0000-0000-0000-0000000020f3', '0a000000-0000-0000-0000-000000000000', 'A-LOC3', 'A Branch L3');
select pg_temp.assert_eq((select count(*) from public.locations where branch_id = '0a000000-0000-0000-0000-0000000020f3' and role = 'branch' and parent_id is null and cardinality(path) = 1), 1, 'a new branch gets a top-level node');
-- the shape comes from the level and the parent (a client's role / branch / path are ignored)
select pg_temp.assert_eq((select count(*) from public.locations where id = '0a000000-0000-0000-0000-000000002022' and role = 'place' and branch_id = '0a000000-0000-0000-0000-00000000000c' and depth = 4), 1, 'a place takes its role from the level and its branch from the parent');
insert into public.locations (id, organization_id, level_id, role, branch_id, parent_id, code, name, path) values
  ('0a000000-0000-0000-0000-000000002023', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001004', 'group', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000002021', 'F3', 'Floor 3', '{0a000000-0000-0000-0000-000000002011}');
select pg_temp.assert_eq((select count(*) from public.locations where id = '0a000000-0000-0000-0000-000000002023' and role = 'place' and branch_id = '0a000000-0000-0000-0000-00000000000c' and path[1] = '0a000000-0000-0000-0000-000000002001'), 1, 'client-sent role, branch and path are re-derived');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003', 'TOP', 'Top site', '{}') $q$, '22023', 'a place cannot sit at the top');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003', '0a000000-0000-0000-0000-000000002001', 'UG', 'Under group', '{}') $q$, '22023', 'a place cannot sit under a group node');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003', '0a000000-0000-0000-0000-000000002022', 'UP', 'Site under floor', '{}') $q$, '22023', 'a child sits on a deeper level than its parent');
select pg_temp.assert_sqlstate($q$ update public.locations set parent_id = '0a000000-0000-0000-0000-000000002022' where id = '0a000000-0000-0000-0000-000000002021' $q$, '22023', 'no cycle');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000', null, 'X', 'Cross level', '{}') $q$, '23503', 'a level of another organisation is refused');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001004', (select id from public.locations where organization_id = '0b000000-0000-0000-0000-000000000000' and role = 'branch' limit 1), 'X', 'Cross parent', '{}') $q$, '23503', 'a parent of another organisation is refused');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003', (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000b' and role = 'branch'), 'sa', 'Site A again', '{}') $q$, '23505', 'codes are unique among siblings (case-insensitive)');
select pg_temp.assert_rows($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001003', (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000b' and role = 'branch'), 'F2', 'Site F2 of A-HQ', '{}') $q$, 1, 'the same code under another parent is fine');
select pg_temp.assert_sqlstate($q$ update public.locations set level_id = '0a000000-0000-0000-0000-000000001001' where id = '0a000000-0000-0000-0000-000000002011' $q$, '22023', 'a place cannot become a group node');
-- moving a branch node re-derives its places' paths
update public.locations set parent_id = null where role = 'branch' and branch_id = '0a000000-0000-0000-0000-00000000000c';
select pg_temp.assert_eq((select count(*) from public.locations where id in ('0a000000-0000-0000-0000-000000002021', '0a000000-0000-0000-0000-000000002022') and path[1] <> '0a000000-0000-0000-0000-000000002001' and depth = cardinality(path)), 2, 'a moved branch takes its places along');
-- place references
select pg_temp.assert_sqlstate($q$ update public.devices set location_id = '0a000000-0000-0000-0000-000000002021' where id = '0a000000-0000-0000-0000-0000000000d1' $q$, '23503', 'a device cannot sit in a place of another branch');
select pg_temp.assert_sqlstate($q$ update public.devices set location_id = (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000b' and role = 'branch') where id = '0a000000-0000-0000-0000-0000000000d1' $q$, '22023', 'a device location is a place, not the branch node');
select pg_temp.assert_sqlstate($q$ update public.locations set parent_id = (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000c' and role = 'branch') where id = '0a000000-0000-0000-0000-000000002011' $q$, '23503', 'a place a device uses cannot move to another branch');
update public.employees set work_location_id = '0a000000-0000-0000-0000-000000002011' where id = '0a000000-0000-0000-0000-0000000000e1';
update public.employees set branch_id = '0a000000-0000-0000-0000-00000000000c' where id = '0a000000-0000-0000-0000-0000000000e1';
select pg_temp.assert_eq((select count(*) from public.employees where id = '0a000000-0000-0000-0000-0000000000e1' and work_location_id is null), 1, 'a transfer clears a work location of the old branch');
update public.employees set branch_id = '0a000000-0000-0000-0000-00000000000b', work_location_id = '0a000000-0000-0000-0000-000000002011' where id = '0a000000-0000-0000-0000-0000000000e1';
select pg_temp.assert_eq((select count(*) from public.employees where id = '0a000000-0000-0000-0000-0000000000e1' and work_location_id = '0a000000-0000-0000-0000-000000002011'), 1, 'a transfer may set the new work location in the same statement');
select pg_temp.assert_sqlstate($q$ insert into public.geofences (organization_id, branch_id, location_id, name, latitude, longitude, radius_m) values ('0a000000-0000-0000-0000-000000000000', null, '0a000000-0000-0000-0000-000000002011', 'No branch', 23.6, 58.5, 100) $q$, '23514', 'a fence on a place has a branch');
-- policies by location: a group node without a branch, a place with its branch
select pg_temp.assert_rows($q$ insert into public.attendance_rule_sets (organization_id, name, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'HQ policy', '0a000000-0000-0000-0000-000000002001', '2026-01-01', '{}') $q$, 1, 'a policy for a group location');
select pg_temp.assert_rows($q$ insert into public.attendance_rule_sets (organization_id, name, branch_id, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Site A policy', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000002011', '2026-01-01', '{}') $q$, 1, 'a policy for a place names its branch');
select pg_temp.assert_rows($q$ insert into public.attendance_rule_sets (organization_id, name, branch_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'A-HQ policy', '0a000000-0000-0000-0000-00000000000b', '2026-01-01', '{}') $q$, 1, 'a branch policy overlaps a place policy of the branch');
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Place without branch', '0a000000-0000-0000-0000-000000002011', '2027-01-01', '{}') $q$, '22023', 'a place policy names the place''s branch');
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, branch_id, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Wrong branch', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000002011', '2027-01-01', '{}') $q$, '22023', 'a place policy cannot name another branch');
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Branch node', (select id from public.locations where branch_id = '0a000000-0000-0000-0000-00000000000b' and role = 'branch'), '2027-01-01', '{}') $q$, '22023', 'a branch is named through branch_id');
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'HQ again', '0a000000-0000-0000-0000-000000002001', '2026-06-01', '{}') $q$, '23P01', 'two policies of the same location cannot overlap');
-- coverage per place
select pg_temp.assert_rows($q$ insert into public.shift_coverage_requirements (organization_id, branch_id, shift_id, location_id, min_headcount) select '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', s.id, '0a000000-0000-0000-0000-000000002011', 2 from public.shifts s where s.organization_id = '0a000000-0000-0000-0000-000000000000' limit 1 $q$, 1, 'a coverage target for a place');
-- the level list stays well formed at commit; a used level cannot go
select pg_temp.assert_sqlstate($q$ delete from public.location_levels where id = '0a000000-0000-0000-0000-000000001003' $q$, '23503', 'a level in use cannot be deleted');
rollback;

begin;
select pg_temp.fixtures();
insert into public.location_levels (organization_id, position, role, name) values ('0a000000-0000-0000-0000-000000000000', 5, 'group', 'Group below the branch');
select pg_temp.assert_sqlstate($q$ set constraints location_levels_check immediate $q$, '23514', 'a group level cannot sit below the branch level');
rollback;
begin;
select pg_temp.fixtures();
update public.location_levels set position = 6 where id = '0a000000-0000-0000-0000-000000001004';
select pg_temp.assert_sqlstate($q$ set constraints location_levels_check immediate $q$, '23514', 'level positions have no gaps');
rollback;
begin;
select pg_temp.fixtures();
update public.location_levels set position = case position when 3 then 4 when 4 then 3 end where organization_id = '0a000000-0000-0000-0000-000000000000' and position in (3, 4);
select pg_temp.assert_sqlstate($q$ set constraints location_levels_check immediate $q$, '23514', 'swapping two levels in use would put a floor above its site');
rollback;
begin;
select pg_temp.fixtures();
select pg_temp.assert_sqlstate($q$ update public.location_levels set role = 'place' where id = '0a000000-0000-0000-0000-000000001001' $q$, '22023', 'a level keeps its role');
rollback;

-- ---------- as Owner A (every branch, branch.manage) ----------
begin;
select pg_temp.fixtures();
select pg_temp.expectations();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.location_levels), (select a_levels from loc_expect), 'owner A sees org A levels only');
select pg_temp.assert_eq((select count(*) from public.locations), (select a_nodes from loc_expect), 'owner A sees every node of org A and none of org B');
select pg_temp.assert_rows($q$ insert into public.locations (organization_id, level_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001001', 'NR', 'Northern Region', '{}') $q$, 1, 'owner A creates a group node');
select pg_temp.assert_rows($q$ update public.locations set parent_id = null where role = 'branch' and branch_id = '0a000000-0000-0000-0000-00000000000c' $q$, 1, 'owner A places a branch');
select pg_temp.assert_rows($q$ update public.location_levels set name = 'Head office', name_ar = 'المكتب الرئيسي' where id = '0a000000-0000-0000-0000-000000001001' $q$, 1, 'owner A renames a level');
select pg_temp.assert_rows($q$ update public.locations set name = 'Hijack' where organization_id = '0b000000-0000-0000-0000-000000000000' $q$, 0, 'owner A cannot touch org B nodes');
select pg_temp.assert_sqlstate($q$ insert into public.location_levels (organization_id, position, role, name) values ('0b000000-0000-0000-0000-000000000000', 2, 'place', 'Cross') $q$, '42501', 'owner A cannot add a level to org B');
select pg_temp.assert_sqlstate($q$ delete from public.locations where id = '0a000000-0000-0000-0000-000000002022' $q$, '42501', 'a location is archived, never deleted — even by the owner');
select pg_temp.assert_rows($q$ insert into public.attendance_rule_sets (organization_id, name, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'HQ policy', '0a000000-0000-0000-0000-000000002001', '2026-01-01', '{}') $q$, 1, 'owner A writes a policy for a group location');
rollback;

-- ---------- as a branch-scoped administrator (bm-a promoted to org admin, A-2 only) ----------
begin;
select pg_temp.fixtures();
select pg_temp.expectations();
update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000002' where id = '0a000000-0000-0000-0000-0000000000a2';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.locations), (select a2_nodes from loc_expect), 'a scoped admin sees the group nodes and the nodes of their branch');
select pg_temp.assert_eq((select count(*) from public.locations where id = '0a000000-0000-0000-0000-000000002011'), 0, 'a scoped admin does not see the places of another branch');
select pg_temp.assert_rows($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001004', '0a000000-0000-0000-0000-000000002021', 'F9', 'Floor 9', '{}') $q$, 1, 'a scoped admin adds a place in their branch');
select pg_temp.assert_rows($q$ update public.locations set name = 'Site 2 (east)' where id = '0a000000-0000-0000-0000-000000002021' $q$, 1, 'a scoped admin renames a place of their branch');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001001', 'SR', 'Southern Region', '{}') $q$, '42501', 'a scoped admin cannot create a group node');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, parent_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001004', '0a000000-0000-0000-0000-000000002011', 'FX', 'Floor in A-HQ', '{}') $q$, '42501', 'a scoped admin cannot add a place to another branch');
select pg_temp.assert_rows($q$ update public.locations set parent_id = null where role = 'branch' and branch_id = '0a000000-0000-0000-0000-00000000000c' $q$, 0, 'a scoped admin cannot move their branch node');
select pg_temp.assert_rows($q$ update public.locations set name = 'Renamed HQ' where id = '0a000000-0000-0000-0000-000000002001' $q$, 0, 'a scoped admin cannot rename a group node');
select pg_temp.assert_rows($q$ update public.location_levels set name = 'Renamed' $q$, 0, 'a scoped admin cannot rename levels');
select pg_temp.assert_rows($q$ delete from public.location_levels $q$, 0, 'a scoped admin cannot delete levels');
select pg_temp.assert_sqlstate($q$ insert into public.location_levels (organization_id, position, role, name) values ('0a000000-0000-0000-0000-000000000000', 5, 'place', 'Desk') $q$, '42501', 'a scoped admin cannot add levels');
-- rule sets that name no branch span branches: a scoped admin writes neither a group location's nor the organisation-wide one
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Region grab', '0a000000-0000-0000-0000-000000002001', '2026-01-01', '{}') $q$, '42501', 'a scoped admin cannot write a group-location policy');
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Org grab', '2027-01-01', '{}') $q$, '42501', 'a scoped admin cannot write the organisation-wide rule set');
select pg_temp.assert_rows($q$ insert into public.attendance_rule_sets (organization_id, name, branch_id, location_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Site 2 policy', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000002021', '2026-01-01', '{}') $q$, 1, 'a scoped admin writes a place policy of their branch');
rollback;

-- ---------- as the auditor (branch.view, no branch.manage) ----------
begin;
select pg_temp.fixtures();
select pg_temp.expectations();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.locations), (select a_nodes from loc_expect), 'the auditor reads the whole tree');
select pg_temp.assert_eq((select count(*) from public.location_levels), (select a_levels from loc_expect), 'the auditor reads the levels');
select pg_temp.assert_sqlstate($q$ insert into public.locations (organization_id, level_id, code, name, path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000001001', 'AU', 'Auditor region', '{}') $q$, '42501', 'the auditor cannot create a node');
select pg_temp.assert_rows($q$ update public.locations set name = 'Audited' where id = '0a000000-0000-0000-0000-000000002011' $q$, 0, 'the auditor cannot rename a node');
rollback;

-- ---------- as an employee (no branch.view) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.locations), 0, 'an employee reads no location');
select pg_temp.assert_eq((select count(*) from public.location_levels), 0, 'an employee reads no level');
rollback;

-- ---------- as Owner B ----------
begin;
select pg_temp.fixtures();
select pg_temp.expectations();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.locations), (select b_nodes from loc_expect), 'owner B sees org B nodes only');
select pg_temp.assert_eq((select count(*) from public.location_levels where organization_id = '0a000000-0000-0000-0000-000000000000'), 0, 'owner B reads none of org A levels');
select pg_temp.assert_sqlstate($q$ delete from public.locations where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '42501', 'owner B cannot delete org A nodes (nobody deletes a location)');
rollback;

\echo 'rls_locations: ok'
