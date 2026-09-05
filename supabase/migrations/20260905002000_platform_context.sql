-- FlowZa Time · 2000 · platform execution context for cross-tenant maintenance jobs (outbox relay, metering, partitions)
-- Claims: {"role":"flowza_system","scope":"platform"} under SET ROLE flowza_system. Deny by default: only the tables below
-- get platform policies, each limited to the operations the maintenance handlers need.
set client_min_messages = warning;

create or replace function app.is_platform_context() returns boolean language sql stable as $$
  select app.is_system() and (app.claims() ->> 'scope') = 'platform'
$$;

-- read-only platform access
create policy organizations_platform_ctx on public.organizations for select to flowza_system using ((select app.is_platform_context()));
create policy org_memberships_platform_ctx on public.org_memberships for select to flowza_system using ((select app.is_platform_context()));
create policy role_permissions_platform_ctx on public.role_permissions for select to flowza_system using ((select app.is_platform_context()));
create policy user_profiles_platform_ctx on public.user_profiles for select to flowza_system using ((select app.is_platform_context()));
create policy notification_preferences_platform_ctx on public.notification_preferences for select to flowza_system using ((select app.is_platform_context()));
create policy data_retention_policies_platform_ctx on public.data_retention_policies for select to flowza_system using ((select app.is_platform_context()));
create policy devices_platform_ctx on public.devices for select to flowza_system using ((select app.is_platform_context()));
create policy provider_circuit_states_platform_ctx on public.provider_circuit_states for select to flowza_system using ((select app.is_platform_context()));
create policy subscriptions_platform_ctx on public.subscriptions for select to flowza_system using ((select app.is_platform_context()));
create policy plans_platform_ctx on public.plans for select to flowza_system using ((select app.is_platform_context()));
create policy entitlements_platform_ctx on public.entitlements for select to flowza_system using ((select app.is_platform_context()));
-- scheduler bookkeeping on devices (next poll time, adaptive interval, connection status)
create policy devices_platform_ctx_update on public.devices for update to flowza_system using ((select app.is_platform_context())) with check ((select app.is_platform_context()));
-- outbox + notifications
create policy domain_events_platform_ctx on public.domain_events for all to flowza_system using ((select app.is_platform_context())) with check ((select app.is_platform_context()));
create policy notifications_platform_ctx on public.notifications for all to flowza_system using ((select app.is_platform_context())) with check ((select app.is_platform_context()));
create policy notification_deliveries_platform_ctx on public.notification_deliveries for all to flowza_system using ((select app.is_platform_context())) with check ((select app.is_platform_context()));
-- metering + audit
create policy usage_records_platform_ctx on public.usage_records for all to flowza_system using ((select app.is_platform_context())) with check ((select app.is_platform_context()));
create policy audit_logs_platform_ctx on audit.logs for insert to flowza_system with check ((select app.is_platform_context()));
-- counts used by metering (read-only)
create policy employees_platform_ctx on public.employees for select to flowza_system using ((select app.is_platform_context()));
create policy branches_platform_ctx on public.branches for select to flowza_system using ((select app.is_platform_context()));
create policy attendance_raw_platform_ctx on public.attendance_raw_transactions for select to flowza_system using ((select app.is_platform_context()));
-- sync scheduling (scan due devices, coalesce jobs) and health rollups
create policy sync_jobs_platform_ctx on public.sync_jobs for select to flowza_system using ((select app.is_platform_context()));
create policy sync_job_items_platform_ctx on public.sync_job_items for select to flowza_system using ((select app.is_platform_context()));
create policy sync_cursors_platform_ctx on public.sync_cursors for select to flowza_system using ((select app.is_platform_context()));
create policy report_requests_platform_ctx on public.report_requests for select to flowza_system using ((select app.is_platform_context()));
create policy attendance_period_locks_platform_ctx on public.attendance_period_locks for select to flowza_system using ((select app.is_platform_context()));

-- Partition maintenance must run as the table owner.
create or replace function app.ensure_month_partitions(p_table regclass, p_from date, p_months int)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_schema text; v_table text; v_start date; v_end date; v_name text; v_created int := 0; i int;
begin
  if not app.is_system() then raise exception 'system context required' using errcode = '42501'; end if;
  select n.nspname, c.relname into v_schema, v_table from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_table not in ('attendance_raw_transactions', 'attendance_events', 'device_logs', 'sync_logs') then
    raise exception 'table % is not a managed partitioned table', v_table using errcode = '22023';
  end if;
  for i in 0 .. p_months - 1 loop
    v_start := date_trunc('month', p_from)::date + (i || ' months')::interval;
    v_end := v_start + interval '1 month';
    v_name := format('%s_%s', v_table, to_char(v_start, 'YYYYMM'));
    if to_regclass(format('%I.%I', v_schema, v_name)) is null then
      execute format('create table %I.%I partition of %I.%I for values from (%L) to (%L)', v_schema, v_name, v_schema, v_table, v_start, v_end);
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end $$;

-- Rows in DEFAULT partitions signal missing future partitions (alerting).
create or replace function app.default_partition_rows() returns table (table_name text, row_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare t text; n bigint;
begin
  if not app.is_system() then raise exception 'system context required' using errcode = '42501'; end if;
  foreach t in array array['attendance_raw_transactions', 'attendance_events', 'device_logs', 'sync_logs'] loop
    execute format('select count(*) from public.%I_default', t) into n;
    table_name := t; row_count := n; return next;
  end loop;
end $$;

grant execute on function app.ensure_month_partitions(regclass, date, int), app.default_partition_rows() to flowza_system, flowza_worker, flowza_api;
revoke execute on function app.ensure_month_partitions(regclass, date, int), app.default_partition_rows() from authenticated, anon, public;
