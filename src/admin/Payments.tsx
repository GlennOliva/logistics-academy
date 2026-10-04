import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { supabase } from '../lib/supabase'
import { formatCentavos, formatManilaDateTime, statusLabel, validateProofFile } from '../lib/payment'
import { useResource, type ResourceResult } from '../lib/useResource'
import type { PaymentMethod, PaymentSubmission } from '../lib/types'

type QueueRow = PaymentSubmission & {
  order_amount_centavos: number
  course_title: string
  method_type: string
  method_display: string
  student_name: string
  revision_count: number
}

export function AdminPayments() {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')

  const fetcher = useCallback(async (): Promise<ResourceResult<QueueRow[]>> => {
    let query = supabase
      .from('payment_submissions')
      .select(
        'id,order_id,payment_method_id,status,reference_number,submitted_amount_centavos,transaction_at,created_at,reviewed_at,review_reason',
      )
      .order('created_at', { ascending: false })

    if (filter === 'pending') query = query.in('status', ['pending', 'resubmission_required'])

    const { data, error } = await query
    if (error) return { value: [], error: error.message }

    const submissions = data ?? []
    if (submissions.length === 0) return { value: [], error: '' }

    const orderIds = [...new Set(submissions.map((row) => row.order_id))]
    const methodIds = [...new Set(submissions.map((row) => row.payment_method_id))]

    const [orderResult, methodResult, revisionResult] = await Promise.all([
      supabase.from('orders').select('id,user_id,price_centavos,course_id').in('id', orderIds),
      supabase.from('payment_methods').select('id,type,display_name').in('id', methodIds),
      supabase
        .from('payment_proof_revisions')
        .select('submission_id')
        .in('submission_id', submissions.map((row) => row.id)),
    ])

    const orders = new Map((orderResult.data ?? []).map((row) => [row.id, row]))
    const methods = new Map((methodResult.data ?? []).map((row) => [row.id, row]))
    const courseIds = [...new Set((orderResult.data ?? []).map((row) => row.course_id))]
    const userIds = [...new Set((orderResult.data ?? []).map((row) => row.user_id))]

    const [courseResult, profileResult] = await Promise.all([
      courseIds.length > 0
        ? supabase.from('courses').select('id,title').in('id', courseIds)
        : Promise.resolve({ data: [] as { id: string; title: string }[], error: null }),
      userIds.length > 0
        ? supabase.from('profiles').select('id,full_name').in('id', userIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string }[], error: null }),
    ])

    const courses = new Map((courseResult.data ?? []).map((row) => [row.id, row.title]))
    const profiles = new Map((profileResult.data ?? []).map((row) => [row.id, row.full_name]))

    // One grouped read instead of a count query per submission.
    const revisionCounts = new Map<string, number>()
    for (const revision of revisionResult.data ?? []) {
      revisionCounts.set(revision.submission_id, (revisionCounts.get(revision.submission_id) ?? 0) + 1)
    }

    const rows = submissions.map((submission) => {
      const order = orders.get(submission.order_id)
      const method = methods.get(submission.payment_method_id)
      return {
        ...(submission as QueueRow),
        order_amount_centavos: order?.price_centavos ?? 0,
        course_title: (order && courses.get(order.course_id)) || 'Course',
        method_type: method?.type ?? '',
        method_display: method?.display_name ?? '',
        student_name: (order && profiles.get(order.user_id)) || 'Student',
        revision_count: revisionCounts.get(submission.id) ?? 0,
      }
    })

    return { value: rows, error: '' }
  }, [filter])

  const { value: rows, error, loading, loaded, reload } = useResource(fetcher, [])

  const pendingCount = useMemo(
    () => rows.filter((row) => row.status === 'pending' || row.status === 'resubmission_required').length,
    [rows],
  )

  return (
    <div className="page">
      <p className="eyebrow">Administration</p>
      <h1>Payment review queue.</h1>
      <p className="lede">
        Compare each submission against actual receipt in the configured account. A screenshot is
        never sufficient on its own.
      </p>

      <div className="filter-bar">
        <label className="field">
          <span>Queue</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as 'pending' | 'all')}>
            <option value="pending">Needs a decision</option>
            <option value="all">All submissions</option>
          </select>
        </label>
        <p className="fine">
          {pendingCount} submission{pendingCount === 1 ? '' : 's'} in this view still need a decision.
        </p>
      </div>

      {error && <p className="status">{error}</p>}
      {loading && <p className="status" role="status">Loading submissions…</p>}
      {!loading && rows.length === 0 && !error && (
        <div className="empty">
          <h2>Queue is clear</h2>
          <p>No submissions are waiting for a decision.</p>
        </div>
      )}
      {loaded && rows.length > 0 && (
        <button className="secondary" onClick={() => void reload()} disabled={loading}>
          Refresh queue
        </button>
      )}

      <div className="table-list">
        {rows.map((row) => {
          const mismatch = row.submitted_amount_centavos !== row.order_amount_centavos
          const open = row.status === 'pending' || row.status === 'resubmission_required'
          return (
            <article key={row.id}>
              <div>
                <strong>{statusLabel(row.status)}</strong>
                <p>{row.student_name} · {row.course_title}</p>
                <p>
                  {row.method_display} · reference {row.reference_number} ·{' '}
                  {row.revision_count} proof revision{row.revision_count === 1 ? '' : 's'}
                </p>
                <small>Submitted {formatManilaDateTime(row.created_at)}</small>
                {row.review_reason && <p>{row.review_reason}</p>}
              </div>
              <div>
                {formatCentavos(row.submitted_amount_centavos)}
                <small>order {formatCentavos(row.order_amount_centavos)}</small>
              </div>
              <div>
                {mismatch && <p className="error">Amount differs from the order</p>}
                <Link className="secondary" to={`/admin/payments/${row.id}`}>
                  {open ? 'Review' : 'Inspect'}
                </Link>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

type DetailValue = {
  submission: PaymentSubmission | null
  orderAmount: number | null
  proofUrl: string
  proofNote: string
  amountWarning: string
}

export function AdminPaymentDetail() {
  const { id = '' } = useParams()
  const [decision, setDecision] = useState('')
  const [reason, setReason] = useState('')
  const [refundReference, setRefundReference] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [refundCompletedAt, setRefundCompletedAt] = useState('')
  const [refundConfirmed, setRefundConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState('')

  const fetcher = useCallback(async (): Promise<ResourceResult<DetailValue>> => {
    const empty: DetailValue = { submission: null, orderAmount: null, proofUrl: '', proofNote: '', amountWarning: '' }
    if (!id) return { value: empty, error: 'Submission not found.' }

    const { data, error } = await supabase
      .from('payment_submissions')
      .select(
        'id,order_id,payment_method_id,status,reference_number,submitted_amount_centavos,transaction_at,created_at,reviewed_at,review_reason',
      )
      .eq('id', id)
      .maybeSingle()

    if (error || !data) return { value: empty, error: error?.message ?? 'Submission not available.' }

    const [{ data: order }, { data: revisions }] = await Promise.all([
      supabase.from('orders').select('price_centavos,course_id').eq('id', data.order_id).maybeSingle(),
      supabase
        .from('payment_proof_revisions')
        .select('object_path,original_filename,mime_type,size_bytes,revision,created_at')
        .eq('submission_id', id)
        .order('revision', { ascending: false }),
    ])

    let proofUrl = ''
    let proofNote = 'No proof revision recorded.'
    const latest = revisions?.[0]
    if (latest) {
      // The link is short-lived and minted per view, so an expired or shared
      // screenshot cannot be replayed later.
      const signed = await supabase.storage.from('payment-proofs').createSignedUrl(latest.object_path, 300)
      if (signed.error) {
        proofNote = signed.error.message
      } else {
        proofUrl = signed.data.signedUrl
        proofNote = `Revision ${latest.revision} · ${latest.original_filename} · ${Math.ceil(latest.size_bytes / 1024)} KB · link expires in 5 minutes`
      }
    }

    return {
      value: {
        submission: data as PaymentSubmission,
        orderAmount: order?.price_centavos ?? null,
        proofUrl,
        proofNote,
        amountWarning:
          order && data.submitted_amount_centavos !== order.price_centavos
            ? `Submitted ${formatCentavos(data.submitted_amount_centavos)} does not match the order ${formatCentavos(order.price_centavos)}. Reconcile outside this queue before approving.`
            : '',
      },
      error: '',
    }
  }, [id])

  const { value, error, loading, reload } = useResource(fetcher, {
    submission: null,
    orderAmount: null,
    proofUrl: '',
    proofNote: '',
    amountWarning: '',
  })
  const { submission, orderAmount, proofUrl, proofNote, amountWarning } = value

  const submitDecision = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!id) return
    setBusy(true)
    setConfirmation('')
    const { error: rpcError } = await supabase.rpc('review_payment', {
      target_submission: id,
      decision,
      reason: decision === 'approved' ? '' : reason,
    })
    setBusy(false)
    if (rpcError) {
      setConfirmation(rpcError.message)
      return
    }
    setDecision('')
    setReason('')
    await reload()
    setConfirmation(
      `Recorded as ${statusLabel(decision)}. Access, audit history and the confirmation email were written in one transaction.`,
    )
  }

  const reconcileRefund = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!submission || !refundConfirmed) return
    setBusy(true)
    setConfirmation('')
    const { error: rpcError } = await supabase.rpc('record_completed_refund', {
      target_submission: submission.id,
      actual_amount_centavos: submission.submitted_amount_centavos,
      external_completion_reference: refundReference.trim(),
      completion_time: new Date(refundCompletedAt).toISOString(),
      reason: refundReason.trim(),
      revoke_access: false,
    })
    setBusy(false)
    if (rpcError) { setConfirmation(rpcError.message); return }
    setConfirmation('External refund reconciled. Access and any issued certificate were retained pending an approved revocation policy.')
    await reload()
  }

  // The database owns the state machine. This only stops the interface from
  // offering a decision the trusted function would reject anyway.
  const decidable = submission?.status === 'pending' || submission?.status === 'resubmission_required'
  const amountMatches = orderAmount !== null && submission?.submitted_amount_centavos === orderAmount
  const canApprove = decidable && amountMatches
  const canDecide = canApprove || (decidable && reason.trim().length >= 3)

  return (
    <div className="page narrow">
      <p className="eyebrow">Private evidence</p>
      <h1>Review submission.</h1>

      <p className="status">{loading ? 'Loading submission…' : error || proofNote}</p>
      {(amountWarning || confirmation) && <div className="notice">{amountWarning || confirmation}</div>}

      {submission && (
        <div className="review-summary">
          <p>
            Reference <strong>{submission.reference_number}</strong> · {formatCentavos(submission.submitted_amount_centavos)} ·{' '}
            {statusLabel(submission.status)}
          </p>
          {submission.review_reason && <p>Previous reason: {submission.review_reason}</p>}
        </div>
      )}

      {proofUrl && (
        <p>
          <a className="button" href={proofUrl} target="_blank" rel="noreferrer">
            Open private proof
          </a>
        </p>
      )}

      {!decidable && submission && (
        <p className="status">
          This submission is already {statusLabel(submission.status).toLowerCase()}, so no further
          decision can be recorded. Repeating an approval would not grant a second enrollment or send
          another email.
        </p>
      )}

      <form onSubmit={submitDecision}>
        <label className="field">
          <span>Decision</span>
          <select
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
            required
            disabled={!decidable}
          >
            <option value="" disabled>Select a reviewed outcome</option>
            <option value="approved" disabled={!amountMatches}>
              Approve and grant access
            </option>
            <option value="resubmission_required">Request a better proof</option>
            <option value="rejected">Reject this submission</option>
          </select>
          {decidable && !amountMatches && (
            <small className="error">
              Approval is unavailable until the submitted amount matches the order.
            </small>
          )}
        </label>
        <label className="field">
          <span>Reason for the student</span>
          <textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required={decision !== '' && decision !== 'approved'}
            disabled={!decidable}
            placeholder="Explain what the student should correct. Required for anything other than approval."
          />
        </label>
        <button className="button" disabled={busy || !decision || !canDecide}>
          {busy ? 'Recording…' : 'Record reviewed outcome'}
        </button>
      </form>

      {submission?.status === 'approved' && (
        <form className="review-summary" onSubmit={reconcileRefund}>
          <h2>Reconcile a completed external refund</h2>
          <p>This does not move money. Continue only after the full {formatCentavos(submission.submitted_amount_centavos)} was returned outside the platform.</p>
          <label className="field"><span>External completion reference</span><input required minLength={3} value={refundReference} onChange={(event) => setRefundReference(event.target.value)} /></label>
          <label className="field"><span>External completion time</span><input required type="datetime-local" value={refundCompletedAt} onChange={(event) => setRefundCompletedAt(event.target.value)} /></label>
          <label className="field"><span>Reconciliation reason/evidence note</span><textarea required minLength={3} rows={3} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={refundConfirmed} onChange={(event) => setRefundConfirmed(event.target.checked)} /> I confirm the external provider shows this full refund as completed.</label>
          <button className="secondary" disabled={busy || !refundConfirmed || refundReference.trim().length < 3 || refundReason.trim().length < 3 || !refundCompletedAt}>Record completed refund</button>
        </form>
      )}

      <p className="fine">
        Approval runs in one trusted transaction: the payment and order are locked, the amount is
        reconciled, the enrollment is upserted, the audit record is written and a single idempotent
        confirmation is queued. Repeating an approval cannot duplicate access or send a second email.
        Review timestamps are stamped by the server, not the browser.
      </p>
    </div>
  )
}

export function StudentResubmit() {
  const { id = '' } = useParams()
  const [submission, setSubmission] = useState<PaymentSubmission | null>(null)
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [selectedMethodId, setSelectedMethodId] = useState('')
  const [message, setMessage] = useState('Loading…')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    void (async () => {
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('id,order_id,payment_method_id,status,reference_number,submitted_amount_centavos,transaction_at,created_at,reviewed_at,review_reason')
        .eq('id', id)
        .maybeSingle()
      if (error || !data) {
        setMessage(error?.message ?? 'Submission not available.')
        return
      }
      setSubmission(data as PaymentSubmission)
      const methodResult = await supabase
        .from('payment_methods')
        .select('id,type,display_name,destination_label,destination_details,instructions,qr_object_path')
        .eq('enabled', true)
        .order('display_name')
      const enabledMethods = (methodResult.data ?? []) as PaymentMethod[]
      setMethods(enabledMethods)
      setSelectedMethodId(
        enabledMethods.some((method) => method.id === data.payment_method_id)
          ? data.payment_method_id
          : '',
      )
      setMessage('')
    })()
  }, [id])

  const resubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!submission) return
      const form = new FormData(event.currentTarget)
      const proof = form.get('proof')
      if (!(proof instanceof File)) {
        setMessage('Choose a file.')
        return
      }
      const fileError = validateProofFile(proof)
      if (fileError) {
        setMessage(fileError)
        return
      }
      // The amount is fixed by the order, not by this form, so a tampered field
      // cannot change what the student is charged against.
      form.set('submissionId', submission.id)
      form.set('orderId', submission.order_id)
      form.set('amountCentavos', String(submission.submitted_amount_centavos))
      setBusy(true)
      setMessage('')
      const { data, error } = await supabase.functions.invoke('submit-payment-proof-resubmission', {
        body: form,
      })
      setBusy(false)
      setMessage(
        error
          ? error.message || 'Upload failed. Your access has not changed.'
          : `Replacement proof received as ${String((data as { status?: string })?.status ?? 'pending')}. The original proof and reviewer history are preserved.`,
      )
      if (!error) event.currentTarget.reset()
    },
    [submission],
  )

  if (!submission) {
    return (
      <div className="page narrow">
        <h1>Submission</h1>
        <p className="status">{message}</p>
        <Link className="secondary" to="/dashboard">Back to dashboard</Link>
      </div>
    )
  }

  const open = submission.status === 'resubmission_required'
  const selectedMethod = methods.find((method) => method.id === selectedMethodId)
  const qrUrl = selectedMethod?.qr_object_path
    ? supabase.storage.from('branding').getPublicUrl(selectedMethod.qr_object_path).data.publicUrl
    : ''

  return (
    <div className="page narrow">
      <p className="eyebrow">Payment review</p>
      <h1>Replace your proof.</h1>

      <div className="notice">
        Reference {submission.reference_number} is currently {statusLabel(submission.status)}.
        {submission.review_reason && ` Reason: ${submission.review_reason}`}
      </div>

      {!open && (
        <p className="status">
          This submission is not awaiting a replacement. Resubmissions are only accepted while the
          review is open.
        </p>
      )}

      {open && methods.length === 0 && (
        <div className="empty">
          <h2>No verified payment destination</h2>
          <p>Do not transfer funds. Genuine destination details are still required.</p>
        </div>
      )}

      {open && methods.length > 0 && (
        <form className="checkout-form" onSubmit={resubmit}>
          <div className="amount">
            <span>Amount to match</span>
            <strong>{formatCentavos(submission.submitted_amount_centavos)}</strong>
            <small>This must match the original order amount exactly.</small>
          </div>
          <label className="field">
            <span>Payment method</span>
            <select
              name="methodId"
              required
              value={selectedMethodId}
              onChange={(event) => setSelectedMethodId(event.target.value)}
            >
              <option value="" disabled>Select a verified method</option>
              {methods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.display_name} — {method.destination_label}: {method.destination_details}
                </option>
              ))}
            </select>
          </label>
          {selectedMethod && (
            <section className="payment-destination" aria-live="polite">
              <div>
                <small>{selectedMethod.destination_label}</small>
                <strong>{selectedMethod.destination_details}</strong>
                <p>{selectedMethod.instructions}</p>
              </div>
              {qrUrl && <img src={qrUrl} alt={`${selectedMethod.display_name} payment QR code`} />}
            </section>
          )}
          <label className="field">
            <span>New reference number</span>
            <input
              required
              name="referenceNumber"
              minLength={3}
              maxLength={100}
              defaultValue={submission.reference_number}
            />
          </label>
          <label className="field">
            <span>Transaction date and time</span>
            <input required name="transactionAt" type="datetime-local" />
          </label>
          <label className="field">
            <span>Replacement proof</span>
            <input required name="proof" type="file" accept="image/jpeg,image/png,application/pdf" />
            <small>JPG, PNG or PDF up to 10 MB. Contents are checked server-side.</small>
          </label>
          <button className="button full" disabled={busy}>
            {busy ? 'Validating and uploading…' : 'Submit replacement proof'}
          </button>
        </form>
      )}

      {message && <p className="status">{message}</p>}
      <Link className="secondary" to="/dashboard">Back to dashboard</Link>
    </div>
  )
}
