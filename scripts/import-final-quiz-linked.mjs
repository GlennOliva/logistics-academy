#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(2)
}

if (process.env.ALLOW_QUIZ_IMPORT !== '1') refuse('set ALLOW_QUIZ_IMPORT=1 after confirming the linked test project')

const adminEmail = process.env.QUIZ_IMPORT_ADMIN_EMAIL?.trim().toLowerCase()
if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) refuse('a valid QUIZ_IMPORT_ADMIN_EMAIL is required')

const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (process.env.EXPECTED_SUPABASE_PROJECT_REF !== linkedRef) {
  refuse('EXPECTED_SUPABASE_PROJECT_REF must exactly match the linked project')
}

const sourceContents = readFileSync(new URL('../quiz/quiz_all_modules_en.json', import.meta.url), 'utf8')
const source = JSON.parse(sourceContents)
const manifest = JSON.parse(readFileSync(new URL('../quiz/import-manifest.json', import.meta.url), 'utf8'))
const sourceHash = createHash('sha256').update(sourceContents).digest('hex')
if (sourceHash !== manifest.source_sha256) refuse('protected quiz source changed after owner approval')

const titles = new Map(manifest.modules.map((module) => [module.position, module.title]))
const normalized = {
  ...source,
  questions: source.questions.map((question) => ({ ...question, module: titles.get(question.module_number) })),
}
const escapedBank = JSON.stringify(normalized).replaceAll("'", "''")
const escapedEmail = adminEmail.replaceAll("'", "''")
const sql = `
select public.import_final_quiz_bank(
  '${manifest.course_slug}',
  '${escapedBank}'::jsonb,
  '${sourceHash}',
  (select id from auth.users where lower(email) = '${escapedEmail}')
);
`

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'logistics-quiz-import-'))
const sqlPath = join(temporaryDirectory, 'import.sql')
try {
  writeFileSync(sqlPath, sql, { encoding: 'utf8', mode: 0o600 })
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '--file', sqlPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    console.error(result.stderr.trim() || 'Trusted linked quiz import failed')
    process.exitCode = 1
  } else {
    process.stdout.write(result.stdout)
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
