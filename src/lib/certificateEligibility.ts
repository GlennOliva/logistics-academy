import type { Json } from './database.types'

/**
 * The per-condition breakdown returned by `public.certificate_eligibility`.
 *
 * The function is the only authority on whether a certificate may be issued, so
 * this type mirrors the payload it builds. `expected_module_count` and
 * `best_final_score` are null when the course has no certificate config yet or
 * no scored final attempt, and `certificate_status` is null until a certificate
 * row exists.
 */
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

type JsonRecord = { [key: string]: Json | undefined }

function isJsonRecord(value: Json | null | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBoolean(record: JsonRecord, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNullableNumber(record: JsonRecord, key: string): number | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function readNullableString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : null
}

function readStringArray(record: JsonRecord, key: string): string[] | null {
  const value = record[key]
  if (!Array.isArray(value)) return null
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null
}

/**
 * Validates the `jsonb` payload before the UI trusts it.
 *
 * The RPC is declared `returns jsonb`, so the generated types can only promise
 * `Json`. Rather than asserting the shape, every field is checked: a malformed
 * or unexpected payload returns null and the caller shows its retry message
 * instead of rendering invented eligibility numbers. Only `blockers` tolerates
 * absence, because an empty list is the truthful "nothing blocking" value and
 * must not blank out a real eligibility answer.
 */
export function parseCertificateEligibility(value: Json | null | undefined): CertificateEligibility | null {
  if (!isJsonRecord(value)) return null

  const configEnabled = readBoolean(value, 'config_enabled')
  const enrollmentActive = readBoolean(value, 'enrollment_active')
  const requiredModuleCount = readNumber(value, 'required_module_count')
  const requiredCompleted = readNumber(value, 'required_completed')
  const requiredOutstanding = readNumber(value, 'required_outstanding')
  const outstandingTitles = readString(value, 'outstanding_titles')
  const eligible = readBoolean(value, 'eligible')
  const blockers = value.blockers === undefined ? [] : readStringArray(value, 'blockers')

  if (
    configEnabled === null ||
    enrollmentActive === null ||
    requiredModuleCount === null ||
    requiredCompleted === null ||
    requiredOutstanding === null ||
    outstandingTitles === null ||
    eligible === null ||
    blockers === null
  ) {
    return null
  }

  return {
    config_enabled: configEnabled,
    enrollment_active: enrollmentActive,
    expected_module_count: readNullableNumber(value, 'expected_module_count'),
    required_module_count: requiredModuleCount,
    required_completed: requiredCompleted,
    required_outstanding: requiredOutstanding,
    outstanding_titles: outstandingTitles,
    required_score: readNullableNumber(value, 'required_score'),
    best_final_score: readNullableNumber(value, 'best_final_score'),
    certificate_status: readNullableString(value, 'certificate_status'),
    eligible,
    blockers,
  }
}
