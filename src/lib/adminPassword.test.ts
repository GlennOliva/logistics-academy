import { describe, expect, it } from 'vitest'

import { interpretAdminPasswordChange } from './adminPassword'

describe('interpretAdminPasswordChange', () => {
  it('reports a complete reset only when the password and sessions both succeeded', () => {
    const result = interpretAdminPasswordChange({
      status: 'complete',
      passwordUpdated: true,
      sessionsRevoked: true,
      isSelf: false,
      message: 'Password updated.',
    })

    expect(result.complete).toBe(true)
    expect(result.message).toBe('Password updated.')
  })

  it('keeps a password-only result as partial and mentions a missing audit', () => {
    const result = interpretAdminPasswordChange({
      status: 'password_updated_sessions_not_revoked',
      passwordUpdated: true,
      sessionsRevoked: false,
      auditRecorded: false,
      warning: 'Sessions were not revoked.',
    })

    expect(result.complete).toBe(false)
    expect(result.passwordUpdated).toBe(true)
    expect(result.sessionsRevoked).toBe(false)
    expect(result.message).toContain('Sessions were not revoked.')
    expect(result.message).toContain('audit event also could not be recorded')
  })

  it('does not treat an unknown payload as success', () => {
    const result = interpretAdminPasswordChange(null)

    expect(result.complete).toBe(false)
    expect(result.passwordUpdated).toBe(false)
    expect(result.message).toBe('The password was not updated.')
  })
})
