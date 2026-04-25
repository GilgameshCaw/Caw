// Read deployed contract addresses out of client/src/abi/addresses.ts so the
// CLI uses the same source of truth as the running app. Avoids the drift
// problem of hand-maintaining a CLI-side shim.
//
// addresses.ts is `export const NAME = '0x...' as const;` lines — trivially
// parseable with a regex. We read it once at module load and freeze.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// addresses.ts lives at repo-root/client/src/abi/addresses.ts; the CLI lives
// at repo-root/cli/src. Resolve once.
const ADDRESSES_TS = path.resolve(__dirname, '../../client/src/abi/addresses.ts')

let _cache = null

function load() {
  if (_cache) return _cache
  let src
  try {
    src = fs.readFileSync(ADDRESSES_TS, 'utf8')
  } catch (e) {
    throw new Error(`Failed to read addresses.ts at ${ADDRESSES_TS}: ${e.message}`)
  }
  // Match: export const FOO_ADDRESS = "0xabc..." as const;
  // Single or double quotes; trailing `as const;` optional; spaces flexible.
  const re = /export\s+const\s+([A-Z0-9_]+)\s*=\s*["']([^"']+)["']/g
  const out = {}
  let m
  while ((m = re.exec(src)) !== null) {
    out[m[1]] = m[2]
  }
  _cache = Object.freeze(out)
  return _cache
}

/**
 * Return the address for a given symbol (must exist in addresses.ts).
 * Throws if missing — fail-fast beats falling back to a stale duplicate.
 */
export function addr(name) {
  const all = load()
  const v = all[name]
  if (!v) throw new Error(`Address ${name} not found in client/src/abi/addresses.ts`)
  return v
}

/**
 * Return all addresses as a plain object (useful for debugging).
 */
export function allAddresses() {
  return load()
}
