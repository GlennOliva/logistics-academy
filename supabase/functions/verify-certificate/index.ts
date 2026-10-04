import { createClient } from 'npm:@supabase/supabase-js@2'

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  }
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (request) => {
  const headers = cors(request.headers.get('origin'))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers })

  const salt = Deno.env.get('CERTIFICATE_RATE_LIMIT_SALT')
  if (!salt) return Response.json({ error: 'Verification is not configured' }, { status: 503, headers })

  const lookup = new URL(request.url).searchParams.get('id')?.trim().toUpperCase() ?? ''
  if (!/^LVA-\d{4}-[A-F0-9]{16}$/.test(lookup)) {
    return Response.json({ status: 'not_found' }, { status: 404, headers })
  }

  const clientIp = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const requestKey = await hash(`${salt}:${clientIp}`)
  const rate = await service.rpc('check_certificate_rate_limit', { request_key_hash: requestKey })
  if (rate.error) return Response.json({ error: 'Verification is temporarily unavailable' }, { status: 503, headers })
  if (!rate.data) return Response.json({ error: 'Too many requests' }, { status: 429, headers })

  const verified = await service.rpc('verify_certificate_record', { lookup_id: lookup })
  if (verified.error) return Response.json({ error: 'Verification is temporarily unavailable' }, { status: 503, headers })
  return Response.json(verified.data, { status: verified.data.status === 'not_found' ? 404 : 200, headers })
})
