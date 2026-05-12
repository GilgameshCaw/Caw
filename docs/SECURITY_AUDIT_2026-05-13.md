# Security & smoothness audit — 2026-05-13

Three-pronged audit pass:
1. API route security (auth, IDOR, mass-assignment, info-disclosure)
2. Database index coverage on hot query paths
3. Smoothness / scaling concerns (N+1, unbounded loops, sync RPC in request paths)

Findings spot-checked against the actual code; agent claims confirmed where called out as CRITICAL/HIGH.

## API security

### CRITICAL

**1. `withdrawals.ts:104` — unauthenticated withdrawal-request enumeration**
```
router.get('/:userId/pending', async (req, res) => {
  const userId = parseInt(req.params.userId)
  ...
  const pendingWithdrawals = await prisma.withdrawalRequest.findMany({ where: { userId } })
```
No `requireAuth`. Any anonymous caller can enumerate pending withdrawals for any userId. Information disclosure of in-flight withdrawal amounts + addresses.

**Fix:** wrap with `requireAuth({ lookup: req => Number(req.params.userId), verifyOwnership: true })`.

**2. `admin-db.ts:442` — admin PATCH spreads `req.body` without field allowlist**
Mass-assignment behind admin auth. The model-level `requireAdmin` is in place, but a compromised/rogue admin can write to fields not in the intended write set (e.g., `id`, internal flags). Not exploitable by a normal user but reduces audit-trail integrity and blast radius of an admin compromise.

**Fix:** maintain an explicit per-model writable-field allowlist in `MODEL_META` and filter `req.body` against it before passing to `prisma.<model>.update`.

**3. `admin-db.ts:482` — admin DELETE has no audit log**
DELETE is gated by `requireAdmin` but doesn't write a `ModerationAction` row. An admin can silently delete User/TxQueue/Caw rows with no record.

**Fix:** require a non-empty `reason` field on DELETE; write a `ModerationAction` row with admin id, model, target id, reason.

### HIGH

**4. `tips.ts:53` — `/api/tips/sent` reads `x-user-id` header without authentication**
Any caller can spoof the header to read another user's tip-sending history.

**Fix:** add `requireAuth` and resolve `userId` from the verified session, not the header.

**5. `tips.ts:90` — `/api/tips/received` reads `userId` from query string without authentication**
Same shape: read any user's received tips. Information disclosure of payment patterns.

**Fix:** either gate behind auth + ownership check, or make this admin-only / public-profile-only depending on intent. If the data is meant to be public on profile pages, that's fine, but it should be a deliberate choice (and the response shape should exclude sender details to reduce DM-graph fingerprinting).

**6. `reports.ts:61` — reporter id read from `req.body` and defaults to 0 on miss**
```
reporterId: parseInt(reporterId || '0')
```
If `req.body.reporterId` is missing or zero, the row gets `reporterId: 0`, breaking the link back to the authenticated reporter. An attacker could strip `reporterId` to detach a report from their identity even while still being authenticated.

**Fix:** read reporterId from `req.sessionData` (the verified session), not from the request body. Pattern is already correct in `bugReports.ts:92-97`.

### MEDIUM

**7. `dm-groups.ts:117` — DELETE member uses `actorUserId` from req.body**
The body-supplied `actorUserId` is passed to `requireAuth({ field: 'actorUserId', verifyOwnership: true })`. If the verifyOwnership middleware checks that the authenticated user owns the body-supplied id (rather than verifying the action is being performed *by* the authenticated user), an attacker could pass their own tokenId as actorUserId, satisfy ownership, and remove someone else from a group they're not in. Worth code-reading the verifyOwnership middleware to confirm semantics.

**Fix:** read actorUserId from the verified session rather than req.body.

**8. `upload.ts:42` — file upload validates MIME type via header, not magic bytes**
The MIME_TO_EXT allowlist is good defense in depth, but Content-Type is client-supplied. A client could upload a file with executable contents and a spoofed `image/png` header.

**Fix:** validate magic bytes (sniff first 8 bytes against known image format signatures) before accepting an upload. `file-type` npm package does this cleanly.

### Categories audited and CLEAN

- **SQL injection.** No `$queryRaw` / `$executeRaw` found with user-interpolated input.
- **Auth bypass via type confusion.** All routes normalize ids consistently.
- **Action-route rate limiting.** `/api/actions` has rate limits; `/api/upload` has reservations; `/api/dm` has `checkDmRate`.

## Database indexes

### Add (ranked by impact)

**1. `ConversationParticipant(userId, leftAt, status)`**
DM inbox queries filter by all three. Currently has separate `(userId)`, `(userId, status)`, `(conversationId, leftAt)` — none cover the multi-filter. Runs on every DM inbox load.

**2. `Caw(userId, status, createdAt)`**
Profile feed + main feed both filter by userId, status='SUCCESS', sort by createdAt desc. Currently has `(userId, action, createdAt)`, `(status, createdAt)`, `(status, userId)` — close but no exact match for the dominant query shape.

**3. `Tip(recipientId, pending, createdAt)`**
Tip history feature filters recipient + pending, sorts by recent. Currently has only `(recipientId)` and a separate `(senderId, pending)`.

**4. `Follow(followerId, action, status)`** or partial index `WHERE action='FOLLOW' AND status='SUCCESS'`
Home feed's "following" filter runs this on every page load.

**5. (Confirm only)** `Message(conversationId, createdAt)` claimed missing — actually present in the schema. Verify EXPLAIN ANALYZE uses it on real query plans.

### Remove (likely unused)

**1. `Notification(createdAt)`** standalone. All real queries use `(userId, ...)` composites; the single-column index doesn't help any path. Drop it to save write overhead.

**2. `Conversation(lastMessageAt)`** standalone. Same shape — almost always joined from ConversationParticipant where userId is the actual filter.

### Recommendation

The DB migrations live in Prisma. Adding the 4 missing composites costs negligible write overhead on append-heavy tables. Doing them as one migration is appropriate. Drop the two unused indexes in the same migration.

## Smoothness / scale

Top findings, ranked by impact at 10x users.

### Will hurt soon (fix in next cycle)

**S1. `users.ts:1181, 1279` — N+1 on follower/following list "do I follow you?" check**
Loops over each user in a follower list and issues a separate `prisma.follow.findUnique` per entry. 50 followers per page = 50 extra DB round trips.

**Fix:** one `findMany({ where: { followerId: currentUserId, followingId: { in: allTargetIds } } })` and build an in-memory map.

**S2. `marketplace.ts:153` — `/sales/stats` scans all sales and sums in memory**
No pagination/limit. Full table scan + large response. OOM risk as sales accrue.

**Fix:** push aggregation to SQL with `SELECT paymentToken, SUM(price) GROUP BY paymentToken`, or maintain incremental counters in Redis.

**S3. `marketplace.ts:654` — POST `/offers/notify` blocks up to 15 s waiting for indexer**
5 retries × 3 s. Holds an Express request slot the whole time. Under load, this can starve the request pool.

**Fix:** 202 + client polls, or queue an async job and respond immediately.

**S4. `marketplace.ts:208` — `/refunds/:address` unpaginated**
Loads all OUTBID bids for an address with no limit. A heavy bidder = a huge query.

**Fix:** add `take` + cursor pagination matching the pattern in `/bids/:address`.

**S5. `caws.ts:539` — `/api/caws/:id/likes` hard-caps at 500, no cursor**
Viral post with >500 likes can't be fully paginated.

**Fix:** cursor pagination with `take: limit + 1`, return `nextCursor`.

**S6. `actions.ts:112-117` — free-action rate limiter is per-process in-memory**
If the app runs on multiple workers, each sees its own counter — bypassable by spreading requests across workers (effective limit = N × per-worker limit).

**Fix:** move to Redis with `INCR` + `EXPIRE`. Atomic, shared across workers.

**S7. `ViewTracker.ts:78-85` — bulk view-tracking issues N updates per page**
Inside a transaction, `for (const cawId of cawsToUpdate) tx.caw.update({...})`. 20 caws on a page = 20 round-trips.

**Fix:** single `updateMany({ where: { id: { in: cawsToUpdate } }, data: { viewCount: { increment: 1 } } })`.

### Will hurt eventually (defer until pain shows up)

**S8. `websocket.ts:13` — `userSockets` Map grows unbounded if sockets hang open after hard crashes.**
Cleanup runs on graceful disconnect; not on crash. Slow leak in long-lived processes.

**Fix:** TTL eviction every 5 min, or track lastActivity and reap stale entries.

**S9. `NotificationService.ts:9` — `getThreadRootId` walks parent chain with `maxDepth: 100`.**
Silently returns wrong root if a chain exceeds 100 levels. Hard to detect, hard to debug.

**Fix:** log when the depth limit is hit; consider storing `threadRootId` directly on each Caw row so the walk becomes O(1).

**S10. `ViewTracker.ts:92-105` — `getTrendingByViews` scans 7 days of caws without minimum viewCount filter.**
At scale, millions of low-view caws get pulled into memory before sort+limit.

**Fix:** filter `viewCount >= threshold` in SQL, or maintain a materialized "hot caws" table updated by the indexer.

**S11. `search.ts:89-100` — search result re-fetch uses full `include` instead of sparse `select`.**
Over-fetches per result. Not slow today; will be at 10x results.

**Fix:** minimal `select` for the search-result card shape; defer full include to the detail route.

**S12. `NotificationService.ts:108-114` — mention notification loop is N+1-shaped (mute check today is a stub).**
If mute logic ever becomes server-side, this becomes a real N+1.

**Fix:** when implementing server-side mute, batch the check in a single `findMany`.

### Categories audited and CLEAN

- **Unbounded recursion in validator hot paths.** ValidatorService loops are bounded by batch sizes.
- **Polling intervals.** All seen intervals are >= 5s.
- **External RPC in request paths.** Most reads are DB-only; RPC calls are queued (deposit poll, action submission). Exception is the `marketplace.ts:654` retry loop above.

## Severity summary

| Bucket | Count |
|---|---|
| API CRITICAL | 3 |
| API HIGH | 3 |
| API MED | 2 |
| Index — add | 4 |
| Index — remove | 2 |
| Smoothness — soon | 7 |
| Smoothness — eventually | 5 |

## Recommended next steps

1. Fix the three CRITICAL findings before next release: withdrawals auth, admin-db field allowlist, admin DELETE audit log.
2. Fix the three HIGH findings in the same cycle: tips routes auth, reports.reporterId source.
3. Schedule the index migration after the next deploy.
4. Confirm the verifyOwnership middleware semantics against `dm-groups.ts` actorUserId pattern.
5. Add file-magic-byte validation to `upload.ts`.
