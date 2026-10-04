import { createClient } from 'npm:@supabase/supabase-js@2'

type ClaimedEmail = {
  id: string
  idempotency_key: string
  template: string
  recipient_user_id: string
  payload: Record<string, unknown>
  attempt: number
  lock_token: string
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

class PermanentEmailError extends Error {}

function render(template: string, payload: Record<string, unknown>, appOrigin: string) {
  const courseName = String(payload.course_title ?? 'Logistics 101')
  const course = escapeHtml(courseName)
  const dashboardUrl = `${appOrigin}/dashboard`
  const templates: Record<string, { subject: string; html: string; text: string }> = {
    enrollment_approved: {
      subject: `Your ${courseName} enrollment is ready`,
      html: `<p>Your enrollment is approved.</p><p><a href="${dashboardUrl}">Open your student dashboard</a></p>`,
      text: `Your enrollment is approved. Open your student dashboard: ${dashboardUrl}`,
    },
    manual_enrollment: {
      subject: `You now have access to ${courseName}`,
      html: `<p>Academy staff granted your enrollment to ${course}.</p><p><a href="${dashboardUrl}">Open your student dashboard</a></p>`,
      text: `Academy staff granted your enrollment to ${courseName}. Open your student dashboard: ${dashboardUrl}`,
    },
    certificate_ready: {
      subject: 'Your course certificate is ready',
      html: `<p>Your certificate is ready in your learning dashboard.</p><p><a href="${dashboardUrl}">Open your dashboard</a></p>`,
      text: `Your certificate is ready in your learning dashboard: ${dashboardUrl}`,
    },
    refund_completed: {
      subject: 'Your refund record was updated',
      html: `<p>The academy recorded the completed external refund.</p><p><a href="${dashboardUrl}">Review your account</a></p>`,
      text: `The academy recorded the completed external refund. Review your account: ${dashboardUrl}`,
    },
  }
  const result = templates[template]
  if (!result) throw new PermanentEmailError(`Unsupported email template: ${template}`)
  return result
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })
  const workerSecret = Deno.env.get('EMAIL_WORKER_SECRET')
  if (!workerSecret || request.headers.get('authorization') !== `Bearer ${workerSecret}`) {
    return Response.json({ error: 'Worker authentication required' }, { status: 401 })
  }

  const provider = Deno.env.get('EMAIL_PROVIDER')
  const apiKey = Deno.env.get('EMAIL_PROVIDER_API_KEY')
  const from = Deno.env.get('EMAIL_FROM')
  const appOrigin = Deno.env.get('PUBLIC_APP_ORIGIN')
  if (provider !== 'resend' || !apiKey || !from || !appOrigin) {
    return Response.json({ error: 'Email provider, verified sender, and public origin are not configured' }, { status: 503 })
  }

  let normalizedOrigin: string
  try {
    const parsedOrigin = new URL(appOrigin)
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== appOrigin.replace(/\/$/, '')) {
      throw new Error('origin must not include a path')
    }
    normalizedOrigin = parsedOrigin.origin
  } catch {
    return Response.json({ error: 'Public application origin is invalid' }, { status: 503 })
  }

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const claim = await service.rpc('claim_email_outbox', { worker_name: 'email-outbox-worker', batch_size: 10 })
  if (claim.error) return Response.json({ error: 'Unable to claim email work' }, { status: 503 })

  const results = []
  for (const item of claim.data as ClaimedEmail[]) {
    try {
      const identity = await service.auth.admin.getUserById(item.recipient_user_id)
      const email = identity.data.user?.email
      if (identity.error) throw new Error('Unable to load the recipient identity')
      if (!email || !identity.data.user?.email_confirmed_at) {
        throw new PermanentEmailError('Recipient does not have a verified email address')
      }
      const content = render(item.template, item.payload, normalizedOrigin)
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': item.idempotency_key,
        },
        body: JSON.stringify({ from, to: [email], subject: content.subject, html: content.html, text: content.text }),
      })
      const providerResult = await response.json().catch(() => ({})) as { id?: string; message?: string }
      if (!response.ok || !providerResult.id) {
        const retryable = response.status === 429 || response.status >= 500
        const finalized = await service.rpc('mark_email_failed', {
          target_outbox: item.id,
          worker_token: item.lock_token,
          failure: providerResult.message ?? `Provider returned ${response.status}`,
          retryable,
        })
        if (finalized.error) throw new Error('Unable to finalize the provider failure')
        results.push({ id: item.id, status: retryable ? 'retry_scheduled' : 'failed' })
        continue
      }
      const finalized = await service.rpc('mark_email_sent', {
        target_outbox: item.id,
        worker_token: item.lock_token,
        provider_id: providerResult.id,
      })
      if (finalized.error) throw new Error('Provider accepted the email but database finalization failed')
      results.push({ id: item.id, status: 'sent' })
    } catch (error) {
      const retryable = !(error instanceof PermanentEmailError)
      const finalized = await service.rpc('mark_email_failed', {
        target_outbox: item.id,
        worker_token: item.lock_token,
        failure: error instanceof Error ? error.message : 'Email processing failed',
        retryable,
      })
      results.push({
        id: item.id,
        status: finalized.error ? 'finalization_failed' : retryable ? 'retry_scheduled' : 'failed',
      })
    }
  }

  return Response.json({ processed: results.length, results })
})
