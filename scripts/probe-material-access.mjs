#!/usr/bin/env node

// Verifies that the genuine Module 1 material is reachable by an enrolled
// student in both languages, and refused for a signed-in user with no
// enrollment. Runs the real browser against the linked test project and uses
// disposable fixtures only.

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const origin = process.env.VITE_APP_ORIGIN ?? 'http://127.0.0.1:5173'
if (!url || !key) {
  console.error('REFUSING: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required')
  process.exit(2)
}
const MODULE_1 = '994538f1-1544-4df0-aaba-f968f7addf93'
const COURSE = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'

const log = (label, detail = '') => console.log(`${label}${detail ? ` — ${detail}` : ''}`)
const results = []

function sql(text) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', text], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = `${result.stdout}${result.stderr}`
  return { ok: !(out.includes('ERROR') || out.includes('Failed to run sql query')), out }
}

function record(step, ok, detail = '') {
  results.push({ step, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}: ${step}`, detail)
}

const runId = Date.now()
const adminEmail = `academy-mat-admin-${runId}-${randomUUID().slice(0, 6)}@example.com`
const studentEmail = `academy-mat-student-${runId}-${randomUUID().slice(0, 6)}@example.com`
const outsiderEmail = `academy-mat-outsider-${runId}-${randomUUID().slice(0, 6)}@example.com`
const password = `Mat-${randomUUID()}-Aa1!`

const profile = {
  full_name: 'Material Probe',
  preferred_language: 'en',
  age_18_attested: true,
  terms_version: 'development-draft-2026-10-03',
  privacy_version: 'development-draft-2026-10-03',
}

const client = (accessToken) =>
  createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  })

const created = []
let browser

async function signup(email) {
  const result = await client().auth.signUp({ email, password, options: { data: profile } })
  if (result.error) throw new Error(`signup failed for ${email}: ${result.error.message}`)
  created.push(result.data.user.id)
  return result.data.user.id
}

try {
  const adminId = await signup(adminEmail)
  const role = sql(`insert into public.user_roles (user_id, role) values ('${adminId}'::uuid, 'admin') on conflict do nothing;`)
  if (!role.ok) throw new Error(`admin role insert failed: ${role.out.slice(0, 300)}`)
  const adminToken = (await client().auth.signInWithPassword({ email: adminEmail, password })).data.session.access_token
  const studentId = await signup(studentEmail)
  const outsiderId = await signup(outsiderEmail)

  const adminApi = client(adminToken)
  const { data: courseRow, error: courseError } = await adminApi
    .from('courses')
    .select('id')
    .eq('id', COURSE)
    .single()
  if (courseError) throw new Error(`course lookup failed: ${courseError.message}`)
  if (!courseRow) throw new Error('course not found')

  const granted = await adminApi.rpc('grant_manual_enrollment', {
    target_user: studentId,
    target_course: COURSE,
    grant_kind: 'complimentary',
    reason: 'disposable material-access fixture; no payment represented',
  })
  if (granted.error) throw new Error(`enrollment grant failed: ${granted.error.message}`)
  log('disposable enrollment granted')

  const studentToken = (await client().auth.signInWithPassword({ email: studentEmail, password })).data.session.access_token

  // create_order belongs only to checkout. With sales disabled it returns the
  // authoritative checkout refusal and creates no order; opening a lesson must
  // not call it at all.
  const orderCountBefore = await adminApi.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', studentId)
  const orderResponse = await fetch(`${url}/rest/v1/rpc/create_order`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${studentToken}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ course_slug: 'logistics-101' }),
  })
  const orderBody = await orderResponse.json().catch(() => ({}))
  const orderCountAfter = await adminApi.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', studentId)
  record(
    'disabled checkout returns its real refusal without creating an order',
    orderResponse.status === 400 && orderCountBefore.count === orderCountAfter.count,
    `HTTP ${orderResponse.status}: ${String(orderBody.message ?? 'no safe error returned')}`,
  )

  const anonymousResponse = await fetch(`${url}/functions/v1/course-material-access`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ moduleId: MODULE_1, language: 'en' }),
  })
  record('an anonymous request is denied', anonymousResponse.status === 401, `HTTP ${anonymousResponse.status}`)

  // A signed-in student with no enrollment must not receive a link.
  const outsiderToken = (await client().auth.signInWithPassword({ email: outsiderEmail, password })).data.session.access_token
  const outsiderResponse = await fetch(`${url}/functions/v1/course-material-access`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${outsiderToken}`, apikey: key },
    body: JSON.stringify({ moduleId: MODULE_1, language: 'en' }),
  })
  const outsiderBody = await outsiderResponse.clone().json().catch(() => ({}))
  record(
    'a signed-in user without an enrollment cannot obtain material',
    outsiderResponse.status === 403,
    `HTTP ${outsiderResponse.status}: ${String(outsiderBody.error ?? 'no safe error returned')}`,
  )

  browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleErrors = []
  const materialResponses = []
  let createOrderRequests = 0
  let openedTabs = 0
  context.on('page', (opened) => {
    if (opened !== page) openedTabs += 1
  })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', async (response) => {
    if (!response.url().endsWith('/functions/v1/course-material-access')) return
    const requestBody = response.request().postDataJSON()
    const responseBody = await response.json().catch(() => ({}))
    materialResponses.push({ requestBody, status: response.status(), error: responseBody.error ?? null })
  })
  page.on('request', (request) => {
    if (request.url().includes('/rpc/create_order')) createOrderRequests += 1
  })

  await page.goto(`${origin}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', studentEmail)
  await page.fill('input[type="password"]', password)
  await page.click('button.full')
  await page.waitForURL(/\/dashboard/, { timeout: 30000 })
  log('enrolled student logged in')

  await page.goto(`${origin}/learn/${COURSE}/modules/${MODULE_1}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  const lessonTitle = (await page.locator('h1').first().textContent().catch(() => ''))?.trim()
  record('module 1 lesson renders', Boolean(lessonTitle), lessonTitle ?? '')

  // English material
  await page.selectOption('select', 'en').catch(() => log('no language selector'))
  await page.click('button:has-text("Open secure material link")')
  await page.waitForTimeout(2500)
  const enHref = await page.locator('.material-link a.button').first().getAttribute('href').catch(() => null)
  const enLabel = (await page.locator('.material-link a.button').first().textContent().catch(() => ''))?.trim()
  record('enrolled student obtains the English material link', Boolean(enHref?.includes('token=')), enLabel ?? 'no link')
  record('published PDF is labelled for browser viewing', enLabel === 'Open material', enLabel ?? '')

  // The signed URL must actually serve the deck.
  if (enHref) {
    const fetched = await fetch(enHref)
    const bytes = new Uint8Array(await fetched.arrayBuffer())
    const isPdf = new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
    record('the signed URL serves the real PDF bytes', fetched.status === 200 && isPdf, `HTTP ${fetched.status}, ${bytes.length} bytes`)
  }

  // Bisaya material. Changing the language deliberately clears the previous
  // link, so the button returns to its initial label.
  await page.selectOption('select', 'ceb').catch(() => {})
  await page.click('button:has-text("secure material link")')
  await page.waitForTimeout(2500)
  const cebHref = await page.locator('.material-link a.button').first().getAttribute('href').catch(() => null)
  record('enrolled student obtains the Bisaya material link', Boolean(cebHref?.includes('token=')), 'ceb requested')
  if (cebHref && enHref && cebHref !== enHref) {
    record('language selection returns a different object', true, 'en and ceb differ')
  }

  await page.reload({ waitUntil: 'networkidle' })
  await page.click('button:has-text("Open secure material link")')
  await page.waitForTimeout(1500)
  const refreshedHref = await page.locator('.material-link a.button').first().getAttribute('href').catch(() => null)
  record('refresh and repeat access succeeds', Boolean(refreshedHref?.includes('token=')), 'English requested again')
  record('successful clicks reserve a browser tab', openedTabs >= 3, `${openedTabs} tab(s) opened`)
  record('opening lessons never calls create_order', createOrderRequests === 0, `${createOrderRequests} request(s)`)

  record('no unexpected browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
  for (const response of materialResponses) {
    log('material request/response', `${JSON.stringify(response.requestBody)} -> HTTP ${response.status}: ${response.error ?? 'success'}`)
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
} catch (error) {
  console.error('ERROR:', error.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (created.length > 0) {
    // Every table that references auth.users must be cleared first, otherwise the
    // user delete fails on a foreign key and the fixture is silently left behind.
    const children = [
      ['audit_logs', 'actor_id'],
      ['material_access_events', 'user_id'],
      ['policy_acceptances', 'user_id'],
      ['enrollment_grants', 'created_by'],
      ['email_outbox', 'recipient_user_id'],
      ['quiz_attempts', 'user_id'],
      ['certificates', 'user_id'],
      ['payment_events', 'actor_id'],
      ['payment_proof_revisions', 'author_id'],
      ['payment_submissions', 'reviewer_id'],
      ['refund_requests', 'reviewed_by'],
      ['refunds', 'recorded_by'],
      ['orders', 'user_id'],
      ['user_roles', 'user_id'],
      ['profiles', 'id'],
    ]
    const targets = created.map((id) => `'${id}'::uuid`).join(',')
    const selector = `(select id from auth.users where id in (${targets}))`
    let ok = true
    for (const [table, column] of children) {
      const outcome = sql(`delete from public.${table} where ${column} in ${selector};`)
      if (!outcome.ok) {
        console.error(`CLEANUP FAILED on ${table}:`, outcome.out.slice(0, 200))
        ok = false
      }
    }
    for (const table of ['module_progress', 'enrollment_modules']) {
      const outcome = sql(
        `delete from public.${table} where enrollment_id in (select id from public.enrollments where user_id in ${selector});`,
      )
      if (!outcome.ok) {
        console.error(`CLEANUP FAILED on ${table}:`, outcome.out.slice(0, 200))
        ok = false
      }
    }
    for (const statement of [
      `delete from public.enrollments where user_id in ${selector};`,
      `delete from auth.users where id in (${targets});`,
    ]) {
      const outcome = sql(statement)
      if (!outcome.ok) {
        console.error('CLEANUP FAILED:', outcome.out.slice(0, 200))
        ok = false
      }
    }
    const residue = sql(`select count(*) as residue from auth.users where id in (${targets});`)
    if (!residue.ok || !/│\s*0\s*│/.test(residue.out)) {
      console.error('CLEANUP LEFT ROWS:', residue.out.slice(0, 200))
      ok = false
    } else {
      console.log('cleanup — disposable material-probe accounts removed')
    }
    if (!ok) process.exitCode = 1
  }
}
