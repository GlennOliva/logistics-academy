#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 72
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(2)
}

function requireInteractiveTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    refuse('run this command in a trusted interactive terminal')
  }
}

process.on('unhandledRejection', (reason) => {
  console.error(`REFUSING: ${reason instanceof Error ? reason.message : 'the password reset was cancelled'}`)
  process.exit(1)
})

async function readVisible(prompt) {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await input.question(prompt)).trim()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      refuse('the password reset was cancelled')
    }
    throw error
  } finally {
    input.close()
  }
}

async function readSecret(prompt) {
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
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003' || character === '\u0004') {
          return finish(new Error('Password reset cancelled'))
        }
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (character >= ' ' && character !== '\u001b') value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

function passwordProblem(password) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `the new password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `the new password must be ${PASSWORD_MAX_LENGTH} characters or fewer`
  }
  if (!/[A-Za-z]/.test(password)) return 'the new password must include at least one letter'
  if (!/\d/.test(password)) return 'the new password must include at least one number'
  return ''
}

async function findUserByExactEmail(supabase, email) {
  const matches = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    matches.push(...data.users.filter((user) => user.email?.toLowerCase() === email))
    if (data.users.length < 1000) break
  }
  if (matches.length === 0) throw new Error('no Auth user matches that exact email')
  if (matches.length > 1) throw new Error('multiple Auth users match that exact email')
  return matches[0]
}

requireInteractiveTerminal()

if (process.env.ALLOW_ADMIN_PASSWORD_RESET !== '1') {
  refuse('set ALLOW_ADMIN_PASSWORD_RESET=1 after confirming this is the intended project')
}

let linkedRef = ''
try {
  linkedRef = readFileSync(join(repoRoot, 'supabase/.temp/project-ref'), 'utf8').trim().toLowerCase()
} catch {
  refuse('no linked Supabase project found; link the intended project first')
}
if (!linkedRef) refuse('the linked Supabase project ref is empty')

const urlInput = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ??
  await readVisible('Supabase URL (https://<project-ref>.supabase.co): ')
if (!urlInput) refuse('a Supabase URL is required')

let parsedUrl
try {
  parsedUrl = new URL(urlInput)
} catch {
  refuse('the Supabase URL is not valid')
}
if (parsedUrl.protocol !== 'https:') refuse('the Supabase URL must use https')
const expectedHost = `${linkedRef}.supabase.co`
if (parsedUrl.hostname !== expectedHost) {
  refuse(`Supabase URL host ${parsedUrl.hostname} does not match the linked project host ${expectedHost}`)
}
console.log(`Supabase URL matches the linked project ${linkedRef}.`)

const emailInput = process.env.ADMIN_RESET_EMAIL ?? await readVisible('Existing admin email: ')
const email = emailInput.trim().toLowerCase()
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse('a valid email address is required')

const serviceRoleKey = await readSecret('Service-role key (input hidden): ')
if (!serviceRoleKey) refuse('a service-role key is required')

const supabase = createClient(parsedUrl.origin, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

let passwordUpdated = false

try {
  const user = await findUserByExactEmail(supabase, email)
  console.log(`Found existing Auth user ${user.id}.`)

  const role = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle()
  if (role.error) throw role.error
  if (!role.data) throw new Error('the Auth user does not already have the database admin role')

  const adminCheck = await supabase.rpc('is_admin', { target_user: user.id })
  if (adminCheck.error) throw adminCheck.error
  if (adminCheck.data !== true) {
    throw new Error('the database does not recognize this account as an active administrator')
  }
  console.log('Existing database admin role verified.')

  const newPassword = await readSecret('New password (input hidden): ')
  const policyProblem = passwordProblem(newPassword)
  if (policyProblem) throw new Error(policyProblem)
  const confirmation = await readSecret('Repeat new password (input hidden): ')
  if (confirmation !== newPassword) throw new Error('the passwords do not match')

  const updated = await supabase.auth.admin.updateUserById(user.id, { password: newPassword })
  if (updated.error) throw updated.error
  if (!updated.data.user) throw new Error('Auth did not return the updated user')
  passwordUpdated = true

  const verifier = createClient(parsedUrl.origin, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  try {
    const login = await verifier.auth.signInWithPassword({ email, password: newPassword })
    if (login.error || !login.data.session) {
      throw new Error('login with the new password failed')
    }
    const backendRole = await verifier.rpc('is_admin')
    if (backendRole.error) throw backendRole.error
    if (backendRole.data !== true) {
      throw new Error('the is_admin RPC did not confirm administrator access after login')
    }
  } finally {
    await verifier.auth.signOut().catch(() => {})
  }

  console.log(`Password reset and verified for ${user.email} (${user.id}).`)
  console.log('No user was created and no role, email confirmation, enrollment, payment, progress, or certificate data was changed.')
} catch (error) {
  const message = error instanceof Error ? error.message : 'the password reset failed'
  if (passwordUpdated) {
    console.error(`The password was updated, but post-change verification failed: ${message}`)
    console.error('Do not retry blindly. Inspect the Auth user and project configuration first.')
  } else {
    console.error(`REFUSING: ${message}`)
  }
  process.exit(1)
}
