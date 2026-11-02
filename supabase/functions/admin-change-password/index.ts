import { createClient } from 'npm:@supabase/supabase-js@2'

const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 72
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const APP_ORIGINS = new Set([
  'https://logistics-academy-orpin.vercel.app',
  'http://localhost:5173',
  ...(Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
])

function cors(origin: string | null) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (origin && APP_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function response(body: Record<string, unknown>, status: number, headers: Record<string, string>) {
  return Response.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } })
}

function passwordProblem(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `The new password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `The new password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`
  }
  if (!/[A-Za-z]/.test(password)) return 'The new password must include at least one letter.'
  if (!/\d/.test(password)) return 'The new password must include at least one number.'
  return ''
}

type ServiceClient = ReturnType<typeof createClient>

async function recordAudit(
  service: ServiceClient,
  actorId: string,
  targetId: string,
  outcome: 'password_updated' | 'password_updated_sessions_not_revoked' | 'password_update_failed',
  sessionsRevoked: boolean,
  sessionsDeleted: number,
) {
  const { error } = await service.rpc('admin_record_password_change', {
    caller_user: actorId,
    target_user: targetId,
    outcome,
    sessions_revoked: sessionsRevoked,
    sessions_deleted: sessionsDeleted,
  })
  return !error
}

Deno.serve(async (request) => {
  const headers = cors(request.headers.get('origin'))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405, headers)

  const authHeader = request.headers.get('authorization')
  if (!authHeader) return response({ error: 'Authentication required' }, 401, headers)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceRoleKey) {
    return response({ error: 'Password changes are not configured on this server.' }, 503, headers)
  }

  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userError } = await anon.auth.getUser()
  if (userError || !user) return response({ error: 'Invalid or expired session.' }, 401, headers)

  // This is a database lookup, not a JWT or user-metadata claim. A suspended
  // administrator is refused because public.is_admin() checks account status.
  const { data: isAdmin, error: roleError } = await anon.rpc('is_admin', { target_user: user.id })
  if (roleError) return response({ error: 'Your administrator role could not be verified.' }, 503, headers)
  if (isAdmin !== true) return response({ error: 'Administrator role required.' }, 403, headers)

  let body: { targetUserId?: unknown; newPassword?: unknown } | null = null
  try {
    body = await request.json()
  } catch {
    return response({ error: 'A JSON request body is required.' }, 400, headers)
  }

  const targetUserId = typeof body?.targetUserId === 'string' ? body.targetUserId.trim() : ''
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''
  if (!UUID_PATTERN.test(targetUserId)) {
    return response({ error: 'A valid target user is required.' }, 400, headers)
  }
  const policyProblem = passwordProblem(newPassword)
  if (policyProblem) return response({ error: policyProblem }, 400, headers)

  const service = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: rateAllowed, error: rateError } = await service.rpc(
    'admin_consume_password_change_rate_limit',
    { actor_user: user.id },
  )
  if (rateError) {
    return response({ error: 'The password-change limit could not be verified. Try again.' }, 503, headers)
  }
  if (rateAllowed !== true) {
    return response(
      { error: 'Too many password-change requests. Wait a few minutes and try again.' },
      429,
      { ...headers, 'Retry-After': '600' },
    )
  }

  const target = await service.auth.admin.getUserById(targetUserId)
  if (target.error || !target.data?.user) {
    const auditRecorded = await recordAudit(
      service,
      user.id,
      targetUserId,
      'password_update_failed',
      false,
      0,
    )
    return response(
      {
        error: 'No account matches the selected user.',
        passwordUpdated: false,
        sessionsRevoked: false,
        auditRecorded,
      },
      404,
      headers,
    )
  }

  const isSelf = targetUserId === user.id
  const updated = await service.auth.admin.updateUserById(targetUserId, { password: newPassword })
  if (updated.error) {
    const auditRecorded = await recordAudit(
      service,
      user.id,
      targetUserId,
      'password_update_failed',
      false,
      0,
    )
    const rejected = updated.error.status === 422 || updated.error.code === 'weak_password'
    return response(
      {
        error: rejected
          ? 'The authentication service rejected this password. Check the configured password policy.'
          : 'The password could not be updated. No password change was confirmed.',
        passwordUpdated: false,
        sessionsRevoked: false,
        auditRecorded,
      },
      rejected ? 422 : 502,
      headers,
    )
  }

  const finalized = await service.rpc('admin_finalize_password_change', {
    caller_user: user.id,
    target_user: targetUserId,
  })

  if (finalized.error) {
    // The password is already changed. Do not report full success, and still
    // record the partial outcome instead of leaving the reset unaudited.
    const auditRecorded = await recordAudit(
      service,
      user.id,
      targetUserId,
      'password_updated_sessions_not_revoked',
      false,
      0,
    )
    return response(
      {
        status: 'password_updated_sessions_not_revoked',
        passwordUpdated: true,
        sessionsRevoked: false,
        auditRecorded,
        isSelf,
        warning:
          "The new password was saved, but the user's refresh sessions could not be revoked. Existing sessions may keep working until the user signs out on all devices or the sessions expire.",
      },
      200,
      headers,
    )
  }

  const facts = finalized.data as { sessionsDeleted?: number } | null
  return response(
    {
      status: 'complete',
      passwordUpdated: true,
      sessionsRevoked: true,
      sessionsDeleted: facts?.sessionsDeleted ?? 0,
      auditRecorded: true,
      isSelf,
      message:
        'Password updated. The user must sign in again with the new password. Access tokens already issued remain valid until they expire.',
    },
    200,
    headers,
  )
})
