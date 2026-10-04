-- Day 2 follow-up: entitlement-checked material access and bilingual material
-- authoring, exposed to the frontend only through trusted server operations.
--
-- Design note: authorization lives here, in Postgres, not in Edge Function
-- JavaScript. Each function takes an explicit caller id that the Edge Function
-- resolves from the caller's JWT, then re-checks entitlement, account status,
-- curriculum membership and publication state itself. A bug in the function
-- cannot grant access that these functions refuse.

-- public.material_access_events is created in the Day 2 learning migration. This
-- file only adds the functions that write to it and the owner read policy.

-- Grants one enrolled student a short-lived link to the module PDF they are
-- entitled to. Called with the service role by the course-material-access
-- function after resolving the caller from the bearer token.
--
-- Language fallback is decided here and reported back explicitly, so the UI can
-- label a substituted version rather than silently serving the wrong language.
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
  caller_enrollment public.enrollments;
  wanted public.app_language;
  chosen public.module_translations;
  served_language public.app_language;
  used_fallback boolean := false;
  target_object_path text;
  refusal text;
  refusal_enrollment uuid;
  requested_text text;
  preferred_text text;
  effective_text text;
begin
  -- Refusals are recorded and returned, never raised. A raised exception would
  -- roll back the very access_denied row that refund and support review depends
  -- on, and it would also hide the reason from the caller.
  requested_text := nullif(trim(requested_language), '');

  select p.preferred_language::text into preferred_text
  from public.profiles p
  where p.id = caller_user;

  if preferred_text is null then
    refusal := 'Profile not found';
  end if;

  effective_text := coalesce(requested_text, preferred_text, 'en');

  -- Validate before casting. Casting an unsupported language straight to the
  -- enum would raise, which would abort the transaction and lose the denial.
  if effective_text not in ('en', 'ceb') then
    refusal := 'Unsupported language';
  else
    wanted := effective_text::public.app_language;
  end if;

  if refusal is null then
    select * into caller_enrollment
    from public.enrollments e
    where e.user_id = caller_user
      and e.course_id = (select course_id from public.modules where id = target_module)
      and e.status = 'active';
    if not found then
      refusal := 'An active enrollment is required for this material';
    end if;
  end if;

  if refusal is null and not public.is_account_active(caller_user) then
    refusal := 'Account is not active';
  end if;

  -- The module must belong to this enrollment's snapshot, so a module published
  -- after approval is not silently readable.
  if refusal is null and not exists (
    select 1 from public.enrollment_modules em
    where em.enrollment_id = caller_enrollment.id and em.module_id = target_module
  ) then
    refusal := 'This module is not part of your curriculum';
  end if;

  if refusal is null and not exists (
    select 1 from public.modules where id = target_module and status = 'published'
  ) then
    refusal := 'This module is not published';
  end if;

  if refusal is null then
    select * into chosen from public.module_translations
    where module_id = target_module and language = wanted and published
    order by version desc limit 1;

    if not found then
      select * into chosen from public.module_translations
      where module_id = target_module and language = 'en' and published
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

  refusal_enrollment := case when caller_enrollment.id is null then null else caller_enrollment.id end;

  if refusal is not null then
    insert into public.material_access_events (user_id, enrollment_id, module_id, object_path, event_type)
    values (caller_user, refusal_enrollment, target_module, '', 'access_denied');

    return jsonb_build_object(
      'allowed', false,
      'error', refusal,
      'moduleId', target_module
    );
  end if;

  target_object_path := chosen.object_path;

  insert into public.material_access_events (user_id, enrollment_id, module_id, object_path, event_type)
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

-- Records a new immutable material version. The previous version is retained so
-- a bad replacement can be rolled back by pointing at the earlier row.
create or replace function public.admin_save_module_translation(
  caller_user uuid,
  target_module uuid,
  translation_language text,
  translation_title text,
  translation_summary text,
  asset_object_path text,
  asset_sha256 text,
  asset_size_bytes integer,
  publish_now boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := caller_user;
  next_version integer;
  translation_id uuid;
  existing public.module_translations;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if translation_language not in ('en', 'ceb') then
    raise exception 'Unsupported language';
  end if;
  if not exists (select 1 from public.modules where id = target_module) then
    raise exception 'Module not found';
  end if;
  if coalesce(length(trim(translation_title)), 0) = 0 then
    raise exception 'A title is required';
  end if;
  if coalesce(length(trim(asset_object_path)), 0) = 0 or coalesce(length(trim(asset_sha256)), 0) <> 64 then
    raise exception 'A stored object path and content hash are required';
  end if;
  if asset_size_bytes is null or asset_size_bytes < 1 or asset_size_bytes > 52428800 then
    raise exception 'Material must be a PDF of 50 MB or less';
  end if;
  if exists (
    select 1 from public.module_translations mt
    where mt.object_path = asset_object_path and mt.module_id <> target_module
  ) then
    raise exception 'This object is already registered to another module';
  end if;

  -- Re-uploading the identical file is a no-op rather than an error. The caller
  -- sees the existing version back, so a retry after a dropped response cannot
  -- fail on the unique object_path constraint or create a duplicate version.
  select * into existing
  from public.module_translations mt
  where mt.object_path = trim(asset_object_path)
    and mt.module_id = target_module
    and mt.language = translation_language::public.app_language
    and mt.sha256 = lower(trim(asset_sha256));

  if found then
    return jsonb_build_object(
      'translationId', existing.id,
      'moduleId', target_module,
      'language', translation_language,
      'version', existing.version,
      'published', existing.published,
      'title', existing.title,
      'objectPath', existing.object_path,
      'sizeBytes', existing.size_bytes,
      'fileName', split_part(existing.object_path, '/', 3),
      'unchanged', true
    );
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.module_translations
  where module_id = target_module and language = translation_language::public.app_language;

  insert into public.module_translations (
    module_id, language, version, title, summary, object_path, sha256, size_bytes, published, created_by
  )
  values (
    target_module, translation_language::public.app_language, next_version,
    trim(translation_title), coalesce(translation_summary, ''), trim(asset_object_path),
    lower(trim(asset_sha256)), asset_size_bytes, coalesce(publish_now, false), operator_id
  )
  returning id into translation_id;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (operator_id, 'material.saved', 'module', target_module::text,
    jsonb_build_object(
      'translationId', translation_id,
      'language', translation_language,
      'version', next_version,
      'published', coalesce(publish_now, false),
      'sizeBytes', asset_size_bytes));

  return jsonb_build_object(
    'translationId', translation_id,
    'moduleId', target_module,
    'language', translation_language,
    'version', next_version,
    'published', coalesce(publish_now, false),
    'title', trim(translation_title),
    'objectPath', trim(asset_object_path),
    'sizeBytes', asset_size_bytes,
    'fileName', split_part(trim(asset_object_path), '/', 3),
    'unchanged', false
  );
end;
$$;

-- Publishes one previously saved version. Publishing a translation does not
-- publish its module; that stays an explicit, separate decision.
create or replace function public.admin_set_translation_published(
  caller_user uuid,
  target_translation uuid,
  publish_now boolean,
  reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if caller_user is null or not public.is_admin(caller_user) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  update public.module_translations
  set published = coalesce(publish_now, false)
  where id = target_translation;

  if not found then
    raise exception 'Material version not found';
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (caller_user, 'material.publication', 'module_translation', target_translation::text,
    trim(reason), jsonb_build_object('published', coalesce(publish_now, false)));
end;
$$;

alter table public.material_access_events enable row level security;

create policy material_events_owner_read on public.material_access_events
  for select to authenticated using (user_id = auth.uid() and public.is_account_active(auth.uid()));

revoke all on function public.issue_material_access(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_save_module_translation(uuid, uuid, text, text, text, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.admin_set_translation_published(uuid, uuid, boolean, text) from public, anon, authenticated;

-- Only the Edge Functions hold the service role, so these two operations are
-- reachable solely through verified bearer tokens.
grant execute on function public.issue_material_access(uuid, uuid, text) to service_role;
grant execute on function public.admin_save_module_translation(uuid, uuid, text, text, text, text, text, integer, boolean) to service_role;
grant execute on function public.admin_set_translation_published(uuid, uuid, boolean, text) to service_role;

-- Admins preview material before students can reach it; students never get a
-- direct Storage grant, because access must go through the entitlement check.
create policy course_materials_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'course-materials' and public.is_admin());
create policy course_materials_service_insert on storage.objects for insert to service_role
  with check (bucket_id = 'course-materials');
create policy course_materials_service_delete on storage.objects for delete to service_role
  using (bucket_id = 'course-materials');