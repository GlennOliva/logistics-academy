-- Corrective follow-up to 202610050019.
--
-- public.certificate_eligibility was created in 019 with `config.id`, but
-- public.course_certificate_configs is keyed by course_id and has no id column,
-- so the function compiled but failed at runtime with
--   42P03 / 42703: record "config" has no field "id"
-- The certificate issuance path was therefore reporting an error instead of a
-- per-condition breakdown. This replaces the function with the corrected body.
--
-- No guard is relaxed here: eligibility reporting only. public.ensure_certificate
-- keeps its original checks untouched.

begin;

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

  select * into config
  from public.course_certificate_configs
  where course_id = target.course_id;

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

  select c.status into cert_status
  from public.certificates c
  where c.enrollment_id = target.id;

  if config.course_id is null or not config.enabled then
    blockers := blockers || 'Certificate issuance is not enabled for this course.';
  end if;

  if target.status <> 'active' or not public.is_account_active(target.user_id) then
    blockers := blockers || 'An active enrollment and account are required.';
  end if;

  if config.course_id is not null and required_count <> config.required_module_count then
    blockers := blockers || format(
      'Your curriculum has %s required modules but the approved certificate curriculum has %s. An administrator needs to reconcile the module list.',
      required_count, config.required_module_count);
  end if;

  if outstanding_count > 0 then
    blockers := blockers || format('%s required module(s) are still incomplete: %s.',
      outstanding_count, outstanding_titles);
  end if;

  if config.course_id is not null and (best_score is null or best_score < config.minimum_score) then
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

commit;