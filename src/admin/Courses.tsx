import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  parseMaterialVersionImpact,
  parseModuleDeleteImpact,
} from '../lib/adminModuleLifecycle'
import { supabase } from '../lib/supabase'
import { describeLanguages, languageLabel } from '../lib/language'
import { formatManilaDateTime, statusLabel, validateMaterialFile } from '../lib/payment'
import type { AdminTranslationResponse, MaterialVersionImpact } from '../lib/types'
import { useResource, type ResourceResult } from '../lib/useResource'
import { ImpactList, Modal, ModalActions } from './Modal'

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
  archived_at: string | null
  updated_at: string
}

// The title and summary a student currently sees for one language, read from the
// newest live material version. found distinguishes "no version uploaded yet" from
// "a version exists but its title is blank".
type DisplayText = { found: boolean; title: string; summary: string }

const emptyDisplay: DisplayText = { found: false, title: '', summary: '' }

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
}

export function AdminCourses() {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<ModuleRow | null>(null)
  const [deleting, setDeleting] = useState<ModuleRow | null>(null)

  const fetcher = useCallback(async (): Promise<ResourceResult<CourseView>> => {
    const { data: courseRow, error: courseError } = await supabase
      .from('courses')
      .select('id,slug,title,price_centavos,currency,status,sales_enabled')
      .eq('slug', 'logistics-101')
      .maybeSingle()

    if (courseError || !courseRow) {
      return {
        value: { course: null, modules: [] },
        error: courseError?.message ?? 'Course not found.',
      }
    }

    const { data: moduleRows, error: moduleError } = await supabase
      .from('modules')
      .select('id,canonical_title,position,required,status,curriculum_version,archived_at,updated_at')
      .eq('course_id', courseRow.id)
      .order('position', { ascending: true })

    if (moduleError) return { value: { course: null, modules: [] }, error: moduleError.message }

    const moduleIds = (moduleRows ?? []).map((row) => row.id)
    // An empty .in() list is a query error rather than an empty result, so a
    // course with no modules skips these two reads entirely.
    const [translationResult, snapshotResult] =
      moduleIds.length === 0
        ? [
            { data: [] as { module_id: string; language: string; published: boolean; version: number }[] },
            { data: [] as { module_id: string }[] },
          ]
        : await Promise.all([
            supabase
              .from('module_translations')
              .select('module_id,language,published,version')
              .in('module_id', moduleIds),
            supabase.from('enrollment_modules').select('module_id').in('module_id', moduleIds),
          ])

    const translations = translationResult.data ?? []
    const snapshots = snapshotResult.data ?? []

    const modules = (moduleRows ?? []).map((module) => ({
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

    return { value: { course: courseRow, modules }, error: '' }
  }, [])

  const { value, error, loading, reload } = useResource(fetcher, { course: null, modules: [] })
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

  const restoreModule = useCallback(
    async (module: ModuleRow, reason: string, restoreRequirement: boolean) => {
      setBusy(true)
      setMessage('')
      const { error } = await supabase.rpc('admin_restore_module', {
        target_module: module.id,
        reason,
        restore_requirement: restoreRequirement,
      })
      setBusy(false)
      setMessage(
        error
          ? error.message
          : `Restored "${module.canonical_title ?? 'Untitled module'}"${
              restoreRequirement ? ' with its completion requirement reinstated.' : '. Its completion requirement stays released.'
            }`,
      )
      await reload()
    },
    [reload],
  )

  if (loading) return <div className="page"><p className="status" role="status">Loading course…</p></div>

  const liveModules = modules.filter((module) => !module.archived_at)
  const archivedModules = modules.filter((module) => module.archived_at)

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
                    {module.archived_at ? ' · archived' : ''}
                  </strong>
                  {module.archived_at && (
                    <p className="archived-flag">
                      Archived {formatManilaDateTime(module.archived_at)}. Hidden from new curriculum
                      selection; existing student history is preserved.
                    </p>
                  )}
                  <p>
                    v{module.curriculum_version} ·{' '}
                    {module.published_languages
                      ? describeLanguages(module.published_languages.split(', '))
                      : 'no published material'}
                  </p>
                  <p>
                    {module.snapshot_count} enrollment snapshot reference(s) ·{' '}
                    {module.translation_count} material version(s)
                  </p>
                  <small>Updated {formatManilaDateTime(module.updated_at)}</small>
                </div>
                <div className="row-actions">
                  {module.archived_at ? (
                    <RestoreModuleForm
                      module={module}
                      busy={busy}
                      onSubmit={restoreModule}
                    />
                  ) : (
                    <>
                      <button className="secondary" disabled={busy} onClick={() => setEditing(module)}>
                        Edit
                      </button>
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
                      <button className="dangerous" disabled={busy} onClick={() => setDeleting(module)}>
                        Delete
                      </button>
                      <Link className="secondary" to={`/admin/courses/${module.id}/material`}>
                        Manage material
                      </Link>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {archivedModules.length > 0 && (
        <p className="fine">
          {archivedModules.length} archived module(s) are listed above with their original data
          intact. Restore one to return it to the course.
        </p>
      )}

      <section>
        <h2>Add a module</h2>
        <form className="inline-form" onSubmit={createModule}>
          <label className="field">
            <span>Position</span>
            <input type="number" name="position" min={1} required defaultValue={liveModules.length + 1} />
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

      {editing && (
        <EditModuleDialog
          module={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null)
            setMessage(text)
            await reload()
          }}
        />
      )}

      {deleting && (
        <DeleteModuleDialog
          module={deleting}
          onClose={() => setDeleting(null)}
          onDone={async (text) => {
            setDeleting(null)
            setMessage(text)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function RestoreModuleForm({
  module,
  busy,
  onSubmit,
}: {
  module: ModuleRow
  busy: boolean
  onSubmit: (module: ModuleRow, reason: string, restoreRequirement: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [restoreRequirement, setRestoreRequirement] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  if (!open) {
    return (
      <button className="secondary" disabled={busy} onClick={() => setOpen(true)}>
        Restore
      </button>
    )
  }

  return (
    <Modal title={`Restore ${module.canonical_title ?? 'Untitled module'}`} onClose={() => setOpen(false)}>
      <p>
        This module returns to the course with its original data untouched. Restoring does not
        republish it and does not put it back into student curricula on its own.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={restoreRequirement}
          onChange={(event) => setRestoreRequirement(event.target.checked)}
        />
        Also make it required again for students who already have it. A learner who has not studied
        it will become blocked on completion until they finish it.
      </label>
      <label className="field">
        <span>Reason (required)</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={3}
          required
          placeholder="Recorded in the audit log"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <ModalActions>
        <button className="secondary" onClick={() => setOpen(false)} disabled={working}>
          Cancel
        </button>
        <button
          className="button"
          disabled={working || reason.trim().length < 3}
          onClick={() => {
            setWorking(true)
            setError('')
            void onSubmit(module, reason.trim(), restoreRequirement)
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : 'Restore failed.'),
              )
              .finally(() => setWorking(false))
          }}
        >
          {working ? 'Restoring…' : 'Restore module'}
        </button>
      </ModalActions>
    </Modal>
  )
}

function EditModuleDialog({
  module,
  busy,
  onClose,
  onSaved,
}: {
  module: ModuleRow
  busy: boolean
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const [title, setTitle] = useState(module.canonical_title ?? '')
  const [position, setPosition] = useState(String(module.position))
  const [required, setRequired] = useState(module.required)
  const [status, setStatus] = useState(module.status)
  const [reason, setReason] = useState('')
  const [applyToExisting, setApplyToExisting] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  // The newest live version per language is what a student is shown, so that is
  // what the display title and summary fields start from.
  const [display, setDisplay] = useState<{ en: DisplayText; ceb: DisplayText }>({ en: emptyDisplay, ceb: emptyDisplay })
  const [displayLoading, setDisplayLoading] = useState(true)
  const [englishTitle, setEnglishTitle] = useState('')
  const [englishSummary, setEnglishSummary] = useState('')
  const [cebayaTitle, setCebayaTitle] = useState('')
  const [cebayaSummary, setCebayaSummary] = useState('')
  // Snapshots that still disagree with the module's own requirement flag, left
  // behind by an earlier save that was deliberately not reconciled.
  const [outstandingSnapshots, setOutstandingSnapshots] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [translations, snapshots] = await Promise.all([
        supabase
          .from('module_translations')
          .select('language,title,summary')
          .eq('module_id', module.id)
          .is('archived_at', null)
          .order('version', { ascending: false }),
        supabase
          .from('enrollment_modules')
          .select('module_id', { count: 'exact', head: true })
          .eq('module_id', module.id)
          .neq('required', module.required),
      ])
      if (cancelled) return
      const next = { en: emptyDisplay, ceb: emptyDisplay }
      for (const row of translations.data ?? []) {
        const bucket = row.language === 'ceb' ? 'ceb' : 'en'
        if (next[bucket].found) continue
        next[bucket] = {
          found: true,
          title: row.title ?? '',
          summary: row.summary ?? '',
        }
      }
      setDisplay(next)
      setEnglishTitle(next.en.title)
      setEnglishSummary(next.en.summary)
      setCebayaTitle(next.ceb.title)
      setCebayaSummary(next.ceb.summary)
      setOutstandingSnapshots(snapshots.count ?? 0)
      setDisplayLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [module.id, module.required])

  const requirementChanged = required !== module.required
  const unpublishing = module.status === 'published' && status !== 'published'
  // The reconciliation control appears when this save changes the requirement, and
  // also when an earlier save left snapshots out of step with the module.
  const reconcileOffered = requirementChanged || outstandingSnapshots > 0
  const detailsChanged =
    title.trim() !== (module.canonical_title ?? '') ||
    (!displayLoading &&
      (englishTitle !== display.en.title ||
        englishSummary !== display.en.summary ||
        cebayaTitle !== display.ceb.title ||
        cebayaSummary !== display.ceb.summary))

  const save = async () => {
    setWorking(true)
    setError('')
    try {
      // Wording first, then metadata, so a rejected requirement change cannot
      // leave the display title half saved.
      if (detailsChanged) {
        const { error: detailsError } = await supabase.rpc('admin_edit_module_details', {
          target_module: module.id,
          new_canonical_title: title,
          english_title: englishTitle,
          english_summary: englishSummary,
          cebaya_title: cebayaTitle,
          cebaya_summary: cebayaSummary,
          reason: reason.trim(),
        })
        if (detailsError) throw new Error(detailsError.message)
      }

      const { error: rpcError } = await supabase.rpc('admin_edit_module', {
        target_module: module.id,
        new_canonical_title: title,
        new_position: Number(position),
        new_required: required,
        new_status: status,
        reason: reason.trim(),
        apply_to_existing: applyToExisting,
      })
      if (rpcError) throw new Error(rpcError.message)

      const needsUpload: string[] = []
      if (!display.en.found) needsUpload.push('English')
      if (!display.ceb.found) needsUpload.push('Bisaya')
      const wordingNote = needsUpload.length > 0
        ? ` No ${needsUpload.join(' or ')} material version is uploaded yet, so upload one on Manage material to show a translated title.`
        : ''

      await onSaved(
        `${requirementChanged && !applyToExisting
          ? `Saved "${title}". The completion requirement was not changed for current students: confirm and tick the reconciliation box to apply it to their snapshots.`
          : requirementChanged
            ? `Saved "${title}" and reconciled the completion requirement, including certificate eligibility, with an audit record.`
            : `Saved "${title}".`}${unpublishing ? ' The module is now a draft, so students can no longer open it.' : ''}${wordingNote}`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save this module.')
      setWorking(false)
    }
  }

  return (
    <Modal title={`Edit ${module.canonical_title ?? 'Untitled module'}`} onClose={onClose}>
      <p>
        Renaming, reordering and status changes do not change what students must complete. The
        module keeps its ID, its saved material, its knowledge check and every student progress
        record.
      </p>
      <label className="field">
        <span>Module title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
        <small>The name used in the curriculum list, certificates and emails.</small>
      </label>

      <fieldset className="display-fields">
        <legend>Display title and summary shown to students</legend>
        <p>
          These change the wording students read. The uploaded file, its version history, the
          knowledge check and every progress record are untouched, and no completion requirement
          changes.
        </p>
        {displayLoading && <p role="status">Reading the current display text…</p>}
        {!displayLoading && !display.en.found && (
          <p className="warning-note">
            No English material version is uploaded, so there is no English title to edit yet.
          </p>
        )}
        {!displayLoading && !display.ceb.found && (
          <p className="warning-note">
            No Bisaya material version is uploaded, so there is no Bisaya title to edit yet.
          </p>
        )}
        {!displayLoading && display.en.found && (
          <>
            <label className="field">
              <span>English title</span>
              <input
                value={englishTitle}
                onChange={(event) => setEnglishTitle(event.target.value)}
                maxLength={200}
              />
            </label>
            <label className="field">
              <span>English summary</span>
              <textarea
                value={englishSummary}
                onChange={(event) => setEnglishSummary(event.target.value)}
                maxLength={2000}
                rows={3}
              />
            </label>
          </>
        )}
        {!displayLoading && display.ceb.found && (
          <>
            <label className="field">
              <span>Bisaya title</span>
              <input
                value={cebayaTitle}
                onChange={(event) => setCebayaTitle(event.target.value)}
                maxLength={200}
              />
            </label>
            <label className="field">
              <span>Bisaya summary</span>
              <textarea
                value={cebayaSummary}
                onChange={(event) => setCebayaSummary(event.target.value)}
                maxLength={2000}
                rows={3}
              />
            </label>
          </>
        )}
      </fieldset>
      <label className="field">
        <span>Order</span>
        <input
          type="number"
          min={1}
          value={position}
          onChange={(event) => setPosition(event.target.value)}
        />
        <small>
          Moving a module onto an occupied position swaps the two, so no duplicate order can be
          stored.
        </small>
      </label>
      <label className="field">
        <span>Status</span>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
        </select>
        <small>Use Delete → Archive to retire a module from the curriculum.</small>
      </label>
      {unpublishing && required && (
        <div className="warning-note">
          Moving a required module to draft closes it to students. Tick the reconciliation box below
          to release the requirement for current students in the same action, or use Delete →
          Archive instead.
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />
        Required for course completion
      </label>
      {reconcileOffered && (
        <div className="warning-note">
          {requirementChanged ? 'Changing this changes what students must complete.' : null}
          {!requirementChanged && outstandingSnapshots > 0 && (
            <p style={{ marginTop: 0 }}>
              {outstandingSnapshots} enrollment snapshot(s) still disagree with this module&rsquo;s
              requirement, from an earlier save that was not reconciled.
            </p>
          )}
          {!applyToExisting && (
            <p style={{ marginBottom: 0 }}>
              Nothing has changed for current students yet. Tick the box below to reconcile their
              enrollment snapshots and certificate eligibility in the same action.
            </p>
          )}
        </div>
      )}
      {reconcileOffered && (
        <label className="check">
          <input
            type="checkbox"
            checked={applyToExisting}
            onChange={(event) => setApplyToExisting(event.target.checked)}
          />
          Reconcile current enrollments and certificate eligibility now. This updates what existing
          students must complete and is recorded in the audit log.
        </label>
      )}
      <label className="field">
        <span>Reason (required)</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={3}
          required
          placeholder="Recorded in the audit log"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <ModalActions>
        <button className="secondary" onClick={onClose} disabled={working || busy}>
          Cancel
        </button>
        <button
          className="button"
          disabled={working || busy || reason.trim().length < 3}
          onClick={() => void save()}
        >
          {working ? 'Saving…' : 'Save changes'}
        </button>
      </ModalActions>
    </Modal>
  )
}

function DeleteModuleDialog({
  module,
  onClose,
  onDone,
}: {
  module: ModuleRow
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const [impact, setImpact] = useState<ReturnType<typeof parseModuleDeleteImpact>>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState<'archive' | 'purge' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const { data, error: rpcError } = await supabase.rpc('admin_module_delete_impact', {
      target_module: module.id,
    })
    if (rpcError) {
      setLoadError(rpcError.message)
      setLoading(false)
      return
    }
    const parsed = parseModuleDeleteImpact(data)
    if (!parsed) {
      setLoadError('The impact of deleting this module could not be read, so no action was taken.')
      setLoading(false)
      return
    }
    setImpact(parsed)
    setLoading(false)
  }, [module.id])

  useEffectLoad(load)

  const run = async (action: 'archive' | 'purge') => {
    setWorking(action)
    setError('')
    try {
      if (action === 'archive') {
        const { error: rpcError } = await supabase.rpc('admin_archive_module', {
          target_module: module.id,
          reason: reason.trim(),
        })
        if (rpcError) throw new Error(rpcError.message)
        await onDone(
          impact?.required
            ? `Archived "${impact.title}". Its completion requirement was released for ${impact.enrollmentReferences} enrollment snapshot(s) so no student is blocked on a module they can no longer open. All student history is preserved.`
            : `Archived "${impact?.title ?? module.canonical_title}". All student history is preserved and it is hidden from new curriculum selection.`,
        )
        return
      }

      const { error: rpcError } = await supabase.rpc('admin_purge_module', {
        target_module: module.id,
        reason: reason.trim(),
      })
      if (rpcError) throw new Error(rpcError.message)
      await onDone(`Permanently deleted the unused draft "${impact?.title ?? module.canonical_title}".`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action failed.')
      setWorking(null)
    }
  }

  return (
    <Modal title={`Delete ${module.canonical_title ?? 'Untitled module'}`} onClose={onClose}>
      {loading && <p role="status">Checking what this module affects…</p>}
      {loadError && <p className="error">{loadError}</p>}

      {impact && (
        <>
          <p>
            <strong>{impact.title}</strong> is position {impact.moduleId ? '' : ''}
            {impact.status === 'draft' ? 'a draft' : statusLabel(impact.status)} module.
          </p>

          <ImpactList
            title="What would be affected"
            items={[
              `${impact.enrollmentReferences} enrollment reference(s)`,
              `${impact.progressRecords} student progress record(s)`,
              `${impact.materialVersions} saved material version(s)`,
              `${impact.knowledgeChecks} knowledge check(s) covering ${impact.questionCount} question(s)`,
              `${impact.materialAccessRecords} material access record(s)`,
              `${impact.certificateReferences} issued certificate(s) that counted it`,
            ]}
          />

          {impact.canPurge ? (
            <p className="warning-note">
              This module is an unused draft with no references, so it can be permanently deleted.
              Archiving is still available if you would rather keep it.
            </p>
          ) : (
            <p className="warning-note">
              This module has history, so it cannot be erased. Archiving hides it from new curriculum
              selection and keeps every student record intact.
            </p>
          )}

          <ImpactList title="Why permanent deletion is unavailable" items={impact.blockers} />

          <label className="field">
            <span>Reason (required)</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              required
              placeholder="Recorded in the audit log"
            />
          </label>

          {error && <p className="error">{error}</p>}

          <ModalActions>
            <button className="secondary" onClick={onClose} disabled={working !== null}>
              Cancel
            </button>
            {impact.canPurge && (
              <button
                className="dangerous"
                disabled={working !== null || reason.trim().length < 3}
                onClick={() => void run('purge')}
              >
                {working === 'purge' ? 'Deleting…' : 'Delete permanently'}
              </button>
            )}
            <button
              className="button"
              disabled={working !== null || reason.trim().length < 3}
              onClick={() => void run('archive')}
            >
              {working === 'archive' ? 'Archiving…' : 'Archive instead'}
            </button>
          </ModalActions>
        </>
      )}
    </Modal>
  )
}

// Kept as a named hook so each dialog's data load reads as one explicit call
// rather than an inline effect that is easy to leave re-running on every render.
function useEffectLoad(load: () => Promise<void>) {
  useEffect(() => {
    void load()
  }, [load])
}

type TranslationRow = {
  id: string
  language: string
  version: number
  title: string
  summary: string
  published: boolean
  archived_at: string | null
  object_path: string
  size_bytes: number
  created_at: string
}

export function AdminCourseMaterial() {
  const { moduleId = '' } = useParams<{ moduleId?: string }>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [deleting, setDeleting] = useState<TranslationRow | null>(null)

  const fetcher = useCallback(async (): Promise<ResourceResult<TranslationRow[]>> => {
    if (!moduleId) return { value: [], error: '' }
    const { data, error } = await supabase
      .from('module_translations')
      .select('id,language,version,title,summary,published,archived_at,object_path,size_bytes,created_at')
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

  const live = translations.filter((row) => !row.archived_at)
  const archived = translations.filter((row) => row.archived_at)

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
          <>
            <div className="table-list">
              {live.map((translation) => (
                <article key={translation.id}>
                  <div>
                    <strong>
                      {languageLabel(translation.language)} v{translation.version}
                      {translation.published ? ' · published' : ' · draft'}
                    </strong>
                    <p>{translation.title}</p>
                    <small>
                      {Math.ceil(translation.size_bytes / 1024)} KB ·{' '}
                      {formatManilaDateTime(translation.created_at)}
                    </small>
                  </div>
                  <div className="row-actions">
                    <button
                      className="dangerous"
                      disabled={busy}
                      onClick={() => setDeleting(translation)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {archived.length > 0 && (
              <p className="fine">
                {archived.length} archived version(s) are hidden from this list.
                <button
                  className="secondary"
                  onClick={() => setShowArchived((value) => !value)}
                  style={{ marginLeft: '.75rem' }}
                >
                  {showArchived ? 'Hide archived versions' : 'Show archived versions'}
                </button>
              </p>
            )}
            {showArchived && archived.length > 0 && (
              <div className="table-list">
                {archived.map((translation) => (
                  <article key={translation.id}>
                    <div>
                      <strong>
                        {languageLabel(translation.language)} v{translation.version} · archived
                      </strong>
                      <p>{translation.title}</p>
                      <small>
                        Archived {formatManilaDateTime(translation.archived_at ?? '')}. The record
                        and file are preserved for history and are no longer served to students.
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
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

      {deleting && (
        <DeleteMaterialDialog
          translation={deleting}
          siblings={translations.filter((row) => row.language === deleting.language && row.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDone={async (text) => {
            setDeleting(null)
            setMessage(text)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function DeleteMaterialDialog({
  translation,
  siblings,
  onClose,
  onDone,
}: {
  translation: TranslationRow
  siblings: TranslationRow[]
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const [impact, setImpact] = useState<MaterialVersionImpact | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reason, setReason] = useState('')
  const [replacement, setReplacement] = useState('')
  const [unpublish, setUnpublish] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const { data, error: rpcError } = await supabase.rpc('admin_material_version_impact', {
      target_translation: translation.id,
    })
    if (rpcError) {
      setLoadError(rpcError.message)
      setLoading(false)
      return
    }
    const parsed = parseMaterialVersionImpact(data)
    if (!parsed) {
      setLoadError('The impact of deleting this version could not be read, so no action was taken.')
      setLoading(false)
      return
    }
    setImpact(parsed)
    setLoading(false)
  }, [translation.id])

  useEffectLoad(load)

  const candidates = siblings.filter((row) => !row.archived_at)
  const needsReplacementChoice = impact?.isServed === true

  const run = async (mode: 'archive' | 'purge') => {
    setWorking(true)
    setError('')
    try {
      if (mode === 'archive') {
        const { error: rpcError } = await supabase.rpc('admin_archive_material_version', {
          target_translation: translation.id,
          reason: reason.trim(),
          // The generated type marks this argument optional because the SQL
          // default is null, so "no replacement" is passed as undefined rather
          // than an explicit null.
          replacement_translation: replacement === '' ? undefined : replacement,
          unpublish_material: unpublish,
        })
        if (rpcError) throw new Error(rpcError.message)
        await onDone(
          unpublish && replacement === ''
            ? `Archived ${languageLabel(translation.language)} v${translation.version} and unpublished this material. Students will see that no published material is available until a version is published again. The file is preserved.`
            : `Archived ${languageLabel(translation.language)} v${translation.version}. ${
                replacement === ''
                  ? 'No older version was exposed to students.'
                  : 'A replacement version is now the published one.'
              } The file is preserved.`,
        )
        return
      }

      // Permanent deletion goes through the Edge Function so the private bucket
      // file is removed with the service role, never from the browser.
      const { data, error: invokeError } = await supabase.functions.invoke('delete-material-version', {
        body: { translationId: translation.id, reason: reason.trim() },
      })
      if (invokeError) throw new Error(invokeError.message || 'Deletion failed.')
      const result = (data ?? {}) as { error?: string; storagePending?: string[] | null; removedObjects?: string[] }
      if (result.error) throw new Error(result.error)
      await onDone(
        `Permanently deleted ${languageLabel(translation.language)} v${translation.version} and its file.` +
          (result.storagePending
            ? ` The record is gone but file cleanup is pending (${result.storagePending.join(', ')}) and can be retried safely.`
            : ' Signed links already issued remain usable until they expire.'),
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action failed.')
      setWorking(false)
    }
  }

  return (
    <Modal
      title={`Delete ${languageLabel(translation.language)} version ${translation.version}`}
      onClose={onClose}
    >
      {loading && <p role="status">Checking what this version affects…</p>}
      {loadError && <p className="error">{loadError}</p>}

      {impact && (
        <>
          <p>
            <strong>{impact.title}</strong> · {Math.ceil(impact.sizeBytes / 1024)} KB
          </p>

          <ImpactList
            title="What would be affected"
            items={[
              `${impact.accessEvents} student link(s) were issued for this file`,
              impact.sharedObjectReferences > 0
                ? `${impact.sharedObjectReferences} other version(s) share this file`
                : 'This file belongs only to this version',
              impact.isServed
                ? 'This is the version students currently receive'
                : 'Students are not currently served this version',
            ]}
          />

          {needsReplacementChoice && (
            <div className="warning-note">
              <strong>This is the version students are currently receiving.</strong>
              <p>
                Choose which version takes over, or unpublish the material entirely. Students will
                not be silently switched to an older version, and a signed link they already hold
                stays usable until it expires.
              </p>
              {candidates.length > 0 && (
                <label className="field">
                  <span>Publish this version instead</span>
                  <select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
                    <option value="">Choose a replacement…</option>
                    {candidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {languageLabel(candidate.language)} v{candidate.version}
                        {candidate.published ? ' (published)' : ' (draft)'} — {candidate.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={unpublish}
                  onChange={(event) => setUnpublish(event.target.checked)}
                  disabled={replacement !== ''}
                />
                Unpublish this material instead. Students will be told no published material is
                available until a version is published again.
              </label>
            </div>
          )}

          {!impact.canPurge && (
            <p className="warning-note">
              This version has history or is in use, so it can only be archived. Archiving hides it
              from the default list and stops it being served, while preserving the record and the
              file.
            </p>
          )}

          <label className="field">
            <span>Reason (required)</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              required
              placeholder="Recorded in the audit log"
            />
          </label>

          {error && <p className="error">{error}</p>}

          <ModalActions>
            <button className="secondary" onClick={onClose} disabled={working}>
              Cancel
            </button>
            {impact.canPurge && (
              <button
                className="dangerous"
                disabled={
                  working ||
                  reason.trim().length < 3 ||
                  (needsReplacementChoice && replacement === '' && !unpublish)
                }
                onClick={() => void run('purge')}
              >
                {working ? 'Deleting…' : 'Delete permanently'}
              </button>
            )}
            <button
              className="button"
              disabled={
                working ||
                reason.trim().length < 3 ||
                (needsReplacementChoice && replacement === '' && !unpublish)
              }
              onClick={() => void run('archive')}
            >
              {working ? 'Archiving…' : 'Archive instead'}
            </button>
          </ModalActions>
        </>
      )}
    </Modal>
  )
}
