import { createClient } from 'npm:@supabase/supabase-js@2'

const BUCKET = 'course-materials'

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

type RequestResult = {
  translationId: string
  objectPath: string
  retry: boolean
}

type FinalizeResult = {
  translationId: string
  purged: boolean
  alreadyFinalized: boolean
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

  // Checked here as well as inside Postgres. The database check is the one that
  // matters, but refusing early keeps a non-admin from learning anything about
  // material rows.
  const { data: isAdmin } = await anon.rpc('is_admin', { target_user: user.id })
  if (isAdmin !== true) return Response.json({ error: 'Administrator role required' }, { status: 403, headers })

  let translationId = ''
  try {
    const body = await request.json().catch(() => null)
    translationId = typeof body?.translationId === 'string' ? body.translationId : ''
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (!translationId) throw new Error('A material version is required')
    if (reason.length < 3) throw new Error('A reason is required')

    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Step 1 records the decision and archives the version, and is refused in
    // Postgres for anything that was served, is shared, or is still published.
    const requested = await service.rpc('admin_request_material_version_purge', {
      caller_user: user.id,
      target_translation: translationId,
      reason,
    })
    if (requested.error) throw requested.error
    const facts = requested.data as RequestResult
    if (!facts?.objectPath) throw new Error('The material version could not be read.')

    // Step 2 removes the one object this version owns. No companion preview or
    // conversion output is removed, because nothing in the schema records one;
    // guessing a path from the file extension could delete an unrelated file.
    // Storage remove is idempotent, so a retry after a partial failure is safe.
    const removed = await service.storage.from(BUCKET).remove([facts.objectPath])

    if (removed.error) {
      // The version stays archived with purge_pending_at set: no row points at a
      // missing file, the original file is still stored, and the admin can run
      // this same request again.
      return Response.json(
        {
          translationId,
          purged: false,
          retryable: true,
          error: `The saved file could not be removed yet: ${removed.error.message}. The version is archived and can be retried.`,
        },
        { status: 502, headers },
      )
    }

    // Step 3 drops the row, which only happens once the file is known to be gone.
    const finalized = await service.rpc('admin_finalize_material_version_purge', {
      caller_user: user.id,
      target_translation: translationId,
    })
    if (finalized.error) {
      return Response.json(
        {
          translationId,
          purged: false,
          retryable: true,
          error: `The file was removed but the record could not be finalised: ${finalized.error.message}. Retrying completes the deletion.`,
        },
        { status: 502, headers },
      )
    }
    const result = finalized.data as FinalizeResult

    return Response.json(
      {
        translationId: result.translationId,
        purged: true,
        retried: facts.retry,
        removedObjects: [facts.objectPath],
        companionPreviewRemoved: false,
        note: 'No preview or conversion job is recorded for this version, so no other object was touched. Signed URLs already issued remain valid until they expire.',
      },
      { headers },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete this material version'
    return Response.json({ translationId, error: message, retryable: false }, { status: 400, headers })
  }
})
