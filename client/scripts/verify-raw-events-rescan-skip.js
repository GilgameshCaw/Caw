// Standalone verification of the historical-rescan skip added to
// listenForRawEvents.ts (companion fix for PR #60's fetch_failed throw,
// which has no catch around the historical-sync call site and would
// otherwise crash the service on restart for nodes on non-archive RPCs).
// Mirrors the all-or-nothing countExisting check added before the
// processEvents(past, ...) call.
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

// --- Mirrors the all-or-nothing skip logic added before
//     `await processEvents(past, httpContract)` ---
async function resolvePastAfterSkipCheck(past, rawEventsProvider) {
  if (past.length > 0 && rawEventsProvider.countExisting) {
    const existingCount = await rawEventsProvider.countExisting(past)
    if (existingCount === past.length) {
      return [] // skip: nothing new to derive
    }
  }
  return past // unchanged: at least one genuinely new event
}

// 1) Empty past: no-op regardless of provider. Guards against calling
//    countExisting on an empty array (would be a wasted DB round trip).
async function test1() {
  const provider = makeStore([])
  const result = await resolvePastAfterSkipCheck([], provider)
  check('1: empty past stays empty, countExisting not required to be called', result, [])
}

// 2) All events already stored: rescan should skip entirely (past -> []),
//    which is what prevents the fetch_failed throw for settled history on
//    non-archive RPCs.
async function test2() {
  const events = [
    { blockNumber: 100, logIndex: 0, transactionHash: '0xaaa' },
    { blockNumber: 100, logIndex: 1, transactionHash: '0xbbb' },
    { blockNumber: 101, logIndex: 0, transactionHash: '0xccc' },
  ]
  const provider = makeStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`))
  const result = await resolvePastAfterSkipCheck(events, provider)
  check('2: all-known past is skipped (resolves to empty array)', result, [])
}

// 3) None stored (fresh node, cold start): rescan must proceed unchanged so
//    genuinely new events still get processed normally.
async function test3() {
  const events = [
    { blockNumber: 200, logIndex: 0, transactionHash: '0xddd' },
    { blockNumber: 200, logIndex: 1, transactionHash: '0xeee' },
  ]
  const provider = makeStore([])
  const result = await resolvePastAfterSkipCheck(events, provider)
  check('3: none-known past passes through unchanged', result, events)
}

// 4) Partial overlap (some already stored, some genuinely new): must NOT
//    skip and must NOT filter down to just the new ones -- all-or-nothing,
//    per tentencaw's point that per-event filtering would break the
//    sequential parentHash chaining in processEvents, which depends on
//    processing the full contiguous range in order.
async function test4() {
  const events = [
    { blockNumber: 300, logIndex: 0, transactionHash: '0xfff' }, // already stored
    { blockNumber: 300, logIndex: 1, transactionHash: '0x111' }, // genuinely new
  ]
  const provider = makeStore(['300:0:0xfff'])
  const result = await resolvePastAfterSkipCheck(events, provider)
  check('4: partial overlap passes through the FULL unfiltered array (all-or-nothing)', result, events)
}

// 5) Backward compatibility: rawEventsProvider without countExisting (older
//    caller, or a provider that hasn't implemented the optional method)
//    must behave exactly as before this fix -- past always passes through.
async function test5() {
  const events = [
    { blockNumber: 400, logIndex: 0, transactionHash: '0x222' },
  ]
  const providerWithoutCountExisting = {} // countExisting intentionally absent
  const result = await resolvePastAfterSkipCheck(events, providerWithoutCountExisting)
  check('5: provider without countExisting leaves past untouched (backward compatible)', result, events)
}

// 6) The specific regression tentencaw reported: 59 events, all already
//    stored, on a non-archive RPC that can no longer serve their tx bodies.
//    Before this fix, processEvents would throw fetch_failed for all 59 on
//    every restart, and since the historical-sync call site has no catch
//    around it (unlike poll()'s), that crashes the whole service. After
//    this fix, the rescan recognizes all 59 are already ingested and never
//    calls processEvents on them at all.
async function test6() {
  const events = Array.from({ length: 59 }, (_, i) => ({
    blockNumber: 1000 + i,
    logIndex: 0,
    transactionHash: `0xtx${i}`,
  }))
  const provider = makeStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`))
  const result = await resolvePastAfterSkipCheck(events, provider)
  check('6: reported regression scenario (59/59 already stored) resolves to empty, avoiding the fetch_failed throw', result, [])
}

// 7) countExisting itself is batched internally (COUNT_EXISTING_BATCH_SIZE
//    in RawEventsGatherer/index.ts) to keep any single query's OR clause
//    bounded on nodes with large RawEvent tables. Simulate a countExisting
//    that enforces its own batch limit (mirrors the real implementation's
//    chunking) and confirm the skip logic still resolves correctly when the
//    event count crosses multiple batches.
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

async function test7() {
  // 12 events, batch size 5 -> 3 batches (5, 5, 2). All stored.
  const events = Array.from({ length: 12 }, (_, i) => ({
    blockNumber: 500 + i,
    logIndex: 0,
    transactionHash: `0xbatch${i}`,
  }))
  const provider = makeBatchedStore(events.map(e => `${e.blockNumber}:${e.logIndex}:${e.transactionHash}`), 5)
  const result = await resolvePastAfterSkipCheck(events, provider)
  check('7: all-known past spanning multiple internal batches still resolves to empty', result, [])
}

async function main() {
  await test1()
  await test2()
  await test3()
  await test4()
  await test5()
  await test6()
  await test7()
  console.log(`\n${7 - failures}/7 passed`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
