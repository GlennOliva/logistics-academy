export type AdminPasswordChangeOutcome = {
  complete: boolean
  passwordUpdated: boolean
  sessionsRevoked: boolean
  isSelf: boolean
  message: string
}

type Payload = {
  status?: unknown
  passwordUpdated?: unknown
  sessionsRevoked?: unknown
  sessionsDeleted?: unknown
  auditRecorded?: unknown
  isSelf?: unknown
  message?: unknown
  warning?: unknown
}

const completeFallback =
  'Password updated. The user must sign in again with the new password. Access tokens already issued remain valid until they expire.'
const partialFallback =
  "The new password was saved, but the user's refresh sessions could not be revoked."

export function interpretAdminPasswordChange(payload: unknown): AdminPasswordChangeOutcome {
  const data =
    payload && typeof payload === 'object' ? (payload as Payload) : ({} as Payload)
  const passwordUpdated = data.passwordUpdated === true
  const sessionsRevoked = data.sessionsRevoked === true
  const isSelf = data.isSelf === true
  const complete = data.status === 'complete' && passwordUpdated && sessionsRevoked

  if (complete) {
    return {
      complete: true,
      passwordUpdated: true,
      sessionsRevoked: true,
      isSelf,
      message: typeof data.message === 'string' && data.message ? data.message : completeFallback,
    }
  }

  if (passwordUpdated) {
    const warning =
      typeof data.warning === 'string' && data.warning ? data.warning : partialFallback
    const auditNote =
      data.auditRecorded === false
        ? ' The audit event also could not be recorded, so report this to an operator.'
        : ''
    return {
      complete: false,
      passwordUpdated: true,
      sessionsRevoked: false,
      isSelf,
      message: `${warning}${auditNote}`,
    }
  }

  return {
    complete: false,
    passwordUpdated: false,
    sessionsRevoked: false,
    isSelf,
    message: 'The password was not updated.',
  }
}
