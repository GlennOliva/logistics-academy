import { createClient } from 'npm:@supabase/supabase-js@2'

const MAX_BYTES = 10 * 1024 * 1024
const allowedTypes = new Set(['image/jpeg', 'image/png', 'application/pdf'])

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim())
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function hasValidSignature(bytes: Uint8Array, mime: string) {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/png') return bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  if (mime === 'application/pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
  return false
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

  try {
    const form = await request.formData()
    const file = form.get('proof')
    if (!(file instanceof File)) throw new Error('A proof file is required')
    if (!allowedTypes.has(file.type) || file.size < 1 || file.size > MAX_BYTES) throw new Error('Use a JPG, PNG, or PDF up to 10 MB')
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!hasValidSignature(bytes, file.type)) throw new Error('File contents do not match the selected format')

    const orderId = String(form.get('orderId') ?? '')
    const methodId = String(form.get('methodId') ?? '')
    const amount = Number(form.get('amountCentavos'))
    const reference = String(form.get('referenceNumber') ?? '').trim()
    const transactionAt = String(form.get('transactionAt') ?? '')
    if (!orderId || !methodId || !Number.isInteger(amount) || reference.length < 3 || !transactionAt) throw new Error('Payment details are incomplete')

    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'pdf'
    const objectPath = `${user.id}/${orderId}/${crypto.randomUUID()}.${extension}`
    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const upload = await service.storage.from('payment-proofs').upload(objectPath, bytes, { contentType: file.type, upsert: false })
    if (upload.error) throw upload.error

    const result = await service.rpc('create_payment_submission', {
      submission_user_id: user.id,
      target_order_id: orderId,
      target_method_id: methodId,
      amount_centavos: amount,
      payment_reference: reference,
      paid_at: transactionAt,
      proof_path: objectPath,
      proof_filename: file.name.slice(0, 255),
      proof_mime: file.type,
      proof_size: file.size,
      proof_sha256: sha256,
    })
    if (result.error) {
      await service.storage.from('payment-proofs').remove([objectPath])
      throw result.error
    }
    return Response.json({ submissionId: result.data, status: 'pending' }, { status: 201, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to submit payment proof'
    return Response.json({ error: message }, { status: 400, headers })
  }
})
