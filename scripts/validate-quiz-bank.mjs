#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const jsonPath = new URL('../quiz/quiz_all_modules_en.json', import.meta.url)
const csvPath = new URL('../quiz/quiz_all_modules_en.csv', import.meta.url)
const manifestPath = new URL('../quiz/import-manifest.json', import.meta.url)

function parseCsv(input) {
  input = input.replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field')

  const [headers, ...values] = rows
  return values.filter((value) => value.some(Boolean)).map((value) => Object.fromEntries(headers.map((header, index) => [header, value[index] ?? ''])))
}

function normalizeJson(question) {
  return {
    id: String(question.id),
    module_number: String(question.module_number),
    module: question.module,
    question: question.question,
    option_a: question.options.a,
    option_b: question.options.b,
    option_c: question.options.c,
    option_d: question.options.d,
    correct: question.correct,
    explanation: question.explanation,
  }
}

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

const jsonContents = readFileSync(jsonPath, 'utf8')
const csvContents = readFileSync(csvPath, 'utf8')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const source = JSON.parse(jsonContents)
const jsonQuestions = source.questions.map(normalizeJson)
const csvQuestions = parseCsv(csvContents)
const errors = []

if (source.language !== 'en') errors.push('Only the declared English bank is expected here.')
if (source.total_questions !== jsonQuestions.length) errors.push('The JSON total_questions value does not match its records.')
if (jsonQuestions.length !== 15) errors.push('The reviewed bank is expected to contain 15 questions.')
if (new Set(jsonQuestions.map((question) => question.id)).size !== jsonQuestions.length) errors.push('Question IDs are not unique.')

for (const question of jsonQuestions) {
  if (!question.question.trim() || !question.explanation.trim()) errors.push(`Question ${question.id} has missing text.`)
  if (!['a', 'b', 'c', 'd'].includes(question.correct)) errors.push(`Question ${question.id} has an invalid correct-option key.`)
  if (['option_a', 'option_b', 'option_c', 'option_d'].some((key) => !question[key].trim())) errors.push(`Question ${question.id} has a blank option.`)
}

const formatMismatches = jsonQuestions.flatMap((question, index) =>
  Object.keys(question)
    .filter((key) => question[key] !== csvQuestions[index]?.[key])
    .map((field) => ({ questionId: question.id, field })),
)
if (formatMismatches.length > 0 || jsonQuestions.length !== csvQuestions.length) {
  errors.push(`The CSV and JSON banks differ at: ${formatMismatches.map((item) => `question ${item.questionId} ${item.field}`).join(', ')}.`)
}

const approvedTitles = new Map(manifest.modules.map((module) => [module.position, module.title]))
const sourceModules = [...new Map(jsonQuestions.map((question) => [Number(question.module_number), question.module])).entries()]
const sourceHash = hash(jsonContents)
if (manifest.assessment_kind !== 'final') errors.push('The approved assessment shape must be final.')
if (manifest.language !== source.language) errors.push('The approved language does not match the source bank.')
if (manifest.pass_threshold !== 75) errors.push('The approved final pass threshold must remain 75%.')
if (manifest.max_attempts !== null || manifest.cooldown_hours !== null) errors.push('The approved final retry policy is unlimited with no cooldown.')
if (manifest.enabled !== false) errors.push('The final must remain disabled until module knowledge checks and retake rules are complete.')
if (manifest.source_sha256 !== sourceHash) errors.push('The protected JSON source changed after owner approval.')
if (approvedTitles.size !== 8 || sourceModules.some(([number]) => !approvedTitles.has(number))) {
  errors.push('The approved manifest must map all eight source modules.')
}

const report = {
  structurallyValid: errors.length === 0,
  equivalentFormats: formatMismatches.length === 0 && jsonQuestions.length === csvQuestions.length,
  importReady: errors.length === 0,
  importedQuestions: 0,
  questionCount: jsonQuestions.length,
  language: source.language,
  modules: sourceModules.map(([moduleNumber]) => ({ moduleNumber, title: approvedTitles.get(moduleNumber) })),
  sourceHashes: { json: sourceHash, csv: hash(csvContents) },
  errors,
  ambiguity: [],
  approvedImport: {
    assessmentKind: manifest.assessment_kind,
    passThreshold: manifest.pass_threshold,
    maxAttempts: manifest.max_attempts,
    cooldownHours: manifest.cooldown_hours,
    enabled: manifest.enabled,
    knowledgeChecksUnchanged: true,
  },
}

console.log(JSON.stringify(report, null, 2))
if (errors.length > 0) process.exitCode = 1
