import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '../auth'
import { supabase } from '../lib/supabase'
import { useResource, type ResourceResult } from '../lib/useResource'
import type { Enrollment, Module, ModuleProgress, ModuleTranslation, ProgressSummary, Quiz } from '../lib/types'

/**
 * Data hooks for the learning area.
 *
 * These live apart from the screens so the component files export only
 * components. Every loader returns plain data and lets useResource own the
 * state write, so a missing enrollment stays distinguishable from a slow
 * request and a late response can never overwrite a newer one.
 */

export type ModuleRow = Module & {
  enrollment_required: boolean
  curriculum_version: number
  studied_at: string | null
  knowledge_check_completed_at: string | null
  completed_at: string | null
  titles: Partial<Record<'en' | 'ceb', string>>
  material_available: boolean
  knowledge_check_id: string | null
}

/**
 * One purchased course as the student's own rows describe it.
 *
 * `published_modules` is the count of snapshotted modules the student can
 * actually open right now. It is what separates "you own this" from "you own
 * this but the academy has not published its lessons yet", so the dashboard can
 * be honest instead of rendering a silently empty course.
 */
export type EnrolledCourse = {
  enrollment: Enrollment
  courseId: string
  courseTitle: string
  courseStatus: string
  published_modules: number
  required_modules: number
  knowledge_checks: number
  certificate: Certificate | null
}

export type Certificate = { id: string; verification_id: string; status: string; issued_at: string | null }

const NO_COURSE: { enrollment: Enrollment | null; courseId: string | null; courseTitle: string; message: string } = {
  enrollment: null,
  courseId: null,
  courseTitle: 'Logistics 101',
  message: '',
}

export type CourseValue = {
  enrollment: Enrollment | null
  courseId: string | null
  courseTitle: string
  message: string
}

/**
 * Loads every course the signed-in student owns.
 *
 * Approval is written by an administrator, so this list is the authoritative
 * answer to "what did I buy" rather than anything derived from the payment
 * history: a paid order with no active enrollment must not read as access, and
 * an audited manual grant with no order must read as access.
 */
export function useEnrolledCourses() {
  const { session } = useAuth()

  const fetcher = useCallback(async (): Promise<ResourceResult<EnrolledCourse[]>> => {
    if (!session) return { value: [], error: '' }

    const { data: enrollments, error } = await supabase
      .from('enrollments')
      .select('id,user_id,course_id,status,granted_at,updated_at')
      .eq('status', 'active')
      .order('granted_at', { ascending: false })

    if (error) return { value: [], error: error.message }

    const active = (enrollments ?? []) as Enrollment[]
    if (active.length === 0) return { value: [], error: '' }

    const courseIds = [...new Set(active.map((row) => row.course_id))]
    const enrollmentIds = active.map((row) => row.id)

    const [courseResult, snapshotResult] = await Promise.all([
      supabase.from('courses').select('id,title,status').in('id', courseIds),
      supabase.from('enrollment_modules').select('enrollment_id,module_id,required').in('enrollment_id', enrollmentIds),
    ])

    if (courseResult.error) return { value: [], error: courseResult.error.message }
    if (snapshotResult.error) return { value: [], error: snapshotResult.error.message }

    // Module publication is filtered by the ids in the student's own snapshot,
    // never by "every module of every course", so a draft module belonging to
    // another enrollment can never inflate this count.
    const snapshots = (snapshotResult.data ?? []) as { enrollment_id: string; module_id: string; required: boolean }[]
    const moduleIds = [...new Set(snapshots.map((row) => row.module_id))]

    const [moduleResult, quizResult, certificateResult] = await Promise.all([
      moduleIds.length > 0
        ? supabase.from('modules').select('id,status').in('id', moduleIds)
        : Promise.resolve({ data: [] as { id: string; status: string }[], error: null }),
      supabase.from('quizzes').select('id,module_id,kind').eq('kind', 'knowledge_check'),
      supabase.from('certificates').select('id,enrollment_id,verification_id,status,issued_at').in('enrollment_id', enrollmentIds),
    ])

    if (moduleResult.error) return { value: [], error: moduleResult.error.message }
    if (certificateResult.error) return { value: [], error: certificateResult.error.message }

    const courses = new Map(((courseResult.data ?? []) as { id: string; title: string; status: string }[]).map((row) => [row.id, row]))
    const publishedIds = new Set(
      ((moduleResult.data ?? []) as { id: string; status: string }[])
        .filter((row) => row.status === 'published')
        .map((row) => row.id),
    )
    const quizModules = new Set(((quizResult.data ?? []) as { module_id: string | null }[]).map((row) => row.module_id))
    const certificates = new Map(
      ((certificateResult.data ?? []) as (Certificate & { enrollment_id: string })[]).map((row) => [row.enrollment_id, row]),
    )

    const rows: EnrolledCourse[] = active.map((enrollment) => {
      const own = snapshots.filter((row) => row.enrollment_id === enrollment.id)
      const course = courses.get(enrollment.course_id)
      return {
        enrollment,
        courseId: enrollment.course_id,
        courseTitle: course?.title ?? 'Course',
        courseStatus: course?.status ?? 'unknown',
        published_modules: own.filter((row) => publishedIds.has(row.module_id)).length,
        required_modules: own.filter((row) => row.required).length,
        knowledge_checks: own.filter((row) => quizModules.has(row.module_id)).length,
        certificate: certificates.get(enrollment.id) ?? null,
      }
    })

    return { value: rows, error: '' }
  }, [session])

  const { value, error, loading, reload } = useResource(fetcher, [] as EnrolledCourse[], { refreshOnFocus: true })

  return useMemo(
    () => ({
      loading: session ? loading : false,
      courses: value,
      error,
      reload,
    }),
    [error, loading, reload, session, value],
  )
}

/**
 * The single course behind a `/learn/:courseId` route.
 *
 * The route parameter is honoured rather than ignored, so a link to a course
 * the student does not own reports that instead of quietly rendering whichever
 * enrollment happened to be returned first.
 */
export function useEnrolledCourse(courseIdFromRoute?: string) {
  const { session } = useAuth()
  const { courses, loading, reload } = useEnrolledCourses()

  return useMemo<CourseValue & { loading: boolean; reload: () => Promise<void> }>(() => {
    if (!session) return { ...NO_COURSE, loading: false, reload }
    // Until the query settles the enrollment is unknown, not absent. Reporting
    // "no active enrollment" here would flash the wrong state at every student
    // whose approval is slow to arrive.
    if (loading) return { ...NO_COURSE, loading: true, reload }
    if (courses.length === 0) {
      return {
        ...NO_COURSE,
        loading: false,
        reload,
        message: 'No active enrollment yet. Payment approval or an audited manual grant unlocks the course.',
      }
    }
    const match = courseIdFromRoute ? courses.find((row) => row.courseId === courseIdFromRoute) : courses[0]
    if (!match) {
      return {
        ...NO_COURSE,
        loading: false,
        reload,
        message: 'This course is not part of your account. Payment approval or an audited manual grant is required first.',
      }
    }
    return { enrollment: match.enrollment, courseId: match.courseId, courseTitle: match.courseTitle, message: '', loading: false, reload }
  }, [courses, courseIdFromRoute, loading, reload, session])
}

export function useProgress(enrollmentId: string | null) {
  const fetcher = useCallback(async () => {
    if (!enrollmentId) return { value: null as ProgressSummary | null, error: '' }
    const { data, error } = await supabase.rpc('enrollment_progress', { target_enrollment: enrollmentId })
    if (error) return { value: null, error: error.message }
    return {
      value: Array.isArray(data) ? (data[0] as ProgressSummary) : (data as ProgressSummary),
      error: '',
    }
  }, [enrollmentId])

  const { value, error, reload } = useResource(fetcher, null)

  return useMemo(
    () => ({ progress: value, error, reload }),
    [error, reload, value],
  )
}

export function useModuleRows(enrollmentId: string | null, courseId: string | null) {
  const fetcher = useCallback(async () => {
    if (!enrollmentId || !courseId) return { value: [] as ModuleRow[], error: '' }

    const { data: snapshot, error: snapshotError } = await supabase
      .from('enrollment_modules')
      .select('module_id,required,curriculum_version')
      .eq('enrollment_id', enrollmentId)

    if (snapshotError) return { value: [] as ModuleRow[], error: snapshotError.message }

    const moduleIds = (snapshot ?? []).map((row) => row.module_id)
    if (moduleIds.length === 0) return { value: [] as ModuleRow[], error: '' }

    const [moduleResult, translationResult, progressResult, quizResult] = await Promise.all([
      supabase.from('modules').select('id,position,required,status').in('id', moduleIds),
      supabase
        .from('module_translations')
        .select('module_id,language,title,published')
        .in('module_id', moduleIds),
      supabase
        .from('module_progress')
        .select('module_id,studied_at,knowledge_check_completed_at,completed_at')
        .eq('enrollment_id', enrollmentId),
      supabase
        .from('quizzes')
        .select('id,module_id,kind')
        .eq('kind', 'knowledge_check')
        .in('module_id', moduleIds),
    ])

    if (moduleResult.error) return { value: [] as ModuleRow[], error: moduleResult.error.message }

    const byId = new Map((snapshot ?? []).map((row) => [row.module_id, row]))
    const titles: Record<string, Partial<Record<'en' | 'ceb', string>>> = {}
    for (const translation of (translationResult.data ?? []) as ModuleTranslation[]) {
      const bucket = (titles[translation.module_id] ??= {})
      if (translation.published) bucket[translation.language] = translation.title
    }
    const progressByModule = new Map(
      ((progressResult.data ?? []) as ModuleProgress[]).map((row) => [row.module_id, row]),
    )
    const quizByModule = new Map(((quizResult.data ?? []) as Quiz[]).map((row) => [row.module_id, row.id]))

    const rows: ModuleRow[] = ((moduleResult.data ?? []) as Module[])
      .map((module) => {
        const snapshotRow = byId.get(module.id)
        const record = progressByModule.get(module.id)
        const moduleTitles = titles[module.id] ?? {}
        return {
          ...module,
          // The snapshot outranks the live module row, so a later curriculum
          // change cannot silently rewrite what an enrolled student must complete.
          enrollment_required: snapshotRow?.required ?? module.required,
          curriculum_version: snapshotRow?.curriculum_version ?? module.curriculum_version,
          studied_at: record?.studied_at ?? null,
          knowledge_check_completed_at: record?.knowledge_check_completed_at ?? null,
          completed_at: record?.completed_at ?? null,
          titles: moduleTitles,
          material_available: Object.keys(moduleTitles).length > 0,
          knowledge_check_id: quizByModule.get(module.id) ?? null,
        }
      })
      .sort((left, right) => left.position - right.position)

    return { value: rows, error: '' }
  }, [courseId, enrollmentId])

  const { value, error, loading, reload } = useResource(fetcher, [])

  return useMemo(
    () => ({
      modules: enrollmentId && courseId ? value : [],
      loading: enrollmentId && courseId ? loading : false,
      error,
      reload,
    }),
    [courseId, enrollmentId, error, loading, reload, value],
  )
}

export type CertificateEligibility = {
  config_enabled: boolean
  enrollment_active: boolean
  expected_module_count: number | null
  required_module_count: number
  required_completed: number
  required_outstanding: number
  outstanding_titles: string
  required_score: number | null
  best_final_score: number | null
  certificate_status: string | null
  eligible: boolean
  blockers: string[]
}

export type CertificateIssuance = {
  certificate: Certificate | null
  enabled: boolean
  eligible: boolean
  checked: boolean
  working: boolean
  failed: boolean
  message: string
  blockers: string[]
  eligibility: CertificateEligibility | null
  issue: () => void
  view: () => void
  download: () => void
}

/**
 * Issues the learner's certificate automatically once the server says they are
 * entitled to one.
 *
 * Entitlement is never decided in the browser. `certificate_eligibility` returns
 * every unmet condition separately, so the panel can show the real reason
 * issuance was refused instead of one generic "not ready yet" sentence. The edge
 * function re-checks all of it against trusted state before anything is written.
 *
 * Asking once per page keeps issuance automatic without turning every render
 * into a request, and `retry` stays available because generation can fail
 * transiently.
 */
export function useCertificateIssuance(
  enrollment: Pick<Enrollment, 'id' | 'course_id'> | null,
  allModulesComplete: boolean,
): CertificateIssuance {
  const [certificate, setCertificate] = useState<Certificate | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [eligible, setEligible] = useState(false)
  const [checked, setChecked] = useState(false)
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState('')
  const [blockers, setBlockers] = useState<string[]>([])
  const [eligibility, setEligibility] = useState<CertificateEligibility | null>(null)
  const requested = useRef(false)

  const enrollmentId = enrollment?.id ?? null

  const refresh = useCallback(async () => {
    if (!enrollmentId) return
    const { data, error } = await supabase.rpc('certificate_eligibility', {
      target_enrollment: enrollmentId,
    })
    if (error || !data) {
      setChecked(true)
      setEligible(false)
      setBlockers([
        'Your certificate status could not be checked right now. Please try again in a moment.',
      ])
      return
    }
    const next = data as unknown as CertificateEligibility
    setEligibility(next)
    setEnabled(next.config_enabled)
    setEligible(next.eligible)
    setBlockers(next.blockers ?? [])
    setChecked(true)
  }, [enrollmentId])

  useEffect(() => {
    if (!enrollmentId) return
    let active = true
    void Promise.all([
      supabase
        .from('certificates')
        .select('id,verification_id,status,issued_at')
        .eq('enrollment_id', enrollmentId)
        .maybeSingle(),
    ]).then(([certificateResult]) => {
      if (!active) return
      setCertificate((certificateResult.data as Certificate | null) ?? null)
      setFailed(certificateResult.data?.status === 'failed')
    })
    void (async () => {
      await refresh()
    })()
    return () => {
      active = false
    }
  }, [enrollmentId, refresh])

  const issue = useCallback(() => {
    if (!enrollmentId || working) return
    setWorking(true)
    setMessage('')
    void supabase.functions
      .invoke('generate-certificate', { body: { enrollmentId } })
      .then(async ({ data, error }) => {
        setWorking(false)
        const reported = (data as { error?: string } | null)?.error
        if (error || !data) {
          const reason =
            reported ??
            (error
              ? 'The certificate service could not be reached. Your progress and results are safe — retry in a moment.'
              : 'The certificate service returned an unexpected response. Your progress and results are safe — retry in a moment.')
          setMessage(reason)
          setFailed(true)
          void refresh()
          return
        }
        if (reported) {
          setMessage(reported)
          setFailed(true)
          void refresh()
          return
        }
        const issued = data as { certificateId: string; verificationId: string; status: string }
        setCertificate({
          id: issued.certificateId,
          verification_id: issued.verificationId,
          status: issued.status,
          issued_at: new Date().toISOString(),
        })
        setFailed(issued.status === 'failed')
        setMessage(
          issued.status === 'active'
            ? 'Your certificate is ready.'
            : 'Your certificate is being prepared. This page updates on its own.',
        )
        void refresh()
      })
  }, [enrollmentId, refresh, working])

  // Automatic issuance: one attempt per enrollment for this page view.
  useEffect(() => {
    if (requested.current) return
    if (!enrollmentId || !enabled || !eligible || !checked) return
    if (!allModulesComplete) return
    if (certificate?.status === 'active' || certificate?.status === 'generating') return
    requested.current = true
    void (async () => {
      try {
        await issue()
      } catch (error) {
        requested.current = false
        console.error(error)
      }
    })()
  }, [allModulesComplete, certificate?.status, checked, eligible, enabled, enrollmentId, issue])

  // The signed URL arrives after an async round trip, so it is handed to the
  // browser as a normal navigation. window.open here would be popup-blocked
  // because the user gesture is gone by the time the link resolves, which made
  // the buttons look dead. disposition decides whether the PDF renders in the
  // tab or is downloaded.
  const openCertificate = useCallback(
    (disposition: 'inline' | 'attachment', failure: string) => {
      if (!certificate) return
      setWorking(true)
      setMessage('')
      void supabase.functions
        .invoke('certificate-access', {
          body:
            disposition === 'attachment'
              ? {
                  certificateId: certificate.id,
                  disposition,
                  fileName: `Logistics-101-Certificate-${certificate.verification_id}.pdf`,
                }
              : { certificateId: certificate.id, disposition },
        })
        .then(({ data, error }) => {
          setWorking(false)
          const url = (data as { url?: string } | null)?.url
          const reported = (data as { error?: string } | null)?.error
          if (error || !url) {
            setMessage(reported ?? failure)
            return
          }
          window.location.assign(url)
        })
    },
    [certificate],
  )

  const view = useCallback(() => {
    openCertificate('inline', 'The private certificate link could not be opened. Please try again.')
  }, [openCertificate])

  const download = useCallback(() => {
    openCertificate('attachment', 'The private certificate link could not be opened. Please try again.')
  }, [openCertificate])

  return {
    certificate,
    enabled,
    eligible,
    checked,
    working,
    failed,
    message,
    blockers,
    eligibility,
    issue,
    view,
    download,
  }
}