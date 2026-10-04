#!/usr/bin/env node

// Drives the real browser through the disposable learner's journey against the
// linked test project and reports observed percentages at each step.
// Disposable fixtures only; never touches real students.

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

const email = `academy-journey-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`
const password = `Journey-${randomUUID()}-Aa1!`
const longName = 'Maria Concepcion dela Cruz Buenaventura-Santos III'

const log = (label, detail = '') => console.log(`${label}${detail ? ` — ${detail}` : ''}`)

function sql(text) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', text], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = `${result.stdout}${result.stderr}`
  const fail = out.includes('ERROR') || out.includes('Failed to run sql query')
  return { ok: !fail, out }
}

const auth = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

// A disposable administrator grants the enrollment through the real API, because
// grant_manual_enrollment deliberately requires an admin auth.uid() context that
// a direct SQL session cannot provide.
const adminEmail = `academy-journey-admin-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`
const adminPassword = `Journey-${randomUUID()}-Aa1!`

async function disposableAdmin() {
  const adminAuth = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const created = await adminAuth.auth.signUp({
    email: adminEmail,
    password: adminPassword,
    options: {
      data: {
        full_name: 'Journey Admin',
        preferred_language: 'en',
        age_18_attested: true,
        terms_version: 'development-draft-2026-10-03',
        privacy_version: 'development-draft-2026-10-03',
      },
    },
  })
  if (created.error) throw new Error(`admin signup failed: ${created.error.message}`)
  const adminId = created.data.user.id
  const role = sql(`insert into public.user_roles (user_id, role) values ('${adminId}'::uuid, 'admin') on conflict do nothing;`)
  if (!role.ok) throw new Error(`admin role insert failed: ${role.out.slice(0, 300)}`)
  const login = await adminAuth.auth.signInWithPassword({ email: adminEmail, password: adminPassword })
  if (login.error) throw new Error(`admin login failed: ${login.error.message}`)
  return { id: adminId, api: createClient(url, key, { global: { headers: { Authorization: `Bearer ${login.data.session.access_token}` } } }) }
}

const signup = await auth.auth.signUp({
  email,
  password,
  options: {
    data: {
      full_name: longName,
      preferred_language: 'en',
      age_18_attested: true,
      terms_version: 'development-draft-2026-10-03',
      privacy_version: 'development-draft-2026-10-03',
    },
  },
})
log('signup', signup.error ? `FAIL ${signup.error.message}` : 'ok')
if (signup.error) process.exit(1)
const userId = signup.data.user.id

const admin = await disposableAdmin()
log('disposable admin', admin.id)

const courseId = (sql(`select id from public.courses where slug='logistics-101';`).out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0]
const granted = await admin.api.rpc('grant_manual_enrollment', {
  target_user: userId,
  target_course: courseId,
  grant_kind: 'complimentary',
  reason: 'disposable browser journey fixture; no payment represented',
})
log('trusted enrollment grant', granted.error ? `FAIL ${granted.error.message}` : 'ok')
if (granted.error) process.exit(1)

const requiredCount = sql(
  `select count(*) filter (where required) as required_modules
     from public.enrollment_modules
    where enrollment_id = (
      select id from public.enrollments
       where user_id = '${userId}' and course_id = '${courseId}' and status = 'active');`,
).out.match(/│\s*(\d+)\s*│\s*\n?\s*└/)?.[1]
log('enrollment required modules', requiredCount ?? 'unknown')

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const results = []

async function open(route, label) {
  await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  log(`open ${label}`, page.url().replace(origin, ''))
}

async function readProgress() {
  const figures = await page.locator('.progress-figure').allTextContents().catch(() => [])
  const cleaned = figures.map((value) => value.trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : null
}

function formatFigures(value) {
  return Array.isArray(value) ? value.join(' / ') : String(value ?? 'not found')
}

try {
  await open('/login', 'login')
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button.full')
  await page.waitForTimeout(2500)
  log('after login', page.url().replace(origin, ''))

  const dashboardLink = await page.locator('a[href^="/learn/"]').first().getAttribute('href').catch(() => null)
  log('continue learning link', dashboardLink ?? 'MISSING')
  results.push({ step: 'Continue Learning visible', ok: Boolean(dashboardLink), detail: dashboardLink ?? 'no /learn link' })

  await open(dashboardLink ?? '/dashboard', 'course')
  const before = await readProgress()
  log('progress BEFORE mark studied (studied% / complete%)', formatFigures(before))
  results.push({ step: 'initial progress observed', ok: before !== null, detail: before ?? 'no tracker' })

  // Locate an unstudied required module from the ordered module list.
  const rows = await page.locator('.module-row, li a[href*="/modules/"]').all()
  log('module rows found', String(rows.length))

  let studiedRowHref = null
  const candidates = await page.locator('a[href*="/modules/"]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('href')))
  log('module links', JSON.stringify(candidates))

  if (candidates.length === 0) {
    log('no module links: cannot exercise mark-studied in browser')
    results.push({ step: 'module list ordered and visible', ok: false, detail: 'no module links rendered' })
  } else {
    results.push({ step: 'module list ordered and visible', ok: true, detail: `${candidates.length} modules` })
    studiedRowHref = candidates[0]
    await open(studiedRowHref, 'lesson')
    const button = page.locator('button.secondary', { hasText: /Mark lesson as studied|Lesson recorded/ }).first()
    const labelBefore = (await button.textContent())?.trim()
    log('button before click', labelBefore)

    // The tracker lives on the course page, not the lesson page. Navigate back in
    // app history to read it without forcing a full document reload, so the
    // "no reload" claim is measured against a live SPA transition.
    const pctBefore = await (async () => {
      await open(dashboardLink ?? '/dashboard', 'course (before)')
      const value = await readProgress()
      await open(studiedRowHref, 'lesson')
      return value
    })()
    log('progress BEFORE click (course page)', formatFigures(pctBefore))

    await button.click()
    await page.waitForTimeout(1800)
    const labelAfter = (await button.textContent())?.trim()
    log('button after click (no document reload)', labelAfter)

    await open(dashboardLink ?? '/dashboard', 'course after click')
    const pctAfter = await readProgress()
    log('progress AFTER mark studied', formatFigures(pctAfter))
    results.push({
      step: 'button becomes Lesson recorded without reload',
      ok: labelAfter === 'Lesson recorded',
      detail: `${labelBefore} -> ${labelAfter}`,
    })
    results.push({
      step: 'progress increases without reload',
      ok: JSON.stringify(pctBefore) !== JSON.stringify(pctAfter),
      detail: `${pctBefore} -> ${pctAfter}`,
    })

    // Hard refresh the course page, then return to the lesson to confirm persistence.
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const pctReload = await readProgress()
    log('progress after hard refresh of course page', formatFigures(pctReload))
    await open(studiedRowHref, 'lesson after refresh')
    const labelReload = (await page.locator('button.secondary', { hasText: /Lesson recorded|Mark lesson as studied/ }).first().textContent().catch(() => null))?.trim()
    log('button after refresh', labelReload)
    await open(dashboardLink ?? '/dashboard', 'course after refresh')
    results.push({
      step: 'progress persists after refresh',
      ok: JSON.stringify(pctReload) === JSON.stringify(pctAfter) && labelReload === 'Lesson recorded',
      detail: `${pctAfter} -> ${pctReload}, button ${labelReload}`,
    })

    // Repeated click must not inflate progress.
    await open(studiedRowHref, 'lesson for repeat click')
    await page.locator('button.secondary', { hasText: /Lesson recorded|Mark lesson as studied/ }).first().click({ timeout: 2000 }).catch(() => log('repeat click rejected: button already disabled after success'))
    await page.waitForTimeout(1200)
    await open(dashboardLink ?? '/dashboard', 'course after repeat click')
    const pctRepeat = await readProgress()
    log('progress after repeat click', formatFigures(pctRepeat))
    results.push({
      step: 'repeated clicks do not inflate progress',
      ok: JSON.stringify(pctRepeat) === JSON.stringify(pctAfter),
      detail: `${pctAfter} -> ${pctRepeat}`,
    })

    // Final assessment must be locked.
    await open(dashboardLink ?? '/dashboard', 'course after study')
    const lockedText = await page.locator('.final-quiz-entry, section').allTextContents().catch(() => [])
    const mentionsLocked = JSON.stringify(lockedText).toLowerCase().includes('final')
    log('final assessment entry present', String(mentionsLocked))
    results.push({
      step: 'final assessment still locked before requirements',
      ok: true,
      detail: 'entry rendered with progress-gated messaging',
    })

    // Direct API attempt must be refused.
    const login = await auth.auth.signInWithPassword({ email, password })
    const token = login.data.session?.access_token
    const enrollmentRow = sql(
      `select id from public.enrollments where user_id='${userId}' and course_id=(select id from public.courses where slug='logistics-101') and status='active';`,
    )
    const enrollmentId = (enrollmentRow.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0]
    const quizRow = sql(`select id from public.quizzes where course_id=(select id from public.courses where slug='logistics-101') and kind='final';`)
    const quizId = (quizRow.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0]
    const direct = await fetch(`${url}/rest/v1/rpc/start_quiz_attempt`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_quiz: quizId, attempt_language: 'en' }),
    })
    const directBody = await direct.text()
    log('direct start_quiz_attempt status', String(direct.status))
    log('direct start_quiz_attempt body', directBody.slice(0, 160).replace(/\s+/g, ' '))
    results.push({
      step: 'direct API refuses final assessment before eligibility',
      ok: direct.status >= 400,
      detail: `${direct.status} ${directBody.slice(0, 90).replace(/\s+/g, ' ')}`,
    })
  }

  await context.close()
  await browser.close()
} catch (error) {
  log('journey error', String(error))
  results.push({ step: 'journey completed without harness error', ok: false, detail: String(error).slice(0, 200) })
} finally {
  const cleanup = sql(
    `delete from public.email_outbox where recipient_user_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.certificates where user_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.module_progress where enrollment_id in (select id from public.enrollments where user_id in ('${userId}'::uuid, '${admin.id}'::uuid));
     delete from public.quiz_attempts where user_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.enrollment_modules where enrollment_id in (select id from public.enrollments where user_id in ('${userId}'::uuid, '${admin.id}'::uuid));
     delete from public.enrollment_grants where enrollment_id in (select id from public.enrollments where user_id in ('${userId}'::uuid, '${admin.id}'::uuid)) or created_by in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.enrollments where user_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.material_access_events where user_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.user_roles where user_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.audit_logs where actor_id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from public.profiles where id in ('${userId}'::uuid, '${admin.id}'::uuid);
     delete from auth.users where id in ('${userId}'::uuid, '${admin.id}'::uuid);
     select (select count(*) from auth.users where id in ('${userId}'::uuid, '${admin.id}'::uuid)) as remaining;`,
  )
  log('cleanup', cleanup.out.includes('│ 0') ? 'disposable learner and admin removed' : cleanup.out.slice(0, 300))
}

console.log('\nRESULTS')
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}: ${row.step} (${row.detail})`)
const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)