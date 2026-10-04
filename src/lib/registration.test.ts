import { describe, expect, it } from 'vitest'

import { registrationErrorMessage, registrationSuccessMessage } from './registration'

describe('registration feedback', () => {
  it('identifies an email quota failure as a failed signup', () => {
    expect(registrationErrorMessage({ code: 'over_email_send_rate_limit', status: 429 })).toContain(
      'did not create an account',
    )
  })

  it('explains the hosted password requirements', () => {
    expect(registrationErrorMessage({ code: 'weak_password', status: 422 })).toContain('one letter and one number')
  })

  it('distinguishes a newly created unconfirmed identity from an obfuscated existing account response', () => {
    expect(registrationSuccessMessage(1)).toMatch(/^Account created/)
    expect(registrationSuccessMessage(0)).toMatch(/^If this email is eligible/)
  })
})
