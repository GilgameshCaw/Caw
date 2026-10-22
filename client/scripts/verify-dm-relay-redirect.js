// Standalone verification that the DM relay's outbound POSTs don't
// follow redirects. A local "peer" answers every request with a 3xx
// pointing at a second local server (standing in for 169.254.169.254 or
// a loopback service), and we check whether the relay body reaches it.
// Uses a real `fetch()` with the same options DmRelayService passes.
// Run: node scripts/verify-dm-relay-redirect.js

const http = require('http')

const DM_RELAY_TIMEOUT_MS = 5_000

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

// The redirect target. Records every request that reaches it.
let hits = []
async function startInternal() {
  return listen((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      hits.push({ method: req.method, body })
      res.end('ok')
    })
  })
}

// The peer. A request to /<status> gets that status with Location
// pointing at the internal server; /200 answers normally, like a
// well-behaved peer.
async function startPeer(internalPort) {
  return listen((req, res) => {
    req.resume()
    const status = Number(req.url.split('/')[1])
    if (status === 200) return res.end('{"status":"relayed"}')
    res.writeHead(status, { Location: `http://127.0.0.1:${internalPort}/internal` })
    res.end()
  })
}

async function relayAttempt(url, redirect) {
  hits = []
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"relayId":"verify"}',
    signal: AbortSignal.timeout(DM_RELAY_TIMEOUT_MS),
  }
  if (redirect) init.redirect = redirect
  try {
    const res = await fetch(url, init)
    return { outcome: 'resolved', status: res.status, hits }
  } catch (err) {
    const cause = err.cause && err.cause.message ? ` (${err.cause.message})` : ''
    return { outcome: 'caught', error: err.message + cause, hits }
  }
}

let failures = 0
let checks = 0
function check(label, cond, detail) {
  checks++
  if (!cond) failures++
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' -> ' + detail : ''}`)
}

function describe(r) {
  const reached = r.hits.map((h) => `${h.method} body=${h.body || '(none)'}`).join('; ') || 'none'
  return r.outcome === 'resolved'
    ? `resolved ${r.status}, reached internal: ${reached}`
    : `caught "${r.error}", reached internal: ${reached}`
}

async function run() {
  const internal = await startInternal()
  const peer = await startPeer(internal.address().port)
  const base = `http://127.0.0.1:${peer.address().port}`

  // 1) Without the option (fetch's default 'follow'), 307/308 re-send
  //    the POST and its body to the internal server. This is the
  //    behaviour the change removes; if it ever stops holding, the
  //    checks below prove nothing.
  for (const status of [307, 308]) {
    const r = await relayAttempt(`${base}/${status}`, undefined)
    check(
      `default fetch follows ${status} and re-sends the POST body`,
      r.hits.length === 1 && r.hits[0].method === 'POST' && r.hits[0].body === '{"relayId":"verify"}',
      describe(r)
    )
  }

  // 2) With redirect: 'error', every 3xx is caught and nothing reaches
  //    the internal server.
  for (const status of [301, 302, 303, 307, 308]) {
    const r = await relayAttempt(`${base}/${status}`, 'error')
    check(
      `redirect:'error' on ${status} is caught and the internal server is not reached`,
      r.outcome === 'caught' && r.hits.length === 0,
      describe(r)
    )
  }

  // 3) A peer that answers normally still gets the relay.
  const ok = await relayAttempt(`${base}/200`, 'error')
  check(
    `redirect:'error' leaves a normal 200 peer working`,
    ok.outcome === 'resolved' && ok.status === 200,
    describe(ok)
  )

  peer.close()
  internal.close()
  console.log(`\n${checks - failures}/${checks} passed`)
  process.exit(failures > 0 ? 1 : 0)
}

run()
