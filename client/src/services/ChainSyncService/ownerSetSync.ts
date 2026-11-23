// Indexes the L2 ledger's OwnerSet event into TokenOwnerSince (see utils/ownerSigned.ts).
// Its own loop and cursor, so it cannot hold up the session/auth loop.
import { Contract, type JsonRpcProvider } from 'ethers'
import { prisma } from '../../prismaClient'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { recordOwnerSet } from '../../utils/ownerSigned'

const OWNER_SET_ABI = ['event OwnerSet(uint32 tokenId, address newOwner)'] as const

const SYNC_BLOCK_KEY = 'l2_owner_set_last_synced_block'
const CHUNK_SIZE = 2000 // blocks per getLogs call, as in the L2 session loop
// getLogs calls per run; a node far behind the head catches up over several runs.
const MAX_CHUNKS_PER_RUN = 25

let running = false

// Public RPCs drop old history ("pruned history unavailable"). A range that will
// never be answered would hold the cursor for good, so it is skipped (its events
// are lost). Only an error that says "pruned" is skipped; any other is retried.
const isPrunedHistory = (err: any) => /pruned/i.test(String(err?.message ?? err))

async function getCursor(): Promise<number | null> {
  const row = await prisma.chainData.findUnique({ where: { key: SYNC_BLOCK_KEY } })
  const value = row?.value as any
  return typeof value?.block === 'number' ? value.block : null
}

/**
 * Start just before the earliest indexed action: an OwnerSet before every action
 * cannot exclude any. Only once RawEventsGatherer's history fill is done
 * (floor-filled), as it can store a live event first and fill below it later.
 * Both the flag (`raw-events-gatherer:<chainId>:<networkId>:floor-filled`) and
 * the raw event are this L2's, so events of another chain cannot set the start.
 * null: not yet.
 */
async function firstActionBlock(chainId: number): Promise<number | null> {
  const flags = await prisma.chainData.findMany({
    where: { key: { startsWith: `raw-events-gatherer:${chainId}:`, endsWith: ':floor-filled' } },
    select: { value: true },
  })
  if (!flags.some(f => (f.value as any)?.filled === true)) return null
  const first = await prisma.rawEvent.findFirst({ where: { chainId }, orderBy: { blockNumber: 'asc' }, select: { blockNumber: true } })
  return first ? Math.max(0, Number(first.blockNumber) - 1) : null
}

async function setCursor(block: number): Promise<void> {
  await prisma.chainData.upsert({
    where: { key: SYNC_BLOCK_KEY },
    update: { value: { block } },
    create: { key: SYNC_BLOCK_KEY, value: { block } },
  })
}

/** Throws on a failure: the cursor stays and the next tick retries; recordOwnerSet is idempotent. */
export async function syncOwnerSetEvents(
  l2Provider: Pick<JsonRpcProvider, 'getBlockNumber' | 'getNetwork'> | null,
  // Replaceable in tests.
  makeContract: (provider: any) => { filters: { OwnerSet(): any }; queryFilter(f: any, from: number, to: number): Promise<any[]> } =
    p => new Contract(CAW_NAMES_L2_ADDRESS, OWNER_SET_ABI as any, p) as any,
): Promise<void> {
  if (!l2Provider || running) return
  running = true
  try {
    const contract = makeContract(l2Provider)
    const latest = await l2Provider.getBlockNumber()
    let from = await getCursor()
    if (from === null) {
      from = await firstActionBlock(Number((await l2Provider.getNetwork()).chainId))
      if (from === null) return
      console.log(`[ChainSync:OwnerSet] Bootstrapping from block ${from}, the earliest indexed action`)
    }
    let cursor = from + 1
    let seen = 0
    let chunks = 0
    while (cursor <= latest && chunks < MAX_CHUNKS_PER_RUN) {
      chunks++
      const to = Math.min(cursor + CHUNK_SIZE - 1, latest)
      let events: any[]
      try {
        events = await contract.queryFilter(contract.filters.OwnerSet(), cursor, to)
      } catch (err: any) {
        if (!isPrunedHistory(err)) throw err
        console.warn(`[ChainSync:OwnerSet] Blocks ${cursor}-${to} are pruned on this RPC; skipping them`)
        events = []
      }
      events.sort((a: any, b: any) => (a.blockNumber - b.blockNumber) || ((a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0)))
      for (const ev of events as any[]) {
        const args = ev.args
        if (!args) continue
        await recordOwnerSet(Number(args.tokenId), String(args.newOwner), ev.blockNumber, ev.index ?? ev.logIndex ?? 0)
      }
      seen += events.length
      await setCursor(to)
      cursor = to + 1
    }
    if (seen > 0) console.log(`[ChainSync:OwnerSet] Indexed ${seen} event(s) through block ${cursor - 1}`)
  } finally {
    running = false
  }
}

/**
 * What ChainSyncService runs each tick. It does not reject: a failed run is
 * logged and the next tick retries from the cursor.
 *
 * ChainSyncService beats a loop's heartbeat only when its task resolves, and
 * its watchdog restarts the whole service when a declared loop has not beaten
 * for its timeout. A task that rejects would therefore take the session/auth
 * loop and the others down with it every 4 minutes for as long as its RPC or
 * database trouble lasts, for a note that is only a display aid. L2Events
 * catches its own errors the same way. `onError` is for the caller's recovery
 * (ChainSyncService passes its provider rebuild, which acts on connection
 * errors only).
 */
export async function runOwnerSetSync(
  l2Provider: Parameters<typeof syncOwnerSetEvents>[0],
  onError?: (err: unknown) => void,
  makeContract?: Parameters<typeof syncOwnerSetEvents>[1],
): Promise<void> {
  try {
    await syncOwnerSetEvents(l2Provider, makeContract)
  } catch (err: any) {
    console.error('[ChainSync:OwnerSet] Sync failed, the next tick retries from the cursor:', String(err?.message ?? err).slice(0, 200))
    onError?.(err)
  }
}
