import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { supabase, supabasePublishableKey, supabaseUrl } from '../lib/supabase'
import { formatCentavos, formatManilaDate, formatManilaDateTime, statusLabel } from '../lib/payment'
import { useResource, type ResourceResult } from '../lib/useResource'

type StudentView = {
  courseId: string | null
  students: StudentRow[]
}

type StudentRow = {
  user_id: string
  full_name: string
  preferred_language: string
  account_status: string
  created_at: string
  enrollment_status: string | null
  enrollment_id: string | null
  granted_at: string | null
  pending_payments: number
  latest_payment_status: string | null
  latest_amount_centavos: number | null
}

const defaultReportThroughDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
const defaultReportFromDate = new Date(new Date().getTime() - 29 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })

export function AdminStudents() {
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  const fetcher = useCallback(async (): Promise<ResourceResult<StudentView>> => {
    const { data: course } = await supabase.from('courses').select('id').eq('slug', 'logistics-101').maybeSingle()
    if (!course) return { value: { courseId: null, students: [] }, error: 'Course not found.' }

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id,full_name,preferred_language,account_status,created_at')
      .order('created_at', { ascending: false })

    if (error) return { value: { courseId: course.id, students: [] }, error: error.message }

    const [enrollmentResult, orderResult, submissionResult] = await Promise.all([
      supabase.from('enrollments').select('id,user_id,status,granted_at').eq('course_id', course.id),
      supabase.from('orders').select('id,user_id,price_centavos'),
      supabase.from('payment_submissions').select('id,order_id,status,created_at'),
    ])

    const enrollments = enrollmentResult.data ?? []
    const orders = orderResult.data ?? []
    const submissions = submissionResult.data ?? []
    // A submission has no user column of its own; ownership is reached through
    // the order it belongs to.
    const ownerOfOrder = new Map(orders.map((order) => [order.id, order.user_id]))
    const priceOfOrder = new Map(orders.map((order) => [order.id, order.price_centavos]))

    const students: StudentRow[] = ((profiles ?? []) as {
      id: string
      full_name: string
      preferred_language: string
      account_status: string
      created_at: string
    }[]).map((profile) => {
      const enrollment = enrollments.find((row) => row.user_id === profile.id) ?? null
      const own = submissions.filter((row) => ownerOfOrder.get(row.order_id) === profile.id)
      const latest = own.reduce<(typeof own)[number] | null>(
        (newest, row) => (!newest || row.created_at > newest.created_at ? row : newest),
        null,
      )
      return {
        user_id: profile.id,
        full_name: profile.full_name,
        preferred_language: profile.preferred_language,
        account_status: profile.account_status,
        created_at: profile.created_at,
        enrollment_status: enrollment?.status ?? null,
        enrollment_id: enrollment?.id ?? null,
        granted_at: enrollment?.granted_at ?? null,
        pending_payments: own.filter(
          (row) => row.status === 'pending' || row.status === 'resubmission_required',
        ).length,
        latest_payment_status: latest?.status ?? null,
        latest_amount_centavos: latest ? priceOfOrder.get(latest.order_id) ?? null : null,
      }
    })

    return { value: { courseId: course.id, students }, error: '' }
  }, [])

  const { value, error, loading, reload } = useResource(fetcher, { courseId: null, students: [] })
  const courseId = value.courseId
  const students = value.students

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return students
    return students.filter(
      (student) => student.full_name.toLowerCase().includes(term) || student.user_id.includes(term),
    )
  }, [search, students])

  const grantEnrollment = useCallback(
    async (userId: string, grantKind: 'complimentary' | 'external_payment') => {
      if (!courseId) return
      const reason = window.prompt(
        'Reason for this manual grant. It is written to the audit log and appears in enrollment history.',
      )
      if (!reason || reason.trim().length < 3) return
      setBusy(true)
      const { error: actionError } = await supabase.rpc('grant_manual_enrollment', {
        target_user: userId,
        target_course: courseId,
        grant_kind: grantKind,
        reason: reason.trim(),
      })
      setBusy(false)
      setMessage(
        actionError
          ? actionError.message
          : 'Manual enrollment granted and audited. No payment record was fabricated, so this does not inflate revenue reporting.',
      )
      await reload()
    },
    [courseId, reload],
  )

  const setEnrollmentAccess = useCallback(
    async (enrollmentId: string, status: string, reason: string) => {
      setBusy(true)
      const { error: actionError } = await supabase.rpc('set_enrollment_access', {
        target_enrollment: enrollmentId,
        new_status: status,
        reason,
      })
      setBusy(false)
      setMessage(actionError ? actionError.message : `Enrollment ${statusLabel(status).toLowerCase()} and audited.`)
      await reload()
    },
    [reload],
  )

  const setAccountStatus = useCallback(
    async (userId: string, status: string, reason: string) => {
      setBusy(true)
      const { error: actionError } = await supabase.rpc('set_account_status', {
        target_user: userId,
        new_status: status,
        reason,
      })
      setBusy(false)
      setMessage(actionError ? actionError.message : `Account ${status}. Backend requests from existing sessions are refused.`)
      await reload()
    },
    [reload],
  )

  const counts = useMemo(
    () => ({
      students: students.length,
      active: students.filter((student) => student.enrollment_status === 'active').length,
      pending: students.reduce((total, student) => total + student.pending_payments, 0),
      suspended: students.filter((student) => student.account_status === 'suspended').length,
    }),
    [students],
  )

  return (
    <div className="page">
      <p className="eyebrow">Administration</p>
      <h1>Students.</h1>

      <section className="metric-row">
        <div><strong>{counts.students}</strong><small>registered students</small></div>
        <div><strong>{counts.active}</strong><small>active enrollments</small></div>
        <div><strong>{counts.pending}</strong><small>payments needing review</small></div>
        <div><strong>{counts.suspended}</strong><small>suspended accounts</small></div>
      </section>

      <label className="field">
        <span>Search by name or user id</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" />
      </label>

      {(message || error) && <p className="status">{message || error}</p>}
      {loading && <p className="status" role="status">Loading students…</p>}

      {!loading && filtered.length === 0 && (
        <div className="empty"><h2>No matching students</h2><p>Adjust the search.</p></div>
      )}

      <div className="table-list">
        {filtered.map((student) => (
          <article key={student.user_id}>
            <div>
              <strong>{student.full_name}</strong>
              <p>
                {statusLabel(student.preferred_language)} · account {statusLabel(student.account_status)}
              </p>
              <small>
                Registered {formatManilaDate(student.created_at)}
                {student.granted_at && ` · enrolled ${formatManilaDate(student.granted_at)}`}
              </small>
              {student.latest_payment_status && (
                <p>
                  Latest payment {statusLabel(student.latest_payment_status)}
                  {student.latest_amount_centavos !== null && ` · ${formatCentavos(student.latest_amount_centavos)}`}
                  {student.pending_payments > 0 && ` · ${student.pending_payments} awaiting review`}
                </p>
              )}
            </div>
            <div className="row-actions">
              {student.enrollment_status === 'active' ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Reason for suspending this enrollment.')
                    if (reason && reason.trim().length >= 3) {
                      void setEnrollmentAccess(student.enrollment_id!, 'suspended', reason.trim())
                    }
                  }}
                >
                  Suspend access
                </button>
              ) : student.enrollment_status ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Reason for reinstating this enrollment.')
                    if (reason && reason.trim().length >= 3) {
                      void setEnrollmentAccess(student.enrollment_id!, 'active', reason.trim())
                    }
                  }}
                >
                  Reinstate
                </button>
              ) : (
                <>
                  <button className="secondary" disabled={busy} onClick={() => void grantEnrollment(student.user_id, 'external_payment')}>
                    Grant access (paid elsewhere)
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => void grantEnrollment(student.user_id, 'complimentary')}>
                    Grant complimentary access
                  </button>
                </>
              )}
              {student.account_status === 'active' ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Reason for suspending this account.')
                    if (reason && reason.trim().length >= 3) {
                      void setAccountStatus(student.user_id, 'suspended', reason.trim())
                    }
                  }}
                >
                  Suspend account
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Reason for reinstating this account.')
                    if (reason && reason.trim().length >= 3) {
                      void setAccountStatus(student.user_id, 'active', reason.trim())
                    }
                  }}
                >
                  Restore account
                </button>
              )}
              {student.pending_payments > 0 && (
                <Link className="secondary" to="/admin/payments">Review payments</Link>
              )}
            </div>
          </article>
        ))}
      </div>

      <p className="fine">
        Suspending an account takes effect at the database, not just in this interface: protected
        operations check account status on every call, so an already-issued session stops working.
        Trigger a password reset from the Supabase dashboard rather than here; passwords are never
        retrieved or displayed.
      </p>
    </div>
  )
}

export function AdminReports() {
  const [rows, setRows] = useState<{
    event_at: string
    event_type: string
    submission_id: string
    order_id: string
    student_id: string
    reference_number: string
    gross_centavos: number
    refund_centavos: number
    net_centavos: number
  }[]>([])
  const [fromDate, setFromDate] = useState(defaultReportFromDate)
  const [throughDate, setThroughDate] = useState(defaultReportThroughDate)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_financial_ledger', {
      from_date: fromDate,
      through_date: throughDate,
    })
    setRows(data ?? [])
    setMessage(error?.message ?? '')
    setLoading(false)
  }, [fromDate, throughDate])

  useEffect(() => {
    let current = true
    void supabase.rpc('admin_financial_ledger', {
      from_date: defaultReportFromDate,
      through_date: defaultReportThroughDate,
    }).then(({ data, error }) => {
      if (!current) return
      setRows(data ?? [])
      setMessage(error?.message ?? '')
      setLoading(false)
    })
    return () => { current = false }
  }, [])

  const exportCsv = async () => {
    setMessage('')
    const session = await supabase.auth.getSession()
    const token = session.data.session?.access_token
    if (!token) { setMessage('Your session expired. Sign in again.'); return }
    const response = await fetch(`${supabaseUrl}/functions/v1/admin-report-csv`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: supabasePublishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDate, throughDate }),
    })
    if (!response.ok) { setMessage('CSV export failed. Check the date range and your administrator session.'); return }
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = `financial-ledger-${fromDate}-to-${throughDate}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const totals = useMemo(
    () =>
      rows.reduce(
        (sum, row) => ({
          approved: sum.approved + row.gross_centavos,
          refunded: sum.refunded + row.refund_centavos,
        }),
        { approved: 0, refunded: 0 },
      ),
    [rows],
  )

  return (
    <div className="page">
      <p className="eyebrow">Administration</p>
      <h1>Revenue reporting.</h1>

      <div className="filter-bar">
        <label className="field"><span>From date (Manila)</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label className="field"><span>Through date (Manila)</span><input type="date" value={throughDate} onChange={(event) => setThroughDate(event.target.value)} /></label>
        <button className="secondary" onClick={() => void load()}>Refresh</button>
        <button className="secondary" onClick={() => void exportCsv()}>Export CSV</button>
      </div>

      {message && <p className="status">{message}</p>}
      {loading && <p className="status">Loading reviewed payments…</p>}

      <section className="metric-row">
        <div><strong>{formatCentavos(totals.approved)}</strong><small>approved</small></div>
        <div><strong>{formatCentavos(totals.refunded)}</strong><small>refunded</small></div>
        <div><strong>{formatCentavos(totals.approved - totals.refunded)}</strong><small>net</small></div>
      </section>

      <div className="table-list">
        {rows.map((row) => (
          <article key={`${row.submission_id}-${row.event_type}-${row.event_at}`}>
            <div>
              <strong>{row.event_type === 'refund' ? 'Refund' : 'Approval'} · {row.reference_number}</strong>
              <p>
                Order {row.order_id.slice(0, 8)} · student {row.student_id.slice(0, 8)}
              </p>
              <small>{formatManilaDateTime(row.event_at)}</small>
            </div>
            <div>
              {formatCentavos(row.net_centavos)}
              <small>net event</small>
            </div>
          </article>
        ))}
      </div>

      <p className="fine">
        Refunds are recorded as completed external reconciliations. Marking a payment refunded never
        moves money and never silently revokes an enrollment that another valid payment supports.
        Manual grants are excluded because they represent no revenue. Date boundaries use Asia/Manila,
        and CSV cells are escaped server-side to prevent spreadsheet formula execution.
      </p>
    </div>
  )
}

export function AdminAudit() {
  const [rows, setRows] = useState<{
    id: number
    actor_id: string | null
    action: string
    target_type: string
    target_id: string
    reason: string | null
    created_at: string
  }[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id,actor_id,action,target_type,target_id,reason,created_at')
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) setMessage(error.message)
      else {
        setRows(data ?? [])
        setMessage('')
      }
      setLoading(false)
    })()
  }, [])

  return (
    <div className="page">
      <p className="eyebrow">Administration</p>
      <h1>Audit log.</h1>
      <p className="lede">Privileged actions only. Payment evidence and secrets are never stored here.</p>

      {message && <p className="status">{message}</p>}
      {loading && <p className="status">Loading audit records…</p>}

      <div className="table-list">
        {rows.map((row) => (
          <article key={row.id}>
            <div>
              <strong>{row.action}</strong>
              <p>
                {row.target_type} {row.target_id.slice(0, 8)}
                {row.actor_id && ` · by ${row.actor_id.slice(0, 8)}`}
              </p>
              {row.reason && <p>{row.reason}</p>}
            </div>
            <div><small>{formatManilaDateTime(row.created_at)}</small></div>
          </article>
        ))}
      </div>
    </div>
  )
}
