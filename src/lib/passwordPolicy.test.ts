import { describe, expect, it } from 'vitest'

import {
  PASSWORD_MAX_LENGTH,
  passwordConfirmationError,
  passwordPolicyError,
} from './passwordPolicy'

describe('passwordPolicyError', () => {
  it('accepts the configured letters and digits policy', () => {
    expect(passwordPolicyError('NewPass123')).toBeNull()
  })

  it('rejects short passwords', () => {
    expect(passwordPolicyError('Ab1')).toBe('Use at least 8 characters.')
  })

  it('rejects passwords without a letter', () => {
    expect(passwordPolicyError('12345678')).toBe('Include at least one letter.')
  })

  it('rejects passwords without a number', () => {
    expect(passwordPolicyError('longpassword')).toBe('Include at least one number.')
  })

  it('rejects passwords beyond the Auth bcrypt limit', () => {
    expect(passwordPolicyError(`A1${'x'.repeat(PASSWORD_MAX_LENGTH)}`)).toBe(
      `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`,
    )
  })
})

describe('passwordConfirmationError', () => {
  it('requires a confirmation', () => {
    expect(passwordConfirmationError('NewPass123', '')).toBe('Confirm the new password.')
  })

  it('requires the confirmation to match exactly', () => {
    expect(passwordConfirmationError('NewPass123', 'NewPass124')).toBe(
      'The passwords do not match.',
    )
  })

  it('accepts a matching confirmation', () => {
    expect(passwordConfirmationError('NewPass123', 'NewPass123')).toBeNull()
  })
})
