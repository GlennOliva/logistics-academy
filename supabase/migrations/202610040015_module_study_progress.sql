-- "Mark lesson as studied" must record study progress for any module in the
-- student's own curriculum snapshot once the module itself is published.
--
-- The previous implementation refused the write unless a published
-- module_translations row already existed. That coupled lesson-study progress to
-- material import timing: a learner enrolled in a published module could not
-- record studying it until its translation had been uploaded, so the browser
-- button stayed on "Mark lesson as studied" with no progress change and no
-- server-side alternative. Publication is a module-level fact, and
-- material_available is a separate display concern handled by the interface.

create or replace function public.mark_module_studied(target_module uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment_row public.enrollments;
begin
  if auth.uid() is null or not public.is_account_active(auth.uid()) then
    raise exception 'Active account required';
  end if;

  select * into enrollment_row from public.enrollments
  where user_id = auth.uid() and course_id = (select course_id from public.modules where id = target_module)
    and status = 'active'
  for update;
  if not found then raise exception 'Active enrollment required'; end if;

  if not exists (
    select 1 from public.enrollment_modules em
    where em.enrollment_id = enrollment_row.id and em.module_id = target_module
  ) then
    raise exception 'Module is not part of your curriculum snapshot';
  end if;

  if not exists (
    select 1 from public.modules m
    where m.id = target_module and m.status = 'published'
  ) then
    raise exception 'Module is not published yet';
  end if;

  -- Progress is a single row per (enrollment, module). Keeping the first
  -- timestamp means repeated clicks cannot inflate or rewrite study progress.
  insert into public.module_progress (enrollment_id, module_id, studied_at)
  values (enrollment_row.id, target_module, now())
  on conflict (enrollment_id, module_id) do update
    set studied_at = coalesce(public.module_progress.studied_at, now()), updated_at = now();

  -- Studying a lesson is necessary but never sufficient for module completion:
  -- a required knowledge check must also be recorded.
  update public.module_progress mp set completed_at = now()
  where mp.enrollment_id = enrollment_row.id and mp.module_id = target_module
    and mp.studied_at is not null and mp.knowledge_check_completed_at is not null and mp.completed_at is null;
end;
$$;