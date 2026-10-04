#!/usr/bin/env node
// Temporary reproduction for the approved-payment -> course-visibility report.
// Creates a disposable student, approves a payment through the real admin RPC,
// then proves what the database returns to that student versus what the
// dashboard actually renders. Everything is cleaned up in finally.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

if (process.env.HOSTED_TEST_ALLOW_MUTATION !== '1') {
  console.error('REFUSING: set HOSTED_TEST_ALLOW_MUTATION=1 for the isolated test project')
  process.exit(2)
}

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const origin = process.env.VITE_APP_ORIGIN
if (!url || !key || !origin) {
  console.error('REFUSING: the three browser-safe VITE_* values are required')
  process.exit(2)
}
const configuredRef = new URL(url).hostname.split('.')[0]
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (configuredRef !== linkedRef) {
  console.error('REFUSING: linked project does not match the configured browser URL')
  process.exit(2)
}

function client(accessToken) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  })
}

function dbQuery(sql) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout)
    throw new Error('Trusted test-project SQL operation failed')
  }
  return result.stdout
}

async function signup(label, runId) {
  const email = `repro-${label}-${runId}@example.com`
  const password = `Repro-${randomUUID()}-Aa1!`
  const auth = client()
  const signup = await auth.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: `Repro ${label}`,
        preferred_language: 'en',
        age_18_attested: true,
        terms_version: 'development-draft-2026-10-03',
        privacy_version: 'development-draft-2026-10-03',
      },
    },
  })
  if (signup.error || !signup.data.user) throw new Error(`${label} signup failed`)
  await auth.auth.signOut()
  const login = await auth.auth.signInWithPassword({ email, password })
  if (login.error || !login.data.session) throw new Error(`${label} login failed`)
  return { id: login.data.user.id, email, password, token: login.data.session.access_token }
}

const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
const orderId = randomUUID()
const methodRow = dbQuery(
  `select id, display_name from public.payment_methods where type = 'gcash';`,
)
const methodId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(methodRow)?.[0]
const courseRow = dbQuery(`select id, title, status from public.courses where slug = 'logistics-101';`)
const courseId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(courseRow)?.[0]

let adminId = ''
let studentId = ''
let submissionId = ''

try {
  const admin = await signup('admin', runId)
  const student = await signup('student', runId)
  adminId = admin.id
  studentId = student.id

  dbQuery(`insert into public.user_roles (user_id, role) values ('${adminId}'::uuid, 'admin') on conflict do nothing;`)

  const adminApi = client(admin.token)
  const studentApi = client(student.token)

  dbQuery(`
    insert into public.orders (id, user_id, course_id, price_centavos, currency, status)
    values ('${orderId}'::uuid, '${studentId}'::uuid, '${courseId}'::uuid, 69900, 'PHP', 'open');
  `)

  const pending = dbQuery(`
    select id as sid from public.payment_submissions
    where order_id = '${orderId}'::uuid;
  `)

  // Create the submission through the same trusted path production uses.
  const form = new FormData()
  form.set('orderId', orderId)
  form.set('methodId', methodId)
  form.set('amountCentavos', '69900')
  form.set('referenceNumber', `REPRO-${runId}`)
  form.set('transactionAt', new Date().toISOString())
  form.set('proof', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: 'image/png' }), 'repro.png')

  const submitted = await fetch(`${url}/functions/v1/submit-payment-proof`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${student.token}`, Origin: origin },
    body: form,
  })
  const submittedBody = await submitted.json()
  submissionId = submittedBody.submissionId
  console.log(`proof submission HTTP ${submitted.status}, status=${submittedBody.status}`)
  void pending

  const enrollmentBefore = await studentApi.from('enrollments').select('id').eq('course_id', courseId)
  console.log(`enrollments visible to student BEFORE approval: ${enrollmentBefore.data?.length ?? 'error'} (error: ${enrollmentBefore.error?.message ?? 'none'})`)

  const approval = await adminApi.rpc('review_payment', {
    target_submission: submissionId,
    decision: 'approved',
    reason: '',
  })
  console.log(`admin approval error: ${approval.error?.message ?? 'none'}`)

  const duplicate = await adminApi.rpc('review_payment', {
    target_submission: submissionId,
    decision: 'approved',
    reason: '',
  })
  const enrollmentCount = dbQuery(`select count(*) from public.enrollments where user_id = '${studentId}'::uuid;`)
  console.log(`second approval error: ${duplicate.error?.message ?? 'none'}; enrollment rows: ${enrollmentCount.trim()}`)

  const enrollmentAfter = await studentApi.from('enrollments').select('id,status,course_id')
  console.log(`enrollments visible to student AFTER approval: ${JSON.stringify(enrollmentAfter.data)} (error: ${enrollmentAfter.error?.message ?? 'none'})`)

  const submissionRow = await studentApi.from('payment_submissions').select('status').eq('id', submissionId).single()
  console.log(`submission status for student: ${submissionRow.data?.status}`)

  const courseRowForStudent = await studentApi.from('courses').select('id,title,status').eq('id', courseId).maybeSingle()
  console.log(`course readable by student: ${JSON.stringify(courseRowForStudent.data)} (error: ${courseRowForStudent.error?.message ?? 'none'})`)

  // Now render the real dashboard as this approved student.
  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: origin })
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(student.email)
  await page.getByLabel(/password/i).fill(student.password)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
  await page.waitForLoadState('networkidle')

  const bodyText = await page.locator('body').innerText()
  const dashboardHtml = await page.locator('.dashboard-card').first().innerHTML().catch(() => '(no .dashboard-card)')
  console.log('--- dashboard text ---')
  console.log(bodyText.slice(0, 1200))
  console.log('--- dashboard-card html ---')
  console.log(dashboardHtml.slice(0, 800))
  console.log(`dashboard links to /learn: ${(await page.locator('a[href*="/learn"]').count()) > 0}`)
  console.log(`dashboard mentions enrollment: ${/no active enrollment/i.test(bodyText)}`)
  console.log(`dashboard offers checkout only: ${/checkout/i.test(bodyText)}`)

  await browser.close()
} catch (error) {
  console.error(`reproduction stopped: ${error instanceof Error ? error.message : 'unknown failure'}`)
  process.exitCode = 1
} finally {
  if (adminId && studentId) {
    try {
      dbQuery(`
        begin;
        delete from public.email_delivery_events where outbox_id in (select id from public.email_outbox where recipient_user_id in ('${adminId}'::uuid, '${studentId}'::uuid));
        delete from public.email_outbox where recipient_user_id in ('${adminId}'::uuid, '${studentId}'::uuid);
        delete from public.payment_events where submission_id in (select ps.id from public.payment_submissions ps join public.orders o on o.id = ps.order_id where o.user_id in ('${adminId}'::uuid, '${studentId}'::uuid));
        delete from public.enrollment_grants where enrollment_id in (select id from public.enrollments where user_id in ('${adminId}'::uuid, '${studentId}'::uuid)) or created_by = '${adminId}'::uuid;
        delete from public.enrollments where user_id in ('${adminId}'::uuid, '${studentId}'::uuid);
        delete from public.payment_proof_revisions where submission_id in (select ps.id from public.payment_submissions ps join public.orders o on o.id = ps.order_id where o.user_id in ('${adminId}'::uuid, '${studentId}'::uuid));
        delete from public.payment_submissions where order_id in (select id from public.orders where user_id in ('${adminId}'::uuid, '${studentId}'::uuid));
        delete from public.orders where user_id in ('${adminId}'::uuid, '${studentId}'::uuid);
        delete from public.module_progress where enrollment_id in (select id from public.enrollments where user_id in ('${adminId}'::uuid, '${studentId}'::uuid));
        delete from public.audit_logs where actor_id in ('${adminId}'::uuid, '${studentId}'::uuid);
        delete from public.user_roles where user_id in ('${adminId}'::uuid, '${studentId}'::uuid);
        delete from auth.users where id in ('${adminId}'::uuid, '${studentId}'::uuid);
        commit;
      `)
      console.log('cleanup: disposable rows removed')
    } catch {
      console.error('WARNING: disposable hosted fixture cleanup requires manual review')
    }
  }
}