-- FlowZa Time · seed · platform super administrator dev@flowza.ai with a TEMPORARY password.
--
-- Creates (or refreshes) the super-admin login of the /adm portal on the hosted project: auth user → user_profiles →
-- platform_admins (level owner). Idempotent: re-running resets the password to the temporary one below and re-asserts
-- the owner level; it never duplicates rows. Run it once on the admin connection (Supabase SQL editor, or
-- `psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f supabase/seeds/platform-admin/01_super_admin.sql`).
--
--   Sign in at https://time.flowza.ai/adm/login
--     email     dev@flowza.ai
--     password  ChangeMe@FlowZa2026        ← temporary: change it on first sign-in (My account → Change password)
--
-- The account is flagged `password_is_temporary` in its user metadata, so the portal shows a banner until the password is
-- changed; changing it clears the flag. Platform administrators must also enrol MFA (TOTP) at their first sign-in — the
-- API refuses every platform-admin session below aal2 — so the temporary password alone never reaches tenant
-- management. Still: change it before sharing access, and prefer `pnpm --filter @flowza/database run seed:platform-admin`
-- (docs/go-live.md §6) with a password from the environment for any later rotation.
--
-- Written for the hosted Supabase Auth schema (the columns GoTrue expects to be '' rather than NULL are set when they
-- exist, so the same file also runs on the local shim, whose auth.users is minimal).

do $$
declare
  v_email constant text := 'dev@flowza.ai';
  v_name constant text := 'FlowZa Platform Owner';
  v_pw constant text := extensions.crypt('ChangeMe@FlowZa2026', extensions.gen_salt('bf', 10));
  v_id uuid;
  v_col text;
begin
  select id into v_id from auth.users where lower(email) = v_email limit 1;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (v_id, v_email, v_pw, now(), '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'full_name', v_name, 'email_verified', true, 'password_is_temporary', true), now(), now());
  else
    update auth.users
       set encrypted_password = v_pw,
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('full_name', v_name, 'password_is_temporary', true),
           updated_at = now()
     where id = v_id;
  end if;

  -- hosted GoTrue columns: instance / audience / role, and the token columns it reads as strings (NULL breaks sign-in)
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'instance_id') then
    execute 'update auth.users set instance_id = coalesce(instance_id, ''00000000-0000-0000-0000-000000000000''), aud = coalesce(aud, ''authenticated''), role = coalesce(role, ''authenticated'') where id = $1' using v_id;
  end if;
  foreach v_col in array array['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change', 'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = v_col) then
      execute format('update auth.users set %1$I = coalesce(%1$I, '''') where id = $1', v_col) using v_id;
    end if;
  end loop;
  if to_regclass('auth.identities') is not null then
    execute 'insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
             select $1::text, $1, $2, ''email'', now(), now()
             where not exists (select 1 from auth.identities where user_id = $1 and provider = ''email'')'
      using v_id, jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false);
  end if;

  insert into public.user_profiles (id, email, full_name, status)
  values (v_id, v_email, v_name, 'active')
  on conflict (id) do update set email = excluded.email, full_name = case when public.user_profiles.full_name = '' then excluded.full_name else public.user_profiles.full_name end, status = 'active', updated_at = now();

  insert into public.platform_admins (user_id, level, status)
  values (v_id, 'owner', 'active')
  on conflict (user_id) do update set level = 'owner', status = 'active';

  insert into audit.logs (organization_id, actor_user_id, actor_type, actor_label, action, entity_type, entity_id, new_value, reason)
  values (null, null, 'SYSTEM', 'seed-platform-admin-sql', 'platform_admin.seeded', 'platform_admin', v_id::text,
          jsonb_build_object('email', v_email, 'level', 'owner', 'status', 'active', 'temporaryPassword', true), 'Super-admin portal bootstrap (temporary password)');

  raise notice 'platform super admin ready: % (%), level owner — temporary password set; enrol MFA at first sign-in', v_email, v_id;
end $$;
