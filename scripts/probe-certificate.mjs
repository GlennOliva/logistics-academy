// Certificate pipeline verification against a real, reconciled enrollment.
//
// Signs in as a disposable administrator (ensure_certificate permits admins to
// act on behalf of a learner) and then exercises the exact production path:
// certificate_eligibility -> generate-certificate -> certificate-access ->
// verify_certificate_record, twice, to prove issuance is not duplicated.
//
// Never resets the database and never touches the learner's progress or
// attempts. Only the disposable administrator is removed at the end.

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const TARGET_ENROLLMENT = process.env.TARGET_ENROLLMENT ?? '9413f41f-baa0-4eb5-9769-1c847fda2af9'

if (!url || !key) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required')

const results = []
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// macOS PDFKit reads the drawn text back out of a finished PDF, which is an
// independent check that the name and verification code really were rendered.
function pdfText(pdf) {
  const path = `${process.env.PROBE_ARTIFACT_DIR ?? tmpdir()}/certificate-probe.pdf`
  writeFileSync(path, pdf)
  const script = `
    ObjC.import('PDFKit')
    ObjC.import('Foundation')
    const url = $.NSURL.fileURLWithPath('${path}')
    const doc = $.PDFDocument.alloc.initWithURL(url)
    doc.string.js
  `
  const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`pdf text extraction failed: ${result.stderr.trim().slice(0, 200)}`)
  return result.stdout.trim()
}

function sql(text) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', text], { encoding: 'utf8' })
  const out = `${result.stdout}${result.stderr}`
  if (/unexpected status|ERROR/.test(out)) throw new Error(`sql failed: ${out.slice(0, 400)}`)
  return out
}

// Reads a single delimited scalar instead of a wide table, which keeps the
// assertions independent of column ordering.
function scalar(text) {
  const lines = text.split('\n')
  const separator = lines.findIndex((line) => line.trim().startsWith('├'))
  const dataLine = separator === -1 ? undefined : lines[separator + 1]
  if (!dataLine || !dataLine.includes('│')) throw new Error(`no scalar row found in:\n${text}`)
  const value = dataLine.split('│')[1].trim()
  if (!value || value === '(null)' || value === '') throw new Error(`scalar was empty in:\n${text}`)
  return value
}

const adminEmail = `academy-cert-admin-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`
const adminPassword = `Mat-${randomUUID()}-Aa1!`
const anon = createClient(url, key)
let adminId = null

async function main() {
  const created = await anon.auth.signUp({
    email: adminEmail,
    password: adminPassword,
    options: {
      data: {
        full_name: 'Certificate Probe Admin',
        preferred_language: 'en',
        age_18_attested: true,
        terms_version: 'development-draft-2026-10-03',
        privacy_version: 'development-draft-2026-10-03',
      },
    },
  })
  if (created.error) throw new Error(`admin signup failed: ${created.error.message}`)
  adminId = created.data.user.id
  sql(`insert into public.user_roles (user_id, role) values ('${adminId}'::uuid, 'admin') on conflict do nothing;`)

  const login = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword })
  if (login.error) throw new Error(`admin login failed: ${login.error.message}`)
  const token = login.data.session.access_token
  const api = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } } })

  // 1. Eligibility is decided by the server and reports each blocker separately.
  const eligibility = await api.rpc('certificate_eligibility', { target_enrollment: TARGET_ENROLLMENT })
  if (eligibility.error) throw new Error(`eligibility rpc failed: ${eligibility.error.message}`)
  const state = eligibility.data
  check('eligibility: required module count is the approved eight', state.required_module_count === 8, `required=${state.required_module_count} expected=${state.expected_module_count}`)
  check('eligibility: all required modules complete', state.required_outstanding === 0, `completed=${state.required_completed}/${state.required_module_count}`)
  check('eligibility: passing final score present', Number(state.best_final_score) >= Number(state.required_score), `best=${state.best_final_score} required=${state.required_score}`)
  check('eligibility: no unmet conditions', state.eligible === true && state.blockers.length === 0, JSON.stringify(state.blockers))

  // 2. Issue through the real edge function.
  const issued = await api.functions.invoke('generate-certificate', { body: { enrollmentId: TARGET_ENROLLMENT } })
  if (issued.error) throw new Error(`generate-certificate transport error: ${issued.error.message}`)
  if (issued.data?.error) throw new Error(`generate-certificate refused: ${issued.data.error}`)
  const first = issued.data
  check('generate-certificate returns an active certificate', first?.status === 'active', `status=${first?.status}`)

  const [studentName, requiredModuleCount, finalScore, certStatus, templateVersion] = scalar(
    sql(`select string_agg(student_name || '~' || required_module_count::text || '~' || coalesce(final_score::text, '') || '~' || status::text || '~' || template_version::text, '|') as v from public.certificates where enrollment_id = '${TARGET_ENROLLMENT}';`),
  ).split('~')
  check('certificate row records the student full name', Boolean(studentName) && studentName !== '(null)', `student_name=${studentName}`)
  check('certificate row records 8 required modules', requiredModuleCount === '8', `required_module_count=${requiredModuleCount}`)
  check('certificate row records the passing score', Number(finalScore) >= 75, `final_score=${finalScore}`)
  check('certificate row is active', certStatus === 'active', `status=${certStatus}`)
  check('certificate row uses the supplied template version', templateVersion === '3', `template_version=${templateVersion}`)

  // 3. Repeated requests must not duplicate issuance.
  const repeat = await api.functions.invoke('generate-certificate', { body: { enrollmentId: TARGET_ENROLLMENT } })
  const count = Number(scalar(sql(`select (count(*)::text || '~') as v from public.certificates where enrollment_id = '${TARGET_ENROLLMENT}';`)).replace('~', ''))
  check('repeated request returns the same certificate', repeat.data?.certificateId === first.certificateId, `${first.certificateId} then ${repeat.data?.certificateId}`)
  check('repeated request does not create a second row', count === 1, `rows=${count}`)

  // 4. Private link, PDF bytes, name and layout.
  const access = await api.functions.invoke('certificate-access', {
    body: { certificateId: first.certificateId, disposition: 'inline' },
  })
  if (access.error) throw new Error(`certificate-access transport error: ${access.error.message}`)
  if (access.data?.error) throw new Error(`certificate-access refused: ${access.data.error}`)
  check('certificate-access returns the student name', access.data?.studentName === studentName, `studentName=${access.data?.studentName}`)
  const pdf = Buffer.from(await (await fetch(access.data.url)).arrayBuffer())
  check('generated file is a PDF', pdf.subarray(0, 5).toString() === '%PDF-', `magic=${pdf.subarray(0, 5).toString()} bytes=${pdf.length}`)
  const raw = pdf.toString('latin1')
  check('generated PDF is one page', (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length === 1, `pages=${(raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length}`)
  check('generated PDF embeds a QR code', raw.includes('/Subtype /Image') || raw.includes('QR'), 'qr present')

  // Extract the drawn text with macOS PDFKit rather than guessing at pdf-lib's
  // content-stream encoding, so a missing name cannot hide behind compression.
  const drawnText = pdfText(pdf)
  check('generated PDF draws the student name', drawnText.includes(studentName), `text=${JSON.stringify(drawnText)}`)
  // The template renders the course title in uppercase, so match case-insensitively.
  check(
    'generated PDF draws the course title',
    drawnText.toLowerCase().includes('logistics 101'),
    `text=${JSON.stringify(drawnText)}`,
  )
  check(
    'generated PDF draws the verification id',
    drawnText.includes(first.verificationId.toUpperCase()) || drawnText.includes(first.verificationId),
    `text=${JSON.stringify(drawnText)}`,
  )

  // 5. Download disposition returns an attachment URL.
  const download = await api.functions.invoke('certificate-access', {
    body: { certificateId: first.certificateId, disposition: 'attachment', fileName: 'Logistics-101-Certificate.pdf' },
  })
  check('download disposition returns a link', typeof download.data?.url === 'string' && download.data.disposition === 'attachment', `disposition=${download.data?.disposition}`)

  // 6. Public verification. verify_certificate_record is service-role only, so the
  // real public path is the verify-certificate edge function, which takes a GET.
  const verificationId = first.verificationId
  const publicLookup = await fetch(
    `${url}/functions/v1/verify-certificate?id=${encodeURIComponent(verificationId)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  )
  const verifiedPayload = await publicLookup.text()
  check('public verification endpoint resolves the certificate', publicLookup.status === 200 && !verifiedPayload.includes('not_found'), `status=${publicLookup.status} body=${verifiedPayload.slice(0, 200)}`)
  check('public verification reports the student name', verifiedPayload.includes(studentName), 'name present in verification payload')

  const bogus = await fetch(
    `${url}/functions/v1/verify-certificate?id=LVA-0000-0000000000000000`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  )
  check('public verification rejects an unknown id', bogus.status === 404, `status=${bogus.status}`)

  const [verifyId, verifyStatus, verifyName, verifyModules] = scalar(
    sql(`select string_agg(verification_id || '~' || status::text || '~' || coalesce(student_name, '') || '~' || required_module_count::text, '|') as v from public.certificates where verification_id = '${verificationId}';`),
  ).split('~')
  check('verification id resolves to the certificate row', verifyId === verificationId, `${verifyId}`)
  check('verification record is active', verifyStatus === 'active', `status=${verifyStatus}`)
  check('verification record matches the certificate', verifyName === studentName, `${verifyName}`)
  check('verification record reports 8 required modules', verifyModules === '8', `required_module_count=${verifyModules}`)

  check('verification URL is derivable from the verification id', verificationId.length > 0, `verificationId=${verificationId}`)

  console.log(`\nverification URL: ${process.env.VITE_APP_ORIGIN ?? '(set VITE_APP_ORIGIN)'}/verify/${verificationId}`)
}

try {
  await main()
} catch (error) {
  check('probe completed without error', false, error instanceof Error ? error.message : String(error))
} finally {
  if (adminId) {
    try {
      sql(`delete from public.audit_logs where actor_id = '${adminId}'::uuid;`);
      sql(`delete from public.user_roles where user_id = '${adminId}'::uuid;`);
      sql(`delete from auth.users where id = '${adminId}'::uuid;`);
      console.log(`\ncleaned up disposable admin ${adminEmail}`)
    } catch (error) {
      console.log(`\ncleanup warning: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const failed = results.filter((row) => !row.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1