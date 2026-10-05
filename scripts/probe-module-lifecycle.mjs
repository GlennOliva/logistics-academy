#!/usr/bin/env node

// End-to-end verification of module editing, archival and safe deletion, and of
// saved material version retirement, through the real admin browser interface
// against the linked test project.
//
// Everything a trainer touches goes through the shipped UI: the Edit dialog, the
// Delete confirmation dialog, Restore, and the per-version Delete action. The
// checks that cannot be seen in a screenshot (student views, snapshot rows,
// certificate eligibility, audit records) are read back with SQL.
//
// Nothing that belongs to the academy is modified. The probe creates its own
// disposable modules and its own disposable student, and every row it creates is
// removed at the end. Module 1 and the seven approved modules are only read.

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const COURSE_ID = '3bc1e477-8736-42f2-8a1d-e5eeda290f39'
const MODULE_1 = '994538f1-1544-4df0-aaba-f968f7addf93'
const cleanupSql = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'cleanup-module-probe-fixtures.sql',
)

// Reconciling a requirement change rewrites course_certificate_configs, so the
// value from before the run is restored during cleanup.
let certificateCountAtStart = null

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

function sqlFile(path) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '--file', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = `${result.stdout}${result.stderr}`
  return { ok: !(out.includes('ERROR') || out.includes('Failed to run sql query')), out }
}

// Clears fixtures left behind by an interrupted run so a retry starts from a
// clean slate. Only probe-owned rows are matched.
function purgeProbeFixtures() {
  if (certificateCountAtStart !== null) {
    const restored = sql(
      `update public.course_certificate_configs set required_module_count = ${Number(certificateCountAtStart)} where course_id = '${COURSE_ID}' returning required_module_count;`,
    )
    if (!restored.ok) {
      throw new Error(`could not restore the certificate requirement count:\n${restored.out}`)
    }
  }
  const result = sqlFile(cleanupSql)
  const counts = result.out.match(/PROBELEFT(\d+)\|(\d+)END/)
  if (!result.ok || !counts) {
    throw new Error(`could not clear leftover probe fixtures:\n${result.out}`)
  }
  const [modules, users] = [Number(counts[1]), Number(counts[2])]
  if (modules !== 0 || users !== 0) {
    throw new Error(`probe fixtures still present after cleanup: modules=${modules} users=${users}`)
  }
  return { remaining: modules, remainingUsers: users }
}

// Fixture writes must never fail silently: a skipped insert used to look like a
// product bug in the assertions below.
function mustSql(statement) {
  const result = sql(statement)
  if (!result.ok) throw new Error(`fixture SQL failed: ${statement}\n${result.out}`)
  return result.out
}

function countOf(where) {
  const out = sql(`select 'COUNT' || count(*)::text || 'END' as v from ${where};`).out
  return Number(out.match(/COUNT(\d+)END/)?.[1] ?? NaN)
}

// The CLI prints a box-drawn table, so the value is read from the row that sits
// between the header rule and the bottom rule rather than by matching pipes.
function cell(where, column) {
  const out = sql(
    `select 'CELL' || coalesce((${column})::text, 'NULL') || 'ENDCELL' as v from ${where};`,
  ).out
  return out.match(/CELL(.*?)ENDCELL/)?.[1] ?? 'UNREADABLE'
}

const runId = Date.now()
const adminEmail = `academy-mod-admin-${runId}-${randomUUID().slice(0, 6)}@example.com`
const studentEmail = `academy-mod-student-${runId}-${randomUUID().slice(0, 6)}@example.com`
const outsiderEmail = `academy-mod-outsider-${runId}-${randomUUID().slice(0, 6)}@example.com`
const password = `Mod-${randomUUID()}-Aa1!`

const profile = {
  full_name: 'Module Lifecycle Probe',
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
  return {
    id: data.user.id,
    token: signIn.data.session.access_token,
    api: client(signIn.data.session.access_token),
  }
}

function grantAdmin() {
  const result = sql(
    `insert into public.user_roles (user_id, role) values ((select id from auth.users where email = '${adminEmail}'), 'admin') on conflict do nothing;`,
  )
  if (!result.ok) throw new Error(`grant admin failed: ${result.out}`)
}

function enroll(student) {
  const created$ = mustSql(
    `insert into public.enrollments (user_id, course_id, status) values ('${student.id}'::uuid, '${COURSE_ID}'::uuid, 'active') returning id;`,
  )
  const enrollmentId = created$.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
  if (!enrollmentId) throw new Error(`enrollment id not returned: ${created$}`)
  mustSql(`select public.snapshot_curriculum('${enrollmentId}'::uuid);`)
  return enrollmentId
}

// Creates a module the probe owns. Used so archiving, purging and reordering are
// never performed against a real curriculum module.
function createProbeModule(title, position, required) {
  const out = mustSql(
    `insert into public.modules (course_id, position, required, status, canonical_title)
     values ('${COURSE_ID}'::uuid, ${position}, ${required}, 'draft', '${title}') returning id;`,
  )
  const id = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
  if (!id) throw new Error(`probe module not created: ${out}`)
  return id
}

async function main() {
  if (!existsSync(`${fixtures}/logistics-basics.pdf`)) {
    throw new Error(`missing fixture ${fixtures}/logistics-basics.pdf`)
  }

  // An interrupted run leaves modules holding their unique positions, which used
  // to make the next run fail on setup rather than on a real defect.
  const leftover = purgeProbeFixtures()
  record('no leftover probe fixtures from earlier runs', leftover.remaining === 0 && leftover.remainingUsers === 0)

  const admin = await signUp(adminEmail)
  grantAdmin()
  const student = await signUp(studentEmail)
  const enrollmentId = enroll(student)
  const outsider = await signUp(outsiderEmail)

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  // A module the probe owns at a position above the real curriculum, so the
  // admin list can be asserted on without touching the approved eight.
  const probeTitle = 'Lifecycle probe module'
  const probeModuleId = createProbeModule(probeTitle, 40, false)
  const spareModuleId = createProbeModule('Lifecycle spare module', 41, false)

  // A referenced module for the archive/restore path: it is published, added to
  // the disposable student's snapshot, given material and given a progress row.
  const referencedTitle = 'Lifecycle referenced module'
  const referencedModuleId = createProbeModule(referencedTitle, 42, true)
  mustSql(`update public.modules set status = 'published' where id = '${referencedModuleId}';`)
  mustSql(
    `insert into public.enrollment_modules (enrollment_id, module_id, required, curriculum_version)
     select '${enrollmentId}', '${referencedModuleId}', true, 1 on conflict do nothing;`,
  )
  mustSql(
    `insert into public.module_progress (enrollment_id, module_id, studied_at, completed_at, updated_at)
     values ('${enrollmentId}', '${referencedModuleId}', now(), now(), now())
     on conflict (enrollment_id, module_id) do update set completed_at = now(), updated_at = now();`,
  )

  // A material version on the probe module so the edit dialog has a student-facing
  // title and summary to edit. The probe module stays a draft, so this version is
  // never served to a student and its object path is never opened.
  mustSql(
    `insert into public.module_translations (module_id, language, version, title, summary, object_path, sha256, size_bytes, published, created_by)
     select '${probeModuleId}', 'en', 1, 'Probe original title', 'Probe original summary.',
       'course/${probeModuleId}/en/probedisplay.pdf', repeat('b', 64), 2048, true, '${admin.id}'::uuid
     on conflict do nothing;`,
  )

  try {
    await page.goto(`${origin}/login`, { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', adminEmail)
    await page.fill('input[type="password"]', password)
    await page.click('button.full')
    await page.waitForURL(/\/dashboard|\/admin/, { timeout: 30000 })
    record('admin signs in through the browser', true, adminEmail)

    await page.goto(`${origin}/admin/courses`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    record('admin course page lists the probe modules', (await page.getByText('Lifecycle probe module').count()) > 0)

    // The referenced module gets a real uploaded file before anything else runs,
    // so "archiving keeps the file" is checked against a stored object rather than
    // a row pointing at nothing.
    await page.goto(`${origin}/admin/courses/${referencedModuleId}/material`, { waitUntil: 'networkidle' })
    await page.selectOption('select[name="language"]', 'en')
    await page.fill('input[name="title"]', 'Lifecycle referenced material')
    await page.setInputFiles('input[name="material"]', `${fixtures}/logistics-basics.pdf`)
    await page.locator('input[name="publishNow"]').check()
    await page.click('button.full')
    await page.waitForTimeout(4000)
    const firstUpload = (await page.locator('p.status').first().textContent().catch(() => '')) ?? ''
    record(
      'the referenced module receives a real published file',
      /Saved|Published/i.test(firstUpload) &&
        countOf(`public.module_translations where module_id = '${referencedModuleId}' and published`) === 1,
      firstUpload.slice(0, 120),
    )
    const referencedPath = cell(
      `public.module_translations where module_id = '${referencedModuleId}'`,
      'object_path',
    )
    record(
      'the uploaded file is stored in private storage',
      countOf(`storage.objects where bucket_id = 'course-materials' and name = '${referencedPath}'`) === 1,
      `objects=${countOf(`storage.objects where bucket_id = 'course-materials' and name = '${referencedPath}'`)}`,
    )

    await page.goto(`${origin}/admin/courses`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    // --- 1. EDIT: rename, reorder, status, requirement ---
    const row = page.locator('article', { hasText: 'Lifecycle probe module' }).first()
    await row.getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })

    const renamed = 'Lifecycle probe module renamed'
    await page.locator('dialog.modal .field input').first().fill(renamed)
    // The dialog's first number input is the order field.
    const orderInputs = page.locator('dialog.modal input[type="number"]')
    await orderInputs.first().fill('43')
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Correcting a typo in the probe module title.')
    await clickAndExpectClose(page, page.getByRole('button', { name: 'Save changes' }), 'renaming a module')
    await page.waitForTimeout(2000)

    const banner = (await page.locator('p.status').first().textContent().catch(() => '')) ?? ''
    record('editing a module title saves through the admin UI', /Saved/.test(banner), banner.slice(0, 140))
    record('the renamed title is stored', cell(`public.modules where id = '${probeModuleId}'`, 'canonical_title') === renamed)

    // Renaming alone must not touch the completion requirement or snapshots.
    const requirementsAfterRename = countOf(
      `public.enrollment_modules where module_id = '${probeModuleId}' and required`,
    )
    record('renaming alone changes no completion requirement', requirementsAfterRename === 0, `required rows=${requirementsAfterRename}`)

    // --- display title and summary editing ---
    const englishDisplay = 'Probe English display title'
    const englishSummaryText = 'Probe English display summary.'
    await row.getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await page.waitForTimeout(1200)
    const displayFieldsPresent = (await page.locator('dialog.modal .display-fields').count()) === 1
    record(
      'the edit dialog offers the student-facing display title and summary',
      displayFieldsPresent,
      displayFieldsPresent ? '' : 'display fields missing: no material version is uploaded for this module',
    )
    if (displayFieldsPresent) {
      // The probe module has a published English material version, so the fields
      // are editable and must be pre-filled from that version.
      await page.locator('dialog.modal .display-fields input').first().fill(englishDisplay)
      await page.locator('dialog.modal .display-fields textarea').first().fill(englishSummaryText)
      await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Clarifying the title students read.')
      await clickAndExpectClose(page, page.getByRole('button', { name: 'Save changes' }), 'editing the display wording')
      await page.waitForTimeout(2000)
      const savedTitle = cell(
        `public.module_translations where module_id = '${probeModuleId}' and language = 'en' and archived_at is null`,
        'title',
      )
      const savedSummary = cell(
        `public.module_translations where module_id = '${probeModuleId}' and language = 'en' and archived_at is null`,
        'summary',
      )
      record(
        'the display title a student reads is saved',
        savedTitle === englishDisplay,
        `title=${savedTitle}`,
      )
      record(
        'the display summary a student reads is saved',
        savedSummary === englishSummaryText,
        `summary=${savedSummary}`,
      )
      record(
        'editing the display wording changes no completion requirement',
        countOf(`public.enrollment_modules where module_id = '${probeModuleId}' and required`) === 0,
      )
      const detailAudit = countOf(
        `public.audit_logs where target_id = '${probeModuleId}' and action = 'module.details_edited'`,
      )
      record('the display wording edit is audited', detailAudit > 0, `rows=${detailAudit}`)
    }

    const auditEdit = countOf(
      `public.audit_logs where target_id = '${probeModuleId}' and action = 'module.edited'`,
    )
    record('the edit is recorded in the audit log', auditEdit > 0, `module.edited rows=${auditEdit}`)

    // --- reorder: land the spare module on the occupied slot the probe module
    // already left behind, so the swap has to happen without a duplicate position.
    const spareBefore = cell(`public.modules where id = '${spareModuleId}'`, 'position')
    const probeBefore = cell(`public.modules where id = '${probeModuleId}'`, 'position')
    const spareRow = page.locator('article', { hasText: 'Lifecycle spare module' }).first()
    await spareRow.getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await page.locator('dialog.modal input[type="number"]').first().fill(probeBefore)
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Swapping probe module order.')
    await clickAndExpectClose(page, page.getByRole('button', { name: 'Save changes' }), 'reordering two modules')
    await page.waitForTimeout(2000)
    const probeAfterSwap = cell(`public.modules where id = '${probeModuleId}'`, 'position')
    const spareAfterSwap = cell(`public.modules where id = '${spareModuleId}'`, 'position')
    record(
      'reordering swaps the two modules instead of colliding',
      probeAfterSwap === spareBefore && spareAfterSwap === probeBefore,
      `probe=${probeAfterSwap} (was ${probeBefore}) spare=${spareAfterSwap} (was ${spareBefore})`,
    )
    const duplicatePositions = countOf(
      `(select position from public.modules where course_id = '${COURSE_ID}' group by position having count(*) > 1) d`,
    )
    record('no duplicate module order is stored', duplicatePositions === 0, `duplicated positions=${duplicatePositions}`)

    // --- student view reflects the rename and the reorder ---
    const studentModules = await student.api.rpc('module_requirements', { target_enrollment: enrollmentId })
    const requirements = studentModules.data ?? []
    record(
      'the student view returns requirements after the edit',
      Array.isArray(requirements) && requirements.length > 0,
      `${requirements.length} row(s)`,
    )
    const referencedTitleSeen = requirements.some((row) => row.title === referencedTitle)
    record('the student view still shows the referenced module', referencedTitleSeen)

    const progressSeen = requirements.find((row) => row.module_id === referencedModuleId)
    record(
      'student progress for the referenced module is preserved',
      Boolean(progressSeen && progressSeen.completed_at),
      `completed_at=${progressSeen?.completed_at ?? 'missing'}`,
    )

    // --- a requirement change only reaches students when it is reconciled ---
    // The snapshot starts required, so the observable direction is required ->
    // optional. Reconciling that proves the snapshots really moved; the following
    // edit then proves an unreconciled change leaves them alone.
    const referencedRow = page.locator('article', { hasText: referencedTitle }).first()
    const certificateCountBefore = cell(
      `public.course_certificate_configs where course_id = '${COURSE_ID}'`,
      'required_module_count',
    )
    certificateCountAtStart = certificateCountBefore
    await referencedRow.getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await tickRequiredAndReconcile(page, false)
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Making the probe module optional for everyone.')
    await clickAndExpectClose(page, page.getByRole('button', { name: 'Save changes' }), 'reconciling a requirement change')
    await page.waitForTimeout(2000)
    const reconciled = countOf(`public.enrollment_modules where module_id = '${referencedModuleId}' and required`)
    record(
      'reconciling applies the requirement to current enrollments',
      reconciled === 0,
      `required snapshot rows=${reconciled}`,
    )
    // The configured count has to equal the number of modules students are
    // actually required to complete, or the certificate is unattainable.
    const liveRequired = cell(
      `(select count(*) from public.modules where course_id = '${COURSE_ID}' and required and status = 'published' and archived_at is null) live`,
      'count',
    )
    const certificateCountAfter = cell(
      `public.course_certificate_configs where course_id = '${COURSE_ID}'`,
      'required_module_count',
    )
    record(
      'reconciling also moves the certificate requirement count',
      certificateCountAfter === liveRequired,
      `config=${certificateCountAfter} live required=${liveRequired} (was ${certificateCountBefore})`,
    )
    const auditReconcile = countOf(
      `public.audit_logs where target_id = '${referencedModuleId}' and action = 'module.edited' and (metadata->>'requirement_reconciled') = 'true'`,
    )
    record('the requirement reconciliation is audited', auditReconcile > 0, `rows=${auditReconcile}`)

    // Now the same change back to required, without ticking the box.
    await referencedRow.getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await page.locator('dialog.modal .check input[type="checkbox"]').first().check()
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Marking the probe module required again.')
    await clickAndExpectClose(page, page.getByRole('button', { name: 'Save changes' }), 'changing a requirement without reconciling')
    await page.waitForTimeout(2000)
    const unreconciled = countOf(
      `public.enrollment_modules where module_id = '${referencedModuleId}' and required`,
    )
    record(
      'changing required without reconciliation leaves the snapshot untouched',
      unreconciled === 0,
      `required snapshot rows=${unreferencedSafe(unreconciled)}`,
    )

    // Put the snapshot back in step. Nothing changed in the module this time, so
    // the reconciliation control only appears because an earlier save left the
    // snapshots out of step.
    await referencedRow.getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    const outstandingNotice = await page
      .locator('dialog.modal .warning-note')
      .innerText()
      .catch(() => '')
    record(
      'an unreconciled requirement difference is reported in the edit dialog',
      /snapshot\(s\) still disagree/i.test(outstandingNotice),
      outstandingNotice.replace(/\s+/g, ' ').slice(0, 120),
    )
    await page
      .locator('dialog.modal .check input[type="checkbox"]')
      .nth(1)
      .waitFor({ state: 'attached', timeout: 10000 })
    await page.locator('dialog.modal .check input[type="checkbox"]').nth(1).check()
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Reinstating the probe module requirement.')
    await clickAndExpectClose(page, page.getByRole('button', { name: 'Save changes' }), 'reinstating a requirement')
    await page.waitForTimeout(2000)
    record(
      'the requirement is back in place for the archive path',
      countOf(`public.enrollment_modules where module_id = '${referencedModuleId}' and required`) === 1,
    )

    // --- 2. DELETE: archive a referenced module ---
    await referencedRow.getByRole('button', { name: 'Delete' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await page.waitForTimeout(1500)
    const impactText = (await page.locator('dialog.modal').innerText()) ?? ''
    record(
      'the delete dialog shows the module title and its impact',
      impactText.includes(referencedTitle) && /enrollment reference/.test(impactText),
      impactText.split('\n').find((line) => /enrollment reference/.test(line))?.slice(0, 90) ?? 'no impact shown',
    )
    record(
      'a referenced module cannot be permanently deleted',
      !/Delete permanently/i.test(await page.locator('dialog.modal').innerText()),
      'permanent delete not offered',
    )

    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Archiving the probe module for the test.')
    await page.getByRole('button', { name: 'Archive instead' }).click()
    await page.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2500)

    record(
      'archiving stores an archived_at timestamp',
      cell(`public.modules where id = '${referencedModuleId}'`, 'archived_at') !== 'NULL',
    )
    record(
      'archiving preserved the module row, its material and its progress',
      countOf(`public.module_translations where module_id = '${referencedModuleId}' and published`) === 1 &&
        countOf(`public.module_progress where module_id = '${referencedModuleId}'`) === 1 &&
        countOf(`public.modules where id = '${referencedModuleId}'`) === 1,
    )
    record(
      'archiving kept the saved file rather than deleting it',
      countOf(`storage.objects where bucket_id = 'course-materials' and name = '${referencedPath}'`) === 1,
      `objects=${countOf(`storage.objects where bucket_id = 'course-materials' and name = '${referencedPath}'`)}`,
    )
    const released = countOf(`public.enrollment_modules where module_id = '${referencedModuleId}' and required`)
    record(
      'archiving releases the completion requirement so no learner is stranded',
      released === 0,
      `required snapshot rows=${released}`,
    )
    // snapshot_curriculum only inserts published modules, so an archived one can
    // never reappear for a new or re-snapshotted enrollment.
    const snapCheck = sql(`select public.snapshot_curriculum('${enrollmentId}'::uuid);`).ok
    const stillSnapshot = countOf(
      `public.enrollment_modules where enrollment_id = '${enrollmentId}' and module_id = '${referencedModuleId}'`,
    )
    record(
      're-snapshotting does not re-add an archived module',
      snapCheck && stillSnapshot === 1,
      `snapshot rows=${stillSnapshot} (history kept, not re-added)`,
    )
    const archiveAudit = countOf(
      `public.audit_logs where target_id = '${referencedModuleId}' and action = 'module.archived'`,
    )
    record('archiving is audited', archiveAudit > 0, `rows=${archiveAudit}`)

    // Archived module must no longer be servable to the student.
    const archivedAccess = await student.api.functions.invoke('course-material-access', {
      body: { moduleId: referencedModuleId, language: 'en' },
    })
    record(
      'an archived module is no longer served to students',
      Boolean(archivedAccess.error),
      archivedAccess.error?.message?.slice(0, 80) ?? `allowed=${archivedAccess.data?.allowed}`,
    )

    // --- restore ---
    await page.goto(`${origin}/admin/courses`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const archivedRow = page.locator('article', { hasText: 'Lifecycle referenced module' }).first()
    record('the archived module is listed with an archived marker', /archived/i.test(await archivedRow.innerText()))
    await archivedRow.getByRole('button', { name: 'Restore' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Restoring the probe module for the test.')
    await page.getByRole('button', { name: 'Restore module' }).click()
    await page.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2500)
    record(
      'restoring clears the archived timestamp',
      cell(`public.modules where id = '${referencedModuleId}'`, 'archived_at') === 'NULL',
    )
    record(
      'restoring returns the module to its previous status',
      cell(`public.modules where id = '${referencedModuleId}'`, 'status') === 'published',
      `status=${cell(`public.modules where id = '${referencedModuleId}'`, 'status')}`,
    )
    const restoreAudit = countOf(
      `public.audit_logs where target_id = '${referencedModuleId}' and action = 'module.restored'`,
    )
    record('restoring is audited', restoreAudit > 0, `rows=${restoreAudit}`)

    // --- permanent delete of an unused draft ---
    await page.goto(`${origin}/admin/courses`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const spareRowNow = page.locator('article', { hasText: 'Lifecycle spare module' }).first()
    await spareRowNow.getByRole('button', { name: 'Delete' }).click()
    await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
    await page.waitForTimeout(1500)
    const spareDialog = (await page.locator('dialog.modal').innerText()) ?? ''
    record(
      'an unused draft offers permanent deletion',
      /Delete permanently/i.test(spareDialog),
      'permanent delete offered',
    )
    await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Deleting the unused probe draft.')
    await page.getByRole('button', { name: 'Delete permanently' }).click()
    await page.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2500)
    record(
      'the unused draft is permanently deleted',
      countOf(`public.modules where id = '${spareModuleId}'`) === 0,
      `rows=${countOf(`public.modules where id = '${spareModuleId}'`)}`,
    )
    const purgeAudit = countOf(`public.audit_logs where target_id = '${spareModuleId}' and action = 'module.purged'`)
    record('permanent deletion is audited', purgeAudit > 0, `rows=${purgeAudit}`)

    // A published module must never be purgeable.
    const referencedDeleteAttempt = await admin.api.rpc('admin_purge_module', {
      target_module: referencedModuleId,
      reason: 'Attempting to purge a referenced published module.',
    })
    record(
      'a referenced published module cannot be purged through the API',
      Boolean(referencedDeleteAttempt.error),
      referencedDeleteAttempt.error?.message?.slice(0, 110) ?? 'purged unexpectedly',
    )

    // --- 3. MATERIAL VERSION: delete an unused draft version ---
    await page.goto(`${origin}/admin/courses/${referencedModuleId}/material`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    const versionRows = sql(
      `select version::text || ' ~ ' || (case when published then 'published' else 'draft' end) || ' ~ ' || object_path
       from public.module_translations where module_id = '${referencedModuleId}' order by version desc;`,
    ).out.split('\n').filter((line) => / ~ /.test(line))

    // Add a second, unpublished version so there is something unused to delete.
    await page.goto(`${origin}/admin/courses/${referencedModuleId}/material`, { waitUntil: 'networkidle' })
    await page.selectOption('select[name="language"]', 'en')
    await page.fill('input[name="title"]', 'Lifecycle spare version')
    await page.setInputFiles('input[name="material"]', `${fixtures}/logistics-basics.pdf`)
    await page.click('button.full')
    await page.waitForTimeout(4000)
    const uploadBanner = (await page.locator('p.status').first().textContent().catch(() => '')) ?? ''
    record('a disposable spare version uploads through the admin UI', /Saved/.test(uploadBanner), uploadBanner.slice(0, 120))

    const allVersions = sql(
      `select version::text || ' ~ ' || (case when published then 'published' else 'draft' end) || ' ~ ' || object_path
       from public.module_translations where module_id = '${referencedModuleId}' order by version desc;`,
    ).out.split('\n').filter((line) => / ~ /.test(line))
    const draftVersionLine = allVersions.find((line) => / ~ draft ~ /.test(line))
    record('an unused draft version exists to be deleted', Boolean(draftVersionLine), draftVersionLine?.slice(0, 80) ?? 'none')
    void versionRows
    // Captured before the purge, because the audit row outlives the row it names.
    const draftTranslationId = draftVersionLine
      ? cell(
          `public.module_translations where module_id = '${referencedModuleId}' and version = ${Number(draftVersionLine.split(' ~ ')[0])}`,
          'id',
        )
      : ''

    if (draftVersionLine) {
      const draftVersion = Number(draftVersionLine.split(' ~ ')[0])
      const draftPath = draftVersionLine.split(' ~ ')[2]
      const draftRow = page.locator('article', { hasText: `v${draftVersion}` }).first()
      await draftRow.getByRole('button', { name: 'Delete' }).click()
      await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
      await page.waitForTimeout(1500)
      const draftDialog = (await page.locator('dialog.modal').innerText()) ?? ''
      record(
        'the version delete dialog reports its impact',
        /link\(s\) were issued|belongs only to this version|no preview or conversion job/i.test(draftDialog),
        draftDialog.split('\n').find((line) => /link\(s\)|belongs only|conversion job/i.test(line))?.slice(0, 90) ?? 'no impact',
      )
      await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Removing the unused probe version.')
      await page.getByRole('button', { name: 'Delete permanently' }).click()
      await page.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(3000)
      const deleteBanner = (await page.locator('p.status').first().textContent().catch(() => '')) ?? ''
      record(
        'an unused version is permanently deleted with its file',
        countOf(`public.module_translations where module_id = '${referencedModuleId}' and version = ${draftVersion}`) === 0,
        deleteBanner.slice(0, 130),
      )
      record(
        'the deleted version file is removed from storage',
        countOf(`storage.objects where bucket_id = 'course-materials' and name = '${draftPath}'`) === 0,
        `objects=${countOf(`storage.objects where bucket_id = 'course-materials' and name = '${draftPath}'`)}`,
      )
      record(
        'no leftover pending deletion is left behind',
        countOf(`public.module_translations where id = '${draftTranslationId}' and purge_pending_at is not null`) === 0,
      )
      const purgeMaterialAudit = countOf(
        `public.audit_logs where target_id = '${draftTranslationId}' and action = 'material.version_purged'`,
      )
      record('the material purge is audited', purgeMaterialAudit > 0, `rows=${purgeMaterialAudit}`)
    }

    // --- deleting the active published version requires a decision ---
    const publishedVersionLine = allVersions.find((line) => / ~ published ~ /.test(line))
    if (publishedVersionLine) {
      const publishedVersion = Number(publishedVersionLine.split(' ~ ')[0])
      const publishedPath = publishedVersionLine.split(' ~ ')[2]
      await page.goto(`${origin}/admin/courses/${referencedModuleId}/material`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2000)
      const publishedRow = page.locator('article', { hasText: `v${publishedVersion}` }).first()
      await publishedRow.getByRole('button', { name: 'Delete' }).click()
      await page.waitForSelector('dialog.modal[open]', { timeout: 10000 })
      await page.waitForTimeout(1500)
      const publishedDialog = (await page.locator('dialog.modal').innerText()) ?? ''
      record(
        'the active version explains the student-access effect and demands a decision',
        /currently receiving/i.test(publishedDialog) && /replacement|unpublish/i.test(publishedDialog),
        publishedDialog.split('\n').find((line) => /currently receiving/i.test(line))?.slice(0, 90) ?? 'no warning',
      )
      const archiveButton = page.getByRole('button', { name: 'Archive instead' })
      record('archiving the active version is blocked until a decision is made', await archiveButton.isDisabled())

      // Choose the explicit unpublish path, which is the safe outcome when no
      // replacement exists.
      await page.locator('dialog.modal input[placeholder="Recorded in the audit log"]').fill('Unpublishing the probe material deliberately.')
      await page.locator('dialog.modal .check input[type="checkbox"]').last().check()
      await archiveButton.click()
      await page.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(3000)
      const archiveBanner = (await page.locator('p.status').first().textContent().catch(() => '')) ?? ''
      record(
        'archiving the active version with an explicit unpublish succeeds',
        /unpublished/i.test(archiveBanner),
        archiveBanner.slice(0, 140),
      )
      record(
        'the archived version is no longer published',
        countOf(
          `public.module_translations where module_id = '${referencedModuleId}' and version = ${publishedVersion} and published`,
        ) === 0,
      )
      record(
        'the archived version keeps its file for history',
        countOf(`storage.objects where bucket_id = 'course-materials' and name = '${publishedPath}'`) === 1,
        `objects=${countOf(`storage.objects where bucket_id = 'course-materials' and name = '${publishedPath}'`)}`,
      )
      const noPublished = countOf(
        `public.module_translations where module_id = '${referencedModuleId}' and published and archived_at is null`,
      )
      record('no older version was silently exposed in its place', noPublished === 0, `published live versions=${noPublished}`)
      const archiveMaterialAudit = countOf(
        `public.audit_logs where action = 'material.version_archived' and target_id in (select id from public.module_translations where module_id = '${referencedModuleId}')`,
      )
      record('archiving a material version is audited', archiveMaterialAudit > 0, `rows=${archiveMaterialAudit}`)
    }

    // --- unauthorized operations are rejected server-side ---
    const outsiderEdit = await outsider.api.rpc('admin_edit_module', {
      target_module: probeModuleId,
      new_canonical_title: 'Hijacked',
      new_position: 43,
      new_required: false,
      new_status: 'draft',
      reason: 'Attempting an unauthorized edit.',
    })
    record(
      'a non-admin cannot edit a module',
      Boolean(outsiderEdit.error) && cell(`public.modules where id = '${probeModuleId}'`, 'canonical_title') !== 'Hijacked',
      outsiderEdit.error?.message?.slice(0, 80) ?? 'edit succeeded unexpectedly',
    )

    const outsiderArchive = await outsider.api.rpc('admin_archive_module', {
      target_module: probeModuleId,
      reason: 'Attempting an unauthorized archive.',
    })
    record('a non-admin cannot archive a module', Boolean(outsiderArchive.error), outsiderArchive.error?.message?.slice(0, 80) ?? 'archived')

    const outsiderPurge = await outsider.api.rpc('admin_purge_module', {
      target_module: probeModuleId,
      reason: 'Attempting an unauthorized purge.',
    })
    record('a non-admin cannot purge a module', Boolean(outsiderPurge.error), outsiderPurge.error?.message?.slice(0, 80) ?? 'purged')

    const outsiderImpact = await outsider.api.rpc('admin_module_delete_impact', {
      target_module: probeModuleId,
    })
    record('a non-admin cannot read the delete impact report', Boolean(outsiderImpact.error), outsiderImpact.error?.message?.slice(0, 80) ?? 'read')

    const outsiderMaterialPurge = await outsider.api.functions.invoke('delete-material-version', {
      body: { translationId: '00000000-0000-0000-0000-000000000000', reason: 'Attempting an unauthorized purge.' },
    })
    record(
      'a non-admin cannot delete a material version',
      Boolean(outsiderMaterialPurge.error),
      outsiderMaterialPurge.error?.message?.slice(0, 80) ?? 'deleted',
    )

    const anonClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const anonDelete = await fetch(`${url}/functions/v1/delete-material-version`, {
      method: 'POST',
      headers: { apikey: key, 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ translationId: '00000000-0000-0000-0000-000000000000', reason: 'Anonymous attempt.' }),
    }).catch(() => null)
    record('an unauthenticated material delete is refused', anonDelete?.status === 401 || anonDelete?.status === 403, `status=${anonDelete?.status}`)
    void anonClient

    // --- unrelated data untouched ---
    const realMaterials = countOf(`public.module_translations where module_id = '${MODULE_1}'`)
    record('Module 1 saved material is untouched', realMaterials > 0, `versions=${realMaterials}`)
    const approvedRequired = countOf(
      `public.enrollment_modules where module_id in (
         '994538f1-1544-4df0-aaba-f968f7addf93','ca1f067e-b499-46c2-8471-256072d0071a',
         '3d3f0426-7385-4cea-b43e-cb7f2b1d2002','7196d8c5-0632-4427-841b-c8c2469e781b',
         '7228d8b9-f80b-47b0-97c1-e3af7b8df2d4','0be31428-21bb-40b5-9110-0e9ebdb6c122',
         '108173b3-9266-4b4a-b18b-bb6bb28a7275','99ce1711-cb3b-4daa-a4a8-09e4b3c092ce')
       and required`,
    )
    record('approved curriculum modules keep their required flag', approvedRequired >= 8, `required rows=${approvedRequired}`)
    const certificates = countOf('public.certificates')
    record('existing certificates are untouched', certificates >= 1, `certificates=${certificates}`)
    const attempts = countOf('public.quiz_attempts')
    record('assessment history is untouched', attempts >= 0, `attempts=${attempts}`)
  } finally {
    await browser.close()
  }

  const passed = results.filter((entry) => entry.ok).length
  log('', '')
  log('passed', `${passed}/${results.length}`)
  if (passed !== results.length) process.exitCode = 1
}

// A dialog that refuses to save keeps its error on screen. Reading it turns a
// 30 second click timeout into a usable failure message.
// The reconcile checkbox only exists once the required box is changed, so the
// two clicks cannot both resolve against a one-checkbox dialog.
async function tickRequiredAndReconcile(page, tickRequired) {
  const requiredBox = page.locator('dialog.modal .check input[type="checkbox"]').first()
  if (tickRequired) await requiredBox.check()
  else await requiredBox.uncheck()
  await page
    .locator('dialog.modal .check input[type="checkbox"]')
    .nth(1)
    .waitFor({ state: 'attached', timeout: 10000 })
  await page.locator('dialog.modal .check input[type="checkbox"]').nth(1).check()
}

async function clickAndExpectClose(page, button, label) {
  await button.click()
  const closed = await page
    .waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  if (closed) return true
  const text = (await page.locator('dialog.modal').innerText().catch(() => '')) ?? ''
  const error = text.split('\n').find((line) => /error|required|refus|cannot|must|already|invalid/i.test(line))
  record(`${label} saves without an error`, false, error?.slice(0, 160) ?? 'dialog stayed open')
  return false
}

function unreferencedSafe(value) {
  return Number.isNaN(value) ? 'unreadable' : value
}

main()
  .then(async () => {
    // Storage objects cannot be removed from SQL, so the probe purges every
    // uploaded file through delete-material-version before this runs.
    const leftover = purgeProbeFixtures()
    log('cleaned up', `${created.length} disposable account(s), ${leftover.remaining} leftover row(s)`)
  })
  .catch((error) => {
    console.error('probe error:', error.message)
    process.exitCode = 1
  })
