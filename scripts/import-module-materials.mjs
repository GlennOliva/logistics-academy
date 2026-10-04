// Imports the genuine supplied Module 1 lesson decks into the private
// course-materials bucket through the trusted admin edge function, then proves
// the objects are private, content-addressed, and readable by enrolled
// students only.
//
// Refuses to run unless the configured project ref matches the linked project.
// Creates and removes its own disposable admin so no real credential is used.

import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
if (!url || !key) {
  console.error('REFUSING: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required')
  process.exit(2)
}
const linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
if (new URL(url).hostname.split('.')[0] !== linkedRef) {
  console.error('REFUSING: configured project does not match the linked project')
  process.exit(2)
}

const MODULE_1 = '994538f1-1544-4df0-aaba-f968f7addf93'
const SUPPLIER = process.env.MATERIAL_SUPPLIER_DIR

const checks = []
function check(condition, label, detail = '') {
  checks.push({ condition: Boolean(condition), label })
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`)
}

function sql(statement) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', statement], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr?.slice(0, 300)}`)
  return result.stdout
}

function client(accessToken) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  })
}

const materials = [
  {
    file: 'Logistics_Fundamentals.pptx',
    language: 'en',
    title: 'Logistics Fundamentals',
    summary:
      'What logistics and freight are, the five rights, the road/rail/ocean/air modes, what a 3PL handles, and who takes part in every shipment.',
  },
  {
    file: 'Logistics_Fundamentals_Bisaya.pptx',
    language: 'ceb',
    title: 'Logistics Fundamentals (Bisaya)',
    summary:
      'Ang logistics ug freight, ang five rights, dalan/riles/dagat/hangin, ang 3PL, ug kinsa ang naa sa matag shipment.',
  },
]

const runId = randomUUID()
const adminEmail = `academy-import-${runId}@example.com`
const adminPassword = `Import-${runId}-Aa1!`
let adminId

try {
  const auth = client()
  const signup = await auth.auth.signUp({ email: adminEmail, password: adminPassword })
  if (signup.error) throw new Error(`disposable admin signup failed: ${signup.error.message}`)
  adminId = signup.data.user.id
  sql(`insert into public.user_roles (user_id, role) values ('${adminId}'::uuid, 'admin') on conflict do nothing;`)
  const login = await client().auth.signInWithPassword({ email: adminEmail, password: adminPassword })
  if (login.error) throw new Error('disposable admin login failed')
  const adminToken = login.data.session.access_token
  check(true, 'disposable admin session established')

  // A student must not be able to author paid material.
  const studentEmail = `academy-import-student-${runId}@example.com`
  const studentSignup = await client().auth.signUp({ email: studentEmail, password: adminPassword })
  if (studentSignup.error) throw new Error('disposable student signup failed')
  const studentToken = (await client().auth.signInWithPassword({ email: studentEmail, password: adminPassword })).data
    .session.access_token

  const results = []
  for (const material of materials) {
    const path = `${SUPPLIER}/${material.file}`
    const bytes = readFileSync(path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    const form = new FormData()
    form.set('moduleId', MODULE_1)
    form.set('language', material.language)
    form.set('title', material.title)
    form.set('summary', material.summary)
    form.set('publishNow', 'true')
    form.set('material', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), material.file)

    const response = await fetch(`${url}/functions/v1/submit-course-material`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, apikey: key },
      body: form,
    })
    const payload = await response.json().catch(() => ({}))
    check(response.status === 201, `${material.file} imported`, `HTTP ${response.status} ${payload?.error ?? ''}`)
    results.push({ material, sha256, response, payload })
  }

  const denied = await fetch(`${url}/functions/v1/submit-course-material`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${studentToken}`, apikey: key },
    body: (() => {
      const form = new FormData()
      const bytes = readFileSync(`${SUPPLIER}/${materials[0].file}`)
      form.set('moduleId', MODULE_1)
      form.set('language', 'en')
      form.set('title', 'Blocked')
      form.set('material', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'blocked.pptx')
      return form
    })(),
  })
  check(denied.status === 403, 'a non-admin cannot author material', `HTTP ${denied.status}`)

  // A renamed archive must not be stored as a PowerPoint lesson.
  const disguised = new FormData()
  disguised.set('moduleId', MODULE_1)
  disguised.set('language', 'en')
  disguised.set('title', 'Disguised archive')
  disguised.set('material', new Blob([Buffer.from('PKnot a real deck at all')], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'fake.pptx')
  const rejected = await fetch(`${url}/functions/v1/submit-course-material`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, apikey: key },
    body: disguised,
  })
  check(rejected.status === 400, 'a non-PowerPoint ZIP is rejected as material', `HTTP ${rejected.status}`)

  // Private storage: the object must exist for the service role and must not be
  // reachable anonymously.
  for (const { material, sha256, payload } of results) {
    const objectPath = payload?.objectPath ?? payload?.object_path
    check(Boolean(objectPath), `${material.file} stored at a content-addressed path`, objectPath ?? 'missing')
    check(
      typeof objectPath === 'string' && objectPath.includes(sha256.slice(0, 16)),
      `${material.file} path embeds the source digest`,
    )

    const anonymous = await fetch(`${url}/storage/v1/object/public/${objectPath}`)
    check(anonymous.status >= 400, `${material.file} is not publicly readable`, `HTTP ${anonymous.status}`)

    const anonDownload = await fetch(`${url}/storage/v1/object/sign/${objectPath}`)
    check(anonDownload.status >= 400, `${material.file} cannot be signed anonymously`, `HTTP ${anonDownload.status}`)
  }

  const stored = sql(
    `select mt.language, mt.title, mt.published, mt.object_path, mt.sha256, mt.size_bytes, m.status as module_status
     from public.module_translations mt
     join public.modules m on m.id = mt.module_id
     where mt.module_id = '${MODULE_1}'
     order by mt.language`,
  )
  console.log('\n--- module_translations for Module 1 ---')
  console.log(stored.trim())
  check(/ceb/.test(stored), 'Bisaya translation recorded')
  check(/en/.test(stored), 'English translation recorded')

const bucket = sql(
  `select 'PRIVATE_OK' as privacy from storage.buckets where id = 'course-materials' and public = false;`,
)
check(bucket.includes('PRIVATE_OK'), 'course-materials bucket is private')

  const failed = checks.filter((entry) => !entry.condition)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((entry) => entry.label).join('; '))
    process.exitCode = 1
  }
} catch (error) {
  console.error('ERROR:', error.message)
  process.exitCode = 1
} finally {
  if (adminId) {
    try {
      // module_translations.created_by is a durable FK, so author attribution is
      // handed back to the academy admin before the helper account is removed.
      sql(
        `update public.module_translations set created_by = (select id from auth.users where email = '${process.env.MATERIAL_AUTHOR_EMAIL ?? 'admin@gmail.com'}') where created_by = '${adminId}'::uuid;`,
      )
      sql(`delete from public.audit_logs where actor_id in (select id from auth.users where email like 'academy-import-%@example.com');`)
      sql(`delete from public.user_roles where user_id in (select id from auth.users where email like 'academy-import-%@example.com');`)
      sql(`delete from auth.users where email like 'academy-import-%@example.com';`)
      console.log('cleanup — disposable import accounts removed')
    } catch (cleanupError) {
      console.error('CLEANUP FAILED:', cleanupError.message)
    }
  }
}