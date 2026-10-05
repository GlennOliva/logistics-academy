import type { Database, Json } from './database.types'

type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']

export type Enrollment = Row<'enrollments'>
export type Module = Row<'modules'>
export type ModuleTranslation = Row<'module_translations'>
export type ModuleProgress = Row<'module_progress'>
export type EnrollmentModule = Row<'enrollment_modules'>
export type Quiz = Row<'quizzes'>
export type QuizAttempt = Row<'quiz_attempts'>
export type Course = Row<'courses'>
export type Order = Row<'orders'>
export type PaymentSubmission = Row<'payment_submissions'>
export type PaymentMethod = Row<'payment_methods'>
export type Profile = Row<'profiles'>

export type ProgressSummary = {
  required_total: number
  required_complete: number
  percent_complete: number
  /** Required modules whose lesson has been recorded as studied. */
  required_studied: number
  /** Lesson-study progress: studied required modules / total required modules. */
  percent_studied: number
  final_unlocked: boolean
}

export type MaterialGrant = {
  allowed: boolean
  error?: string
  objectPath?: string
  title?: string
  language?: string
  requestedLanguage?: string
  fallback?: boolean
  version?: number
  sizeBytes?: number
}

export type MaterialLinkResponse = {
  url: string
  expiresInSeconds: number
  title: string
  language: string
  requestedLanguage: string
  /** Stored object format, so the UI labels PowerPoint without URL guessing. */
  format?: 'pdf' | 'ppt' | 'pptx' | 'unknown'
  fallback: boolean
  version: number
  sizeBytes: number
}

export type QuizQuestion = {
  id: string
  prompt: string
  options: { id: string; label: string }[]
}

export type QuizPayload = {
  attemptId: string
  kind: 'knowledge_check' | 'final'
  attemptNumber: number
  language: string
  state: 'in_progress' | 'scored'
  score: number | null
  passed: boolean | null
  passThreshold: number | null
  questions: QuizQuestion[]
}

export type QuizResult = {
  attemptId: string
  score: number | null
  passed: boolean | null
  correct?: number
  total?: number
  alreadyScored?: boolean
}

export type AdminTranslationResponse = {
  translationId: string
  moduleId: string
  language: string
  version: number
  published: boolean
  title: string
  objectPath: string
  sizeBytes: number
  fileName: string
  /** True when the same object was already stored, so no new version was created. */
  unchanged: boolean
}

export type ModuleDeleteImpact = {
  moduleId: string
  title: string
  status: string
  required: boolean
  archivedAt: string | null
  enrollmentReferences: number
  progressRecords: number
  materialAccessRecords: number
  materialVersions: number
  knowledgeChecks: number
  questionCount: number
  certificateReferences: number
  /** True only for an unused draft with nothing referencing it anywhere. */
  canPurge: boolean
  blockers: string[]
}

export type MaterialVersionImpact = {
  translationId: string
  moduleId: string
  language: string
  version: number
  title: string
  objectPath: string
  sizeBytes: number
  published: boolean
  archivedAt: string | null
  /** This version is the one students are currently served. */
  isServed: boolean
  accessEvents: number
  newerPublishedAvailable: number
  olderPublishedAvailable: number
  sharedObjectReferences: number
  /** True when history or a shared file means archive-only. */
  canPurge: boolean
  mustArchive: boolean
}

export function asJson(value: unknown): Json {
  return value as Json
}

/** Turns a Supabase RPC failure into a message that is safe to show a user. */
export function errorMessage(error: { message: string } | null, fallback: string) {
  return error ? error.message : fallback
}