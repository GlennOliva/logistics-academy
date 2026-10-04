import { describe, expect, it } from 'vitest'

import { signedInDestination } from './authRouting'

describe('signedInDestination', () => {
  it('routes a database-verified administrator to administration', () => {
    expect(signedInDestination(true)).toBe('/admin')
  })

  it('routes a student to the student dashboard', () => {
    expect(signedInDestination(false)).toBe('/dashboard')
  })
})
