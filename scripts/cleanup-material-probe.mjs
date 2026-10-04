#!/usr/bin/env node

// Removes the versions created by scripts/probe-material-formats.mjs.
//
// The probe titles every version it uploads with a "Format probe" prefix, so
// only probe rows are touched. Genuine Module 1 material, all other modules and
// every student progress row are left alone.
//
// The matching Storage objects cannot be removed from here because this project
// deliberately keeps no service role key on the machine. They are left orphaned
// in a private bucket: unreferenced, unsignable and unreachable by students.

import { spawnSync } from 'node:child_process'

const MODULE_1 = '994538f1-1544-4df0-aaba-f968f7addf93'

function sql(text) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--linked', text], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = `${result.stdout}${result.stderr}`
  return { ok: !(out.includes('ERROR') || out.includes('Failed to run sql query')), out }
}

const rows = sql(`select object_path from public.module_translations where title like 'Format probe%';`)
const paths = [...rows.out.matchAll(/course\/[0-9a-f-]+\/(?:en|ceb)\/[0-9a-f]+\.[a-z0-9]+/g)].map((match) => match[0])

if (paths.length === 0) {
  console.log('no probe versions found')
  process.exit(0)
}

console.log(`removing ${paths.length} probe version(s):`)
for (const path of paths) console.log(`  ${path}`)

const removed = sql(`delete from public.module_translations where title like 'Format probe%';`)
if (!removed.ok) {
  console.error('failed to remove probe versions')
  console.error(removed.out)
  process.exit(1)
}

console.log('probe versions removed')
console.log('orphaned storage objects (private, unreferenced):')
for (const path of paths) console.log(`  ${path}`)
