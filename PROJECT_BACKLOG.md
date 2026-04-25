# CAW Protocol — Project Backlog

Outstanding TODOs, security considerations, and planned features. Each entry has enough context for an agent (or human) to pick it up cold.

---

## Smart Contracts

### Mint flow — three modes (frontend work)

The `mintSelector` / `mintAndUpdateOwners` plumbing is intentionally kept as latent capacity (see comments in `CawProfile.sol:44-50` and `CawProfileL2.sol:280-289`). Once mainnet contracts ship they're immutable, so removing the wiring would lock us out of a flow we might want.

**Current state worth knowing:**
- `mintAndDeposit` (cross-chain) sends `depositAndUpdateOwners`, which sets `ownerOf[tokenId]` on L2 but **does NOT set `usernames[tokenId]`** on L2. L2's `usernames[]` mapping is currently dead in cross-chain mode — the only writer (`mintAndUpdateOwners`) is never reached. `getTokens()` returns an empty string for `username`, but the backend doesn't read it (FE/backend pull username from L1's `usernames[]`). So no live bug, but the field is misleading.
- Pure `mint()` doesn't lzSend at all → L2 doesn't even know the token exists.

- [ ] **Mint UI: three explicit modes** (frontend)
  - **Mint + deposit** (current default, uses `mintAndDeposit`) — pays mint + deposit + auth fees, CAW usable immediately.
  - **Mint + authenticate (no deposit)** — pays mint + auth fees, registers the token with the chosen client without depositing CAW yet. Closes the awkward gap where a freshly-minted token can't receive internal CAW transfers from another token until *something* tells L2 it exists. Needs a new L1 path (`mintAndAuthenticate`?) that mints and lzSends in one call. Either selector works:
    - Reuse `authSelector` (`authenticateAndUpdateOwners`): minimal change, but L2 still doesn't learn the username at this step (matches current `mintAndDeposit` behavior).
    - Use the parked `mintSelector` (`mintAndUpdateOwners`): also pushes the username to L2 so `getTokens().username` finally returns something useful in cross-chain mode.
  - **Mint only** — pays mint fee only. Token exists on L1 (marketplace/identity); L2 has no record. User authenticates later when they're ready to use the platform.
  - Tooltip explains the fee for each mode.
  - **Side question**: do we want L2 usernames populated for non-co-deployed setups? If yes, `mintSelector` is the right path forward; if not, the L2 `usernames[]` mapping should probably be removed in a future deploy to avoid the misleading empty-string field in `getTokens()`.

---

## Security & Pre-Launch

### LZ DVN 3-of-3 config — verify before mainnet

**Status:** Implemented in `solidity/scripts/deploy.js` phase 6 (and `solidity/scripts/lz-dvn-config.js`). Runs automatically on mainnet deploys; testnet intentionally uses LZ defaults.

**Config:** 3-of-3 required DVNs across every cross-chain pathway (CawProfile ↔ CawProfileL2_L2, CawProfile ↔ CawProfileL2_L2b, CawChallengeRelay_L2 → CawActionsArchive_L2b):

- LayerZero Labs
- Nethermind
- Google Cloud

DVN addresses are per-chain, pulled from LayerZero's metadata API on 2026-04-24. Send and receive sides of each pathway use the same provider identity set, protecting against the "DVN mismatch" pitfall LZ's docs warn about.

**Pre-mainnet checklist:**

- [ ] Re-pull DVN addresses from `metadata.layerzero-api.com/v1/metadata/dvns` right before mainnet deploy and diff against `scripts/lz-dvn-config.js::DVNS_BY_CHAIN_MAINNET`. If LZ moves an address, our hardcoded value is stale.
- [ ] Verify send/receive library addresses (`LZ_LIBRARIES_MAINNET`) haven't been rotated — run `endpoint.defaultSendLibrary(destEid)` / `defaultReceiveLibrary(destEid)` for each pathway and confirm they match what the script uses.
- [ ] After mainnet deploy, for each of the 6 pathways, call `endpoint.getConfig(oapp, library, destEid, 2)` and assert the on-chain `requiredDVNs` array is sorted ascending and contains exactly the 3 expected addresses.
- [ ] Send one test cross-chain message and observe all 3 DVNs sign before delivery.
- [ ] Renounce the ability to alter `setConfig` for each OApp (or move to multisig) once verified — otherwise a compromised deployer key can downgrade the DVN set.

### Admin/owner abilities — verify before mainnet

**Core lockdown is DONE** via the `OnlyOnce` pattern (`solidity/contracts/OnlyOnce.sol`). All protocol-critical setters are gated by `onlyOnce(key)` and permanently disabled after their first successful call:

- `CawProfile.setMinter`, `setUriGenerator`, `setL2Peer` (per-eid), and now also raw `setPeer` (per-eid)
- `CawProfileL2.setL1Peer`, `setCawActions`, raw `setPeer` (per-eid)
- `CawActionsArchive.setPeer` (per-eid) — newly added
- `CawChallengeRelay.setPeer` (per-eid) — newly added
- `CawClientManager.setCawProfile`

Strictly stronger than `renounceOwnership()` because it's per-setter and doesn't need a separate "remember to renounce" step.

The inherited `OAppCore.setPeer(uint32, bytes32)` was the dangerous one — `public virtual onlyOwner`, would have let a compromised owner swap an existing peer at any time and forge LZ messages. Now overridden in every OApp-extending contract with a per-eid `onlyOnce` so existing peers are immutable forever; new chains can still be added by setting peers for fresh eids. (Commit `3c445c0`.)

Intentionally unlocked (operational, not protocol-critical):

- `CawClientManager` per-client fee setters — controlled by each client's owner, not the protocol owner. By design.
- `OAppCore.setDelegate` — not virtual (can't override). Handled by the multisig/renounce step in the deploy checklist instead.

Removed entirely:

- `CawProfileMarketplace` ownership + `setAllowedPaymentToken` — the marketplace no longer inherits `Ownable`. The allowed-payment-token set is now fixed at construction (per-env list passed by deploy.js: WETH/USDC/USDT on mainnet plus per-env CAW). ETH is always allowed. To change the set, deploy a sibling marketplace.

**Pre-mainnet checklist:**

- [ ] Deploy runs all `onlyOnce`-gated setters once in `deploy.js` (verify none are missed).
- [ ] Spot-check each locked setter post-deploy by calling it again and confirming `"OnlyOnce: already called"` revert.
- [x] **Marketplace has no admin (done 2026-04-25)** — `CawProfileMarketplace` no longer inherits `Ownable`; payment-token list fixed at construction.
- [x] **Delegatecall audit (done 2026-04-25)**: only two delegatecall sites in the codebase (`CawProfile._lzReceive`, `CawProfileL2._lzReceive`); both call `address(this).delegatecall(...)` (target is self, not user-controlled), behind a whitelisted-selector check, behind OApp's endpoint+peer auth, with `fromLZ` flag flipped on success only. Selector collisions against all inherited functions (Ownable / ERC721 / ERC721Enumerable / OApp / OAppCore) checked and ruled out. No further action needed.

---

## Replication & Testing

### End-to-end replication tests — mostly covered

The replication path was rewritten as the optimistic archive + trustless `CawChallengeRelay` (commit `b536eae`); the old LZ-based `CawActionsReplicator` is gone.

**Already tested:**

- **Real archive submissions.** `solidity/test/archive-test.js` covers `submitReplication`, finalization after challenge period, deposits / withdraws, pending-submission gating, multi-submission invalidation on slash.
- **Mode B (mismatched root) slashing on chain.** `archive-test.js` covers full-stake slashing on fraud, all-pending-submissions invalidated when one is slashed, false-challenge rejection.
- **Mode A and Mode B in production.** `ValidatorService` has built-in `CORRUPT_REPLICATION=true` + `CORRUPT_MODE=A|B` test selectors (`index.ts:2097-2143`). Mode A corrupts the merkle root → monitor catches it via `slashIncoherentRoot`; Mode B corrupts the rebuild path → `slashFraud` via merkle proof. Both have been exercised end-to-end on testnet.
- **`slashIncoherentRoot` path** (added 2026-04 / `a9b51e5`) — exercised live by the corrupt-validator test rig.
- **Live testnet challenge flow.** `solidity/scripts/test-slash.js` runs the full path: deposit stake on L2b → submit bad data → relay correct hash via `CawChallengeRelay` on L2 → wait for LZ delivery → `resolveChallenge` on L2b → verify slashed.

**Still missing:**

- [ ] **Mode A unit test** in `archive-test.js`. Mode A is exercised live but not in solidity unit tests; adding a `slashIncoherentRoot` test alongside the existing `slashFraud` ones would let CI catch regressions without needing testnet.

### Stale test cleanup

- [ ] `solidity/test/multi-layer-test.js` references `migratePartialCheckpoint` (and possibly other removed functions). Either rewrite against the current architecture or delete in favour of new tests written for the optimistic archive flow.

---

## Frontend

### UX — features not started

- [ ] **Image modal** (`client/src/services/FrontEnd/src/components/FeedItem.tsx:966, 994, 1022`)
  - Comment: `// TODO: Open image in modal`
  - Clicking on post images should open a full-size modal.

- [ ] **Real gas price** (`client/src/services/FrontEnd/src/components/GasPriceLine.tsx:12-15`)
  - Currently hardcoded `const ethPrice = 1`.
  - ETH price IS already tracked by `ChainSyncService` (`usdPerEth` cached, `chainData` updated every 5 min). Frontend just needs to consume it via the `chainData` API.

- [ ] **Reported content moderation (EXPLICIT / REMOVED)** — IN PROGRESS
  - **Done**: report modal sub-options (Explicit vs Illegal/Harmful), reason filtering on admin dashboard, success confirmation screen, duplicate reports update instead of 409.
  - **Still needed**:
    - Add `moderation` enum field (`NONE | EXPLICIT | REMOVED`) to `Caw` model and migration.
    - `PATCH /api/caws/:id/moderation` endpoint, `requireAdmin`.
    - `shapeCaw` / `getCawIncludeConfig`: pass moderation through, blank content for `REMOVED` server-side.
    - `FeedItem`: `EXPLICIT` shows blurred overlay with click-to-reveal; `REMOVED` shows stub ("This caw was removed from this domain. It still exists on chain through the CAW protocol.") with no action buttons.
    - Propagation: explicit/removed status applies to quoted/recawed parents automatically via nested includes.
    - Admin row buttons: "Mark Explicit", "Remove Post", "Clear Moderation".

- [ ] **Operator-level user removal (transparent extension of REMOVED moderation)**
  - When a client operator decides a user is bad-faith (illegal content, sustained spam, repeated hate speech), they can remove that user **from this client only**. The user is told. Their on-chain content is unaffected and remains visible from any other client.
  - This explicitly *replaces* the originally-considered "shadow banning" feature. Shadow banning hides content silently from the banned user, which is deceptive and operator-asymmetric — it's the kind of moderator power the protocol's transparency ethos is designed to make hard. Hard, transparent removal is the same enforcement capability without the deception.
  - DB: `User.removedFromClient: Boolean` (per-instance, not synced across clients).
  - API: when querying feed/search/trending/suggested-users, filter out users with `removedFromClient = true`. The user themselves still sees their own posts (so they can move to another client without surprise) and gets a banner: *"You've been removed from this client. Your content is still on-chain — try connecting through a different domain."*
  - Reuses the existing `REMOVED` moderation render-stub pattern for the user's posts when seen from this client by other users.
  - Admin UI to manage removed users (extend ReportsAdmin page).
  - Block + mute already cover the per-user "I don't want to see X" case; this is purely about operator-level enforcement.

- [ ] **Tip ceiling exceeded warning**
  - Quick Sign sessions store a `tipCeiling`. The autonomous signing path uses `min(currentMarketTip, ceiling)`, so the user is never charged more than agreed. If validator network's market tip rises above the ceiling, actions still get signed (with the ceiling) but may be rejected.
  - **What's needed**:
    1. Hook that periodically compares `getCurrentMarketTip()` to active session's `tipCeiling`.
    2. Non-blocking banner near the top of MainLayout when underpriced: *"Quick Sign tip ceiling ($X) is below the current network rate (~$Y). Posts may be slow or rejected. [Renew Quick Sign]"*
    3. On all-validator rejection: explicit modal: *"All validators rejected your action because your tip is too low. Renew Quick Sign with a higher ceiling?"*
    4. `QuickSignRenewModal` opens with ceiling preset to `currentMarket × 3`.
  - **Why deferred**: the cap protection itself ships; this UX polish is only needed once validators actually raise tips significantly. Wait for real-use signal.

- [ ] **English auction "stuck" recovery UX (frontend)**
  - **Status**: contract-side mostly resolved. As of `db84bf7`, `cancelListing` works on English auctions even with active bids — the seller can back out cleanly and the bidder is refunded automatically. `reclaimBid` remains as a public safety valve for the rare case where the seller transferred the NFT away and won't act.
  - **Frontend work still needed**:
    - "Cancel auction" button on the seller's own active English auctions, even when there's a highest bidder. Confirmation dialog explains the bidder will be refunded.
    - Detect "seller no longer owns NFT" stuck state by checking `cawProfile.ownerOf(tokenId) === listing.seller`. If false, surface the banner to the highest bidder: *"This auction can no longer be settled — the seller transferred the NFT away. [Reclaim your bid]"* (calls `reclaimBid`).
    - Make the pull-pattern `withdrawBid` flow discoverable for previously outbid bidders.
    - Optional: public "stuck listings" view across the marketplace with a public Reclaim button (self-healing).
  - **Backend**: optional — `MarketplaceIndexerService` could set a `stuck` flag on the listing record so the FE doesn't hit the chain on every page load. Lower priority now that the seller has a proactive cancel path.

---

## Backend Services

### Validator Mesh Network — partly done

**Already in place:**

- **On-chain instance registry**: `CawClientManager` emits `InstanceRegistered` / `InstanceUpdated` events carrying each instance's `apiUrl` and `validatorAddress`. `InstanceRegistryService` auto-registers the local instance on startup, so any node coming online broadcasts itself.
- **Frontend host failover with reputation**: `useInstanceStore` reads the registry and exposes `getApiHosts()`; `apiFetch` walks that list in response-time-priority order; `useHostVerification` records failures and blacklists hosts that serve unverified posts. 5xx errors trigger automatic failover; 4xx don't (correct semantics).
- **DM relay across instances**: `DmRelayService` reads the same registry, fans out incoming DMs to peer instances via `POST /api/dm/relay` (fire-and-forget), so a conversation can happen across domains regardless of which instance each side connects to.

**Still missing:**

- [ ] **Validator-to-validator action gossip**. `relayDmToPeers` covers DMs but there's no equivalent for actions — the FE can fail over to a peer instance for *reading*, but action submission doesn't get gossiped between validators. Consequence: if a user submits to validator A and A goes down before broadcasting on chain, the action is lost; another validator can't pick it up. Add an `action-relay` route + service mirroring `DmRelayService`. Reuse the same on-chain registry + signed-payload pattern (`/api/dm/relay` already validates that the payload is signed by the sender's wallet, so no extra peer auth is needed). Dedup by `(senderId, cawonce)`.
- [ ] **Action submission resilience inside the FE**. When the user posts and validator A 5xx's, we currently fail the post — we don't retry on the next host. Mirror the read-side failover for action submission too (`api/actions.ts`).
- [ ] **Stale registry handling**. `useInstanceStore` and `DmRelayService` both query `InstanceRegistered` events from `fromBlock: 0` every refresh. Cache the last-scanned block per service so this scales as the registry grows.

### Validator Profitability Modeling

- [ ] **Optimal fee modeling and game theory analysis**
  - The data side is **done**: `ValidatorAnalytics.tsx` (admin route `/admin/validator-analytics`) tracks revenue, gas cost, profit, action breakdown, time-series — pulls from `ValidatorTx` rows written by `ValidatorService`.
  - **What's still needed**:
    - Document expected revenue vs costs across realistic activity levels (low / medium / high posting volume).
    - Recommend default fee/tip presets that keep validators net-profitable across typical usage.
    - Game-theory write-up: when does it pay to undercut? At what point does the network's tip-priority queue fail to clear?

### Daily CAW Distribution Display

- [ ] **"X CAW distributed to stakers today" widget**
  - Query `ActionsProcessed` events from last 24h, multiply by per-action issuance:
    - CAW post: 5,000
    - Like: 400
    - Recaw: 2,000
    - Follow: 6,000
  - Display:
    - "X CAW distributed to stakers today"
    - "Your earnings today: Y CAW" (user share of pool)
    - Historical chart of daily distributions
    - "Based on recent activity, stakers earning ~Z CAW/day"
  - **Note**: activity-based yield, not time-based APR — more like equity dividends. The HelpPage already explains the model in plain English; just need the live calculation surfaced.

### Price History Tracking

- [ ] **`PriceHistory` table for charts**
  - Currently `ChainSyncService` overwrites the latest price in `chainData`.
  - New table: `{ id, token (caw|eth), usdPrice, ethPrice, timestamp }`.
  - Insert a new row every sync interval (5 min) instead of just overwriting.
  - `GET /api/prices/history?token=caw&period=24h` for charting.
  - Frontend: price chart on staking page or sidebar.
  - Retention: 5-min granularity for 7 days, hourly for 90 days, daily forever.

### API & Worker Efficiency

- [ ] **Audit redundant RPC and DB calls across services**
  - Profile: ActionProcessor, RawEventsGatherer, ValidatorService, ChainSyncService, DataCleaner.
  - Look for:
    - Redundant chain reads, duplicate DB queries, over-polling
    - Missed batching (multicall, batch `getLogs`)
    - Cache opportunities (Redis) for stable chain data: token metadata, client configs, gas prices
    - Overlapping work between services reading the same contract state
    - N+1 queries, missing indexes, over-fetching in Prisma includes
    - Reorg-induced reprocessing — debounce/throttle?
  - **Note**: `findOrCreateUser` in-memory cache landed 2026-04-24 (`UserService.ts:198`). Same "burst of N parallel lookups for the same key" pattern likely exists elsewhere and is worth hunting.

### Infrastructure

- [ ] **Document all deployed contract addresses**
  - Many addresses marked TBD in docs.
  - Update after each deployment so client config and indexers stay in sync.

- [ ] **Multi-chain storage support** — see `docs/MULTI_CHAIN_STORAGE.md` for the full plan.
  - Contracts already accept any `storageChainEid` per client (`CawClientManager.createClient`); the off-chain runtime hardcodes Base.
  - Work splits into: deploy `CawActions` + `CawProfileL2` to a new chain, restructure `addresses.ts` as `addresses.<chain>.<symbol>`, parameterize chain-specific addresses in service configs, have the CLI read `storageChainEid` from `CawClientManager.getClient(clientId)` at install time and configure RPC + addresses per-client.
  - Don't touch this until there's a real driver (a client wanting to deploy to a non-Base storage chain). Indirection costs zero today; the abstraction is purely future-tense.
  - Same restructure unblocks the parallel "replication chain → archive contract address" map in `ValidatorService` (today there's one hardcoded `CAW_ACTIONS_ARCHIVE_ADDRESS`).

---

## Client Deployment CLI (`cli/`)

One-liner install: `curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash`

### Phase 1 — Interactive installer & process management — MOSTLY DONE

**Already implemented:**

- Node type selection step (`cli/src/steps/nodeType.js`)
- RPC URL collection (`rpcUrls.js`)
- Validator config (`validator.js`)
- Infrastructure config (`infrastructure.js`)
- Config generation (`generate.js`)
- Dependency install (`install.js`)
- Nginx setup (`nginx.js`)
- Process management commands wired up: `caw status`, `caw logs`, `caw restart`, `caw stop`

**Still missing in Phase 1:**

- [ ] Docker support — `docker-compose.yml` generation for PostgreSQL + Redis + app (optional)
- [ ] pm2 startup-on-boot integration (`pm2 startup`)
- [ ] Pros/cons guidance at each prompt — explain economics, replication tradeoffs, tip-amount tradeoffs

### Phase 2 — On-chain operations — NOT STARTED

- [ ] **Mint username** — walk through if user doesn't have a CawName (needs ETH + CAW on L1).
- [ ] **Register client** — submit `registerClient` transaction using validator PEM.
- [ ] **Check balances** — verify validator wallet has enough ETH for gas.
- [ ] **Buy CAW** — Uniswap integration for ETH→CAW swap if needed for staking/minting.
- [ ] **Authenticate** — submit L1→L2 authentication via LayerZero.
- [ ] **Register session key** — create and register a session key for the validator.

### Phase 3 — Management & operations — PARTIALLY DONE

**Already implemented:** `caw status`, `caw logs`, `caw restart`, `caw stop`.

**Still missing:**

- [ ] **`caw update`** — pull latest from GitHub, rebuild, restart
- [ ] **`caw config`** — edit configuration interactively
- [ ] **`caw domain`** — change domain, regenerate SSL
- [ ] **`caw api-priority`** — manage API endpoint discovery priority
- [ ] **`caw api-blacklist`** — block specific API endpoints
- [ ] **`caw uninstall`** — clean removal
- [ ] **`caw analytics`** — validator profitability, action throughput, gas costs (CLI surface for the data already in `ValidatorAnalytics.tsx`)

---

## Documentation

- [ ] **API documentation** — document all REST endpoints. Currently no `API.md`.
- [ ] **Deployment guide** — step-by-step deployment instructions. Currently no `DEPLOYMENT.md`.
- [x] **Client replication guide** — `solidity/docs/CLIENT_REPLICATION_GUIDE.md`
- [x] **Services documentation** — `client/src/services/SERVICES.md`
- [x] **Architecture docs** — `docs/ARCHITECTURE.md`, `docs/DATA_FLOW.md`, `docs/REPLICATION_AND_SLASHING.md`, `docs/VALIDATOR_MESH_NETWORK.md`, `docs/SESSION_KEYS.md`, `docs/MARKETPLACE.md`, `docs/DIRECT_MESSAGING.md`, etc. — extensive

---

## Resolved (since previous backlog snapshots)

- [x] **`OnlyOnce` lockdown of all protocol-critical setters** (2026-04-24)
- [x] **Old LZ replication path removed** (`CawActionsReplicator.sol` deleted, runtime callers gone, address removed from `client/src/abi/addresses.ts`; one stale test reference remains — see "Stale test cleanup")
- [x] **`gasLimitFor()` measured values** in `CawProfile.sol` and `CawProfileL2.sol` (from `solidity/scripts/measure-gas.js`); `CawActionsReplicator.RECEIVE_GAS_LIMIT` is moot — contract removed
- [x] **Permissionless `depositFor`** on `CawProfile.sol`
- [x] **Combined mint + stake transaction** — `mintAndDeposit` on `CawProfile.sol:157` and `CawProfileMinter.sol:45`, with quoter at `CawProfileQuoter.sol:75`
- [x] **Buy-offer system (OTC)** — `createOfferETH` / `createOfferERC20` / `acceptOffer` / `cancelOffer` on `CawProfileMarketplace.sol`; FE `MakeOfferModal` and `ViewOffersModal` wired up
- [x] **Withdraw fee floor locked at first authentication** (per `(clientId, tokenId)`) — clients can't retroactively raise fees on existing users; old "fee blocking attack" is no longer reachable
- [x] **LayerZero refund address resolved** — `CawProfile.lzSend()` refunds to `tx.origin` with comment explaining why (works through marketplace intermediaries)
- [x] **`reclaimBid` for transferred NFTs** — contract done; frontend UX still in the open list above
- [x] **XMTP integration removed entirely** — no DM service, no auth TODOs
- [x] **Short URLs after DB rebuild** — resolved by toggle in UI to choose current domain or not
- [x] **`useTokenDataUpdate` ETH-read TODO** — code cleaned up
- [x] **Delete posts** — implemented via on-chain `hide:caw:{cawonce}` action (`FeedItem.tsx:1660-1676`); the `hide` action handler in `actionHandlers.ts` flips the caw to `HIDDEN` status
- [x] **DM editing and deletion** — full backend (`Message.editHistory`, `MessageDeletion` model, edit/hide/delete endpoints in `dm.ts`) and frontend (`useDm.ts` decrypts edit history, etc.)
- [x] **Validator profitability data** — `ValidatorAnalytics.tsx` admin page tracks revenue, gas cost, profit, breakdown, time-series. Optimal-fee *modeling* still open (see Backend Services).
- [x] **`findOrCreateUser` in-memory cache + pulled out of interactive tx** (2026-04-24) — fixes `P2028` "transaction already closed" cascades when a batch of N actions from the same sender arrives in parallel
- [x] **GasPriceLine wired to real ETH price** (2026-04-25, `db84bf7`) — was hardcoded to `1` with three TODO comments; now reads from `usePriceStore` (already populated by `useFetchPrices` from `/api/prices`)
- [x] **Marketplace ownership removed** (2026-04-25) — see Security & Pre-Launch above for details
- [x] **`setPeer` once-per-eid lock + delegatecall audit** (2026-04-25, `3c445c0`)
- [x] **English auction `cancelListing` works with active bids** (2026-04-25, `db84bf7`) — refunds highest bidder automatically; seller no longer needs the transfer-NFT-away workaround
- [x] **`mintSelector` kept as latent capacity** (2026-04-25) — comments now explain it's reserved for a future "mint + authenticate (no deposit)" flow rather than the misleading `// TODO: this one not used`
- [x] **Stale `multi-layer-test.js` references** cleaned up (2026-04-25, by user)
