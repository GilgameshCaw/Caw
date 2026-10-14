import { expect } from 'chai'
import { scanLogsForward, shrinkAfterError } from '../../src/utils/chunkedLogs'

// Minimal fake provider for the forward scan: getLogs returns the seeded
// blocks inside [fromBlock, toBlock], unless `reject` returns an error for
// that range. Records every call so tests can bound the retries.
function makeProvider(events: number[], reject?: (fromBlock: number, toBlock: number) => Error | undefined) {
  const calls: Array<[number, number]> = []
  const provider = {
    async getLogs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
      calls.push([fromBlock, toBlock])
      const err = reject?.(fromBlock, toBlock)
      if (err) throw err
      return events
        .filter(b => b >= fromBlock && b <= toBlock)
        .map(b => ({ blockNumber: b, topics: ['0xtopic'], logIndex: 0 })) as any
    },
  } as any
  return { provider, calls }
}

// The shape ethers v6 throws for a non-2xx response (FetchResponse.assertOk):
// status in shortMessage / info.responseStatus, body in info.responseBody.
function httpError(status: string, body: string, requestId = 1) {
  return Object.assign(
    new Error(
      `server response ${status} (request={ }, response={ }, error=null, ` +
      `info={ "requestUrl": "https://sepolia.base.org", "responseBody": ${JSON.stringify(body)}, ` +
      `"responseStatus": "${status}" }, code=SERVER_ERROR, version=6.16.0) "id":${requestId}`,
    ),
    {
      code: 'SERVER_ERROR',
      shortMessage: `server response ${status}`,
      info: { requestUrl: 'https://sepolia.base.org', responseBody: body, responseStatus: status },
    },
  )
}

// sepolia.base.org accepts toBlock - fromBlock <= cap and answers 413 above it.
function cappedAt(cap: number, body: (cap: number) => string) {
  return (fromBlock: number, toBlock: number) =>
    toBlock - fromBlock > cap ? httpError('413 Payload Too Large', body(cap)) : undefined
}
const baseSepoliaBody = (cap: number) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32614, message: `eth_getLogs is limited to a ${cap} range` } })

const ADDR = '0xCawActions'
const TOPICS = ['0xtopic']
const FROM = 47_850_038
const TO = FROM + 19_999
// 146 events spread over the 20,000 blocks, including both ends.
const EVENTS = Array.from({ length: 146 }, (_, i) => FROM + i * 137).concat([TO])

function expectAllEvents(logs: any[]) {
  expect(logs.map(l => l.blockNumber)).to.deep.equal(EVENTS)
}

describe('scanLogsForward — window shrinking', () => {
  const origWarn = console.warn
  beforeEach(() => { console.warn = () => {} })
  afterEach(() => { console.warn = origWarn })

  it('reaches a 200-block cap from the default chunk when the RPC names the cap', async () => {
    const { provider, calls } = makeProvider(EVENTS, cappedAt(200, baseSepoliaBody))
    const logs = await scanLogsForward(provider, ADDR, TOPICS, FROM, TO)
    expectAllEvents(logs)
    // One failed 10,000-block call, then 100 windows of 200.
    expect(calls.length).to.equal(101)
    expect(calls.slice(1).every(([f, t]) => t - f + 1 === 200)).to.equal(true)
  })

  it('keeps halving past five shrinks on a 413 that names no cap', async () => {
    // 10,000 -> 78 takes 7 halvings.
    const { provider } = makeProvider(EVENTS, cappedAt(100, () => ''))
    const logs = await scanLogsForward(provider, ADDR, TOPICS, FROM, TO)
    expectAllEvents(logs)
  })

  it('gives up on a range error once the window is a single block', async () => {
    const { provider, calls } = makeProvider(EVENTS, () => httpError('413 Payload Too Large', ''))
    let thrown: any
    try { await scanLogsForward(provider, ADDR, TOPICS, FROM, TO) } catch (e) { thrown = e }
    expect(thrown?.shortMessage).to.equal('server response 413 Payload Too Large')
    // 10,000, 5,000, ..., 2, 1: 14 calls.
    expect(calls.length).to.equal(14)
    expect(calls.every(([f]) => f === FROM)).to.equal(true)
  })

  it('fails fast on an error that is not about the range (outage)', async () => {
    let n = 0
    const { provider, calls } = makeProvider(EVENTS, () => httpError('503 Service Unavailable', 'upstream down', 413 + n++))
    let thrown: any
    try { await scanLogsForward(provider, ADDR, TOPICS, FROM, TO) } catch (e) { thrown = e }
    expect(thrown?.message).to.contain('"id":413')
    expect(calls.length).to.equal(6)
  })

  it('keeps the shrunk window for the rest of the scan', async () => {
    const { provider, calls } = makeProvider(EVENTS, cappedAt(500, baseSepoliaBody))
    const logs = await scanLogsForward(provider, ADDR, TOPICS, FROM, TO)
    expectAllEvents(logs)
    expect(calls.filter(([f, t]) => t - f > 500).length).to.equal(1)
  })
})

describe('shrinkAfterError', () => {
  it('uses the cap the RPC names', () => {
    expect(shrinkAfterError(httpError('413 Payload Too Large', baseSepoliaBody(200)), 10_000, 0)).to.equal(200)
    expect(shrinkAfterError(new Error('eth_getLogs is limited to a 1000-block range'), 10_000, 0)).to.equal(1000)
  })

  it('halves when the named cap is not smaller than the window', () => {
    expect(shrinkAfterError(new Error('eth_getLogs is limited to a 200 range'), 200, 1)).to.equal(100)
  })

  it('reads the error nested by a wrapping provider', () => {
    const wrapped = Object.assign(new Error('all providers failed'), {
      error: httpError('413 Payload Too Large', baseSepoliaBody(200)),
    })
    expect(shrinkAfterError(wrapped, 10_000, 0)).to.equal(200)
  })

  it('treats too-wide wording without a number as a range error', () => {
    for (const msg of ['block range too large', 'query returned more than 10000 results', 'exceeds max block range']) {
      expect(shrinkAfterError(new Error(msg), 64, 9), msg).to.equal(32)
    }
  })

  it('stops after five shrinks on any other error', () => {
    const err = httpError('503 Service Unavailable', 'upstream down', 413)
    expect(shrinkAfterError(err, 10_000, 4)).to.equal(5_000)
    expect(shrinkAfterError(err, 10_000, 5)).to.equal(undefined)
    expect(shrinkAfterError(new Error('rate limit exceeded'), 10_000, 5)).to.equal(undefined)
  })

  it('never shrinks a single block', () => {
    expect(shrinkAfterError(new Error('eth_getLogs is limited to a 200 range'), 1, 0)).to.equal(undefined)
  })
})
