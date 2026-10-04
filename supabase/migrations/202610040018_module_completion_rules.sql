-- Module completion must not require a knowledge check that the module does not
-- actually require.
--
-- Completion was hard-coded to "studied_at AND knowledge_check_completed_at".
-- knowledge_check_completed_at is only ever written by submit_quiz_attempt, so a
-- module with no knowledge_check quiz could never complete: the learner reached
-- 100% lesson-study progress and stayed at 0% overall completion with no error
-- and no way forward.
--
-- Rules implemented here:
--   * no knowledge_check quiz for the module -> studying completes the module;
--   * knowledge_check quiz exists and is published+enabled -> studying plus a
--     scored attempt completes the module (unchanged);
--   * knowledge_check quiz exists but has no published, enabled version -> the
--     module cannot complete and is reported as content-unavailable to the
--     learner and to an admin, rather than being silently stuck at 0%.

-- ---------------------------------------------------------------------------
-- Shared, security-definer helpers so the rule is defined exactly once.
-- ---------------------------------------------------------------------------

create or replace function public.module_requires_knowledge_check(target_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quizzes q
    where q.module_id = target_module
      and q.kind = 'knowledge_check'
  );
$$;

create or replace function public.module_knowledge_check_available(target_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quizzes q
    join public.quiz_versions qv on qv.quiz_id = q.id
    where q.module_id = target_module
      and q.kind = 'knowledge_check'
      and qv.status = 'published'
      and qv.enabled
  );
$$;

-- ---------------------------------------------------------------------------
-- Study now completes any module that does not require a knowledge check.
-- ---------------------------------------------------------------------------

create or replace function public.mark_module_studied(target_module uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment_row public.enrollments;
  check_required boolean;
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

  select public.module_requires_knowledge_check(target_module) into check_required;

  -- Progress is a single row per (enrollment, module). Keeping the first
  -- timestamp means repeated clicks cannot inflate or rewrite study progress.
  insert into public.module_progress (enrollment_id, module_id, studied_at)
  values (enrollment_row.id, target_module, now())
  on conflict (enrollment_id, module_id) do update
    set studied_at = coalesce(public.module_progress.studied_at, now()), updated_at = now();

  -- A module that requires no knowledge check is complete once studied. A module
  -- that does require one still needs a scored attempt, which submit_quiz_attempt
  -- records separately.
  if not check_required then
    update public.module_progress mp
    set completed_at = coalesce(mp.completed_at, now()), updated_at = now()
    where mp.enrollment_id = enrollment_row.id
      and mp.module_id = target_module
      and mp.studied_at is not null
      and mp.completed_at is null;
    return;
  end if;

  -- Defensive: if the check was already scored, studying finishes the module.
  update public.module_progress mp
  set completed_at = coalesce(mp.completed_at, now()), updated_at = now()
  where mp.enrollment_id = enrollment_row.id
    and mp.module_id = target_module
    and mp.studied_at is not null
    and mp.knowledge_check_completed_at is not null
    and mp.completed_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Progress gains the counts the interface needs to explain itself.
-- ---------------------------------------------------------------------------

drop function if exists public.enrollment_progress(uuid);

create function public.enrollment_progress(target_enrollment uuid)
returns table (
  required_total integer,
  required_complete integer,
  percent_complete numeric,
  final_unlocked boolean,
  required_studied integer,
  percent_studied numeric,
  checks_required integer,
  checks_outstanding integer,
  checks_unavailable integer
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

  -- Completed modules are counted from module_progress.completed_at only, and the
  -- join is on (enrollment_id, module_id), so a module can never be counted twice.
  -- The denominator is the enrollment's own snapshot, not the live curriculum.
  select
    count(*) filter (where em.required)::integer as required_total,
    count(*) filter (where em.required and mp.completed_at is not null)::integer as required_complete,
    count(*) filter (where em.required and mp.studied_at is not null)::integer as required_studied,
    count(*) filter (where em.required and public.module_requires_knowledge_check(em.module_id))::integer as checks_required,
    count(*) filter (
      where em.required
        and public.module_requires_knowledge_check(em.module_id)
        and mp.knowledge_check_completed_at is null
    )::integer as checks_outstanding,
    count(*) filter (
      where em.required
        and public.module_requires_knowledge_check(em.module_id)
        and not public.module_knowledge_check_available(em.module_id)
    )::integer as checks_unavailable
  into totals
  from public.enrollment_modules em
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target_enrollment;

  return query select
    totals.required_total,
    totals.required_complete,
    case when totals.required_total = 0 then 0
         else round(totals.required_complete * 100.0 / totals.required_total, 1) end,
    totals.required_total > 0
      and totals.required_complete = totals.required_total,
    totals.required_studied,
    case when totals.required_total = 0 then 0
         else round(totals.required_studied * 100.0 / totals.required_total, 1) end,
    totals.checks_required,
    totals.checks_outstanding,
    totals.checks_unavailable;
end;
$$;

revoke all on function public.enrollment_progress(uuid) from public, anon, authenticated;
grant execute on function public.enrollment_progress(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Per-module outstanding requirements, so the learner sees what is left.
-- ---------------------------------------------------------------------------

create or replace function public.module_requirements(target_enrollment uuid)
returns table (
  module_id uuid,
  module_position integer,
  title text,
  required boolean,
  studied_at timestamptz,
  completed_at timestamptz,
  requires_check boolean,
  check_available boolean,
  check_completed_at timestamptz,
  outstanding text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.enrollments e
    where e.id = target_enrollment
      and ((e.user_id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin())
  ) then
    raise exception 'Enrollment not available';
  end if;

  return query
  select
    m.id,
    m.position,
    coalesce(nullif(m.canonical_title, ''), 'Module ' || m.position::text),
    em.required,
    mp.studied_at,
    mp.completed_at,
    public.module_requires_knowledge_check(m.id),
    public.module_knowledge_check_available(m.id),
    mp.knowledge_check_completed_at,
    case
      when mp.completed_at is not null then null
      when public.module_requires_knowledge_check(m.id)
        and not public.module_knowledge_check_available(m.id) then 'content_unavailable'
      when mp.studied_at is null then 'lesson'
      else 'knowledge_check'
    end
  from public.enrollment_modules em
  join public.modules m on m.id = em.module_id
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target_enrollment
  order by m.position;
end;
$$;

revoke all on function public.module_requirements(uuid) from public, anon;
grant execute on function public.module_requirements(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin view of the content gaps behind the learner-facing message.
-- ---------------------------------------------------------------------------

create or replace function public.admin_knowledge_check_gaps()
returns table (
  module_id uuid,
  module_position integer,
  title text,
  module_status public.module_status,
  check_exists boolean,
  check_available boolean,
  gap text
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
    m.id,
    m.position,
    coalesce(nullif(m.canonical_title, ''), 'Module ' || m.position::text),
    m.status,
    public.module_requires_knowledge_check(m.id),
    public.module_knowledge_check_available(m.id),
    case
      when public.module_knowledge_check_available(m.id) then null
      when public.module_requires_knowledge_check(m.id) then 'check_not_published'
      else 'no_check_authored'
    end
  from public.modules m
  where m.required
  order by m.position;
end;
$$;

revoke all on function public.admin_knowledge_check_gaps() from public, anon, authenticated;
grant execute on function public.admin_knowledge_check_gaps() to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: modules already studied that require no knowledge check are complete.
-- ---------------------------------------------------------------------------

update public.module_progress mp
set completed_at = coalesce(mp.completed_at, mp.studied_at), updated_at = now()
where mp.studied_at is not null
  and mp.completed_at is null
  and mp.knowledge_check_completed_at is null
  and not public.module_requires_knowledge_check(mp.module_id);

comment on function public.module_requires_knowledge_check(uuid) is
  'A module requires a knowledge check exactly when a knowledge_check quiz exists for it.';
comment on function public.module_knowledge_check_available(uuid) is
  'A module''s required knowledge check is deliverable when it has a published and enabled version.';
comment on function public.module_requirements(uuid) is
  'Per-module outstanding requirement for the learner: lesson, knowledge_check, content_unavailable, or null when complete.';