alter table public.modules
  add column canonical_title text;

alter table public.modules
  add constraint modules_canonical_title_length
  check (canonical_title is null or char_length(trim(canonical_title)) between 1 and 200);

comment on column public.modules.canonical_title is
  'Owner-approved module title independent of uploaded material translations.';

alter table public.quiz_versions
  add column source_sha256 text;

alter table public.quiz_versions
  add constraint quiz_versions_source_sha256_format
  check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$');

create unique index quiz_versions_source_unique
  on public.quiz_versions (quiz_id, language, source_sha256)
  where source_sha256 is not null;

comment on column public.quiz_versions.source_sha256 is
  'SHA-256 of the protected authoritative source used for idempotent trusted imports.';

insert into public.modules (course_id, position, required, status, canonical_title)
select c.id, approved.position, true, 'draft'::public.module_status, approved.title
from public.courses c
cross join (values
  (1, 'Logistics Fundamentals'),
  (2, 'Trucks & Equipment'),
  (3, 'Carrier Sourcing'),
  (4, 'Booking and Rate Negotiation'),
  (5, 'Documents'),
  (6, 'Dispatch and Track and Trace'),
  (7, 'Accessorials'),
  (8, 'Delivery and Load Closing')
) as approved(position, title)
where c.slug = 'logistics-101'
on conflict (course_id, position) do update
set canonical_title = excluded.canonical_title,
    updated_at = now();

create or replace function public.import_final_quiz_bank(
  target_course_slug text,
  source_bank jsonb,
  source_hash text,
  owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  course_key uuid;
  quiz_key uuid;
  version_key uuid;
  question_key uuid;
  option_key uuid;
  version_number integer;
  question_record jsonb;
  option_letter text;
  expected_title text;
begin
  if target_course_slug <> 'logistics-101' then
    raise exception 'Only the approved Logistics 101 import is supported';
  end if;
  if source_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid source hash'; end if;
  if source_bank ->> 'language' <> 'en'
     or (source_bank ->> 'total_questions')::integer <> 15
     or jsonb_array_length(source_bank -> 'questions') <> 15 then
    raise exception 'The approved English bank must contain exactly 15 questions';
  end if;
  if not exists (
    select 1
    from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = owner_id and ur.role = 'admin' and p.account_status = 'active'
  ) then
    raise exception 'An active database administrator must own the import';
  end if;

  select id into course_key from public.courses where slug = target_course_slug;
  if course_key is null then raise exception 'Course not found'; end if;

  if (
    select count(distinct (entry ->> 'id')::integer)
    from jsonb_array_elements(source_bank -> 'questions') entry
  ) <> 15 then
    raise exception 'Question IDs must be unique';
  end if;
  if (
    select count(distinct (entry ->> 'module_number')::integer)
    from jsonb_array_elements(source_bank -> 'questions') entry
  ) <> 8 then
    raise exception 'All eight approved modules must be represented';
  end if;

  for question_record in
    select entry
    from jsonb_array_elements(source_bank -> 'questions') entry
    order by (entry ->> 'id')::integer
  loop
    expected_title := case (question_record ->> 'module_number')::integer
      when 1 then 'Logistics Fundamentals'
      when 2 then 'Trucks & Equipment'
      when 3 then 'Carrier Sourcing'
      when 4 then 'Booking and Rate Negotiation'
      when 5 then 'Documents'
      when 6 then 'Dispatch and Track and Trace'
      when 7 then 'Accessorials'
      when 8 then 'Delivery and Load Closing'
      else null
    end;
    if expected_title is null or question_record ->> 'module' <> expected_title then
      raise exception 'Question % has an unapproved module mapping', question_record ->> 'id';
    end if;
    if (question_record ->> 'id')::integer not between 1 and 15
       or nullif(trim(question_record ->> 'question'), '') is null
       or nullif(trim(question_record ->> 'explanation'), '') is null
       or question_record ->> 'correct' not in ('a', 'b', 'c', 'd') then
      raise exception 'Question % is incomplete', question_record ->> 'id';
    end if;
    foreach option_letter in array array['a', 'b', 'c', 'd'] loop
      if nullif(trim(question_record -> 'options' ->> option_letter), '') is null then
        raise exception 'Question % has a blank option', question_record ->> 'id';
      end if;
    end loop;
  end loop;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('final-quiz-import:' || course_key::text || ':en', 0)
  );

  insert into public.quizzes (course_id, module_id, kind)
  values (course_key, null, 'final')
  on conflict (course_id) where kind = 'final' do update set course_id = excluded.course_id
  returning id into quiz_key;

  select id into version_key
  from public.quiz_versions
  where quiz_id = quiz_key and language = 'en' and source_sha256 = source_hash;

  if version_key is not null then
    return jsonb_build_object(
      'quizVersionId', version_key,
      'questionCount', 15,
      'created', false,
      'enabled', false
    );
  end if;

  select coalesce(max(version), 0) + 1 into version_number
  from public.quiz_versions
  where quiz_id = quiz_key and language = 'en';

  insert into public.quiz_versions (
    quiz_id, language, version, status, pass_threshold, max_attempts,
    cooldown_hours, enabled, created_by, published_at, source_sha256
  ) values (
    quiz_key, 'en', version_number, 'published', 75, null,
    null, false, owner_id, now(), source_hash
  ) returning id into version_key;

  for question_record in
    select entry
    from jsonb_array_elements(source_bank -> 'questions') entry
    order by (entry ->> 'id')::integer
  loop
    insert into public.quiz_questions (quiz_version_id, position, prompt, explanation, required)
    values (
      version_key,
      (question_record ->> 'id')::integer,
      trim(question_record ->> 'question'),
      trim(question_record ->> 'explanation'),
      true
    ) returning id into question_key;

    foreach option_letter in array array['a', 'b', 'c', 'd'] loop
      insert into public.question_options (question_id, position, label)
      values (
        question_key,
        array_position(array['a', 'b', 'c', 'd'], option_letter),
        trim(question_record -> 'options' ->> option_letter)
      ) returning id into option_key;

      if option_letter = question_record ->> 'correct' then
        insert into private.quiz_answer_keys (question_id, option_id)
        values (question_key, option_key);
      end if;
    end loop;
  end loop;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (
    owner_id,
    'quiz.final_import',
    'quiz_version',
    version_key::text,
    'Owner-approved authoritative English final bank',
    jsonb_build_object(
      'source_sha256', source_hash,
      'question_count', 15,
      'pass_threshold', 75,
      'enabled', false,
      'knowledge_checks_unchanged', true
    )
  );

  return jsonb_build_object(
    'quizVersionId', version_key,
    'questionCount', 15,
    'created', true,
    'enabled', false
  );
end;
$$;

revoke all on function public.import_final_quiz_bank(text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.import_final_quiz_bank(text, jsonb, text, uuid) to service_role;
