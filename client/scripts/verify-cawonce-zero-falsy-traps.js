// Standalone verification of the cawonce===0 falsy-trap fixes across
// FeedItem.tsx, ScheduledPostProcessor, actions.ts, Feed.tsx,
// actionHandlers.ts, CawAI/reply.ts, and Notifications.tsx.
//
// cawonce is a per-user nonce starting at 0 for a user's first action
// or a thread's root chunk. `0` is falsy in JS, so `if (!cawonce)` /
// `if (x && x.cawonce)` style guards break specifically on the
// first-post / thread-root case. Each check here mirrors the exact
// condition from the source, evaluated with cawonce=0 (should pass
// through) vs cawonce=undefined/null (should still be caught).
//
// Run: node scripts/verify-cawonce-zero-falsy-traps.js

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// --- Site 1: FeedItem.tsx delete-confirm guard ---
// Fixed: if (!effectiveTokenId || useItem.cawonce == null) return
function site1_shouldReturn(effectiveTokenId, cawonce) {
  return !effectiveTokenId || cawonce == null
}
check('1a: cawonce=0, tokenId set -> proceeds with delete (no early return)', site1_shouldReturn(42, 0), false)
check('1b: cawonce=5, tokenId set -> proceeds with delete', site1_shouldReturn(42, 5), false)
check('1c: cawonce=undefined -> still blocked', site1_shouldReturn(42, undefined), true)
check('1d: no tokenId -> still blocked even with cawonce=0', site1_shouldReturn(null, 0), true)

// --- Site 2: ScheduledPostProcessor parent-lookup guard ---
// Fixed: if (data.receiverId && data.receiverCawonce != null)
function site2_shouldLookupParent(receiverId, receiverCawonce) {
  return Boolean(receiverId && receiverCawonce != null)
}
check('2a: receiverCawonce=0 (chunk 0 as parent) -> looks up parent', site2_shouldLookupParent(7, 0), true)
check('2b: receiverCawonce=3 -> looks up parent', site2_shouldLookupParent(7, 3), true)
check('2c: receiverId=0 (top-level post, prod format) -> skips lookup', site2_shouldLookupParent(0, 0), false)
check('2d: receiverId=undefined -> skips lookup (top-level post)', site2_shouldLookupParent(undefined, undefined), false)

// --- Site 3: actions.ts pending-replay effect guard ---
// Fixed: if (!isConnected || !pendingParams || cawonce == null || submittingRef.current)
function site3_shouldReturn(isConnected, pendingParams, cawonce, submitting) {
  return !isConnected || !pendingParams || cawonce == null || submitting
}
check('3a: connected, pending action, cawonce=0 -> replays (no early return)', site3_shouldReturn(true, {}, 0, false), false)
check('3b: cawonce=undefined -> still blocked (activeToken not resolved yet)', site3_shouldReturn(true, {}, undefined, false), true)
check('3c: not connected -> still blocked regardless of cawonce', site3_shouldReturn(false, {}, 0, false), true)

// --- Site 4: Feed.tsx pending-post-id resolution guard ---
// Fixed: p.cawonce != null && p.user?.tokenId (tokenId unchanged, per existing line 936 style)
function site4_shouldResolve(idStr, cawonce, tokenId) {
  return idStr.startsWith('pending-') && cawonce != null && !!tokenId
}
check('4a: pending id, cawonce=0, tokenId set -> resolves real id', site4_shouldResolve('pending-123', 0, 42), true)
check('4b: cawonce=undefined -> does not resolve yet', site4_shouldResolve('pending-123', undefined, 42), false)
check('4c: already real id -> not attempted (startsWith fails)', site4_shouldResolve('44', 0, 42), false)

// --- Site 5: actionHandlers.ts handleLikeAction fallback guard ---
// Fixed: if (!parentCawId && rawAction.receiverId != null && rawAction.receiverCawonce != null)
function site5_shouldResolveFallback(parentCawId, receiverId, receiverCawonce) {
  return !parentCawId && receiverId != null && receiverCawonce != null
}
check('5a: no parentCawId yet, receiverCawonce=0 (liking first post) -> resolves via fallback', site5_shouldResolveFallback(undefined, 9, 0), true)
check('5b: parentCawId already resolved upstream -> fallback skipped (no-op either way)', site5_shouldResolveFallback(123, 9, 0), false)
check('5c: receiverCawonce=undefined -> fallback correctly skipped (nothing to resolve)', site5_shouldResolveFallback(undefined, 9, undefined), false)

// --- Site 6: CawAI/reply.ts fetchParentCawInfo guard ---
// Fixed: if (receiverId == null || receiverCawonce == null) throw
function site6_shouldThrow(receiverId, receiverCawonce) {
  return receiverId == null || receiverCawonce == null
}
check('6a: replying to first post, cawonce=0 -> does not throw', site6_shouldThrow(9, 0), false)
check('6b: cawonce=undefined (malformed API response) -> throws as intended', site6_shouldThrow(9, undefined), true)
check('6c: receiverId=undefined -> throws as intended', site6_shouldThrow(undefined, 0), true)

// --- Site 7: Notifications.tsx ACTION_FAILED title/link guards (all 3 sites share the same fix) ---
// Fixed: payload.receiverId && payload.receiverCawonce != null
function site7_isReplyFailure(receiverId, receiverCawonce) {
  return Boolean(receiverId && receiverCawonce != null)
}
check('7a: failed reply to first post (receiverCawonce=0) -> labeled as reply failure', site7_isReplyFailure(9, 0), true)
check('7b: top-level post failure (receiverId=0, receiverCawonce=0, prod format) -> labeled as generic posting failure', site7_isReplyFailure(0, 0), false)
check('7c: top-level post failure (no receiver) -> labeled as generic posting failure', site7_isReplyFailure(undefined, undefined), false)
check('7d: reply to post #5 -> labeled as reply failure', site7_isReplyFailure(9, 5), true)

console.log(`\n${19 - failures}/19 passed`)
process.exit(failures > 0 ? 1 : 0)
