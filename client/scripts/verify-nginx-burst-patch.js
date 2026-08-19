// Standalone verification of the NGINX_PATCHES burst-value fix
// (review finding, tentencaw, PR #48): the patch used to hardcode
// burst=100 and isApplied only checked for the zone name, so a changed
// CAW_NGINX_RATE_LIMIT_BURST could never reach an already-patched host
// via `caw update`. Mirrors the patch entry's apply/isApplied logic.
// Run: node scripts/verify-nginx-burst-patch.js

function makePatch(burstEnv) {
  return {
    apply: (s) => {
      const withoutOldLine = s.replace(/[ \t]*limit_req zone=caw_general[^\n]*\n/, '')
      return withoutOldLine.replace(
        /location \/api\/ \{/,
        `location /api/ {\n        limit_req zone=caw_general burst=${burstEnv || 100} nodelay;`,
      )
    },
    isApplied: (s) => s.includes(`limit_req zone=caw_general burst=${burstEnv || 100} nodelay;`),
  }
}

const freshConfig = `server {
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
    }
}
`

let failures = 0
function check(label, actual, expected) {
  const pass = actual === expected
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// 1) Fresh, unpatched config: not applied, and apply() inserts burst=100
//    (default) exactly once.
const patchDefault = makePatch(undefined)
check('1a: fresh config is not yet applied', patchDefault.isApplied(freshConfig), false)
const afterFirstApply = patchDefault.apply(freshConfig)
check('1b: apply() inserts default burst=100 exactly once',
  (afterFirstApply.match(/limit_req zone=caw_general/g) || []).length, 1)
check('1c: isApplied is now true for the same burst value', patchDefault.isApplied(afterFirstApply), true)

// 2) Operator sets CAW_NGINX_RATE_LIMIT_BURST=200 and runs `caw update`
//    again: isApplied for the NEW value must be false (so the patch
//    re-runs), and apply() must replace the old line rather than
//    stacking a second one.
const patchNew = makePatch('200')
check('2a: isApplied for the new burst value is false on the old-burst config', patchNew.isApplied(afterFirstApply), false)
const afterSecondApply = patchNew.apply(afterFirstApply)
check('2b: re-apply produces exactly one limit_req line, not two',
  (afterSecondApply.match(/limit_req zone=caw_general/g) || []).length, 1)
check('2c: the surviving line has the new burst value', afterSecondApply.includes('burst=200'), true)
check('2d: the old burst=100 line is gone', afterSecondApply.includes('burst=100'), false)
check('2e: isApplied for the new value is now true', patchNew.isApplied(afterSecondApply), true)

// 3) Idempotency: running the same-value patch again is a true no-op at
//    the isApplied level (this is what the real NGINX_PATCHES loop's
//    `if (p.isApplied(patched)) continue` relies on).
check('3: re-checking isApplied with the same value stays true (loop would skip)', patchNew.isApplied(afterSecondApply), true)

console.log(`\n${9 - failures}/9 passed`)
process.exit(failures > 0 ? 1 : 0)
