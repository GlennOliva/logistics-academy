#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(2)
}

if (process.env.HOSTED_QUIZ_TEST_ALLOW_MUTATION !== '1') {
  refuse('set HOSTED_QUIZ_TEST_ALLOW_MUTATION=1 for the isolated test project')
}
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (process.env.EXPECTED_SUPABASE_PROJECT_REF !== linkedRef) {
  refuse('EXPECTED_SUPABASE_PROJECT_REF must exactly match the linked project')
}

const learnerId = randomUUID()
const enrollmentId = randomUUID()
const learnerEmail = `hosted-quiz-${randomUUID()}@example.test`
const sql = `
begin;

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '${learnerId}'::uuid, 'authenticated', 'authenticated', '${learnerEmail}', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Hosted Quiz Test","preferred_language":"en","age_18_attested":true,"terms_version":"development-draft-2026-10-03","privacy_version":"development-draft-2026-10-03"}'::jsonb,
  now(), now()
);

insert into public.enrollments (id, user_id, course_id, status)
select '${enrollmentId}'::uuid, '${learnerId}'::uuid, id, 'active'
from public.courses where slug = 'logistics-101';

insert into public.enrollment_modules (enrollment_id, module_id, required, curriculum_version)
select '${enrollmentId}'::uuid, m.id, m.required, m.curriculum_version
from public.modules m join public.courses c on c.id = m.course_id
where c.slug = 'logistics-101';

update public.quiz_versions qv
set enabled = true
from public.quizzes q join public.courses c on c.id = q.course_id
where qv.quiz_id = q.id and c.slug = 'logistics-101' and q.kind = 'final'
  and qv.source_sha256 = 'acc3397a0a38883df2cdee7792d811c2388ce074c81fba7499bcbf6f0ef6333b';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"${learnerId}","role":"authenticated"}', true);
do $$
declare
  was_blocked boolean := false;
  final_quiz uuid;
begin
  select q.id into final_quiz
  from public.quizzes q join public.courses c on c.id = q.course_id
  where c.slug = 'logistics-101' and q.kind = 'final';
  begin
    perform public.start_quiz_attempt(final_quiz, 'en');
  exception when others then
    if position('Complete all required modules' in sqlerrm) = 0 then raise; end if;
    was_blocked := true;
  end;
  if not was_blocked then raise exception 'Incomplete learner unexpectedly started the final'; end if;
end;
$$;
reset role;

insert into public.module_progress (
  enrollment_id, module_id, studied_at, knowledge_check_completed_at, completed_at
)
select '${enrollmentId}'::uuid, em.module_id, now(), now(), now()
from public.enrollment_modules em
where em.enrollment_id = '${enrollmentId}'::uuid;

select set_config(
  'academy_test.pass_answers',
  (
    select jsonb_agg(jsonb_build_object(
      'questionId', q.id,
      'optionId', case when q.position <= 12 then ak.option_id else wrong.id end
    ) order by q.position)::text
    from public.quiz_questions q
    join public.quiz_versions qv on qv.id = q.quiz_version_id
    join private.quiz_answer_keys ak on ak.question_id = q.id
    join lateral (
      select o.id from public.question_options o
      where o.question_id = q.id and o.id <> ak.option_id order by o.position limit 1
    ) wrong on true
    where qv.source_sha256 = 'acc3397a0a38883df2cdee7792d811c2388ce074c81fba7499bcbf6f0ef6333b'
  ),
  true
);
select set_config(
  'academy_test.fail_answers',
  (
    select jsonb_agg(jsonb_build_object(
      'questionId', q.id,
      'optionId', case when q.position <= 11 then ak.option_id else wrong.id end
    ) order by q.position)::text
    from public.quiz_questions q
    join public.quiz_versions qv on qv.id = q.quiz_version_id
    join private.quiz_answer_keys ak on ak.question_id = q.id
    join lateral (
      select o.id from public.question_options o
      where o.question_id = q.id and o.id <> ak.option_id order by o.position limit 1
    ) wrong on true
    where qv.source_sha256 = 'acc3397a0a38883df2cdee7792d811c2388ce074c81fba7499bcbf6f0ef6333b'
  ),
  true
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"${learnerId}","role":"authenticated"}', true);
do $$
declare
  final_quiz uuid;
  passing_attempt uuid;
  failing_attempt uuid;
  passing_result jsonb;
  failing_result jsonb;
begin
  select q.id into final_quiz
  from public.quizzes q join public.courses c on c.id = q.course_id
  where c.slug = 'logistics-101' and q.kind = 'final';

  passing_attempt := public.start_quiz_attempt(final_quiz, 'en');
  passing_result := public.submit_quiz_attempt(
    passing_attempt,
    current_setting('academy_test.pass_answers')::jsonb
  );
  if (passing_result ->> 'score')::numeric <> 80
     or (passing_result ->> 'correct')::integer <> 12
     or (passing_result ->> 'total')::integer <> 15
     or not (passing_result ->> 'passed')::boolean then
    raise exception 'Server scoring did not pass the 12-of-15 attempt';
  end if;

  failing_attempt := public.start_quiz_attempt(final_quiz, 'en');
  failing_result := public.submit_quiz_attempt(
    failing_attempt,
    current_setting('academy_test.fail_answers')::jsonb
  );
  if (failing_result ->> 'score')::numeric <> 73.33
     or (failing_result ->> 'correct')::integer <> 11
     or (failing_result ->> 'total')::integer <> 15
     or (failing_result ->> 'passed')::boolean then
    raise exception 'Server scoring did not fail the 11-of-15 attempt';
  end if;
end;
$$;
reset role;

rollback;

select
  true as rollback_only_hosted_quiz_checks_passed,
  not exists (select 1 from auth.users where id = '${learnerId}'::uuid) as learner_fixture_removed,
  (select enabled = false from public.quiz_versions where source_sha256 = 'acc3397a0a38883df2cdee7792d811c2388ce074c81fba7499bcbf6f0ef6333b') as final_still_disabled;
`

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'logistics-hosted-quiz-test-'))
const sqlPath = join(temporaryDirectory, 'verify.sql')
try {
  writeFileSync(sqlPath, sql, { encoding: 'utf8', mode: 0o600 })
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '--file', sqlPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    console.error(result.stderr.trim() || 'Hosted quiz verification failed')
    process.exitCode = 1
  } else {
    process.stdout.write(result.stdout)
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
