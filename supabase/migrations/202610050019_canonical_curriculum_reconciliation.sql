-- Canonical eight-module reconciliation.
--
-- Confirmed cause of the certificate blocker: every module row for course
-- 3bc1e477-8736-42f2-8a1d-e5eeda290f39 was published + required, including the
-- extra NULL-title row at position 9. snapshot_curriculum therefore gave each
-- new enrollment nine required rows, while course_certificate_configs requires
-- exactly eight (the owner-approved curriculum). ensure_certificate compares
-- those two numbers, so it denied issuance even though every module was
-- completed and the final assessment was passed.
--
-- The final-quiz gate and the certificate gate disagreed because the quiz gate
-- uses the enrollment's required set while the certificate gate uses the
-- owner-approved count, and nothing reconciled the two. This migration makes the
-- required set equal the approved eight so all three gates agree.
--
-- Rules honoured here:
--   * no snapshot row is ever deleted
--   * module 9 is demoted, not removed, so its study history is preserved
--   * no progress row and no quiz attempt is touched
--   * material rows that only ever held the certificate template are unpublished,
--     never deleted

begin;

-- ---------------------------------------------------------------------------
-- 1. Canonical approved eight. Positions 1-8 must match the approved manifest.
-- ---------------------------------------------------------------------------
create temporary table canonical_eight on commit drop as
select * from (values
  (1::integer, '994538f1-1544-4df0-aaba-f968f7addf93'::uuid, 'Logistics Fundamentals'),
  (2, 'ca1f067e-b499-46c2-8471-256072d0071a', 'Trucks & Equipment'),
  (3, '3d3f0426-7385-4cea-b43e-cb7f2b1d2002', 'Carrier Sourcing'),
  (4, '7196d8c5-0632-4427-841b-c8c2469e781b', 'Booking and Rate Negotiation'),
  (5, '7228d8b9-f80b-47b0-97c1-e3af7b8df2d4', 'Documents'),
  (6, '0be31428-21bb-40b5-9110-0e9ebdb6c122', 'Dispatch and Track and Trace'),
  (7, '108173b3-9266-4b4a-b18b-bb6bb28a7275', 'Accessorials'),
  (8, '99ce1711-cb3b-4daa-a4a8-09e4b3c092ce', 'Delivery and Load Closing')
) as t(position, module_id, canonical_title);

do $$
declare
  mismatch text;
begin
  select string_agg(
           c.position::text || ': expected ' || c.canonical_title || ' but found '
           || coalesce(m.canonical_title, '(null)'),
           ' | ')
  into mismatch
  from canonical_eight c
  left join public.modules m on m.id = c.module_id
  where m.id is null or m.canonical_title is distinct from c.canonical_title;

  if mismatch is not null then
    raise exception 'Canonical curriculum mismatch, refusing to reconcile: %', mismatch;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Approved eight stay published + required; every other module of the same
--    course is demoted to a non-required draft (row preserved).
-- ---------------------------------------------------------------------------
update public.modules m
set required = true, status = 'published', updated_at = now()
where m.id in (select module_id from canonical_eight)
  and (m.required is distinct from true or m.status is distinct from 'published');

update public.modules m
set required = false, status = 'draft', updated_at = now()
where m.course_id = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'
  and m.id not in (select module_id from canonical_eight)
  and (m.required is distinct from false or m.status is distinct from 'draft');

-- ---------------------------------------------------------------------------
-- 3. Snapshot reconciliation across existing enrollments. Forward-only: add
--    missing approved rows, drop the required flag from demoted rows, never
--    delete a row and never touch module_progress.
-- ---------------------------------------------------------------------------
insert into public.enrollment_modules (enrollment_id, module_id, required, curriculum_version, created_at)
select e.id, c.module_id, true, m.curriculum_version, now()
from public.enrollments e
cross join canonical_eight c
join public.modules m on m.id = c.module_id
where e.course_id = m.course_id
on conflict (enrollment_id, module_id) do nothing;

update public.enrollment_modules em
set required = true
where em.module_id in (select module_id from canonical_eight)
  and em.required is distinct from true;

update public.enrollment_modules em
set required = false
where em.module_id in (
    select m.id from public.modules m
    where m.course_id = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'
      and m.id not in (select module_id from canonical_eight))
  and em.required is distinct from false;

-- ---------------------------------------------------------------------------
-- 4. Unpublish material rows that only ever contained the certificate template.
--    The certificate PDF was uploaded as "the lesson" for several modules, which
--    hid the real content gaps. Rows are unpublished, not deleted, and the
--    genuine Module 1 PowerPoint material is untouched.
-- ---------------------------------------------------------------------------
update public.module_translations mt
set published = false
where mt.sha256 in (
    select template_sha256 from public.course_certificate_configs
    where course_id = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'
      and template_sha256 is not null)
  and mt.published;

commit;

-- ---------------------------------------------------------------------------
-- 5. certificate_eligibility: reports every unmet condition separately so the
--    learner UI can show a real reason instead of one generic message.
-- ---------------------------------------------------------------------------
create or replace function public.certificate_eligibility(target_enrollment uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target public.enrollments%rowtype;
  config public.course_certificate_configs%rowtype;
  required_count integer;
  completed_count integer;
  outstanding_count integer;
  outstanding_titles text;
  best_score numeric;
  blockers text[] := '{}';
  cert_status text;
begin
  if caller is null then
    raise exception 'Authentication required';
  end if;

  select * into target from public.enrollments where id = target_enrollment;
  if not found then
    raise exception 'Enrollment not found';
  end if;
  if target.user_id <> caller and not public.is_admin(caller) then
    raise exception 'Access denied';
  end if;

  select * into config from public.course_certificate_configs where course_id = target.course_id;

  select count(*) filter (where em.required),
         count(*) filter (where em.required and mp.completed_at is not null),
         count(*) filter (where em.required and mp.completed_at is null)
  into required_count, completed_count, outstanding_count
  from public.enrollment_modules em
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target.id;

  select coalesce(string_agg(coalesce(m.canonical_title, 'Untitled module'), ', ' order by m.position), '')
  into outstanding_titles
  from public.enrollment_modules em
  join public.modules m on m.id = em.module_id
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target.id and em.required and mp.completed_at is null;

  select max(qa.score) into best_score
  from public.quiz_attempts qa
  join public.quizzes q on q.id = qa.quiz_id
  where qa.enrollment_id = target.id and qa.kind = 'final' and qa.state = 'scored';

  select status into cert_status from public.certificates where enrollment_id = target.id;

  if config.id is null or not config.enabled then
    blockers := blockers || 'Certificate issuance is not enabled for this course.';
  end if;

  if target.status <> 'active' or not public.is_account_active(target.user_id) then
    blockers := blockers || 'An active enrollment and account are required.';
  end if;

  if config.id is not null and required_count <> config.required_module_count then
    blockers := blockers || format(
      'Your curriculum has %s required modules but the approved certificate curriculum has %s. An administrator needs to reconcile the module list.',
      required_count, config.required_module_count);
  end if;

  if outstanding_count > 0 then
    blockers := blockers || format('%s required module(s) are still incomplete: %s.',
      outstanding_count, outstanding_titles);
  end if;

  if config.id is not null and (best_score is null or best_score < config.minimum_score) then
    blockers := blockers || format(
      'A passing final assessment score of at least %s is required. Your best score is %s.',
      config.minimum_score, coalesce(best_score::text, 'none'));
  end if;

  return jsonb_build_object(
    'course_id', target.course_id,
    'config_enabled', coalesce(config.enabled, false),
    'enrollment_active', target.status = 'active' and public.is_account_active(target.user_id),
    'expected_module_count', config.required_module_count,
    'required_module_count', required_count,
    'required_completed', completed_count,
    'required_outstanding', outstanding_count,
    'outstanding_titles', outstanding_titles,
    'required_score', config.minimum_score,
    'best_final_score', best_score,
    'certificate_status', cert_status,
    'eligible', coalesce(array_length(blockers, 1), 0) = 0,
    'blockers', to_jsonb(blockers)
  );
end;
$$;

revoke all on function public.certificate_eligibility(uuid) from public, anon;
grant execute on function public.certificate_eligibility(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Drift report so this drift is visible before a learner hits it. Reports
--    any module whose required flag disagrees with the approved eight, plus the
--    number of enrollments currently counting it as required.
-- ---------------------------------------------------------------------------
create or replace function public.curriculum_required_drift(target_course uuid)
returns table (
  module_id uuid,
  module_position integer,
  canonical_title text,
  module_status module_status,
  module_required boolean,
  in_approved_curriculum boolean,
  enrollments_counting_required bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with approved as (
    select * from (values
      ('994538f1-1544-4df0-aaba-f968f7addf93'::uuid),
      ('ca1f067e-b499-46c2-8471-256072d0071a'::uuid),
      ('3d3f0426-7385-4cea-b43e-cb7f2b1d2002'::uuid),
      ('7196d8c5-0632-4427-841b-c8c2469e781b'::uuid),
      ('7228d8b9-f80b-47b0-97c1-e3af7b8df2d4'::uuid),
      ('0be31428-21bb-40b5-9110-0e9ebdb6c122'::uuid),
      ('108173b3-9266-4b4a-b18b-bb6bb28a7275'::uuid),
      ('99ce1711-cb3b-4daa-a4a8-09e4b3c092ce'::uuid)
    ) as t(module_id)
  )
  select m.id,
         m.position as module_position,
         m.canonical_title,
         m.status,
         m.required,
         (a.module_id is not null) as in_approved_curriculum,
         (select count(*) from public.enrollment_modules em where em.module_id = m.id and em.required)
  from public.modules m
  left join approved a on a.module_id = m.id
  where m.course_id = target_course
    and m.required is distinct from (a.module_id is not null)
  order by m.position;
$$;

revoke all on function public.curriculum_required_drift(uuid) from public, anon;
grant execute on function public.curriculum_required_drift(uuid) to authenticated;