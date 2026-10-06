import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { supabase } from '../lib/supabase'
import { edgeFunctionFailure } from '../lib/edgeFunctionError'
import { formatManilaDateTime, statusLabel } from '../lib/payment'
import type { MaterialLinkResponse, QuizPayload, QuizResult } from '../lib/types'
import { LANGUAGE_LABEL } from '../lib/language'
import { useCertificateIssuance, useEnrolledCourse, useModuleRows, useProgress } from './hooks'

export function ModuleLesson() {
  const { moduleId, courseId } = useParams()
  const navigate = useNavigate()

  const { enrollment, courseId: activeCourseId, loading } = useEnrolledCourse(courseId)
  const { modules, loading: modulesLoading, reload } = useModuleRows(enrollment?.id ?? null, activeCourseId)
  const module = modules.find((row) => row.id === moduleId)

  const [chosenLanguage, setChosenLanguage] = useState<string>('')
  const [link, setLink] = useState<MaterialLinkResponse | null>(null)
  const [linkError, setLinkError] = useState('')
  const [opening, setOpening] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [studying, setStudying] = useState(false)
  const [actionMessage, setActionMessage] = useState('')

  // Derived rather than stored: if the published translation set changes, the
  // selection follows it instead of pointing at a language that vanished.
  const publishedLanguages = module ? (Object.keys(module.titles) as string[]) : []
  const language =
    chosenLanguage && publishedLanguages.includes(chosenLanguage)
      ? chosenLanguage
      : publishedLanguages[0] ?? ''

  const openMaterial = async () => {
    if (!moduleId) return
    const pendingWindow = window.open('', '_blank')
    if (pendingWindow) pendingWindow.opener = null
    setOpening(true)
    setLinkError('')
    setLink(null)
    const { data, error } = await supabase.functions.invoke('course-material-access', {
      body: { moduleId, language },
    })
    setOpening(false)
    if (error) {
      pendingWindow?.close()
      const failure = await edgeFunctionFailure(error, 'This material is not available right now.')
      if (failure.status === 401) {
        await supabase.auth.signOut({ scope: 'local' })
        navigate('/login', { replace: true })
        return
      }
      setAccessDenied(failure.status === 403)
      setLinkError(failure.message)
      return
    }
    const materialLink = data as MaterialLinkResponse
    setAccessDenied(false)
    setLink(materialLink)
    if (pendingWindow) pendingWindow.location.replace(materialLink.url)
  }

  const markStudied = async () => {
    if (!moduleId) return
    setStudying(true)
    setActionMessage('')
    const { error } = await supabase.rpc('mark_module_studied', { target_module: moduleId })
    setStudying(false)
    if (error) {
      setActionMessage(error.message)
      return
    }
    setActionMessage('Lesson recorded as studied.')
    await reload()
  }

  if (loading || modulesLoading) return <div className="page"><p className="status">Loading module…</p></div>

  if (!enrollment) {
    return (
      <div className="page">
        <h1>No active enrollment</h1>
        <p>Payment approval or an audited manual grant is required before course materials open.</p>
        <Link className="button" to="/dashboard">Back to dashboard</Link>
      </div>
    )
  }

  if (!module) {
    return (
      <div className="page">
        <h1>Module unavailable</h1>
        <p>
          This module is not part of your approved curriculum, or it is not published. Both are
          decided server-side, so a crafted URL cannot open unentitled content.
        </p>
        <button className="secondary" onClick={() => navigate(`/learn/${courseId ?? activeCourseId}`)}>
          Back to course
        </button>
      </div>
    )
  }

  const fallbackTitle = module.titles.en ?? module.titles.ceb ?? `Module ${module.position}`
  const available = Object.keys(module.titles) as ('en' | 'ceb')[]

  return (
    <div className="page">
      <p className="eyebrow">Module {module.position}</p>
      <h1>{fallbackTitle}</h1>
      <p className="fine">
        {module.enrollment_required ? 'Required module' : 'Optional module'} · curriculum v
        {module.curriculum_version} · {statusLabel(module.status)}
      </p>

      <section className="lesson-status" aria-label="Module completion status">
        <ul>
          <li className={module.studied_at ? 'done' : undefined}>
            Lesson marked studied {module.studied_at ? `(${formatManilaDateTime(module.studied_at)})` : ''}
          </li>
          <li className={module.knowledge_check_completed_at ? 'done' : undefined}>
            Knowledge check submitted {module.knowledge_check_completed_at ? `(${formatManilaDateTime(module.knowledge_check_completed_at)})` : ''}
          </li>
          <li className={module.completed_at ? 'done' : undefined}>
            Module complete {module.completed_at ? `(${formatManilaDateTime(module.completed_at)})` : ''}
          </li>
        </ul>
        {actionMessage && <p className="status">{actionMessage}</p>}
        <button className="secondary" onClick={markStudied} disabled={studying || module.studied_at !== null}>
          {studying ? 'Saving…' : module.studied_at ? 'Lesson recorded' : 'Mark lesson as studied'}
        </button>
      </section>

      <section className="material-panel">
        <h2>Module material</h2>
        {available.length === 0 ? (
          <div className="empty">
            <h3>No published material</h3>
            <p>
              This module has no published PDF yet. The academy is still importing the English and
              Bisaya course files, so nothing is served in place of the real content.
            </p>
          </div>
        ) : (
          <>
            <Field label="Language">
              <select
                value={language}
                onChange={(event) => {
                  setChosenLanguage(event.target.value)
                  setLink(null)
                   setLinkError('')
                   setAccessDenied(false)
                }}
              >
                {available.map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_LABEL[code]} — {module.titles[code]}
                  </option>
                ))}
              </select>
            </Field>
            <button className="button" onClick={openMaterial} disabled={opening || accessDenied}>
              {opening ? 'Checking entitlement…' : link ? 'Get a fresh link' : 'Open secure material link'}
            </button>
            {linkError && <p className="status">{linkError}</p>}
            {accessDenied && (
              <p className="fine">Access was refused by the server. Refresh after your enrollment is updated; this page will not retry automatically.</p>
            )}
            {link && (
              <div className="material-link">
                {link.fallback && (
                  <p className="notice">
                    The {LANGUAGE_LABEL[link.requestedLanguage] ?? link.requestedLanguage} version is not
                    published yet. This is the {LANGUAGE_LABEL[link.language] ?? link.language} version,
                    offered as a clearly labelled fallback rather than a silent substitution.
                  </p>
                )}
                <p>
                  <a className="button" href={link.url} target="_blank" rel="noreferrer">
                    {isPowerPoint(link) ? 'Download PowerPoint file' : 'Open material'}
                  </a>
                </p>
                <p className="fine">
                  Version {link.version} · {Math.ceil(link.sizeBytes / 1024)} KB · link expires in{' '}
                  {link.expiresInSeconds / 60} minutes.{' '}
                  {isPowerPoint(link) &&
                    'PowerPoint downloads cannot be previewed in the browser. A companion PDF can be uploaded later for inline preview.'}
                </p>
              </div>
            )}
            <p className="fine">
              Access is checked against your active enrollment, this module's curriculum snapshot and
              its publication state before any link is signed. Every issuance is logged.
            </p>
          </>
        )}
      </section>

      {module.knowledge_check_id && (
        <section className="knowledge-check-entry">
          <h2>Knowledge check</h2>
          <p>
            Completing the module requires this check. Answers are graded by a trusted database
            function; the browser never receives the answer key.
          </p>
          <Link className="button" to={`/learn/${courseId ?? activeCourseId}/modules/${module.id}/quiz`}>
            Open knowledge check
          </Link>
        </section>
      )}

      <button className="secondary" onClick={() => navigate(`/learn/${courseId ?? activeCourseId}`)}>
        Back to course
      </button>
    </div>
  )
}

export function KnowledgeCheck() {
  const { moduleId, courseId } = useParams()
  const navigate = useNavigate()
  const { enrollment, courseId: activeCourseId } = useEnrolledCourse(courseId)
  const { modules, reload } = useModuleRows(enrollment?.id ?? null, activeCourseId)
  const module = modules.find((row) => row.id === moduleId)

  const [payload, setPayload] = useState<QuizPayload | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<QuizResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const quizId = module?.knowledge_check_id ?? null

  const start = useCallback(async () => {
    if (!quizId) return
    setBusy(true)
    setMessage('')
    const { data: attemptId, error } = await supabase.rpc('start_quiz_attempt', {
      target_quiz: quizId,
      attempt_language: 'en',
    })
    if (error) {
      setBusy(false)
      setMessage(error.message)
      return
    }
    const { data, error: payloadError } = await supabase.rpc('quiz_payload', { target_attempt: attemptId })
    setBusy(false)
    if (payloadError) {
      setMessage(payloadError.message)
      return
    }
    setPayload(data as QuizPayload)
    setAnswers({})
  }, [quizId])

  const submit = useCallback(async () => {
    if (!payload) return
    setBusy(true)
    setMessage('')
    const answerList = Object.entries(answers).map(([questionId, optionId]) => ({ questionId, optionId }))
    const { data, error } = await supabase.rpc('submit_quiz_attempt', {
      target_attempt: payload.attemptId,
      answers: answerList,
    })
    setBusy(false)
    if (error) {
      setMessage(error.message)
      return
    }
    setResult(data as QuizResult)
    await reload()
  }, [answers, payload, reload])

  if (!enrollment) return <div className="page"><h1>No active enrollment</h1></div>

  if (!quizId) {
    return (
      <div className="page">
        <h1>Knowledge check unavailable</h1>
        <p>No published knowledge check exists for this module.</p>
        <button className="secondary" onClick={() => navigate(`/learn/${courseId ?? activeCourseId}`)}>
          Back to course
        </button>
      </div>
    )
  }

  const answered = Object.keys(answers).length
  const required = payload?.questions.length ?? 0

  return (
    <div className="page narrow">
      <p className="eyebrow">Knowledge check</p>
      <h1>{module?.titles.en ?? 'Module knowledge check'}</h1>

      {!payload && !result && (
        <>
          <p>
            Practice checks may be repeated. Each attempt is scored on the server and recorded against
            your enrollment.
          </p>
          <button className="button" onClick={start} disabled={busy}>
            {busy ? 'Starting…' : 'Start knowledge check'}
          </button>
        </>
      )}

      {message && <p className="status">{message}</p>}

      {payload && !result && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <p className="fine">
            Attempt {payload.attemptNumber} · {LANGUAGE_LABEL[payload.language] ?? payload.language} ·{' '}
            {answered} of {required} answered
          </p>
          {payload.questions.map((question, index) => (
            <fieldset key={question.id} className="quiz-question">
              <legend>
                {index + 1}. {question.prompt}
              </legend>
              {question.options.map((option) => (
                <label key={option.id} className="check">
                  <input
                    type="radio"
                    name={question.id}
                    value={option.id}
                    checked={answers[question.id] === option.id}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.id }))}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          ))}
          <button className="button" disabled={busy || answered !== required}>
            {busy ? 'Submitting…' : `Submit ${required} answers`}
          </button>
        </form>
      )}

      {result && (
        <div className="quiz-result">
          <h2>Submitted</h2>
          <p>
            Score {result.score ?? 0}% ({result.correct ?? 0} of {result.total ?? 0} correct).
          </p>
          {module?.knowledge_check_completed_at && (
            <p className="status">
              Knowledge check recorded. The module now completes once the lesson is also marked studied.
            </p>
          )}
          <button className="secondary" onClick={() => navigate(`/learn/${courseId ?? activeCourseId}`)}>
            Back to course
          </button>
        </div>
      )}
    </div>
  )
}

export function FinalQuiz() {
  const { courseId } = useParams()
  const navigate = useNavigate()
  const { enrollment, courseId: activeCourseId } = useEnrolledCourse(courseId)
  const { progress } = useProgress(enrollment?.id ?? null)
  const allRequiredComplete = (progress?.required_complete ?? 0) >= (progress?.required_total ?? 1) && (progress?.required_total ?? 0) > 0
  const { certificate, enabled: certificateEnabled, working: certificateWorking, failed: certificateFailed, message: certificateMessage, issue: retryCertificate } =
    useCertificateIssuance(enrollment, allRequiredComplete)
  const certificateEnabledFromContext = useCallback(() => certificateEnabled, [certificateEnabled])

  const [quizId, setQuizId] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<{ attempt_number: number; score: number | null; passed: boolean | null; state: string }[]>([])
  const [payload, setPayload] = useState<QuizPayload | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<QuizResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!enrollment || !activeCourseId) return
    void (async () => {
      const { data: quiz } = await supabase
        .from('quizzes')
        .select('id')
        .eq('course_id', activeCourseId)
        .eq('kind', 'final')
        .maybeSingle()
      setQuizId(quiz?.id ?? null)
      const { data: history } = await supabase
        .from('quiz_attempts')
        .select('attempt_number,score,passed,state')
        .eq('kind', 'final')
        .order('attempt_number', { ascending: false })
      setAttempts((history ?? []) as typeof attempts)
    })()
  }, [activeCourseId, enrollment])

  const start = useCallback(async () => {
    if (!quizId) return
    setBusy(true)
    setMessage('')
    const { data: attemptId, error } = await supabase.rpc('start_quiz_attempt', {
      target_quiz: quizId,
      attempt_language: 'en',
    })
    if (error) {
      setBusy(false)
      setMessage(error.message)
      return
    }
    const { data, error: payloadError } = await supabase.rpc('quiz_payload', { target_attempt: attemptId })
    setBusy(false)
    if (payloadError) {
      setMessage(payloadError.message)
      return
    }
    setPayload(data as QuizPayload)
    setAnswers({})
    setResult(null)
  }, [quizId])

  const submit = useCallback(async () => {
    if (!payload) return
    setBusy(true)
    setMessage('')
    const { data, error } = await supabase.rpc('submit_quiz_attempt', {
      target_attempt: payload.attemptId,
      answers: Object.entries(answers).map(([questionId, optionId]) => ({ questionId, optionId })),
    })
    setBusy(false)
    if (error) {
      setMessage(error.message)
      return
    }
    setResult(data as QuizResult)
  }, [answers, payload])

  if (!enrollment) return <div className="page"><h1>No active enrollment</h1></div>

  if (!quizId) {
    return (
      <div className="page narrow">
        <h1>Final quiz not available</h1>
        <p>
          No final assessment has been published. The academy will not launch placeholder questions
          from unseen modules.
        </p>
        <button className="secondary" onClick={() => navigate(`/learn/${courseId ?? activeCourseId}`)}>
          Back to course
        </button>
      </div>
    )
  }

  const answered = Object.keys(answers).length
  const required = payload?.questions.length ?? 0

  return (
    <div className="page narrow">
      <p className="eyebrow">Final assessment</p>
      <h1>Final quiz</h1>

      <div className="notice">
        The question set, the 75% pass mark and the retake rule are all enforced by trusted database
        operations. Changing the score or pass state in the browser has no effect. Attempts are
        unlimited and there is no waiting period between attempts; your best score is what counts.
      </div>

      {attempts.length > 0 && (
        <section>
          <h2>Your attempts</h2>
          <div className="table-list">
            {attempts.map((attempt) => (
              <article key={attempt.attempt_number}>
                <div>
                  <strong>Attempt {attempt.attempt_number}</strong>
                  <p>{statusLabel(attempt.state)}</p>
                </div>
                <div>
                  {attempt.score ?? '—'}%
                  <small>{attempt.passed === null ? 'practice' : attempt.passed ? 'passed' : 'not passed'}</small>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {message && <p className="status">{message}</p>}

      {!payload && !result && (
        <button className="button" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : 'Start final quiz'}
        </button>
      )}

      {payload && !result && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <p className="fine">
            Attempt {payload.attemptNumber} · pass mark {payload.passThreshold ?? '—'}% · {answered} of{' '}
            {required} answered
          </p>
          {payload.questions.map((question, index) => (
            <fieldset key={question.id} className="quiz-question">
              <legend>
                {index + 1}. {question.prompt}
              </legend>
              {question.options.map((option) => (
                <label key={option.id} className="check">
                  <input
                    type="radio"
                    name={question.id}
                    value={option.id}
                    checked={answers[question.id] === option.id}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.id }))}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          ))}
          <button className="button" disabled={busy || answered !== required}>
            {busy ? 'Submitting…' : 'Submit final quiz'}
          </button>
        </form>
      )}

      {result && (
        <div className="quiz-result">
          <h2>Result</h2>
          <p>
            Score {result.score ?? 0}% against a {payload?.passThreshold ?? 75}% pass mark —{' '}
            {result.passed ? 'passed' : 'not passed'}.
          </p>
          {result.alreadyScored && (
            <p className="fine">This attempt had already been scored, so the stored result was returned unchanged.</p>
          )}
          {result.passed && certificate && certificate.status === 'active' && (
            <p className="fine">Your certificate {certificate.verification_id} is already available on your course page.</p>
          )}
          {result.passed && certificateEnabledFromContext() === false && (
            <p className="fine">Certificates are not yet enabled. Automatic issuance will start when publishing is complete.</p>
          )}
          {result.passed && certificateFailed && (
            <>
              <p className="status">Automatic certificate issuance did not complete. You can retry once without re-taking the quiz.</p>
              <button className="button" onClick={retryCertificate} disabled={certificateWorking}>
                {certificateWorking ? 'Issuing…' : 'Retry certificate issuance'}
              </button>
            </>
          )}
          {result.passed && certificateMessage && (
            <p className="status">{certificateMessage}</p>
          )}
          <button className="secondary" onClick={() => navigate(`/learn/${courseId ?? activeCourseId}`)}>
            Back to course
          </button>
        </div>
      )}
    </div>
  )
}

function isPowerPoint(link: MaterialLinkResponse) {
  if (link.format) return link.format === 'ppt' || link.format === 'pptx'
  return link.url.includes('.pptx') || link.url.includes('.ppt')
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}
