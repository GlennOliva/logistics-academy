import { createClient } from 'npm:@supabase/supabase-js@2'

const SIGNED_URL_SECONDS = 300

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
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
    const body = await request.json().catch(() => null)
    const certificateId = typeof body?.certificateId === 'string' ? body.certificateId : ''
    if (!certificateId) throw new Error('A certificate is required')
    // 'attachment' forces Content-Disposition: attachment so the browser saves the
    // file. 'inline' (or anything absent) keeps the default, which renders the PDF
    // in the tab. Omitting disposition keeps older callers working unchanged.
    const disposition = body?.disposition === 'attachment' ? 'attachment' : 'inline'
    const downloadName =
      typeof body?.fileName === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(body.fileName)
        ? body.fileName
        : undefined

    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const result = await service.rpc('issue_certificate_access', {
      caller_user: user.id,
      target_certificate: certificateId,
    })
    if (result.error) throw result.error
    if (!result.data.allowed) return Response.json({ error: result.data.error }, { status: 403, headers })

    const signed = await service.storage.from('certificates').createSignedUrl(
      result.data.objectPath,
      SIGNED_URL_SECONDS,
      disposition === 'attachment' ? { download: downloadName ?? 'certificate.pdf' } : undefined,
    )
    if (signed.error) throw signed.error

    return Response.json({
      url: signed.data.signedUrl,
      expiresInSeconds: SIGNED_URL_SECONDS,
      disposition,
      verificationId: result.data.verificationId,
      studentName: result.data.studentName,
      courseTitle: result.data.courseTitle,
    }, { headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to open this certificate'
    return Response.json({ error: message }, { status: 403, headers })
  }
})
