-- FlowZa Time · 1500 · Storage buckets/policies and Realtime channel authorisation (tenant-scoped)
set client_min_messages = warning;
-- Object path convention: <bucket>/<organization_id>/... — the first folder is the tenant.
create or replace function app.path_org_id(p_name text) returns uuid language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values
      ('org-logos', 'org-logos', false),
      ('employee-photos', 'employee-photos', false),
      ('reports', 'reports', false),
      ('imports', 'imports', false),
      ('documents', 'documents', false)
    on conflict (id) do nothing;
  end if;
  if to_regclass('storage.objects') is not null then
    execute $p$ drop policy if exists flowza_objects_read on storage.objects $p$;
    execute $p$ create policy flowza_objects_read on storage.objects for select to authenticated, flowza_system using (
      app.path_org_id(name) is not null and (
        (bucket_id = 'org-logos'       and app.path_org_id(name) = any ((select app.member_org_ids())::uuid[])) or
        (bucket_id = 'employee-photos' and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.view'))::uuid[])) or
        (bucket_id = 'reports'         and app.path_org_id(name) = any ((select app.org_ids_with_permission('report.view'))::uuid[])) or
        (bucket_id = 'imports'         and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.import'))::uuid[])) or
        (bucket_id = 'documents'       and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.view_sensitive'))::uuid[]))
      )) $p$;
    execute $p$ drop policy if exists flowza_objects_write on storage.objects $p$;
    execute $p$ create policy flowza_objects_write on storage.objects for insert to authenticated, flowza_system with check (
      app.path_org_id(name) is not null and (
        (bucket_id = 'org-logos'       and app.path_org_id(name) = any ((select app.org_ids_with_permission('organization.manage'))::uuid[])) or
        (bucket_id = 'employee-photos' and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[])) or
        (bucket_id = 'reports'         and app.is_system()) or
        (bucket_id = 'imports'         and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.import'))::uuid[])) or
        (bucket_id = 'documents'       and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[]))
      )) $p$;
    execute $p$ drop policy if exists flowza_objects_update on storage.objects $p$;
    execute $p$ create policy flowza_objects_update on storage.objects for update to authenticated, flowza_system using (
      app.path_org_id(name) is not null and (app.is_system() or app.path_org_id(name) = any ((select app.org_ids_with_permission('organization.manage'))::uuid[])
        or (bucket_id in ('employee-photos', 'documents') and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[])))) $p$;
    execute $p$ drop policy if exists flowza_objects_delete on storage.objects $p$;
    execute $p$ create policy flowza_objects_delete on storage.objects for delete to authenticated, flowza_system using (
      app.path_org_id(name) is not null and (app.is_system() or app.path_org_id(name) = any ((select app.org_ids_with_permission('organization.manage'))::uuid[])
        or (bucket_id in ('employee-photos', 'documents') and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[])))) $p$;
  end if;
end $$;

-- Realtime private channels: org:<uuid>:sync | org:<uuid>:devices | org:<uuid>:attendance | user:<uuid>:notifications
create or replace function app.topic_org_id(p_topic text) returns uuid language sql immutable as $$
  select case when p_topic ~ '^org:[0-9a-f-]{36}:' then split_part(p_topic, ':', 2)::uuid end
$$;
create or replace function app.topic_user_id(p_topic text) returns uuid language sql immutable as $$
  select case when p_topic ~ '^user:[0-9a-f-]{36}:' then split_part(p_topic, ':', 2)::uuid end
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$ drop policy if exists flowza_realtime_read on realtime.messages $p$;
    execute $p$ create policy flowza_realtime_read on realtime.messages for select to authenticated using (
      (app.topic_org_id(realtime.topic()) is not null and app.topic_org_id(realtime.topic()) = any ((select app.member_org_ids())::uuid[]))
      or (app.topic_user_id(realtime.topic()) is not null and app.topic_user_id(realtime.topic()) = app.uid())
    ) $p$;
    -- clients never publish; the API/worker publish through the REST broadcast endpoint with the service key
    execute $p$ drop policy if exists flowza_realtime_write on realtime.messages $p$;
    execute $p$ create policy flowza_realtime_write on realtime.messages for insert to authenticated with check (false) $p$;
  end if;
end $$;
