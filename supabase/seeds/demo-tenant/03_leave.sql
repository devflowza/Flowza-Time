-- FlowZa Time · demo tenant seed · Majan Gulf Trading & Contracting LLC · step 3/5: six months of leave
--
-- 63 leave records (Mar–Sep 2026) across every configured type: approved, pending (upcoming), rejected and cancelled.
-- Approved leave drives the attendance engine (LEAVE status; Site Duty counts as present; No Pay counts with absences);
-- the other statuses are visible in the Leave page filters only. Must run after 02_people.sql.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('27bfe270-5dea-4587-aec3-0f5c23113261'::uuid, p) $$;

do $$
declare
  org uuid := '27bfe270-5dea-4587-aec3-0f5c23113261';
  owner_id uuid := '82f009ce-9248-4550-b030-896746ef2e73';
begin
  insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, source, external_ref, reason, approved_by, approved_at, created_by, created_at, updated_at)
  select pg_temp.sid('leave:' || v.num || ':' || v.code || ':' || v.s), org, e.id, e.branch_id, pg_temp.sid('leave-type:' || v.code), v.s::date, v.e::date, v.half, v.part::public.half_day_part,
         v.status::public.leave_status,
         case when v.code in ('ML', 'HJ') then 'EXTERNAL' else 'INTERNAL' end::public.leave_source,
         case when v.code in ('ML', 'HJ') then 'HRMS-LR-2026-' || lpad((row_number() over (order by v.s, v.num) * 37 % 9000 + 1000)::text, 4, '0') end,
         v.reason,
         case when v.status in ('APPROVED', 'CANCELLED') then case when v.num = 'MG-1002' then owner_id when e.branch_id = pg_temp.sid('branch:SOH') and v.num <> 'MG-2001' then pg_temp.sid('user:brmanager@flowza.ai') else pg_temp.sid('user:hradmin@flowza.ai') end end,
         case when v.status in ('APPROVED', 'CANCELLED') then ((v.s::date - v.lead) + time '13:20') at time zone 'Asia/Muscat' end,
         coalesce(u.id, pg_temp.sid('user:hruser@flowza.ai')),
         ((v.s::date - v.lead) + case when v.lead = 0 then time '08:40' else time '10:15' end) at time zone 'Asia/Muscat',
         case when v.status = 'CANCELLED' then ((v.s::date - 2) + time '15:05') at time zone 'Asia/Muscat' else ((v.s::date - v.lead) + time '13:20') at time zone 'Asia/Muscat' end
  from (values
    -- num, type, start, end, half-day, part, status, reason, days requested ahead
    ('MG-1005', 'AL',  '2026-04-12', '2026-04-23', false, null, 'APPROVED', 'Annual vacation – family visit to Kerala', 21),
    ('MG-1010', 'AL',  '2026-07-05', '2026-07-16', false, null, 'APPROVED', 'Annual leave – summer holiday', 30),
    ('MG-1011', 'AL',  '2026-03-24', '2026-03-26', false, null, 'APPROVED', 'Extended Eid al-Fitr break', 14),
    ('MG-1003', 'AL',  '2026-08-02', '2026-08-13', false, null, 'APPROVED', 'Annual leave', 28),
    ('MG-2001', 'AL',  '2026-06-21', '2026-06-25', false, null, 'APPROVED', 'Annual leave – Salalah khareef trip', 18),
    ('MG-3001', 'AL',  '2026-08-16', '2026-08-27', false, null, 'APPROVED', 'Annual leave', 25),
    ('MG-1021', 'AL',  '2026-05-03', '2026-05-14', false, null, 'APPROVED', 'Home leave – Philippines', 35),
    ('MG-2004', 'AL',  '2026-07-19', '2026-08-06', false, null, 'APPROVED', 'Annual leave – India (three weeks, biennial ticket)', 40),
    ('MG-4001', 'AL',  '2026-06-07', '2026-06-11', false, null, 'APPROVED', 'Annual leave', 12),
    ('MG-1012', 'AL',  '2026-08-23', '2026-08-27', false, null, 'APPROVED', 'Annual leave – Onam festival', 20),
    ('MG-1019', 'AL',  '2026-05-31', '2026-06-04', false, null, 'APPROVED', 'Post-Eid annual leave', 15),
    ('MG-6002', 'AL',  '2026-04-05', '2026-04-16', false, null, 'APPROVED', 'Home leave – Bangladesh', 30),
    ('MG-1014', 'AL',  '2026-06-28', '2026-07-09', false, null, 'APPROVED', 'Annual leave – Manila', 30),
    ('MG-5001', 'AL',  '2026-07-26', '2026-07-30', false, null, 'APPROVED', 'Annual leave', 10),
    ('MG-1002', 'AL',  '2026-08-09', '2026-08-20', false, null, 'APPROVED', 'Annual leave', 20),
    ('MG-3004', 'AL',  '2026-05-10', '2026-05-21', false, null, 'APPROVED', 'Home leave – Pakistan', 30),
    ('MG-1008', 'AL',  '2026-07-12', '2026-07-14', false, null, 'APPROVED', 'Annual leave', 7),
    ('MG-4002', 'AL',  '2026-07-05', '2026-07-09', false, null, 'APPROVED', 'Annual leave (re-submitted after the June request was declined)', 14),
    ('MG-1013', 'AL',  '2026-09-20', '2026-09-24', false, null, 'PENDING',  'Annual leave – wedding in Sur', 14),
    ('MG-2002', 'AL',  '2026-09-27', '2026-10-01', false, null, 'PENDING',  'Annual leave', 20),
    ('MG-1024', 'AL',  '2026-10-04', '2026-10-15', false, null, 'PENDING',  'Home leave – Kerala (Diwali)', 27),
    ('MG-4002', 'AL',  '2026-06-14', '2026-06-18', false, null, 'REJECTED', 'Annual leave – declined: peak season at the branch, re-apply for July', 12),
    ('MG-1007', 'AL',  '2026-05-17', '2026-05-21', false, null, 'CANCELLED', 'Annual leave – cancelled by employee, trip postponed', 20),
    ('MG-5002', 'AL',  '2026-08-30', '2026-09-03', false, null, 'CANCELLED', 'Annual leave – cancelled, covering for a colleague', 15),
    ('MG-1004', 'SL',  '2026-03-10', '2026-03-10', false, null, 'APPROVED', 'Sick leave – fever', 0),
    ('MG-1012', 'SL',  '2026-04-07', '2026-04-08', false, null, 'APPROVED', 'Sick leave – medical certificate (viral infection)', 0),
    ('MG-1016', 'SL',  '2026-05-19', '2026-05-19', false, null, 'APPROVED', 'Sick leave – migraine', 0),
    ('MG-2003', 'SL',  '2026-06-15', '2026-06-16', false, null, 'APPROVED', 'Sick leave – medical certificate', 0),
    ('MG-1022', 'SL',  '2026-07-21', '2026-07-21', false, null, 'APPROVED', 'Sick leave', 0),
    ('MG-3002', 'SL',  '2026-03-30', '2026-03-31', false, null, 'APPROVED', 'Sick leave – medical certificate', 0),
    ('MG-1009', 'SL',  '2026-08-04', '2026-08-06', false, null, 'APPROVED', 'Sick leave – medical certificate (influenza)', 0),
    ('MG-5003', 'SL',  '2026-04-27', '2026-04-27', false, null, 'APPROVED', 'Sick leave – clinic visit', 0),
    ('MG-1018', 'SL',  '2026-06-02', '2026-06-04', false, null, 'APPROVED', 'Sick leave – medical certificate (back strain)', 0),
    ('MG-4003', 'SL',  '2026-08-18', '2026-08-18', false, null, 'APPROVED', 'Sick leave', 0),
    ('MG-6003', 'SL',  '2026-05-05', '2026-05-06', false, null, 'APPROVED', 'Sick leave – medical certificate', 0),
    ('MG-1026', 'SL',  '2026-04-14', '2026-04-14', false, null, 'APPROVED', 'Sick leave', 0),
    ('MG-1006', 'SL',  '2026-06-10', '2026-06-10', true,  'SECOND_HALF', 'APPROVED', 'Dental appointment (afternoon)', 2),
    ('MG-1011', 'EL',  '2026-05-12', '2026-05-12', false, null, 'APPROVED', 'Emergency leave – family matter', 0),
    ('MG-2005', 'EL',  '2026-07-08', '2026-07-08', false, null, 'APPROVED', 'Emergency leave', 0),
    ('MG-3006', 'EL',  '2026-04-20', '2026-04-20', false, null, 'APPROVED', 'Emergency leave – vehicle breakdown en route', 0),
    ('MG-1023', 'EL',  '2026-08-11', '2026-08-11', false, null, 'APPROVED', 'Emergency leave – hospital visit (family)', 0),
    ('MG-4004', 'EL',  '2026-06-24', '2026-06-24', true,  'FIRST_HALF',  'APPROVED', 'Emergency leave – school pickup (morning)', 0),
    ('MG-1008', 'CL',  '2026-03-12', '2026-03-12', false, null, 'APPROVED', 'Casual leave – personal errand', 3),
    ('MG-1013', 'CL',  '2026-06-03', '2026-06-03', false, null, 'APPROVED', 'Casual leave', 2),
    ('MG-2006', 'CL',  '2026-08-05', '2026-08-06', false, null, 'APPROVED', 'Casual leave – family occasion', 5),
    ('MG-1015', 'CL',  '2026-04-29', '2026-04-29', false, null, 'APPROVED', 'Casual leave', 4),
    ('MG-3003', 'CL',  '2026-07-15', '2026-07-15', false, null, 'APPROVED', 'Casual leave – embassy appointment', 6),
    ('MG-1020', 'CL',  '2026-05-06', '2026-05-06', true,  'SECOND_HALF', 'APPROVED', 'Casual leave – afternoon', 2),
    ('MG-1013', 'SPL', '2026-04-26', '2026-04-28', false, null, 'APPROVED', 'Marriage leave (three days)', 21),
    ('MG-2002', 'SPL', '2026-08-30', '2026-09-01', false, null, 'APPROVED', 'Bereavement leave – three days', 0),
    ('MG-1017', 'ML',  '2026-06-01', '2026-09-06', false, null, 'APPROVED', 'Maternity leave – 98 days per the Labour Law (Royal Decree 53/2023)', 45),
    ('MG-1011', 'PTL', '2026-08-16', '2026-08-22', false, null, 'APPROVED', 'Paternity leave – seven days, newborn daughter', 3),
    ('MG-1015', 'HJ',  '2026-05-17', '2026-05-31', false, null, 'APPROVED', 'Hajj leave – 15 days (once during service)', 60),
    ('MG-6002', 'NP',  '2026-08-09', '2026-08-13', false, null, 'APPROVED', 'Unpaid leave – extended stay after home leave (visa renewal)', 10),
    ('MG-3006', 'NP',  '2026-07-26', '2026-07-28', false, null, 'APPROVED', 'Unpaid leave – annual balance exhausted', 7),
    ('MG-1026', 'NP',  '2026-07-05', '2026-07-09', false, null, 'APPROVED', 'Unpaid leave – relocation before resignation', 10),
    ('MG-1020', 'SD',  '2026-03-15', '2026-03-17', false, null, 'APPROVED', 'Client visits – Sohar Freezone tender', 5),
    ('MG-1019', 'SD',  '2026-04-21', '2026-04-21', false, null, 'APPROVED', 'Site duty – customer meetings in Barka', 3),
    ('MG-2002', 'SD',  '2026-06-10', '2026-06-11', false, null, 'APPROVED', 'Site duty – Sohar Port client survey', 4),
    ('MG-6001', 'SD',  '2026-05-03', '2026-05-07', false, null, 'APPROVED', 'Vendor inspection and training – Muscat head office', 7),
    ('MG-1009', 'SD',  '2026-07-27', '2026-07-28', false, null, 'APPROVED', 'Data-centre visit – Barka', 5),
    ('MG-1023', 'SD',  '2026-03-08', '2026-03-09', false, null, 'APPROVED', 'Site duty – Duqm site review', 6)
  ) as v(num, code, s, e, half, part, status, reason, lead)
  join public.employees e on e.organization_id = org and e.employee_number = v.num
  left join public.user_profiles u on u.id = e.user_id
  on conflict (id) do update set start_date = excluded.start_date, end_date = excluded.end_date, is_half_day = excluded.is_half_day, half_day_part = excluded.half_day_part, status = excluded.status, source = excluded.source,
    external_ref = excluded.external_ref, reason = excluded.reason, approved_by = excluded.approved_by, approved_at = excluded.approved_at, branch_id = excluded.branch_id, updated_at = now();
end $$;

select 'leave' as step, status, count(*) from public.leave_records where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261' group by status order by status;
