// Standalone verification of two fixes:
// 1. DataCleaner.cleanupPendingTips() never called createTipNotification
//    on either of its two confirmation branches (Action found / TxQueue
//    found), so a tip confirmed via this fallback (indexer missed the
//    on-chain event) never notified the recipient.
// 2. NotificationService.createTipNotification's dedup check for profile
//    tips (cawId null) matched ANY prior profile-tip notification between
//    the same two users (cawId: cawId || undefined drops the cawId key
//    from the WHERE entirely when cawId is undefined), so a second,
//    third, etc. profile tip from the same sender never got its own
//    notification once the first one existed.
//
// Fix: dedupe post tips (cawId set) by cawId as before; dedupe profile
// tips (cawId null) by cawonce instead, stored in actionPayload.
// Run: node scripts/verify-tip-notification-cawonce-dedup.js

let failures = 0
let checkCount = 0
function check(label, actual, expected) {
  checkCount++
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// --- Simulated Notification store ---
function makeStore() {
  const rows = []
  let nextId = 1
  return {
    rows,
    findFirst: (where) => {
      return rows.find(r => {
        if (r.userId !== where.userId) return false
        if (r.actorId !== where.actorId) return false
        if (r.type !== where.type) return false
        if ('cawId' in where && r.cawId !== where.cawId) return false
        if (where.actionPayload && r.actionPayload?.cawonce !== where.actionPayload.equals) return false
        return true
      }) || null
    },
    create: (data) => {
      const row = { id: nextId++, ...data }
      rows.push(row)
      return row
    },
  }
}

// --- Mirrors the fixed createTipNotification dedup logic ---
function createTipNotification(store, recipientId, tipperId, cawId, amount, cawonce) {
  if (recipientId === tipperId) return
  const existing = cawId
    ? store.findFirst({ userId: recipientId, actorId: tipperId, type: 'TIP', cawId })
    : cawonce != null
      ? store.findFirst({ userId: recipientId, actorId: tipperId, type: 'TIP', cawId: null, actionPayload: { equals: cawonce } })
      : null
  if (!existing) {
    store.create({
      userId: recipientId,
      actorId: tipperId,
      type: 'TIP',
      cawId: cawId || null,
      actionPayload: { ...(amount ? { tipAmount: String(amount) } : {}), ...(cawonce != null ? { cawonce } : {}) },
    })
  }
}

// 1) First profile tip: creates a notification.
function test1() {
  const store = makeStore()
  createTipNotification(store, 2, 1, undefined, 5, 100)
  check('1: first profile tip (cawonce 100) creates a notification', store.rows.length, 1)
}

// 2) THE BUG: second profile tip from the same sender, different cawonce.
//    Before the fix, this was silently suppressed by the broad cawId-less
//    dedup check. After the fix, it must create its own notification.
function test2() {
  const store = makeStore()
  createTipNotification(store, 2, 1, undefined, 5, 100)
  createTipNotification(store, 2, 1, undefined, 3, 101)
  check('2: second profile tip (cawonce 101, different amount) creates a SEPARATE notification -- the bug this fixes', store.rows.length, 2)
}

// 3) A third, fourth profile tip: each one keeps getting its own
//    notification, not just the second.
function test3() {
  const store = makeStore()
  createTipNotification(store, 2, 1, undefined, 5, 100)
  createTipNotification(store, 2, 1, undefined, 3, 101)
  createTipNotification(store, 2, 1, undefined, 1, 102)
  createTipNotification(store, 2, 1, undefined, 2, 103)
  check('3: every subsequent profile tip from the same sender gets notified, not just the first two', store.rows.length, 4)
}

// 4) Replay protection: the SAME cawonce processed twice (e.g. DataCleaner
//    and ActionProcessor both confirming the same tip in a race) must
//    still dedupe to exactly one notification.
function test4() {
  const store = makeStore()
  createTipNotification(store, 2, 1, undefined, 5, 100)
  createTipNotification(store, 2, 1, undefined, 5, 100) // replay of the same cawonce
  check('4: replaying the same cawonce does not create a duplicate notification', store.rows.length, 1)
}

// 5) Post tips (cawId set) are unaffected by the cawonce change -- still
//    dedupe by cawId as before, so multiple tips on the same caw from the
//    same tipper collapse to one notification (existing rollup behavior).
function test5() {
  const store = makeStore()
  createTipNotification(store, 2, 1, 999, 5, 200)
  createTipNotification(store, 2, 1, 999, 3, 201) // different cawonce, same caw
  check('5: post tips still collapse by cawId regardless of cawonce (unchanged rollup behavior)', store.rows.length, 1)
}

// 6) Post tips on DIFFERENT cawIds from the same tipper each get their own
//    notification, same as before this fix.
function test6() {
  const store = makeStore()
  createTipNotification(store, 2, 1, 999, 5, 300)
  createTipNotification(store, 2, 1, 888, 3, 301)
  check('6: post tips on different caws each get their own notification', store.rows.length, 2)
}

// 7) Self-tips are still never notified, regardless of cawonce.
function test7() {
  const store = makeStore()
  createTipNotification(store, 1, 1, undefined, 5, 400)
  check('7: self-tip creates no notification', store.rows.length, 0)
}

// --- Mirrors the DataCleaner fallback fix: both confirmation branches now
//     call createTipNotification, where before neither did. ---
function simulateDataCleanerConfirm(store, pendingTip, viaAction) {
  // Both branches (Action found / TxQueue found) previously just updated
  // pending: false with no notification call at all. Both now call
  // createTipNotification with the tip's own recipientId/senderId/cawId/
  // amount/cawonce -- same call regardless of which branch confirmed it.
  createTipNotification(store, pendingTip.recipientId, pendingTip.senderId, pendingTip.cawId, pendingTip.amount, pendingTip.cawonce)
}

// 8) DataCleaner's action-confirmed branch now notifies (previously silent).
function test8() {
  const store = makeStore()
  const pendingTip = { recipientId: 2, senderId: 1, cawId: undefined, amount: 7, cawonce: 500 }
  simulateDataCleanerConfirm(store, pendingTip, true)
  check('8: DataCleaner action-confirmed branch now creates a notification (previously missing)', store.rows.length, 1)
}

// 9) DataCleaner's txQueue-confirmed branch now notifies (previously silent).
function test9() {
  const store = makeStore()
  const pendingTip = { recipientId: 2, senderId: 1, cawId: undefined, amount: 4, cawonce: 501 }
  simulateDataCleanerConfirm(store, pendingTip, false)
  check('9: DataCleaner txQueue-confirmed branch now creates a notification (previously missing)', store.rows.length, 1)
}

// 10) DataCleaner confirming a tip that ActionProcessor's live path already
//     notified for (same cawonce) must not double-notify -- the cawonce
//     dedup covers this cross-path race too.
function test10() {
  const store = makeStore()
  // Live path already notified for cawonce 502
  createTipNotification(store, 2, 1, undefined, 6, 502)
  // DataCleaner's sweep later confirms the same tip via its fallback
  const pendingTip = { recipientId: 2, senderId: 1, cawId: undefined, amount: 6, cawonce: 502 }
  simulateDataCleanerConfirm(store, pendingTip, true)
  check('10: DataCleaner confirming a tip the live path already notified for does not double-notify', store.rows.length, 1)
}

function main() {
  test1()
  test2()
  test3()
  test4()
  test5()
  test6()
  test7()
  test8()
  test9()
  test10()
  console.log(`\n${checkCount - failures}/${checkCount} passed`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
