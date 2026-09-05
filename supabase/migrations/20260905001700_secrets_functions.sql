-- FlowZa Time · 1700 · controlled access to encrypted device credentials (ADR-003)
set client_min_messages = warning;
-- The ciphertext is produced by the application (AES-256-GCM, master key outside the database).
-- These functions are the only path to the table for application roles; they run in system context.

create or replace function secrets.get_device_credentials(p_device_id uuid)
returns table (organization_id uuid, key_id text, nonce bytea, ciphertext bytea, auth_tag bytea, version int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_system() then
    raise exception 'secrets.get_device_credentials requires system context' using errcode = '42501';
  end if;
  return query
    select c.organization_id, c.key_id, c.nonce, c.ciphertext, c.auth_tag, c.version
    from public.device_credentials c
    where c.device_id = p_device_id and c.organization_id = app.system_org_id();
end $$;

create or replace function secrets.put_device_credentials(
  p_device_id uuid, p_key_id text, p_nonce bytea, p_ciphertext bytea, p_auth_tag bytea, p_masked jsonb, p_updated_by uuid
) returns int
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_version int;
begin
  if not app.is_system() then
    raise exception 'secrets.put_device_credentials requires system context' using errcode = '42501';
  end if;
  select organization_id into v_org from public.devices where id = p_device_id;
  if v_org is null or v_org <> app.system_org_id() then
    raise exception 'device % not found in current organisation', p_device_id using errcode = 'P0002';
  end if;
  insert into public.device_credentials (device_id, organization_id, key_id, nonce, ciphertext, auth_tag, masked, version, updated_by)
  values (p_device_id, v_org, p_key_id, p_nonce, p_ciphertext, p_auth_tag, coalesce(p_masked, '{}'::jsonb), 1, p_updated_by)
  on conflict (device_id) do update set
    key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext, auth_tag = excluded.auth_tag,
    masked = excluded.masked, version = public.device_credentials.version + 1, rotated_at = now(), updated_by = excluded.updated_by
  returning version into v_version;
  return v_version;
end $$;

create or replace function secrets.delete_device_credentials(p_device_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_found boolean;
begin
  if not app.is_system() then
    raise exception 'secrets.delete_device_credentials requires system context' using errcode = '42501';
  end if;
  delete from public.device_credentials where device_id = p_device_id and organization_id = app.system_org_id();
  get diagnostics v_found = row_count;
  return v_found;
end $$;

-- Masked view for the UI (never the ciphertext).
create or replace function secrets.masked_device_credentials(p_device_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select c.masked || jsonb_build_object('version', c.version, 'rotatedAt', c.rotated_at, 'keyId', c.key_id)
    from public.device_credentials c
    join public.devices d on d.id = c.device_id
    where c.device_id = p_device_id
      and (d.organization_id = any ((select app.org_ids_with_permission('device.view'))::uuid[]))
  ), '{}'::jsonb)
$$;

revoke all on all functions in schema secrets from public, anon, authenticated;
grant execute on function secrets.get_device_credentials(uuid), secrets.put_device_credentials(uuid, text, bytea, bytea, bytea, jsonb, uuid), secrets.delete_device_credentials(uuid) to flowza_system, flowza_api, flowza_worker;
grant execute on function secrets.masked_device_credentials(uuid) to authenticated, flowza_system, flowza_api, flowza_worker;
grant usage on schema secrets to authenticated;
