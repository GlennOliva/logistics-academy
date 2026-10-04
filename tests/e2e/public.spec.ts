import { expect, test } from '@playwright/test'

test('public course copy is accurate and transparent', async ({ page }) => {
  await page.goto('/courses/logistics-101')
  await expect(page.getByRole('heading', { name: 'Logistics 101' })).toBeVisible()
  await expect(page.getByText('₱699.00')).toBeVisible()
  await expect(page.getByText(/All eight module titles are trainer-approved/)).toBeVisible()
  await expect(page.getByText(/approval is not instant/i)).toBeVisible()
  await expect(page.getByRole('img', { name: /Logistics 101 course/ })).toBeVisible()
})

test('approved brand assets appear in the public shell and trainer profile', async ({ page }) => {
  await page.goto('/about')
  await expect(page.locator('header img[src="/logo.svg"]')).toBeVisible()
  await expect(page.locator('footer img[src="/logo.svg"]')).toBeVisible()
  await expect(page.getByRole('img', { name: /Angela Valiente/ })).toBeVisible()
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll')
})

test('protected checkout redirects to login without a session', async ({ page }) => {
  await page.goto('/checkout/logistics-101')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
})

test('contact methods use actionable links', async ({ page }) => {
  await page.goto('/contact')
  await expect(page.getByRole('link', { name: /Anjval27@gmail.com/ })).toHaveAttribute('href', 'mailto:Anjval27@gmail.com')
  await expect(page.getByRole('link', { name: /963 344 2176/ })).toHaveAttribute('href', 'tel:+639633442176')
})
