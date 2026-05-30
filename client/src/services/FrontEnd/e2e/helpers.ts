/**
 * helpers.ts
 *
 * Shared utilities for Population-B E2E tests.
 *
 * virtual-authenticator setup: Chromium exposes the WebAuthn CDP domain at
 * the protocol level. We reach it via page.context().newCDPSession(page).
 * Once addVirtualAuthenticator returns, navigator.credentials.create()
 * and .get() route through the CDP-controlled authenticator instead of
 * hitting a real OS prompt.
 *
 * route mocking: page.route() intercepts network calls so tests don't
 * need a live sponsor server, RPC node, or contract.
 */

import type { CDPSession, Page } from '@playwright/test'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Minimal type for AddVirtualAuthenticatorResponse */
export interface VirtualAuthenticatorOptions {
  protocol: 'ctap2' | 'u2f'
  transport: 'internal' | 'usb' | 'nfc' | 'ble'
  hasResidentKey: boolean
  hasUserVerification: boolean
  isUserVerified: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Virtual authenticator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Install a CDP virtual WebAuthn authenticator on the given page.
 *
 * Returns the CDPSession so callers can tear it down or inspect credentials
 * if needed. The authenticator is `internal` (platform) so residentKey=required
 * in navigator.credentials.create() is satisfied without user-gesture prompts.
 *
 * Reference: https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/
 */
export async function installVirtualAuthenticator(
  page: Page,
  opts: Partial<VirtualAuthenticatorOptions> = {},
): Promise<{ session: CDPSession; authenticatorId: string }> {
  const session = await page.context().newCDPSession(page)

  // Enable the WebAuthn CDP domain.
  await session.send('WebAuthn.enable', { enableUI: false })

  const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: opts.protocol ?? 'ctap2',
      transport: opts.transport ?? 'internal',
      hasResidentKey: opts.hasResidentKey ?? true,
      hasUserVerification: opts.hasUserVerification ?? true,
      isUserVerified: opts.isUserVerified ?? true,
    },
  }) as { authenticatorId: string }

  return { session, authenticatorId }
}

// ────────────────────────────────────────────────────────────────────────────
// Route mocks
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mount all route mocks required for the onboarding happy-path test.
 *
 * Intercepted:
 *   POST /api/sponsor/bootstrap → { txHash }
 *   POST /api/rpc/l1 (eth_call idByUsername) → tokenId = 0 (available)
 *   POST /api/rpc/l2 (eth_getTransactionReceipt) → { status: 1 }
 */
export async function mockOnboardingRoutes(page: Page): Promise<void> {
  // Sponsor bootstrap: return a fake txHash immediately.
  await page.route('**/api/sponsor/bootstrap', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        txHash: '0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      }),
    })
  })

  // eth_call for idByUsername: return 0 (username is available).
  // The RPC proxy lives at /api/rpc/l1 or VITE_API_HOST/api/rpc/l1.
  // wagmi's useReadContract hits /api/rpc/l1 via the configured transport.
  // We match on the method name inside the body.
  await page.route('**/api/rpc/l1', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    if (body.method === 'eth_call') {
      // idByUsername returns uint32 — 0 means available.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
        }),
      })
    } else {
      // Let other L1 calls through (or default them to a noop).
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1' }),
      })
    }
  })

  // L2 receipt: confirmed.
  await page.route('**/api/rpc/l2', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          transactionHash:
            '0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          status: '0x1',
          blockNumber: '0x100',
        },
      }),
    })
  })

  // chainId reads (wagmi pre-flight).
  await page.route('**/api/rpc/**', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    if (body.method === 'eth_chainId') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xaa36a7' }), // Sepolia
      })
    } else {
      await route.continue()
    }
  })
}

/**
 * Build a minimal valid BackupBlob JSON string.
 *
 * The decryptBackupBlob function uses PBKDF2 when argon2.memorySize === 0.
 * We supply a real AES-GCM encrypted payload so the recovery test can
 * actually decrypt with the correct password.
 *
 * This helper uses the Web Crypto API via Node (Node 20+) — Playwright
 * runs tests in Node where globalThis.crypto is available.
 */
export async function buildValidBackupBlob(password: string): Promise<string> {
  // Derive a PBKDF2 key from the password (matches the PBKDF2 fallback path
  // in vaultPassword.ts / backupBlob.ts).
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )

  // The plaintext is a deterministic 32-byte secp256k1 private key.
  const fakePrivateKey = new Uint8Array(32).fill(0x42)
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    fakePrivateKey,
  )

  const bytesToHex = (b: Uint8Array): string =>
    '0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')

  // pubkeyAddress is not validated by validateBackupBlobShape beyond startsWith('0x')
  const blob = {
    version: 1,
    argon2: { memorySize: 0, iterations: 600_000, parallelism: 1 },
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertextBuffer)),
    pubkeyAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  }
  return JSON.stringify(blob)
}
