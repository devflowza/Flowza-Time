-- Employee portal attendance self-service (migration 20260928000500, HR portal Prompt 4). Runs as superuser AFTER
-- rls_isolation.sql (it reuses that suite's organisations, branches, employees, logins and roles):
--   Org A: e1 (HQ) reports to e4 (manager-a) and e5 (secondary-a); e6 (A-2) reports to e1 (NOT a direct report of e4);
--          e2 (A-2) reports to e3 (emp-a, role `employee`: a relationship without a team key); bm-a is scoped to branch A-2;
--          auditor-a is organisation-wide read-only.
-- Rules under test: the self-service tables (notes, regularisations, grants, selfies, swaps) are READ by the organisation-wide
-- key (attendance.view, branch-scoped where the table has a branch), by the employee's own rows and by line managers holding
-- attendance.view_team for direct reports — and WRITTEN only by the system context (no client privilege, explicit restrictive
-- denials that survive a later GRANT). Geofences are configuration written by attendance.manage_geofences holders. Selfie
-- photos live under employee-photos/checkins/<org>/<employee>/…: no tenant storage policy matches the prefix and a
-- restrictive policy denies it to every client role, so the API's 60-second signed URL is the only way to a photo.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual <> expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
end $$;
create or replace function pg_temp.assert_rows(sqltext text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute sqltext; get diagnostics n = row_count;
  if n <> expected then raise exception 'ASSERT FAILED: % — expected % affected rows, got %', label, expected, n; end if;
end $$;
create or replace function pg_temp.assert_raises(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    return;
  end;
  raise exception 'ASSERT FAILED: % — expected an error', label;
end $$;

-- ---------- fixtures (as superuser, committed) ----------
begin;
-- a second org-B employee so org B can hold a swap of its own
insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id, user_id) values
  ('0b000000-0000-0000-0000-0000000000e2', '0b000000-0000-0000-0000-000000000000', 'B-002', 'Huda', 'Salem', 'Huda Salem', '2025-01-01', '0b000000-0000-0000-0000-00000000000b', '2', null);
-- attendance notes: N1 e1 (HQ, report of manager-a), N2 e2 (A-2), N3 e3 (A-2, emp-a's own), N4 e6 (A-2, a report of a report)
insert into public.attendance_notes (id, organization_id, employee_id, branch_id, attendance_date, category, note, status, submitted_by) values
  ('0a000000-0000-0000-0000-000000000401', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-01', 'client_visit', 'At the client site', 'pending', null),
  ('0a000000-0000-0000-0000-000000000402', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'late_reason', 'Traffic', 'approved', null),
  ('0a000000-0000-0000-0000-000000000403', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'absence_reason', 'Sick', 'pending', 'a0000000-0000-0000-0000-000000000003'),
  ('0a000000-0000-0000-0000-000000000404', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e6', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'field_work', 'Installation', 'pending', null),
  ('0b000000-0000-0000-0000-000000000401', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '2026-09-01', 'other', 'Org B note', 'pending', null);
-- regularisations: R1 e1 (HQ), R2 e3 (A-2, emp-a's own)
insert into public.attendance_regularisation_requests (id, organization_id, employee_id, branch_id, attendance_date, type, proposed_in_at, reason, status) values
  ('0a000000-0000-0000-0000-000000000411', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-02', 'missed_punch', '2026-09-02 04:00+00', 'Forgot to punch in', 'pending'),
  ('0a000000-0000-0000-0000-000000000412', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-02', 'wfh_unmarked', null, 'Worked from home', 'pending'),
  ('0b000000-0000-0000-0000-000000000411', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '2026-09-02', 'system_downtime', null, 'Terminal offline', 'pending');
-- attendance grants: e1 open attendance, e3 selfie required
insert into public.employee_attendance_grants (employee_id, organization_id, open_attendance, selfie_required) values
  ('0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-000000000000', true, false),
  ('0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-000000000000', false, true),
  ('0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-000000000000', true, true);
-- selfie check-ins: S1 e1 (HQ), S3 e3 (A-2)
insert into public.selfie_checkins (id, organization_id, employee_id, branch_id, direction, photo_path, status) values
  ('0a000000-0000-0000-0000-000000000421', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', 'in', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/s1.jpg', 'pending'),
  ('0a000000-0000-0000-0000-000000000422', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', 'in', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e3/s3.jpg', 'pending'),
  ('0b000000-0000-0000-0000-000000000421', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', 'out', 'checkins/0b000000-0000-0000-0000-000000000000/0b000000-0000-0000-0000-0000000000e1/sb.jpg', 'pending');
-- geofences: F1 HQ, F2 A-2, F3 organisation-wide (no branch); assignments: F1 → branch HQ, F2 → employee e3
insert into public.geofences (id, organization_id, branch_id, name, latitude, longitude, radius_m, enforcement) values
  ('0a000000-0000-0000-0000-000000000431', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', 'HQ', 23.5880, 58.3829, 150, 'hard_block'),
  ('0a000000-0000-0000-0000-000000000432', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000c', 'Branch 2', 23.6000, 58.4000, 100, 'soft_warn'),
  ('0a000000-0000-0000-0000-000000000433', '0a000000-0000-0000-0000-000000000000', null, 'Client park', 23.6200, 58.4200, 300, 'advisory_log'),
  ('0b000000-0000-0000-0000-000000000431', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-00000000000b', 'B HQ', 25.2000, 55.2700, 200, 'soft_warn');
insert into public.geofence_assignments (id, organization_id, geofence_id, scope, target_id) values
  ('0a000000-0000-0000-0000-000000000441', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000431', 'branch', '0a000000-0000-0000-0000-00000000000b'),
  ('0a000000-0000-0000-0000-000000000442', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000432', 'employee', '0a000000-0000-0000-0000-0000000000e3'),
  ('0b000000-0000-0000-0000-000000000441', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000431', 'org', null);
-- shifts + swaps: W1 e3 → e2 (emp-a requests), W2 e6 → e1 (names manager-a's report), W3 e2 → e3 (names emp-a)
insert into public.shifts (id, organization_id, code, name, type, start_time, end_time) values
  ('0a000000-0000-0000-0000-000000000451', '0a000000-0000-0000-0000-000000000000', 'P4-DAY', 'Portal day', 'FIXED', '08:00', '17:00'),
  ('0a000000-0000-0000-0000-000000000452', '0a000000-0000-0000-0000-000000000000', 'P4-NIGHT', 'Portal night', 'FIXED', '20:00', '05:00'),
  ('0b000000-0000-0000-0000-000000000451', '0b000000-0000-0000-0000-000000000000', 'P4-DAY', 'Portal day', 'FIXED', '08:00', '17:00'),
  ('0b000000-0000-0000-0000-000000000452', '0b000000-0000-0000-0000-000000000000', 'P4-NIGHT', 'Portal night', 'FIXED', '20:00', '05:00');
insert into public.shift_swap_requests (id, organization_id, requester_employee_id, target_employee_id, branch_id, swap_date, requester_shift_id, target_shift_id, reason, status) values
  ('0a000000-0000-0000-0000-000000000461', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '2026-10-01', '0a000000-0000-0000-0000-000000000451', '0a000000-0000-0000-0000-000000000452', 'Family event', 'pending'),
  ('0a000000-0000-0000-0000-000000000462', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e6', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000c', '2026-10-02', '0a000000-0000-0000-0000-000000000451', '0a000000-0000-0000-0000-000000000452', 'Doctor visit', 'pending'),
  ('0a000000-0000-0000-0000-000000000463', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-10-03', '0a000000-0000-0000-0000-000000000452', '0a000000-0000-0000-0000-000000000451', 'Course', 'pending'),
  ('0b000000-0000-0000-0000-000000000461', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-0000000000e2', '0b000000-0000-0000-0000-00000000000b', '2026-10-01', '0b000000-0000-0000-0000-000000000451', '0b000000-0000-0000-0000-000000000452', 'Org B swap', 'pending');
-- the stored selfie objects (written by the API's service client in production): S3 is emp-a's own, S1 a colleague's (e1)
insert into storage.objects (bucket_id, name) values
  ('employee-photos', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e3/s3.jpg'),
  ('employee-photos', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/s1.jpg'),
  -- the control: an ordinary profile photo on the tenant path, readable by employee.view holders
  ('employee-photos', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/profile.jpg');
commit;

-- ---------- schema facts ----------
begin;
select pg_temp.assert_eq((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('attendance_notes', 'attendance_regularisation_requests', 'employee_attendance_grants', 'selfie_checkins', 'geofences', 'geofence_assignments', 'shift_swap_requests') and c.relrowsecurity), 7, 'every new table has RLS enabled');
select pg_temp.assert_eq((select count(*) from unnest(array['attendance_notes', 'attendance_regularisation_requests', 'employee_attendance_grants', 'selfie_checkins', 'shift_swap_requests']) t
  where has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'delete')), 0, 'no client write privilege on the RPC-only tables');
select pg_temp.assert_eq((select count(*) from public.device_providers where key = 'self_service'), 1, 'the virtual self-service provider exists');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'flowza_selfie_photos_deny_client'
  and permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles @> array['anon', 'authenticated', 'flowza_system']::name[]), 1, 'a restrictive storage policy denies every client role the checkins/ prefix');
select pg_temp.assert_eq((select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'raw_source' and e.enumlabel = 'SELF_SERVICE'), 1, 'raw_source carries SELF_SERVICE');
select pg_temp.assert_raises($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note, status) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'second active note', 'pending') $q$, 'one active note per employee-day');
select pg_temp.assert_rows($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note, status) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'rejected history', 'rejected') $q$, 1, 'a rejected note is history and does not count as active');
select pg_temp.assert_raises($q$ insert into public.geofence_assignments (organization_id, geofence_id, scope, target_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000431', 'org', '0a000000-0000-0000-0000-00000000000b') $q$, 'an org-scope assignment has no target');
select pg_temp.assert_raises($q$ insert into public.geofence_assignments (organization_id, geofence_id, scope, target_id) values ('0b000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000431', 'org', null) $q$, 'an assignment cannot point at another organisation''s fence');
select pg_temp.assert_raises($q$ insert into public.shift_swap_requests (organization_id, requester_employee_id, target_employee_id, swap_date, requester_shift_id, target_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0b000000-0000-0000-0000-0000000000e1', '2026-10-05', '0a000000-0000-0000-0000-000000000451', '0a000000-0000-0000-0000-000000000452', 'cross-tenant') $q$, 'a swap cannot name an employee of another organisation');
rollback;

-- ---------- as Employee A (emp-a, role employee, linked to e3; e2 reports to e3 but the role has no team key) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 1, 'employee sees only own note');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where employee_id = '0a000000-0000-0000-0000-0000000000e3'), 1, 'employee reads own note');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where employee_id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'a manager relationship without a team key reveals no note');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 1, 'employee sees only own regularisation');
select pg_temp.assert_eq((select count(*) from public.employee_attendance_grants), 1, 'employee sees only own attendance grant');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 1, 'employee sees only own selfie check-in');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 2, 'employee sees the swap they asked for and the swap that names them');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests where id = '0a000000-0000-0000-0000-000000000462'), 0, 'employee cannot see a swap between two other people');
select pg_temp.assert_eq((select count(*) from public.geofences), 0, 'employee reads no geofence (the API evaluates in the system context)');
select pg_temp.assert_eq((select count(*) from public.geofence_assignments), 0, 'employee reads no geofence assignment');
select pg_temp.assert_raises($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-03', 'direct insert') $q$, 'employee cannot insert a note directly (API only)');
select pg_temp.assert_raises($q$ update public.attendance_notes set status = 'approved' where id = '0a000000-0000-0000-0000-000000000403' $q$, 'employee cannot approve own note');
select pg_temp.assert_raises($q$ update public.attendance_notes set note = 'edited' where id = '0a000000-0000-0000-0000-000000000403' $q$, 'employee cannot edit own note directly (API only)');
select pg_temp.assert_raises($q$ delete from public.attendance_notes where id = '0a000000-0000-0000-0000-000000000403' $q$, 'employee cannot delete own note');
select pg_temp.assert_raises($q$ insert into public.attendance_regularisation_requests (organization_id, employee_id, branch_id, attendance_date, type, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-04', 'wfh_unmarked', 'direct insert') $q$, 'employee cannot insert a regularisation directly');
select pg_temp.assert_raises($q$ update public.attendance_regularisation_requests set status = 'approved' where id = '0a000000-0000-0000-0000-000000000412' $q$, 'employee cannot approve own regularisation');
select pg_temp.assert_raises($q$ update public.employee_attendance_grants set open_attendance = true where employee_id = '0a000000-0000-0000-0000-0000000000e3' $q$, 'employee cannot grant self open attendance');
select pg_temp.assert_raises($q$ insert into public.selfie_checkins (organization_id, employee_id, branch_id, direction, photo_path) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', 'out', 'checkins/x/y/z.jpg') $q$, 'employee cannot insert a selfie row directly');
select pg_temp.assert_raises($q$ update public.selfie_checkins set status = 'approved', reviewed_at = now() where id = '0a000000-0000-0000-0000-000000000422' $q$, 'employee cannot approve own selfie');
select pg_temp.assert_raises($q$ update public.shift_swap_requests set status = 'approved' where id = '0a000000-0000-0000-0000-000000000461' $q$, 'employee cannot approve own swap');
select pg_temp.assert_raises($q$ insert into public.geofences (organization_id, name, latitude, longitude, radius_m) values ('0a000000-0000-0000-0000-000000000000', 'Home', 23.6, 58.4, 100) $q$, 'employee cannot create a geofence');
select pg_temp.assert_rows($q$ update public.geofences set radius_m = 5000 where id = '0a000000-0000-0000-0000-000000000432' $q$, 0, 'employee cannot widen the fence that applies to them');
select pg_temp.assert_rows($q$ delete from public.geofence_assignments where id = '0a000000-0000-0000-0000-000000000442' $q$, 0, 'employee cannot remove their fence assignment');
-- selfie photos: the checkins/ prefix is not an organisation id (no tenant storage policy matches) and a restrictive policy denies it
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%'), 0, 'employee cannot list selfie photos, not even their own');
select pg_temp.assert_eq((select count(*) from storage.objects where name = 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/s1.jpg'), 0, 'a same-org employee without rights reads 0 of a colleague''s selfie objects, even by exact name');
select pg_temp.assert_rows($q$ update storage.objects set name = name where bucket_id = 'employee-photos' and name like 'checkins/%' $q$, 0, 'employee cannot touch a selfie object');
select pg_temp.assert_rows($q$ delete from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%' $q$, 0, 'employee cannot delete a selfie object');
select pg_temp.assert_raises($q$ insert into storage.objects (bucket_id, name) values ('employee-photos', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e3/forged.jpg') $q$, 'employee cannot upload a selfie photo directly');
rollback;

-- ---------- as Line Manager A (role manager, linked to e4 = primary manager of e1) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 1, 'manager sees the direct report''s note only (attendance.view_team)');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'manager reads the report''s note');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where employee_id = '0a000000-0000-0000-0000-0000000000e6'), 0, 'a report of a report''s note is NOT visible (direct reports only)');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where employee_id in ('0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-0000000000e3')), 0, 'manager cannot read a non-report''s note');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 1, 'manager sees the report''s regularisation only');
select pg_temp.assert_eq((select count(*) from public.employee_attendance_grants), 1, 'manager sees the report''s attendance grant only');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 1, 'manager sees the report''s selfie only');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 1, 'manager sees the swap that names the report (shift.view alone opens no swap)');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests where id = '0a000000-0000-0000-0000-000000000462'), 1, 'manager reads the swap where the report is the colleague asked');
select pg_temp.assert_eq((select count(*) from public.geofences), 0, 'manager (no attendance.view) reads no geofence');
select pg_temp.assert_raises($q$ update public.attendance_notes set status = 'approved', reviewed_by = 'a0000000-0000-0000-0000-000000000005' where id = '0a000000-0000-0000-0000-000000000401' $q$, 'manager cannot approve a note by UPDATE (the engine decides)');
select pg_temp.assert_raises($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-05', 'on behalf') $q$, 'manager cannot file a note directly');
select pg_temp.assert_raises($q$ update public.employee_attendance_grants set selfie_required = true where employee_id = '0a000000-0000-0000-0000-0000000000e1' $q$, 'manager cannot change a grant by UPDATE (API only)');
select pg_temp.assert_raises($q$ update public.shift_swap_requests set status = 'approved' where id = '0a000000-0000-0000-0000-000000000462' $q$, 'manager cannot approve a swap by UPDATE');
select pg_temp.assert_raises($q$ insert into public.geofences (organization_id, name, latitude, longitude, radius_m) values ('0a000000-0000-0000-0000-000000000000', 'Team fence', 23.6, 58.4, 100) $q$, 'manager (no attendance.manage_geofences) cannot create a geofence');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%'), 0, 'even the direct report''s selfie photo is not readable from storage (the API signs a URL)');
rollback;

-- ---------- as Secondary Manager A (role manager, linked to e5 = secondary manager of e1) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 1, 'secondary manager sees the report''s note only');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'secondary manager reads the report''s note');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 1, 'secondary manager sees the report''s regularisation only');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 1, 'secondary manager sees the report''s selfie only');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 1, 'secondary manager sees the swap that names the report');
rollback;

-- ---------- as Branch Manager A (attendance.view scoped to branch A-2, not linked to an employee) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 3, 'branch manager sees the notes of branch A-2 (e2, e3, e6)');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where branch_id = '0a000000-0000-0000-0000-00000000000b'), 0, 'branch manager cannot read an HQ note');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 1, 'branch manager sees branch A-2''s regularisation only');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 1, 'branch manager sees branch A-2''s selfie only');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 3, 'branch manager sees branch A-2''s swaps');
select pg_temp.assert_eq((select count(*) from public.geofences), 2, 'branch manager sees branch A-2''s fence and the organisation-wide one');
select pg_temp.assert_eq((select count(*) from public.geofences where id = '0a000000-0000-0000-0000-000000000431'), 0, 'branch manager cannot read the HQ fence');
select pg_temp.assert_raises($q$ insert into public.geofences (organization_id, branch_id, name, latitude, longitude, radius_m) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000c', 'Yard', 23.6, 58.4, 100) $q$, 'branch manager (no attendance.manage_geofences) cannot create a fence');
select pg_temp.assert_rows($q$ update public.geofences set radius_m = 400 where id = '0a000000-0000-0000-0000-000000000432' $q$, 0, 'branch manager cannot edit a fence without attendance.manage_geofences');
select pg_temp.assert_raises($q$ update public.selfie_checkins set status = 'approved', reviewed_at = now() where id = '0a000000-0000-0000-0000-000000000422' $q$, 'branch manager cannot approve a selfie by UPDATE (API only)');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%'), 0, 'branch manager reads no selfie object');
rollback;

-- ---------- as Owner A (every key, organisation-wide) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 4, 'owner sees every note of org A');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 2, 'owner sees every regularisation of org A');
select pg_temp.assert_eq((select count(*) from public.employee_attendance_grants), 2, 'owner sees every attendance grant of org A');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 2, 'owner sees every selfie of org A');
select pg_temp.assert_eq((select count(*) from public.geofences), 3, 'owner sees every fence of org A');
select pg_temp.assert_eq((select count(*) from public.geofence_assignments), 2, 'owner sees every fence assignment of org A');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 3, 'owner sees every swap of org A');
select pg_temp.assert_eq((select count(*) from public.attendance_notes where organization_id = '0b000000-0000-0000-0000-000000000000')
  + (select count(*) from public.attendance_regularisation_requests where organization_id = '0b000000-0000-0000-0000-000000000000')
  + (select count(*) from public.employee_attendance_grants where organization_id = '0b000000-0000-0000-0000-000000000000')
  + (select count(*) from public.selfie_checkins where organization_id = '0b000000-0000-0000-0000-000000000000')
  + (select count(*) from public.geofences where organization_id = '0b000000-0000-0000-0000-000000000000')
  + (select count(*) from public.geofence_assignments where organization_id = '0b000000-0000-0000-0000-000000000000')
  + (select count(*) from public.shift_swap_requests where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B');
-- not even the owner writes the RPC-only tables directly
select pg_temp.assert_raises($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-06', 'owner insert') $q$, 'owner cannot insert a note directly');
select pg_temp.assert_raises($q$ update public.attendance_notes set status = 'excused' where id = '0a000000-0000-0000-0000-000000000401' $q$, 'owner cannot excuse a note by UPDATE');
select pg_temp.assert_raises($q$ delete from public.attendance_regularisation_requests where id = '0a000000-0000-0000-0000-000000000411' $q$, 'owner cannot delete a regularisation');
select pg_temp.assert_raises($q$ insert into public.employee_attendance_grants (employee_id, organization_id, open_attendance) values ('0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-000000000000', true) $q$, 'owner cannot insert a grant directly (API only, audited)');
select pg_temp.assert_raises($q$ delete from public.selfie_checkins where id = '0a000000-0000-0000-0000-000000000421' $q$, 'owner cannot delete a selfie row');
select pg_temp.assert_raises($q$ update public.shift_swap_requests set status = 'cancelled' where id = '0a000000-0000-0000-0000-000000000461' $q$, 'owner cannot cancel a swap by UPDATE');
-- geofences are configuration: attendance.manage_geofences writes them (RLS twice with the API)
select pg_temp.assert_rows($q$ insert into public.geofences (organization_id, branch_id, name, latitude, longitude, radius_m) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', 'Warehouse', 23.59, 58.39, 120) $q$, 1, 'owner (attendance.manage_geofences) creates a fence');
select pg_temp.assert_rows($q$ update public.geofences set radius_m = 200 where id = '0a000000-0000-0000-0000-000000000431' $q$, 1, 'owner edits a fence');
select pg_temp.assert_rows($q$ insert into public.geofence_assignments (organization_id, geofence_id, scope, target_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000433', 'employee', '0a000000-0000-0000-0000-0000000000e1') $q$, 1, 'owner assigns a fence');
select pg_temp.assert_rows($q$ delete from public.geofences where id = '0a000000-0000-0000-0000-000000000433' $q$, 1, 'owner deletes a fence');
select pg_temp.assert_eq((select count(*) from public.geofence_assignments where geofence_id = '0a000000-0000-0000-0000-000000000433'), 0, 'a deleted fence takes its assignments with it');
select pg_temp.assert_raises($q$ insert into public.geofences (organization_id, name, latitude, longitude, radius_m) values ('0b000000-0000-0000-0000-000000000000', 'Cross', 25.2, 55.27, 100) $q$, 'owner A cannot create a fence in org B');
select pg_temp.assert_rows($q$ update public.geofences set radius_m = 999 where id = '0b000000-0000-0000-0000-000000000431' $q$, 0, 'owner A cannot edit org B''s fence');
select pg_temp.assert_rows($q$ delete from public.geofence_assignments where id = '0b000000-0000-0000-0000-000000000441' $q$, 0, 'owner A cannot delete org B''s assignment');
-- selfie photos stay out of reach even for employee.view / employee.update holders
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%'), 0, 'owner cannot list selfie photos through the storage API (signed URLs only)');
select pg_temp.assert_raises($q$ insert into storage.objects (bucket_id, name) values ('employee-photos', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/forged.jpg') $q$, 'owner cannot upload into checkins/');
select pg_temp.assert_rows($q$ delete from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%' $q$, 0, 'owner cannot delete a selfie photo');
rollback;

-- ---------- the explicit denials survive a later GRANT ----------
begin;
grant insert, update, delete on public.attendance_notes, public.employee_attendance_grants, public.shift_swap_requests to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-07', 'after a grant') $q$, 'a re-granted INSERT is still refused by the restrictive policy');
select pg_temp.assert_rows($q$ update public.attendance_notes set status = 'approved' where id = '0a000000-0000-0000-0000-000000000401' $q$, 0, 'a re-granted UPDATE still matches no row');
select pg_temp.assert_rows($q$ delete from public.attendance_notes where id = '0a000000-0000-0000-0000-000000000401' $q$, 0, 'a re-granted DELETE still matches no row');
select pg_temp.assert_rows($q$ update public.employee_attendance_grants set open_attendance = true $q$, 0, 'a re-granted UPDATE on grants still matches no row');
select pg_temp.assert_rows($q$ update public.shift_swap_requests set status = 'approved' $q$, 0, 'a re-granted UPDATE on swaps still matches no row');
rollback;

-- ---------- a later, broader storage policy cannot open the checkins/ prefix ----------
begin;
create policy zz_test_broad_storage on storage.objects for all to authenticated using (true) with check (true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name = '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/profile.jpg'), 1, 'control: the broad policy opens the tenant-path photo to a plain employee');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%'), 0, 'the restrictive policy still hides every selfie object');
select pg_temp.assert_rows($q$ update storage.objects set name = name where bucket_id = 'employee-photos' and name like 'checkins/%' $q$, 0, 'the restrictive policy still refuses to change a selfie object');
select pg_temp.assert_rows($q$ delete from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%' $q$, 0, 'the restrictive policy still refuses to delete a selfie object');
select pg_temp.assert_raises($q$ insert into storage.objects (bucket_id, name) values ('employee-photos', 'checkins/0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/planted.jpg') $q$, 'the restrictive policy still refuses an upload into checkins/');
rollback;

-- ---------- as Auditor A (attendance.view + shift.view, organisation-wide, read-only) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 4, 'auditor reads every note of org A');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 2, 'auditor reads every regularisation of org A');
select pg_temp.assert_eq((select count(*) from public.employee_attendance_grants), 2, 'auditor reads every attendance grant of org A');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 2, 'auditor reads every selfie of org A');
select pg_temp.assert_eq((select count(*) from public.geofences), 3, 'auditor reads every fence of org A');
select pg_temp.assert_eq((select count(*) from public.geofence_assignments), 2, 'auditor reads every fence assignment of org A');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 3, 'auditor reads every swap of org A');
select pg_temp.assert_raises($q$ update public.attendance_notes set status = 'rejected' where id = '0a000000-0000-0000-0000-000000000401' $q$, 'auditor cannot decide a note');
select pg_temp.assert_raises($q$ insert into public.geofences (organization_id, name, latitude, longitude, radius_m) values ('0a000000-0000-0000-0000-000000000000', 'Audit', 23.6, 58.4, 100) $q$, 'auditor cannot create a fence');
select pg_temp.assert_rows($q$ update public.geofences set is_active = false where id = '0a000000-0000-0000-0000-000000000431' $q$, 0, 'auditor cannot disable a fence');
select pg_temp.assert_rows($q$ delete from public.geofence_assignments where id = '0a000000-0000-0000-0000-000000000441' $q$, 0, 'auditor cannot remove an assignment');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like 'checkins/%'), 0, 'the auditor reads no selfie object');
rollback;

-- ---------- as Owner B ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 1, 'owner B sees only org B''s note');
select pg_temp.assert_eq((select count(*) from public.attendance_regularisation_requests), 1, 'owner B sees only org B''s regularisation');
select pg_temp.assert_eq((select count(*) from public.employee_attendance_grants), 1, 'owner B sees only org B''s grant');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins), 1, 'owner B sees only org B''s selfie');
select pg_temp.assert_eq((select count(*) from public.geofences), 1, 'owner B sees only org B''s fence');
select pg_temp.assert_eq((select count(*) from public.geofence_assignments), 1, 'owner B sees only org B''s assignment');
select pg_temp.assert_eq((select count(*) from public.shift_swap_requests), 1, 'owner B sees only org B''s swap');
select pg_temp.assert_rows($q$ update public.geofences set radius_m = 999 where id = '0a000000-0000-0000-0000-000000000431' $q$, 0, 'owner B cannot edit org A''s fence');
select pg_temp.assert_raises($q$ insert into public.geofence_assignments (organization_id, geofence_id, scope, target_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000431', 'employee', '0a000000-0000-0000-0000-0000000000e2') $q$, 'owner B cannot assign org A''s fence');
rollback;

-- ---------- the system context (the API after its own checks) is the only writer ----------
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.attendance_notes), 4, 'system context for org A reads org A''s notes');
select pg_temp.assert_rows($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note, submitted_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-08', 'Client visit', 'a0000000-0000-0000-0000-000000000003') $q$, 1, 'system context files a note');
select pg_temp.assert_rows($q$ update public.attendance_notes set status = 'excused', reviewed_by = 'a0000000-0000-0000-0000-000000000001', reviewed_at = now(), review_via = 'oversight' where id = '0a000000-0000-0000-0000-000000000401' $q$, 1, 'system context records a decision');
select pg_temp.assert_rows($q$ insert into public.attendance_regularisation_requests (organization_id, employee_id, branch_id, attendance_date, type, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-08', 'system_downtime', 'Terminal down') $q$, 1, 'system context files a regularisation');
select pg_temp.assert_rows($q$ insert into public.employee_attendance_grants (employee_id, organization_id, open_attendance) values ('0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-000000000000', true) $q$, 1, 'system context writes a grant');
select pg_temp.assert_rows($q$ update public.selfie_checkins set status = 'rejected', reviewed_at = now(), review_reason = 'Blurry' where id = '0a000000-0000-0000-0000-000000000422' $q$, 1, 'system context records a selfie review');
select pg_temp.assert_rows($q$ update public.shift_swap_requests set status = 'approved' where id = '0a000000-0000-0000-0000-000000000461' $q$, 1, 'system context applies a swap decision');
select pg_temp.assert_raises($q$ insert into public.attendance_notes (organization_id, employee_id, branch_id, attendance_date, note) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '2026-09-08', 'cross-tenant') $q$, 'system context for org A cannot write org B');
select pg_temp.assert_rows($q$ update public.attendance_notes set status = 'approved' where id = '0b000000-0000-0000-0000-000000000401' $q$, 0, 'system context for org A cannot touch org B''s note');
select pg_temp.assert_eq((select count(*) from public.selfie_checkins where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'system context for org A reads nothing of org B');
rollback;
