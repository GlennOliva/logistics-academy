import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { supabase } from '../lib/supabase'
import { formatManilaDateTime, statusLabel, validateMaterialFile } from '../lib/payment'
import { useResource, type ResourceResult } from '../lib/useResource'
import { describeLanguages, languageLabel } from '../lib/language'
import type { AdminTranslationResponse } from '../lib/types'

type ModuleRow = {
  id: string
  canonical_title: string | null
  position: number
  required: boolean
  status: string
  curriculum_version: number
  snapshot_count: number
  translation_count: number
  published_languages: string
  updated_at: string
}

type CourseRow = {
  id: string
  slug: string
  title: string
  price_centavos: number
  currency: string
  status: string
  sales_enabled: boolean
}

type CourseView = {
  course: CourseRow | null
  modules: ModuleRow[]
  message: string
}

export function AdminCourses() {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const fetcher = useCallback(async (): Promise<ResourceResult<CourseView>> => {
    const { data: courseRow, error: courseError } = await supabase
      .from('courses')
      .select('id,slug,title,price_centavos,currency,status,sales_enabled')
      .eq('slug', 'logistics-101')
      .maybeSingle()

    if (courseError || !courseRow) {
      return { value: { course: null, modules: [], message: '' }, error: courseError?.message ?? 'Course not found.' }
    }

    const { data: moduleRows, error: moduleError } = await supabase
      .from('modules')
      .select('id,canonical_title,position,required,status,curriculum_version,updated_at')
      .eq('course_id', courseRow.id)
      .order('position', { ascending: true })

    if (moduleError) return { value: { course: null, modules: [], message: '' }, error: moduleError.message }

    const moduleIds = (moduleRows ?? []).map((row) => row.id)
    // An empty .in() list is a query error rather than an empty result, so a
    // course with no modules skips these two reads entirely.
    const [translationResult, snapshotResult] =
      moduleIds.length === 0
        ? [{ data: [] as { module_id: string; language: string; published: boolean; version: number }[] }, { data: [] as { module_id: string }[] }]
        : await Promise.all([
            supabase.from('module_translations').select('module_id,language,published,version').in('module_id', moduleIds),
            supabase.from('enrollment_modules').select('module_id').in('module_id', moduleIds),
          ])

    const translations = translationResult.data ?? []
    const snapshots = snapshotResult.data ?? []

    const modules = ((moduleRows ?? []) as ModuleRow[]).map((module) => ({
      ...module,
      snapshot_count: snapshots.filter((row) => row.module_id === module.id).length,
      translation_count: translations.filter((row) => row.module_id === module.id).length,
      published_languages: [
        ...new Set(
          translations
            .filter((row) => row.module_id === module.id && row.published)
            .map((row) => row.language as string),
        ),
      ].join(', '),
    }))

    return { value: { course: courseRow, modules, message: '' }, error: '' }
  }, [])

  const { value, error, loading, reload } = useResource(fetcher, { course: null, modules: [], message: '' })
  const course = value.course
  const modules = value.modules

  const toggleSales = useCallback(async () => {
    if (!course) return
    setBusy(true)
    setMessage('')
    const { error } = await supabase.rpc('admin_set_course_sales', {
      target_course: course.id,
      sales: !course.sales_enabled,
    })
    setBusy(false)
    setMessage(error ? error.message : `Sales ${course.sales_enabled ? 'disabled' : 'enabled'}.`)
    await reload()
  }, [course, reload])

  const createModule = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!course) return
      const form = new FormData(event.currentTarget)
      setBusy(true)
      setMessage('')
      const { error } = await supabase.rpc('admin_save_module', {
        target_course: course.id,
        module_position: Number(form.get('position')),
        module_required: form.get('required') === 'true',
        action: 'create',
      })
      setBusy(false)
      setMessage(error ? error.message : 'Module created as a draft.')
      if (!error) event.currentTarget.reset()
      await reload()
    },
    [course, reload],
  )

  const setStatus = useCallback(
    async (moduleId: string, newStatus: string, reason: string, applyToExisting: boolean) => {
      setBusy(true)
      setMessage('')
      const { error } = await supabase.rpc('admin_set_module_status', {
        target_module: moduleId,
        new_status: newStatus,
        reason,
        apply_to_existing: applyToExisting,
      })
      setBusy(false)
      setMessage(
        error
          ? error.message
          : `Module moved to ${statusLabel(newStatus)}.${newStatus === 'published' && !applyToExisting ? ' Existing enrollment snapshots were left unchanged; use the explicit add-to-enrollments action to change them.' : ''}`,
      )
      await reload()
    },
    [reload],
  )

  const addToEnrollments = useCallback(
    async (moduleId: string, reason: string) => {
      setBusy(true)
      setMessage('')
      const { data, error } = await supabase.rpc('admin_add_module_to_enrollments', {
        target_module: moduleId,
        reason,
      })
      setBusy(false)
      setMessage(error ? error.message : `Added to ${data ?? 0} active enrollment snapshot(s), with an audit record.`)
      await reload()
    },
    [reload],
  )

  if (loading) return <div className="page"><p className="status" role="status">Loading course…</p></div>

  return (
    <div className="page">
      <p className="eyebrow">Administration</p>
      <h1>Course and modules.</h1>

      {(message || error) && <p className="status">{message || error}</p>}

      {course && (
        <section className="course-admin-card">
          <div>
            <h2>{course.title}</h2>
            <p className="fine">
              {course.price_centavos / 100} {course.currency} · {statusLabel(course.status)} · sales{' '}
              {course.sales_enabled ? 'enabled' : 'disabled'}
            </p>
          </div>
          <button className="secondary" onClick={toggleSales} disabled={busy}>
            {course.sales_enabled ? 'Disable sales' : 'Enable sales'}
          </button>
        </section>
      )}

      <div className="notice">
        Verified GCash and MariBank destinations are configured. Keep sales disabled until the
        remaining course, assessment, policy and launch gates pass. Publishing a module does not
        add it to students who are already enrolled; that requires the separate, audited
        add-to-enrollments action.
      </div>

      <section>
        <h2>Modules</h2>
        {modules.length === 0 ? (
          <div className="empty">
            <h3>No modules yet</h3>
            <p>The academy is still importing the English and Bisaya course files.</p>
          </div>
        ) : (
          <div className="table-list">
            {modules.map((module) => (
              <article key={module.id}>
                <div>
                  <strong>
                    {module.position}. {module.canonical_title ?? 'Untitled module'} · {statusLabel(module.status)}
                    {module.required ? ' · required' : ' · optional'}
                  </strong>
                  <p>
                    v{module.curriculum_version} · {module.published_languages
                      ? describeLanguages(module.published_languages.split(', '))
                      : 'no published material'}
                  </p>
                  <p>
                    {module.snapshot_count} enrollment snapshot reference(s) · {module.translation_count} material version(s)
                  </p>
                  <small>Updated {formatManilaDateTime(module.updated_at)}</small>
                </div>
                <div className="row-actions">
                  <ModuleStatusForm moduleId={module.id} current={module.status} busy={busy} onSubmit={setStatus} />
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt(
                        'Reason for adding this module to existing enrollments. This changes what current students must complete.',
                      )
                      if (reason) void addToEnrollments(module.id, reason)
                    }}
                  >
                    Add to current enrollments
                  </button>
                  <Link className="secondary" to={`/admin/courses/${module.id}/material`}>
                    Manage material
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Add a module</h2>
        <form className="inline-form" onSubmit={createModule}>
          <label className="field">
            <span>Position</span>
            <input type="number" name="position" min={1} required defaultValue={modules.length + 1} />
          </label>
          <label className="field">
            <span>Required</span>
            <select name="required" defaultValue="true">
              <option value="true">Required for completion</option>
              <option value="false">Optional</option>
            </select>
          </label>
          <button className="button" disabled={busy}>Create draft module</button>
        </form>
        <p className="fine">
          New modules are created as drafts. Upload material for both languages, then publish.
        </p>
      </section>
    </div>
  )
}

function ModuleStatusForm({
  moduleId,
  current,
  busy,
  onSubmit,
}: {
  moduleId: string
  current: string
  busy: boolean
  onSubmit: (moduleId: string, status: string, reason: string, applyToExisting: boolean) => Promise<void>
}) {
  const [status, setStatus] = useState('')
  const [reason, setReason] = useState('')

  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!status || reason.trim().length < 3) return
        void onSubmit(moduleId, status, reason, false)
      }}
    >
      <select value={status} onChange={(event) => setStatus(event.target.value)} required>
        <option value="">Change status…</option>
        <option value="published" disabled={current === 'published'}>Publish</option>
        <option value="draft" disabled={current === 'draft'}>Move to draft</option>
        <option value="archived" disabled={current === 'archived'}>Archive</option>
      </select>
      <input
        placeholder="Reason (required)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        required={status !== ''}
        minLength={3}
      />
      <button className="secondary" disabled={busy || status === '' || reason.trim().length < 3}>
        Apply
      </button>
    </form>
  )
}

type TranslationRow = {
  id: string
  language: string
  version: number
  title: string
  published: boolean
  size_bytes: number
  created_at: string
}

export function AdminCourseMaterial() {
  const { moduleId = '' } = useParams()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const fetcher = useCallback(async (): Promise<ResourceResult<TranslationRow[]>> => {
    if (!moduleId) return { value: [], error: '' }
    const { data, error } = await supabase
      .from('module_translations')
      .select('id,language,version,title,published,size_bytes,created_at')
      .eq('module_id', moduleId)
      .order('language', { ascending: true })
      .order('version', { ascending: false })
    if (error) return { value: [], error: error.message }
    return { value: (data ?? []) as TranslationRow[], error: '' }
  }, [moduleId])

  const { value: translations, error, reload } = useResource(fetcher, [])

  const upload = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      const file = form.get('material')
      if (!(file instanceof File)) {
        setMessage('Choose a PDF or PowerPoint file.')
        return
      }
      const fileError = validateMaterialFile(file)
      if (fileError) {
        setMessage(fileError)
        return
      }
      setBusy(true)
      setMessage('')
      const uploadForm = new FormData()
      uploadForm.set('moduleId', moduleId)
      uploadForm.set('language', String(form.get('language')))
      uploadForm.set('title', String(form.get('title')))
      uploadForm.set('summary', String(form.get('summary')))
      uploadForm.set('publishNow', String(form.get('publishNow') === 'true'))
      uploadForm.set('material', file)
      const { data, error: invokeError } = await supabase.functions.invoke('submit-course-material', {
        body: uploadForm,
      })
      setBusy(false)
      if (invokeError) {
        setMessage(invokeError.message || 'Upload failed.')
        return
      }
      const saved = data as AdminTranslationResponse
      setMessage(
        `Saved ${languageLabel(saved.language)} version ${saved.version} (${saved.fileName}).${
          saved.unchanged
            ? ' This is the same file already stored, so no duplicate version was created.'
            : saved.published
              ? ' Published immediately.'
              : ' Stored as a draft version; publish it when the trainer approves.'
        }`,
      )
      event.currentTarget.reset()
      await reload()
    },
    [moduleId, reload],
  )

  return (
    <div className="page narrow">
      <p className="eyebrow">Administration</p>
      <h1>Module material.</h1>
      <p className="lede">
        Each upload becomes a new immutable version. Previous versions are retained so a bad
        replacement can be rolled back without deleting anything students may already have opened.
      </p>

      {(message || error) && <p className="status">{message || error}</p>}

      <section>
        <h2>Saved versions</h2>
        {translations.length === 0 ? (
          <div className="empty">
            <h3>No material uploaded</h3>
            <p>Import the English and Bisaya PDFs here once the source files are available.</p>
          </div>
        ) : (
          <div className="table-list">
            {translations.map((translation) => (
              <article key={translation.id}>
                <div>
                  <strong>
                    {languageLabel(translation.language)} v{translation.version}
                    {translation.published ? ' · published' : ' · draft'}
                  </strong>
                  <p>{translation.title}</p>
                  <small>
                    {Math.ceil(translation.size_bytes / 1024)} KB · {formatManilaDateTime(translation.created_at)}
                  </small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Upload a new version</h2>
        <form className="checkout-form" onSubmit={upload}>
          <label className="field">
            <span>Language</span>
            <select name="language" required defaultValue="en">
              <option value="en">English</option>
              <option value="ceb">Bisaya</option>
            </select>
          </label>
          <label className="field">
            <span>Material title</span>
            <input name="title" required maxLength={200} />
          </label>
          <label className="field">
            <span>Summary</span>
            <textarea name="summary" rows={2} />
          </label>
          <label className="field">
            <span>Course material — PDF or PowerPoint</span>
            <input
              name="material"
              type="file"
              accept=".pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              required
            />
            <small>
              PDF, PPT, or PPTX up to 50 MB. A PowerPoint deck does not need a companion PDF; a PDF
              preview is used only when one is available. The real file signature is verified
              server-side, so a renamed or unrelated archive is rejected.
            </small>
          </label>
          <label className="check">
            <input type="checkbox" name="publishNow" value="true" />
            Publish immediately (the module itself still needs publishing)
          </label>
          <button className="button full" disabled={busy}>
            {busy ? 'Validating and uploading…' : 'Save material version'}
          </button>
        </form>
      </section>
    </div>
  )
}
