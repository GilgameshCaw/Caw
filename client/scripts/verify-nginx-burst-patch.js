// Verifies the "add nginx-level rate limiting to /api/" entry of
// NGINX_PATCHES in cli/src/steps/nginx.js. Imports the real entry rather
// than a copy, so the checks follow the code if it changes.
//
// Run (from client/): node scripts/verify-nginx-burst-patch.js [path-to-nginx.js]
// The optional path runs the same checks against another copy of nginx.js
// (e.g. a pre-fix version) to confirm they fail there.

const path = require('path')
const { pathToFileURL } = require('url')

const PATCH_NAME = 'add nginx-level rate limiting to /api/'
const L5 = 'limit_req zone=caw_general burst=5 nodelay;'
const L100 = 'limit_req zone=caw_general burst=100 nodelay;'
const L150 = 'limit_req zone=caw_general burst=150 nodelay;'

let failures = 0
function check(label, actual, expected) {
  const pass = actual === expected
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
const count = (s, needle) => s.split(needle).length - 1
function setBurst(v) {
  if (v === undefined) delete process.env.CAW_NGINX_RATE_LIMIT_BURST
  else process.env.CAW_NGINX_RATE_LIMIT_BURST = v
}

const fresh = `server {
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
    }
}
`
// Two server blocks, each with its own /api/ location.
const twoBlocks = `server {
    listen 80;
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
    }
}
server {
    listen 443 ssl;
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
    }
}
`
// Another location earlier in the file also uses the caw_general zone.
const otherLocation = `server {
    location /upload/ {
        ${L5}
        proxy_pass http://127.0.0.1:4000;
    }
    location /api/ {
        ${L100}
        proxy_pass http://127.0.0.1:4000;
    }
}
`

async function main() {
  const modPath = path.resolve(process.argv[2] || path.join(__dirname, '../../cli/src/steps/nginx.js'))
  const mod = await import(pathToFileURL(modPath).href)
  const patch = (mod.NGINX_PATCHES || []).find((p) => p.name === PATCH_NAME)
  if (!patch) {
    console.error(`No exported NGINX_PATCHES entry named "${PATCH_NAME}" in ${modPath}`)
    process.exit(2)
  }

  // 1) Single /api/ block, default burst.
  setBurst(undefined)
  check('1a: fresh config is not applied', patch.isApplied(fresh), false)
  const a1 = patch.apply(fresh)
  check('1b: apply inserts burst=100 once', count(a1, L100), 1)
  check('1c: applied after apply', patch.isApplied(a1), true)
  check('1d: re-apply is a no-op', patch.apply(a1), a1)

  // 2) Changed burst on an already-patched config.
  setBurst('150')
  check('2a: changed burst -> not applied', patch.isApplied(a1), false)
  const a2 = patch.apply(a1)
  check('2b: burst=150 once', count(a2, L150), 1)
  check('2c: old burst=100 gone', count(a2, L100), 0)
  check('2d: applied', patch.isApplied(a2), true)

  // 3) Two /api/ blocks: both must be patched and kept in step.
  setBurst(undefined)
  const b1 = patch.apply(twoBlocks)
  check('3a: both blocks get burst=100', count(b1, L100), 2)
  check('3b: applied', patch.isApplied(b1), true)
  const half = b1.replace(L100, L150) // first block only
  setBurst('150')
  check('3c: only one block updated -> not applied', patch.isApplied(half), false)
  const b2 = patch.apply(b1)
  check('3d: both blocks updated to burst=150', count(b2, L150), 2)
  check('3e: no burst=100 left', count(b2, L100), 0)
  check('3f: applied', patch.isApplied(b2), true)

  // 4) Another location using caw_general must be left alone.
  setBurst('150')
  const c = patch.apply(otherLocation)
  check('4a: /upload/ line untouched', count(c, L5), 1)
  check('4b: /api/ has the new line once', count(c, L150), 1)
  check('4c: old /api/ line gone', count(c, L100), 0)
  check('4d: applied', patch.isApplied(c), true)

  setBurst(undefined)
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
