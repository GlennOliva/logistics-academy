-- A suspended account must not retain administrator authority.
create or replace function public.is_admin(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = target_user
      and ur.role = 'admin'
      and p.account_status = 'active'
  );
$$;

revoke insert, update, delete, truncate on public.user_roles from anon, authenticated;
