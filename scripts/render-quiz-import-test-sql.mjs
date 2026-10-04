#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const sourceContents = readFileSync(new URL('../quiz/quiz_all_modules_en.json', import.meta.url), 'utf8')
const source = JSON.parse(sourceContents)
const manifest = JSON.parse(readFileSync(new URL('../quiz/import-manifest.json', import.meta.url), 'utf8'))
const titles = new Map(manifest.modules.map((module) => [module.position, module.title]))
const normalized = {
  ...source,
  questions: source.questions.map((question) => ({ ...question, module: titles.get(question.module_number) })),
}
const bank = JSON.stringify(normalized).replaceAll("'", "''")
const sourceHash = createHash('sha256').update(sourceContents).digest('hex')

process.stdout.write(`
update public.profiles
set account_status = 'active'
where id = '99999999-9999-4999-8999-999999999999';

select public.import_final_quiz_bank(
  'logistics-101', '${bank}'::jsonb, '${sourceHash}',
  '99999999-9999-4999-8999-999999999999'
) as first_import \\gset

select harness.check(
  (:'first_import'::jsonb ->> 'created')::boolean
  and (:'first_import'::jsonb ->> 'questionCount')::integer = 15
  and not (:'first_import'::jsonb ->> 'enabled')::boolean,
  'approved final bank imports disabled with all 15 questions');

select public.import_final_quiz_bank(
  'logistics-101', '${bank}'::jsonb, '${sourceHash}',
  '99999999-9999-4999-8999-999999999999'
) as second_import \\gset

select harness.check(
  not (:'second_import'::jsonb ->> 'created')::boolean
  and (select count(*) from public.quiz_versions where source_sha256 = '${sourceHash}') = 1,
  'approved final import is idempotent by protected source hash');

select harness.check(
  (select count(*) from public.quiz_questions q join public.quiz_versions qv on qv.id = q.quiz_version_id where qv.source_sha256 = '${sourceHash}') = 15
  and (select count(*) from private.quiz_answer_keys k join public.quiz_questions q on q.id = k.question_id join public.quiz_versions qv on qv.id = q.quiz_version_id where qv.source_sha256 = '${sourceHash}') = 15
  and (select pass_threshold = 75 and enabled = false from public.quiz_versions where source_sha256 = '${sourceHash}'),
  'final threshold and private answer keys match the approved import manifest');
`)
