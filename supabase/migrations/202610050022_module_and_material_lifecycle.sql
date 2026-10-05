-- Admin module editing, archival and safe deletion, plus saved material version
-- retirement.
--
-- The admin page could only create modules and change status. A trainer could
-- not correct a title, reorder a module, or retire a saved material version at
-- all, so an incorrect curriculum could only be worked around rather than
-- fixed.
--
-- Two data hazards shaped this design.
--
-- 1. public.module_translations.module_id and public.quizzes.module_id are both
--    `on delete cascade`. A plain `delete from modules` therefore erases every
--    saved material version and every authored knowledge check for that module,
--    including assessment history that students have already sat. This migration
--    adds `archived_at` so a referenced module is archived instead, and
--    `admin_purge_module` refuses to run at all unless the module is an unused
--    draft with no rows anywhere referencing it.
--
-- 2. public.enrollment_modules.required is the learner's completion
--    requirement, and public.certificate_eligibility compares the count of
--    required snapshot rows against course_certificate_configs. Archiving a
--    required module without touching the snapshot would leave a learner staring
--    at a module they can no longer open while still being blocked on it, so
--    every requirement change here is explicit and audited.
--
-- Renaming never changes requirements: title, summary and position updates only
-- touch the modules row. `required` changes require apply_to_existing and
-- reconcile snapshots deliberately.

begin;

-- ---------------------------------------------------------------------------
-- 1. Archival columns
-- ---------------------------------------------------------------------------

-- A null archived_at is the live row. Archived rows stay in the database and
-- stay reachable to learners who already have them in their snapshot.
alter table public.modules add column if not exists archived_at timestamptz;
alter table public.modules add column if not exists archived_from_status public.module_status;

comment on column public.modules.archived_at is
  'Set when an administrator archived this module. Non-null hides it from new curriculum selection and blocks permanent deletion. Preserves every student reference.';
comment on column public.modules.archived_from_status is
  'The status this module held when it was archived, so Restore can return it to the state the trainer actually left it in.';

alter table public.module_translations add column if not exists archived_at timestamptz;

comment on column public.module_translations.archived_at is
  'Set when an administrator retired this saved material version. Non-null hides it from the default list and from material access while preserving the row and its file for history.';

-- A version that is archived must never be handed to a student, including when
-- it was the newest published one. issue_material_access picks the newest
-- published version, so an archived-but-published row would keep being served.
-- The parameter default must be repeated exactly: create or replace cannot
-- remove a default that already exists on the deployed signature.
create or replace function public.issue_material_access(
  caller_user uuid,
  target_module uuid,
  requested_language text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_enrollment public.enrollments%rowtype;
  wanted public.app_language;
  served_language public.app_language := 'en';
  used_fallback boolean := false;
  refusal text;
  chosen public.module_translations%rowtype;
  refusal_enrollment uuid;
  target_object_path text;
begin
  if caller_user is null then raise exception 'Authentication required'; end if;
  if requested_language not in ('en', 'ceb') then raise exception 'Unsupported language'; end if;
  wanted := requested_language::public.app_language;

  select * into caller_enrollment
  from public.enrollments e
  where e.user_id = caller_user
    and e.status = 'active'
    and public.is_account_active(caller_user)
  order by e.created_at desc
  limit 1;

  if not found then refusal := 'No active enrollment was found for this account'; end if;

  if refusal is null and not exists (
    select 1 from public.enrollment_modules em
    where em.enrollment_id = caller_enrollment.id and em.module_id = target_module
  ) then
    refusal := 'This module is not part of your curriculum';
  end if;

  if refusal is null and not exists (
    select 1 from public.modules where id = target_module and status = 'published' and archived_at is null
  ) then
    refusal := 'This module is not published';
  end if;

  if refusal is null then
    -- An archived version is skipped entirely. Previously issued signed URLs
    -- stay valid until they expire, which is stated in the admin UI rather than
    -- promised away here.
    select * into chosen from public.module_translations
    where module_id = target_module and language = wanted and published and archived_at is null
    order by version desc limit 1;

    if not found then
      select * into chosen from public.module_translations
      where module_id = target_module and language = 'en' and published and archived_at is null
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

    return jsonb_build_object('allowed', false, 'error', refusal, 'moduleId', target_module);
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

-- ---------------------------------------------------------------------------
-- 2. Edit a module
-- ---------------------------------------------------------------------------

-- Renaming, reordering and status are metadata-only changes and never touch
-- enrollment_modules. Only `required` can change a completion requirement, and
-- only when apply_to_existing is true, which re-snapshots every active
-- enrollment for the course.
create or replace function public.admin_edit_module(
  target_module uuid,
  new_canonical_title text,
  new_position integer,
  new_required boolean,
  new_status text,
  reason text,
  apply_to_existing boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  current_row public.modules;
  target_course uuid;
  title_before text;
  title_after text;
  position_before integer;
  position_after integer;
  required_before boolean;
  required_after boolean;
  status_before public.module_status;
  status_after public.module_status;
  moved_enrollments integer := 0;
  required_snapshots integer := 0;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into current_row from public.modules where id = target_module for update;
  if not found then raise exception 'Module not found'; end if;
  target_course := current_row.course_id;

  if current_row.archived_at is not null then
    raise exception 'This module is archived. Restore it before editing.';
  end if;

  title_after := nullif(trim(coalesce(new_canonical_title, '')), '');
  if title_after is not null and char_length(title_after) > 200 then
    raise exception 'Module title must be 200 characters or fewer';
  end if;

  if new_status is not null and new_status not in ('draft', 'published') then
    raise exception 'Use Archive to retire a module, or Restore to bring an archived one back';
  end if;

  position_after := coalesce(new_position, current_row.position);
  if position_after < 1 then raise exception 'Module order must be 1 or higher'; end if;

  required_after := coalesce(new_required, current_row.required);
  status_after := coalesce(new_status::public.module_status, current_row.status);

  title_before := current_row.canonical_title;
  position_before := current_row.position;
  required_before := current_row.required;
  status_before := current_row.status;

  -- modules has unique (course_id, position), so a move that lands on an
  -- occupied slot would abort mid-statement. The occupant is shifted out of the
  -- way first, and the vacated slot is closed at the end, so both modules keep a
  -- valid position and neither row is left duplicate.
  if position_after <> position_before then
    if exists (
      select 1 from public.modules
      where course_id = target_course and id <> target_module and position = position_after
    ) then
      update public.modules
      set position = position_before, updated_at = now()
      where course_id = target_course and id <> target_module and position = position_after;
    end if;
  end if;

  update public.modules
  set canonical_title = title_after,
      position = position_after,
      required = required_after,
      status = status_after,
      updated_at = now()
  where id = target_module;

  -- A requirement change is the only edit that can strand a learner, so it is
  -- never implicit. apply_to_existing re-snapshots active enrollments, which
  -- updates the required flag on their existing rows without adding or removing
  -- modules.
  if required_after is distinct from required_before and apply_to_existing then
    update public.enrollment_modules em
    set required = required_after,
        curriculum_version = current_row.curriculum_version
    where em.module_id = target_module;
    get diagnostics required_snapshots = row_count;

    perform public.snapshot_curriculum(e.id)
    from public.enrollments e
    where e.course_id = target_course and e.status = 'active';
    get diagnostics moved_enrollments = row_count;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.edited', 'module', target_module::text, trim(reason),
    jsonb_build_object(
      'title_before', title_before,
      'title_after', title_after,
      'position_before', position_before,
      'position_after', position_after,
      'required_before', required_before,
      'required_after', required_after,
      'status_before', status_before,
      'status_after', status_after,
      'requirement_reconciled', (required_after is distinct from required_before) and apply_to_existing,
      'snapshot_rows_updated', required_snapshots,
      'enrollments_resnapshotted', moved_enrollments));

  return jsonb_build_object(
    'moduleId', target_module,
    'canonicalTitle', title_after,
    'position', position_after,
    'required', required_after,
    'status', status_after,
    'requirementReconciled', (required_after is distinct from required_before) and apply_to_existing,
    'snapshotRowsUpdated', required_snapshots,
    'enrollmentsResnapshotted', moved_enrollments
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Archive, restore, purge
-- ---------------------------------------------------------------------------

-- Reports exactly what a delete would affect, so the confirmation dialog can
-- state the real impact instead of a generic warning.
create or replace function public.admin_module_delete_impact(target_module uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  module_row public.modules;
  snapshot_count integer;
  progress_count integer;
  access_count integer;
  translation_count integer;
  quiz_count integer;
  certificate_count integer;
  other_translation_count integer;
  purge_blocked boolean;
  blockers text[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'Administrator role required';
  end if;

  select * into module_row from public.modules where id = target_module;
  if not found then raise exception 'Module not found'; end if;

  select count(*) into snapshot_count from public.enrollment_modules where module_id = target_module;
  select count(*) into progress_count from public.module_progress where module_id = target_module;
  select count(*) into access_count from public.material_access_events where module_id = target_module;
  select count(*) into translation_count from public.module_translations where module_id = target_module;
  select count(*) into quiz_count from public.quizzes where module_id = target_module;
  -- A certificate that counted this module as required is the hardest history
  -- to lose, because it is an artifact already issued to a student.
  select count(*) into certificate_count
  from public.certificates c
  where exists (
    select 1 from public.enrollment_modules em
    where em.enrollment_id = c.enrollment_id and em.module_id = target_module
  );
  select count(*) into other_translation_count
  from public.quiz_questions q
  join public.quizzes qz on qz.id = q.quiz_id
  where qz.module_id = target_module;

  purge_blocked := snapshot_count > 0 or progress_count > 0 or access_count > 0
    or translation_count > 0 or quiz_count > 0 or other_translation_count > 0
    or module_row.status <> 'draft';

  if snapshot_count > 0 then
    blockers := blockers || format('%s enrollment(s) reference this module.', snapshot_count);
  end if;
  if progress_count > 0 then
    blockers := blockers || format('%s student progress record(s) exist.', progress_count);
  end if;
  if access_count > 0 then
    blockers := blockers || format('%s material access record(s) exist.', access_count);
  end if;
  if translation_count > 0 then
    blockers := blockers || format('%s saved material version(s) are stored.', translation_count);
  end if;
  if quiz_count > 0 then
    blockers := blockers || format('%s knowledge check(s) are authored.', quiz_count);
  end if;
  if certificate_count > 0 then
    blockers := blockers || format('%s issued certificate(s) counted this module.', certificate_count);
  end if;
  if module_row.status <> 'draft' then
    blockers := blockers || 'Only an unused draft module can be permanently deleted.';
  end if;

  return jsonb_build_object(
    'moduleId', target_module,
    'title', coalesce(nullif(module_row.canonical_title, ''), 'Module ' || module_row.position::text),
    'status', module_row.status,
    'required', module_row.required,
    'archivedAt', module_row.archived_at,
    'enrollmentReferences', snapshot_count,
    'progressRecords', progress_count,
    'materialAccessRecords', access_count,
    'materialVersions', translation_count,
    'knowledgeChecks', quiz_count,
    'questionCount', other_translation_count,
    'certificateReferences', certificate_count,
    'canArchive', true,
    'canPurge', not purge_blocked,
    'blockers', to_jsonb(blockers)
  );
end;
$$;

-- Archiving hides the module from new curriculum snapshots and unpublishes it,
-- but keeps every row. Snapshot requirements are made optional so no learner is
-- left blocked on something they can no longer open.
create or replace function public.admin_archive_module(target_module uuid, reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  module_row public.modules;
  released_snapshots integer := 0;
  detached_enrollments integer := 0;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into module_row from public.modules where id = target_module for update;
  if not found then raise exception 'Module not found'; end if;
  if module_row.archived_at is not null then
    raise exception 'This module is already archived';
  end if;

  update public.modules
  set status = 'archived',
      archived_at = now(),
      archived_from_status = module_row.status,
      updated_at = now()
  where id = target_module;

  -- A required module that is archived would still be counted by
  -- enrollment_progress and certificate_eligibility while being unopenable, so
  -- the snapshot requirement is released rather than left as a trap.
  if module_row.required then
    update public.enrollment_modules set required = false where module_id = target_module and required;
    get diagnostics released_snapshots = row_count;
  end if;

  -- Students who already completed it keep their completion row and their
  -- certificate still counts the module they actually finished.
  perform public.snapshot_curriculum(e.id)
  from public.enrollments e
  join public.enrollment_modules em on em.enrollment_id = e.id and em.module_id = target_module
  where e.course_id = module_row.course_id and e.status = 'active';
  get diagnostics detached_enrollments = row_count;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.archived', 'module', target_module::text, trim(reason),
    jsonb_build_object(
      'previous_status', module_row.status,
      'required', module_row.required,
      'snapshot_requirements_released', released_snapshots,
      'enrollments_resnapshotted', detached_enrollments,
      'data_preserved', true));

  return jsonb_build_object(
    'moduleId', target_module,
    'archivedAt', jsonb_build_object('at', now()),
    'snapshotRequirementsReleased', released_snapshots,
    'dataPreserved', true
  );
end;
$$;

-- Restore returns the module to the status it held before archiving and, only
-- when asked, puts the requirement back. Reinstating a requirement is opt-in
-- because it can immediately block a learner who had already finished.
create or replace function public.admin_restore_module(
  target_module uuid,
  reason text,
  restore_requirement boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  module_row public.modules;
  reinstated_snapshots integer := 0;
  resnapshotted integer := 0;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into module_row from public.modules where id = target_module for update;
  if not found then raise exception 'Module not found'; end if;
  if module_row.archived_at is null then
    raise exception 'This module is not archived';
  end if;

  update public.modules
  set status = coalesce(module_row.archived_from_status, 'draft'::public.module_status),
      archived_at = null,
      archived_from_status = null,
      updated_at = now()
  where id = target_module;

  if restore_requirement and module_row.required then
    update public.enrollment_modules set required = true where module_id = target_module;
    get diagnostics reinstated_snapshots = row_count;

    perform public.snapshot_curriculum(e.id)
    from public.enrollments e
    where e.course_id = module_row.course_id and e.status = 'active';
    get diagnostics resnapshotted = row_count;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.restored', 'module', target_module::text, trim(reason),
    jsonb_build_object(
      'restored_status', coalesce(module_row.archived_from_status, 'draft'::public.module_status),
      'requirement_reinstated', restore_requirement and module_row.required,
      'snapshot_rows_reinstated', reinstated_snapshots));

  return jsonb_build_object(
    'moduleId', target_module,
    'status', coalesce(module_row.archived_from_status, 'draft'::public.module_status),
    'requirementReinstated', restore_requirement and module_row.required,
    'snapshotRowsReinstated', reinstated_snapshots
  );
end;
$$;

-- Permanent deletion is only ever an unused draft. Every other case archives, so
-- this function refuses rather than cascading into assessment history.
create or replace function public.admin_purge_module(target_module uuid, reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  module_row public.modules;
  snapshot_count integer;
  progress_count integer;
  access_count integer;
  translation_count integer;
  quiz_count integer;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into module_row from public.modules where id = target_module for update;
  if not found then raise exception 'Module not found'; end if;

  if module_row.status <> 'draft' or module_row.archived_at is not null then
    raise exception 'Only an unused draft module can be permanently deleted. Archive it instead.';
  end if;

  select count(*) into snapshot_count from public.enrollment_modules where module_id = target_module;
  select count(*) into progress_count from public.module_progress where module_id = target_module;
  select count(*) into access_count from public.material_access_events where module_id = target_module;
  select count(*) into translation_count from public.module_translations where module_id = target_module;
  select count(*) into quiz_count from public.quizzes where module_id = target_module;

  if snapshot_count > 0 or progress_count > 0 or access_count > 0 or translation_count > 0 or quiz_count > 0 then
    raise exception
      'This module is referenced by enrollment, progress, material access, saved material or a knowledge check, so it cannot be deleted. Archive it instead to preserve that history.';
  end if;

  -- module_translations.module_id and quizzes.module_id are ON DELETE CASCADE, so
  -- reaching this point means nothing of either kind exists.
  delete from public.modules where id = target_module;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.purged', 'module', target_module::text, trim(reason),
    jsonb_build_object('position', module_row.position, 'title', module_row.canonical_title));

  return jsonb_build_object('moduleId', target_module, 'purged', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Saved material versions
-- ---------------------------------------------------------------------------

-- Reports what deleting one saved version would touch, including whether it is
-- the version currently served to students.
create or replace function public.admin_material_version_impact(target_translation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  translation_row public.module_translations;
  access_count integer;
  newer_published_count integer;
  older_published_count integer;
  shares_object integer;
  is_served boolean;
  archive_only boolean;
begin
  if not public.is_admin() then
    raise exception 'Administrator role required';
  end if;

  select * into translation_row from public.module_translations where id = target_translation;
  if not found then raise exception 'Material version not found'; end if;

  select count(*) into access_count
  from public.material_access_events
  where object_path = translation_row.object_path and event_type = 'link_issued';

  select count(*) into newer_published_count
  from public.module_translations
  where module_id = translation_row.module_id
    and language = translation_row.language
    and published and archived_at is null and version > translation_row.version;

  select count(*) into older_published_count
  from public.module_translations
  where module_id = translation_row.module_id
    and language = translation_row.language
    and published and archived_at is null and version < translation_row.version;

  -- object_path is globally unique in module_translations, but the check is kept
  -- so a shared object is never deleted from Storage even if that changes.
  select count(*) into shares_object
  from public.module_translations
  where object_path = translation_row.object_path and id <> target_translation;

  is_served := translation_row.published and translation_row.archived_at is null;
  archive_only := access_count > 0 or shares_object > 0 or is_served;

  return jsonb_build_object(
    'translationId', target_translation,
    'moduleId', translation_row.module_id,
    'language', translation_row.language,
    'version', translation_row.version,
    'title', translation_row.title,
    'objectPath', translation_row.object_path,
    'sizeBytes', translation_row.size_bytes,
    'published', translation_row.published,
    'archivedAt', translation_row.archived_at,
    'isServed', is_served,
    'accessEvents', access_count,
    'newerPublishedAvailable', newer_published_count,
    'olderPublishedAvailable', older_published_count,
    'sharedObjectReferences', shares_object,
    'canPurge', not archive_only,
    'mustArchive', archive_only
  );
end;
$$;

-- Retires a version. When it is the version students are currently served, a
-- replacement must be named or the material explicitly unpublished, so an older
-- version is never silently exposed and the material is never left pointing at
-- nothing.
create or replace function public.admin_archive_material_version(
  target_translation uuid,
  reason text,
  replacement_translation uuid default null,
  unpublish_material boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  translation_row public.module_translations;
  replacement_row public.module_translations;
  unpublishing boolean := false;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into translation_row from public.module_translations where id = target_translation for update;
  if not found then raise exception 'Material version not found'; end if;
  if translation_row.archived_at is not null then
    raise exception 'This material version is already archived';
  end if;

  if replacement_translation is not null and replacement_translation = target_translation then
    raise exception 'Choose a different version as the replacement';
  end if;

  if translation_row.published and translation_row.archived_at is null then
    if replacement_translation is null and not unpublish_material then
      raise exception
        'This is the version students currently receive. Select a replacement version or explicitly unpublish this material before archiving it, so students are never silently switched to an older version.';
    end if;

    if replacement_translation is not null then
      select * into replacement_row from public.module_translations
      where id = replacement_translation and module_id = translation_row.module_id
        and language = translation_row.language and archived_at is null;

      if not found then
        raise exception 'The replacement must be another live version of the same module and language';
      end if;

      update public.module_translations
      set published = true
      where id = replacement_translation;
    end if;

    unpublishing := unpublish_material or replacement_translation is null;
  end if;

  -- Archiving always clears published so the retired version can never be chosen
  -- by issue_material_access again.
  update public.module_translations
  set archived_at = now(), published = false
  where id = target_translation;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'material.version_archived', 'module_translation', target_translation::text, trim(reason),
    jsonb_build_object(
      'moduleId', translation_row.module_id,
      'language', translation_row.language,
      'version', translation_row.version,
      'objectPath', translation_row.object_path,
      'replacementTranslationId', replacement_translation,
      'material_unpublished', unpublishing,
      'file_retained', true));

  return jsonb_build_object(
    'translationId', target_translation,
    'archived', true,
    'replacementTranslationId', replacement_translation,
    'materialUnpublished', unpublishing,
    'fileRetained', true
  );
end;
$$;

-- Permanent deletion is limited to a version that was never served and whose
-- object nothing else references. The row is removed here; the trusted Edge
-- Function removes the file afterwards and reports back, so a failed Storage
-- delete never leaves a dangling row.
create or replace function public.admin_purge_material_version(
  caller_user uuid,
  target_translation uuid,
  reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := caller_user;
  translation_row public.module_translations;
  access_count integer;
  shares_object integer;
  pending_preview text;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into translation_row from public.module_translations where id = target_translation for update;
  if not found then raise exception 'Material version not found'; end if;

  if translation_row.published or translation_row.archived_at is null then
    raise exception
      'This version is still published or live. Archive it first, or choose an unused draft version, so no student loses access unexpectedly.';
  end if;

  select count(*) into access_count
  from public.material_access_events
  where object_path = translation_row.object_path;

  select count(*) into shares_object
  from public.module_translations
  where object_path = translation_row.object_path and id <> target_translation;

  if access_count > 0 or shares_object > 0 then
    raise exception
      'This version has access history or a shared file, so it can only be archived. Archiving hides it from the default list while preserving the record and the file.';
  end if;

  -- A PowerPoint version may have a companion preview generated beside it.
  -- Only a preview that belongs exclusively to this version is returned for
  -- removal; a shared asset is left alone.
  pending_preview := case
    when translation_row.object_path ~ '\.(ppt|pptx)$'
      then regexp_replace(translation_row.object_path, '\.(ppt|pptx)$', '.preview.pdf')
    else null
  end;

  delete from public.module_translations where id = target_translation;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'material.version_purged', 'module_translation', target_translation::text, trim(reason),
    jsonb_build_object(
      'moduleId', translation_row.module_id,
      'language', translation_row.language,
      'version', translation_row.version,
      'objectPath', translation_row.object_path,
      'previewObjectPath', pending_preview,
      'signed_urls_note', 'Previously issued signed URLs remain usable until they expire'));

  return jsonb_build_object(
    'translationId', target_translation,
    'purged', true,
    'objectPath', translation_row.object_path,
    'previewObjectPath', pending_preview
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.admin_edit_module(uuid, text, integer, boolean, text, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_module_delete_impact(uuid) from public, anon, authenticated;
revoke all on function public.admin_archive_module(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_restore_module(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_purge_module(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_material_version_impact(uuid) from public, anon, authenticated;
revoke all on function public.admin_archive_material_version(uuid, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_purge_material_version(uuid, uuid, text) from public, anon, authenticated;

-- The read-only impact reports and the metadata edits are safe for any
-- authenticated admin to call directly: each one re-checks is_admin() inside.
grant execute on function public.admin_edit_module(uuid, text, integer, boolean, text, text, boolean) to authenticated;
grant execute on function public.admin_module_delete_impact(uuid) to authenticated;
grant execute on function public.admin_archive_module(uuid, text) to authenticated;
grant execute on function public.admin_restore_module(uuid, text, boolean) to authenticated;
grant execute on function public.admin_purge_module(uuid, text) to authenticated;
grant execute on function public.admin_material_version_impact(uuid) to authenticated;
grant execute on function public.admin_archive_material_version(uuid, text, uuid, boolean) to authenticated;

-- Purging a material version removes a row the browser must never be able to
-- touch directly, so it is reachable only through the service role held by the
-- verified Edge Function.
grant execute on function public.admin_purge_material_version(uuid, uuid, text) to service_role;

commit;
