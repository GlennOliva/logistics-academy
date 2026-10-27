-- Resumable quiz attempts. Draft answers remain server-side and every write is
-- revision guarded so a slow request cannot overwrite a newer snapshot.

alter table public.quiz_attempts
  add column draft_revision bigint not null default 0 check (draft_revision >= 0),
  add column current_question_position integer not null default 0 check (current_question_position >= 0),
  add column draft_updated_at timestamptz;

alter table public.attempt_answers alter column is_correct drop not null;

create or replace function public.quiz_payload(target_attempt uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  attempt_row public.quiz_attempts;
  version_row public.quiz_versions;
begin
  select * into attempt_row from public.quiz_attempts where id = target_attempt;
  if not found then raise exception 'Attempt not found'; end if;
  if attempt_row.user_id <> auth.uid() and not public.is_admin() then
    raise exception 'Attempt not available';
  end if;
  if not public.is_admin() and not public.is_account_active(auth.uid()) then
    raise exception 'Active account required';
  end if;
  if not public.is_admin() and not exists (
    select 1 from public.enrollments e
    where e.id = attempt_row.enrollment_id
      and e.user_id = auth.uid()
      and e.status = 'active'
  ) then
    raise exception 'Active enrollment required';
  end if;

  select * into version_row from public.quiz_versions where id = attempt_row.quiz_version_id;

  return jsonb_build_object(
    'attemptId', attempt_row.id,
    'kind', attempt_row.kind,
    'attemptNumber', attempt_row.attempt_number,
    'language', version_row.language,
    'state', attempt_row.state,
    'score', attempt_row.score,
    'passed', attempt_row.passed,
    'passThreshold', case when attempt_row.kind = 'final' then version_row.pass_threshold else null end,
    'currentPosition', attempt_row.current_question_position,
    'draftRevision', attempt_row.draft_revision,
    'savedAnswers', coalesce((
      select jsonb_object_agg(aa.question_id::text, aa.option_id::text)
      from public.attempt_answers aa where aa.attempt_id = attempt_row.id
    ), '{}'::jsonb),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'options', (select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.position)
                    from public.question_options o where o.question_id = q.id)
      ) order by q.position)
      from public.quiz_questions q
      where q.quiz_version_id = attempt_row.quiz_version_id and q.required
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.start_quiz_attempt(target_quiz uuid, attempt_language text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment_row public.enrollments;
  quiz_row public.quizzes;
  version_row public.quiz_versions;
  progress_row record;
  next_number integer;
  previous_scored timestamptz;
  attempt_row uuid;
  chosen_option_count integer;
begin
  if auth.uid() is null or not public.is_account_active(auth.uid()) then
    raise exception 'Active account required';
  end if;
  if attempt_language not in ('en', 'ceb') then
    raise exception 'Unsupported language';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || ':' || target_quiz::text, 0));

  select * into quiz_row from public.quizzes where id = target_quiz;
  if not found then raise exception 'Quiz not found'; end if;

  select * into enrollment_row from public.enrollments
  where user_id = auth.uid() and course_id = quiz_row.course_id and status = 'active' for update;
  if not found then raise exception 'Active enrollment required'; end if;

  -- Returning the pinned open attempt before looking up a newer version keeps
  -- its question set, language, order and attempt number unchanged.
  select qa.id into attempt_row
  from public.quiz_attempts qa
  where qa.enrollment_id = enrollment_row.id
    and qa.quiz_id = target_quiz
    and qa.state = 'in_progress';
  if found then return attempt_row; end if;

  select * into version_row from public.quiz_versions
  where quiz_id = target_quiz and language = attempt_language::public.app_language
    and status = 'published'
  order by version desc limit 1;
  if not found then raise exception 'No published quiz version is available for the selected language'; end if;
  if not version_row.enabled then raise exception 'This assessment is not enabled yet'; end if;

  select count(*) into chosen_option_count
  from public.quiz_questions q
  where q.quiz_version_id = version_row.id and q.required
    and (select count(*) from public.question_options o where o.question_id = q.id) < 2;
  if chosen_option_count > 0 then raise exception 'This quiz version is not publishable'; end if;

  if quiz_row.kind = 'knowledge_check' then
    if not exists (
      select 1 from public.enrollment_modules em
      where em.enrollment_id = enrollment_row.id and em.module_id = quiz_row.module_id
    ) then
      raise exception 'This knowledge check is not part of your curriculum';
    end if;
  else
    select * into progress_row from public.enrollment_progress(enrollment_row.id);
    if not progress_row.final_unlocked then
      raise exception 'Complete all required modules before starting the final quiz';
    end if;
  end if;

  select coalesce(max(attempt_number), 0) + 1 into next_number
  from public.quiz_attempts where enrollment_id = enrollment_row.id and quiz_id = target_quiz;

  if version_row.max_attempts is not null and next_number > version_row.max_attempts then
    raise exception 'Attempt limit reached for this assessment';
  end if;

  if version_row.cooldown_hours is not null and version_row.cooldown_hours > 0 then
    select max(scored_at) into previous_scored from public.quiz_attempts
    where enrollment_id = enrollment_row.id and quiz_id = target_quiz and scored_at is not null;
    if previous_scored is not null and previous_scored > now() - make_interval(hours => version_row.cooldown_hours) then
      raise exception 'A waiting period applies before the next attempt';
    end if;
  end if;

  insert into public.quiz_attempts (enrollment_id, user_id, quiz_id, quiz_version_id, kind, attempt_number)
  values (enrollment_row.id, auth.uid(), target_quiz, version_row.id, quiz_row.kind, next_number)
  returning id into attempt_row;

  return attempt_row;
end;
$$;

create or replace function public.save_quiz_progress(
  target_attempt uuid,
  answers jsonb,
  current_position integer,
  client_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.quiz_attempts;
  entry jsonb;
  question_key uuid;
  option_key uuid;
  seen_questions uuid[] := '{}'::uuid[];
  question_total integer;
begin
  select * into attempt_row from public.quiz_attempts where id = target_attempt for update;
  if not found then raise exception 'Attempt not found'; end if;
  if attempt_row.user_id <> auth.uid() then raise exception 'Attempt not available'; end if;
  if not public.is_account_active(auth.uid()) then raise exception 'Active account required'; end if;
  if not exists (
    select 1 from public.enrollments e
    where e.id = attempt_row.enrollment_id and e.user_id = auth.uid() and e.status = 'active'
  ) then raise exception 'Active enrollment required'; end if;
  if attempt_row.state <> 'in_progress' then
    return jsonb_build_object('saved', false, 'state', attempt_row.state, 'revision', attempt_row.draft_revision);
  end if;
  if client_revision <= attempt_row.draft_revision then
    return jsonb_build_object('saved', false, 'state', attempt_row.state, 'revision', attempt_row.draft_revision);
  end if;
  if jsonb_typeof(answers) <> 'array' then raise exception 'Answers must be a list'; end if;

  select count(*) into question_total from public.quiz_questions q
  where q.quiz_version_id = attempt_row.quiz_version_id and q.required;
  if current_position < 0 or (question_total > 0 and current_position >= question_total) then
    raise exception 'Question position is outside this assessment';
  end if;

  for entry in select value from jsonb_array_elements(answers) loop
    if jsonb_typeof(entry -> 'questionId') <> 'string' or jsonb_typeof(entry -> 'optionId') <> 'string' then
      raise exception 'Each answer needs a questionId and optionId';
    end if;
    question_key := (entry ->> 'questionId')::uuid;
    option_key := (entry ->> 'optionId')::uuid;
    if question_key = any(seen_questions) then raise exception 'Each question may only be answered once'; end if;
    if not exists (
      select 1 from public.quiz_questions q
      where q.id = question_key and q.quiz_version_id = attempt_row.quiz_version_id and q.required
    ) then raise exception 'An answer references a question outside this assessment'; end if;
    if not exists (
      select 1 from public.question_options o where o.id = option_key and o.question_id = question_key
    ) then raise exception 'An answer references an option that does not belong to the question'; end if;

    insert into public.attempt_answers (attempt_id, question_id, option_id, is_correct)
    values (attempt_row.id, question_key, option_key, null)
    on conflict (attempt_id, question_id) do update
      set option_id = excluded.option_id, is_correct = null;
    seen_questions := array_append(seen_questions, question_key);
  end loop;

  delete from public.attempt_answers aa
  where aa.attempt_id = attempt_row.id and not (aa.question_id = any(seen_questions));

  update public.quiz_attempts
  set draft_revision = client_revision,
      current_question_position = current_position,
      draft_updated_at = now()
  where id = attempt_row.id;

  return jsonb_build_object('saved', true, 'state', 'in_progress', 'revision', client_revision);
end;
$$;

-- Submission remains the only operation that computes correctness and scores.
create or replace function public.submit_quiz_attempt(target_attempt uuid, answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.quiz_attempts;
  version_row public.quiz_versions;
  required_questions integer;
  correct_total integer := 0;
  score_value numeric(5,2);
  passed_value boolean;
  entry jsonb;
  question_key uuid;
  option_key uuid;
  module_key uuid;
  is_answer_correct boolean;
  seen_questions uuid[] := '{}'::uuid[];
begin
  select * into attempt_row from public.quiz_attempts where id = target_attempt for update;
  if not found then raise exception 'Attempt not found'; end if;
  if attempt_row.user_id <> auth.uid() then raise exception 'Attempt not available'; end if;
  if not public.is_account_active(auth.uid()) then raise exception 'Active account required'; end if;
  if not exists (
    select 1 from public.enrollments e
    where e.id = attempt_row.enrollment_id and e.user_id = auth.uid() and e.status = 'active'
  ) then raise exception 'Active enrollment required'; end if;

  select * into version_row from public.quiz_versions where id = attempt_row.quiz_version_id;
  if attempt_row.state = 'scored' then
    return jsonb_build_object(
      'attemptId', attempt_row.id, 'score', attempt_row.score, 'passed', attempt_row.passed,
      'correct', attempt_row.correct_count, 'total', attempt_row.question_count, 'alreadyScored', true
    );
  end if;
  if jsonb_typeof(answers) <> 'array' then raise exception 'Answers must be a list'; end if;

  for entry in select value from jsonb_array_elements(answers) loop
    if jsonb_typeof(entry -> 'questionId') <> 'string' or jsonb_typeof(entry -> 'optionId') <> 'string' then
      raise exception 'Each answer needs a questionId and optionId';
    end if;
    question_key := (entry ->> 'questionId')::uuid;
    option_key := (entry ->> 'optionId')::uuid;
    if question_key = any(seen_questions) then raise exception 'Each question may only be answered once'; end if;
    if not exists (
      select 1 from public.quiz_questions q
      where q.id = question_key and q.quiz_version_id = attempt_row.quiz_version_id and q.required
    ) then raise exception 'An answer references a question outside this assessment'; end if;
    if not exists (
      select 1 from public.question_options o where o.id = option_key and o.question_id = question_key
    ) then raise exception 'An answer references an option that does not belong to the question'; end if;

    select (ak.option_id = option_key) into is_answer_correct
    from private.quiz_answer_keys ak where ak.question_id = question_key;
    if is_answer_correct is null then raise exception 'This assessment version is missing an answer key'; end if;

    insert into public.attempt_answers (attempt_id, question_id, option_id, is_correct)
    values (attempt_row.id, question_key, option_key, is_answer_correct)
    on conflict (attempt_id, question_id) do update
      set option_id = excluded.option_id, is_correct = excluded.is_correct;
    if is_answer_correct then correct_total := correct_total + 1; end if;
    seen_questions := array_append(seen_questions, question_key);
  end loop;

  select count(*) into required_questions from public.quiz_questions
  where quiz_version_id = attempt_row.quiz_version_id and required;
  if cardinality(seen_questions) <> required_questions then
    raise exception 'Every required question must be answered exactly once';
  end if;

  score_value := round(correct_total * 100.0 / required_questions, 2);
  if attempt_row.kind = 'final' then
    if version_row.pass_threshold is null then raise exception 'The final quiz pass threshold is not configured'; end if;
    passed_value := score_value >= version_row.pass_threshold;
  else
    passed_value := null;
  end if;

  update public.quiz_attempts
  set state = 'scored', score = score_value, passed = passed_value,
      correct_count = correct_total, question_count = required_questions, scored_at = now()
  where id = attempt_row.id;

  if attempt_row.kind = 'knowledge_check' then
    select module_id into module_key from public.quizzes where id = attempt_row.quiz_id;
    update public.module_progress mp
    set knowledge_check_completed_at = coalesce(mp.knowledge_check_completed_at, now()), updated_at = now()
    where mp.enrollment_id = attempt_row.enrollment_id and mp.module_id = module_key;
    update public.module_progress mp set completed_at = now()
    where mp.enrollment_id = attempt_row.enrollment_id and mp.module_id = module_key
      and mp.studied_at is not null and mp.knowledge_check_completed_at is not null and mp.completed_at is null;
  end if;

  return jsonb_build_object(
    'attemptId', attempt_row.id, 'score', score_value, 'passed', passed_value,
    'correct', correct_total, 'total', required_questions,
    'passThreshold', case when attempt_row.kind = 'final' then version_row.pass_threshold else null end
  );
end;
$$;

drop policy attempt_answers_read_owner_admin on public.attempt_answers;
create policy attempt_answers_read_owner_admin on public.attempt_answers for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.quiz_attempts qa
  join public.enrollments e on e.id = qa.enrollment_id
  where qa.id = attempt_id and qa.user_id = auth.uid()
    and e.status = 'active' and public.is_account_active(auth.uid())
));

revoke all on function public.save_quiz_progress(uuid, jsonb, integer, bigint) from public, anon, authenticated;
grant execute on function public.save_quiz_progress(uuid, jsonb, integer, bigint) to authenticated;
