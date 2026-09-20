// CSP guard. Fails a deploy (caw update / caw doctor) when the frontend's
// Content-Security-Policy, or the shipped index.html, would let injected
// script run.
//
// Why this exists: connect-src was widened to `https: wss:` (peers register
// on chain under arbitrary domains, so an allow-list cannot work), which
// means script-src is now the ONLY thing standing between an XSS and the
// Quick Sign session keys in localStorage. Nothing in the page can read a
// MetaMask / Rabby private key, but a script that runs in the page can read
// a plaintext QS key and spend that session's allotment. So: script-src is
// treated as load-bearing, and any change that loosens it must fail loudly
// at deploy time instead of shipping quietly.
//
// Pure functions + a thin file-reading wrapper so the rules are unit-testable
// (scripts/verify-csp-guard.js) and the same check runs from `caw doctor`,
// `caw update`, and CI.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { CSP_POLICY } from './nginx.js'

/** Parse "a b; c d" into { a: ['b'], c: ['d'] }. Directive names lower-cased. */
export function parseCsp(policy) {
  const out = {}
  for (const part of String(policy).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    out[tokens[0].toLowerCase()] = tokens.slice(1)
  }
  return out
}

// Keywords that let injected script execute, or that make hashes/nonces
// meaningless. Any of these in script-src is a hard failure.
const FORBIDDEN_SCRIPT_KEYWORDS = new Set([
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'unsafe-hashes'",
  "'strict-dynamic'",
  '*',
  'data:',
  'blob:',
  'filesystem:',
  'http:',
  'https:',
  'ws:',
  'wss:',
])

// A host source in script-src must be a single, exact, version-pinned path
// on a CDN we chose. Anything looser (bare host, wildcard subdomain, range
// version, http) would let a compromised or drifting upstream ship script.
const PINNED_HOST_SOURCE = /^https:\/\/[a-z0-9.-]+\/[^*\s]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?\/$/

/**
 * Check a policy string. Returns an array of violation strings (empty =
 * pass). Rules are deliberately conservative: a false positive costs one
 * deliberate exception here, a false negative costs users their QS keys.
 */
export function checkCspPolicy(policy) {
  const v = []
  const d = parseCsp(policy)

  const scriptSrc = d['script-src']
  if (!scriptSrc) {
    v.push("script-src is missing (default-src would govern scripts; be explicit)")
  } else {
    for (const src of scriptSrc) {
      const s = src.toLowerCase()
      if (FORBIDDEN_SCRIPT_KEYWORDS.has(s)) v.push(`script-src contains ${src}`)
      else if (s.startsWith("'nonce-")) v.push(`script-src uses a nonce (${src}); nginx serves static files, so a static nonce is equivalent to unsafe-inline`)
      else if (s === "'self'" || s === "'wasm-unsafe-eval'" || s.startsWith("'sha256-") || s.startsWith("'sha384-") || s.startsWith("'sha512-")) continue
      else if (s.startsWith('http://')) v.push(`script-src allows a plaintext-http host: ${src}`)
      else if (s.includes('*')) v.push(`script-src allows a wildcard host: ${src}`)
      else if (!PINNED_HOST_SOURCE.test(src)) v.push(`script-src host source is not an exact version-pinned path (expected https://host/path@x.y.z/): ${src}`)
    }
  }

  const defaultSrc = d['default-src']
  if (!defaultSrc || defaultSrc.length !== 1 || defaultSrc[0] !== "'self'") {
    v.push(`default-src must be exactly 'self' (got: ${defaultSrc ? defaultSrc.join(' ') : 'missing'})`)
  }

  const objectSrc = d['object-src']
  if (!objectSrc || objectSrc.join(' ') !== "'none'") v.push(`object-src must be 'none' (got: ${objectSrc ? objectSrc.join(' ') : 'missing'})`)

  const baseUri = d['base-uri']
  if (!baseUri || !["'self'", "'none'"].includes(baseUri.join(' '))) v.push(`base-uri must be 'self' or 'none' (got: ${baseUri ? baseUri.join(' ') : 'missing'})`)

  const frameAncestors = d['frame-ancestors']
  if (!frameAncestors || frameAncestors.join(' ') !== "'none'") v.push(`frame-ancestors must be 'none' (got: ${frameAncestors ? frameAncestors.join(' ') : 'missing'})`)

  // Workers execute script too. blob: is needed for browser-image-compression;
  // anything network-wide is not.
  const workerSrc = d['worker-src']
  if (workerSrc) {
    for (const src of workerSrc) {
      const s = src.toLowerCase()
      if (['*', 'https:', 'http:', 'data:', "'unsafe-inline'"].includes(s) || s.includes('*')) v.push(`worker-src contains ${src}`)
    }
  }

  return v
}

/** Hashes a string the way CSP expects: base64(sha256(bytes)). */
export function cspSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64')
}

/**
 * Check an index.html against the policy: every inline <script> must be
 * covered by a hash in script-src; no inline event handlers; no javascript:
 * URLs; no external <script src> off-origin unless it is an allowed pinned
 * source. Returns violation strings.
 */
export function checkIndexHtml(html, policy, label = 'index.html') {
  const v = []
  const d = parseCsp(policy)
  const allowedHashes = new Set((d['script-src'] || []).filter(s => /^'sha256-/.test(s)).map(s => s.slice("'sha256-".length, -1)))
  const allowedHosts = (d['script-src'] || []).filter(s => /^https:\/\//.test(s))

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1]
    const body = m[2]
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
    if (srcMatch) {
      const src = srcMatch[1]
      const external = /^(?:https?:)?\/\//i.test(src)
      if (external && !allowedHosts.some(h => src.startsWith(h))) {
        v.push(`${label}: external <script src="${src}"> is not an allowed pinned source`)
      }
      continue
    }
    // Inline script: CSP hashes the exact bytes between the tags.
    const hash = cspSha256(body)
    if (!allowedHashes.has(hash)) {
      v.push(`${label}: inline <script> is not covered by a script-src hash (computed sha256-${hash}). If the change is intended, update CSP_POLICY in cli/src/steps/nginx.js.`)
    }
  }

  // Inline event handlers are blocked by any script-src without
  // 'unsafe-inline'/'unsafe-hashes', so they are either dead code or a sign
  // someone is about to add one of those. (The Inter font async-load
  // regression was exactly this shape.)
  const handlerRe = /<[a-z][^>]*\s(on[a-z]+)\s*=/gi
  while ((m = handlerRe.exec(html)) !== null) {
    v.push(`${label}: inline event handler attribute ${m[1]}= (blocked by CSP; would only work with 'unsafe-inline')`)
  }
  if (/\bhref\s*=\s*["']\s*javascript:/i.test(html)) v.push(`${label}: javascript: URL`)

  return v
}

/**
 * File-reading wrapper. Checks CSP_POLICY plus the source index.html and,
 * when present, the built dist/index.html (Vite rewrites the file, so the
 * inline theme script's bytes are what matter there).
 * Returns { checked: string[], violations: string[] }.
 */
export function runCspGuard(installDir) {
  const violations = [...checkCspPolicy(CSP_POLICY).map(s => `CSP_POLICY: ${s}`)]
  const checked = ['CSP_POLICY']
  const feDir = path.join(installDir, 'client', 'src', 'services', 'FrontEnd')
  for (const rel of ['index.html', path.join('dist', 'index.html')]) {
    const p = path.join(feDir, rel)
    if (!fs.existsSync(p)) continue
    checked.push(rel)
    violations.push(...checkIndexHtml(fs.readFileSync(p, 'utf8'), CSP_POLICY, rel))
  }
  return { checked, violations }
}
