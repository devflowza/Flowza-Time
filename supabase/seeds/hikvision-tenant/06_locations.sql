-- FlowZa Time · Hikvision test tenant seed · step 6: the location hierarchy (docs/locations.md, migration 20261010000100)
--
--   Levels (the CORPORATE template): Headquarters → Branch → Site → Floor → Zone
--   Muscat Headquarters (group) → the Ghala office and the Sohar Plant (branches)
--     Ghala office · Office Building → Ground Floor (Reception & Staff Entrance, Customer Service)
--                                    → First Floor (Finance & HR, IT & Operations)
--                                    → Second Floor (Management, Sales)
--     Sohar Plant  · Main Plant → Main Gate, Production Floor        (zones straight under the site: a level may be skipped)
--                  · Warehouse  → Loading Dock, Cold Store
--   Terminals: Ghala Staff Entrance → Reception & Staff Entrance, Sohar Plant Gate → Main Gate, Sohar Warehouse Dock →
--     Loading Dock (the real terminal "james" stays unplaced: set its location in Devices)
--   Work locations by department (in the home branch): CS → Customer Service; HR, FIN → Finance & HR; IT, OPS → IT &
--     Operations; MGMT → Management; SALES → Sales; WH → Warehouse; SEC → Main Gate; MNT → Production Floor
--   Coverage (Enterprise): at least one security officer at the Main Gate on the day and the night shift
--
-- Idempotent, one statement (the level list is checked at commit). It changes no attendance figure: no policy is scoped to
-- these places (scope one in Schedule → Policies to see the location dimension at work). Levels that were already changed by
-- hand are left alone and the step stops.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('78a5a348-69b6-4c51-8d72-3697f72c50f0'::uuid, 'hk-demo:' || p) $$;

do $$
declare
  org uuid := '78a5a348-69b6-4c51-8d72-3697f72c50f0';
  ghala uuid := '63751c8f-885c-4140-8bd7-1511876be027';
  sohar uuid := pg_temp.sid('branch:SOH');
  hr_id uuid := (select id from public.user_profiles where lower(email) = 'reddyprem1311@gmail.com');
  ghala_node uuid;
  sohar_node uuid;
begin
  if not exists (select 1 from public.organizations where id = org) then
    raise notice 'the Hikvision test tenant does not exist here — nothing to do';
    return;
  end if;

  -- levels: only while the organisation still has its single branch level (never overwrite levels someone changed)
  if not exists (select 1 from public.location_levels where organization_id = org and role <> 'branch') then
    update public.location_levels set position = 2, name = 'Branch', name_ar = 'فرع', icon = 'branch' where organization_id = org and role = 'branch';
    insert into public.location_levels (id, organization_id, position, role, name, name_ar, icon) values
      (pg_temp.sid('level:HQ'), org, 1, 'group', 'Headquarters', 'المقر الرئيسي', 'headquarters'),
      (pg_temp.sid('level:SITE'), org, 3, 'place', 'Site', 'موقع', 'site'),
      (pg_temp.sid('level:FLOOR'), org, 4, 'place', 'Floor', 'طابق', 'floor'),
      (pg_temp.sid('level:ZONE'), org, 5, 'place', 'Zone', 'منطقة', 'zone');
  elsif not exists (select 1 from public.location_levels where id = pg_temp.sid('level:ZONE')) then
    raise notice 'the location levels were changed by hand — the demo tree needs Headquarters / Site / Floor / Zone; skipped';
    return;
  end if;

  -- Headquarters and the two branches under it
  insert into public.locations (id, organization_id, level_id, code, name, name_ar, path, created_by)
  values (pg_temp.sid('loc:HQ'), org, pg_temp.sid('level:HQ'), 'HQ', 'Muscat Headquarters', 'المقر الرئيسي – مسقط', '{}', hr_id)
  on conflict (id) do nothing;
  update public.locations set parent_id = pg_temp.sid('loc:HQ')
  where organization_id = org and role = 'branch' and branch_id in (ghala, sohar) and parent_id is null;
  select id into ghala_node from public.locations where branch_id = ghala and role = 'branch';
  select id into sohar_node from public.locations where branch_id = sohar and role = 'branch';

  -- places, parents first
  insert into public.locations (id, organization_id, level_id, parent_id, code, name, name_ar, latitude, longitude, path, created_by)
  select pg_temp.sid('loc:' || p.code), org, pg_temp.sid('level:' || p.lvl), case p.parent when 'GHALA' then ghala_node else sohar_node end,
         p.code, p.name, p.name_ar, p.lat, p.lng, '{}', hr_id
  from (values
    ('GHL-BLDG', 'SITE', 'GHALA', 'Office Building', 'مبنى المكتب', 23.5859::numeric, 58.3854::numeric),
    ('PLANT',    'SITE', 'SOHAR', 'Main Plant',      'المصنع الرئيسي', null, null),
    ('WH',       'SITE', 'SOHAR', 'Warehouse',       'المستودع', null, null)
  ) as p(code, lvl, parent, name, name_ar, lat, lng)
  on conflict (id) do nothing;
  insert into public.locations (id, organization_id, level_id, parent_id, code, name, name_ar, path, created_by)
  select pg_temp.sid('loc:' || p.code), org, pg_temp.sid('level:FLOOR'), pg_temp.sid('loc:GHL-BLDG'), p.code, p.name, p.name_ar, '{}', hr_id
  from (values ('GF', 'Ground Floor', 'الطابق الأرضي'), ('F1', 'First Floor', 'الطابق الأول'), ('F2', 'Second Floor', 'الطابق الثاني')) as p(code, name, name_ar)
  on conflict (id) do nothing;
  insert into public.locations (id, organization_id, level_id, parent_id, code, name, name_ar, path, created_by)
  select pg_temp.sid('loc:' || p.code), org, pg_temp.sid('level:ZONE'), pg_temp.sid('loc:' || p.parent), p.code, p.name, p.name_ar, '{}', hr_id
  from (values
    ('ENT',   'GF',    'Reception & Staff Entrance', 'الاستقبال ومدخل الموظفين'),
    ('CS',    'GF',    'Customer Service',           'خدمة العملاء'),
    ('FINHR', 'F1',    'Finance & HR',               'المالية والموارد البشرية'),
    ('ITOPS', 'F1',    'IT & Operations',            'تقنية المعلومات والعمليات'),
    ('MGMT',  'F2',    'Management',                 'الإدارة'),
    ('SALES', 'F2',    'Sales',                      'المبيعات'),
    ('GATE',  'PLANT', 'Main Gate',                  'البوابة الرئيسية'),
    ('PROD',  'PLANT', 'Production Floor',           'صالة الإنتاج'),
    ('DOCK',  'WH',    'Loading Dock',               'رصيف التحميل'),
    ('COLD',  'WH',    'Cold Store',                 'المخزن المبرد')
  ) as p(code, parent, name, name_ar)
  on conflict (id) do nothing;

  -- the demo terminals where they are installed (a location someone set by hand is kept)
  update public.devices d set location_id = pg_temp.sid('loc:' || x.loc), updated_at = now()
  from (values ('GHL-02', 'ENT'), ('SOH-01', 'GATE'), ('SOH-02', 'DOCK')) as x(dev, loc)
  where d.id = pg_temp.sid('device:' || x.dev) and d.organization_id = org and d.location_id is null;

  -- work locations by department, in the employee's home branch (a work location set by hand is kept)
  update public.employees e set work_location_id = pg_temp.sid('loc:' || x.loc), updated_at = now()
  from (values ('CS', 'CS', 'GHALA'), ('HR', 'FINHR', 'GHALA'), ('FIN', 'FINHR', 'GHALA'), ('IT', 'ITOPS', 'GHALA'), ('OPS', 'ITOPS', 'GHALA'),
               ('MGMT', 'MGMT', 'GHALA'), ('SALES', 'SALES', 'GHALA'), ('WH', 'WH', 'SOHAR'), ('SEC', 'GATE', 'SOHAR'), ('MNT', 'PROD', 'SOHAR')) as x(dept, loc, br)
  where e.organization_id = org and e.deleted_at is null and e.work_location_id is null
    and e.department_id = pg_temp.sid('dept:' || x.dept) and e.branch_id = case x.br when 'GHALA' then ghala else sohar end;

  -- a zone-level coverage target next to the branch-wide ones
  insert into public.shift_coverage_requirements (id, organization_id, branch_id, shift_id, location_id, weekdays, min_headcount, created_by, created_at)
  select pg_temp.sid('coverage:GATE:' || s.code), org, sohar, pg_temp.sid('shift:' || s.code), pg_temp.sid('loc:GATE'), '{0,1,2,3,4,5,6}', 1, hr_id, now()
  from (values ('SEC-D'), ('SEC-N')) as s(code)
  where exists (select 1 from public.shifts where id = pg_temp.sid('shift:' || s.code))
  on conflict (organization_id, branch_id, shift_id, location_id) do update set min_headcount = excluded.min_headcount, updated_at = now();
end $$;

-- what it built
with o as (select '78a5a348-69b6-4c51-8d72-3697f72c50f0'::uuid as id)
select 'levels' as check, (select string_agg(l.name || ' (' || l.role || ')', ' → ' order by l.position) from public.location_levels l, o where l.organization_id = o.id) as result
union all select 'locations', (select string_agg(role::text || ' ' || n, ', ') from (select role, count(*) n from public.locations l, o where l.organization_id = o.id group by 1) x)
union all select 'placed terminals', (select count(*)::text from public.devices d, o where d.organization_id = o.id and d.location_id is not null)
union all select 'employees with a work location', (select count(*)::text from public.employees e, o where e.organization_id = o.id and e.work_location_id is not null and e.deleted_at is null)
union all select 'zone coverage targets', (select count(*)::text from public.shift_coverage_requirements c, o where c.organization_id = o.id and c.location_id is not null);
