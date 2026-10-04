-- The course tracker conflated two different things.
--
-- "percent_complete" counted only modules whose completed_at was set, which
-- requires BOTH a studied lesson and a recorded knowledge check. A learner who
-- had studied every lesson still saw 0%, because completion could not advance
-- until the knowledge checks were also done. That made "Mark lesson as studied"
-- look like it did nothing.
--
-- Lesson-study progress and overall course completion are now reported
-- separately and both are computed from the enrollment's own curriculum
-- snapshot:
--   required_studied  / required_total  -> percent_studied   (lesson study)
--   required_complete / required_total  -> percent_complete (overall)
--
-- final_unlocked keeps requiring real completion, so reporting study progress
-- cannot unlock the final assessment or a certificate.

-- Postgres cannot change a function's return type in place, and dependent
-- objects exist, so the old signature is dropped and recreated.
drop function if exists public.enrollment_progress(uuid);

create or replace function public.enrollment_progress(target_enrollment uuid)
returns table (
  required_total integer,
  required_complete integer,
  percent_complete integer,
  required_studied integer,
  percent_studied integer,
  final_unlocked boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  totals record;
begin
  if not exists (
    select 1 from public.enrollments e
    where e.id = target_enrollment
      and ((e.user_id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin())
  ) then
    raise exception 'Enrollment not available';
  end if;

  select
    count(*) filter (where em.required)::integer as required_total,
    count(*) filter (where em.required and mp.completed_at is not null)::integer as required_complete,
    count(*) filter (where em.required and mp.studied_at is not null)::integer as required_studied
  into totals
  from public.enrollment_modules em
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target_enrollment;

  return query select
    totals.required_total,
    totals.required_complete,
    case when coalesce(totals.required_total, 0) = 0 then 0
      else round(totals.required_complete * 100.0 / totals.required_total)::integer end,
    totals.required_studied,
    case when coalesce(totals.required_total, 0) = 0 then 0
      else round(totals.required_studied * 100.0 / totals.required_total)::integer end,
    totals.required_total > 0 and totals.required_complete = totals.required_total;
end;
$$;