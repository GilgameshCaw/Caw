// Reproduces / verifies the JSON-RPC batch size cap in routes/rpc-proxy.ts.
// Mounts the real router behind the same global express.json() that
// server.ts uses, points the L2 upstream at a local server that only
// counts requests, and reports how many upstream calls each batch causes.
// Everything stays on 127.0.0.1; no real RPC is contacted.
//
// Run (from client/): npx tsx scripts/verify-rpc-proxy-batch-cap.ts

import http from 'http'
import express from 'express'
import type { AddressInfo } from 'net'

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

async function main() {
  let upstreamHits = 0
  const upstream = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      upstreamHits++
      let id: unknown = null
      try { id = JSON.parse(data).id } catch { /* ignore */ }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + '0'.repeat(64) }))
    })
  })
  const upPort = await listen(upstream)

  process.env.NODE_ENV = 'test'
  process.env.L2_RPC_URL_HTTP = `http://127.0.0.1:${upPort}`
  delete process.env.L2_RPC_URL_HTTP_FALLBACK
  delete process.env.L2_RPC_SECRET

  const mod: any = await import('../src/api/routes/rpc-proxy')
  const router = mod.default
  const cap: number | undefined = mod.MAX_RPC_BATCH_SIZE
  console.log(`MAX_RPC_BATCH_SIZE: ${cap === undefined ? '(not exported: no cap)' : cap}`)

  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json({ limit: '50mb' })) // same global parser server.ts applies
  app.use('/api/rpc', router)
  const server = http.createServer(app)
  const port = await listen(server)

  let seq = 0
  async function postBatch(n: number) {
    // Distinct calldata per call so neither the response cache nor the
    // in-flight dedup can fold them together.
    const body = Array.from({ length: n }, (_, i) => ({
      jsonrpc: '2.0', id: i, method: 'eth_call',
      params: [{ to: '0xca11bde05977b3631167028862be2a173976ca11', data: '0x' + (seq++).toString(16).padStart(8, '0') }, 'latest'],
    }))
    const before = upstreamHits
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc/l2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
      body: JSON.stringify(body),
    })
    const json: any = await res.json()
    return {
      status: res.status,
      results: Array.isArray(json) ? json.length : null,
      errorCode: Array.isArray(json) ? null : (json?.error?.code ?? null),
      upstream: upstreamHits - before,
    }
  }

  let failures = 0
  function check(label: string, ok: boolean, detail: unknown) {
    if (!ok) failures++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} -> ${JSON.stringify(detail)}`)
  }

  const limit = cap ?? 50
  const r2 = await postBatch(2)
  check('2 calls: answered, 2 upstream requests', r2.results === 2 && r2.upstream === 2, r2)
  const rCap = await postBatch(limit)
  check(`${limit} calls (at the cap): answered`, rCap.results === limit && rCap.upstream === limit, rCap)
  const rOver = await postBatch(limit + 1)
  check(`${limit + 1} calls: rejected, 0 upstream requests`, rOver.errorCode === -32600 && rOver.upstream === 0, rOver)
  const r1000 = await postBatch(1000)
  check('1000 calls: rejected, 0 upstream requests', r1000.errorCode === -32600 && r1000.upstream === 0, r1000)
  const r0 = await postBatch(0)
  check('empty batch: rejected, 0 upstream requests', r0.errorCode === -32600 && r0.upstream === 0, r0)

  // A batch whose elements are themselves arrays must not reach the upstream
  // as nested batches (that would sidestep the cap). handleOne already rejects
  // any element without a string `method`; pinned here because the cap relies on it.
  {
    const inner = Array.from({ length: 50 }, (_, i) => ({
      jsonrpc: '2.0', id: i, method: 'eth_call',
      params: [{ to: '0xca11bde05977b3631167028862be2a173976ca11', data: '0x' + (seq++).toString(16).padStart(8, '0') }, 'latest'],
    }))
    const before = upstreamHits
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc/l2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
      body: JSON.stringify([inner, inner]),
    })
    const json: any = await res.json()
    const codes = Array.isArray(json) ? json.map((r: any) => r?.error?.code ?? null) : null
    const upstream = upstreamHits - before
    check('nested batches: each element rejected, 0 upstream requests',
      Array.isArray(codes) && codes.length === 2 && codes.every((c: any) => c === -32600) && upstream === 0,
      { status: res.status, codes, upstream })
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
  server.close()
  upstream.close()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
