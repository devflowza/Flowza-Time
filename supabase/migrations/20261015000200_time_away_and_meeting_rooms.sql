-- FlowZa Time · 20261015000200 · Time away during working hours, terminal punch roles, meeting rooms and room access
-- (docs/time-away.md). Additive and idempotent; one transaction; ends with a post-verify block.
--
--  1. `devices.punch_role` — what a terminal's punches MEAN, whatever the terminal reports:
--       AUTO       the punch direction the terminal reports (function keys / IN-OUT readers) — today's behaviour, the default;
--       CHECK_IN   an entry-only terminal: every punch is an arrival (a site with no exit reader — the employee steps out
--                  from the portal and checks back in here);
--       CHECK_OUT  an exit-only terminal: every punch is a departure;
--       ACCESS     a door / meeting-room reader: its punches are room access, never attendance (they land in
--                  `access_events`, not in `attendance_events`, so a meeting never splits a working day).
--  2. `time_away_requests` — time away from the site INSIDE the working day, decided through the approval engine (entity
--     TIME_AWAY): OFFICIAL duty (a client visit, a government office, the bank for the company — counted as worked when the
--     policy says so) or PERSONAL permission (excused, unpaid, within the policy's monthly quota). Filed ahead of time
--     (source `request`) or when stepping out from the portal (source `step_out`, which also records a break-out punch). The
--     engine classifies every measured away interval of the day against the APPROVED windows (official / permission /
--     break / unapproved). System-written (the API's system step), like regularisations.
--  3. `attendance_daily_records`: the engine's away figures — away (total), official duty, permission and unapproved minutes.
--     Constant defaults: a catalogue-only change on this hot table.
--  4. Meeting rooms (Enterprise module `meeting_rooms`): `meeting_rooms` (a place of the location tree with a capacity and an
--     optional restriction to departments / employees), `meetings` + `meeting_invitees`, and `access_events` — the room
--     entries the normaliser records from ACCESS terminals (append-only). Meeting attendance (who came, when, late, absent,
--     walk-ins) is derived from them at read time.
--  5. Permissions `meeting.view`, `meeting.manage`, `meeting.rooms`.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Terminal punch role
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'device_punch_role' and typnamespace = 'public'::regnamespace) then
    create type public.device_punch_role as enum ('AUTO', 'CHECK_IN', 'CHECK_OUT', 'ACCESS');
  end if;
end $$;
alter table public.devices add column if not exists punch_role public.device_punch_role not null default 'AUTO';
comment on column public.devices.punch_role is 'What the terminal''s punches mean: AUTO (reported direction), CHECK_IN (entry-only), CHECK_OUT (exit-only), ACCESS (door / meeting-room reader: room access, not attendance).';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Time away requests
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'time_away_kind' and typnamespace = 'public'::regnamespace) then
    create type public.time_away_kind as enum ('OFFICIAL', 'PERSONAL');
  end if;
  if not exists (select 1 from pg_type where typname = 'time_away_status' and typnamespace = 'public'::regnamespace) then
    create type public.time_away_status as enum ('pending', 'approved', 'rejected', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'time_away_source' and typnamespace = 'public'::regnamespace) then
    create type public.time_away_source as enum ('request', 'step_out');
  end if;
end $$;

create table if not exists public.time_away_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  -- the attendance date the window belongs to (branch timezone)
  attendance_date date not null,
  kind public.time_away_kind not null,
  source public.time_away_source not null default 'request',
  -- the approved window: a step-out starts when the employee stepped out and ends at the return they expected
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- step-out: when the employee came back (the portal's "I'm back", or the terminal punch the API saw first); informational
  returned_at timestamptz,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  destination text check (destination is null or length(btrim(destination)) between 1 and 200),
  status public.time_away_status not null default 'pending',
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  -- the raw transaction of the step-out punch (partitioned table: no foreign key)
  step_out_raw_id bigint,
  decided_by uuid references public.user_profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_away_requests_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint time_away_requests_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint time_away_requests_window check (ends_at > starts_at and ends_at - starts_at <= interval '16 hours'),
  constraint time_away_requests_returned check (returned_at is null or returned_at >= starts_at),
  -- two live requests of one employee never overlap (the service refuses first; this is the backstop)
  constraint time_away_requests_no_overlap exclude using gist (organization_id with =, employee_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status in ('pending', 'approved'))
);
comment on table public.time_away_requests is 'Time away from the site inside the working day (official duty / personal permission), decided through the approval engine (TIME_AWAY); the engine classifies measured away time against the approved windows (docs/time-away.md).';
create index if not exists time_away_requests_employee_idx on public.time_away_requests (organization_id, employee_id, attendance_date desc);
create index if not exists time_away_requests_pending_idx on public.time_away_requests (organization_id, attendance_date) where status = 'pending';
create index if not exists time_away_requests_approved_idx on public.time_away_requests (organization_id, employee_id, attendance_date) where status = 'approved';
create index if not exists time_away_requests_approval_idx on public.time_away_requests (approval_request_id) where approval_request_id is not null;
create index if not exists time_away_requests_branch_idx on public.time_away_requests (organization_id, branch_id);
create index if not exists time_away_requests_created_by_fk_idx on public.time_away_requests (created_by) where created_by is not null;
create index if not exists time_away_requests_decided_by_fk_idx on public.time_away_requests (decided_by) where decided_by is not null;
drop trigger if exists time_away_requests_updated_at on public.time_away_requests;
create trigger time_away_requests_updated_at before update on public.time_away_requests for each row execute function app.set_updated_at();
-- read like regularisations: attendance.view (branch scope), own rows, a line manager's team; written by the API's system step only
call app.apply_readonly_tenant_policies('public.time_away_requests', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Away figures on the daily record (hot table: nullable-free columns with constant defaults are catalogue-only)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.attendance_daily_records
  add column if not exists away_minutes integer not null default 0,
  add column if not exists official_duty_minutes integer not null default 0,
  add column if not exists permission_minutes integer not null default 0,
  add column if not exists unapproved_away_minutes integer not null default 0;
comment on column public.attendance_daily_records.away_minutes is 'Measured time away from the site between the first IN and the last OUT (breaks included), engine 1.5.0.';
comment on column public.attendance_daily_records.official_duty_minutes is 'Away minutes inside an approved OFFICIAL time-away window.';
comment on column public.attendance_daily_records.permission_minutes is 'Away minutes inside an approved PERSONAL time-away window (excused, unpaid).';
comment on column public.attendance_daily_records.unapproved_away_minutes is 'Away minutes beyond the breaks with no approved window.';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Module and permissions
-- ---------------------------------------------------------------------------------------------------------------------------
insert into public.modules (key, name, description, category, sort_order) values
  ('meeting_rooms', 'Meeting rooms & access', 'Room readers, meetings with invitees, who attended and when, and restricted rooms with an access log.', 'time', 120)
on conflict (key) do update set name = excluded.name, description = excluded.description, category = excluded.category, sort_order = excluded.sort_order
  where (public.modules.name, public.modules.description, public.modules.category, public.modules.sort_order)
        is distinct from (excluded.name, excluded.description, excluded.category, excluded.sort_order);
update public.plans set modules = modules || array['meeting_rooms'] where key = 'enterprise' and not (modules @> array['meeting_rooms']);

insert into public.permissions (key, category, description, sort_order) values
  ('meeting.view',   'meetings', 'See meetings and who attended them', 140),
  ('meeting.manage', 'meetings', 'Schedule and cancel meetings', 141),
  ('meeting.rooms',  'meetings', 'Configure meeting rooms and read the room access log', 142)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

-- owner, org admin, HR admin, attendance admin: everything; branch manager and line manager: meetings; HR user, auditor: read
insert into public.role_permissions (role_id, permission_key)
select r.id::uuid, k from (values
  ('10000000-0000-0000-0000-000000000001'), ('10000000-0000-0000-0000-000000000002'), ('10000000-0000-0000-0000-000000000003'), ('10000000-0000-0000-0000-000000000006')
) as r(id), unnest(array['meeting.view', 'meeting.manage', 'meeting.rooms']) as k
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select r.id::uuid, k from (values ('10000000-0000-0000-0000-000000000005'), ('10000000-0000-0000-0000-000000000009')) as r(id), unnest(array['meeting.view', 'meeting.manage']) as k
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select r.id::uuid, 'meeting.view' from (values ('10000000-0000-0000-0000-000000000004'), ('10000000-0000-0000-0000-000000000010')) as r(id)
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Meeting rooms, meetings, invitees
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'meeting_status' and typnamespace = 'public'::regnamespace) then
    create type public.meeting_status as enum ('scheduled', 'cancelled');
  end if;
end $$;

create table if not exists public.meeting_rooms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  -- the place of the location tree the room is (its readers are the ACCESS terminals placed there)
  location_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  capacity integer check (capacity is null or capacity between 1 and 1000),
  -- a restricted room admits its allowed departments / employees and the invitees of a meeting in progress; any other entry
  -- is reported as unauthorised (the reader itself enforces the door; FlowZa audits it)
  restricted boolean not null default false,
  allowed_department_ids uuid[] not null default '{}',
  allowed_employee_ids uuid[] not null default '{}',
  status public.record_status not null default 'active',
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_rooms_id_organization_id_key unique (id, organization_id),
  constraint meeting_rooms_location_key unique (organization_id, location_id),
  constraint meeting_rooms_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  constraint meeting_rooms_location_fkey foreign key (location_id, branch_id, organization_id) references public.locations(id, branch_id, organization_id),
  constraint meeting_rooms_allowed_size check (cardinality(allowed_department_ids) <= 200 and cardinality(allowed_employee_ids) <= 2000)
);
comment on table public.meeting_rooms is 'A meeting room: a place of the location tree with a capacity and an optional access restriction (Enterprise, meeting_rooms).';
create index if not exists meeting_rooms_branch_idx on public.meeting_rooms (organization_id, branch_id);
create index if not exists meeting_rooms_location_fk_idx on public.meeting_rooms (organization_id, location_id, branch_id);
create index if not exists meeting_rooms_created_by_fk_idx on public.meeting_rooms (created_by) where created_by is not null;
drop trigger if exists meeting_rooms_updated_at on public.meeting_rooms;
create trigger meeting_rooms_updated_at before update on public.meeting_rooms for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.meeting_rooms', 'meeting.view', 'meeting.rooms', 'branch_id');

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  room_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- an invitee who enters more than this many minutes after the start is late
  late_after_minutes smallint not null default 5 check (late_after_minutes between 0 and 120),
  organizer_employee_id uuid,
  status public.meeting_status not null default 'scheduled',
  cancelled_by uuid references public.user_profiles(id) on delete set null,
  cancelled_at timestamptz,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meetings_id_organization_id_key unique (id, organization_id),
  constraint meetings_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  constraint meetings_room_fkey foreign key (room_id, organization_id) references public.meeting_rooms(id, organization_id) on delete cascade,
  constraint meetings_organizer_fkey foreign key (organizer_employee_id, organization_id) references public.employees(id, organization_id) on delete set null (organizer_employee_id),
  constraint meetings_window check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours'),
  -- a room hosts one meeting at a time
  constraint meetings_no_double_booking exclude using gist (organization_id with =, room_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'scheduled')
);
comment on table public.meetings is 'A meeting in a meeting room; attendance is derived from the room''s access events (Enterprise, meeting_rooms).';
create index if not exists meetings_room_idx on public.meetings (organization_id, room_id, starts_at);
create index if not exists meetings_branch_idx on public.meetings (organization_id, branch_id, starts_at);
create index if not exists meetings_organizer_idx on public.meetings (organization_id, organizer_employee_id) where organizer_employee_id is not null;
create index if not exists meetings_created_by_fk_idx on public.meetings (created_by) where created_by is not null;
create index if not exists meetings_cancelled_by_fk_idx on public.meetings (cancelled_by) where cancelled_by is not null;
drop trigger if exists meetings_updated_at on public.meetings;
create trigger meetings_updated_at before update on public.meetings for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.meetings', 'meeting.view', 'meeting.manage', 'branch_id');

create table if not exists public.meeting_invitees (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  meeting_id uuid not null,
  employee_id uuid not null,
  is_required boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (meeting_id, employee_id),
  constraint meeting_invitees_meeting_fkey foreign key (meeting_id, organization_id) references public.meetings(id, organization_id) on delete cascade,
  constraint meeting_invitees_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade
);
create index if not exists meeting_invitees_employee_idx on public.meeting_invitees (organization_id, employee_id);
create index if not exists meeting_invitees_meeting_fk_idx on public.meeting_invitees (organization_id, meeting_id);
-- invitations: meeting.view holders, and every invitee reads their own
call app.apply_tenant_policies('public.meeting_invitees', 'meeting.view', 'meeting.manage', null, 'employee_id');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Room access events (append-only; written by the normaliser from ACCESS terminals)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.access_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  device_id uuid not null,
  -- where the reader was placed when the entry happened, and the meeting room there (if any)
  location_id uuid,
  room_id uuid,
  -- null when the terminal's user id matched nobody
  employee_id uuid,
  device_employee_id text not null,
  occurred_at timestamptz not null,
  direction public.punch_direction not null default 'unknown',
  -- the raw transaction it was normalised from (partitioned table: no foreign key)
  raw_transaction_id bigint not null,
  created_at timestamptz not null default now(),
  constraint access_events_raw_key unique (organization_id, raw_transaction_id),
  constraint access_events_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  constraint access_events_device_fkey foreign key (device_id, organization_id) references public.devices(id, organization_id) on delete cascade,
  constraint access_events_room_fkey foreign key (room_id, organization_id) references public.meeting_rooms(id, organization_id) on delete set null (room_id),
  constraint access_events_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete set null (employee_id)
);
comment on table public.access_events is 'Room / door entries recorded by ACCESS terminals (devices.punch_role); never attendance. Append-only.';
create index if not exists access_events_room_idx on public.access_events (organization_id, room_id, occurred_at) where room_id is not null;
create index if not exists access_events_employee_idx on public.access_events (organization_id, employee_id, occurred_at) where employee_id is not null;
create index if not exists access_events_device_idx on public.access_events (organization_id, device_id, occurred_at);
create index if not exists access_events_branch_idx on public.access_events (organization_id, branch_id, occurred_at);
drop trigger if exists access_events_append_only on public.access_events;
create trigger access_events_append_only before update on public.access_events for each row execute function app.reject_modification();
-- the access log is a movement record: the room administrators (meeting.rooms, branch scope) and the employee themself; meeting
-- attendance is served by the API from it for the meetings a caller can see
call app.apply_readonly_tenant_policies('public.access_events', 'meeting.rooms', 'branch_id', 'employee_id');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare v_table text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'public.devices'::regclass and attname = 'punch_role' and not attisdropped) then
    raise exception 'devices.punch_role missing';
  end if;
  if (select count(*) from pg_attribute where attrelid = 'public.attendance_daily_records'::regclass and not attisdropped
        and attname in ('away_minutes', 'official_duty_minutes', 'permission_minutes', 'unapproved_away_minutes')) <> 4 then
    raise exception 'attendance_daily_records: away columns missing';
  end if;
  if not exists (select 1 from public.plans where key = 'enterprise' and modules @> array['meeting_rooms']) then
    raise exception 'meeting_rooms: the enterprise plan does not include it';
  end if;
  if (select count(*) from public.permissions where key in ('meeting.view', 'meeting.manage', 'meeting.rooms')) <> 3 then
    raise exception 'meeting permissions missing';
  end if;
  foreach v_table in array array['time_away_requests', 'meeting_rooms', 'meetings', 'meeting_invitees', 'access_events'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || v_table)::regclass and relrowsecurity) then
      raise exception '% has no RLS', v_table;
    end if;
  end loop;
  foreach v_table in array array['time_away_requests', 'access_events'] loop
    if has_table_privilege('authenticated', 'public.' || v_table, 'insert') or has_table_privilege('authenticated', 'public.' || v_table, 'update')
       or has_table_privilege('authenticated', 'public.' || v_table, 'delete') then
      raise exception '% must be written by the system context only', v_table;
    end if;
  end loop;
end $$;
