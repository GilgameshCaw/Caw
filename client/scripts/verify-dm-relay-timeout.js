// Standalone verification of the DM relay outbound fetch timeout.
// Uses a real `fetch()` against a local TCP server that intentionally
// never responds, so this exercises the actual fetch()+AbortSignal
// combination used in DmRelayService, not a simulated abort.
// Run: node scripts/verify-dm-relay-timeout.js

const http = require('http')
const net = require('net')

const DM_RELAY_TIMEOUT_MS = 300 // short for test speed; production uses 5_000

async function withHangingServer(fn) {
  // A raw TCP server that accepts the connection but never writes a
  // response — this is what an unresponsive/hung peer looks like from
  // the relaying node's side (as opposed to ECONNREFUSED, which fails
  // instantly and isn't the case this timeout protects against).
  const server = net.createServer((socket) => {
    // Deliberately do nothing — hold the connection open.
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(`http://127.0.0.1:${port}/`)
  } finally {
    server.close()
  }
}

async function withRefusingPort(fn) {
  // A port nothing is listening on — fails fast (ECONNREFUSED), the
  // routine-failure case that must NOT be delayed by the timeout.
  return fn('http://127.0.0.1:1/') // port 1 is reserved, always refused
}

async function relayAttempt(url) {
  const start = Date.now()
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(DM_RELAY_TIMEOUT_MS),
    })
    return { outcome: 'ok', elapsedMs: Date.now() - start }
  } catch (err) {
    return { outcome: 'caught', error: err.message, elapsedMs: Date.now() - start }
  }
}

let failures = 0
function check(label, cond, detail) {
  if (!cond) failures++
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' -> ' + detail : ''}`)
}

async function run() {
  // 1) A peer that accepts the connection but never responds must be
  //    aborted at ~DM_RELAY_TIMEOUT_MS, not hang indefinitely.
  const hung = await withHangingServer(relayAttempt)
  check(
    'hung peer aborts near the timeout, not indefinitely',
    hung.outcome === 'caught' && hung.elapsedMs >= DM_RELAY_TIMEOUT_MS && hung.elapsedMs < DM_RELAY_TIMEOUT_MS + 500,
    `outcome=${hung.outcome} elapsed=${hung.elapsedMs}ms error=${hung.error}`
  )

  // 2) A peer that refuses the connection outright must be caught
  //    quickly — the timeout must not delay routine failures.
  const refused = await withRefusingPort(relayAttempt)
  check(
    'refused connection is caught quickly, not held until timeout',
    refused.outcome === 'caught' && refused.elapsedMs < DM_RELAY_TIMEOUT_MS,
    `outcome=${refused.outcome} elapsed=${refused.elapsedMs}ms error=${refused.error}`
  )

  // 3) N hung peers relayed concurrently (fire-and-forget, matching the
  //    actual for-loop's non-awaited fetch calls) must all resolve
  //    within roughly one timeout window, not N * timeout serially.
  const N = 10
  const servers = []
  for (let i = 0; i < N; i++) {
    const server = net.createServer(() => {})
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
  }
  const concurrentStart = Date.now()
  await Promise.all(
    servers.map((s) => relayAttempt(`http://127.0.0.1:${s.address().port}/`))
  )
  const concurrentElapsed = Date.now() - concurrentStart
  servers.forEach((s) => s.close())
  check(
    `${N} concurrent hung peers all resolve within ~1 timeout window (parallel, not serial)`,
    concurrentElapsed < DM_RELAY_TIMEOUT_MS + 500,
    `elapsed=${concurrentElapsed}ms for ${N} peers`
  )

  console.log(`\n${3 - failures}/3 passed`)
  process.exit(failures > 0 ? 1 : 0)
}

run()
