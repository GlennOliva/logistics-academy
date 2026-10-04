#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(2)
}

if (process.env.ALLOW_TEST_AUTH_CONFIG_CHANGE !== '1') {
  refuse('set ALLOW_TEST_AUTH_CONFIG_CHANGE=1 for this isolated test-project operation')
}
const expectedRef = process.env.EXPECTED_SUPABASE_PROJECT_REF
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (!expectedRef || expectedRef !== linkedRef) refuse('expected project ref must exactly match the linked project')
if (process.env.TEST_EMAIL_CONFIRMATIONS !== 'disabled') {
  refuse('this guarded command only supports the owner-approved test setting: disabled')
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'logistics-auth-config-'))
const supabaseDirectory = join(temporaryRoot, 'supabase')
mkdirSync(supabaseDirectory, { mode: 0o700 })
writeFileSync(
  join(supabaseDirectory, 'config.toml'),
  'project_id = "logistics-academy"\n\n[auth.email]\nenable_confirmations = false\n',
  { encoding: 'utf8', mode: 0o600 },
)

try {
  const args = ['supabase', 'config', process.env.AUTH_CONFIG_DRY_RUN === '1' ? 'diff' : 'push', '--project-ref', expectedRef, '--workdir', temporaryRoot]
  if (process.env.AUTH_CONFIG_DRY_RUN !== '1') args.push('--yes')
  const result = spawnSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(result.stdout)
  if (result.status !== 0) {
    console.error(result.stderr.trim() || 'Auth configuration operation failed')
    process.exitCode = 1
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
