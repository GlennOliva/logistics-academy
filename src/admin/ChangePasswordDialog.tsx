import { useState, type FormEvent } from 'react'

import { Field } from '../components/ui'
import { interpretAdminPasswordChange, type AdminPasswordChangeOutcome } from '../lib/adminPassword'
import { edgeFunctionFailure } from '../lib/edgeFunctionError'
import {
  PASSWORD_POLICY_HINT,
  passwordConfirmationError,
  passwordPolicyError,
} from '../lib/passwordPolicy'
import { supabase } from '../lib/supabase'
import { Modal, ModalActions } from './Modal'

export type AdminPasswordTarget = {
  id: string
  fullName: string
  email: string
}

type Props = {
  target: AdminPasswordTarget
  onClose: () => void
  onCompleted: (outcome: AdminPasswordChangeOutcome) => void
}

export function ChangePasswordDialog({ target, onClose, onCompleted }: Props) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const close = () => {
    if (submitting) return
    setPassword('')
    setConfirmation('')
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting || done) return
    setError('')
    setSuccess('')

    const policyError = passwordPolicyError(password)
    if (policyError) {
      setError(policyError)
      return
    }
    const confirmationError = passwordConfirmationError(password, confirmation)
    if (confirmationError) {
      setError(confirmationError)
      return
    }

    setSubmitting(true)
    const { data, error: invokeError } = await supabase.functions.invoke('admin-change-password', {
      body: { targetUserId: target.id, newPassword: password },
    })
    setSubmitting(false)

    if (invokeError) {
      const failure = await edgeFunctionFailure(
        invokeError,
        'The password change could not be confirmed. Do not assume it succeeded.',
      )
      setError(failure.message)
      return
    }

    const outcome = interpretAdminPasswordChange(data)
    setPassword('')
    setConfirmation('')
    setShowPasswords(false)
    setDone(true)
    setSuccess(outcome.message)
    onCompleted(outcome)
  }

  const emailLabel = target.email || target.id

  return (
    <Modal title="Change password" onClose={close}>
      <p>
        Update the password for {emailLabel}? This user will need the new password to sign in
        again.
      </p>
      <p>
        <strong>{target.fullName}</strong>
        <br />
        {emailLabel}
      </p>

      <form onSubmit={submit} noValidate>
        <Field label="New password" hint={PASSWORD_POLICY_HINT}>
          <input
            type={showPasswords ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting || done}
            required
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type={showPasswords ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={submitting || done}
            required
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={showPasswords}
            onChange={(event) => setShowPasswords(event.target.checked)}
            disabled={submitting || done}
          />
          Show passwords
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="status" role="status">
            {success}
          </p>
        )}

        <ModalActions>
          <button type="button" className="secondary" onClick={close} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={submitting || done}>
            {submitting ? 'Updating password…' : 'Update Password'}
          </button>
        </ModalActions>
      </form>
    </Modal>
  )
}
