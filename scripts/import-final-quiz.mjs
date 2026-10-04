#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { createClient } from '@supabase/supabase-js'

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
      if (character === '\u0003') return finish(new Error('Import cancelled'))
      if (character === '\r' || character === '\n') return finish()
      if (character === '\u007f') value = value.slice(0, -1)
      else if (character >= ' ') value += character
    }
    process.stdin.on('data', onData)
  })
}

if (process.env.ALLOW_QUIZ_IMPORT !== '1') refuse('set ALLOW_QUIZ_IMPORT=1 after confirming the linked test project')

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const adminEmail = process.env.QUIZ_IMPORT_ADMIN_EMAIL?.trim().toLowerCase()
if (!url || !adminEmail) refuse('SUPABASE_URL (or VITE_SUPABASE_URL) and QUIZ_IMPORT_ADMIN_EMAIL are required')

const configuredRef = new URL(url).hostname.split('.')[0]
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (configuredRef !== linkedRef) refuse('linked project does not match the configured Supabase URL')

const sourceContents = readFileSync(new URL('../quiz/quiz_all_modules_en.json', import.meta.url), 'utf8')
const source = JSON.parse(sourceContents)
const manifest = JSON.parse(readFileSync(new URL('../quiz/import-manifest.json', import.meta.url), 'utf8'))
const sourceHash = createHash('sha256').update(sourceContents).digest('hex')
if (sourceHash !== manifest.source_sha256) refuse('protected quiz source changed after owner approval')

const approvedTitles = new Map(manifest.modules.map((module) => [module.position, module.title]))
const normalizedBank = {
  ...source,
  questions: source.questions.map((question) => ({
    ...question,
    module: approvedTitles.get(question.module_number),
  })),
}

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? await readSecret('Service-role key (input hidden): ')
if (!serviceRoleKey) refuse('a service-role key is required')
const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

let ownerId = null
for (let page = 1; ; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
  if (error) throw error
  const matches = data.users.filter((user) => user.email?.toLowerCase() === adminEmail)
  if (matches.length > 1 || ownerId) refuse('admin email is not unique')
  if (matches.length === 1) ownerId = matches[0].id
  if (data.users.length < 1000) break
}
if (!ownerId) refuse('the requested admin Auth identity does not exist')

const { data, error } = await supabase.rpc('import_final_quiz_bank', {
  target_course_slug: manifest.course_slug,
  source_bank: normalizedBank,
  source_hash: sourceHash,
  owner_id: ownerId,
})
if (error) throw error
console.log(JSON.stringify(data))
