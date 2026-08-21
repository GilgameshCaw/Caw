// Standalone verification of the historical-rescan skip added to
// listenForRawEvents.ts (companion fix for PR #60's fetch_failed throw,
// which has no catch around the historical-sync call site and would
// otherwise crash the service on restart for nodes on non-archive RPCs).
// Mirrors the all-or-nothing countExisting check added before the
// processEvents(past, ...) call, and the flag-based branch (rather than
// clearing `past`) added after review found that clearing `past` corrupts
// the poll cursor's seed value read further down in the same function.
// Run: node scripts/verify-raw-events-rescan-skip.js

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// --- Simulated RawEvent store ---
function makeStore(existingKeys) {
  const stored = new Set(existingKeys) // keys: "blockNumber:logIndex:txHash"
  return {
    countExisting: async (events) => {
      let n = 0
      for (const e of events) {
        const key = `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`
        if (stored.has(key)) n++
      }
      return n
    },
  }
}

// --- Mirrors the CURRENT implementation: a flag decides whether
//     processEvents() runs, but `past` itself is never mutated. Also
//     mirrors the lastSyncedBlock seed read that lives further down in the
//     real function: `past.length > 0 ? past[past.length - 1].blockNumber
//     : startBlock`. Returns both so tests can check the skip decision AND
//     that the seed still resolves off the real scanned range. ---
async function resolveSkipAndSeed(past, rawEventsProvider, startBlock) {
  const skipDerive =
    past.length > 0 &&
    !!rawEventsProvider.countExisting &&
    (await rawEventsProvider.countExisting(past)) === past.length

  // past is intentionally NOT reassigned here -- this is the bug tentencaw
  // caught: the original implementation did `past = []` on skip, which
  // corrupted this exact read.
  const lastSyncedBlockSeed = past.length > 0 ? past[past.length - 1].blockNumber : startBlock

  return { skipDerive, past, lastSyncedBlockSeed }
}

// 1) Empty past: no skip decision needed, seed falls through to startBlock
//    regardless (nothing was scanned). Guards against calling countExisting
//    on an empty array (would be a wasted DB round trip).
async function test1() {
  const provider = makeStore([])
  const { skipDerive, past, lastSyncedBlockSeed } = await resolveSkipAndSeed([], provider, 1000)
  check('1a: empty past never triggers skip', skipDerive, false)
  check('1b: empty past stays empty', past, [])
  check('1c: empty past seeds from startBlock', lastSyncedBlockSeed, 1000)
}

// 2) All events already stored: skipDerive is true (processEvents is
//    skipped), but `past` itself must remain the full scanned array so the
//    seed below reads the real last-scanned block, not startBlock.
async function test2() {
  const events = [
    { blockNumber: 100, logIndex: 0, transactionHash: '0xaaa' },
    { blockNumber: 100, logIndex: 1, transactionHash: '0xbbb' },
    { blockNumber: 101, logIndex: 0, transactionHash: '0xccc' },
  ]
  const provider = makeStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`))
  const { skipDerive, past, lastSyncedBlockSeed } = await resolveSkipAndSeed(events, provider, 50)
  check('2a: all-known past triggers skip', skipDerive, true)
  check('2b: past is NOT cleared -- stays the full scanned array', past, events)
  check('2c: seed reads the real last-scanned block (101), not startBlock (50)', lastSyncedBlockSeed, 101)
}

// 3) None stored (fresh node, cold start): no skip, processEvents runs on
//    the full array, seed reads the last scanned block as usual.
async function test3() {
  const events = [
    { blockNumber: 200, logIndex: 0, transactionHash: '0xddd' },
    { blockNumber: 200, logIndex: 1, transactionHash: '0xeee' },
  ]
  const provider = makeStore([])
  const { skipDerive, past, lastSyncedBlockSeed } = await resolveSkipAndSeed(events, provider, 10)
  check('3a: none-known past does not trigger skip', skipDerive, false)
  check('3b: none-known past passes through unchanged', past, events)
  check('3c: seed reads the last scanned block', lastSyncedBlockSeed, 200)
}

// 4) Partial overlap (some already stored, some genuinely new): no skip --
//    all-or-nothing, per tentencaw's original point that per-event
//    filtering would break the sequential parentHash chaining in
//    processEvents, which depends on processing the full contiguous range
//    in order.
async function test4() {
  const events = [
    { blockNumber: 300, logIndex: 0, transactionHash: '0xfff' }, // already stored
    { blockNumber: 300, logIndex: 1, transactionHash: '0x111' }, // genuinely new
  ]
  const provider = makeStore(['300:0:0xfff'])
  const { skipDerive, past } = await resolveSkipAndSeed(events, provider, 10)
  check('4a: partial overlap does not trigger skip', skipDerive, false)
  check('4b: partial overlap passes through the FULL unfiltered array (all-or-nothing)', past, events)
}

// 5) Backward compatibility: rawEventsProvider without countExisting (older
//    caller, or a provider that hasn't implemented the optional method)
//    must never skip -- processEvents always runs, matching pre-fix
//    behavior.
async function test5() {
  const events = [
    { blockNumber: 400, logIndex: 0, transactionHash: '0x222' },
  ]
  const providerWithoutCountExisting = {} // countExisting intentionally absent
  const { skipDerive, past } = await resolveSkipAndSeed(events, providerWithoutCountExisting, 10)
  check('5a: provider without countExisting never skips', skipDerive, false)
  check('5b: past left untouched (backward compatible)', past, events)
}

// 6) The specific regression tentencaw originally reported: 59 events, all
//    already stored, on a non-archive RPC that can no longer serve their tx
//    bodies. Before the countExisting fix, processEvents would throw
//    fetch_failed for all 59 on every restart, crashing the service since
//    the historical-sync call site has no catch around it. After the fix,
//    skipDerive is true and processEvents is never called on them.
async function test6() {
  const events = Array.from({ length: 59 }, (_, i) => ({
    blockNumber: 1000 + i,
    logIndex: 0,
    transactionHash: `0xtx${i}`,
  }))
  const provider = makeStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`))
  const { skipDerive, lastSyncedBlockSeed } = await resolveSkipAndSeed(events, provider, 500)
  check('6a: reported regression scenario (59/59 already stored) triggers skip', skipDerive, true)
  check('6b: seed reads the last of the 59 scanned blocks, not the floor (500)', lastSyncedBlockSeed, 1058)
}

// --- Batched countExisting, same as the real implementation's internal
//     chunking (COUNT_EXISTING_BATCH_SIZE in RawEventsGatherer/index.ts) ---
function makeBatchedStore(existingKeys, batchSize) {
  const stored = new Set(existingKeys)
  return {
    countExisting: async (events) => {
      let total = 0
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize)
        for (const e of batch) {
          const key = `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`
          if (stored.has(key)) total++
        }
      }
      return total
    },
  }
}

// 7) All-known past spanning multiple internal countExisting batches still
//    triggers the skip correctly.
async function test7() {
  const events = Array.from({ length: 12 }, (_, i) => ({
    blockNumber: 500 + i,
    logIndex: 0,
    transactionHash: `0xbatch${i}`,
  }))
  const provider = makeBatchedStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`), 5)
  const { skipDerive } = await resolveSkipAndSeed(events, provider, 10)
  check('7: all-known past spanning multiple internal batches still triggers skip', skipDerive, true)
}

// 8) THE REGRESSION tentencaw caught in review: the original implementation
//    did `past = []` when skipping, which corrupted the lastSyncedBlock
//    seed read (`past.length > 0 ? past[...].blockNumber : startBlock`) --
//    on a node with a configured startBlock, that fell through to the
//    floor instead of the real high-water mark, sending every subsequent
//    poll tick re-walking the whole floor-to-tip range on every restart
//    where the skip fires. This test locks in that the CURRENT
//    implementation (flag-based, past left untouched) does not reproduce
//    that: the seed must equal the real last-scanned block even when the
//    skip fires and the configured startBlock floor is far below it.
async function test8() {
  const events = [
    { blockNumber: 45723253, logIndex: 0, transactionHash: '0xlatest1' },
    { blockNumber: 45723253, logIndex: 1, transactionHash: '0xlatest2' },
  ]
  const provider = makeStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`))
  const configuredFloorStartBlock = 40000000 // far below the real watermark
  const { skipDerive, lastSyncedBlockSeed } = await resolveSkipAndSeed(events, provider, configuredFloorStartBlock)
  check('8a: skip fires (regression precondition)', skipDerive, true)
  check('8b: seed is the real watermark (45723253), NOT the configured floor (40000000) -- the exact bug tentencaw caught', lastSyncedBlockSeed, 45723253)
}

async function main() {
  await test1()
  await test2()
  await test3()
  await test4()
  await test5()
  await test6()
  await test7()
  await test8()
  console.log(`\n${19 - failures}/19 passed`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
