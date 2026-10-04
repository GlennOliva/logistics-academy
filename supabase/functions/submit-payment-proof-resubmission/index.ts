import { createClient } from 'npm:@supabase/supabase-js@2'

const MAX_BYTES = 10 * 1024 * 1024
const allowedTypes = new Set(['image/jpeg', 'image/png', 'application/pdf'])

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function hasValidSignature(bytes: Uint8Array, mime: string) {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/png') {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  }
  if (mime === 'application/pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
  return false
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

type Proof = {
  orderId: string
  methodId: string
  amount: number
  reference: string
  transactionAt: string
  originalSubmissionId: string
}

Deno.serve(async (request) => {
  const headers = cors(request.headers.get('origin'))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers })

  const authHeader = request.headers.get('authorization')
  if (!authHeader) return Response.json({ error: 'Authentication required' }, { status: 401, headers })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await anon.auth.getUser()
  if (!user) return Response.json({ error: 'Invalid session' }, { status: 401, headers })

  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const bucket = service.storage.from('payment-proofs')
  let objectPath: string | null = null

  try {
    const form = await request.formData()
    const file = form.get('proof')
    if (!(file instanceof File)) throw new Error('A proof file is required')
    if (!allowedTypes.has(file.type) || file.size < 1 || file.size > MAX_BYTES) {
      throw new Error('Use a JPG, PNG, or PDF up to 10 MB')
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!hasValidSignature(bytes, file.type)) throw new Error('File contents do not match the selected format')

    const proof: Proof = {
      orderId: String(form.get('orderId') ?? ''),
      methodId: String(form.get('methodId') ?? ''),
      amount: Number(form.get('amountCentavos')),
      reference: String(form.get('referenceNumber') ?? '').trim(),
      transactionAt: String(form.get('transactionAt') ?? ''),
      originalSubmissionId: String(form.get('submissionId') ?? ''),
    }
    if (!proof.orderId || !proof.methodId || !Number.isInteger(proof.amount) || proof.reference.length < 3 || !proof.transactionAt) {
      throw new Error('Payment details are incomplete')
    }
    if (Number.isNaN(Date.parse(proof.transactionAt))) throw new Error('Transaction time is not a valid date')

    const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'pdf'
    // The path prefix is re-validated inside the trusted database function, so the
    // database remains the single authority on who may write where.
    objectPath = `${user.id}/${proof.orderId}/${crypto.randomUUID()}.${extension}`
    const upload = await bucket.upload(objectPath, bytes, { contentType: file.type, upsert: false })
    if (upload.error) throw upload.error

    const shared = {
      submission_user_id: user.id,
      target_order_id: proof.orderId,
      target_method_id: proof.methodId,
      amount_centavos: proof.amount,
      payment_reference: proof.reference,
      paid_at: proof.transactionAt,
      proof_path: objectPath,
      proof_filename: file.name.slice(0, 255),
      proof_mime: file.type,
      proof_size: file.size,
      proof_sha256: await sha256Hex(bytes),
    }

    // A resubmission adds a new immutable revision to the same submission, so the
    // original proof and the reviewer's stated reason both survive. Ownership,
    // current status, and amount are re-checked inside the function, which is the
    // only place trusted: a client cannot resubmit another student's payment.
    const saved = proof.originalSubmissionId
      ? await service.rpc('add_payment_proof_revision', {
          submission_user_id: shared.submission_user_id,
          target_submission: proof.originalSubmissionId,
          target_method_id: shared.target_method_id,
          amount_centavos: shared.amount_centavos,
          payment_reference: shared.payment_reference,
          paid_at: shared.paid_at,
          proof_path: shared.proof_path,
          proof_filename: shared.proof_filename,
          proof_mime: shared.proof_mime,
          proof_size: shared.proof_size,
          proof_sha256: shared.proof_sha256,
        })
      : await service.rpc('create_payment_submission', shared)

    if (saved.error) {
      await bucket.remove([objectPath])
      objectPath = null
      throw saved.error
    }

    return Response.json({ submissionId: saved.data, status: 'pending' }, { status: 201, headers })
  } catch (error) {
    // Never leave an orphaned object behind if the database rejected the write.
    if (objectPath) await bucket.remove([objectPath])
    const message = error instanceof Error ? error.message : 'Unable to submit payment proof'
    return Response.json({ error: message }, { status: 400, headers })
  }
})
