-- FlowZa Time · demo tenant seed · Majan Gulf Trading & Contracting LLC · step 2/5: logins, employees, teams
--
-- Logins (all with password Test@1234): acme@flowza.ai (owner, existing) · orgadmin@ · hradmin@ · hruser@ · payroll@ ·
-- attadmin@ · brmanager@ (Sohar only) · employee@flowza.ai. Auth rows are written directly with a bcrypt hash — the
-- same shape Supabase Auth itself writes — so this file must run on the admin connection.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('27bfe270-5dea-4587-aec3-0f5c23113261'::uuid, p) $$;
create or replace function pg_temp.u(p text) returns double precision language sql immutable as
$$ select (('x' || substr(md5('majan-2026:' || p), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0 $$;

do $$
declare
  org uuid := '27bfe270-5dea-4587-aec3-0f5c23113261';
  owner_id uuid := '82f009ce-9248-4550-b030-896746ef2e73';
  hradmin_id uuid := pg_temp.sid('user:hradmin@flowza.ai');
  t0 timestamptz := '2026-02-16 09:00:00+04';
  pw text := extensions.crypt('Test@1234', extensions.gen_salt('bf', 10));
  r record;
begin
  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Logins: auth users, identities, profiles
  ---------------------------------------------------------------------------------------------------------------------
  for r in select * from (values
      ('orgadmin@flowza.ai',  'Khalid Al Harthi'),
      ('hradmin@flowza.ai',   'Fatma Al Balushi'),
      ('hruser@flowza.ai',    'Aisha Al Rawahi'),
      ('payroll@flowza.ai',   'Maryam Al Siyabi'),
      ('attadmin@flowza.ai',  'Zainab Al Zadjali'),
      ('brmanager@flowza.ai', 'Said Al Rawahi'),
      ('employee@flowza.ai',  'Priya Sharma')
    ) as v(email, full_name)
  loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, email_change_confirm_status, phone_change, phone_change_token, reauthentication_token, created_at, updated_at)
    values (pg_temp.sid('user:' || r.email), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', r.email, pw, t0,
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('sub', pg_temp.sid('user:' || r.email)::text, 'email', r.email, 'full_name', r.full_name, 'email_verified', true, 'phone_verified', false),
      false, false, '', '', '', '', '', 0, '', '', '', t0, now())
    on conflict (id) do update set encrypted_password = excluded.encrypted_password, raw_user_meta_data = excluded.raw_user_meta_data, email_confirmed_at = coalesce(auth.users.email_confirmed_at, now()), updated_at = now();

    insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    values (pg_temp.sid('user:' || r.email)::text, pg_temp.sid('user:' || r.email),
      jsonb_build_object('sub', pg_temp.sid('user:' || r.email)::text, 'email', r.email, 'email_verified', true, 'phone_verified', false), 'email', t0, now())
    on conflict (provider_id, provider) do update set identity_data = excluded.identity_data, updated_at = now();

    insert into public.user_profiles (id, email, full_name, locale, status, created_at)
    values (pg_temp.sid('user:' || r.email), r.email, r.full_name, 'en', 'active', t0)
    on conflict (id) do update set full_name = excluded.full_name, status = 'active', updated_at = now();
  end loop;

  -- the existing owner keeps its id and password; it becomes the Managing Director
  update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('full_name', 'Hamad Al Busaidi'), encrypted_password = pw, updated_at = now() where id = owner_id;
  update public.user_profiles set full_name = 'Hamad Al Busaidi', updated_at = now() where id = owner_id;

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Employees (53): head office 26, Sohar 8, Salalah 6, Nizwa 4, Sur 4, Duqm 5 — incl. two joiners and two leavers
  --    inside the six-month window and one branch transfer (Anita Kumar, HQ → Sohar on 1 Jun 2026).
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.employees (id, organization_id, employee_number, first_name, middle_name, last_name, display_name, display_name_ar, gender, date_of_birth, nationality_code, email, phone, joining_date, exit_date,
    employment_status, employment_type, branch_id, department_id, designation_id, manager_employee_id, user_id, device_user_id, card_number, fingerprint_enrolled, face_enrolled, weekly_off_days, custom_fields, created_by, created_at)
  select pg_temp.sid('emp:' || v.num), org, v.num, v.first, v.middle, v.last, v.first || ' ' || v.last, v.name_ar, v.gender::public.gender, v.dob::date, v.nat, v.email, v.phone, v.joining::date, v.exit_d::date,
    v.status::public.employment_status, v.etype::public.employment_type, pg_temp.sid('branch:' || v.branch), pg_temp.sid('dept:' || v.dept), pg_temp.sid('desig:' || v.desig),
    case when v.mgr is null then null else pg_temp.sid('emp:' || v.mgr) end,
    case when v.email = 'acme@flowza.ai' then owner_id when v.email like '%@flowza.ai' then pg_temp.sid('user:' || v.email) else null end,
    v.pin, v.card, v.fp, v.face, null,
    jsonb_build_object('ramadanEligible', v.ramadan, 'bloodGroup', v.blood, 'maritalStatus', v.marital, 'grade', v.grade,
                       'emergencyContact', jsonb_build_object('name', v.ec_name, 'phone', v.ec_phone, 'relation', v.ec_rel)),
    hradmin_id, greatest(t0, (v.joining::date::timestamp) at time zone 'Asia/Muscat')
  from (values
    -- num, first, middle, last, name_ar, gender, dob, nat, email, phone, joining, exit, status, type, branch, dept, desig, manager, pin, card, fp, face, ramadan, blood, marital, ec_name, ec_phone, ec_rel, grade
    ('MG-1001','Hamad','Said','Al Busaidi','حمد بن سعيد البوسعيدي','male','1972-04-15','OM','acme@flowza.ai','+968 9911 2001','2018-03-01',null,'active','full_time','MCT-HQ','MGMT','MD',null,'1001','0100000001',true,true,true,'O+','married','Said Al Busaidi','+968 9911 2101','father','E1'),
    ('MG-1002','Khalid','Nasser','Al Harthi','خالد بن ناصر الحارثي','male','1978-09-02','OM','orgadmin@flowza.ai','+968 9922 3002','2019-06-16',null,'active','full_time','MCT-HQ','MGMT','GM','MG-1001','1002','0100000002',true,true,true,'A+','married','Muna Al Harthi','+968 9922 3102','spouse','E2'),
    ('MG-1003','Fatma','Ali','Al Balushi','فاطمة بنت علي البلوشية','female','1983-01-21','OM','hradmin@flowza.ai','+968 9933 4003','2019-09-01',null,'active','full_time','MCT-HQ','HR','HRM','MG-1002','1003','0100000003',true,true,true,'B+','married','Ali Al Balushi','+968 9933 4103','father','M1'),
    ('MG-1004','Aisha','Salim','Al Rawahi','عائشة بنت سالم الرواحية','female','1994-06-30','OM','hruser@flowza.ai','+968 9944 5004','2022-02-13',null,'active','full_time','MCT-HQ','HR','HRE','MG-1003','1004','0100000004',true,false,true,'O-','single','Salim Al Rawahi','+968 9944 5104','father','S2'),
    ('MG-1005','Rajesh','Kumar','Nair','راجيش كومار ناير','male','1975-11-08','IN','rajesh.nair@majangulf.om','+968 9555 6005','2017-11-05',null,'active','full_time','MCT-HQ','FIN','FM','MG-1002','1005','0100000005',true,true,false,'AB+','married','Lakshmi Nair','+968 9555 6105','spouse','M1'),
    ('MG-1006','Maryam','Hamed','Al Siyabi','مريم بنت حمد السيابية','female','1990-03-12','OM','payroll@flowza.ai','+968 9966 7006','2021-04-18',null,'active','full_time','MCT-HQ','PAY','PAYS','MG-1005','1006','0100000006',true,true,true,'A-','married','Hamed Al Siyabi','+968 9966 7106','father','S3'),
    ('MG-1007','Suresh',null,'Pillai','سوريش بيلاي','male','1981-07-19','IN','suresh.pillai@majangulf.om','+968 9577 8007','2020-01-12',null,'active','full_time','MCT-HQ','FIN','SACC','MG-1005','1007','0100000007',true,false,false,'B-','married','Anitha Pillai','+91 98470 22107','spouse','S3'),
    ('MG-1008','Noor','Yousuf','Al Kindi','نور بنت يوسف الكندية','female','1997-12-05','OM','noor.alkindi@majangulf.om','+968 9788 9008','2023-08-20',null,'active','full_time','MCT-HQ','FIN','ACC','MG-1005','1008','0100000008',true,true,true,'O+','single','Yousuf Al Kindi','+968 9788 9108','father','S2'),
    ('MG-1009','Imran','Tariq','Khan','عمران طارق خان','male','1979-02-27','PK','imran.khan@majangulf.om','+968 9199 1009','2018-10-07',null,'active','full_time','MCT-HQ','IT','ITM','MG-1002','1009','0100000009',true,true,true,'A+','married','Sadia Khan','+968 9199 1109','spouse','M1'),
    ('MG-1010','Arun','Vijay','Menon','أرون فيجاي مينون','male','1986-05-14','IN','arun.menon@majangulf.om','+968 9211 2010','2019-02-24',null,'active','full_time','MCT-HQ','IT','TL','MG-1009','1010','0100000010',true,true,false,'O+','married','Kavya Menon','+968 9211 2110','spouse','S4'),
    ('MG-1011','Salim','Hilal','Al Hinai','سالم بن هلال الهنائي','male','1991-08-23','OM','salim.alhinai@majangulf.om','+968 9322 3011','2020-08-09',null,'active','full_time','MCT-HQ','IT','SSE','MG-1010','1011','0100000011',true,true,true,'B+','married','Hilal Al Hinai','+968 9322 3111','father','S3'),
    ('MG-1012','Priya','Ramesh','Sharma','بريا راميش شارما','female','1995-10-02','IN','employee@flowza.ai','+968 9433 4012','2022-05-15',null,'active','full_time','MCT-HQ','IT','SE','MG-1010','1012','0100000012',true,true,false,'A+','single','Ramesh Sharma','+91 98200 44012','father','S2'),
    ('MG-1013','Mohammed','Abdullah','Al Farsi','محمد بن عبدالله الفارسي','male','1998-01-17','OM','mohammed.alfarsi@majangulf.om','+968 9544 5013','2024-01-07',null,'active','full_time','MCT-HQ','IT','SE','MG-1010','1013','0100000013',true,false,true,'O-','married','Abdullah Al Farsi','+968 9544 5113','father','S1'),
    ('MG-1014','Joseph','Mark','Santos','جوزيف مارك سانتوس','male','1988-04-09','PH','joseph.santos@majangulf.om','+968 9655 6014','2021-10-03',null,'active','full_time','MCT-HQ','IT','ITSE','MG-1009','1014','0100000014',true,true,false,'B+','married','Maria Santos','+63 917 555 6014','spouse','S3'),
    ('MG-1015','Said','Khalfan','Al Amri','سعيد بن خلفان العامري','male','1976-06-11','OM','said.alamri@majangulf.om','+968 9766 7015','2018-05-20',null,'active','full_time','MCT-HQ','ADM','ADMM','MG-1002','1015','0100000015',true,true,true,'A+','married','Khalfan Al Amri','+968 9766 7115','father','M1'),
    ('MG-1016','Zainab','Rashid','Al Zadjali','زينب بنت راشد الزدجالية','female','1992-09-28','OM','attadmin@flowza.ai','+968 9877 8016','2021-01-10',null,'active','full_time','MCT-HQ','ADM','ATTA','MG-1015','1016','0100000016',true,true,true,'O+','married','Rashid Al Zadjali','+968 9877 8116','father','S3'),
    ('MG-1017','Huda','Majid','Al Habsi','هدى بنت ماجد الحبسية','female','1996-02-14','OM','huda.alhabsi@majangulf.om','+968 9988 9017','2023-03-05',null,'active','full_time','MCT-HQ','ADM','AA','MG-1015','1017','0100000017',true,true,true,'A-','married','Majid Al Habsi','+968 9988 9117','father','S1'),
    ('MG-1018','Bilal','Ahmed','Rahman','بلال أحمد رحمن','male','1984-12-20','BD','bilal.rahman@majangulf.om','+968 9111 2018','2019-11-17',null,'active','full_time','MCT-HQ','ADM','DRV','MG-1015','1018','0100000018',true,false,true,'B+','married','Ahmed Rahman','+880 1711 200018','father','G1'),
    ('MG-1019','Nasser','Saif','Al Maskari','ناصر بن سيف المسكري','male','1980-10-30','OM','nasser.almaskari@majangulf.om','+968 9222 3019','2019-04-14',null,'active','full_time','MCT-HQ','SALES','SM','MG-1002','1019','0100000019',true,true,true,'O+','married','Saif Al Maskari','+968 9222 3119','father','M1'),
    ('MG-1020','Talal','Sultan','Al Busaidi','طلال بن سلطان البوسعيدي','male','1993-07-07','OM','talal.albusaidi@majangulf.om','+968 9333 4020','2022-09-11',null,'active','full_time','MCT-HQ','BD','BDE','MG-1019','1020','0100000020',true,true,true,'A+','single','Sultan Al Busaidi','+968 9333 4120','father','S3'),
    ('MG-1021','Grace','Ann','Reyes','غريس آن رييس','female','1990-11-25','PH','grace.reyes@majangulf.om','+968 9444 5021','2021-06-06',null,'active','full_time','MCT-HQ','CS','CSE','MG-1022','1021','0100000021',true,true,false,'O+','single','Ann Reyes','+63 918 555 5021','mother','S2'),
    ('MG-1022','Faisal','Hamood','Al Rawahi','فيصل بن حمود الرواحي','male','1987-03-03','OM','faisal.alrawahi@majangulf.om','+968 9555 6022','2020-03-15',null,'active','full_time','MCT-HQ','CS','TL','MG-1023','1022','0100000022',true,true,true,'B+','married','Hamood Al Rawahi','+968 9555 6122','father','S4'),
    ('MG-1023','Hassan','Mahmoud','Ibrahim','حسن محمود إبراهيم','male','1977-08-16','EG','hassan.ibrahim@majangulf.om','+968 9666 7023','2018-08-26',null,'active','full_time','MCT-HQ','OPS','OPM','MG-1002','1023','0100000023',true,true,true,'A+','married','Mona Ibrahim','+968 9666 7123','spouse','M1'),
    ('MG-1024','Deepa','Anil','Kumar','ديبا أنيل كومار','female','1999-04-22','IN','deepa.kumar@majangulf.om','+968 9777 8024','2024-06-02',null,'active','full_time','MCT-HQ','CS','CSE','MG-1022','1024','0100000024',true,true,false,'O-','single','Anil Kumar','+91 98950 88024','father','S1'),
    ('MG-1025','Amal','Saif','Al Harthi','أمل بنت سيف الحارثية','female','2000-05-19','OM','amal.alharthi@majangulf.om','+968 9888 9025','2026-06-14',null,'active','full_time','MCT-HQ','HR','HRE','MG-1003','1025','0100000025',true,true,true,'B-','single','Saif Al Harthi','+968 9888 9125','father','S1'),
    ('MG-1026','Kamal',null,'Hussain','كمال حسين','male','1989-01-09','PK','kamal.hussain@majangulf.om','+968 9101 2026','2020-12-06','2026-07-31','resigned','full_time','MCT-HQ','ADM','OA','MG-1015','1026','0100000026',true,false,true,'O+','married','Nadia Hussain','+92 300 1002026','spouse','G1'),
    ('MG-2001','Said','Ahmed','Al Rawahi','سعيد بن أحمد الرواحي','male','1982-02-18','OM','brmanager@flowza.ai','+968 9202 1027','2019-01-20',null,'active','full_time','SOH','OPS','BM','MG-1023','2001','0100002001',true,true,true,'A+','married','Ahmed Al Rawahi','+968 9202 1127','father','M2'),
    ('MG-2002','Yousuf','Khamis','Al Balushi','يوسف بن خميس البلوشي','male','1990-09-09','OM','yousuf.albalushi@majangulf.om','+968 9303 2028','2020-10-11',null,'active','full_time','SOH','SALES','SEX','MG-2001','2002','0100002002',true,true,true,'O+','married','Khamis Al Balushi','+968 9303 2128','father','S3'),
    ('MG-2003','Anita','Suresh','Kumar','أنيتا سوريش كومار','female','1993-12-01','IN','anita.kumar@majangulf.om','+968 9404 3029','2022-01-23',null,'active','full_time','SOH','SALES','SEX','MG-2001','2003','0100002003',true,true,false,'B+','married','Suresh Kumar','+968 9404 3129','spouse','S2'),
    ('MG-2004','Vijay','Kumar','Sharma','فيجاي كومار شارما','male','1980-06-25','IN','vijay.sharma@majangulf.om','+968 9505 4030','2018-12-02',null,'active','full_time','SOH','OPS','STK','MG-2001','2004','0100002004',true,false,true,'AB+','married','Sunita Sharma','+91 98100 44030','spouse','G2'),
    ('MG-2005','Rahim',null,'Uddin','رحيم الدين','male','1985-03-30','BD','rahim.uddin@majangulf.om','+968 9606 5031','2021-08-15',null,'active','full_time','SOH','OPS','TECH','MG-2001','2005','0100002005',true,false,true,'O+','married','Karim Uddin','+880 1811 500031','brother','G2'),
    ('MG-2006','Salma','Nasser','Al Shukaili','سلمى بنت ناصر الشكيلية','female','1997-07-13','OM','salma.alshukaili@majangulf.om','+968 9707 6032','2023-10-08',null,'active','full_time','SOH','ADM','AA','MG-2001','2006','0100002006',true,true,true,'A-','single','Nasser Al Shukaili','+968 9707 6132','father','S1'),
    ('MG-2007','Mahmoud','Karim','Mostafa','محمود كريم مصطفى','male','1986-10-05','EG','mahmoud.mostafa@majangulf.om','+968 9808 7033','2022-04-03',null,'active','full_time','SOH','FIN','ACC','MG-1005','2007','0100002007',true,true,false,'B+','married','Karim Mostafa','+20 100 200 7033','father','S2'),
    ('MG-2008','Omar',null,'Farouk','عمر فاروق','male','1988-08-08','EG','omar.farouk@majangulf.om','+968 9909 8034','2020-02-16','2026-05-15','terminated','full_time','SOH','OPS','TECH','MG-2001','2008','0100002008',true,false,true,'O+','single','Farouk Hassan','+20 101 200 8034','father','G2'),
    ('MG-3001','Hilal','Saeed','Al Mashani','هلال بن سعيد المعشني','male','1979-05-05','OM','hilal.almashani@majangulf.om','+968 9210 3035','2018-07-15',null,'active','full_time','SLL','OPS','BM','MG-1023','3001','0100003001',true,true,true,'A+','married','Saeed Al Mashani','+968 9210 3135','father','M2'),
    ('MG-3002','Laila','Ahmed','Al Shanfari','ليلى بنت أحمد الشنفرية','female','1992-11-11','OM','laila.alshanfari@majangulf.om','+968 9320 4036','2021-03-28',null,'active','full_time','SLL','SALES','SEX','MG-3001','3002','0100003002',true,true,true,'O+','married','Ahmed Al Shanfari','+968 9320 4136','father','S3'),
    ('MG-3003','Ramon',null,'Cruz','رامون كروز','male','1991-01-29','PH','ramon.cruz@majangulf.om','+968 9430 5037','2022-11-06',null,'active','full_time','SLL','SALES','SEX','MG-3001','3003','0100003003',true,true,false,'B+','single','Elena Cruz','+63 919 555 5037','mother','S2'),
    ('MG-3004','Nadeem',null,'Akhtar','نديم أختر','male','1983-09-14','PK','nadeem.akhtar@majangulf.om','+968 9540 6038','2019-05-12',null,'active','full_time','SLL','OPS','TECH','MG-3001','3004','0100003004',true,false,true,'A+','married','Rubina Akhtar','+92 321 600 6038','spouse','G2'),
    ('MG-3005','Shaima','Salim','Al Amri','شيماء بنت سالم العامرية','female','1998-08-20','OM','shaima.alamri@majangulf.om','+968 9650 7039','2023-01-15',null,'active','full_time','SLL','CS','CSE','MG-3001','3005','0100003005',true,true,true,'O-','single','Salim Al Amri','+968 9650 7139','father','S1'),
    ('MG-3006','Jose','Miguel','Reyes','خوسيه ميغيل رييس','male','1987-02-02','PH','jose.reyes@majangulf.om','+968 9760 8040','2020-06-21',null,'active','full_time','SLL','ADM','DRV','MG-3001','3006','0100003006',true,false,true,'B-','married','Carmen Reyes','+63 920 555 8040','spouse','G1'),
    ('MG-4001','Sultan','Hamed','Al Riyami','سلطان بن حمد الريامي','male','1981-12-12','OM','sultan.alriyami@majangulf.om','+968 9270 4041','2020-02-09',null,'active','full_time','NZW','OPS','BM','MG-1023','4001','0100004001',true,true,true,'A+','married','Hamed Al Riyami','+968 9270 4141','father','M2'),
    ('MG-4002','Farah','Ali','Al Kindi','فرح بنت علي الكندية','female','1995-04-04','OM','farah.alkindi@majangulf.om','+968 9380 5042','2022-07-17',null,'active','full_time','NZW','SALES','SEX','MG-4001','4002','0100004002',true,true,true,'O+','single','Ali Al Kindi','+968 9380 5142','father','S2'),
    ('MG-4003','Arun','Kumar','Pillai','أرون كومار بيلاي','male','1989-06-06','IN','arun.pillai@majangulf.om','+968 9490 6043','2021-11-21',null,'active','full_time','NZW','OPS','TECH','MG-4001','4003','0100004003',true,false,true,'B+','married','Meera Pillai','+91 98460 66043','spouse','G2'),
    ('MG-4004','Mona','Hassan','Ibrahim','منى حسن إبراهيم','female','1994-10-10','EG','mona.ibrahim@majangulf.om','+968 9590 7044','2024-03-10',null,'active','part_time','NZW','ADM','AA','MG-4001','4004','0100004004',true,true,false,'A-','married','Hassan Ibrahim','+968 9590 7144','father','S1'),
    ('MG-5001','Majid','Rashid','Al Araimi','ماجد بن راشد العريمي','male','1980-03-21','OM','majid.alaraimi@majangulf.om','+968 9250 5045','2019-08-04',null,'active','full_time','SUR','OPS','BM','MG-1023','5001','0100005001',true,true,true,'O+','married','Rashid Al Araimi','+968 9250 5145','father','M2'),
    ('MG-5002','Sana',null,'Tariq','سناء طارق','female','1996-09-16','PK','sana.tariq@majangulf.om','+968 9360 6046','2023-05-14',null,'active','full_time','SUR','SALES','SEX','MG-5001','5002','0100005002',true,true,false,'B+','single','Tariq Mahmood','+92 333 600 6046','father','S2'),
    ('MG-5003','Waleed','Salim','Al Ghailani','وليد بن سالم الغيلاني','male','1992-05-27','OM','waleed.alghailani@majangulf.om','+968 9470 7047','2022-02-20',null,'active','full_time','SUR','OPS','TECH','MG-5001','5003','0100005003',true,false,true,'A+','married','Salim Al Ghailani','+968 9470 7147','father','G2'),
    ('MG-5004','Deepak',null,'Nair','ديباك ناير','male','1985-01-31','IN','deepak.nair@majangulf.om','+968 9580 8048','2021-01-24',null,'active','full_time','SUR','ADM','DRV','MG-5001','5004','0100005004',true,false,true,'O+','married','Reshma Nair','+91 98470 88048','spouse','G1'),
    ('MG-6001','Ali','Hamdan','Al Junaibi','علي بن حمدان الجنيبي','male','1984-07-24','OM','ali.aljunaibi@majangulf.om','+968 9260 6049','2021-09-05',null,'active','full_time','DQM','OPS','SUP','MG-1023','6001','0100006001',true,true,true,'B+','married','Hamdan Al Junaibi','+968 9260 6149','father','S4'),
    ('MG-6002','Abdul Rahman',null,'Siddique','عبدالرحمن صديق','male','1990-02-12','BD','abdulrahman.siddique@majangulf.om','+968 9370 7050','2022-08-14',null,'active','full_time','DQM','OPS','TECH','MG-6001','6002','0100006002',true,false,true,'O+','married','Siddique Ahmed','+880 1911 700050','father','G2'),
    ('MG-6003','Ibrahim','Yahya','Al Balushi','إبراهيم بن يحيى البلوشي','male','1996-06-18','OM','ibrahim.albalushi@majangulf.om','+968 9480 8051','2023-04-02',null,'active','full_time','DQM','OPS','TECH','MG-6001','6003','0100006003',true,false,true,'A+','single','Yahya Al Balushi','+968 9480 8151','father','G2'),
    ('MG-6004','Mark','Anthony','Dela Cruz','مارك أنتوني ديلا كروز','male','1989-10-27','PH','mark.delacruz@majangulf.om','+968 9690 9052','2024-10-06',null,'active','full_time','DQM','OPS','STK','MG-6001','6004','0100006004',true,true,false,'B+','married','Anna Dela Cruz','+63 921 555 9052','spouse','G2'),
    ('MG-6005','Tariq',null,'Mehmood','طارق محمود','male','1993-03-08','PK','tariq.mehmood@majangulf.om','+968 9790 1053','2026-07-19',null,'active','contract','DQM','OPS','DRV','MG-6001','6005','0100006005',true,false,false,'O+','married','Mehmood Ali','+92 345 100 1053','father','G1')
  ) as v(num, first, middle, last, name_ar, gender, dob, nat, email, phone, joining, exit_d, status, etype, branch, dept, desig, mgr, pin, card, fp, face, ramadan, blood, marital, ec_name, ec_phone, ec_rel, grade)
  on conflict (organization_id, employee_number) do update set first_name = excluded.first_name, middle_name = excluded.middle_name, last_name = excluded.last_name, display_name = excluded.display_name, display_name_ar = excluded.display_name_ar,
    gender = excluded.gender, date_of_birth = excluded.date_of_birth, nationality_code = excluded.nationality_code, email = excluded.email, phone = excluded.phone, joining_date = excluded.joining_date, exit_date = excluded.exit_date,
    employment_status = excluded.employment_status, employment_type = excluded.employment_type, branch_id = excluded.branch_id, department_id = excluded.department_id, designation_id = excluded.designation_id,
    manager_employee_id = excluded.manager_employee_id, user_id = excluded.user_id, device_user_id = excluded.device_user_id, card_number = excluded.card_number, fingerprint_enrolled = excluded.fingerprint_enrolled,
    face_enrolled = excluded.face_enrolled, custom_fields = excluded.custom_fields, updated_by = hradmin_id, updated_at = now(), deleted_at = null;

  -- employment history: one placement row per employee from the joining date; leavers close their row; Anita transferred
  insert into public.employment_history (id, organization_id, employee_id, effective_from, effective_to, branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason, created_by)
  select pg_temp.sid('hist:' || e.employee_number || ':join'), org, e.id, e.joining_date,
         case when e.employee_number = 'MG-2003' then date '2026-06-01' when e.exit_date is not null then e.exit_date + 1 end,
         case when e.employee_number = 'MG-2003' then pg_temp.sid('branch:MCT-HQ') else e.branch_id end,
         e.department_id, e.designation_id, case when e.employee_number = 'MG-2003' then pg_temp.sid('emp:MG-1019') else e.manager_employee_id end,
         e.employment_type, 'active', 'Joined', hradmin_id
  from public.employees e where e.organization_id = org
  on conflict (id) do update set effective_to = excluded.effective_to, branch_id = excluded.branch_id, department_id = excluded.department_id, designation_id = excluded.designation_id, manager_employee_id = excluded.manager_employee_id, employment_type = excluded.employment_type;

  insert into public.employment_history (id, organization_id, employee_id, effective_from, effective_to, branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason, created_by)
  values (pg_temp.sid('hist:MG-2003:transfer'), org, pg_temp.sid('emp:MG-2003'), '2026-06-01', null, pg_temp.sid('branch:SOH'), pg_temp.sid('dept:SALES'), pg_temp.sid('desig:SEX'), pg_temp.sid('emp:MG-2001'), 'full_time', 'active',
          'Transferred to Sohar Industrial Branch — sales coverage for Al Batinah', hradmin_id)
  on conflict (id) do nothing;

  -- identity documents: Omanis carry a civil ID + passport; expatriates a passport, resident card and labour card
  insert into public.employee_identity_documents (id, organization_id, employee_id, branch_id, type, number, issuing_country, issued_at, expires_at, notes, created_by)
  select pg_temp.sid('doc:' || e.employee_number || ':' || t.kind), org, e.id, e.branch_id, t.kind::public.identity_document_type,
         case t.kind
           when 'civil_id'       then lpad((10000000 + floor(pg_temp.u(e.employee_number || ':civil') * 89999999))::bigint::text, 8, '0')
           when 'residence_card' then lpad((10000000 + floor(pg_temp.u(e.employee_number || ':civil') * 89999999))::bigint::text, 8, '0')
           when 'passport'       then chr(65 + floor(pg_temp.u(e.employee_number || ':pp1') * 6)::int) || lpad(floor(pg_temp.u(e.employee_number || ':pp2') * 9999999)::bigint::text, 7, '0')
           else 'LC' || lpad((1000000 + floor(pg_temp.u(e.employee_number || ':lc') * 8999999))::bigint::text, 7, '0') end,
         case t.kind when 'passport' then e.nationality_code else 'OM' end,
         d.issued,
         d.issued + case t.kind when 'passport' then interval '10 years' when 'civil_id' then interval '10 years' else interval '2 years' end,
         case when d.issued + case t.kind when 'passport' then interval '10 years' when 'civil_id' then interval '10 years' else interval '2 years' end < date '2027-03-31' then 'Renewal due — expires within six months' end,
         hradmin_id
  from public.employees e
  cross join (values ('civil_id'), ('passport'), ('residence_card'), ('labour_card')) as t(kind)
  cross join lateral (select (date '2023-01-01' + floor(pg_temp.u(e.employee_number || ':' || t.kind || ':issued') * 1300)::int) as issued) d
  where e.organization_id = org
    and ((e.nationality_code = 'OM' and t.kind in ('civil_id', 'passport')) or (e.nationality_code <> 'OM' and t.kind in ('passport', 'residence_card', 'labour_card')))
  on conflict (id) do update set number = excluded.number, issuing_country = excluded.issuing_country, issued_at = excluded.issued_at, expires_at = excluded.expires_at, notes = excluded.notes, updated_at = now();

  -- department managers and the owner's team leads
  update public.departments d set manager_employee_id = pg_temp.sid('emp:' || m.num), updated_at = now()
  from (values ('MGMT', 'MG-1001'), ('HR', 'MG-1003'), ('FIN', 'MG-1005'), ('PAY', 'MG-1006'), ('IT', 'MG-1009'), ('ADM', 'MG-1015'), ('OPS', 'MG-1023'), ('SALES', 'MG-1019'), ('BD', 'MG-1020'), ('CS', 'MG-1022')) as m(code, num)
  where d.organization_id = org and d.code = m.code;

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. Teams (lead is always a member)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.teams (id, organization_id, branch_id, code, name, lead_employee_id, status, created_at)
  select pg_temp.sid('team:' || t.code), org, case when t.branch is null then null else pg_temp.sid('branch:' || t.branch) end, t.code, t.name, pg_temp.sid('emp:' || t.lead), 'active', t0
  from (values
    ('HR-OPS',     'People Operations (HR)',                 null,  'MG-1004', 'MG-1004,MG-1025'),
    ('PAYROLL',    'Payroll & Benefits',                     null,  'MG-1006', 'MG-1006'),
    ('ACCTS',      'Accounts & Reporting',                   null,  'MG-1007', 'MG-1007,MG-1008,MG-2007'),
    ('IT-DEV',     'Software Development',                   null,  'MG-1010', 'MG-1010,MG-1011,MG-1012,MG-1013'),
    ('IT-SUP',     'IT Support & Infrastructure',            null,  'MG-1014', 'MG-1014'),
    ('ADMIN',      'Administration & Facilities',            null,  'MG-1015', 'MG-1015,MG-1016,MG-1017,MG-1018,MG-1026'),
    ('SALES-N',    'Sales – Al Batinah',                     'SOH', 'MG-2002', 'MG-2002,MG-2003'),
    ('SALES-S',    'Sales – Dhofar',                         'SLL', 'MG-3002', 'MG-3002,MG-3003'),
    ('SALES-INT',  'Sales – Interior & Sharqiyah',           null,  'MG-4002', 'MG-4002,MG-5002'),
    ('CS-DESK',    'Customer Support Desk',                  null,  'MG-1022', 'MG-1021,MG-1022,MG-1024,MG-3005'),
    ('OPS-DQM',    'Duqm Site Crew',                         'DQM', 'MG-6001', 'MG-6001,MG-6002,MG-6003,MG-6004,MG-6005'),
    ('FIELD-TECH', 'Field Technicians',                      null,  'MG-2005', 'MG-2004,MG-2005,MG-3004,MG-4003,MG-5003')
  ) as t(code, name, branch, lead, members)
  on conflict (organization_id, code) do update set name = excluded.name, branch_id = excluded.branch_id, lead_employee_id = excluded.lead_employee_id, status = 'active', updated_at = now();

  insert into public.team_members (team_id, employee_id, organization_id, added_at)
  select pg_temp.sid('team:' || t.code), pg_temp.sid('emp:' || m), org, t0
  from (values
    ('HR-OPS', 'MG-1004,MG-1025'), ('PAYROLL', 'MG-1006'), ('ACCTS', 'MG-1007,MG-1008,MG-2007'), ('IT-DEV', 'MG-1010,MG-1011,MG-1012,MG-1013'), ('IT-SUP', 'MG-1014'),
    ('ADMIN', 'MG-1015,MG-1016,MG-1017,MG-1018,MG-1026'), ('SALES-N', 'MG-2002,MG-2003'), ('SALES-S', 'MG-3002,MG-3003'), ('SALES-INT', 'MG-4002,MG-5002'),
    ('CS-DESK', 'MG-1021,MG-1022,MG-1024,MG-3005'), ('OPS-DQM', 'MG-6001,MG-6002,MG-6003,MG-6004,MG-6005'), ('FIELD-TECH', 'MG-2004,MG-2005,MG-3004,MG-4003,MG-5003')
  ) as t(code, members), unnest(string_to_array(t.members, ',')) as m
  on conflict do nothing;

  -- shift assignments below the organisation default: developers are flexible, the MD too, drivers/technicians/storekeepers start at 07:00
  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  values (pg_temp.sid('assign:team:IT-DEV'), org, 'TEAM', pg_temp.sid('team:IT-DEV'), null, pg_temp.sid('shift:FLEX'), null, '2024-01-01', null, hradmin_id, t0),
         (pg_temp.sid('assign:emp:MG-1001'), org, 'EMPLOYEE', pg_temp.sid('emp:MG-1001'), pg_temp.sid('branch:MCT-HQ'), pg_temp.sid('shift:FLEX'), null, '2024-01-01', null, hradmin_id, t0)
  on conflict (id) do update set shift_id = excluded.shift_id, effective_from = excluded.effective_from;

  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  select pg_temp.sid('assign:emp:' || e.employee_number), org, 'EMPLOYEE', e.id, e.branch_id, pg_temp.sid('shift:SITE'), null, e.joining_date, null, hradmin_id, t0
  from public.employees e where e.organization_id = org and e.employee_number in ('MG-1018', 'MG-2004', 'MG-2005', 'MG-2008', 'MG-3004', 'MG-3006', 'MG-4003', 'MG-5003', 'MG-5004')
  on conflict (id) do update set shift_id = excluded.shift_id, effective_from = excluded.effective_from;

  ---------------------------------------------------------------------------------------------------------------------
  -- 4. Device enrolment state and provider identities (how the terminals know who "1012" is)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.device_employee_states (id, organization_id, device_id, employee_id, branch_id, device_user_id, cloud_hash, device_hash, sync_status, desired, last_sync_at, last_success_at, fingerprint_count, face_enrolled, card_enrolled)
  select pg_temp.sid('des:' || d.code || ':' || e.employee_number), org, d.id, e.id, d.branch_id, e.device_user_id,
         'sha1:' || left(md5(e.employee_number || ':cloud'), 16), 'sha1:' || left(md5(e.employee_number || ':cloud'), 16),
         case when e.employment_status in ('terminated', 'resigned') then 'REMOVED' else 'IN_SYNC' end::public.device_employee_sync_status,
         e.employment_status not in ('terminated', 'resigned'),
         now() - (floor(pg_temp.u(e.employee_number || d.code || ':sync') * 20)::int || ' hours')::interval, now() - (floor(pg_temp.u(e.employee_number || d.code || ':sync') * 20)::int || ' hours')::interval,
         case when e.fingerprint_enrolled then 1 + (pg_temp.u(e.employee_number || ':fp') < 0.6)::int else 0 end,
         e.face_enrolled and coalesce((d.capabilities ->> 'face')::boolean, false), e.card_number is not null
  from public.devices d join public.employees e on e.organization_id = d.organization_id and e.branch_id = d.branch_id
  where d.organization_id = org
  on conflict (device_id, device_user_id) do update set employee_id = excluded.employee_id, sync_status = excluded.sync_status, desired = excluded.desired, last_sync_at = excluded.last_sync_at, last_success_at = excluded.last_success_at,
    fingerprint_count = excluded.fingerprint_count, face_enrolled = excluded.face_enrolled, card_enrolled = excluded.card_enrolled, updated_at = now();

  insert into public.employee_provider_identities (id, organization_id, employee_id, provider_key, device_user_id, card_number)
  select pg_temp.sid('epi:' || e.employee_number), org, e.id, 'zkteco_push', e.device_user_id, e.card_number from public.employees e where e.organization_id = org
  on conflict (organization_id, employee_id, provider_key) do update set device_user_id = excluded.device_user_id, card_number = excluded.card_number, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- 5. Memberships (role + branch scope + linked employee) and notification preferences
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, employee_id, invited_by, joined_at, created_at)
  select pg_temp.sid('membership:' || m.email), org, case when m.email = 'acme@flowza.ai' then owner_id else pg_temp.sid('user:' || m.email) end, m.role_id::uuid, 'active', m.all_br, pg_temp.sid('emp:' || m.num),
         case when m.email = 'acme@flowza.ai' then null else owner_id end, t0, t0
  from (values
    ('acme@flowza.ai',      '10000000-0000-0000-0000-000000000001', true,  'MG-1001'),
    ('orgadmin@flowza.ai',  '10000000-0000-0000-0000-000000000002', true,  'MG-1002'),
    ('hradmin@flowza.ai',   '10000000-0000-0000-0000-000000000003', true,  'MG-1003'),
    ('hruser@flowza.ai',    '10000000-0000-0000-0000-000000000004', true,  'MG-1004'),
    ('payroll@flowza.ai',   '10000000-0000-0000-0000-000000000007', true,  'MG-1006'),
    ('attadmin@flowza.ai',  '10000000-0000-0000-0000-000000000006', true,  'MG-1016'),
    ('brmanager@flowza.ai', '10000000-0000-0000-0000-000000000005', false, 'MG-2001'),
    ('employee@flowza.ai',  '10000000-0000-0000-0000-000000000008', true,  'MG-1012')
  ) as m(email, role_id, all_br, num)
  on conflict (organization_id, user_id) do update set role_id = excluded.role_id, status = 'active', all_branches = excluded.all_branches, employee_id = excluded.employee_id, joined_at = coalesce(org_memberships.joined_at, excluded.joined_at), updated_at = now();

  insert into public.membership_branches (membership_id, branch_id)
  select m.id, pg_temp.sid('branch:SOH') from public.org_memberships m where m.organization_id = org and m.user_id = pg_temp.sid('user:brmanager@flowza.ai')
  on conflict do nothing;

  insert into public.notification_preferences (user_id, organization_id, category, channel, enabled)
  select m.user_id, org, c.cat::public.notification_category, ch.ch::public.notification_channel,
         -- e-mail stays off for ATTENDANCE (sync chatter) and SYSTEM; in-app notifications are on for everything
         case when ch.ch = 'EMAIL' and c.cat in ('SYSTEM', 'ATTENDANCE') then false else true end
  from public.org_memberships m
  cross join (values ('DEVICE'), ('ATTENDANCE'), ('APPROVAL'), ('SYSTEM'), ('SUBSCRIPTION')) as c(cat)
  cross join (values ('IN_APP'), ('EMAIL')) as ch(ch)
  where m.organization_id = org
  on conflict (user_id, organization_id, category, channel) do update set enabled = excluded.enabled, updated_at = now();
end $$;

select 'people' as step,
  (select count(*) from public.employees where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as employees,
  (select count(*) from public.org_memberships where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261' and status = 'active') as members,
  (select count(*) from public.teams where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as teams,
  (select count(*) from public.team_members where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as team_members,
  (select count(*) from public.employee_identity_documents where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as documents,
  (select count(*) from public.device_employee_states where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as device_states,
  (select count(*) from public.employment_history where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as history_rows;
