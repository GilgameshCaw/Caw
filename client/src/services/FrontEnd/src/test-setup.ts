/**
 * test-setup.ts
 *
 * Vitest global setup file. Runs before every test suite.
 * Extends expect with @testing-library/jest-dom matchers
 * (toBeInTheDocument, toBeDisabled, toHaveAttribute, etc.).
 */

import '@testing-library/jest-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// argon2-browser's dist/argon2.js is an Emscripten module. In happy-dom, the
// environment has `window` defined, so Emscripten thinks it's in a browser and
// tries to XHR-fetch the .wasm binary — which fails in Node. Pre-load the WASM
// binary into Module.wasmBinary so Emscripten uses it directly instead of
// fetching. argon2-browser reads `self.Module.wasmBinary` at init time.
//
// The path is computed from process.cwd() (vitest sets this to the project root,
// i.e. client/src/services/FrontEnd/) so resolve() from cwd works.
const wasmFilePath = resolve(
  process.cwd(),
  'node_modules/argon2-browser/dist/argon2.wasm',
)

let wasmBinary: Uint8Array | undefined
try {
  wasmBinary = new Uint8Array(readFileSync(wasmFilePath))
} catch {
  // Silently skip — argon2-browser tests will fail with a clear message
  // if the WASM is missing rather than crashing the entire test run.
}

if (wasmBinary !== undefined) {
  // Set self.Module before argon2-browser loads it — Emscripten reads
  // `typeof self !== 'undefined' && typeof self.Module !== 'undefined'
  //  ? self.Module : {}` at module init time. Providing wasmBinary here
  // makes Emscripten skip the XHR-fetch path and use the pre-loaded bytes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).Module = {
    ...(typeof (globalThis as any).Module === 'object' ? (globalThis as any).Module : {}),
    wasmBinary,
  }
}

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
