/**
 * recovery.spec.ts
 *
 * E2E tests for the Population-B /recovery flow.
 *
 * All tests assume the Vite dev server is running on port 5274.
 * No sponsor or RPC mocks needed — the recovery flow is purely
 * client-side (file parse + PBKDF2 decrypt via Web Crypto).
 *
 * Tests:
 *   3. Happy path — upload valid blob + correct password → success screen
 *   4. Wrong vault password — blob present, wrong password → error shown,
 *      key NOT stored in RecoveryProvider (isInRecoveryMode stays false)
 */

import { test, expect } from '@playwright/test'
import { buildValidBackupBlob } from './helpers'

const CORRECT_PASSWORD = 'Str0ngV@ultPass!'
const WRONG_PASSWORD = 'wrongpassword999'

// ---------------------------------------------------------------------------
// Test 3 — Recovery happy path
// ---------------------------------------------------------------------------

test('recovery happy-path: upload blob → correct password → success + navigate home', async ({ page }) => {
  // Build a real AES-GCM encrypted blob in the test process.
  // buildValidBackupBlob uses Node's globalThis.crypto (Node 20+ / WebCrypto).
  const blobJson = await buildValidBackupBlob(CORRECT_PASSWORD)

  await page.goto('/recovery')

  // The file-select step should be visible.
  await expect(page.locator('text=/recovery|backup/i').first()).toBeVisible({ timeout: 5_000 })

  // Simulate the file upload by setting the hidden <input type="file">.
  // Playwright's setInputFiles injects the file directly without a native picker dialog.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'caw-recovery-alice.json',
    mimeType: 'application/json',
    buffer: Buffer.from(blobJson, 'utf-8'),
  })

  // After a valid blob is loaded, the flow advances to the 'password' step.
  const passwordInput = page.locator('input[type="password"]')
  await expect(passwordInput).toBeVisible({ timeout: 5_000 })

  // Fill in the correct vault password.
  await passwordInput.fill(CORRECT_PASSWORD)

  // Click the decrypt button.
  const decryptBtn = page.locator('button', { hasText: /decrypt|unlock|continue/i })
  await expect(decryptBtn).toBeEnabled({ timeout: 3_000 })
  await decryptBtn.click()

  // ── Success screen ───────────────────────────────────────────────────────
  // Recovery.tsx transitions to step === 'success' which shows a green
  // checkmark and the derived Ethereum address.
  // The success heading text comes from t('recovery.success.heading').
  // We look for the green circle icon as a stable anchor.
  const successIcon = page.locator('svg.w-7.h-7.text-green-500')
  await expect(successIcon).toBeVisible({ timeout: 10_000 })

  // The derived address of our deterministic fake key (all 0x42 bytes) should
  // be displayed. We don't assert the exact address — just that an 0x-prefixed
  // hex string appears somewhere on screen.
  const addressDisplay = page.locator('p.font-mono')
  await expect(addressDisplay).toContainText('0x', { timeout: 5_000 })

  // "Continue" button navigates to /home.
  const continueBtn = page.locator('button', { hasText: /continue|home|feed/i })
  await expect(continueBtn).toBeVisible()
  await continueBtn.click()

  await expect(page).toHaveURL(/\/home/, { timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 4 — Wrong vault password
// ---------------------------------------------------------------------------

test('recovery wrong-password: error shown, key NOT in memory, file not cleared', async ({ page }) => {
  const blobJson = await buildValidBackupBlob(CORRECT_PASSWORD)

  await page.goto('/recovery')

  // Upload the valid blob.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'caw-recovery-alice.json',
    mimeType: 'application/json',
    buffer: Buffer.from(blobJson, 'utf-8'),
  })

  const passwordInput = page.locator('input[type="password"]')
  await expect(passwordInput).toBeVisible({ timeout: 5_000 })

  // Enter the WRONG password.
  await passwordInput.fill(WRONG_PASSWORD)

  const decryptBtn = page.locator('button', { hasText: /decrypt|unlock|continue/i })
  await decryptBtn.click()

  // ── Error should surface ─────────────────────────────────────────────────
  // Recovery.tsx maps the DOMException to t('recovery.error.wrong_password').
  // We check for a red error message (text-red-500).
  const errorMsg = page.locator('p.text-red-500, p.text-sm.text-red-500')
  await expect(errorMsg).toBeVisible({ timeout: 8_000 })

  // ── File NOT cleared ─────────────────────────────────────────────────────
  // Per the comment in Recovery.tsx: on wrong-password, the file is NOT
  // cleared so the user can retry without re-uploading.
  // We verify by checking the password input is still visible (still on
  // the 'password' step, not back to 'file-select').
  await expect(passwordInput).toBeVisible()

  // ── No key in memory ────────────────────────────────────────────────────
  // RecoveryProvider keeps the key in React state only. We verify that
  // isInRecoveryMode is false by checking that the app has NOT navigated to
  // a success screen (the step hasn't advanced).
  const successIcon = page.locator('svg.text-green-500')
  await expect(successIcon).not.toBeVisible()

  // ── Retry with correct password succeeds ────────────────────────────────
  // (This also demonstrates the file-not-cleared UX path.)
  await passwordInput.fill(CORRECT_PASSWORD)
  await decryptBtn.click()

  const retrySuccess = page.locator('svg.w-7.h-7.text-green-500')
  await expect(retrySuccess).toBeVisible({ timeout: 10_000 })
})
