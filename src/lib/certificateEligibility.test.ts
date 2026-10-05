import { describe, expect, it } from 'vitest'

import { parseCertificateEligibility } from './certificateEligibility'

const eligiblePayload = {
  course_id: '11111111-1111-4111-8111-111111111111',
  config_enabled: true,
  enrollment_active: true,
  expected_module_count: 8,
  required_module_count: 8,
  required_completed: 8,
  required_outstanding: 0,
  outstanding_titles: '',
  required_score: 80,
  best_final_score: 100,
  certificate_status: 'active',
  eligible: true,
  blockers: [],
}

describe('parseCertificateEligibility', () => {
  it('accepts the payload built by certificate_eligibility', () => {
    expect(parseCertificateEligibility(eligiblePayload)).toMatchObject({
      config_enabled: true,
      enrollment_active: true,
      expected_module_count: 8,
      required_module_count: 8,
      required_completed: 8,
      required_outstanding: 0,
      outstanding_titles: '',
      required_score: 80,
      best_final_score: 100,
      certificate_status: 'active',
      eligible: true,
      blockers: [],
    })
  })

  it('keeps genuine blockers from an incomplete enrollment', () => {
    const parsed = parseCertificateEligibility({
      ...eligiblePayload,
      required_completed: 6,
      required_outstanding: 2,
      outstanding_titles: 'Accessorials, Delivery and Load Closing',
      best_final_score: 72,
      certificate_status: null,
      eligible: false,
      blockers: [
        '2 required module(s) are still incomplete: Accessorials, Delivery and Load Closing.',
        'A passing final assessment score of at least 80 is required. Your best score is 72.',
      ],
    })

    expect(parsed?.eligible).toBe(false)
    expect(parsed?.blockers).toHaveLength(2)
    expect(parsed?.certificate_status).toBeNull()
  })

  it('treats a missing config as null rather than inventing a threshold', () => {
    const parsed = parseCertificateEligibility({
      ...eligiblePayload,
      config_enabled: false,
      expected_module_count: null,
      required_score: null,
      best_final_score: null,
      eligible: false,
      blockers: ['Certificate issuance is not enabled for this course.'],
    })

    expect(parsed?.expected_module_count).toBeNull()
    expect(parsed?.required_score).toBeNull()
    expect(parsed?.best_final_score).toBeNull()
  })

  it('defaults absent blockers to an empty list', () => {
    const withoutBlockers: Record<string, unknown> = { ...eligiblePayload }
    delete withoutBlockers.blockers

    expect(parseCertificateEligibility(withoutBlockers as never)?.blockers).toEqual([])
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'eligible'],
    ['an array', []],
    ['a non-finite number', { ...eligiblePayload, required_completed: 'many' }],
    ['a string boolean', { ...eligiblePayload, eligible: 'yes' }],
    ['a numeric string count', { ...eligiblePayload, required_module_count: '8' }],
    ['non-string blockers', { ...eligiblePayload, blockers: [1, 2] }],
  ])('rejects %s without inventing eligibility', (_label, payload) => {
    expect(parseCertificateEligibility(payload as never)).toBeNull()
  })
})
