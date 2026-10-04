import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'

import { formatManilaDateTime } from '../lib/payment'
import { describeLanguages } from '../lib/language'
import { Loading, PageMeta } from '../components/ui'
import { useCertificateIssuance, useEnrolledCourse, useModuleRows, useProgress } from './hooks'

export function LearnCourse() {
  const { courseId } = useParams()
  const { enrollment, courseId: activeCourseId, courseTitle, loading, message } = useEnrolledCourse(courseId)
  const { progress, error: progressError } = useProgress(enrollment?.id ?? null)
  const { modules, loading: modulesLoading, error: modulesError } = useModuleRows(enrollment?.id ?? null, activeCourseId)

  const requiredModules = useMemo(() => modules.filter((row) => row.enrollment_required), [modules])
  const allRequiredComplete = (progress?.required_complete ?? 0) >= (progress?.required_total ?? 1) && requiredModules.length > 0
  const {
    certificate,
    enabled: certificateEnabled,
    working: certificateLoading,
    failed: certificateFailed,
    message: certificateMessage,
    blockers: certificateBlockers,
    eligibility: certificateEligibility,
    issue: generateCertificate,
    view: viewCertificate,
    download: downloadCertificate,
  } = useCertificateIssuance(enrollment, allRequiredComplete)

  // The server is the single source of truth for the certificate curriculum, so
  // the panel reports its counts rather than recomputing them from the module
  // list, which also includes optional modules.
  const certificateRequiredTotal =
    certificateEligibility?.required_module_count ?? requiredModules.length
  const certificateRequiredScore = certificateEligibility?.required_score ?? 75

  if (loading)
    return (
      <Page>
        <PageMeta title="Your course" description="Your Logistics 101 modules and progress." noIndex />
        <Loading label="Loading your course…" />
      </Page>
    )
  if (!enrollment) {
    return (
      <Page>
        <p className="eyebrow">Learning</p>
        <h1>{courseTitle}</h1>
        <div className="empty">
          <h2>No active enrollment</h2>
          <p>{message || 'Payment approval or an audited manual grant unlocks this course.'}</p>
          <Link className="button" to="/checkout/logistics-101">Payment and checkout</Link>
        </div>
      </Page>
    )
  }

  const scopedCourseId = courseId ?? activeCourseId

  return (
    <Page>
      <PageMeta title={courseTitle} description="Your Logistics 101 modules and progress." noIndex />
      <p className="eyebrow">Learning</p>
      <h1>{courseTitle}</h1>
      <p className="lede">
        Lifetime access from approval. Progress is stored per module, not per language, so switching
        between English and Bisaya never creates a second enrollment or resets your work.
      </p>

      {(progressError || modulesError) && <div className="notice">{progressError || modulesError}</div>}

      <section className="progress-panel" aria-label="Course progress">
        <div>
          <span className="progress-figure">{progress ? progress.percent_studied : 0}%</span>
          <small>
            lessons studied · {progress?.required_studied ?? 0} of {progress?.required_total ?? requiredModules.length}{' '}
            required modules
          </small>
        </div>
        <progress value={progress?.percent_studied ?? 0} max={100}>
          {progress?.percent_studied ?? 0}%
        </progress>
        <div>
          <span className="progress-figure">{progress ? progress.percent_complete : 0}%</span>
          <small>
            overall completion · {progress?.required_complete ?? 0} of {progress?.required_total ?? requiredModules.length}{' '}
            required modules complete
          </small>
        </div>
        <progress value={progress?.percent_complete ?? 0} max={100}>
          {progress?.percent_complete ?? 0}%
        </progress>
        <p className="fine">
          Studying a lesson is recorded separately from completing a module. A module completes only
          once its lesson is studied and its knowledge check is submitted, so 100% studied can still
          leave knowledge checks outstanding.
        </p>
        <p className="fine">
          {progress?.final_unlocked
            ? 'All required modules are complete. The final assessment is available.'
            : 'The final assessment stays locked until every required module is complete.'}
        </p>
      </section>

      {modulesLoading && <p className="status">Loading modules…</p>}

      {!modulesLoading && modules.length === 0 && (
        <div className="empty">
          <h2>Lessons not published yet</h2>
          <p>
            Your payment is approved and this enrollment is active, but no lesson materials
            have been published for this course yet. This is a publishing gap on the academy
            side, not a missing payment. Your access is recorded and the modules will appear
            here as soon as they are released.
          </p>
          <p>
            Your enrollment is active and your place in the course is recorded. Lessons appear
            here as soon as the academy publishes them, and studying a module still records your
            progress, so nothing you complete here is lost.
          </p>
          <Link className="secondary" to="/dashboard">Back to your courses</Link>
        </div>
      )}

      <ol className="module-list">
        {modules.map((row) => {
          const fallbackTitle = row.titles.en ?? row.titles.ceb ?? `Module ${row.position}`
          const available = Object.entries(row.titles)
          return (
            <li key={row.id} className={row.completed_at ? 'complete' : undefined}>
              <div>
                <span className="module-position">Module {row.position}</span>
                <h2>{fallbackTitle}</h2>
                <p className="fine">
                  {row.enrollment_required ? 'Required' : 'Optional'} · curriculum v{row.curriculum_version}
                  {row.completed_at && ' · complete'}
                  {!row.material_available && ' · material not published'}
                </p>
                {available.length > 0 && (
                  <p className="fine">Available in {describeLanguages(available.map(([code]) => code))}</p>
                )}
                {row.completed_at && <small>Completed {formatManilaDateTime(row.completed_at)}</small>}
              </div>
              <Link className="secondary" to={`/learn/${scopedCourseId}/modules/${row.id}`}>
                {row.completed_at ? 'Review module' : 'Open module'}
              </Link>
            </li>
          )
        })}
      </ol>

      <section className="final-quiz-entry">
        <h2>Final assessment</h2>
        <p>
          The final quiz is server-gated. Attempts, the 75% pass mark and the question set are all
          decided by trusted database operations, never by the browser.
        </p>
        <Link className="button" to={`/learn/${scopedCourseId}/final-quiz`}>
          Go to the final quiz
        </Link>
      </section>

      <section className="final-quiz-entry">
        <h2>Certificate</h2>
        {certificate?.status === 'active' ? <>
          <p>Certificate <strong>{certificate.verification_id}</strong> is ready. Viewing uses a private five-minute link.</p>
          <div className="actions">
            <button className="button" disabled={certificateLoading} onClick={viewCertificate}>View certificate</button>
            <button className="button" disabled={certificateLoading} onClick={downloadCertificate}>Download certificate</button>
            <Link className="secondary" to={`/verify/${certificate.verification_id}`}>Open public verification</Link>
          </div>
        </> : certificateEnabled ? <>
          <p>
            Your certificate covers {certificateRequiredTotal} approved modules and is issued
            automatically once every one of them is complete and the final assessment is passed at{' '}
            {certificateRequiredScore}% or higher. You can only ever receive one certificate per
            enrollment.
          </p>
          {certificateBlockers.length > 0 ? <ul className="status">{certificateBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            : certificateFailed ? <>
              <p className="status">Automatic issuance could not finish. You can retry without losing your result.</p>
              <button className="button" disabled={certificateLoading} onClick={generateCertificate}>{certificateLoading ? 'Issuing…' : 'Retry issuance'}</button>
            </>
            : certificateLoading ? <p className="status">Issuing your certificate now…</p>
            : <p className="status">Everything is complete. Your certificate will appear here on its own.</p>}
        </> : <>
          <p className="status">Certificate issuance is not enabled for this course yet.</p>
        </>}
        {certificateMessage && <p className="status">{certificateMessage}</p>}
      </section>
    </Page>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="page">{children}</div>
}
