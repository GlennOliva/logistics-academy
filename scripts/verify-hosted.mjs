#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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

const checks = []
function check(condition, label) {
  checks.push({ condition: Boolean(condition), label })
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}`)
  if (!condition) throw new Error(label)
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
  if (result.status !== 0) throw new Error('Trusted test-project SQL operation failed')
}

function removeStorageObject(bucket, objectPath) {
  if (!objectPath) return
  spawnSync('npx', ['supabase', 'storage', 'rm', '--experimental', '--linked', '--yes', `ss:///${bucket}/${objectPath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function invoke(name, accessToken, body, requestOrigin = origin) {
  const headers = { apikey: key, Origin: requestOrigin }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers,
    body: body instanceof FormData ? body : JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  return { response, payload }
}

async function signupAndLogin(label, runId) {
  const email = `academy-${label}-${runId}@example.com`
  const password = `Hosted-${randomUUID()}-Aa1!`
  const auth = client()
  const signup = await auth.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: `Hosted Test ${label}`,
        preferred_language: label === 'student-b' ? 'ceb' : 'en',
        age_18_attested: true,
        terms_version: 'development-draft-2026-10-03',
        privacy_version: 'development-draft-2026-10-03',
      },
    },
  })
  check(!signup.error && Boolean(signup.data.user), `${label} signup persists through hosted Auth`)
  check(Boolean(signup.data.session), `${label} receives a test session while auto-confirm is temporary`)

  await auth.auth.signOut()
  const login = await auth.auth.signInWithPassword({ email, password })
  check(!login.error && Boolean(login.data.session), `${label} password login succeeds`)
  return {
    id: login.data.user.id,
    token: login.data.session.access_token,
    api: client(login.data.session.access_token),
  }
}

const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
const certificateCourseId = randomUUID()
const certificateEnrollmentId = randomUUID()
const certificateQuizId = randomUUID()
const certificateQuizVersionId = randomUUID()
const certificateAttemptId = randomUUID()
const certificateModuleIds = Array.from({ length: 8 }, () => randomUUID())
const refundOrderId = randomUUID()
const refundSubmissionId = randomUUID()
const refundEnrollmentId = randomUUID()
const refundGrantId = randomUUID()
const paymentOrderAId = randomUUID()
const paymentOrderBId = randomUUID()
let materialObjectPath = ''
let certificateObjectPath = ''
let paymentProofPaths = []
let adminId = ''
let studentAId = ''
let studentBId = ''

try {
  const admin = await signupAndLogin('admin', runId)
  const studentA = await signupAndLogin('student-a', runId)
  const studentB = await signupAndLogin('student-b', runId)
  adminId = admin.id
  studentAId = studentA.id
  studentBId = studentB.id

  dbQuery(
    `insert into public.user_roles (user_id, role) values ('${admin.id}'::uuid, 'admin') on conflict do nothing`,
  )

  const adminRole = await admin.api.rpc('is_admin', { target_user: admin.id })
  check(!adminRole.error && adminRole.data === true, 'trusted provisioning grants only the designated admin role')

  const profile = await studentA.api.from('profiles').select('id,full_name').eq('id', studentA.id).single()
  const acceptances = await studentA.api.from('policy_acceptances').select('policy_version_id').eq('user_id', studentA.id)
  check(!profile.error && profile.data.full_name === 'Hosted Test student-a', 'signup trigger creates the student profile')
  check(!acceptances.error && acceptances.data.length === 2, 'signup trigger records both policy acknowledgements')

  const crossProfile = await studentB.api.from('profiles').select('id').eq('id', studentA.id)
  check(!crossProfile.error && crossProfile.data.length === 0, 'another student cannot read the first student profile')

  const publicCourse = await client().from('courses').select('id,price_centavos,sales_enabled').eq('slug', 'logistics-101').single()
  check(!publicCourse.error && publicCourse.data.price_centavos === 69900, 'public course query uses authoritative centavo pricing')
  check(publicCourse.data.sales_enabled === false, 'course sales remain disabled')

  const methods = await studentA.api
    .from('payment_methods')
    .select('id,type,display_name,destination_label,destination_details,instructions,qr_object_path,enabled')
    .order('display_name')
  check(
    !methods.error
      && methods.data.length === 2
      && methods.data.every((method) => method.enabled && method.destination_details && method.instructions && method.qr_object_path)
      && methods.data.map((method) => method.display_name).join(',') === 'GCash,MariBank',
    'students see only configured GCash and MariBank destinations',
  )
  for (const method of methods.data) {
    const qrUrl = studentA.api.storage.from('branding').getPublicUrl(method.qr_object_path).data.publicUrl
    const qrResponse = await fetch(qrUrl)
    check(qrResponse.ok && qrResponse.headers.get('content-type') === 'image/jpeg', `${method.display_name} QR is publicly readable as JPEG`)
  }

  const tinyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
  const directProof = await studentA.api.storage
    .from('payment-proofs')
    .upload(`${studentA.id}/blocked/direct.png`, tinyPng, { contentType: 'image/png', upsert: false })
  check(Boolean(directProof.error), 'student direct upload to private payment-proof storage is denied')

  const gcash = methods.data.find((method) => method.type === 'gcash')
  const maribank = methods.data.find((method) => method.type === 'bank_transfer')
  check(Boolean(gcash && maribank), 'hosted payment methods retain stable GCash and bank-transfer identifiers')

  dbQuery(`
    insert into public.orders (id, user_id, course_id, price_centavos, currency, status)
    values
      ('${paymentOrderAId}'::uuid, '${studentA.id}'::uuid, '${publicCourse.data.id}'::uuid, 69900, 'PHP', 'open'),
      ('${paymentOrderBId}'::uuid, '${studentB.id}'::uuid, '${publicCourse.data.id}'::uuid, 69900, 'PHP', 'open');
  `)

  const paymentForm = (orderId, methodId, reference) => {
    const form = new FormData()
    form.set('orderId', orderId)
    form.set('methodId', methodId)
    form.set('amountCentavos', '69900')
    form.set('referenceNumber', reference)
    form.set('transactionAt', new Date().toISOString())
    form.set('proof', new Blob([tinyPng], { type: 'image/png' }), 'hosted-proof.png')
    return form
  }

  const firstProof = await invoke(
    'submit-payment-proof',
    studentA.token,
    paymentForm(paymentOrderAId, gcash.id, `HOSTED-GCASH-${runId}`),
  )
  check(firstProof.response.status === 201 && firstProof.payload.status === 'pending', 'private GCash proof submission enters pending review')
  const paymentSubmissionAId = firstProof.payload.submissionId
  const initialRevision = await studentA.api
    .from('payment_proof_revisions')
    .select('object_path')
    .eq('submission_id', paymentSubmissionAId)
    .single()
  if (!initialRevision.error) paymentProofPaths.push(initialRevision.data.object_path)

  const requestReplacement = await admin.api.rpc('review_payment', {
    target_submission: paymentSubmissionAId,
    decision: 'resubmission_required',
    reason: 'Hosted replacement proof check',
  })
  check(!requestReplacement.error, 'administrator can request a replacement proof with a reason')
  const replacementState = await studentA.api
    .from('payment_submissions')
    .select('status')
    .eq('id', paymentSubmissionAId)
    .single()
  check(!replacementState.error && replacementState.data.status === 'resubmission_required', 'student sees that a replacement proof is required')

  const replacementProof = paymentForm(paymentOrderAId, maribank.id, `HOSTED-MARIBANK-${runId}`)
  replacementProof.set('submissionId', paymentSubmissionAId)
  const replaced = await invoke('submit-payment-proof-resubmission', studentA.token, replacementProof)
  check(
    replaced.response.status === 201 && replaced.payload.status === 'pending',
    `private MariBank replacement returns the same case to pending${replaced.payload.error ? ` (${replaced.payload.error})` : ''}`,
  )

  const revisionsA = await studentA.api
    .from('payment_proof_revisions')
    .select('object_path,revision')
    .eq('submission_id', paymentSubmissionAId)
    .order('revision')
  check(!revisionsA.error && revisionsA.data.length === 2, 'resubmission preserves both immutable private proof revisions')
  paymentProofPaths.push(
    ...revisionsA.data
      .map((revision) => revision.object_path)
      .filter((objectPath) => !paymentProofPaths.includes(objectPath)),
  )

  const rejected = await admin.api.rpc('review_payment', {
    target_submission: paymentSubmissionAId,
    decision: 'rejected',
    reason: 'Hosted rejection access check',
  })
  const rejectedEnrollment = await studentA.api.from('enrollments').select('id').eq('course_id', publicCourse.data.id)
  check(!rejected.error && !rejectedEnrollment.error && rejectedEnrollment.data.length === 0, 'rejection records the decision without granting course access')

  const approvalProof = await invoke(
    'submit-payment-proof',
    studentB.token,
    paymentForm(paymentOrderBId, maribank.id, `HOSTED-APPROVE-${runId}`),
  )
  check(approvalProof.response.status === 201 && approvalProof.payload.status === 'pending', 'private MariBank proof remains pending until administrator review')
  const paymentSubmissionBId = approvalProof.payload.submissionId
  const revisionsB = await studentB.api
    .from('payment_proof_revisions')
    .select('object_path')
    .eq('submission_id', paymentSubmissionBId)
  paymentProofPaths.push(...(revisionsB.data ?? []).map((revision) => revision.object_path))

  const approved = await admin.api.rpc('review_payment', {
    target_submission: paymentSubmissionBId,
    decision: 'approved',
    reason: '',
  })
  const approvedEnrollment = await studentB.api.from('enrollments').select('id,status').eq('course_id', publicCourse.data.id).single()
  check(!approved.error && !approvedEnrollment.error && approvedEnrollment.data.status === 'active', 'administrator approval alone grants active course access')

  for (const name of [
    'submit-payment-proof',
    'submit-payment-proof-resubmission',
    'course-material-access',
    'submit-course-material',
    'generate-certificate',
    'certificate-access',
    'admin-report-csv',
  ]) {
    const unauthenticated = await invoke(name, null, {})
    check(unauthenticated.response.status === 401, `${name} rejects a missing user JWT`)
  }

  const options = await fetch(`${url}/functions/v1/course-material-access`, {
    method: 'OPTIONS',
    headers: { Origin: origin, apikey: key },
  })
  check(
    options.status === 204 && options.headers.get('access-control-allow-origin') === origin,
    'Edge Function CORS allows only the configured local origin',
  )

  const studentMaterialAttempt = new FormData()
  studentMaterialAttempt.set('moduleId', randomUUID())
  studentMaterialAttempt.set('language', 'en')
  studentMaterialAttempt.set('title', 'Blocked student upload')
  studentMaterialAttempt.set('summary', 'Hosted authorization check')
  studentMaterialAttempt.set('publishNow', 'false')
  studentMaterialAttempt.set('material', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'blocked.pdf')
  const forbiddenAuthoring = await invoke('submit-course-material', studentA.token, studentMaterialAttempt)
  check(forbiddenAuthoring.response.status === 403, 'a student cannot invoke admin material authoring')

  const created = await admin.api.rpc('admin_save_module', {
    target_course: publicCourse.data.id,
    module_position: 100000 + Math.floor(Math.random() * 100000),
    module_required: true,
    action: 'create',
  })
  check(!created.error && Boolean(created.data), 'admin creates a hosted test module through the trusted RPC')
  const moduleId = created.data

  const pdfBytes = new Blob(
    [`%PDF-1.4\n% Logistics Academy hosted integration fixture ${runId}\n%%EOF`],
    { type: 'application/pdf' },
  )
  const materialForm = new FormData()
  materialForm.set('moduleId', moduleId)
  materialForm.set('language', 'en')
  materialForm.set('title', 'HOSTED TEST MATERIAL - NOT COURSE CONTENT')
  materialForm.set('summary', 'Disposable authorization and signed-link fixture.')
  materialForm.set('publishNow', 'true')
  materialForm.set('material', pdfBytes, 'hosted-test-material.pdf')
  const authored = await invoke('submit-course-material', admin.token, materialForm)
  check(authored.response.status === 201 && Boolean(authored.payload.objectPath), 'admin uploads a private PDF through the material Edge Function')
  const objectPath = authored.payload.objectPath
  materialObjectPath = objectPath

  const published = await admin.api.rpc('admin_set_module_status', {
    target_module: moduleId,
    new_status: 'published',
    reason: 'hosted integration authorization fixture',
    apply_to_existing: false,
  })
  check(!published.error, 'admin publishes the hosted test module through the trusted RPC')

  const unpaidAccess = await invoke('course-material-access', studentB.token, { moduleId, language: 'en' })
  check(unpaidAccess.response.status === 403, 'unpaid student cannot obtain a course-material signed URL')

  const crossAdmin = await studentA.api.rpc('admin_set_module_status', {
    target_module: moduleId,
    new_status: 'archived',
    reason: 'unauthorized student attempt',
    apply_to_existing: false,
  })
  check(Boolean(crossAdmin.error), 'student cannot invoke an admin-only module transition')

  const granted = await admin.api.rpc('grant_manual_enrollment', {
    target_user: studentA.id,
    target_course: publicCourse.data.id,
    grant_kind: 'complimentary',
    reason: 'hosted integration test; no payment represented',
  })
  check(!granted.error && Boolean(granted.data), 'admin grants a clearly non-payment test enrollment')

  const materialAccess = await invoke('course-material-access', studentA.token, { moduleId, language: 'en' })
  check(materialAccess.response.status === 200 && Boolean(materialAccess.payload.url), 'enrolled student receives a short-lived signed material URL')

  const signedPdf = await fetch(materialAccess.payload.url)
  const signedBytes = new Uint8Array(await signedPdf.arrayBuffer())
  check(
    signedPdf.ok && new TextDecoder().decode(signedBytes.slice(0, 5)) === '%PDF-',
    'signed URL returns the private PDF contents',
  )

  const directStudentMaterial = await studentA.api.storage.from('course-materials').download(objectPath)
  check(Boolean(directStudentMaterial.error), 'enrolled student cannot bypass entitlement with a direct Storage download')

  const adminPreview = await admin.api.storage.from('course-materials').download(objectPath)
  check(!adminPreview.error && adminPreview.data.size > 0, 'admin can preview the private material through admin RLS')

  const ownEvents = await studentA.api
    .from('material_access_events')
    .select('id,event_type')
    .eq('module_id', moduleId)
  const otherEvents = await studentB.api
    .from('material_access_events')
    .select('id,event_type')
    .eq('module_id', moduleId)
  check(!ownEvents.error && ownEvents.data.some((row) => row.event_type === 'link_issued'), 'signed-link issuance is recorded for the entitled student')
  check(!otherEvents.error && otherEvents.data.every((row) => row.event_type === 'access_denied'), 'another student cannot read the entitled student access history')

  const invalidProofForm = new FormData()
  const proofInvocation = await invoke('submit-payment-proof', studentA.token, invalidProofForm)
  check(proofInvocation.response.status === 400, 'authenticated proof function validates the multipart request')

  const moduleValues = certificateModuleIds.map((id, index) =>
    `('${id}'::uuid, '${certificateCourseId}'::uuid, ${index + 1}, true, 'published')`,
  ).join(',')
  dbQuery(`
    insert into public.courses (id, slug, title, description, price_centavos, status, sales_enabled)
    values ('${certificateCourseId}'::uuid, 'hosted-certificate-${runId}', 'Hosted Certificate Fixture', 'Disposable test fixture', 0, 'published', false);
    insert into public.modules (id, course_id, position, required, status) values ${moduleValues};
    insert into public.enrollments (id, user_id, course_id, status)
    values ('${certificateEnrollmentId}'::uuid, '${studentA.id}'::uuid, '${certificateCourseId}'::uuid, 'active');
    insert into public.enrollment_modules (enrollment_id, module_id, required, curriculum_version)
    select '${certificateEnrollmentId}'::uuid, id, true, curriculum_version from public.modules where course_id = '${certificateCourseId}'::uuid;
    insert into public.module_progress (enrollment_id, module_id, studied_at, knowledge_check_completed_at, completed_at)
    select '${certificateEnrollmentId}'::uuid, id, now(), now(), now() from public.modules where course_id = '${certificateCourseId}'::uuid;
    insert into public.quizzes (id, course_id, kind)
    values ('${certificateQuizId}'::uuid, '${certificateCourseId}'::uuid, 'final');
    insert into public.quiz_versions (id, quiz_id, language, version, status, pass_threshold, enabled, created_by, published_at)
    values ('${certificateQuizVersionId}'::uuid, '${certificateQuizId}'::uuid, 'en', 1, 'published', 75, true, '${admin.id}'::uuid, now());
    insert into public.quiz_attempts (
      id, enrollment_id, user_id, quiz_id, quiz_version_id, kind, attempt_number,
      state, score, passed, correct_count, question_count, scored_at
    ) values (
      '${certificateAttemptId}'::uuid, '${certificateEnrollmentId}'::uuid, '${studentA.id}'::uuid,
      '${certificateQuizId}'::uuid, '${certificateQuizVersionId}'::uuid, 'final', 1,
      'scored', 75, true, 3, 4, now()
    );
    insert into public.course_certificate_configs (
      course_id, enabled, required_module_count, minimum_score, template_version,
      template_sha256, template_object_path
    ) values (
      '${certificateCourseId}'::uuid, true, 8, 75, 2,
      '0ae273c023f8237fa990115257b21ef208637ba29b3d309b2b5e67cd039d9062',
      'logistics-101/v2/background.png'
    );
  `)

  const crossCertificate = await invoke('generate-certificate', studentB.token, { enrollmentId: certificateEnrollmentId })
  check(crossCertificate.response.status === 403, 'another student cannot issue a certificate for this enrollment')

  const generated = await invoke('generate-certificate', studentA.token, { enrollmentId: certificateEnrollmentId })
  check(generated.response.status === 201 && generated.payload.status === 'active', 'eligible student generates a certificate from the private template')
  const certificateId = generated.payload.certificateId
  const verificationId = generated.payload.verificationId

  const certificateRow = await studentA.api
    .from('certificates')
    .select('id,status,object_path,pdf_sha256,size_bytes,verification_id')
    .eq('id', certificateId)
    .single()
  check(
    !certificateRow.error && certificateRow.data.status === 'active'
      && certificateRow.data.pdf_sha256?.length === 64 && certificateRow.data.size_bytes > 50000,
    'generated certificate records its private object, size, and SHA-256',
  )
  certificateObjectPath = certificateRow.data.object_path

  const directCertificate = await studentA.api.storage.from('certificates').download(certificateObjectPath)
  check(Boolean(directCertificate.error), 'certificate owner cannot bypass the signed-download function with direct Storage access')
  const directTemplate = await studentA.api.storage.from('certificate-templates').download('logistics-101/v2/background.png')
  check(Boolean(directTemplate.error), 'students cannot read the private certificate source template')

  const wrongStudentCertificate = await invoke('certificate-access', studentB.token, { certificateId })
  check(wrongStudentCertificate.response.status === 403, 'another student cannot obtain the certificate signed URL')
  const ownerCertificate = await invoke('certificate-access', studentA.token, { certificateId })
  check(ownerCertificate.response.status === 200 && Boolean(ownerCertificate.payload.url), 'certificate owner receives a five-minute signed URL')
  const adminCertificate = await invoke('certificate-access', admin.token, { certificateId })
  check(adminCertificate.response.status === 200, 'administrator can retrieve the certificate through the same trusted authorization path')

  const certificatePdf = await fetch(ownerCertificate.payload.url)
  const certificateBytes = new Uint8Array(await certificatePdf.arrayBuffer())
  const certificateSource = new TextDecoder('latin1').decode(certificateBytes)
  check(certificatePdf.ok && certificateSource.startsWith('%PDF-'), 'certificate signed URL returns a PDF')
  check((certificateSource.match(/\/Type\s*\/Page\b/g) ?? []).length === 1, 'generated certificate remains a one-page document')
  if (process.env.HOSTED_CERTIFICATE_OUTPUT) writeFileSync(process.env.HOSTED_CERTIFICATE_OUTPUT, certificateBytes)

  const publicVerification = await fetch(`${url}/functions/v1/verify-certificate?id=${encodeURIComponent(verificationId)}`, {
    headers: { apikey: key, Origin: origin },
  })
  const publicPayload = await publicVerification.json()
  const publicKeys = Object.keys(publicPayload).sort()
  check(
    publicVerification.status === 200 && publicPayload.status === 'valid'
      && publicPayload.studentName === 'Hosted Test student-a'
      && publicPayload.courseTitle === 'Hosted Certificate Fixture',
    'public verification returns the immutable student and course snapshots',
  )
  check(
    publicKeys.every((field) => ['completedAt', 'courseTitle', 'issuedAt', 'status', 'studentName', 'verificationId'].includes(field)),
    'public verification exposes no user, enrollment, score, payment, hash, or object-path fields',
  )

  const invalidVerification = await fetch(`${url}/functions/v1/verify-certificate?id=invalid`, { headers: { apikey: key, Origin: origin } })
  check(invalidVerification.status === 404, 'public verification rejects malformed identifiers without lookup details')
  let rateLimited = false
  for (let attempt = 0; attempt < 35 && !rateLimited; attempt += 1) {
    const response = await fetch(`${url}/functions/v1/verify-certificate?id=${encodeURIComponent(verificationId)}`, {
      headers: { apikey: key, Origin: origin },
    })
    rateLimited = response.status === 429
  }
  check(rateLimited, 'public certificate verification enforces its per-minute rate limit')

  const workerWithoutSecret = await fetch(`${url}/functions/v1/email-outbox-worker`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: '{}',
  })
  check(workerWithoutSecret.status === 401, 'email worker rejects calls without its independent worker secret')

  const paymentMethod = await admin.api.from('payment_methods').select('id').limit(1).single()
  check(!paymentMethod.error && Boolean(paymentMethod.data.id), 'admin can resolve a disabled method for an isolated reconciliation fixture')
  dbQuery(`
    insert into public.orders (id, user_id, course_id, price_centavos, currency, status)
    values ('${refundOrderId}'::uuid, '${studentB.id}'::uuid, '${certificateCourseId}'::uuid, 69900, 'PHP', 'paid');
    insert into public.payment_submissions (
      id, order_id, payment_method_id, submitted_amount_centavos, reference_number,
      transaction_at, status, reviewer_id, reviewed_at
    ) values (
      '${refundSubmissionId}'::uuid, '${refundOrderId}'::uuid, '${paymentMethod.data.id}'::uuid,
      69900, '=HOSTED-REFUND-${runId}', now(), 'approved', '${admin.id}'::uuid, now()
    );
    insert into public.enrollments (id, user_id, course_id, status)
    values ('${refundEnrollmentId}'::uuid, '${studentB.id}'::uuid, '${certificateCourseId}'::uuid, 'active');
    insert into public.enrollment_grants (id, enrollment_id, source_type, source_id, reason, created_by)
    values (
      '${refundGrantId}'::uuid, '${refundEnrollmentId}'::uuid, 'payment', '${refundSubmissionId}'::uuid,
      'Hosted external reconciliation fixture', '${admin.id}'::uuid
    );
  `)
  const refunded = await admin.api.rpc('record_completed_refund', {
    target_submission: refundSubmissionId,
    actual_amount_centavos: 69900,
    external_completion_reference: `HOSTED-EXT-${runId}`,
    completion_time: new Date().toISOString(),
    reason: 'Hosted external reconciliation fixture',
    revoke_access: false,
  })
  check(!refunded.error && refunded.data.access_revoked === false, 'admin reconciles a completed external refund without moving money or revoking access')
  const manilaDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
  const ledger = await admin.api.rpc('admin_financial_ledger', { from_date: manilaDate, through_date: manilaDate })
  const refundEvents = ledger.data?.filter((row) => row.submission_id === refundSubmissionId) ?? []
  check(
    !ledger.error && refundEvents.length === 2
      && refundEvents.reduce((sum, row) => sum + row.gross_centavos, 0) === 69900
      && refundEvents.reduce((sum, row) => sum + row.refund_centavos, 0) === 69900
      && refundEvents.reduce((sum, row) => sum + row.net_centavos, 0) === 0,
    'hosted financial ledger preserves gross, refund, and zero net as separate events',
  )
  const adminCsv = await fetch(`${url}/functions/v1/admin-report-csv`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${admin.token}`, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromDate: manilaDate, throughDate: manilaDate }),
  })
  const adminCsvText = await adminCsv.text()
  check(adminCsv.status === 200 && adminCsv.headers.get('content-type')?.startsWith('text/csv'), 'administrator exports the filtered ledger as CSV')
  check(adminCsvText.includes(`"'=HOSTED-REFUND-${runId}"`), 'CSV export neutralizes spreadsheet-formula prefixes')
  const studentCsv = await invoke('admin-report-csv', studentA.token, { fromDate: manilaDate, throughDate: manilaDate })
  check(studentCsv.response.status === 403, 'student cannot export the administrator financial ledger')

  const finalMethods = await studentA.api.from('payment_methods').select('display_name').order('display_name')
  check(
    !finalMethods.error && finalMethods.data.map((method) => method.display_name).join(',') === 'GCash,MariBank',
    'integration checks leave only GCash and MariBank available',
  )

  console.log(`hosted checks passed: ${checks.filter((row) => row.condition).length}/${checks.length}`)
} catch (error) {
  console.error(`hosted verification stopped: ${error instanceof Error ? error.message : 'unknown failure'}`)
  process.exitCode = 1
} finally {
  removeStorageObject('course-materials', materialObjectPath)
  removeStorageObject('certificates', certificateObjectPath)
  for (const objectPath of paymentProofPaths) removeStorageObject('payment-proofs', objectPath)
  if (adminId && studentAId && studentBId) {
    try {
      dbQuery(`
        begin;
        delete from public.email_delivery_events where outbox_id in (select id from public.email_outbox where recipient_user_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid));
        delete from public.email_outbox where recipient_user_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid);
        delete from public.material_access_events where user_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid);
        delete from public.certificates where user_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid);
        delete from public.refunds where submission_id = '${refundSubmissionId}'::uuid;
        delete from public.refund_requests where submission_id = '${refundSubmissionId}'::uuid;
        delete from public.payment_events where submission_id = '${refundSubmissionId}'::uuid;
        delete from public.payment_events where submission_id in (select ps.id from public.payment_submissions ps join public.orders o on o.id = ps.order_id where o.user_id in ('${studentAId}'::uuid, '${studentBId}'::uuid));
        delete from public.enrollment_grants where enrollment_id in (select id from public.enrollments where user_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid)) or created_by = '${adminId}'::uuid;
        delete from public.enrollments where user_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid);
        delete from public.payment_proof_revisions where submission_id in (select ps.id from public.payment_submissions ps join public.orders o on o.id = ps.order_id where o.user_id in ('${studentAId}'::uuid, '${studentBId}'::uuid));
        delete from public.payment_submissions where order_id in (select id from public.orders where user_id in ('${studentAId}'::uuid, '${studentBId}'::uuid));
        delete from public.orders where user_id in ('${studentAId}'::uuid, '${studentBId}'::uuid);
        delete from public.payment_submissions where id = '${refundSubmissionId}'::uuid;
        delete from public.orders where id = '${refundOrderId}'::uuid;
        delete from public.module_translations where created_by = '${adminId}'::uuid;
        delete from public.modules where id in ('${certificateModuleIds.join("'::uuid, '")}'::uuid) or position >= 100000;
        delete from public.audit_logs where actor_id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid);
        delete from public.courses where id = '${certificateCourseId}'::uuid;
        delete from auth.users where id in ('${adminId}'::uuid, '${studentAId}'::uuid, '${studentBId}'::uuid);
        commit;
      `)
    } catch {
      console.error('WARNING: disposable hosted fixture cleanup requires manual review')
    }
  }
}
