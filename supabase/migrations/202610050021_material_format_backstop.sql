-- Course material accepts PDF, PPT and PPTX, and the database stops describing
-- that path as PDF-only.
--
-- admin_save_module_translation raised 'Material must be a PDF of 50 MB or less'
-- for any size failure and performed no format check at all, while the edge
-- function and the admin UI all accept the three genuine formats. A trainer
-- uploading a PowerPoint deck therefore hit two different PDF-only messages
-- depending on which layer rejected the file.
--
-- This migration corrects the message and adds the missing format backstop on
-- the stored object path. It does not change the 50 MB ceiling, does not make
-- the bucket public, and does not touch any existing row.

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
    raise exception 'Course material must be a PDF or PowerPoint file of 50 MB or less';
  end if;
  -- The stored object path is content addressed and ends in the real extension
  -- the edge function detected from the file signature, so the database can
  -- refuse a format it does not serve. This is a backstop only: the signature
  -- itself is verified in the edge function before anything is stored.
  if lower(asset_object_path) !~ '\.(pdf|ppt|pptx)$' then
    raise exception 'Course material must be a PDF, PPT, or PPTX file';
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
revoke all on function public.admin_save_module_translation(uuid, uuid, text, text, text, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.admin_save_module_translation(uuid, uuid, text, text, text, text, text, integer, boolean) to service_role;

-- Existing rows must satisfy the new backstop, so refuse to apply while any
-- stored material uses an unsupported extension. Nothing is rewritten here.
do $$
declare
  unsupported text;
begin
  select string_agg(object_path, ', ') into unsupported
  from public.module_translations
  where object_path is not null
    and lower(object_path) !~ '\.(pdf|ppt|pptx)$';

  if unsupported is not null then
    raise exception 'Stored course material uses an unsupported file extension: %', unsupported;
  end if;
end;
$$;

-- A future write outside the trusted function cannot register a material whose
-- path does not name one of the three served formats.
alter table public.module_translations
  drop constraint if exists module_translations_format_check;

alter table public.module_translations
  add constraint module_translations_format_check
  check (object_path is null or lower(object_path) ~ '\.(pdf|ppt|pptx)$');
