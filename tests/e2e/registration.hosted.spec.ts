import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

test('validates the hosted password policy before sending signup', async ({ page }) => {
  let signupRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/auth/v1/signup')) signupRequests += 1
  })

  await page.goto('/register')
  await page.getByLabel('Full name').fill('Validation Test')
  await page.getByLabel('Email').fill('validation@example.com')
  await page.getByLabel('Password').fill('lettersOnly')
  await page.getByLabel(/at least 18/i).check()
  await page.getByLabel(/acknowledge the development-draft/i).check()
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByText('Include at least one number.')).toBeVisible()
  expect(signupRequests).toBe(0)
})

test('marks password recovery unavailable when email delivery is disabled', async ({ page }) => {
  await page.goto('/forgot-password')
  await expect(page.getByText(/Password recovery email is unavailable/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send recovery link' })).toBeDisabled()
})

test('captures a redacted hosted registration response', async ({ page }) => {
  test.skip(process.env.HOSTED_REGISTRATION_TEST !== '1', 'explicit hosted Auth mutation is required')

  const email = process.env.HOSTED_REGISTRATION_EMAIL
  if (!email) throw new Error('HOSTED_REGISTRATION_EMAIL is required')
  const password = `Registration-${randomUUID()}-Aa1!`

  await page.goto('/register')
  await page.getByLabel('Full name').fill('Hosted Registration Test')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByLabel(/at least 18/i).check()
  await page.getByLabel(/acknowledge the development-draft/i).check()

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/auth/v1/signup') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Create account' }).click()
  const response = await responsePromise
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  const user = payload.user as Record<string, unknown> | undefined
  const redirectTo = new URL(response.url()).searchParams.get('redirect_to')
  const safeEvidence = response.ok()
    ? {
        status: response.status(),
        redirectTo,
        userCreated: Boolean(user?.id),
        emailConfirmed: Boolean(user?.email_confirmed_at),
        sessionCreated: Boolean(payload.access_token),
      }
    : {
        status: response.status(),
        redirectTo,
        code: payload.code ?? payload.error_code ?? null,
        message: payload.msg ?? payload.message ?? payload.error_description ?? null,
      }

  const applicationMessage = response.ok() && payload.access_token
    ? null
    : await page.getByRole('status').textContent().catch(() => null)
  console.log(`REGISTRATION_NETWORK_EVIDENCE=${JSON.stringify(safeEvidence)}`)
  console.log(`REGISTRATION_APPLICATION_MESSAGE=${JSON.stringify(applicationMessage)}`)

  if (response.ok() && payload.access_token) {
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login$/)

    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    const loginResponsePromise = page.waitForResponse(
      (loginResponse) => loginResponse.url().includes('/auth/v1/token') && loginResponse.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Sign in' }).click()
    const loginResponse = await loginResponsePromise
    console.log(`STUDENT_LOGIN_NETWORK_EVIDENCE=${JSON.stringify({ status: loginResponse.status() })}`)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0)
  } else {
    await expect(page.getByRole('status')).toBeVisible()
  }
})

test('routes the database-authorized administrator to admin', async ({ page }) => {
  test.skip(process.env.HOSTED_ADMIN_LOGIN_TEST !== '1', 'explicit hidden admin credential is required')
  const password = process.env.HOSTED_ADMIN_LOGIN_PASSWORD
  if (!password) throw new Error('HOSTED_ADMIN_LOGIN_PASSWORD is required')

  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@gmail.com')
  await page.getByLabel('Password').fill(password)
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/auth/v1/token') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  const response = await responsePromise
  console.log(`ADMIN_LOGIN_NETWORK_EVIDENCE=${JSON.stringify({ status: response.status() })}`)
  await expect(page).toHaveURL(/\/admin$/)
})
