-- Supabase Auth defines auth.users.email as character varying(255), while the
-- browser-facing directory contract returns text. PL/pgSQL RETURN QUERY does
-- not implicitly coerce that row field, so make every returned type explicit.

do $$
declare
  active_admin uuid;
  email_type text;
  failure_message text;
  failure_detail text;
begin
  select format_type(a.atttypid, a.atttypmod)
  into email_type
  from pg_attribute a
  where a.attrelid = 'auth.users'::regclass
    and a.attname = 'email'
    and not a.attisdropped;

  raise notice 'admin_user_directory source auth.users.email type: %', email_type;

  select ur.user_id
  into active_admin
  from public.user_roles ur
  join public.profiles p on p.id = ur.user_id
  where ur.role = 'admin'
    and p.account_status = 'active'
  limit 1;

  if active_admin is not null then
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', active_admin, 'role', 'authenticated')::text,
      true
    );

    begin
      perform 1 from public.admin_user_directory() limit 1;
    exception when others then
      get stacked diagnostics
        failure_message = message_text,
        failure_detail = pg_exception_detail;
      raise notice 'admin_user_directory pre-fix error: %; detail: %',
        failure_message,
        failure_detail;
    end;
  end if;
end;
$$;

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
    u.id::uuid,
    u.email::text,
    coalesce(p.full_name, 'Student'::text)::text,
    coalesce(p.preferred_language, 'en'::public.app_language)::public.app_language,
    coalesce(p.account_status, 'active'::public.account_status)::public.account_status,
    coalesce(p.created_at, u.created_at)::timestamptz
  from auth.users u
  left join public.profiles p on p.id = u.id
  order by coalesce(p.created_at, u.created_at) desc;
end;
$$;

revoke all on function public.admin_user_directory() from public, anon, authenticated;
grant execute on function public.admin_user_directory() to authenticated;

notify pgrst, 'reload schema';
