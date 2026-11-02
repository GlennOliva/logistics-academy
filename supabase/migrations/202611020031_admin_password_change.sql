-- Administrative password changes. Passwords are never handled by these
-- functions: the Edge Function validates the policy, calls the Supabase Auth
-- Admin API, then uses these service-role-only helpers to revoke refresh
-- sessions and write an audit event. auth.users is never modified with SQL.

create table private.admin_password_change_limits (
  actor_user uuid not null,
  window_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (actor_user, window_start)
);

-- The admin directory is the only browser-facing read of an account email.
-- auth.users is not exposed through the Data API, so this security-definer
-- function returns only the fields the Users screen needs and refuses every
-- caller who is not an active administrator.
create or replace function public.admin_user_directory()
returns table (
  user_id uuid,
  email text,
  full_name text,
  preferred_language public.app_language,
  account_status public.account_status,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator role required';
  end if;

  return query
  select
    u.id,
    u.email,
    coalesce(p.full_name, 'Student'),
    coalesce(p.preferred_language, 'en'::public.app_language),
    coalesce(p.account_status, 'active'::public.account_status),
    coalesce(p.created_at, u.created_at)
  from auth.users u
  left join public.profiles p on p.id = u.id
  order by coalesce(p.created_at, u.created_at) desc;
end;
$$;

-- Fixed ten-minute windows, ten attempts per acting administrator. The table
-- lives in the private schema so a browser can neither read nor reset it.
create or replace function public.admin_consume_password_change_rate_limit(actor_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_count integer;
  current_window timestamptz := to_timestamp(floor(extract(epoch from now()) / 600) * 600);
begin
  if actor_user is null or not public.is_admin(actor_user) then
    raise exception 'Administrator role required';
  end if;

  delete from private.admin_password_change_limits
  where window_start < now() - interval '1 hour';

  insert into private.admin_password_change_limits (actor_user, window_start, request_count)
  values (actor_user, current_window, 1)
  on conflict (actor_user, window_start) do update
    set request_count = private.admin_password_change_limits.request_count + 1
  returning request_count into current_count;

  return current_count <= 10;
end;
$$;

create or replace function public.admin_record_password_change(
  caller_user uuid,
  target_user uuid,
  outcome text,
  sessions_revoked boolean default false,
  sessions_deleted integer default 0
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  event_id bigint;
begin
  if caller_user is null or not public.is_admin(caller_user) then
    raise exception 'Administrator role required';
  end if;
  if target_user is null then
    raise exception 'A target user is required';
  end if;
  if outcome not in (
    'password_updated',
    'password_updated_sessions_not_revoked',
    'password_update_failed'
  ) then
    raise exception 'Unsupported password-change outcome';
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    caller_user,
    'auth.password_changed',
    'user',
    target_user::text,
    jsonb_build_object(
      'outcome', outcome,
      'sessions_revoked', coalesce(sessions_revoked, false),
      'sessions_deleted', greatest(coalesce(sessions_deleted, 0), 0)
    )
  )
  returning id into event_id;

  return event_id;
end;
$$;

-- Supabase Auth has no documented revoke-all-sessions-by-user-id admin API.
-- Deleting the user's auth.sessions rows is the same operation GoTrue performs
-- for a global sign-out; refresh tokens then fail because their session is
-- gone. Already-issued access tokens remain valid until their JWT expiry.
create or replace function public.admin_finalize_password_change(
  caller_user uuid,
  target_user uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  deleted_sessions integer;
begin
  if caller_user is null or not public.is_admin(caller_user) then
    raise exception 'Administrator role required';
  end if;
  if target_user is null then
    raise exception 'A target user is required';
  end if;

  delete from auth.sessions where user_id = target_user;
  get diagnostics deleted_sessions = row_count;

  perform public.admin_record_password_change(
    caller_user,
    target_user,
    'password_updated',
    true,
    deleted_sessions
  );

  return jsonb_build_object(
    'sessionsDeleted', deleted_sessions,
    'auditRecorded', true
  );
end;
$$;

revoke all on private.admin_password_change_limits from public, anon, authenticated;

revoke all on function public.admin_user_directory() from public, anon, authenticated;
revoke all on function public.admin_consume_password_change_rate_limit(uuid) from public, anon, authenticated;
revoke all on function public.admin_record_password_change(uuid, uuid, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_finalize_password_change(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_user_directory() to authenticated;
grant execute on function public.admin_consume_password_change_rate_limit(uuid) to service_role;
grant execute on function public.admin_record_password_change(uuid, uuid, text, boolean, integer) to service_role;
grant execute on function public.admin_finalize_password_change(uuid, uuid) to service_role;
