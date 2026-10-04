#!/usr/bin/env node

import { writeFileSync } from 'node:fs'

const outputPath = '.admin-provisioning.local'

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(2)
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse('run this command in an interactive terminal')
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.resume()

  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (character) => {
      if (character === '\u0003') return finish(new Error('Preparation cancelled'))
      if (character === '\r' || character === '\n') return finish()
      if (character === '\u007f') {
        value = value.slice(0, -1)
        return
      }
      if (character >= ' ') value += character
    }
    process.stdin.on('data', onData)
  })
}

const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase()
const reason = process.env.ADMIN_PROVISIONING_REASON?.trim()
if (!email || !reason) refuse('INITIAL_ADMIN_EMAIL and ADMIN_PROVISIONING_REASON are required')

const serviceRoleKey = await readSecret('Service-role key (input hidden): ')
if (!serviceRoleKey) refuse('a service-role key is required')

const initialPassword = await readSecret('Initial password (input hidden): ')
if (initialPassword.length < 8 || !/[A-Za-z]/.test(initialPassword) || !/\d/.test(initialPassword)) {
  refuse('initial password must contain at least eight characters, one letter, and one digit')
}
const confirmation = await readSecret('Repeat initial password (input hidden): ')
if (confirmation !== initialPassword) refuse('passwords do not match')

writeFileSync(
  outputPath,
  `${JSON.stringify({ email, reason, serviceRoleKey, initialPassword })}\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'wx' },
)
console.log(`One-use provisioning input created at ${outputPath}. It will be deleted as soon as provisioning reads it.`)
