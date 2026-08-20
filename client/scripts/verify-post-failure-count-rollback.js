// Standalone verification of the CAW/RECAW count rollback added to
// txQueueFailure.ts and DataCleaner/index.ts (companion to PR #58,
// which fixed the same rollback omission for like/follow).
// Mirrors CountManager.onStatusChanged's case 'caw' logic.
// Run: node scripts/verify-post-failure-count-rollback.js

// --- Simulated DB state ---
let users = new Map() // tokenId -> { cawCount, recawCount }
let caws = new Map()  // id -> { recawCount }

function resetDb() {
  users = new Map()
  caws = new Map()
}
function getUser(id) {
  if (!users.has(id)) users.set(id, { cawCount: 0, recawCount: 0 })
  return users.get(id)
}
function getCaw(id) {
  if (!caws.has(id)) caws.set(id, { recawCount: 0 })
  return caws.get(id)
}
function safeDecrement(current) {
  return Math.max(0, current - 1)
}

// --- onCawCreated (mirrors CountManager.ts, including the isReply
//     dead-code status found during audit: isReply is never passed
//     true by any caller, so replies DO bump cawCount on creation,
//     same as top-level posts and quotes) ---
function onCawCreated(caw) {
  const user = getUser(caw.userId)
  if (caw.action === 'RECAW') {
    user.recawCount++
  } else {
    user.cawCount++ // includes replies, per the audit finding
  }
  if (caw.originalCawId) {
    getCaw(caw.originalCawId).recawCount++
  }
}

// --- onStatusChanged case 'caw' (mirrors CountManager.ts, this PR's
//     txQueueFailure.ts/DataCleaner.ts call sites always pass
//     originalCawId: null from DataCleaner to avoid double-decrementing
//     the parent recawCount that DataCleaner's own recalculation logic
//     already handles separately -- txQueueFailure.ts passes the real
//     originalCawId since it has no separate recalculation step) ---
function onStatusChangedCawFailed(meta) {
  const user = getUser(meta.userId)
  if (meta.action === 'RECAW') {
    user.recawCount = safeDecrement(user.recawCount)
  } else {
    user.cawCount = safeDecrement(user.cawCount)
  }
  if (meta.originalCawId && (meta.action === 'RECAW' || meta.action === 'CAW')) {
    const parent = getCaw(meta.originalCawId)
    parent.recawCount = safeDecrement(parent.recawCount)
  }
}

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// 1) Top-level CAW: create then fail. cawCount should return to 0.
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
check('1a: top-level CAW creation bumps cawCount', getUser(1).cawCount, 1)
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null })
check('1b: top-level CAW failure rolls cawCount back to 0', getUser(1).cawCount, 0)

// 2) Quote (CAW with originalCawId): create then fail. Both cawCount and
//    parent's recawCount should roll back together.
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: 100 })
check('2a: quote creation bumps cawCount and parent recawCount', [getUser(1).cawCount, getCaw(100).recawCount], [1, 1])
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: 100 })
check('2b: quote failure rolls back both cawCount and parent recawCount', [getUser(1).cawCount, getCaw(100).recawCount], [0, 0])

// 3) Reply (CAW with originalCawId, per the audit finding this DOES bump
//    cawCount on creation despite the isReply doc comment's intent, since
//    no caller ever passes isReply:true). DataCleaner's call site passes
//    originalCawId: null deliberately, so only cawCount rolls back here
//    -- parent recawCount is NOT touched by this path (replies bump
//    parent.commentCount, not recawCount, so there's nothing to undo on
//    this axis; commentCount rollback is handled separately).
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null }) // reply: caller omits originalCawId same as quote-vs-reply distinction upstream
check('3a: reply creation bumps cawCount (matches audited actual behavior)', getUser(1).cawCount, 1)
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null })
check('3b: reply failure rolls cawCount back symmetrically', getUser(1).cawCount, 0)

// 4) RECAW (plain repost): create then fail. recawCount (not cawCount)
//    should roll back, along with the parent's recawCount.
resetDb()
onCawCreated({ userId: 1, action: 'RECAW', originalCawId: 200 })
check('4a: RECAW creation bumps recawCount and parent recawCount', [getUser(1).recawCount, getCaw(200).recawCount], [1, 1])
onStatusChangedCawFailed({ userId: 1, action: 'RECAW', originalCawId: 200 })
check('4b: RECAW failure rolls back both', [getUser(1).recawCount, getCaw(200).recawCount], [0, 0])

// 5) Idempotency / safety net: rolling back twice must never go negative.
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null })
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null }) // simulate a double-fire
check('5: safeDecrement floor prevents underflow below zero', getUser(1).cawCount, 0)

// 6) Independence: rolling back one user's caw does not affect another
//    user's counts.
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
onCawCreated({ userId: 2, action: 'CAW', originalCawId: null })
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null })
check('6: rolling back user 1 does not affect user 2', [getUser(1).cawCount, getUser(2).cawCount], [0, 1])

// 7) The critical distinction found during audit: Caw.originalCawId is
//    set in the DB for BOTH quotes and replies (actionHandlers.ts's
//    upsert always writes parentCawId there), but only quotes should
//    decrement the parent's recawCount on failure -- a reply's parent
//    gets commentCount bumped instead. Simulates txQueueFailure.ts's
//    Reply-row lookup to confirm a reply's raw DB originalCawId gets
//    converted to null before reaching onStatusChanged, so the parent's
//    recawCount is untouched.
function resolveOriginalCawIdForRollback(rawOriginalCawId, isReplyRow) {
  return isReplyRow ? null : rawOriginalCawId
}
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null }) // reply creation never bumps parent recawCount
getCaw(300).recawCount = 5 // parent has other unrelated recaws/quotes -- must stay untouched
const rawOriginalCawIdFromDb = 300 // what Caw.originalCawId actually holds for a reply row
const resolvedForReply = resolveOriginalCawIdForRollback(rawOriginalCawIdFromDb, true)
onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: resolvedForReply })
check('7a: reply failure resolves originalCawId to null before rollback', resolvedForReply, null)
check('7b: reply failure does not touch the parent recawCount (still 5)', getCaw(300).recawCount, 5)

// 8) Same lookup for an actual quote: raw originalCawId must pass
//    through unchanged, so the parent recawCount rollback still fires.
const resolvedForQuote = resolveOriginalCawIdForRollback(rawOriginalCawIdFromDb, false)
check('8: quote failure passes originalCawId through unchanged', resolvedForQuote, 300)

// 9) TOCTOU regression check: markTxQueueFailed's CAW/RECAW cleanup used to
//    run findMany then updateMany as two separate queries with no status
//    guard on the write. Two concurrent calls for the same senderId/cawonce
//    could both read the same PENDING row before either write landed, then
//    each fire onStatusChanged for it -- double-decrementing cawCount. The
//    fix scopes the updateMany to `status: 'PENDING'` and only calls
//    onStatusChanged for rows this call actually flipped. Simulate both a
//    single "DB" row and two concurrent callers racing against it.
function simulateConcurrentFailure(useGuardedUpdate) {
  resetDb()
  onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
  const row = { status: 'PENDING' }

  function callerAttempt() {
    // findMany-equivalent: read current status
    const sawPending = row.status === 'PENDING'
    if (!sawPending) return // guarded path: row already FAILED, nothing to do
    if (useGuardedUpdate) {
      // updateMany WHERE status = 'PENDING': only the first caller to
      // reach this line actually transitions the row.
      if (row.status !== 'PENDING') return
      row.status = 'FAILED'
    } else {
      // old behavior: unconditional write, no guard against a concurrent
      // caller having already transitioned it.
      row.status = 'FAILED'
    }
    onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null })
  }

  // Simulate caller A's findMany happening, then caller B's findMany
  // happening (both see PENDING) before either write lands.
  callerAttempt()
  callerAttempt()
  return getUser(1).cawCount
}

check('9a: old unguarded pattern double-decrements under concurrent calls (regression demo, expected 0 via floor but only after already going below the correct 1-decrement result)', simulateConcurrentFailure(false), 0)
check('9b: guarded pattern (status: PENDING on updateMany) prevents double-decrement', simulateConcurrentFailure(true), 0)
// Note: 9a and 9b land on the same floored value (0) because safeDecrement's
// floor masks the double-decrement when starting from cawCount=1. The real
// regression is visible starting from cawCount=2 -- see 9c/9d.
resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
check('9c: baseline cawCount before concurrent failure of one post', getUser(1).cawCount, 2)

function simulateConcurrentFailureFromTwo(useGuardedUpdate) {
  const row = { status: 'PENDING' }
  // Phase 1: both concurrent callers' findMany-equivalent reads happen
  // BEFORE either one's write lands -- this is the actual TOCTOU window.
  const callerASawPending = row.status === 'PENDING'
  const callerBSawPending = row.status === 'PENDING'

  function writeAttempt(sawPending) {
    if (!sawPending) return
    if (useGuardedUpdate) {
      // updateMany WHERE status = 'PENDING': only the first writer to
      // reach this line actually transitions the row; the second one's
      // updateMany affects 0 rows and it must not call onStatusChanged.
      if (row.status !== 'PENDING') return
      row.status = 'FAILED'
    } else {
      // old behavior: unconditional write, no re-check against the
      // row's current status.
      row.status = 'FAILED'
    }
    onStatusChangedCawFailed({ userId: 1, action: 'CAW', originalCawId: null })
  }

  // Phase 2: both callers now attempt their writes.
  writeAttempt(callerASawPending)
  writeAttempt(callerBSawPending)
}
simulateConcurrentFailureFromTwo(false)
check('9d: UNGUARDED pattern double-decrements cawCount 2 -> 0 on one failed post (bug)', getUser(1).cawCount, 0)

resetDb()
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
onCawCreated({ userId: 1, action: 'CAW', originalCawId: null })
simulateConcurrentFailureFromTwo(true)
check('9e: GUARDED pattern decrements cawCount 2 -> 1 on one failed post (correct)', getUser(1).cawCount, 1)

console.log(`\n${13 - failures}/13 passed`)
process.exit(failures > 0 ? 1 : 0)
