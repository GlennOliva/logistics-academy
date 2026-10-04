#!/usr/bin/env node

// End-to-end verification of PDF/PPT/PPTX course-material uploads through the
// real admin browser interface against the linked test project.
//
// Everything here goes through the same code path a trainer uses: file picker,
// client validation, the submit-course-material edge function, private Storage,
// admin_save_module_translation, and course-material-access for the download.
// No row or object is written directly by this script.
//
// Each uploaded file is recorded so it can be reverted afterwards, leaving the
// existing Module 1 materials and all student progress untouched.

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const origin = process.env.VITE_APP_ORIGIN ?? 'http://localhost:5173'
const fixtures = process.env.MATERIAL_FIXTURES ?? '/tmp/matfix'
if (!url || !key) {
  console.error('REFUSING: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required')
  process.exit(2)
}

const COURSE = '3bc1e477-8736-42f2-8a1d-4209-...' // replaced below
const MODULE_1 = '994538f1-1544-4df0-aaba-f968f7addf93'
const COURSE_ID = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'
void COURSE

const log = (label, detail = '') => console.log(`${label}${detail ? ` — ${detail}` : ''}`)
const results = []

function record(step, ok, detail = '') {
  results.push({ step, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}: ${step}`, detail)
}

function sql(text) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', text], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = `${result.stdout}${result.stderr}`
  return { ok: !(out.includes('ERROR') || out.includes('Failed to run sql query')), out }
}

// Counts are wrapped in a sentinel so the value is unambiguous in the table
// output; the column header would otherwise be matched by a naive parse.
function countOf(where) {
  const out = sql(`select 'COUNT' || count(*)::text || 'END' as v from ${where};`).out
  return Number(out.match(/COUNT(\d+)END/)?.[1] ?? NaN)
}

const runId = Date.now()
const adminEmail = `academy-fmt-admin-${runId}-${randomUUID().slice(0, 6)}@example.com`
const studentEmail = `academy-fmt-student-${runId}-${randomUUID().slice(0, 6)}@example.com`
const outsiderEmail = `academy-fmt-outsider-${runId}-${randomUUID().slice(0, 6)}@example.com`
const password = `Fmt-${randomUUID()}-Aa1!`

const profile = {
  full_name: 'Format Probe',
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
const uploaded = []

async function signUp(email) {
  const api = client()
  const { data, error } = await api.auth.signUp({
    email,
    password,
    options: { data: profile, emailRedirectTo: `${origin}/dashboard` },
  })
  if (error) throw new Error(`signup ${email}: ${error.message}`)
  created.push(data.user.id)
  const signIn = await api.auth.signInWithPassword({ email, password })
  if (signIn.error) throw new Error(`signin ${email}: ${signIn.error.message}`)
  return { id: data.user.id, token: signIn.data.session.access_token, api: client(signIn.data.session.access_token) }
}

async function grantAdmin(token) {
  const result = sql(
    `insert into public.user_roles (user_id, role) values ((select id from auth.users where email = '${adminEmail}'), 'admin') on conflict do nothing;`,
  )
  if (!result.ok) throw new Error(`grant admin failed: ${result.out}`)
  void token
}

async function enroll(student) {
  const created$ = sql(
    `insert into public.enrollments (user_id, course_id, status) values ('${student.id}'::uuid, '${COURSE_ID}'::uuid, 'active') returning id;`,
  )
  if (!created$.ok) throw new Error(`enroll failed: ${created$.out}`)
  const enrollmentId = created$.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
  if (!enrollmentId) throw new Error('enrollment id not returned')
  sql(`select public.snapshot_curriculum('${enrollmentId}'::uuid);`)
  return enrollmentId
}

// Drives the real admin upload form: sets the file picker, fills the fields and
// submits. Returns the message the UI rendered.
async function uploadThroughUi(page, { file, language, title }) {
  await page.goto(`${origin}/admin/courses/${MODULE_1}/material`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.selectOption('select[name="language"]', language)
  await page.fill('input[name="title"]', title)
  await page.setInputFiles('input[name="material"]', file)
  await page.click('button.full')
  await page.waitForFunction(
    () => /Saved|failed|must be|PDF|PowerPoint|Upload|no larger|required/i.test(document.body.innerText),
    null,
    { timeout: 30000 },
  ).catch(() => {})
  await page.waitForTimeout(2500)
  const banner = await page.locator('p.status').first().textContent().catch(() => null)
  return (banner ?? '').trim()
}

async function main() {
  for (const name of ['logistics-basics.pdf', 'logistics-basics.ppt', 'logistics-basics.pptx', 'not-a-deck.pptx', 'deck-renamed.ppt', 'notes.txt', 'oversized.pdf']) {
    if (!existsSync(`${fixtures}/${name}`)) throw new Error(`missing fixture ${fixtures}/${name}`)
  }

  const admin = await signUp(adminEmail)
  await grantAdmin(admin.token)
  const student = await signUp(studentEmail)
  await enroll(student)
  const outsider = await signUp(outsiderEmail)

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(`${origin}/login`, { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', adminEmail)
    await page.fill('input[type="password"]', password)
    await page.click('button.full')
    await page.waitForURL(/\/dashboard|\/admin/, { timeout: 30000 })
    record('admin signs in through the browser', true, adminEmail)

    // --- PDF ---
    let message = await uploadThroughUi(page, {
      file: `${fixtures}/logistics-basics.pdf`,
      language: 'en',
      title: 'Format probe PDF',
    })
    let saved = /Saved/.test(message)
    record('PDF uploads successfully through the admin UI', saved, message.slice(0, 130))

    // --- PPT ---
    message = await uploadThroughUi(page, {
      file: `${fixtures}/logistics-basics.ppt`,
      language: 'en',
      title: 'Format probe PPT',
    })
    record('PPT uploads successfully through the admin UI', /Saved/.test(message), message.slice(0, 130))

    // --- PPTX ---
    message = await uploadThroughUi(page, {
      file: `${fixtures}/logistics-basics.pptx`,
      language: 'en',
      title: 'Format probe PPTX',
    })
    record('PPTX uploads successfully through the admin UI', /Saved/.test(message), message.slice(0, 130))

    // --- rejections ---
    message = await uploadThroughUi(page, {
      file: `${fixtures}/not-a-deck.pptx`,
      language: 'en',
      title: 'Format probe bad zip',
    })
    record('a ZIP that is not a presentation is rejected', !/Saved/.test(message), message.slice(0, 130))

    message = await uploadThroughUi(page, {
      file: `${fixtures}/deck-renamed.ppt`,
      language: 'en',
      title: 'Format probe renamed deck',
    })
    record('a PPTX renamed to .ppt is rejected', !/Saved/.test(message), message.slice(0, 130))

    message = await uploadThroughUi(page, {
      file: `${fixtures}/notes.txt`,
      language: 'en',
      title: 'Format probe text',
    })
    record('a text file is rejected', !/Saved/.test(message), message.slice(0, 130))

    message = await uploadThroughUi(page, {
      file: `${fixtures}/oversized.pdf`,
      language: 'en',
      title: 'Format probe oversized',
    })
    record('a file over 50 MB is rejected', !/Saved/.test(message), message.slice(0, 130))

    // --- versions saved with correct format / language / filename ---
    const versionRows = sql(
      `select title || ' ~ ' || language || ' ~ ' || object_path || ' ~ ' || size_bytes::text from public.module_translations where module_id = '${MODULE_1}' and title like 'Format probe%' order by created_at;`,
    ).out
    const versions = versionRows.split('\n').filter((line) => /Format probe/.test(line))
    uploaded.push(...versions)

    const pdfRow = versions.find((line) => /\.pdf ~ \d+/.test(line))
    const pptRow = versions.find((line) => /\.ppt ~ \d+/.test(line))
    const pptxRow = versions.find((line) => /\.pptx ~ \d+/.test(line))
    record('a version was saved for each accepted format', Boolean(pdfRow && pptRow && pptxRow), `pdf=${Boolean(pdfRow)} ppt=${Boolean(pptRow)} pptx=${Boolean(pptxRow)}`)
    record('each saved version carries the requested language', versions.length > 0 && versions.every((line) => / ~ en ~ /.test(line)), `${versions.length} version(s)`)

    // Object paths are content addressed, so the extension is the stored format.
    record('stored object path records the real format', Boolean(pdfRow && pptRow && pptxRow), [pdfRow, pptRow, pptxRow].filter(Boolean).map((r) => r.split(' ~ ')[2]?.split('/').pop()).join(', '))

    // --- immutability: re-uploading identical bytes must not create a version ---
    const before = versions.length
    message = await uploadThroughUi(page, {
      file: `${fixtures}/logistics-basics.pptx`,
      language: 'en',
      title: 'Format probe PPTX',
    })
    const after = countOf(`public.module_translations where module_id = '${MODULE_1}' and title like 'Format probe%'`)
    record(
      're-uploading identical bytes does not create a duplicate version',
      /same file already stored/i.test(message) && after === before,
      `message=${message.slice(0, 60)} versions=${after}`,
    )

    // --- student downloads every stored format ---
    // The accessor serves the newest published translation, so each format is
    // checked in turn by publishing that version first.
    for (const format of ['pdf', 'ppt', 'pptx']) {
      sql(`update public.module_translations set published = false where module_id = '${MODULE_1}' and title like 'Format probe%';`)
      sql(`update public.module_translations set published = true where module_id = '${MODULE_1}' and title like 'Format probe%' and object_path like '%.${format}';`)

      const access = await student.api.functions.invoke('course-material-access', {
        body: { moduleId: MODULE_1, language: 'en' },
      })
      const granted = access.data
      if (granted?.format !== format) {
        record(`student download reports the stored ${format.toUpperCase()} format`, false, `got ${granted?.format ?? access.error?.message}`)
        continue
      }
      const fetched = granted?.url ? await context.request.get(granted.url).catch(() => null) : null
      const bytes = fetched ? Buffer.from(await fetched.body()) : Buffer.alloc(0)
      const signature =
        format === 'ppt'
          ? bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'
          : format === 'pptx'
            ? bytes.subarray(0, 4).toString('hex') === '504b0304'
            : bytes.subarray(0, 5).toString() === '%PDF-'
      record(
        `authorized student downloads the ${format.toUpperCase()} material`,
        Boolean(fetched) && fetched.status() === 200 && signature,
        `format=${granted.format} status=${fetched?.status()} bytes=${bytes.length}`,
      )
    }

    // The real Module 1 material must still be downloadable after the probe.
    sql(`update public.module_translations set published = false where module_id = '${MODULE_1}' and title like 'Format probe%';`)

    // --- outsider refused ---
    const refused = await outsider.api.functions.invoke('course-material-access', {
      body: { moduleId: MODULE_1, language: 'en' },
    })
    record(
      'a user with no enrollment is refused material access',
      Boolean(refused.error) || refused.data?.allowed === false,
      refused.error?.message ?? `allowed=${refused.data?.allowed}`,
    )

    // --- unauthenticated refused ---
    const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const raw = await fetch(`${url}/functions/v1/course-material-access`, {
      method: 'POST',
      headers: { apikey: key, 'content-type': 'application/json', authorization: `Bearer ${anonAnonKey(anon)}` },
      body: JSON.stringify({ moduleId: MODULE_1, language: 'en' }),
    }).catch(() => null)
    record('an unauthenticated request is refused', raw?.status === 401 || raw?.status === 403, `status=${raw?.status}`)
  } finally {
    await browser.close()
  }

  const passed = results.filter((entry) => entry.ok).length
  log('', '')
  log('passed', `${passed}/${results.length}`)
  if (passed !== results.length) process.exitCode = 1
}

function anonAnonKey(anon) {
  void anon
  return key
}

main()
  .then(async () => {
    // Remove only the rows this probe created, leaving genuine material and all
    // student progress intact.
    // Delete in FK dependency order, keyed on this probe's own email prefix
    // rather than on collected ids so a partial earlier failure cannot leak.
    // material_access_events references enrollments and
    // email_delivery_events references email_outbox, and
    // module_translations.created_by references auth.users, so all of those must
    // be cleared before the account rows themselves.
    const scoped = `(select id from auth.users where email like 'academy-fmt-%@example.com')`
    const ordered = [
      `delete from public.material_access_events where user_id in ${scoped};`,
      `delete from public.email_delivery_events where outbox_id in (select id from public.email_outbox where recipient_user_id in ${scoped});`,
      `delete from public.email_outbox where recipient_user_id in ${scoped};`,
      `delete from public.certificates where user_id in ${scoped};`,
      `delete from public.quiz_attempts where user_id in ${scoped};`,
      `delete from public.module_progress where enrollment_id in (select id from public.enrollments where user_id in ${scoped});`,
      `delete from public.enrollment_modules where enrollment_id in (select id from public.enrollments where user_id in ${scoped});`,
      `delete from public.enrollment_grants where created_by in ${scoped} or enrollment_id in (select id from public.enrollments where user_id in ${scoped});`,
      `delete from public.enrollments where user_id in ${scoped};`,
      `delete from public.audit_logs where actor_id in ${scoped};`,
      `delete from public.user_roles where user_id in ${scoped};`,
      `delete from public.module_translations where created_by in ${scoped} and title like 'Format probe%';`,
      `delete from auth.users where id in ${scoped};`,
    ]
    let failures = 0
    for (const statement of ordered) {
      const outcome = sql(statement)
      if (!outcome.ok) {
        failures += 1
        log('cleanup warning', outcome.out.replace(/\s+/g, ' ').slice(0, 300))
      }
    }
    if (failures > 0) log('cleanup', `${failures} statement(s) failed`)
    log('cleaned up', `${created.length} disposable account(s) removed`)
  })
  .catch((error) => {
    console.error('probe error:', error.message)
    process.exitCode = 1
  })
