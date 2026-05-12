# Security & smoothness audit — 2026-05-13

Three-pronged audit pass:
1. API route security (auth, IDOR, mass-assignment, info-disclosure)
2. Database index coverage on hot query paths
3. Smoothness / scaling concerns (N+1, unbounded loops, sync RPC in request paths)

Findings spot-checked against the actual code; agent claims confirmed where called out as CRITICAL/HIGH.

## ✅ Fixes applied in this pass

API security:
- `withdrawals.ts:104` — added `requireAuth({ verifyOwnership })` to `/:userId/pending` (was unauthenticated).
- `tips.ts:53,90` — added `requireAuth` to `/sent` and `/received` (were unauthenticated).
- `reports.ts:61` — removed misleading `: 0` fallback (was dead code, kept it tight).
- `admin-db.ts` PATCH — explicit per-model writableFields allowlist; req.body fields outside the allowlist are dropped.
- `admin-db.ts` DELETE — required `reason` field; ModeratorAction audit row written.

Crypto / randomness:
- `shorturl.ts:54` — `generateShortCode` switched from `Math.random()` to `crypto.randomBytes` with modulo-bias rejection sampling.
- `scheduled.ts:88` — threadId random suffix switched to `randomBytes(6).toString('hex')`.

Frontend:
- `AccountSettings.tsx` X-verify flow — origin allowlist on `res.url` before redirect (defense-in-depth open-redirect mitigation).
- `FeedItem.tsx` — 7 unguarded `JSON.parse(localStorage.getItem(...))` calls routed through new `utils/safeStorage` helper.

Smoothness / perf:
- Free-action rate limiter moved from in-memory Map to Redis (`freeActionRateLimit.ts`); previous limiter was per-worker, bypassable.
- `marketplace.ts /sales/stats` — push SUM aggregation to Postgres via raw query (previous version full-scanned the table).
- `marketplace.ts /refunds/:address` — added pagination matching `/bids/:address`.
- `marketplace.ts /offers/notify` — 15s blocking retry loop converted to 202 + background poll.
- `caws.ts /:id/likes` — replaced 500-row hard cap with cursor pagination.
- `users.ts /followers + /following` — N+1 batched into a single `findMany` for the "is this author in my follows" check.
- `ViewTracker` — bulk update loop replaced with `updateMany` (20 round-trips → 1); trending query gated by `viewCount >= 5` threshold to enable partial index scan.
- `ValidatorService.submitProcessActions` — nonce fetch + send now serialized via a promise chain so parallel sub-batch submissions don't collide on nonce.

Schema (prisma/schema.prisma):
- Added: `Caw(userId, status, createdAt)`, `Follow(followerId, action, status)`, `Tip(recipientId, pending, createdAt)`, `ConversationParticipant(userId, leftAt, status)`.
- Dropped: standalone `Notification(createdAt)` and `Conversation(lastMessageAt)`.
- Schema-only; needs `npx prisma migrate dev --create-only --name add_feed_indexes` then review the SQL before applying.

Contract:
- `CawProfileL2.registerSession`, `registerSessionPersonal` — ERC-1271 fallback added; bytes-form signature parameter; 7 new tests; full self-audit in `native/docs/AUDIT_NOTES.md`.

## ✅ Third-wave: contract invariant deep-dive — CLEAN

A focused multi-step state-evolution audit on the smart contracts. Goal: find legitimate-but-combined sequences (transfer + revoke + re-register, deposit-during-transfer, challenge-while-finalizing, etc.) that leave the contracts in an inconsistent state.

**Conclusion: no new critical invariants are broken.** All ten invariants checked — balance drift, session/ownership state coherence, L1/L2 sync, challenge-finalize race, stake accounting, cawonce monotonicity, spend-limit reset, ERC-1271 re-entrance, checkpoint boundaries, LZ out-of-order delivery — hold up against the audit. Existing mitigations (`ownerSessionEpoch` bump on transfer, `sessionNonce` increment per registration, LZ stamp ordering, gas-bounded staticcalls, etc.) form a coherent defense.

One code-hygiene observation worth noting: `sessionSpent[owner][sessionKey]` is not zeroed on `revokeSession`. The dormant counter is *not* exploitable because `validSession` returns a zero struct (epoch mismatch / deleted record) once a session is revoked. Worth a one-line cleanup (`delete sessionSpent[msg.sender][sessionKey]` in `revokeSession`) for tidiness, not because of an exploit path.

## ✅ Second-wave audits and fixes

After the first-wave fixes, three more audit passes ran:

**LayerZero / cross-chain audit** — **CLEAN**. All findings from the 2026-05-08 pass remain mitigated (peer locks, stamp ordering, fee refund paths, withdraw-scope hardening). No new findings. Documented in the chat history; no separate report needed.

**Auth system deep-dive** — surfaced two CRITICAL findings:
1. **Auth signature replay within 5-minute window** — FIXED. New `consumeAuthSignatureOnce` in `sessionStore.ts`; both `/api/auth/verify` and `/api/auth/enable-dms` now atomic-SET-NX the sig digest in Redis with a 5-minute TTL.
2. **"Session fixation via attacker-controlled session IDs"** — VERIFIED FALSE ALARM on re-read. `createSession` generates the token server-side via `randomBytes(32)`; the only way an attacker-supplied `x-session-token` is honored is if it already exists in Redis (i.e., the attacker first authenticated and is now trying to attach a victim to their own session). That's CSRF-territory, not a session-store bug. Real but lower-priority and out of scope for this pass.

Plus medium findings: session TTL is 1 year (no idle timeout), DM-auth signature has no timestamp binding (also fixed via consumed-sig nonce, but the broader timestamp-binding issue remains), logout doesn't require auth (low-risk).

**Logs / observability audit** — applied 5 fixes:
- `ValidatorService:1098,1237,2834` — wrap `l2RpcUrl` in `redactRpcUrl()` before logging. RPC URLs can contain embedded basic-auth secrets (`https://:SECRET@host/`); previously logged plaintext.
- `actions.ts:402,1271,1781` — three full-error-object logs replaced with `message + code` only. Stack traces leak file paths and internal context without aiding triage.

**Dependency CVE audit** — 28 client vulns / 81 solidity vulns enumerated in `docs/DEPENDENCY_AUDIT_2026-05-13.md`. `npm audit fix` recommended; not applied in this pass (risk of breakage without focused testing).

**Migration safety audit** — `docs/MIGRATION_AUDIT_2026-05-13.md`. Two would-break-prod patterns documented in already-applied migrations; forward-looking checklist for future migrations.

## ⏳ Still open (deliberate or design-needed)

- **F1** (CRIT) — JWT/Bearer token in `localStorage`. Needs migration to HttpOnly cookie. Design-needed, not a one-line fix.
- **F3** (HIGH) — DM private keys stored as plaintext hex in `localStorage`. Needs wrapping under the session-encryption layer; affects DM bootstrap UX (unlock-on-cold-start). Defer to a focused DM-security pass.
- **F6** (MED) — Decrypted DM keys in-memory Map across tabs without zeroing on logout. Lower-impact follow-up.
- **V1** (CRIT-adjacent) — ZK proof cache key not bound to submission context. Needs careful thought to avoid breaking the ZK happy path.
- **V3** (HIGH, slashing) — Archive chain not verified before `submitReplication`. Needs a deployment-config hash to compare against.
- **V4** (HIGH, slashing) — LayerZero fee buffer 120% → 150%+. Trivial to apply but worth measuring against actual fee variance first.
- **V5/V6** (HIGH, uptime) — Cawonce dedup indexer-lag-dependent + mixed-batch re-simulation. Touches the hot submission path; needs careful handling.
- **C3** (MED) — AES-GCM without AAD on DM/session encryption. Defense-in-depth; add when next touching that code.
- **API #6** (MED) — `dm-groups.ts:117` actor pattern — verified clean on re-read.

Remaining contract change carryover: none. The single mandatory pre-deploy change for v1 (ERC-1271 in `registerSession`) is applied.

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

**6. `reports.ts:61` — reporter id read from `req.body` and defaults to 0 on miss** — **PARTIALLY APPLIED**
The `: 0` fallback was dead code (`requireAuth` returns 400 before the handler if reporterId is missing). Removed the misleading fallback. The body-field pattern itself is safe because `requireAuth({ field: 'reporterId', verifyOwnership: true })` validates the body-supplied reporterId against the authenticated session's tokenIds — see verified-clean note on (7).

### MEDIUM

**7. `dm-groups.ts:117` — DELETE member uses `actorUserId` from req.body** — **VERIFIED CLEAN**
After reading `requireAuth` in `middleware/auth.ts:39-58`, the `field: 'actorUserId'` setting reads the body value, then checks it against `req.sessionData.authorizedTokenIds`. So the body-supplied actorUserId MUST be one the caller has a session for. The pattern is fine. False alarm in the agent's first pass.

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

## Frontend (React + Vite)

### CRITICAL

**F1. JWT/Bearer token in plain `localStorage`** — `MessageSearch.tsx:46`
`localStorage.getItem('token')` used as Authorization header without any wrapper encryption. XSS = full account takeover.
**Fix:** move auth to HttpOnly cookie. If localStorage is unavoidable, encrypt at rest under a session-derived key.

**F2. Open redirect via OAuth `returnTo`** — `AccountSettings.tsx:243, 250`
`window.location.href = res.url` after a backend hop that takes a `returnTo` query param. Unvalidated.
**Fix:** allowlist the redirect URL (same-origin only, or a small allowlist of trusted external destinations).

### HIGH

**F3. Unencrypted DM private keys in `localStorage`** — `DmCryptoService.ts:27, 34-35`
Comment says encrypted; actual storage shape is `{[tokenId]: {privateKey: "..."}}` in plaintext hex.
**Fix:** wrap keys under the QuickSign session-encryption layer before persistence, or move to IndexedDB with the same encryption.

**F4. Unguarded `JSON.parse(localStorage.getItem(...))` in 6+ places** — `FeedItem.tsx:977, 989, 2246, 2248, 2270, 2290, 2334`, plus `ProfileChooser.tsx`, `PostMintOnboarding.tsx`, `PostForm.tsx`
A malformed localStorage entry (corruption, another tab, dev tooling) crashes the parsing path.
**Fix:** wrap each parse in try/catch with a safe default.

### MEDIUM

**F5. `credentials: 'include'` cross-origin assumption** — `client.ts:198` and admin paths
Pattern relies on server-side CORS being strict. Verify server doesn't allow `*` with credentials.

**F6. Decrypted DM keys live in an in-memory Map** — `sessionKeyEncryption.ts:79-159`
No memory zeroing on logout/tab close. BroadcastChannel sync between tabs sends plaintext (same-origin, but visible to all tabs).
**Fix:** clear the Map on logout; consider memory-only for keys above a security threshold.

## Validator service

### CRITICAL (slashing-adjacent)

**V1. ZK proof cache key isn't bound to submission context** — `ValidatorService/index.ts:57`
Cache key = `keccak256(packedActions || packedSigs)`. Proof is consumed only on submission success; failed-then-retry paths can pair a cached proof with an unrelated batch under specific timing.
**Fix:** include validatorId + quote hash in the cache key, or move to TTL-based eviction with no in-flight consumption.

### HIGH (slashing-adjacent)

**V2. Withdraw quote cache reuses stale quotes** — `index.ts:1126-1127`
Cache key based on sorted tokenIds/amounts; doesn't capture timestamp. LayerZero fees shift rapidly during congestion; a stale-but-cache-key-matching quote underestimates gas and the submission reverts.
**Fix:** TTL of 5-10s on the cache plus a hash of the LZ-fee read.

**V3. Archive chain isn't verified before `submitReplication`** — `index.ts:3566-3572`
If DNS/RPC routing is hijacked, the validator could stake on a rogue archive that drains them.
**Fix:** verify `chainId` and a hash of the archive's deployment config before each submission.

**V4. LayerZero fee buffer is 120%** — `index.ts:3996`
Under congestion the actual cost can exceed the buffer, the challenge relay fails, and the fraudulent submission finalizes unchallenged.
**Fix:** raise to 150%+ or implement a retry that tops up the fee.

### HIGH (uptime, not slashing)

**V5. Cawonce dedup relies on indexer lag budget** — `index.ts:283`
Long indexer outage = legit retries get marked failed even though they landed on-chain.
**Fix:** direct on-chain check (`checkpointClaimed`) as primary, indexer as fast path.

**V6. Mixed batch failures don't re-simulate non-cawonce errors** — `index.ts:2236`
Audit fix `ef08a8b` only handles "Cawonce already used"; mixed batches with other errors still mass-fail.
**Fix:** for any permanent-failure path, re-simulate individual entries to distinguish transient (awaiting_indexer) from real failures.

### MED

**V7. Nonce desync risk in parallel multi-client submissions** — `index.ts:1369`
`getTransactionCount('pending')` is read per sub-batch; if sub-batches submit in parallel, they all get the same nonce.
**Fix:** local nonce counter, or serialize submissions across clients.

**V8. Withdrawal validation is contract-only** — `index.ts:1107`
Defense-in-depth: validator could pre-check `senderId == ownerOf(tokenId)` before including a WITHDRAW in a batch.

**V9. Gas estimation ignores calldata size** — `index.ts:1350-1352`
Large `text` fields can blow up calldata costs; static `base + perAction*count` formula underestimates.
**Fix:** add `16 * calldataLength` to the formula.

### LOW

**V10. `console.error(submitErr)` logs full error objects** — `index.ts:2525, 4145`
Stack traces, transient state, RPC URLs. Operational-security smell; not a key-leak.

**V11. `triggerImmediateValidatorPoll` has no caller-auth check** — `index.ts:223`
Any module that imports it can wake the poller. Probably fine in practice (admin route gates it) but worth confirming.

## Crypto primitives

### CRITICAL (FIXED in this pass)

**C1. `shorturl.ts:54` — `generateShortCode` uses `Math.random()`** — **FIXED 2026-05-13**.
Replaced with `randomBytes` and modulo-bias rejection sampling. 6 base62 chars → 35.7 bits if uniform; old `Math.random()` was likely worse due to PRNG state recovery, and the public `GET /api/shorturl/:code` endpoint is enumerable.

### HIGH (FIXED in this pass)

**C2. `scheduled.ts:88` — threadId uses `Math.random()` suffix** — **FIXED 2026-05-13**.
Replaced with `randomBytes(6).toString('hex')`. Attacker knowing `userId` and approximate `Date.now()` could no longer enumerate. ThreadIds are used for batch operations like "cancel all chunks of a thread."

### MED

**C3. AES-GCM without AAD in DM and session-key encryption** — `DmCryptoService.ts:291-295`, `sessionKeyEncryption.ts:47-50`
Per-peer key separation mitigates ciphertext-shuffling; add `additionalData: conversationId` for defense-in-depth.

### Clean

Session/admin tokens use `randomBytes(32)`. JWT verification rejects `alg:none`. Signature verification uses `ethers.verifyMessage` / `verifyTypedData`. DM IVs use `crypto.getRandomValues(12)`. PBKDF2 uses 100,000 iterations. Admin password comparison uses `timingSafeEqual` on SHA-256 digests. No hardcoded secrets in source.

## Smoothness fix applied in this pass

**S6 (fixed).** Free-action rate limiter moved from in-memory Map to Redis (`client/src/api/freeActionRateLimit.ts`). The previous in-memory version had effective limit = `N × 30/min` for `N` worker processes — bypassable by spreading requests. Redis-backed `INCR + EXPIRE` is atomic and shared across workers.

## Recommended next steps

1. **CRITICAL / HIGH that need code changes:**
   - withdrawals.ts auth (CRIT)
   - admin-db field allowlist + DELETE audit (CRIT × 2)
   - tips routes auth + reports.reporterId fix (HIGH × 3)
   - Frontend JWT cookie migration (CRIT)
   - DM-key encryption at rest (HIGH)
   - OAuth returnTo allowlist (CRIT)
   - ZK proof cache key tightening (CRIT)
   - Archive chain verification before replication submit (HIGH)
2. **Index migration:** the 4 new + 2 dropped composites land in one Prisma migration.
3. **Operational:** LayerZero fee buffer → 150%, nonce serialization in validator, indexer-aware cawonce dedup.
4. **Defense-in-depth:** AAD on DM/session AES-GCM; file-magic-byte validation in upload; in-memory key zeroing on logout.

Two fixes applied in-place this pass: shorturl PRNG, scheduled.ts threadId PRNG, free-action rate limiter to Redis.
