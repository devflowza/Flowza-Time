-- Time away, meeting rooms and the manager team scope (migrations 20261015000100–300, docs/time-away.md). Runs as superuser
-- AFTER rls_isolation.sql (it reuses that suite's organisations, branches, employees, logins and roles):
--   Org A: e1 (HQ) reports to e4 (manager-a) and e5 (secondary-a); e6 (A-2) reports to e1 (an INDIRECT report of e4);
--          e3 is emp-a's own record (role employee); bm-a is scoped to branch A-2; auditor-a (read-only, all branches);
--          owner-a sees everything. Meetings: HQ review (HQ, invitees e1 + e3) and A-2 training (A-2, invitee e2).
-- Rules under test: time_away_requests are read like regularisations (attendance.view in branch scope, own rows, a line
-- manager's team) and written by the system context only; the team follows the organisation's scope (direct → direct reports,
-- hierarchy → the reporting line); meetings and rooms are read with meeting.view and written with meeting.manage /
-- meeting.rooms in branch scope; invitations follow their meeting (read where the meeting is readable, or one's own; written
-- with meeting.manage for a meeting inside the caller's branches); the team-scoped built-in Manager role holds no meeting key
-- (it would otherwise read and cancel every meeting of the organisation); access_events (a movement record) are read by meeting.rooms holders and the person
-- themself, and written by the system context only; nothing crosses organisations. Self-contained: every block rolls back.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
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
-- refused by row security / a missing privilege (42501) — not by a key, a constraint or any unrelated error
create or replace function pg_temp.assert_denied(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when insufficient_privilege then
    return;
  when others then
    raise exception 'ASSERT FAILED: % — expected a row-security refusal, got % (%)', label, sqlerrm, sqlstate;
  end;
  raise exception 'ASSERT FAILED: % — expected a row-security refusal', label;
end $$;
-- fixtures, as superuser inside the caller's transaction
create or replace function pg_temp.fixtures() returns void language plpgsql as $$
declare
  a uuid := '0a000000-0000-0000-0000-000000000000'; b uuid := '0b000000-0000-0000-0000-000000000000';
  hq uuid := '0a000000-0000-0000-0000-00000000000b'; a2 uuid := '0a000000-0000-0000-0000-00000000000c'; bhq uuid := '0b000000-0000-0000-0000-00000000000b';
  lvl uuid := '0a000000-0000-0000-0000-000000000901'; lvl_b uuid := '0b000000-0000-0000-0000-000000000901';
begin
  insert into public.time_away_requests (id, organization_id, employee_id, branch_id, attendance_date, kind, starts_at, ends_at, reason, status) values
    ('0a000000-0000-0000-0000-000000000911', a, '0a000000-0000-0000-0000-0000000000e1', hq, '2026-09-01', 'OFFICIAL', '2026-09-01 06:00+00', '2026-09-01 08:00+00', 'Client visit', 'approved'),
    ('0a000000-0000-0000-0000-000000000912', a, '0a000000-0000-0000-0000-0000000000e6', a2, '2026-09-01', 'PERSONAL', '2026-09-01 07:00+00', '2026-09-01 08:00+00', 'Clinic', 'pending'),
    ('0a000000-0000-0000-0000-000000000913', a, '0a000000-0000-0000-0000-0000000000e3', a2, '2026-09-01', 'PERSONAL', '2026-09-01 07:00+00', '2026-09-01 07:30+00', 'School', 'pending'),
    ('0b000000-0000-0000-0000-000000000911', b, '0b000000-0000-0000-0000-0000000000e1', bhq, '2026-09-01', 'OFFICIAL', '2026-09-01 06:00+00', '2026-09-01 07:00+00', 'Org B', 'pending');
  -- a Room level and one room place per branch (A HQ, A-2, B HQ); a room and a meeting in each; an ACCESS reader in A HQ
  insert into public.location_levels (id, organization_id, position, role, name, icon) values (lvl, a, 2, 'place', 'Room', 'room'), (lvl_b, b, 2, 'place', 'Room', 'room');
  insert into public.locations (id, organization_id, level_id, role, parent_id, code, name, path)
  select v.id, v.org, v.lvl, 'place', (select l.id from public.locations l where l.organization_id = v.org and l.role = 'branch' and l.branch_id = v.br), v.code, v.name, '{}'
  from (values ('0a000000-0000-0000-0000-000000000921'::uuid, a, lvl, hq, 'BRD', 'Boardroom'), ('0a000000-0000-0000-0000-000000000922'::uuid, a, lvl, a2, 'TRN', 'Training'),
               ('0b000000-0000-0000-0000-000000000921'::uuid, b, lvl_b, bhq, 'BRD', 'B Boardroom')) as v(id, org, lvl, br, code, name);
  insert into public.meeting_rooms (id, organization_id, branch_id, location_id, name, restricted) values
    ('0a000000-0000-0000-0000-000000000931', a, hq, '0a000000-0000-0000-0000-000000000921', 'Boardroom', true),
    ('0a000000-0000-0000-0000-000000000932', a, a2, '0a000000-0000-0000-0000-000000000922', 'Training', false),
    ('0b000000-0000-0000-0000-000000000931', b, bhq, '0b000000-0000-0000-0000-000000000921', 'B Boardroom', false);
  insert into public.meetings (id, organization_id, branch_id, room_id, title, starts_at, ends_at) values
    ('0a000000-0000-0000-0000-000000000941', a, hq, '0a000000-0000-0000-0000-000000000931', 'HQ review', '2026-09-01 06:00+00', '2026-09-01 07:00+00'),
    ('0a000000-0000-0000-0000-000000000942', a, a2, '0a000000-0000-0000-0000-000000000932', 'A-2 training', '2026-09-01 06:00+00', '2026-09-01 07:00+00'),
    ('0b000000-0000-0000-0000-000000000941', b, bhq, '0b000000-0000-0000-0000-000000000931', 'Org B meeting', '2026-09-01 06:00+00', '2026-09-01 07:00+00');
  insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values
    (a, '0a000000-0000-0000-0000-000000000941', '0a000000-0000-0000-0000-0000000000e1'), (a, '0a000000-0000-0000-0000-000000000941', '0a000000-0000-0000-0000-0000000000e3'),
    (a, '0a000000-0000-0000-0000-000000000942', '0a000000-0000-0000-0000-0000000000e2'), (b, '0b000000-0000-0000-0000-000000000941', '0b000000-0000-0000-0000-0000000000e1');
  insert into public.devices (id, organization_id, branch_id, location_id, code, name, provider_key, manufacturer, integration_type, timezone, punch_role) values
    ('0a000000-0000-0000-0000-000000000951', a, hq, '0a000000-0000-0000-0000-000000000921', 'BRD-1', 'Boardroom reader', 'mock', 'FlowZa', 'DEVICE_PUSH', 'Asia/Muscat', 'ACCESS');
  insert into public.access_events (organization_id, branch_id, device_id, location_id, room_id, employee_id, device_employee_id, occurred_at, raw_transaction_id) values
    (a, hq, '0a000000-0000-0000-0000-000000000951', '0a000000-0000-0000-0000-000000000921', '0a000000-0000-0000-0000-000000000931', '0a000000-0000-0000-0000-0000000000e1', '1', '2026-09-01 05:58+00', 9001),
    (a, hq, '0a000000-0000-0000-0000-000000000951', '0a000000-0000-0000-0000-000000000921', '0a000000-0000-0000-0000-000000000931', '0a000000-0000-0000-0000-0000000000e3', '3', '2026-09-01 06:04+00', 9002);
end $$;

-- ---------- catalogue ----------
select pg_temp.assert_eq((select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'approval_entity' and e.enumlabel = 'TIME_AWAY'), 1, 'approval_entity carries TIME_AWAY');
select pg_temp.assert_eq((select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'record_history_reason' and e.enumlabel = 'TIME_AWAY'), 1, 'record_history_reason carries TIME_AWAY');
select pg_temp.assert_eq((select count(*) from pg_class where relname in ('time_away_requests', 'meeting_rooms', 'meetings', 'meeting_invitees', 'access_events') and relnamespace = 'public'::regnamespace and relrowsecurity), 5, 'every new table has RLS');
select pg_temp.assert_eq((select count(*) from unnest(array['time_away_requests', 'access_events']) t
  where has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'delete')), 0, 'time away and room entries are written by the system context only');
select pg_temp.assert_eq((select count(*) from pg_proc where proname = '_team_of' and pronamespace = 'app'::regnamespace and has_function_privilege('authenticated', oid, 'execute')), 0, 'app._team_of is not callable by clients');
select pg_temp.assert_eq((select count(*) from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000009' and permission_key like 'meeting.%'), 0, 'the team-scoped built-in Manager role holds no meeting key');
select pg_temp.assert_eq((select count(*) from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000005' and permission_key in ('meeting.view', 'meeting.manage')), 2, 'the branch manager keeps meeting.view + meeting.manage (branch scope)');

-- ---------- as the line manager of e1 (manager-a), direct scope then hierarchy ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_away_requests), 1, 'direct scope: the line manager reads the direct report''s window only');
select pg_temp.assert_eq((select count(*) from public.time_away_requests where employee_id = '0a000000-0000-0000-0000-0000000000e6'), 0, 'direct scope: an indirect report''s window stays hidden');
select pg_temp.assert_raises($q$ insert into public.time_away_requests (organization_id, employee_id, branch_id, attendance_date, kind, starts_at, ends_at, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-02', 'OFFICIAL', '2026-09-02 06:00+00', '2026-09-02 07:00+00', 'direct write') $q$, 'nobody writes a window from a client session');
select pg_temp.assert_raises($q$ update public.time_away_requests set status = 'approved' where id = '0a000000-0000-0000-0000-000000000912' $q$, 'nobody approves a window from a client session');
-- no meeting key on the Manager role: its all-branches membership must not turn into the organisation's meetings / attendees
select pg_temp.assert_eq((select count(*) from public.meetings), 0, 'the Manager role reads no meeting of the organisation (team scope, no meeting.view)');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees), 0, 'nor anybody''s invitation (manager-a is invited to none)');
select pg_temp.assert_eq((select count(*) from public.meeting_rooms), 0, 'nor the rooms');
select pg_temp.assert_denied($q$ insert into public.meetings (organization_id, branch_id, room_id, title, starts_at, ends_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000931', 'Manager booking', '2026-09-02 06:00+00', '2026-09-02 07:00+00') $q$, 'the Manager role books no room');
with c as (update public.meetings set status = 'cancelled' where id = '0a000000-0000-0000-0000-000000000941' returning 1)
select pg_temp.assert_eq(count(*), 0, 'the Manager role cancels nobody''s meeting') from c;
select pg_temp.assert_eq((select count(*) from public.access_events), 0, 'without meeting.rooms the access log stays closed');
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.organization_settings (organization_id, attendance) values ('0a000000-0000-0000-0000-000000000000', '{"team":{"scope":"hierarchy"}}')
on conflict (organization_id) do update set attendance = coalesce(public.organization_settings.attendance, '{}'::jsonb) || '{"team":{"scope":"hierarchy"}}'::jsonb;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_away_requests), 2, 'hierarchy scope: the line manager reads the reporting line (e1 and e6)');
select pg_temp.assert_eq((select count(*) from unnest(app.team_employee_ids()) x), 2, 'hierarchy scope: the RLS team is e1 + e6');
rollback;

-- ---------- as Employee A (emp-a, linked to e3) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_away_requests), 1, 'an employee reads only their own window');
select pg_temp.assert_eq((select count(*) from public.access_events), 1, 'an employee reads only their own room entries');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees), 1, 'an employee reads only their own invitation');
select pg_temp.assert_eq((select count(*) from public.meetings), 0, 'an employee without meeting.view reads no meeting (the API serves their own)');
select pg_temp.assert_raises($q$ insert into public.meetings (organization_id, branch_id, room_id, title, starts_at, ends_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000931', 'mine', '2026-09-02 06:00+00', '2026-09-02 07:00+00') $q$, 'an employee cannot book a room');
select pg_temp.assert_denied($q$ insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000942', '0a000000-0000-0000-0000-0000000000e3') $q$, 'an employee cannot invite themself');
with d as (delete from public.meeting_invitees where employee_id = '0a000000-0000-0000-0000-0000000000e3' returning 1)
select pg_temp.assert_eq(count(*), 0, 'nor drop their own invitation') from d;
rollback;

-- ---------- as the branch manager of A-2 (bm-a) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.meetings), 1, 'a branch-scoped manager reads the meetings of their branch only');
select pg_temp.assert_eq((select count(*) from public.meeting_rooms), 1, 'a branch-scoped manager reads the rooms of their branch only');
select pg_temp.assert_raises($q$ insert into public.meetings (organization_id, branch_id, room_id, title, starts_at, ends_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000931', 'HQ booking', '2026-09-03 06:00+00', '2026-09-03 07:00+00') $q$, 'a branch-scoped manager cannot book a room of another branch');
-- invitations follow their meeting: the A-2 training's only (e2), never the HQ review's (e1, e3)
select pg_temp.assert_eq((select count(*) from public.meeting_invitees), 1, 'a branch-scoped manager reads the invitations of their branch''s meetings only');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees where meeting_id = '0a000000-0000-0000-0000-000000000942' and employee_id = '0a000000-0000-0000-0000-0000000000e2'), 1, 'the A-2 training''s invitee is visible');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees where meeting_id = '0a000000-0000-0000-0000-000000000941'), 0, 'no invitation of the HQ meeting');
select pg_temp.assert_denied($q$ insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000941', '0a000000-0000-0000-0000-0000000000e2') $q$, 'a branch-scoped manager cannot invite anybody to another branch''s meeting');
with d as (delete from public.meeting_invitees where meeting_id = '0a000000-0000-0000-0000-000000000941' returning 1)
select pg_temp.assert_eq(count(*), 0, 'nor drop an invitation of another branch''s meeting') from d;
with u as (update public.meeting_invitees set is_required = false where meeting_id = '0a000000-0000-0000-0000-000000000941' returning 1)
select pg_temp.assert_eq(count(*), 0, 'nor change one') from u;
insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000942', '0a000000-0000-0000-0000-0000000000e3');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees where meeting_id = '0a000000-0000-0000-0000-000000000942'), 2, 'a branch-scoped manager invites people to a meeting of their branch');
select pg_temp.assert_denied($q$ update public.meeting_invitees set meeting_id = '0a000000-0000-0000-0000-000000000941' where meeting_id = '0a000000-0000-0000-0000-000000000942' and employee_id = '0a000000-0000-0000-0000-0000000000e3' $q$, 'nor moves an invitation onto another branch''s meeting');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.assert_eq((select count(*) from public.meeting_invitees where meeting_id = '0a000000-0000-0000-0000-000000000941'), 2, 'the HQ meeting keeps its two invitations');
rollback;

-- ---------- as the auditor (auditor-a: meeting.view only, all branches) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.meetings), 2, 'meeting.view on an all-branches membership reads the organisation''s meetings (all branches)');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees), 3, 'and every invitation of them');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'nothing of organisation B');
select pg_temp.assert_denied($q$ insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000942', '0a000000-0000-0000-0000-0000000000e1') $q$, 'meeting.view alone invites nobody');
with d as (delete from public.meeting_invitees returning 1)
select pg_temp.assert_eq(count(*), 0, 'meeting.view alone drops no invitation') from d;
select pg_temp.assert_denied($q$ insert into public.meetings (organization_id, branch_id, room_id, title, starts_at, ends_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000931', 'Audit', '2026-09-03 06:00+00', '2026-09-03 07:00+00') $q$, 'meeting.view alone books no room');
rollback;

-- ---------- as Owner A ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_away_requests), 3, 'the owner reads every window of the organisation');
select pg_temp.assert_eq((select count(*) from public.time_away_requests where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'nothing of organisation B');
select pg_temp.assert_eq((select count(*) from public.meetings where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'no meeting of organisation B');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees), 3, 'the owner reads every invitation of the organisation');
insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000941', '0a000000-0000-0000-0000-0000000000e2');
select pg_temp.assert_eq((select count(*) from public.meeting_invitees where meeting_id = '0a000000-0000-0000-0000-000000000941'), 3, 'an all-branches meeting.manage holder invites people to any meeting of the organisation');
select pg_temp.assert_denied($q$ insert into public.meeting_invitees (organization_id, meeting_id, employee_id) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000941', '0b000000-0000-0000-0000-0000000000e1') $q$, 'but never to a meeting of organisation B');
select pg_temp.assert_eq((select count(*) from public.access_events), 2, 'meeting.rooms reads the organisation''s access log');
select pg_temp.assert_raises($q$ insert into public.access_events (organization_id, branch_id, device_id, employee_id, device_employee_id, occurred_at, raw_transaction_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000951', '0a000000-0000-0000-0000-0000000000e1', '1', now(), 9100) $q$, 'not even the owner writes a room entry');
select pg_temp.assert_raises($q$ insert into public.meetings (organization_id, branch_id, room_id, title, starts_at, ends_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000931', 'Clash', '2026-09-01 06:30+00', '2026-09-01 07:30+00') $q$, 'a room hosts one meeting at a time');
reset role;
select pg_temp.assert_raises($q$ update public.access_events set occurred_at = now() $q$, 'room entries are append-only');
rollback;
