// The real MarketplaceIndexer service, polling a stand-in JSON-RPC server and
// writing to a real database, with a failure injected AFTER the handlers have
// written: the poll throws, the checkpoint is not saved, and the next poll
// processes the same range again.
//
// The stand-in server answers eth_chainId, eth_blockNumber, eth_getLogs (the
// marketplace's Listed and two BidPlaced logs, and an empty Transfer query)
// and eth_call (listings). The Transfer query, which the service makes after
// its marketplace handlers, fails once.
//
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install. It rewrites the marketplace_last_block checkpoint and puts
// it back.

process.env.CLIENT_ID = '1'

import http from 'node:http'
import { expect } from 'chai'
import { ethers } from 'ethers'
import { prisma } from '../../../src/prismaClient'
import { marketplaceIndexerService } from '../../../src/services/MarketplaceIndexerService'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')

const MARKETPLACE = '0x858F60fC71bAfBdC6Ba170aCC7dc8974F6270CBD'
const NAMES = '0x3BA577936Ff6Cfe07DC2D00e6669436C6Dace319'
const LISTING_ID = 99911
const FIRST_BLOCK = 1000
const HEAD = 1005
const SELLER = '0x' + '5'.repeat(40)
const BIDDER_A = '0x' + 'a'.repeat(40)
const BIDDER_B = '0x' + 'b'.repeat(40)

const iface = new ethers.Interface([
  'event Listed(uint256 indexed listingId, uint32 indexed tokenId, address seller, uint8 listingType, address paymentToken, uint256 startPrice)',
  'event BidPlaced(uint256 indexed listingId, address bidder, uint256 amount)',
  'function listings(uint256) view returns (uint32 tokenId, address seller, address paymentToken, uint8 listingType, uint256 startPrice, uint256 endPrice, uint64 startTime, uint64 endTime, uint256 highestBid, address highestBidder, bool active)',
])

function log(event: string, args: unknown[], block: number, index: number) {
  const enc = iface.encodeEventLog(iface.getEvent(event)!, args)
  return {
    address: MARKETPLACE, topics: enc.topics, data: enc.data, removed: false,
    blockNumber: '0x' + block.toString(16), blockHash: '0x' + String(block).padStart(64, '0'),
    transactionHash: '0x' + String(block * 10 + index).padStart(64, '0'), transactionIndex: '0x0', logIndex: '0x' + index.toString(16),
  }
}
const LOGS = [
  log('Listed', [LISTING_ID, 54, SELLER, 2, ethers.ZeroAddress, 1000n], FIRST_BLOCK, 0),
  log('BidPlaced', [LISTING_ID, BIDDER_A, 100n], FIRST_BLOCK + 1, 0),
  log('BidPlaced', [LISTING_ID, BIDDER_B, 200n], FIRST_BLOCK + 2, 0),
]

function startRpc(failTransferQueryOnce: boolean) {
  const stats = { marketplaceQueries: 0, transferQueries: 0, injected: false }
  const answer = (req: { method: string; params: any[] }) => {
    switch (req.method) {
      case 'eth_chainId': return '0xaa36a7'
      case 'net_version': return '11155111'
      case 'eth_blockNumber': return '0x' + HEAD.toString(16)
      case 'eth_getLogs': {
        const q = req.params[0]
        const from = parseInt(q.fromBlock, 16), to = parseInt(q.toBlock, 16)
        if (String(q.address).toLowerCase() === NAMES.toLowerCase()) {
          stats.transferQueries++
          if (failTransferQueryOnce && !stats.injected) { stats.injected = true; throw new Error('injected: the Transfer query fails after the marketplace handlers have written') }
          return []
        }
        stats.marketplaceQueries++
        return LOGS.filter(l => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to)
      }
      case 'eth_call':
        return iface.encodeFunctionResult('listings', [54, SELLER, ethers.ZeroAddress, 2, 1000n, 0n, 1n, BigInt(Math.floor(Date.now() / 1000) + 3600), 0n, ethers.ZeroAddress, true])
      default: throw new Error('unexpected method ' + req.method)
    }
  }
  const server = http.createServer((rq, rs) => {
    let body = ''
    rq.on('data', d => { body += d })
    rq.on('end', () => {
      const one = (r: any) => {
        try { return { jsonrpc: '2.0', id: r.id, result: answer(r) } }
        catch (e: any) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } } }
      }
      const parsed = JSON.parse(body)
      rs.setHeader('content-type', 'application/json')
      rs.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
    })
  })
  return new Promise<{ url: string; stats: typeof stats; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
      stats,
      close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()) }),
    }))
  })
}

async function runUntilCheckpoint(failTransferQueryOnce: boolean) {
  const rpc = await startRpc(failTransferQueryOnce)
  const saved = { url: process.env.L1_RPC_URL_HTTP, fallback: process.env.L1_RPC_URL_HTTP_FALLBACK }
  process.env.L1_RPC_URL_HTTP = rpc.url
  delete process.env.L1_RPC_URL_HTTP_FALLBACK
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = () => {}
  try {
    const service = marketplaceIndexerService.start(
      { marketplaceAddress: MARKETPLACE, cawProfileAddress: NAMES, pollIntervalMs: 100 },
      { declareLoop() {}, heartbeat() {} } as any,
    )
    await service.started
    const deadline = Date.now() + 20000
    for (;;) {
      const cp = await prisma.chainData.findUnique({ where: { key: 'marketplace_last_block' } })
      if (Number((cp!.value as any).block) >= HEAD || Date.now() > deadline) break
      await new Promise(r => setTimeout(r, 50))
    }
    await service.stop()
  } finally {
    Object.assign(console, quiet)
    if (saved.url === undefined) delete process.env.L1_RPC_URL_HTTP; else process.env.L1_RPC_URL_HTTP = saved.url
    if (saved.fallback !== undefined) process.env.L1_RPC_URL_HTTP_FALLBACK = saved.fallback
    await rpc.close()
  }
  return rpc.stats
}

async function bidStates() {
  const listing = await prisma.marketplaceListing.findUniqueOrThrow({ where: { listingId: LISTING_ID } })
  const bids = await prisma.marketplaceBid.findMany({ where: { listingId: listing.id }, orderBy: { id: 'asc' } })
  return { listing, states: bids.map(b => `${b.bidder.slice(2, 6)}:${b.status}`) }
}

describe('MarketplaceIndexer / a poll that fails after its handlers wrote (real service, stand-in RPC)', function () {
  this.timeout(40000)
  let savedCheckpoint: unknown
  let hadCheckpoint = false

  const wipe = async () => {
    await prisma.marketplaceBid.deleteMany({ where: { listing: { listingId: LISTING_ID } } })
    await prisma.marketplaceListing.deleteMany({ where: { listingId: LISTING_ID } })
  }

  before(function () { if (!ON_TEST_DB) this.skip() })
  beforeEach(async () => {
    if (!ON_TEST_DB) return
    const cp = await prisma.chainData.findUnique({ where: { key: 'marketplace_last_block' } })
    hadCheckpoint = !!cp
    savedCheckpoint = cp?.value
    await wipe()
    await prisma.chainData.upsert({
      where: { key: 'marketplace_last_block' },
      update: { value: { block: FIRST_BLOCK - 1 } },
      create: { key: 'marketplace_last_block', value: { block: FIRST_BLOCK - 1 } },
    })
  })
  afterEach(async () => {
    if (!ON_TEST_DB) return
    await wipe()
    if (hadCheckpoint) await prisma.chainData.update({ where: { key: 'marketplace_last_block' }, data: { value: savedCheckpoint as any } })
    else await prisma.chainData.deleteMany({ where: { key: 'marketplace_last_block' } })
  })
  after(async () => { if (ON_TEST_DB) await prisma.$disconnect() })

  it('a single successful poll leaves the second bid ACTIVE (control)', async () => {
    const stats = await runUntilCheckpoint(false)
    expect(stats.marketplaceQueries).to.equal(1)
    const { states, listing } = await bidStates()
    expect(states).to.deep.equal(['aaaa:OUTBID', 'bbbb:ACTIVE'])
    expect(listing.highestBidder).to.equal(BIDDER_B)
  })

  it('the same range processed again after the failure still leaves the second bid ACTIVE', async () => {
    const stats = await runUntilCheckpoint(true)
    expect(stats.injected, 'the failure was injected').to.equal(true)
    expect(stats.marketplaceQueries, 'the range was read twice').to.be.at.least(2)
    const cp = await prisma.chainData.findUniqueOrThrow({ where: { key: 'marketplace_last_block' } })
    expect((cp.value as any).block, 'the checkpoint moved only after the second poll').to.equal(HEAD)
    const { states, listing } = await bidStates()
    expect(states).to.deep.equal(['aaaa:OUTBID', 'bbbb:ACTIVE'])
    expect(listing.highestBidder).to.equal(BIDDER_B)
  })
})
