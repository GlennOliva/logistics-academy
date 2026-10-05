import type { Json } from './database.types'
import type { MaterialVersionImpact, ModuleDeleteImpact } from './types'

function isJsonRecord(value: Json | null | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(record: { [key: string]: Json | undefined }, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readString(record: { [key: string]: Json | undefined }, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function readNullableString(record: { [key: string]: Json | undefined }, key: string): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : null
}

function readBoolean(record: { [key: string]: Json | undefined }, key: string): boolean {
  return record[key] === true
}

function readStringArray(record: { [key: string]: Json | undefined }, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function readId(record: { [key: string]: Json | undefined }, key: string): string {
  return readString(record, key)
}

/**
 * Reads the delete-impact report the database returned.
 *
 * The RPCs answer with jsonb, so the generated types can only promise `Json`.
 * Every field is validated rather than asserted, and an unusable payload is
 * refused outright: the confirmation dialog must never show a fabricated "safe to
 * delete" summary, because that is exactly the value that would be trusted.
 */
export function parseModuleDeleteImpact(value: Json | null | undefined): ModuleDeleteImpact | null {
  if (!isJsonRecord(value)) return null
  const moduleId = readId(value, 'moduleId')
  const title = readString(value, 'title')
  if (!moduleId || !title) return null

  return {
    moduleId,
    title,
    status: readString(value, 'status'),
    required: readBoolean(value, 'required'),
    archivedAt: readNullableString(value, 'archivedAt'),
    enrollmentReferences: readNumber(value, 'enrollmentReferences'),
    progressRecords: readNumber(value, 'progressRecords'),
    materialAccessRecords: readNumber(value, 'materialAccessRecords'),
    materialVersions: readNumber(value, 'materialVersions'),
    knowledgeChecks: readNumber(value, 'knowledgeChecks'),
    questionCount: readNumber(value, 'questionCount'),
    certificateReferences: readNumber(value, 'certificateReferences'),
    canPurge: readBoolean(value, 'canPurge'),
    blockers: readStringArray(value, 'blockers'),
  }
}

/** Same validation as the module impact report; see parseModuleDeleteImpact. */
export function parseMaterialVersionImpact(value: Json | null | undefined): MaterialVersionImpact | null {
  if (!isJsonRecord(value)) return null
  const translationId = readId(value, 'translationId')
  const moduleId = readId(value, 'moduleId')
  const objectPath = readString(value, 'objectPath')
  if (!translationId || !moduleId || !objectPath) return null

  return {
    translationId,
    moduleId,
    language: readString(value, 'language'),
    version: readNumber(value, 'version'),
    title: readString(value, 'title'),
    objectPath,
    sizeBytes: readNumber(value, 'sizeBytes'),
    published: readBoolean(value, 'published'),
    archivedAt: readNullableString(value, 'archivedAt'),
    isServed: readBoolean(value, 'isServed'),
    accessEvents: readNumber(value, 'accessEvents'),
    newerPublishedAvailable: readNumber(value, 'newerPublishedAvailable'),
    olderPublishedAvailable: readNumber(value, 'olderPublishedAvailable'),
    sharedObjectReferences: readNumber(value, 'sharedObjectReferences'),
    canPurge: readBoolean(value, 'canPurge'),
    mustArchive: readBoolean(value, 'mustArchive'),
  }
}
