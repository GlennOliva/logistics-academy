import { createClient } from 'npm:@supabase/supabase-js@2'

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function csvCell(value: unknown) {
  let text = String(value ?? '').replace(/[\r\n]+/g, ' ')
  if (/^\s*[=+\-@\t]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

Deno.serve(async (request) => {
  const headers = cors(request.headers.get('origin'))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers })

  const authHeader = request.headers.get('authorization')
  if (!authHeader) return Response.json({ error: 'Authentication required' }, { status: 401, headers })

  try {
    const body = await request.json().catch(() => null)
    const fromDate = typeof body?.fromDate === 'string' ? body.fromDate : ''
    const throughDate = typeof body?.throughDate === 'string' ? body.throughDate : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(throughDate)) {
      throw new Error('A valid date range is required')
    }

    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user } } = await client.auth.getUser()
    if (!user) return Response.json({ error: 'Invalid session' }, { status: 401, headers })

    const ledger = await client.rpc('admin_financial_ledger', {
      from_date: fromDate,
      through_date: throughDate,
    })
    if (ledger.error) throw ledger.error
    if (ledger.data.length > 10000) throw new Error('The report is too large; choose a shorter date range')

    const fields = ['event_at', 'event_type', 'submission_id', 'order_id', 'student_id', 'reference_number', 'gross_centavos', 'refund_centavos', 'net_centavos']
    const lines = [fields.map(csvCell).join(',')]
    for (const row of ledger.data) lines.push(fields.map((field) => csvCell(row[field])).join(','))

    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        ...headers,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="financial-ledger-${fromDate}-to-${throughDate}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to export report'
    return Response.json({ error: message }, { status: 403, headers })
  }
})
