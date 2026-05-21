/**
 * test-setup.ts
 *
 * Vitest global setup file. Runs before every test suite.
 * Extends expect with @testing-library/jest-dom matchers
 * (toBeInTheDocument, toBeDisabled, toHaveAttribute, etc.).
 */

import '@testing-library/jest-dom'

// happy-dom provides TextEncoder/TextDecoder and a basic crypto.subtle
// implementation. Polyfill any gaps needed by the identity service layer.
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
  // Node 18+ provides webcrypto; fall back if somehow missing in happy-dom
  const { webcrypto } = await import('node:crypto')
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  })
}
