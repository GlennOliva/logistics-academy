#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'

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
      if (character === '\u0003') return finish(new Error('Provisioning cancelled'))
      if (character === '\r' || character === '\n') return finish()
      if (character === '\u007f') {
        value = value.slice(0, -1)
        return
      }
      if (character >= ' ') value += character
    }
    process.stdin.on('data', onData)
  })
}

if (process.env.ALLOW_ADMIN_PROVISIONING !== '1') {
  refuse('set ALLOW_ADMIN_PROVISIONING=1 after confirming the target is a non-production or approved environment')
}

const inputPath = process.env.ADMIN_PROVISIONING_INPUT_FILE ?? '.admin-provisioning.local'
let localInput = {}
if (existsSync(inputPath)) {
  const inputStat = lstatSync(inputPath)
  if (!inputStat.isFile() || inputStat.isSymbolicLink()) refuse('provisioning input must be a regular file, not a link')
  if ((inputStat.mode & 0o077) !== 0) refuse('provisioning input must not be readable or writable by group/other users')
  try {
    localInput = JSON.parse(readFileSync(inputPath, 'utf8'))
  } finally {
    unlinkSync(inputPath)
  }
}

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
let serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localInput.serviceRoleKey
const email = (process.env.INITIAL_ADMIN_EMAIL ?? localInput.email)?.trim().toLowerCase()
const reason = (process.env.ADMIN_PROVISIONING_REASON ?? localInput.reason)?.trim()
const preparedPassword = localInput.initialPassword

if (!url || !email || !reason) {
  refuse('SUPABASE_URL (or VITE_SUPABASE_URL), INITIAL_ADMIN_EMAIL, and ADMIN_PROVISIONING_REASON are required')
}

if (!serviceRoleKey) serviceRoleKey = await readSecret('Service-role key (input hidden): ')
if (!serviceRoleKey) refuse('a service-role key is required for this one-shot trusted operation')

const configuredRef = new URL(url).hostname.split('.')[0]
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (configuredRef !== linkedRef) refuse('linked project does not match SUPABASE_URL')

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

async function findUsersByEmail() {
  const matches = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    matches.push(...data.users.filter((user) => user.email?.toLowerCase() === email))
    if (data.users.length < 1000) return matches
  }
}

let createdUserId = null
let verificationPassword = preparedPassword

try {
  const matches = await findUsersByEmail()
  if (matches.length > 1) refuse('multiple Auth identities match the requested email')

  let user = matches[0]
  if (user) {
    console.log('Existing Auth identity found; its password will not be changed.')
    verificationPassword ??= await readSecret('Existing password for login verification (input hidden): ')
  } else {
    const password = preparedPassword ?? await readSecret('Initial password (input hidden): ')
    verificationPassword = password
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      refuse('initial password must contain at least eight characters, one letter, and one digit')
    }

    if (!preparedPassword) {
      const confirmation = await readSecret('Repeat initial password (input hidden): ')
      if (confirmation !== password) refuse('passwords do not match')
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Angela Valiente', preferred_language: 'en' },
      app_metadata: { initial_password_change_required: true },
    })
    if (error || !data.user) throw error ?? new Error('Auth did not return the created user')
    user = data.user
    createdUserId = user.id
  }

  if (!user.email_confirmed_at) throw new Error('The Auth identity must have a confirmed email before receiving admin access')

  const profile = await supabase.from('profiles').select('account_status').eq('id', user.id).single()
  if (profile.error || profile.data.account_status !== 'active') throw new Error('The Auth identity must have an active profile')

  const existingRole = await supabase.from('user_roles').select('user_id').eq('user_id', user.id).eq('role', 'admin').maybeSingle()
  if (existingRole.error) throw existingRole.error

  let insertedRole = false
  if (!existingRole.data) {
    const role = await supabase.from('user_roles').insert({ user_id: user.id, role: 'admin' })
    if (role.error) throw role.error
    insertedRole = true
  }

  const audit = await supabase.from('audit_logs').insert({
    actor_id: null,
    action: 'admin.bootstrap',
    target_type: 'user',
    target_id: user.id,
    reason,
    metadata: { project_ref: configuredRef },
  })
  if (audit.error) {
    if (insertedRole) await supabase.from('user_roles').delete().eq('user_id', user.id).eq('role', 'admin')
    throw audit.error
  }

  const loginClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const login = await loginClient.auth.signInWithPassword({ email, password: verificationPassword })
  if (login.error || !login.data.session) throw new Error('Admin password login verification failed')
  const backendRole = await loginClient.rpc('is_admin')
  if (backendRole.error || backendRole.data !== true) throw new Error('Backend administrator authorization verification failed')
  await loginClient.auth.signOut()

  console.log(`Admin role verified for Auth user ${user.id}.`)
  console.log('Password login and backend administrator authorization verified; /login routes this role to /admin.')
  console.log('The initial password must be changed through password recovery before any production use.')
} catch (error) {
  if (createdUserId) await supabase.auth.admin.deleteUser(createdUserId)
  console.error(error instanceof Error ? error.message : 'Provisioning failed')
  process.exit(1)
}
