-- Restore material access after the lifecycle migration accidentally changed
-- this write-producing function from VOLATILE to STABLE. Also select the
-- enrollment for the module's own course instead of the learner's newest
-- enrollment across every course.

begin;

create or replace function public.issue_material_access(
  caller_user uuid,
  target_module uuid,
  requested_language text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_enrollment public.enrollments%rowtype;
  module_row public.modules%rowtype;
  wanted public.app_language;
  served_language public.app_language := 'en'::public.app_language;
  used_fallback boolean := false;
  refusal text;
  chosen public.module_translations%rowtype;
  refusal_enrollment uuid;
  target_object_path text;
  requested_text text;
  preferred_text text;
  effective_text text;
begin
  if caller_user is null then raise exception 'Authentication required'; end if;

  select * into module_row from public.modules where id = target_module;
  if not found then refusal := 'Module not found'; end if;

  requested_text := nullif(trim(requested_language), '');
  select p.preferred_language::text into preferred_text
  from public.profiles p where p.id = caller_user;

  if preferred_text is null then refusal := 'Profile not found'; end if;

  effective_text := coalesce(requested_text, preferred_text, 'en');
  if effective_text not in ('en', 'ceb') then
    refusal := 'Unsupported language';
  else
    wanted := effective_text::public.app_language;
  end if;

  if refusal is null and not public.is_account_active(caller_user) then
    refusal := 'Account is not active';
  end if;

  if refusal is null then
    select e.* into caller_enrollment
    from public.enrollments e
    where e.user_id = caller_user
      and e.course_id = module_row.course_id
      and e.status = 'active'
    order by e.created_at desc
    limit 1;

    if not found then
      refusal := 'An active enrollment is required for this material';
    end if;
  end if;

  -- Snapshot membership is authoritative. A later live curriculum-version
  -- change must not erase access that was granted in the learner's snapshot.
  if refusal is null and not exists (
    select 1 from public.enrollment_modules em
    where em.enrollment_id = caller_enrollment.id and em.module_id = target_module
  ) then
    refusal := 'This module is not part of your curriculum';
  end if;

  if refusal is null
     and (module_row.status <> 'published' or module_row.archived_at is not null) then
    refusal := 'This module is not published';
  end if;

  if refusal is null then
    select * into chosen from public.module_translations
    where module_id = target_module and language = wanted
      and published and archived_at is null and purge_pending_at is null
    order by version desc limit 1;

    if not found then
      select * into chosen from public.module_translations
      where module_id = target_module and language = 'en'
        and published and archived_at is null and purge_pending_at is null
      order by version desc limit 1;
      if found then
        served_language := 'en';
        used_fallback := true;
      end if;
    else
      served_language := wanted;
    end if;

    if not found then
      refusal := 'No published material is available for this module';
    end if;
  end if;

  refusal_enrollment := caller_enrollment.id;

  if refusal is not null then
    insert into public.material_access_events
      (user_id, enrollment_id, module_id, object_path, event_type)
    values (caller_user, refusal_enrollment, target_module, '', 'access_denied');

    return jsonb_build_object(
      'allowed', false,
      'error', refusal,
      'moduleId', target_module
    );
  end if;

  target_object_path := chosen.object_path;
  insert into public.material_access_events
    (user_id, enrollment_id, module_id, object_path, event_type)
  values (caller_user, caller_enrollment.id, target_module, target_object_path, 'link_issued');

  return jsonb_build_object(
    'allowed', true,
    'objectPath', target_object_path,
    'title', chosen.title,
    'language', served_language,
    'requestedLanguage', wanted,
    'fallback', used_fallback,
    'version', chosen.version,
    'sha256', chosen.sha256,
    'sizeBytes', chosen.size_bytes
  );
end;
$$;

revoke all on function public.issue_material_access(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.issue_material_access(uuid, uuid, text)
  to service_role;

commit;
