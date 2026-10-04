// Browser verification of the learner certificate panel.
//
// Drives a disposable learner through the real UI-facing RPCs (mark studied,
// take the final assessment) and then loads the course page in Chromium to
// confirm automatic issuance, the View and Download actions, the verification
// link, and that reloading does not create a second certificate.
//
// Only disposable accounts are created and removed. No real learner is touched
// and the database is never reset.

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const origin = process.env.VITE_APP_ORIGIN ?? 'http://127.0.0.1:5173'

if (!url || !key) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required')

const COURSE = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'
const APPROVED_EIGHT = [
  '994538f1-1544-4df0-aaba-f968f7addf93',
  'ca1f067e-b499-46c2-8471-256072d0071a',
  '3d3f0426-7385-4cea-b43e-cb7f2b1d2002',
  '7196d8c5-0632-4427-841b-c8c2469e781b',
  '7228d8b9-f80b-47b0-97c1-e3af7b8df2d4',
  '0be31428-21bb-40b5-9110-0e9ebdb6c122',
  '108173b3-9266-4b4a-b18b-bb6bb28a7275',
  '99ce1711-cb3b-4daa-a4a8-09e4b3c092ce',
]

const results = []
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const log = (label, detail = '') => console.log(`     ${label}${detail ? ` — ${detail}` : ''}`)

function sql(text) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', text], { encoding: 'utf8' })
  const out = `${result.stdout}${result.stderr}`
  if (/unexpected status|ERROR/.test(out)) throw new Error(`sql failed: ${out.slice(0, 400)}`)
  return out
}
function scalar(text) {
  const lines = text.split('\n')
  const separator = lines.findIndex((line) => line.trim().startsWith('├'))
  const line = lines[separator + 1] ?? ''
  return line.split('│')[1]?.trim() ?? ''
}

const stamp = Date.now()
const learnerEmail = `academy-cert-browser-${stamp}-${randomUUID().slice(0, 6)}@example.com`
const adminEmail = `academy-cert-browser-admin-${stamp}-${randomUUID().slice(0, 6)}@example.com`
const password = `Mat-${randomUUID()}-Aa1!`
const learnerName = 'Certificate Browser Learner'
const anon = createClient(url, key)

let learnerId = null
let adminId = null
let browser = null

async function main() {
  const learner = await anon.auth.signUp({
    email: learnerEmail,
    password,
    options: {
      data: {
        full_name: learnerName,
        preferred_language: 'en',
        age_18_attested: true,
        terms_version: 'development-draft-2026-10-03',
        privacy_version: 'development-draft-2026-10-03',
      },
    },
  })
  if (learner.error) throw new Error(`learner signup failed: ${learner.error.message}`)
  learnerId = learner.data.user.id

  const adminSignup = await anon.auth.signUp({
    email: adminEmail,
    password,
    options: {
      data: {
        full_name: 'Certificate Browser Admin',
        preferred_language: 'en',
        age_18_attested: true,
        terms_version: 'development-draft-2026-10-03',
        privacy_version: 'development-draft-2026-10-03',
      },
    },
  })
  if (adminSignup.error) throw new Error(`admin signup failed: ${adminSignup.error.message}`)
  adminId = adminSignup.data.user.id
  sql(`insert into public.user_roles (user_id, role) values ('${adminId}'::uuid, 'admin') on conflict do nothing;`)
  const adminLogin = await anon.auth.signInWithPassword({ email: adminEmail, password })
  if (adminLogin.error) throw new Error(`admin login failed: ${adminLogin.error.message}`)
  const adminApi = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${adminLogin.data.session.access_token}` } },
  })

  const granted = await adminApi.rpc('grant_manual_enrollment', {
    target_user: learnerId,
    target_course: COURSE,
    grant_kind: 'complimentary',
    reason: 'disposable browser certificate fixture; no payment represented',
  })
  if (granted.error) throw new Error(`enrollment grant failed: ${granted.error.message}`)

  const enrollmentId = scalar(
    sql(`select id::text || '~' as v from public.enrollments where user_id = '${learnerId}' and course_id = '${COURSE}';`),
  ).replace('~', '')
  log('enrollment', enrollmentId)

  const snapshotCount = Number(
    scalar(sql(`select (count(*)::text || '~') as v from public.enrollment_modules where enrollment_id = '${enrollmentId}' and required;`)).replace('~', ''),
  )
  check('new enrollment receives exactly the approved eight required modules', snapshotCount === APPROVED_EIGHT.length, `required=${snapshotCount}`)

  const learnerLogin = await anon.auth.signInWithPassword({ email: learnerEmail, password })
  if (learnerLogin.error) throw new Error(`learner login failed: ${learnerLogin.error.message}`)
  const learnerApi = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${learnerLogin.data.session.access_token}` } },
  })

  // Real learner RPCs, the same ones the lesson page calls.
  for (const moduleId of APPROVED_EIGHT) {
    const studied = await learnerApi.rpc('mark_module_studied', { target_module: moduleId })
    if (studied.error) throw new Error(`mark_module_studied failed for ${moduleId}: ${studied.error.message}`)
  }
  const completed = Number(
    scalar(sql(`select (count(*)::text || '~') as v from public.module_progress where enrollment_id = '${enrollmentId}' and completed_at is not null;`)).replace('~', ''),
  )
  check('all eight modules complete through the learner RPC', completed === APPROVED_EIGHT.length, `completed=${completed}`)

  // Final assessment through the real start/submit path. The answer key is read
  // from the private schema purely to drive this disposable fixture; the attempt
  // itself is started, scored and passed by the trusted RPCs.
  const keyRows = sql(`select string_agg(ak.question_id::text || ',' || ak.option_id::text, ';' order by q.position) as v from private.quiz_answer_keys ak join public.quiz_questions q on q.id = ak.question_id join public.quiz_versions v on v.id = q.quiz_version_id join public.quizzes z on z.id = v.quiz_id where z.course_id = '${COURSE}' and z.kind = 'final' and v.status = 'published';`)
  const answerKey = scalar(keyRows).split(';').filter(Boolean).map((pair) => {
    const [questionId, optionId] = pair.split(',')
    return { questionId, optionId }
  })
  check('published final assessment has an answer key', answerKey.length > 0, `questions=${answerKey.length}`)

  const started = await learnerApi.rpc('start_quiz_attempt', {
    target_quiz: scalar(sql(`select id::text || '~' as v from public.quizzes where course_id = '${COURSE}' and kind = 'final';`)).replace('~', ''),
    attempt_language: 'en',
  })
  if (started.error) throw new Error(`start_quiz_attempt failed: ${started.error.message}`)
  const submitted = await learnerApi.rpc('submit_quiz_attempt', {
    target_attempt: started.data,
    answers: answerKey,
  })
  if (submitted.error) throw new Error(`submit_quiz_attempt failed: ${submitted.error.message}`)
  check(
    'final assessment is scored and passed by the trusted RPCs',
    submitted.data?.passed === true,
    `score=${submitted.data?.score} passed=${submitted.data?.passed}`,
  )

  // Now the browser.
  browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const requests = []
  page.on('request', (request) => {
    if (request.url().includes('generate-certificate')) requests.push(request.url())
  })

  await page.goto(`${origin}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', learnerEmail)
  await page.fill('input[type="password"]', password)
  await page.click('button.full')
  await page.waitForURL(/\/dashboard/, { timeout: 30000 })
  await page.goto(`${origin}/learn/${COURSE}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(5000)

  const body = await page.locator('body').innerText()
  check('learner page shows the approved required-module count', body.includes('8 approved modules') || body.includes('8 required modules'), body.match(/\d+ (approved|required) modules?/)?.[0] ?? 'not shown')

  const hasView = await page.getByRole('button', { name: /view certificate/i }).count()
  const hasDownload = await page.getByRole('button', { name: /download certificate/i }).count()
  const verifyHref = await page.getByRole('link', { name: /public verification/i }).getAttribute('href').catch(() => null)

  check('certificate is issued automatically on the learner page', hasView > 0 && hasDownload > 0, `view=${hasView} download=${hasDownload}`)
  check('View certificate action is present', hasView > 0, '')
  check('Download certificate action is present', hasDownload > 0, '')
  check('public verification link is present', typeof verifyHref === 'string' && /\/verify\/LVA-/.test(verifyHref), verifyHref ?? 'missing')

  page.on('pageerror', (error) => log('page error', error.message))

  // Chromium turns an attachment response into a download and an inline
  // response into a navigation, so page.url() cannot tell the two apart. The
  // storage response itself is the reliable signal.
  const storageRequests = []
  page.on('response', async (response) => {
    if (!response.url().includes('/storage/v1/object/sign/certificates/')) return
    const headers = response.headers()
    let magic = ''
    let bytes = 0
    try {
      const body = await response.body()
      magic = body.subarray(0, 5).toString()
      bytes = body.length
    } catch { magic = '<unreadable>' }
    storageRequests.push({
      status: response.status(),
      contentType: headers['content-type'] ?? '',
      disposition: headers['content-disposition'] ?? '',
      magic,
      bytes,
    })
  })

  const clickAndWaitForStorage = async (name) => {
    const downloads = []
    const before = storageRequests.length
    const onDownload = (download) => downloads.push(download)
    page.on('download', onDownload)
    await page.getByRole('button', { name }).click().catch((error) => log('click failed', error.message))
    for (let waited = 0; waited < 30000 && storageRequests.length <= before; waited += 500) {
      await page.waitForTimeout(500)
    }
    page.off('download', onDownload)
    return downloads
  }

  const downloadEvents = await clickAndWaitForStorage(/download certificate/i)
  const downloadResponse = storageRequests.find((entry) => entry.disposition.includes('attachment'))
  check('download fetches a signed certificate PDF', Boolean(downloadResponse), downloadResponse ? `status=${downloadResponse.status}` : 'no storage request')
  check('download returns a successful storage response', downloadResponse?.status === 200, `status=${downloadResponse?.status ?? 'none'}`)
  check(
    'download is served as an attachment',
    (downloadResponse?.contentType ?? '').includes('application/pdf') && (downloadResponse?.disposition ?? '').includes('attachment'),
    `content-disposition=${downloadResponse?.disposition ?? 'none'}`,
  )
  const savedNames = downloadEvents.map((download) => download.suggestedFilename())
  check('browser saves the file as a certificate PDF', savedNames.some((name) => /\.pdf$/i.test(name)), savedNames.join(',') || 'no download event')

  // A download response body cannot be read back through the page, so the bytes
  // are checked on the file Chromium actually wrote to disk.
  let savedMagic = 'no file'
  let savedBytes = 0
  if (downloadEvents[0]) {
    const savedPath = await downloadEvents[0].path().catch(() => null)
    if (savedPath) {
      const saved = readFileSync(savedPath)
      savedMagic = saved.subarray(0, 5).toString()
      savedBytes = saved.length
    }
  }
  check('the saved file really is a PDF', savedMagic === '%PDF-', `magic=${savedMagic} bytes=${savedBytes}`)

  await clickAndWaitForStorage(/view certificate/i, /inline|attachment/)
  const viewResponse = storageRequests.find((entry) => entry !== downloadResponse)
  check('view certificate fetches the PDF inline', (viewResponse?.contentType ?? '').includes('application/pdf') && !(viewResponse?.disposition ?? '').includes('attachment'), `content-disposition=${viewResponse?.disposition ?? 'none'}`)

  const viewHref = verifyHref
  const verificationPage = await page.goto(`${origin}${viewHref}`, { waitUntil: 'networkidle' }).catch(() => null)
  await page.waitForTimeout(2500)
  const verificationText = await page.locator('body').innerText().catch(() => '')
  check('verification page renders the certificate publicly', verificationPage?.status?.() === 200 && verificationText.includes(learnerName), verificationText.split('\n').slice(0, 6).join(' / '))

  // Reloading must not create a second certificate.
  await page.goto(`${origin}/learn/${COURSE}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(5000)
  const rows = Number(
    scalar(sql(`select (count(*)::text || '~') as v from public.certificates where enrollment_id = '${enrollmentId}';`)).replace('~', ''),
  )
  check('reload does not duplicate issuance', rows === 1, `certificates=${rows}`)
  check('issuance was requested automatically', requests.length >= 1, `requests=${requests.length}`)

  await context.close()
}

try {
  await main()
} catch (error) {
  check('probe completed without error', false, error instanceof Error ? error.message : String(error))
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const id of [learnerId, adminId]) {
    if (!id) continue
    try {
      sql(`delete from public.email_delivery_events where outbox_id in (select id from public.email_outbox where recipient_user_id = '${id}'::uuid);`)
      sql(`delete from public.email_outbox where recipient_user_id = '${id}'::uuid;`)
      sql(`delete from public.certificates where user_id = '${id}'::uuid;`)
      sql(`delete from public.quiz_attempts where user_id = '${id}'::uuid;`)
      sql(`delete from public.module_progress where enrollment_id in (select id from public.enrollments where user_id = '${id}'::uuid);`)
      sql(`delete from public.enrollment_modules where enrollment_id in (select id from public.enrollments where user_id = '${id}'::uuid);`)
      sql(`delete from public.enrollment_grants where created_by = '${id}'::uuid or enrollment_id in (select id from public.enrollments where user_id = '${id}'::uuid);`)
      sql(`delete from public.enrollments where user_id = '${id}'::uuid;`)
      sql(`delete from public.audit_logs where actor_id = '${id}'::uuid;`)
      sql(`delete from public.user_roles where user_id = '${id}'::uuid;`)
      sql(`delete from auth.users where id = '${id}'::uuid;`)
    } catch (error) {
      console.log(`cleanup warning: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (learnerId) console.log(`\ncleaned up disposable browser learner ${learnerEmail}`)
}

const failed = results.filter((row) => !row.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1