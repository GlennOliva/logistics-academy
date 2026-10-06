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
  const requestId = crypto.randomUUID()
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
    const moduleId = typeof body?.moduleId === 'string' ? body.moduleId : ''
    const language = typeof body?.language === 'string' ? body.language : null
    if (!moduleId) throw new Error('A module is required')

    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Entitlement, account status, curriculum membership and publication are all
    // decided inside this call. The function never signs a path it was merely
    // asked for, so a forged body cannot obtain a link.
    const granted = await service.rpc('issue_material_access', {
      caller_user: user.id,
      target_module: moduleId,
      requested_language: language,
    })
    if (granted.error) throw granted.error

    const entitlement = granted.data as {
      allowed: boolean
      error?: string
      objectPath: string
      title: string
      language: string
      requestedLanguage: string
      fallback: boolean
      version: number
      sizeBytes: number
    }

    // A refusal is a recorded decision, not an exception. Surfacing the reason
    // lets the UI explain why access is unavailable instead of showing a
    // generic failure.
    if (!entitlement.allowed) {
      console.warn('Material access denied', { requestId, moduleId, language, reason: entitlement.error ?? 'Access denied' })
      return Response.json({ error: entitlement.error ?? 'Access denied' }, { status: 403, headers })
    }

    const format = entitlement.objectPath.endsWith('.pptx')
      ? 'pptx'
      : entitlement.objectPath.endsWith('.ppt')
        ? 'ppt'
        : entitlement.objectPath.endsWith('.pdf')
          ? 'pdf'
          : 'unknown'
    const downloadName = `${entitlement.title.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100) || 'course-material'}.${format}`

    const signed = await service.storage.from('course-materials').createSignedUrl(
      entitlement.objectPath,
      SIGNED_URL_SECONDS,
      format === 'ppt' || format === 'pptx' ? { download: downloadName } : undefined,
    )
    if (signed.error) {
      console.error('Material signing failed', { requestId, moduleId, language, reason: signed.error.message })
      return Response.json(
        { error: 'The published material file could not be opened. Please contact the academy.' },
        { status: 503, headers },
      )
    }

    return Response.json(
      {
        url: signed.data.signedUrl,
        expiresInSeconds: SIGNED_URL_SECONDS,
        title: entitlement.title,
        language: entitlement.language,
        requestedLanguage: entitlement.requestedLanguage,
        // Derived from the stored object path so the UI can label a PowerPoint
        // download without guessing from the signed URL.
        format,
        // The UI must say when the requested language was unavailable rather than
        // quietly presenting English as if it were Bisaya.
        fallback: entitlement.fallback,
        version: entitlement.version,
        sizeBytes: entitlement.sizeBytes,
      },
      { headers },
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown material access error'
    console.error('Material access check failed', { requestId, reason })
    return Response.json(
      { error: 'Material access could not be checked right now. Please try again.' },
      { status: 500, headers },
    )
  }
})
