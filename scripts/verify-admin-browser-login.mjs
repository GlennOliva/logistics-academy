#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(2)
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse('run this command in an interactive terminal')
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (character) => {
      if (character === '\u0003') return finish(new Error('Login verification cancelled'))
      if (character === '\r' || character === '\n') return finish()
      if (character === '\u007f') value = value.slice(0, -1)
      else if (character >= ' ') value += character
    }
    process.stdin.on('data', onData)
  })
}

const expectedRef = process.env.EXPECTED_SUPABASE_PROJECT_REF
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (!expectedRef || expectedRef !== linkedRef) refuse('expected project ref must exactly match the linked project')

const password = await readSecret('Development admin password (input hidden): ')
if (!password) refuse('a password is required')
const result = spawnSync(
  'npx',
  ['playwright', 'test', 'tests/e2e/registration.hosted.spec.ts', '--project=chromium', '--grep', 'database-authorized administrator', '--reporter=line'],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOSTED_ADMIN_LOGIN_TEST: '1', HOSTED_ADMIN_LOGIN_PASSWORD: password },
  },
)
process.stdout.write(result.stdout)
if (result.status !== 0) {
  console.error(result.stderr.trim() || 'Admin browser login verification failed')
  process.exitCode = 1
}
