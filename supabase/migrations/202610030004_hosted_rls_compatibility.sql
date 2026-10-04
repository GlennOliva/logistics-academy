-- Hosted RLS compatibility follow-up.
--
-- The original course policy applied one expression to both anon and
-- authenticated. PostgreSQL may evaluate is_admin() even when status is already
-- published, but anon intentionally has no execute grant on is_admin(). Split
-- the policies so a public catalog read never invokes a privileged helper.

drop policy if exists courses_public_read on public.courses;

create policy courses_anon_read on public.courses
  for select to anon
  using (status = 'published');

create policy courses_authenticated_read on public.courses
  for select to authenticated
  using (
    (status = 'published' and public.is_account_active(auth.uid()))
    or public.is_admin()
  );
