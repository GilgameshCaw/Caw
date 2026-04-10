# CAW Protocol - Project Backlog

This document tracks outstanding TODOs, security considerations, and planned features.

## Critical / Security

### High Priority

- [ ] **Fee blocking attack vector** (CawName.sol)
  - **Issue**: Could a client set stupidly high fees to block users from withdrawing?
  - **Location**: `CawName.withdraw()` calls `clientManager.getDepositFeeAndAddress()`
  - **Impact**: Users could be prevented from withdrawing if client sets extreme fees
  - **Suggested fix**: Add maximum fee caps or allow users to withdraw without client interaction
  - **Status**: Needs investigation

### Medium Priority

- [ ] **XMTP authentication disabled** (xmtp.ts)
  - **Issue**: Authentication is commented out on all XMTP endpoints
  - **Location**: `client/src/api/routes/xmtp.ts` (lines 53, 83, 140, 171, 196, 227, 429)
  - **Comment**: "TODO: Re-enable authentication after testing"
  - **Status**: Re-enable before production

- [ ] **XMTP wallet key management** (XmtpService/index.ts)
  - **Issue**: Using deterministic wallet seed for XMTP identity
  - **Location**: Line 194
  - **Comment**: "TODO: In production, use the user's actual wallet or secure key management"
  - **Status**: Needs proper key management solution

## Smart Contracts

### Gas Limits (Need Real Values) - HIGH PRIORITY

- [ ] **CawName.gasLimitFor()** (CawName.sol:529-542)
  - Current values are placeholders
  - Need to measure actual gas usage on testnet
  - Affects: `addToBalanceSelector`, `mintSelector`, `updateOwnersSelector`, `authSelector`, `setReplicationPeerSelector`

- [ ] **CawNameL2.gasLimitFor()** (CawNameL2.sol:325-335)
  - Current values are placeholders
  - Need to measure actual gas usage on testnet
  - Affects: `setWithdrawableSelector`

- [ ] **CawActionsReplicator.RECEIVE_GAS_LIMIT** (CawActionsReplicator.sol:45-50)
  - Currently set to 50,000 (should be sufficient for event-only archive)
  - Verify on testnet that LZ overhead + event emission stays under limit
  - If archive contracts do more than emit events, this needs to increase

### UX Improvements

- [ ] **Combined mint + stake transaction** (CawNameMinter.sol)
  - **Goal**: Let users mint a CawName and authenticate/stake to their chosen L2 + client in a single transaction
  - **Current flow**: `buy()` on L1, then separate `authenticate()` call with LZ fee
  - **Proposed**: Add `buyAndAuthenticate(name, clientId, lzDestId)` that does both in one tx
  - **Considerations**: `msg.value` = CAW cost + LZ fee; if LZ part fails, mint still succeeds (user retries auth only)
  - **Status**: Not started

### Marketplace

- [ ] **Buy Offers (OTC offer system)** (CawNameMarketplace.sol)
  - **Goal**: Allow anyone to make a buy offer on any username, even if it's not listed
  - **Contract changes**:
    - New `Offer` struct: `{ offerer, tokenId, paymentToken, amount, expiry, active }`
    - `createOffer(tokenId, paymentToken, amount, expiry)` — buyer escrows funds in contract
    - `acceptOffer(offerId)` — seller accepts, NFT transfers to buyer, funds to seller (one click)
    - `cancelOffer(offerId)` — buyer withdraws their escrowed funds before acceptance
    - `offers[]` mapping and `offersByTokenId[]` for lookup
    - Offers auto-expire after `expiry` timestamp; buyer can reclaim after expiry
    - Multiple offers can exist on the same tokenId (from different buyers or different amounts)
  - **Frontend**:
    - "Make Offer" button on any user profile page
    - Modal: choose currency, amount, expiry duration (1d, 3d, 7d, 30d)
    - Notification to the profile owner when they receive an offer
    - "Pending Offers" section on the marketplace "My Profiles" tab
    - One-click accept with approval check
    - Buyer can view and cancel their pending offers
  - **Indexer**: Index `OfferCreated`, `OfferAccepted`, `OfferCancelled` events
  - **API**: New endpoints for offers (list by tokenId, by buyer, by seller)
  - **Considerations**:
    - Offers are fully escrowed (funds held in contract) so acceptance is guaranteed
    - Seller must still own the NFT at acceptance time (check in `acceptOffer`)
    - If seller has an active listing, they should be able to accept an offer (cancels the listing)
    - 0% fee, consistent with marketplace philosophy
  - **Status**: Not started

- [x] **English auction safety: reclaimBid for transferred NFTs** (CawNameMarketplace.sol:324)
  - `reclaimBid(listingId)` implemented — callable by anyone if seller no longer owns NFT
  - **Frontend**: Still needs "Reclaim Bid" button UI (see BACKLOG.md UX section)
  - **Status**: Contract done, frontend UX pending

### Refactoring

- [ ] **Unused mintSelector** (CawName.sol:41)
  - Comment: "TODO: this one not used"
  - Either implement or remove

- [x] **depositFor function** (CawName.sol:286)
  - Permissionless `depositFor(clientId, tokenId, amount, lzDestId, lzTokenAmount)` implemented
  - Status: Done

- [ ] **LayerZero refund address** (CawName.sol:464-466)
  - Comment: "Should the msg.sender receive the refund instead?"
  - Currently refunds go to contract address
  - Need to decide on proper refund handling

## Frontend

### Features

- [ ] **Delete posts**
  - Allow users to delete their own posts
  - Needs contract-level support or soft-delete via API
  - UI: add "Delete" option to the post options menu (three dots)

- [ ] **DM editing and deletion**
  - Allow users to edit and delete their own direct messages
  - See detailed design notes below in [DM Edit/Delete Design Notes](#dm-editdelete-design-notes)

- [ ] **Reported content moderation (explicit / removed)** — IN PROGRESS
  - Admin can mark any post as `EXPLICIT` or `REMOVED` from the /admin/reports page
  - **Done so far**: Report modal sub-options for Explicit vs Illegal/Harmful, reason filtering in admin dashboard, success confirmation screen, duplicate reports update instead of 409
  - **Still needed**:
    - Add `moderation` field (enum: NONE, EXPLICIT, REMOVED) to Caw model + migration
    - Admin API endpoint `PATCH /api/caws/:id/moderation` (requireAdmin)
    - shapeCaw/getCawIncludeConfig: pass moderation field through, blank content for REMOVED posts server-side
    - FeedItem: EXPLICIT posts show blurred overlay with click-to-reveal gate; REMOVED posts show stub ("This caw was removed from this domain. It still exists on chain through the CAW protocol.") with no action buttons
    - Propagation: explicit/removed status applies to quoted/recawed parent posts automatically via nested includes
    - Admin buttons on report rows: "Mark Explicit", "Remove Post", "Clear Moderation"

- [ ] **Shadow banning**
  - Frontend-level content filtering for users flagged by admins/reports
  - Shadow-banned users can still post and interact, but their content is hidden from other users' feeds
  - The banned user sees no indication they've been banned (posts appear normal to them)
  - Applies per-frontend (consistent with manifesto — protocol is uncensorable, frontends moderate)
  - Admin UI to manage shadow-banned users (via ReportsAdmin page or similar)
  - DB: add `shadowBanned` boolean to User model
  - API: filter shadow-banned users' content from feed/search/trending endpoints
  - Exclude from suggested users, trending hashtags contributions, etc.

- [ ] **Image modal** (FeedItem.tsx:794, 819, 845)
  - Comment: "TODO: Open image in modal"
  - Clicking on post images should open full-size modal

- [ ] **Real gas price** (GasPriceLine.tsx:12-14)
  - Comment: "TODO: get real price"
  - Currently hardcoded `ethPrice = 1`
  - Need to fetch real ETH price from oracle/API

- [ ] **Read token data from ETH** (useTokenDataUpdate.tsx:84-86)
  - Commented out code references reading from Ethereum
  - Status: Unclear if still needed

## Backend Services

### Validator Mesh Network

- [ ] **Set up mesh network for action broadcasting**
  - **Goal**: Enable validators to broadcast actions to each other for redundancy and faster propagation
  - **Potential approach**: Use Evmos or similar chain for validator coordination
  - **Components needed**:
    - P2P networking layer (libp2p, WebRTC, or custom protocol)
    - Action gossip protocol (broadcast new actions to peers)
    - Peer discovery and management
    - Deduplication (prevent reprocessing same actions)
    - Authentication (verify peer validators)
  - **Benefits**:
    - Reduced latency for action propagation
    - Redundancy if one validator goes down
    - Decentralized action submission (users can submit to any validator)
  - **Considerations**:
    - How to handle conflicting actions (same cawonce from different sources)
    - Rate limiting to prevent spam
    - Incentive alignment for validators to participate
    - Evmos integration details (Cosmos SDK, IBC compatibility)
  - **Status**: Not started - needs further research

### Validator Profitability Analysis

- [ ] **Analyze and optimize validator economics**
  - Calculate expected revenue vs costs for running a validator
  - Determine optimal fee structures
  - Model validator incentives and game theory
  - **Status**: Not started

### Staking Pool Analytics

- [ ] **Track and display daily CAW distribution to stakers**
  - **Goal**: Show users how much CAW is being distributed to the staking pool
  - **Approach**: Query `ActionsProcessed` events from last 24h, calculate distribution based on action types:
    - CAW post: 5,000 CAW distributed
    - Like: 400 CAW distributed
    - Recaw: 2,000 CAW distributed
    - Follow: 6,000 CAW distributed
  - **Display options**:
    - "X CAW distributed to stakers today"
    - "Your earnings today: Y CAW" (based on user's share of pool)
    - Historical chart of daily distributions
    - "Based on recent activity, stakers earning ~Z CAW/day"
  - **Note**: This is activity-based yield, not time-based APR - more like equity dividends than interest
  - **Status**: Not started

### Price History Tracking

- [ ] **Store price history over time for charting**
  - Currently ChainSyncService overwrites the latest price in `chainData`
  - Add a `PriceHistory` table: `{ id, token (caw/eth), usdPrice, ethPrice, timestamp }`
  - Insert a new row every sync interval (5 min) instead of just overwriting
  - Add API endpoint `GET /api/prices/history?token=caw&period=24h` for charting
  - Frontend: price chart on staking page or sidebar showing CAW price over time
  - Retention policy: keep 5-min granularity for 7 days, hourly for 90 days, daily forever
  - **Status**: Not started

### XMTP Messaging System

- [ ] **Complete XMTP integration**
  - Re-enable authentication on all endpoints
  - Implement proper wallet key management
  - Test with production XMTP network
  - Add rate limiting
  - Add message persistence/caching

### API & Worker Efficiency

- [ ] **Minimize redundant RPC and DB calls across services**
  - Audit API routes and worker services (ActionProcessor, RawEventsGatherer, ValidatorService, ChainSyncService, DataCleaner) for redundant chain reads, duplicate DB queries, and unnecessary polling
  - Batch RPC calls where possible (multicall, batch getLogs)
  - Add caching layers (Redis) for frequently-read chain data that doesn't change often (token metadata, client configs, gas prices)
  - Deduplicate overlapping work between services (e.g. multiple services reading the same contract state independently)
  - Profile DB query patterns — look for N+1 queries, missing indexes, over-fetching in Prisma includes
  - Consider debouncing/throttling event re-processing on reorgs
  - **Status**: Not started

### Infrastructure

- [ ] **Contract address configuration**
  - Many contract addresses marked as TBD in documentation
  - Update after deployment

### Client Deployment CLI (`cli/`)

One-liner install: `curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash`

#### Phase 1 — Interactive installer & process management (IN PROGRESS)

- [ ] **Node type selection** — user picks what they want to run:
  - **Full node** (validator + API + frontend): earns tips, serves users, max decentralization. Needs validator PEM, client ID, RPC URLs, domain, PostgreSQL, Redis.
  - **Validator only**: earns tips but lower priority (not discoverable as a client). Needs validator PEM, RPC URLs. Minimal infra (no domain, smaller DB).
  - **Frontend + API** (no validator): serves users, reads chain, delegates action submission to external validators. Needs client ID, RPC URLs, domain, DB.
  - **Frontend only** (static site): just the React app pointed at an external API. No backend, no DB. Cheapest option.
  - **API only** (headless): serves data to other frontends. No validator, no public UI.
- [ ] **Guided config collection** — colored prompts for:
  - L1/L2 RPC URLs (with provider suggestions: Infura, Alchemy, public RPCs)
  - Validator private key (import PEM or generate new one)
  - Validator profile tokenId (enter username, CLI looks up tokenId)
  - Client ID (enter existing or explain how to register one)
  - Domain name and SSL (for API/frontend nodes)
  - Admin password
  - Validator tip amount (with explanation of economics)
  - API URL (if using external API instead of running own)
  - Database connection (PostgreSQL — Docker or existing)
  - Redis connection (Docker or existing)
- [ ] **Dependency installation** — based on node type:
  - Node.js 22, PostgreSQL, Redis (or Docker equivalents)
  - `npm install` / `yarn install`
  - Prisma schema push
- [ ] **Config generation** — produces `client/config.json` and `client/.env`
- [ ] **Process management** — pm2 for:
  - Start/stop/restart services
  - Auto-restart on crash
  - Log management
  - Startup on boot (`pm2 startup`)
- [ ] **Docker support** (optional) — `docker-compose.yml` generation for PostgreSQL + Redis + app
- [ ] **Pros/cons guidance** — at each decision point, explain tradeoffs:
  - Running a validator: earn tips, help process transactions, need ETH for gas
  - Running a frontend: help decentralize access, attract users
  - Replication chains: permanence vs gas costs
  - Tip amounts: higher tips = faster processing, but cost more per action

#### Phase 2 — On-chain operations

- [ ] **Mint username** — if user doesn't have a CawName, walk them through minting (requires ETH + CAW on L1)
- [ ] **Register client** — submit `registerClient` transaction on-chain using the validator PEM
- [ ] **Check balances** — verify validator wallet has enough ETH for gas
- [ ] **Buy CAW** — Uniswap integration to swap ETH for CAW (if needed for staking/minting)
- [ ] **Authenticate** — submit L1→L2 authentication via LayerZero
- [ ] **Register session key** — create and register a session key for the validator

#### Phase 3 — Management & operations

- [ ] **`caw status`** — show running services, uptime, pending txQueue count, validator earnings
- [ ] **`caw restart`** — restart all or specific services
- [ ] **`caw update`** — pull latest from GitHub, rebuild, restart
- [ ] **`caw config`** — edit configuration interactively
- [ ] **`caw logs`** — tail logs for specific services
- [ ] **`caw domain`** — change domain, regenerate SSL
- [ ] **`caw api-priority`** — manage API endpoint discovery priority
- [ ] **`caw api-blacklist`** — block specific API endpoints
- [ ] **`caw uninstall`** — clean removal of all CAW components
- [ ] **`caw analytics`** — validator profitability, action throughput, gas costs

## Testing

- [ ] **Gas limit testing**
  - Deploy to testnet
  - Measure actual gas consumption for each cross-chain call
  - Update gas limit constants

- [ ] **Replication testing**
  - Test with actual archive chain deployment
  - Verify historical migration works correctly
  - Test edge cases (max 4 destinations, removal, etc.)

## Documentation

- [x] **Client replication guide** - Created: `solidity/docs/CLIENT_REPLICATION_GUIDE.md`
- [x] **Services documentation** - Created: `SERVICES.md`
- [ ] **API documentation** - Document all REST endpoints
- [ ] **Deployment guide** - Step-by-step deployment instructions

## Design Notes

### DM Edit/Delete Design Notes

#### Philosophical Context

The CAW manifesto establishes that **public protocol data is permanent and censorship-resistant**: "All data will be stored permanently," "no username or message will be blocked or quarantined," and contracts are deployed with renounced ownership so no one can alter the public record.

However, DMs occupy a fundamentally different architectural and philosophical space:

- **The manifesto explicitly separates DMs from public actions** (section vii): "DM's should be 'free' and executed via a trustless handshake between two accounts to enable secure peer-to-peer messaging."
- **DMs are not on-chain.** They are E2E encrypted, relay-based, and stored in the client database — not archived to multiple chains like public posts.
- **DMs are private speech between two people**, not public speech that the protocol exists to protect from censorship.
- **The immutability guarantee exists to prevent external censorship**, not to prevent two consenting parties from managing their own private conversation.

Therefore, edit and delete functionality for DMs is philosophically consistent with the protocol's values, provided it is implemented transparently.

#### Edit Messages — Design

**Allow editing with full transparency.**

- **Time limit: 15 minutes** after sending. After that, the message is locked. This prevents weaponized editing (e.g., changing a message days later to gaslight someone about what was said) while still allowing corrections for typos and mistakes.
- **"Edited" indicator**: All edited messages display a visible "(edited)" label next to the timestamp. This is non-negotiable — transparency is core to the protocol's ethos.
- **Edit history visible to both parties**: Either participant can tap/click "(edited)" to see the full history of what the message originally said and when it was changed. Since messages are E2E encrypted, only the two participants can see this history anyway.
- **No silent edits**: The recipient receives a notification or visual indicator that a message was edited, even if they weren't looking at the conversation at the time.

**Implementation approach:**
- Add an `editHistory` JSON field to the `Message` model (or a related `MessageEdit` table) storing `{ content: string, editedAt: DateTime }[]`.
- The `encryptedPayload` field on the Message row gets updated to the new content. The old content is moved into the edit history (also encrypted with the same shared secret).
- API endpoint: `PATCH /api/dm/messages/:messageId` with the new encrypted payload. Server validates that the sender owns the message and that it's within the 15-minute window.
- Frontend: show "(edited)" badge, with a popover/modal showing history on click.

#### Delete Messages — Design

**Two distinct operations with different behaviors.**

##### "Delete for me" (local hide)
- Always available, no time limit.
- The message is hidden from the deleting user's view only. The other participant still sees it.
- This is a pure UI/privacy operation — the user just doesn't want it in their own view.
- Implementation: Add a `deletedByUsers` array or a `MessageDeletion` join table tracking which users have hidden which messages. Filter these out when fetching conversation history for that user.

##### "Delete for everyone" (mutual delete)
- **Time limit: 5 minutes** after sending. This is intentionally shorter than the edit window because deletion is more drastic — it removes the record rather than amending it.
- **Tombstone message**: When a message is deleted for everyone, it is replaced with a tombstone: "[Message deleted]" with the timestamp preserved. The other party knows something was there. This prevents the unsettling experience of messages silently vanishing from a conversation and maintains conversational context.
- The encrypted payload is wiped from the database. Edit history (if any) is also wiped. Only the tombstone metadata remains.
- **No deletion of the other person's messages**: You can only delete messages you sent.

**Implementation approach:**
- "Delete for me": `POST /api/dm/messages/:messageId/hide` — creates a `MessageDeletion` record for the requesting user. No data is actually removed.
- "Delete for everyone": `DELETE /api/dm/messages/:messageId` — server validates ownership and 5-minute window. Sets `encryptedPayload` to null, `contentType` to `"deleted"`, clears edit history. The message row persists as a tombstone.
- Frontend: "Delete for me" option always available. "Delete for everyone" only shown within the time window. Tombstoned messages render as a gray italicized "[Message deleted]" row.

#### What NOT to support

- **No "unsend" that silently removes all trace.** This conflicts with the transparency principle. If you said something, the other person at minimum knows a message existed.
- **No editing after 15 minutes.** If you need to correct something after that, send a follow-up message. Long edit windows create trust problems.
- **No bulk delete.** Deleting an entire conversation for the other person is too aggressive. "Delete for me" (hiding the whole conversation locally) is fine; "delete for everyone" operates message-by-message within the time window only.
- **No admin/moderator message deletion.** There is no server-side moderation of DMs. The relay stores encrypted payloads it cannot read, and only the two parties can manage their own messages.

#### Database Changes Required

```
// Add to Message model:
contentType    String    @default("text")   // existing — add "deleted" as a type
editHistory    String?                       // encrypted JSON array of previous versions

// New model:
model MessageDeletion {
  id        Int      @id @default(autoincrement())
  messageId String
  userId    Int
  deletedAt DateTime @default(now())
  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([messageId, userId])
  @@index([userId])
}
```

#### API Endpoints Required

- `PATCH /api/dm/messages/:messageId` — Edit message (within 15min, sender only)
- `POST /api/dm/messages/:messageId/hide` — Delete for me (any time, either party)
- `DELETE /api/dm/messages/:messageId` — Delete for everyone (within 5min, sender only)

#### UI/UX Notes

- Long-press (mobile) or right-click (desktop) on a message to show context menu with Edit / Delete options.
- Edit: inline editing in the message bubble, with Save/Cancel buttons.
- The "(edited)" label should be subtle (smaller, muted color) but always visible.
- Edit history popover: simple chronological list showing each version with its timestamp.
- Tombstoned messages should be clearly distinct from regular messages (e.g., gray italic text, no bubble background) so they don't look like real content.
- Time-limited actions should show remaining time in the context menu (e.g., "Delete for everyone (3m left)") to set expectations.

---

## Completed Items

- [x] Refactor CawClientManager to not be an OApp (route through CawName)
- [x] Make CawActionsReplicator ownerless after deployment
- [x] Fix replicationQuote to return 0 instead of reverting when no replication
- [x] Add historical migration support
- [x] Create client replication documentation

---

*Last updated: 2026-04-10*
