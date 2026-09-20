// Standalone verification of cli/src/steps/cspGuard.js. Run: node cli/scripts/verify-csp-guard.js
import { checkCspPolicy, checkIndexHtml, cspSha256 } from '../src/steps/cspGuard.js'
import { CSP_POLICY } from '../src/steps/nginx.js'
import { diffServices, inferNodeType } from '../src/steps/serviceDrift.js'

let failures = 0, count = 0
function check(label, actual, expected) {
  count++
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${pass ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`)
}
const has = (arr, sub) => arr.some(s => s.includes(sub))

// 1) The shipped policy passes.
check('shipped CSP_POLICY has no violations', checkCspPolicy(CSP_POLICY), [])

// 2) Each loosening of script-src is caught.
for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", '*', 'data:', 'blob:', 'https:', 'http://cdn.example.com/x@1.0.0/', 'https://*.jsdelivr.net/', 'https://cdn.jsdelivr.net/npm/foo/', 'https://cdn.jsdelivr.net/npm/foo@^1.0.0/']) {
  const p = CSP_POLICY.replace("script-src 'self'", `script-src 'self' ${bad}`)
  check(`script-src + ${bad} is rejected`, has(checkCspPolicy(p), 'script-src'), true)
}
check("script-src with a nonce is rejected", has(checkCspPolicy(CSP_POLICY.replace("script-src 'self'", "script-src 'self' 'nonce-abc'")), 'nonce'), true)
check('missing script-src is rejected', has(checkCspPolicy(CSP_POLICY.replace(/script-src[^;]*;\s*/, '')), 'script-src is missing'), true)
check("object-src other than 'none' is rejected", has(checkCspPolicy(CSP_POLICY.replace("object-src 'none'", "object-src 'self'")), 'object-src'), true)
check("frame-ancestors other than 'none' is rejected", has(checkCspPolicy(CSP_POLICY.replace("frame-ancestors 'none'", "frame-ancestors *")), 'frame-ancestors'), true)
check("default-src wider than 'self' is rejected", has(checkCspPolicy(CSP_POLICY.replace("default-src 'self'", "default-src 'self' https:")), 'default-src'), true)
check('worker-src https: is rejected', has(checkCspPolicy(CSP_POLICY.replace("worker-src 'self' blob:", "worker-src 'self' blob: https:")), 'worker-src'), true)

// 3) index.html checks.
const inline = "console.log('hi')"
const okPolicy = `default-src 'self'; script-src 'self' 'sha256-${cspSha256(inline)}'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
check('inline script covered by its hash passes', checkIndexHtml(`<html><script>${inline}</script></html>`, okPolicy), [])
check('inline script with no matching hash fails', has(checkIndexHtml(`<html><script>${inline}x</script></html>`, okPolicy), 'not covered'), true)
check('inline event handler fails (the Inter-font regression shape)', has(checkIndexHtml(`<link rel="stylesheet" media="print" onload="this.media='all'">`, okPolicy), 'onload='), true)
check('javascript: URL fails', has(checkIndexHtml(`<a href="javascript:alert(1)">x</a>`, okPolicy), 'javascript:'), true)
check('off-origin <script src> not in script-src fails', has(checkIndexHtml(`<script src="https://evil.example/x.js"></script>`, okPolicy), 'not an allowed pinned source'), true)
check('same-origin <script src> passes', checkIndexHtml(`<script type="module" src="/src/main.tsx"></script>`, okPolicy), [])

// 4) Service drift: a pre-2026-09 full node config is missing the two new indexer services.
const oldFull = ['FrontEnd','Api','ActionProcessor','DataCleaner','ScheduledPostProcessor','MarketplaceIndexer','InstanceRegistry','Validator','RawEventsGatherer','ChainSyncService','NftTransferWatcher'].map(service => ({ service, config: {} }))
const d = diffServices(oldFull, { network: 'testnet', networkId: 1 })
check('old full-node config infers type full', d.nodeType, 'full')
check('old full-node config is missing exactly the two new services', d.missing.map(m => m.service).sort(), ['DepositWatcher', 'StakeLedgerReconciler'])
check('frontend-only config infers frontend-only and needs nothing', diffServices([{ service: 'FrontEnd', config: {} }], { network: 'testnet' }).missing, [])
check('validator-only config infers validator', inferNodeType(['Validator','RawEventsGatherer','ChainSyncService','NftTransferWatcher','DepositWatcher','StakeLedgerReconciler'], { network: 'testnet' }), 'validator')

console.log(`\n${count - failures}/${count} passed`)
process.exit(failures > 0 ? 1 : 0)
