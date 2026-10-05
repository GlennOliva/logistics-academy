-- Corrects the lifecycle behaviour applied in 202610050022. Every change here
-- was found by running scripts/probe-module-lifecycle.mjs against the linked
-- test project, not by inspection alone.
--
-- 1. admin_module_delete_impact referenced quiz_questions.quiz_id, which does not
--    exist. Questions link to a quiz through quiz_versions, so the delete dialog
--    raised on every module and no impact could ever be shown.
-- 2. admin_purge_material_version rejected every version whose archived_at was
--    null, which is exactly the unused draft the admin UI offers to purge.
-- 3. Material purge deleted the database row before Storage was cleaned up, so a
--    failed Storage delete left no retry target. It also guessed a companion
--    preview path from the file extension even though no preview or conversion
--    job is recorded anywhere in the schema.
-- 4. Requirement changes never touched course_certificate_configs, so reconciling
--    enrollment snapshots could leave certificate eligibility unattainable.
-- 5. Moving a published, required module back to draft could strand learners on a
--    module they can no longer open.
-- 6. There was no way to edit the English/Bisaya display title or summary.

begin;

-- ---------------------------------------------------------------------------
-- 1. Retryable, auditable material file deletion
-- ---------------------------------------------------------------------------

-- The purge of a saved version is split in two so that the file is removed
-- before the row that describes it. A crash or a Storage failure between the two
-- steps leaves the version archived with purge_pending_at set: nothing
-- references a missing file, the original file is still there, and the same
-- request can be retried safely.
alter table public.module_translations
  add column if not exists purge_pending_at timestamptz,
  add column if not exists purge_requested_by uuid references auth.users (id) on delete set null,
  add column if not exists purge_reason text;

comment on column public.module_translations.purge_pending_at is
  'Set when permanent deletion has been authorised and the Storage object still needs to be removed.';

-- Phase 1. Authorises and records the deletion, archives the version, and hands
-- the trusted Edge Function the one object path it is allowed to remove.
create or replace function public.admin_request_material_version_purge(
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
  already_pending boolean;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into translation_row
  from public.module_translations where id = target_translation for update;
  if not found then raise exception 'Material version not found'; end if;

  -- A retry of a request that is already pending returns the same object path
  -- instead of failing, so the admin can simply try again.
  already_pending := translation_row.purge_pending_at is not null;

  if not already_pending then
    if translation_row.published then
      raise exception
        'This version is still published. Archive it, choosing a replacement version or explicitly unpublishing the material, before deleting it permanently.';
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

    update public.module_translations
    set archived_at = coalesce(archived_at, now()),
        published = false,
        purge_pending_at = now(),
        purge_requested_by = operator_id,
        purge_reason = trim(reason)
    where id = target_translation;

    insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
    values (operator_id, 'material.version_purge_requested', 'module_translation', target_translation::text, trim(reason),
      jsonb_build_object(
        'moduleId', translation_row.module_id,
        'language', translation_row.language,
        'version', translation_row.version,
        'objectPath', translation_row.object_path,
        'already_archived', translation_row.archived_at is not null,
        'companion_preview', 'none recorded: no preview or conversion job is tracked for this version',
        'signed_urls_note', 'Previously issued signed URLs remain usable until they expire'));
  end if;

  return jsonb_build_object(
    'translationId', target_translation,
    'moduleId', translation_row.module_id,
    'objectPath', translation_row.object_path,
    'sizeBytes', translation_row.size_bytes,
    'previewObjectPath', null,
    'retry', already_pending
  );
end;
$$;

-- Phase 2. Runs only after the Storage object is gone. Removing the row last is
-- what keeps a failed cleanup retryable instead of leaving a broken reference.
create or replace function public.admin_finalize_material_version_purge(
  caller_user uuid,
  target_translation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := caller_user;
  translation_row public.module_translations;
  module_id uuid;
  language public.app_language;
  version_number integer;
  object_path text;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;

  select * into translation_row
  from public.module_translations where id = target_translation for update;
  if not found then
    -- Already finalised. Reporting success keeps the Edge Function idempotent.
    return jsonb_build_object('translationId', target_translation, 'purged', true, 'alreadyFinalized', true);
  end if;

  if translation_row.purge_pending_at is null then
    raise exception 'This version was not approved for permanent deletion';
  end if;

  module_id := translation_row.module_id;
  language := translation_row.language;
  version_number := translation_row.version;
  object_path := translation_row.object_path;

  delete from public.module_translations where id = target_translation;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'material.version_purged', 'module_translation', target_translation::text,
    coalesce(translation_row.purge_reason, 'Permanent deletion'),
    jsonb_build_object(
      'moduleId', module_id,
      'language', language,
      'version', version_number,
      'objectPath', object_path,
      'storage_object_removed', true,
      'companion_preview_removed', false,
      'companion_preview_note', 'none recorded: no preview or conversion job is tracked for this version',
      'signed_urls_note', 'Previously issued signed URLs remain usable until they expire'));

  return jsonb_build_object(
    'translationId', target_translation,
    'purged', true,
    'objectPath', object_path,
    'alreadyFinalized', false
  );
end;
$$;

-- Retire the single-step version so no code path can delete the row first.
drop function if exists public.admin_purge_material_version(uuid, uuid, text);

-- ---------------------------------------------------------------------------
-- 2. Impact reports that run
-- ---------------------------------------------------------------------------

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
  question_count integer;
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
  -- quiz_questions has no quiz_id: questions belong to a quiz through
  -- quiz_versions.quiz_id. Reading quiz_questions.quiz_id aborted this whole
  -- function for every module.
  select count(*) into question_count
  from public.quiz_questions q
  join public.quiz_versions qv on qv.id = q.quiz_version_id
  join public.quizzes qz on qz.id = qv.quiz_id
  where qz.module_id = target_module;

  purge_blocked := snapshot_count > 0 or progress_count > 0 or access_count > 0
    or translation_count > 0 or quiz_count > 0 or question_count > 0
    or module_row.status <> 'draft';

  if snapshot_count > 0 then
    blockers := array_append(blockers, format('%s enrollment(s) reference this module.', snapshot_count));
  end if;
  if progress_count > 0 then
    blockers := array_append(blockers, format('%s student progress record(s) exist.', progress_count));
  end if;
  if access_count > 0 then
    blockers := array_append(blockers, format('%s material access record(s) exist.', access_count));
  end if;
  if translation_count > 0 then
    blockers := array_append(blockers, format('%s saved material version(s) are stored.', translation_count));
  end if;
  if quiz_count > 0 then
    blockers := array_append(blockers, format('%s knowledge check(s) are authored.', quiz_count));
  end if;
  if question_count > 0 then
    blockers := array_append(blockers, format('%s knowledge check question(s) are authored.', question_count));
  end if;
  if certificate_count > 0 then
    blockers := array_append(blockers, format('%s issued certificate(s) counted this module.', certificate_count));
  end if;
  if module_row.status <> 'draft' then
    blockers := array_append(blockers, 'Only an unused draft module can be permanently deleted.');
  end if;

  return jsonb_build_object(
    'moduleId', target_module,
    'position', module_row.position,
    'title', coalesce(nullif(module_row.canonical_title, ''), 'Module ' || module_row.position::text),
    'status', module_row.status,
    'required', module_row.required,
    'archivedAt', module_row.archived_at,
    'enrollmentReferences', snapshot_count,
    'progressRecords', progress_count,
    'materialAccessRecords', access_count,
    'materialVersions', translation_count,
    'knowledgeChecks', quiz_count,
    'questionCount', question_count,
    'certificateReferences', certificate_count,
    'canArchive', true,
    'canPurge', not purge_blocked,
    'blockers', to_jsonb(blockers)
  );
end;
$$;

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
  has_access_history boolean;
  purge_blocked boolean;
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

  -- object_path is unique per version, but the check is kept so a shared object
  -- is never deleted from Storage even if that ever changes.
  select count(*) into shares_object
  from public.module_translations
  where object_path = translation_row.object_path and id <> target_translation;

  -- issue_material_access serves the highest published, non-archived version, so
  -- only that row is the one students actually receive.
  is_served := translation_row.published
    and translation_row.archived_at is null
    and newer_published_count = 0;

  has_access_history := access_count > 0;

  -- A version can be deleted permanently once it is not published and nothing
  -- points at its file. An unused live draft qualifies; it does not have to be
  -- archived first.
  purge_blocked := has_access_history or shares_object > 0 or translation_row.published;

  return jsonb_build_object(
    'translationId', target_translation,
    'moduleId', translation_row.module_id,
    'language', translation_row.language,
    'version', translation_row.version,
    'title', translation_row.title,
    'summary', translation_row.summary,
    'objectPath', translation_row.object_path,
    'sizeBytes', translation_row.size_bytes,
    'published', translation_row.published,
    'archivedAt', translation_row.archived_at,
    'purgePendingAt', translation_row.purge_pending_at,
    'isServed', is_served,
    'accessEvents', access_count,
    'hasEnrollmentLink', false,
    'enrollmentLinkNote', 'material versions are not linked to an enrollment directly; access history is the only recorded usage',
    'hasAccessHistory', has_access_history,
    'newerPublishedAvailable', newer_published_count,
    'olderPublishedAvailable', older_published_count,
    'sharedObjectReferences', shares_object,
    'hasCompanionPreview', false,
    'hasConversionJob', false,
    'companionNote', 'no preview or conversion job is recorded for a material version',
    'canPurge', not purge_blocked,
    'mustArchive', translation_row.published
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Editing that cannot strand a learner
-- ---------------------------------------------------------------------------

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
  requirement_reconciled boolean := false;
  availability_changed boolean := false;
  required_snapshot_count integer := 0;
  released_snapshots integer := 0;
  resnapshotted integer := 0;
  live_required_count integer;
  certificate_count_before integer;
  certificate_count_after integer;
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

  -- Taking a module out of publication while students are still required to
  -- complete it would leave them blocked on something they cannot open. That is
  -- refused unless the same action reconciles their snapshots.
  if status_after <> 'published'::public.module_status
     and status_before = 'published'::public.module_status
     and required_after then
    select count(*) into required_snapshot_count
    from public.enrollment_modules where module_id = target_module and required;

    if required_snapshot_count > 0 and not apply_to_existing then
      raise exception
        'Current students are still required to complete this module, and it would no longer be open to them. Tick the reconciliation box to release the requirement in the same action, or archive the module instead.';
    end if;
  end if;

  -- modules has unique (course_id, position), so a move that lands on an
  -- occupied slot would abort mid-statement. The occupant is moved to the slot
  -- being vacated, which swaps the two without ever duplicating a position.
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

  requirement_reconciled :=
    (required_after is distinct from required_before)
    or (status_after is distinct from status_before);

  if apply_to_existing and requirement_reconciled then
    -- Republishing adds the module to current enrollments; unpublishing a module
    -- students are still required to finish releases that requirement so nobody
    -- is left blocked.
    if status_after <> 'published'::public.module_status and required_after then
      update public.enrollment_modules set required = false
      where module_id = target_module and required;
      get diagnostics released_snapshots = row_count;
    end if;

    update public.enrollment_modules em
    set required = required_after,
        curriculum_version = current_row.curriculum_version
    where em.module_id = target_module
      and status_after = 'published'::public.module_status
      and em.required is distinct from required_after;

    perform public.snapshot_curriculum(e.id)
    from public.enrollments e
    where e.course_id = target_course and e.status = 'active';
    get diagnostics resnapshotted = row_count;

    -- Certificate eligibility compares a learner's completed requirements with
    -- course_certificate_configs.required_module_count. Changing what students
    -- must complete without moving that number leaves an unattainable
    -- certificate, so the count is reconciled in the same confirmed action.
    select coalesce(required_module_count, 0) into certificate_count_before
    from public.course_certificate_configs where course_id = target_course;

    select count(*) into live_required_count
    from public.modules
    where course_id = target_course and required
      and status = 'published' and archived_at is null;

    update public.course_certificate_configs
    set required_module_count = live_required_count, updated_at = now()
    where course_id = target_course;

    select coalesce(required_module_count, 0) into certificate_count_after
    from public.course_certificate_configs where course_id = target_course;

    availability_changed := status_after is distinct from status_before;
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
      'requirement_reconciled', apply_to_existing and requirement_reconciled,
      'availability_changed', availability_changed,
      'snapshot_requirements_released', released_snapshots,
      'enrollments_resnapshotted', resnapshotted,
      'certificate_required_module_count_before', certificate_count_before,
      'certificate_required_module_count_after', certificate_count_after));

  return jsonb_build_object(
    'moduleId', target_module,
    'title', coalesce(title_after, title_before),
    'position', position_after,
    'required', required_after,
    'status', status_after,
    'requirementReconciled', apply_to_existing and requirement_reconciled,
    'snapshotRequirementsReleased', released_snapshots,
    'enrollmentsResnapshotted', resnapshotted,
    'certificateRequiredModuleCount', certificate_count_after,
    'filesReplaced', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Display titles and summaries
-- ---------------------------------------------------------------------------

-- The canonical module title and the per-language display title and summary are
-- edited together so a trainer never ends up with a half-saved change. Files,
-- versions, checks and progress are not touched: this changes wording only.
create or replace function public.admin_edit_module_details(
  target_module uuid,
  new_canonical_title text,
  english_title text,
  english_summary text,
  cebaya_title text,
  cebaya_summary text,
  reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  module_row public.modules;
  canonical_after text;
  canonical_before text;
  english_updated integer := 0;
  cebaya_updated integer := 0;
  english_missing integer := 0;
  cebaya_missing integer := 0;
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
    raise exception 'This module is archived. Restore it before editing.';
  end if;

  canonical_after := nullif(trim(coalesce(new_canonical_title, '')), '');
  if canonical_after is not null and char_length(canonical_after) > 200 then
    raise exception 'Module title must be 200 characters or fewer';
  end if;

  if english_title is not null and char_length(english_title) > 200 then
    raise exception 'The English title must be 200 characters or fewer';
  end if;
  if cebaya_title is not null and char_length(cebaya_title) > 200 then
    raise exception 'The Bisaya title must be 200 characters or fewer';
  end if;
  if english_summary is not null and char_length(english_summary) > 2000 then
    raise exception 'The English summary must be 2000 characters or fewer';
  end if;
  if cebaya_summary is not null and char_length(cebaya_summary) > 2000 then
    raise exception 'The Bisaya summary must be 2000 characters or fewer';
  end if;

  canonical_before := module_row.canonical_title;
  update public.modules
  set canonical_title = coalesce(canonical_after, canonical_before), updated_at = now()
  where id = target_module;

  -- Only the newest live version for a language is edited, because that is the
  -- one a student is shown.
  if english_title is not null or english_summary is not null then
    update public.module_translations
    set title = coalesce(nullif(trim(coalesce(english_title, '')), ''), title),
        summary = coalesce(nullif(coalesce(english_summary, ''), ''), summary)
    where id = (
      select id from public.module_translations
      where module_id = target_module and language = 'en'
        and purge_pending_at is null and archived_at is null
      order by version desc limit 1
    );
    get diagnostics english_updated = row_count;
    if english_updated = 0 then english_missing := 1; end if;
  end if;

  if cebaya_title is not null or cebaya_summary is not null then
    update public.module_translations
    set title = coalesce(nullif(trim(coalesce(cebaya_title, '')), ''), title),
        summary = coalesce(nullif(coalesce(cebaya_summary, ''), ''), summary)
    where id = (
      select id from public.module_translations
      where module_id = target_module and language = 'ceb'
        and purge_pending_at is null and archived_at is null
      order by version desc limit 1
    );
    get diagnostics cebaya_updated = row_count;
    if cebaya_updated = 0 then cebaya_missing := 1; end if;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.details_edited', 'module', target_module::text, trim(reason),
    jsonb_build_object(
      'canonical_title_before', canonical_before,
      'canonical_title_after', coalesce(canonical_after, canonical_before),
      'english_updated', english_updated > 0,
      'english_no_version_uploaded', english_missing = 1,
      'cebaya_updated', cebaya_updated > 0,
      'cebaya_no_version_uploaded', cebaya_missing = 1,
      'files_replaced', false,
      'requirements_changed', false));

  return jsonb_build_object(
    'moduleId', target_module,
    'title', coalesce(canonical_after, canonical_before),
    'englishUpdated', english_updated > 0,
    'englishNeedsUpload', english_missing = 1,
    'cebayaUpdated', cebaya_updated > 0,
    'cebayaNeedsUpload', cebaya_missing = 1,
    'requirementsChanged', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.admin_request_material_version_purge(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_finalize_material_version_purge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_edit_module(uuid, text, integer, boolean, text, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_module_delete_impact(uuid) from public, anon, authenticated;
revoke all on function public.admin_material_version_impact(uuid) from public, anon, authenticated;
revoke all on function public.admin_edit_module_details(uuid, text, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.admin_request_material_version_purge(uuid, uuid, text) to service_role;
grant execute on function public.admin_finalize_material_version_purge(uuid, uuid) to service_role;

-- The impact report is read by the Edge Function with the service role before it
-- will touch Storage, so the service role needs it too.
grant execute on function public.admin_material_version_impact(uuid) to service_role;

grant execute on function public.admin_edit_module(uuid, text, integer, boolean, text, text, boolean) to authenticated;
grant execute on function public.admin_module_delete_impact(uuid) to authenticated;
grant execute on function public.admin_material_version_impact(uuid) to authenticated;
grant execute on function public.admin_edit_module_details(uuid, text, text, text, text, text, text) to authenticated;

commit;
