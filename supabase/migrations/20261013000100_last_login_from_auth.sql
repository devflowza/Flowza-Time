-- FlowZa Time · 20261013000100 · "Last sign-in" comes from GoTrue, because nothing was ever writing it.
--
-- `user_profiles.last_login_at` is displayed as "Last sign-in" in six places (the members table, the portal-access
-- card, and the platform console's users, team and tenant panels, which also offers sorting by it) and was NULL for
-- every user in production: 20 profiles, 0 non-null, against 33 live sessions. Nothing in the API or the worker ever
-- wrote the column. The only writer was ever going to be `app.on_password_verification_attempt`, and that hook is
-- cancelled — it needs the Supabase Team plan (risk D27, `docs/risks.md`). So an admin reading the console concluded
-- nobody had ever signed in while people were signing in all day.
--
-- GoTrue already records it. `auth.users.last_sign_in_at` is the latest successful sign-in per user and is readable
-- from SQL; what does not exist is a per-event history, or any record of a *failed* attempt (still D27, unchanged).
-- This migration copies that one value across, so the column shows the truth instead of nothing.
--
-- Why a SECURITY DEFINER function rather than a grant: `authenticated` has no privilege on `auth.users` and should not
-- be given one — a tenant user would then be able to read every other user's auth row. The function reads and writes
-- strictly `app.uid()`'s own row, so the caller gains exactly its own sign-in time and nothing else.

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

create or replace function app.touch_last_login() returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := app.uid(); v_signed_in timestamptz; v_current timestamptz;
begin
  -- Only a real end user has a sign-in time: system and platform contexts carry no `sub`.
  if v_user is null then return null; end if;

  select u.last_sign_in_at into v_signed_in from auth.users u where u.id = v_user;
  if v_signed_in is null then return null; end if;

  select p.last_login_at into v_current from public.user_profiles p where p.id = v_user;

  -- Write only when GoTrue's value has actually moved. /me runs on every page load, so an unconditional UPDATE would
  -- rewrite the row — and its WAL, and its updated_at trigger — on every request instead of once per sign-in.
  if v_current is null or v_current < v_signed_in then
    update public.user_profiles set last_login_at = v_signed_in where id = v_user;
  end if;

  return v_signed_in;
exception when others then
  -- /me is the request that loads the whole application. A stamp that cannot be written must never be the reason a
  -- user cannot get in, so this fails open exactly like the auth hook it stands in for.
  return null;
end $$;

grant execute on function app.touch_last_login() to authenticated, flowza_system;
revoke execute on function app.touch_last_login() from anon, public;

-- Backfill: every existing user already has a sign-in time in GoTrue, so the column can tell the truth immediately
-- rather than from each user's next sign-in. `user_profiles` holds one row per human (20 in production), so a direct
-- UPDATE needs no expand/backfill job. The NULL guard makes a re-apply a no-op, which the migration-idempotency
-- check in CI requires.
update public.user_profiles p
   set last_login_at = u.last_sign_in_at
  from auth.users u
 where u.id = p.id
   and u.last_sign_in_at is not null
   and p.last_login_at is null;
