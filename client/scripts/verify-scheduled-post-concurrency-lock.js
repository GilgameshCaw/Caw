// Spec-level verification of the atomic pending -> processing claim added
// to processDueScheduledPosts.
//
// IMPORTANT: this is a spec test against a JS Map, not an integration test.
// It verifies the intended state-machine logic is correct, but it does NOT
// exercise real Postgres row-locking or confirm that a concurrent
// updateMany actually blocks and re-evaluates its WHERE clause against the
// committed row the way READ COMMITTED is expected to. That guarantee is
// the actual load-bearing part of the fix and is not covered here.
//
// Background: processScheduledPost() only ever writes status at its own
// success/failure branches at the end -- there was no claim step before
// that point. Two overlapping ticks of the 60s-interval worker (a batch
// that takes longer than 60s to process, DB/RPC slowness, etc.) could both
// findMany the same still-pending row and both broadcast it on-chain. This
// mirrors the fix: an atomic updateMany(where: { id, status: 'pending' })
// claim before processing.
// Run: node scripts/verify-scheduled-post-concurrency-lock.js

let failures = 0
let checkCount = 0
function check(label, actual, expected) {
  checkCount++
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// --- Simulated ScheduledCaw store ---
function makeStore(rows) {
  // rows: array of { id, status, updatedAt }
  const table = new Map(rows.map(r => [r.id, { ...r }]))
  return {
    table,
    // Mirrors: prisma.scheduledCaw.updateMany({ where: { id, status: from }, data: { status: to } })
    claim: (id, fromStatus, toStatus, now) => {
      const row = table.get(id)
      if (!row || row.status !== fromStatus) return { count: 0 }
      row.status = toStatus
      row.updatedAt = now
      return { count: 1 }
    },
  }
}

// --- Mirrors the claim step added directly before processScheduledPost() ---
function tryClaim(store, id, now) {
  const result = store.claim(id, 'pending', 'processing', now)
  return result.count === 1
}

// 1) Single post, normal path: claim succeeds, no concurrent claimant.
function test1() {
  const store = makeStore([{ id: 1, status: 'pending', updatedAt: 0 }])
  const claimed = tryClaim(store, 1, 100)
  check('1a: claim succeeds for a pending row', claimed, true)
  check('1b: status is now processing', store.table.get(1).status, 'processing')
}

// 2) Two overlapping worker ticks racing the same row: exactly one claims
//    it (in this simulation, by calling sequentially -- see the header
//    note on what this does and doesn't prove), the other's updateMany
//    affects 0 rows and it skips rather than double-processing. This is
//    the actual concurrency bug being fixed.
function test2() {
  const store = makeStore([{ id: 2, status: 'pending', updatedAt: 0 }])
  const tickAClaimed = tryClaim(store, 2, 100) // tick A claims first
  const tickBClaimed = tryClaim(store, 2, 105) // tick B races the same row moments later
  check('2a: first tick claims successfully', tickAClaimed, true)
  check('2b: second overlapping tick fails to claim (sees processing, not pending)', tickBClaimed, false)
  check('2c: exactly one broadcast would happen -- row is processing, not double-claimed', store.table.get(2).status, 'processing')
}

// 3) Multiple independent posts in one batch: each claims its own row,
//    none interfere with each other.
function test3() {
  const store = makeStore([
    { id: 10, status: 'pending', updatedAt: 0 },
    { id: 11, status: 'pending', updatedAt: 0 },
    { id: 12, status: 'pending', updatedAt: 0 },
    { id: 13, status: 'pending', updatedAt: 0 },
    { id: 14, status: 'pending', updatedAt: 0 },
  ])
  const results = [10, 11, 12, 13, 14].map(id => tryClaim(store, id, 100))
  check('3: all 5 independent posts claim successfully with no cross-interference', results, [true, true, true, true, true])
}

// 4) Thread chunks (already-sequential processing per the existing
//    threadIndex ordering) each claim independently -- the claim step
//    doesn't interfere with the existing thread-ordering logic, it only
//    guards against a second worker tick re-claiming an already-claimed
//    chunk.
function test4() {
  const store = makeStore([
    { id: 20, status: 'pending', updatedAt: 0, threadId: 't1', threadIndex: 0 },
    { id: 21, status: 'pending', updatedAt: 0, threadId: 't1', threadIndex: 1 },
    { id: 22, status: 'pending', updatedAt: 0, threadId: 't1', threadIndex: 2 },
  ])
  const results = [20, 21, 22].map(id => tryClaim(store, id, 100))
  check('4: all 3 thread chunks claim independently in order', results, [true, true, true])
}

// 5) A row already claimed by another tick (simulating "thread head
//    already failed elsewhere") is correctly skipped by a second attempt
//    rather than reprocessed.
function test5() {
  const store = makeStore([{ id: 30, status: 'processing', updatedAt: 100 }]) // already claimed by another tick
  const claimed = tryClaim(store, 30, 105)
  check('5: a row already in processing cannot be re-claimed', claimed, false)
}

// --- Mirrors the thread-fail-fast skip path: when an earlier chunk in a
//     thread failed, later chunks are marked 'failed' too rather than run
//     through processScheduledPost. Scoped to status: 'pending' (via
//     updateMany) so it can't clobber a row a concurrent tick has already
//     claimed and is actively processing. ---
function trySkipAsThreadFailed(store, id) {
  const row = store.table.get(id)
  if (!row || row.status !== 'pending') return { skipped: false, count: 0 }
  row.status = 'failed'
  return { skipped: true, count: 1 }
}

// 6) Normal case: an earlier thread chunk failed, this chunk is still
//    pending (nobody else has touched it) -- the skip path marks it
//    failed as intended.
function test6() {
  const store = makeStore([{ id: 40, status: 'pending', updatedAt: 0 }])
  const result = trySkipAsThreadFailed(store, 40)
  check('6a: thread-fail-fast skip marks a still-pending chunk as failed', result.skipped, true)
  check('6b: status is now failed', store.table.get(40).status, 'failed')
}

// 7) THE REGRESSION found in review: a later thread chunk has already
//    been claimed (processing) by a concurrent, overlapping tick -- e.g.
//    that tick is mid-broadcast on it. The thread-fail-fast skip path
//    must NOT clobber that with an unconditional 'failed' overwrite; it
//    should back off and let the owning tick resolve the row itself.
function test7() {
  const store = makeStore([{ id: 41, status: 'processing', updatedAt: 100 }]) // claimed by another tick
  const result = trySkipAsThreadFailed(store, 41)
  check('7a: skip path does not touch a row already claimed by another tick', result.skipped, false)
  check('7b: status remains processing -- not clobbered to failed', store.table.get(41).status, 'processing')
}

function main() {
  test1()
  test2()
  test3()
  test4()
  test5()
  test6()
  test7()
  console.log(`\n${checkCount - failures}/${checkCount} passed`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
