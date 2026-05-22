# CAW Protocol — White Paper

*A trustless and decentralized social clearing-house.*

---

## Foreword

CAW began without a developer, without official socials, and without a roadmap. A contract was deployed, and a community formed around it. What follows is not the story of a startup; it is the specification for a public utility — one that, once deployed, no party can shut down, fee-extract, censor, or upgrade against its users.

The CAW manifesto (reproduced verbatim in Appendix E) was written years before the implementation described here. The protocol's job is to make the manifesto's claims true in code, not in slogan. Where this paper describes a mechanism — renounced ownership, calldata as the source of truth, the optimistic archive's two-day challenge window, the ETH-denominated cost cap — the claim is that the deployed contracts enforce it without trust in any party, including the people who deployed them.

This paper is for the reader who wants to verify rather than be told. Every constant has a source-file citation. Every cryptographic choice has a reason. Every assertion about durability or censorship-resistance reduces, by the end, to an on-chain fact.

---

## Table of Contents

1.  Abstract
2.  The Problem
3.  Design Principles
4.  Architecture
5.  The Action Lifecycle
6.  Cryptography & Identity
7.  Economics
8.  Optimistic Archive & Slashing
9.  Threat Model
10. The Mesh: Multi-Network, Multi-Mirror, Multi-Chain
11. Governance by Renunciation
12. Comparison & Positioning
13. Roadmap

Appendix A — Glossary
Appendix B — Contract Inventory
Appendix C — Constants Reference
Appendix D — Action Types & Cost Table
Appendix E — The Manifesto
Appendix F — Further Reading

---

# 1. Abstract

CAW Protocol is a fully on-chain social network. Every user action — a post, a like, a follow, a tip — is an EIP-712-signed message that becomes part of the durable record of an L2 blockchain. Identity is an ERC-721 NFT minted on Ethereum mainnet by burning CAW tokens. The supply of usernames is bounded by the cost of burning, with shorter names burning exponentially more.

The protocol is split across three tiers of chains. **Ethereum mainnet (L1)** anchors identity, token balances, the Network registry, and the price oracle. **L2 chains** — chosen per Network at registration time — host the action-processing contracts that turn signed messages into immutable history. **Archive chains** receive long-term optimistic replication of L2 activity, finalized after a two-day challenge window during which any honest observer may slash a fraudulent submission for its full stake.

CAW is structured as a permissionless multi-Network protocol. A "Network" in CAW is a registered operator-tier entity: it picks its own L2 venue, sets its own fee gates, and runs its own validator and mirrors. Networks coexist under one L1 anchor, sharing the same CAW token, NFT identity space, and price oracle, while diverging operationally and economically. This structure is to social protocols what multi-app domains are to DNS: many operators, one root.

Costs are paid in CAW tokens. Action costs are fixed in CAW with **ETH-denominated upper bounds** enforced by a seven-day TWAP of a burned-LP Uniswap V2 pair. The cap binds only when the CAW price rises sufficiently to make the fixed cost unaffordable; when it binds, the protocol's distribution percentages (receiver, depositor pool, validator) are preserved at every price point. Every CAW spent is either redistributed to other holders, paid to validators, or burned at `0xdead`. There is no protocol treasury.

Every production contract is **renounced post-deploy**. The deployer transfers ownership of cross-chain peers to a single sentinel — the `PathwayExpander` — which can only call `addPeer()` and never `setPeer()`. The PathwayExpander itself can then be renounced. After the final renunciation, the protocol can extend to new chains via permissionless peer-addition but cannot be reconfigured, paused, fee-extracted, or upgraded by any party.

Direct messages are encrypted end-to-end and stored off-chain. They are intentionally outside the protocol's economic loop: free to send, free to read, governed at the relay layer by reputational and rate-limiting mechanisms rather than by spend.

The remainder of this paper describes how each of these claims is realized in code.

---

# 2. The Problem

Every centralized social platform begins as a product and ends as a tax. The platform owner accumulates control over identity, distribution, and content moderation, and over time monetizes each in ways that diverge from user interest. A user who has spent a decade building an audience on such a platform cannot port that audience anywhere; the platform's owners can — and do — sell access to it, restrict its visibility, or remove it.

The historical attempts to build a decentralized alternative have, with rare exceptions, failed in one of three ways:

**Custodial decentralization.** A "decentralized social network" that runs on a single corporate-owned cluster of servers, governed by a foundation, with admin keys that can pause, upgrade, or freeze accounts. The decentralization is rhetorical.

**Federated decentralization.** A protocol like ActivityPub where servers ("instances") federate freely, but an instance operator can still ban, defederate, or silently shadow-ban users. Account portability is limited; the social graph fragments along server boundaries. The decentralization is administrative, not cryptographic.

**Relay-based decentralization.** A protocol like Nostr where messages are signed, relays are interchangeable, but storage is replication-by-best-effort. There is no guarantee that the post you made will be retrievable a decade later. Identity is a cryptographic key with no anchored representation, so phishing-resistant key recovery remains an open problem. The decentralization is real but the durability is voluntary.

CAW takes a fourth path. Identity is anchored as an immutable NFT on Ethereum mainnet. Every social action is a transaction on an EVM L2, with the action's bytes living forever in the transaction's calldata. The protocol's storage layer is the same blockchain that adjudicates Bitcoin and DeFi; storage durability is a function of the chain's persistence, not an operator's promise.

Censorship resistance follows from a different fact: the protocol contracts have no admin keys. Once deployed and peers wired, the only mutation any party can make is to add a new cross-chain peer — and that, too, can be renounced. There is no operator who can be subpoenaed, threatened, or compromised into removing content. There is no operator at all.

What remains, then, is a question of frontends. The manifesto is explicit about this:

> *"At the base level, CAW's contracts for trustless data storage and communication, anything can be posted. We are not naive, and we understand what may be posted. As a result of this, it is up to the frontends to limit content that might obfuscate the reason for CAW's creation."*

The protocol does not moderate. Frontends moderate. A frontend operator may filter, mute, hide, or refuse to display any subset of the protocol's data; the protocol is indifferent. A user shadow-banned on one frontend remains, on the protocol, indistinguishable from a user in good standing — and may be visible on another frontend without lifting a finger. This is a deliberate structural choice. Content moderation is a legal, cultural, and aesthetic problem; it does not belong in the protocol layer.

CAW's wager is that separating the *protocol* (which is forever) from the *frontend* (which is replaceable) produces a more robust public square than either layer could produce alone.

---

# 3. Design Principles

The principles below are not aspirational. Each is enforced by deployed code; the relevant enforcement mechanism is named.

## 3.1 Renounced ownership

> *"After deployment, the deployer must renounce any keys they have to the contracts. There will be no multi-sig, no upgradeable proxies. It will not matter who deployed because they will be equal with all with no specific benefit nor advantage. Just get the contract right."*
> — `docs/manifesto.txt`

Every production contract is Ownable, and every production contract has its owner transferred to `address(0)` after deployment. The single exception is the cross-chain peer-wiring surface, which retains a constrained owner (the `PathwayExpander` — see §11) precisely so the protocol can be extended to new chains without becoming reconfigurable.

The renounce is not a future promise. It is a transaction call on every Ownable contract, irreversible by design.

## 3.2 No upgradeable proxies, no multisig

CAW contracts are not behind transparent or UUPS proxies. There is no migration path. If a critical bug is discovered, the response is the same as Bitcoin's response to a critical bug: redeploy, and let the social consensus of users, frontends, and Networks migrate. This is a feature. A protocol with an upgrade path has an attack surface that a protocol without one does not.

## 3.3 Protocol/frontend separation

The protocol contracts validate signatures, enforce costs, and emit events. They do not curate, rank, or filter. Display is the frontend's job.

This means a feature like a "block list" or "muted users" is a frontend feature; the protocol records the action ("hide", a typed `OTHER` action whose payload prefix is `hide:`) and lets the frontend decide what to do with it. Two frontends watching the same Network can present radically different views of the same data.

## 3.4 Calldata as the source of truth

When a validator submits a batch to `CawActions.processActions(...)`, the batch's *bytes* — the packed actions, the signatures, the per-action recipients and amounts — live in the transaction's calldata, not in contract storage. The contract emits an event whose payload is a 32-byte commitment (`batchHash = keccak256(packedActions)`), and indexers reconstruct the social state by fetching the original transaction, validating against `batchHash`, and unpacking.

This is a deliberate cost-of-permanence choice. SSTOREs are expensive; calldata is permanent and cheap. The protocol pays the cheap price and accepts that "the chain is the truth, mirrors are caches" is the architecture's defining property.

## 3.5 Cost in CAW, ceiling in ETH

Action costs are denominated in CAW tokens with values fixed at deploy. To prevent the protocol from becoming unusable if the CAW token appreciates significantly, each action type has an **ETH-denominated upper bound**, enforced by a seven-day TWAP of a Uniswap V2 CAW/WETH pair whose LP tokens are 99.99% burned (the oracle source cannot be rugged). When the cap binds, the distribution percentages — receiver, depositor pool, validator — are preserved. The cap is self-deactivating: when CAW is cheap, baseline applies; when CAW is expensive, the cap binds; the cap has no floor (CAW falling never reduces baseline cost).

The cap is the mechanism that lets a renounced protocol survive a thousand-fold price appreciation without breaking its user experience.

## 3.6 The negative manifesto

It is sometimes more useful to specify what a protocol is *not*:

- **No DAO.** No governance token. No voting on protocol parameters.
- **No timelock.** No emergency switch. No pause function.
- **No upgrade pathway** within a deployed contract. Migration happens by redeploy and social fork.
- **No protocol treasury.** Every CAW collected is redistributed, paid as tip, or burned.
- **No central frontend.** The "official" frontend has no privilege over alternatives.
- **No KYC.** No accounts beyond an NFT held in a wallet.

---

# 4. Architecture

CAW's architecture is organized around three tiers of chains, each tier doing a job that the others cannot.

## 4.1 The Three Worlds

```
                    ┌───────────────────────────────────┐
                    │   L1  —  Ethereum mainnet         │
                    │                                   │
                    │   THE ANCHOR  (one truth)         │
                    │                                   │
                    │   • CAW (ERC-20)                  │
                    │   • CawProfile (username NFT)     │
                    │   • CawNetworkManager (registry)  │
                    │   • CawProfileMarketplace         │
                    │   • CawBuyAndBurn                 │
                    │   • CawL1PriceReader (oracle src) │
                    └────────────────┬──────────────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       ▼                             ▼                             ▼
   ╔═════════╗                  ╔═════════╗                   ╔═════════╗
   ║  Net A  ║                  ║  Net B  ║                   ║  Net C  ║
   ║         ║                  ║         ║                   ║         ║
   ║  L2:    ║                  ║  L2:    ║                   ║  L2:    ║
   ║  Base   ║                  ║ Polygon ║                   ║ Arbitrum║
   ╚════╤════╝                  ╚════╤════╝                   ╚════╤════╝
        │                            │                             │
        │ each Network's own L2 hosts:                              │
        │   • CawActions                                            │
        │   • CawActionsERC1271 (sibling for passkey owners)        │
        │   • CawProfileL2                                          │
        │   • CawChallengeRelay                                     │
        │   • CawCapOracle                                          │
        │                                                           │
        ▼                                                           ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ ARCHIVE CHAINS  (each validator picks their own)                 │
   │                                                                  │
   │  • Arbitrum  • Optimism  • zkSync  • …                           │
   │                                                                  │
   │  Each runs CawActionsArchive — long-term storage of replicated   │
   │  actions with a 2-day challenge window before finalization.      │
   └──────────────────────────────────────────────────────────────────┘
```

**L1 (Ethereum mainnet)** is the anchor. The CAW token lives here. The username NFT (`CawProfile`) lives here. The Network registry (`CawNetworkManager`) lives here. The price oracle source (a burned-LP Uniswap V2 pair) lives here. Whenever a user mints a username, deposits CAW into a profile, or withdraws back to L1, L1 is where it happens — and a LayerZero message propagates the change to whichever L2 the user's Network operates on.

**L2 (action-processing chains)** are where social actions are written. Each Network selects its L2 at registration via `CawNetworkManager.createNetwork()` (the `storageChainEid` parameter). Different Networks may select different L2s; today most Networks live on Base. The L2 contracts — `CawActions`, `CawActionsERC1271`, `CawProfileL2`, `CawChallengeRelay`, `CawCapOracle` — are deployed per-L2, not per-Network: the contracts are shared infrastructure on each chain, and `CawActions` distinguishes Networks by an internal `networkId`.

**Archive chains** are where long-term replication lives. A validator stakes ETH on an archive chain's `CawActionsArchive` contract, then submits packed batches of L2 activity for permanent record. The archive submission is *optimistic*: it becomes canonical after a two-day challenge window during which any honest observer may prove fraud and slash the validator's entire stake.

The Three Worlds are connected by LayerZero (for L1↔L2 messaging and L2→archive fraud-proof messaging). Cross-chain ordering is bounded by LayerZero's delivery semantics, with conservative fee buffers (120% for routine paths, 150% for slash-adjacent paths).

## 4.2 Contract inventory at a glance

Appendix B lists every production contract with file paths and constants. The summary below names the contracts and their job at the protocol level.

**On L1:**

- `MintableCaw` — the CAW ERC-20 token.
- `CawProfile` — username NFT, deposit/withdraw, marketplace transfer hooks.
- `CawProfileMinter` — bundled mint flows (ZAP: ETH → CAW → mint + deposit + session, in one tx). The intentional extension point, since `CawProfile` itself is at the EIP-170 size cap.
- `CawProfileMarketplace` — trustless, feeless NFT marketplace with fixed-price, Dutch auction, English auction, and offer support.
- `CawProfileURI` + `CawFontDataA` + `CawFontDataB` — on-chain SVG renderer for the username NFT, with a 54-glyph vector font split across two data contracts to fit under the EIP-170 cap.
- `CawBuyAndBurn` — captures ETH fees, swaps via Uniswap V2, sends 50% to the Network operator and 50% to `0xdead`.
- `CawL1PriceReader` — reads cumulative price from the burned-LP Uniswap V2 CAW/WETH pair.
- `CawNetworkManager` — permissionless Network registry. Each Network specifies its `storageChainEid` at registration; per-Network fee gates and lockdown flags are configured here.

**On each L2 (per Network's chosen L2):**

- `CawActions` — the core action processor. Two ECDSA entry points: `processActions` (per-action ecrecover) and `processActionsWithZkSigs` (Groth16 proof commits to off-chain signer recovery). Maintains a per-Network hash-chain checkpoint that the archive system attests to.
- `CawActionsERC1271` — sibling contract for variable-length signatures from contract-owned profiles (passkey-backed smart EOAs, Safes, etc.). Exposes `processActionsERC1271(packedActions, bytes[] sigs, ...)`, verifies each owner's `isValidSignature` once, then calls back into `CawActions` in pre-verified-signer mode. Same hash chain, same cawonce bitmap, same `ActionsProcessed` event stream — the sibling exists only because the fixed 67-byte-per-group wire format of `processActions` cannot carry 200–400-byte WebAuthn assertions.
- `CawProfileL2` — L2 balance ledger plus session-key storage. Does *not* hold NFTs; those live on L1. Holds per-tokenId CAW balance, registered session keys (scope bitmap, spend limit, expiry, epoch), and a per-owner session nonce for replay protection. Carries the one-shot `erc1271Sibling` setter that wires the sibling contract.
- `CawChallengeRelay` — permissionless fraud-proof relay; reads canonical per-Network checkpoint hashes from `CawActions` and sends them via LayerZero to archive chains when a submission is disputed.
- `CawCapOracle` — 1024-slot ring buffer of L1-piggybacked price samples; computes a seven-day TWAP used by `CawActions` to bound per-action cost.

**On archive chains:**

- `CawActionsArchive` — validator stake ledger, submission storage, challenge resolution. `MIN_STAKE = 0.01 ether`, `CHALLENGE_PERIOD = 2 days`, `MAX_CHECKPOINTS_PER_SUBMISSION = 256`.

**Cross-cutting:**

- `PathwayExpander` — owner of all LayerZero OApps after the deployer renounces. Its only permitted action is `addPeer()`; it cannot `setPeer()`, cannot transfer ownership, cannot reconfigure anything. It can itself be renounced.
- `OnlyOnce` — mixin enforcing that certain setters run at most once per contract instance.
- `SigVerification` — library providing ECDSA fast-path plus ERC-1271 fallback (with a 50K gas cap to prevent griefing by contract wallets).
- `SP1VerifierGroth16` — Succinct's canonical Groth16 verifier (vendor contract).

For depth on each contract's interface, see `docs/ARCHITECTURE.md`.

## 4.3 The off-chain layer

Each Network runs a set of **Mirrors**: FE/server pairs that index the chain and serve the user-facing application. A Mirror runs roughly twenty services, of which the load-bearing ones are:

- `RawEventsGatherer` — WebSocket-subscribed to the L2; dumps every CAW event into a `RawEvent` table, publishes new IDs to a Redis channel.
- `ActionProcessor` — consumes Redis, fetches the underlying L2 calldata, validates against the event's batchHash, unpacks actions, writes domain rows.
- `ValidatorService` — polls `TxQueue`, batches up to 256 actions, simulates, signs, submits to L2 `processActions()` (or `processActionsERC1271()` for ERC-1271-signed batches). Also runs the optimistic replication loop submitting to the archive every ~120 seconds.
- `Api` — Express server receiving signed EIP-712 actions from browsers, writing optimistic DB rows plus a `TxQueue` row, broadcasting to peer Mirrors.

A Network typically runs several Mirrors in parallel. They coordinate via the L2 chain itself; there is no central Mirror-to-Mirror coordinator (see §10).

For the full service inventory, see `docs/ARCHITECTURE.md`.

---

# 5. The Action Lifecycle

This section follows one signed action from a user's click to its permanent place in the chain.

## 5.1 Compose and sign

A user composes a caw — up to 420 characters after smltxt compression, which yields roughly a 3× to 5× ratio over UTF-8. The frontend builds an EIP-712 `ActionData` structure binding the action type, sender tokenId, recipient tokenId (where applicable), per-action `cawonce` (a monotonic per-user nonce), text bytes, recipients array, and amounts array.

The user signs the structure via one of three mechanisms:

- **Direct wallet signature** (MetaMask, RainbowKit, etc.) — every action requires a wallet popup. Maximally secure.
- **Quick Sign session key** — an ephemeral secp256k1 keypair registered on-chain to sign in-memory without wallet interaction. Bound by scope bitmap, spend limit, expiry, and epoch.
- **Passkey signer** (EIP-7702 + WebAuthn) — biometric unlock; the wallet's authority is temporarily delegated to a WebAuthn-protected key, or the user's profile is owned by a passkey-backed smart EOA that implements ERC-1271.

The cryptographic detail of these paths is the subject of §6.

## 5.2 Submit to a Mirror

The signed action POSTs to one of the Network's Mirrors (typically the user's "home" Mirror, but the browser may fan out to multiple Mirrors in parallel for redundancy). The Mirror's API performs pre-flight checks:

- **Cawonce collision** — server's TxQueue has a partial unique index on `(senderId, cawonce)`. A duplicate returns HTTP 409 with a `suggestedCawonce`.
- **Content fingerprint dedup** — exact-content posts within a two-minute window are rejected.
- **Free-action rate limit** — UNLIKE and UNFOLLOW are zero-cost in CAW (validator collects the 1,000 CAW griefing floor as a tip), so they are rate-limited per user.
- **Session spend-limit check** — if signed with a session key, the cumulative `sessionSpent` is checked against the session's `spendLimit`.

If the action passes, the Mirror writes optimistic rows (`Caw` with `status=PENDING`, plus `Like`/`Follow`/`Reply`/`Poll` as applicable) and queues a `TxQueue` row containing the signed payload. The user sees the post appear immediately.

## 5.3 Peer mirror fan-out (browser-initiated)

Cross-Mirror redundancy is achieved by the browser submitting to multiple Mirrors in parallel, not by server-to-server forwarding. Server-to-server forwarding is structurally forbidden in CAW: with N Mirrors each forwarding to N−1 others, naive fan-out would loop infinitely, so the rule is that only browsers fan out.

Each Mirror writes its own `TxQueue` row independently. The chain's `cawonce` uniqueness is what eventually resolves conflicts: the first validator to land the submission wins, and the others see a 409 on next attempt.

## 5.4 Batching and submission

The `ValidatorService` polls `TxQueue` every ~10 seconds, fetches up to 256 pending rows, groups them under the contract's "max 4 unique senders per batch" rule, simulates the call via `eth_call`, and trims to the 30KB `packedActions` calldata cap.

The validator then chooses between three on-chain entry points:

- **Sig path** (`CawActions.processActions`) — the contract performs `ecrecover` per action, advances the per-Network hash chain, and applies state. Gas: roughly 149K plus 20.8K per action. This is the default path for ECDSA-signed actions.
- **ZK path** (`CawActions.processActionsWithZkSigs`) — an off-chain SP1 Groth16 proof attests to signer recovery; the contract verifies the proof (one `verifyProof` call, ~265K gas fixed) and walks the verified `signers[]` without ecrecover. Break-even versus the sig path is ~70 actions per batch.
- **ERC-1271 path** (`CawActionsERC1271.processActionsERC1271`) — for batches signed by contract-owned profiles (passkey-backed smart EOAs, Safes, etc.). The sibling contract verifies each owner's `isValidSignature` once (with a 50K gas cap to prevent griefing), then calls back into `CawActions` in pre-verified-signer mode. Used because the fixed 67-byte-per-group wire format of `processActions` cannot carry 200–400-byte WebAuthn signature blobs.

All three paths produce identical on-chain state under a single `ActionsProcessed` event stream — one hash chain, one cawonce bitmap, one batch-commitment scheme. The chosen path is signed with the validator's key (`VALIDATOR_PRIVATE_KEY`) and submitted to the L2. Gas-bump retry covers ephemeral failures.

## 5.5 On-chain execution

`CawActions` is the protocol's central state machine. For each action in the batch it:

1. Verifies the signature (ecrecover for the sig path; pre-verified by Groth16 for the ZK path; pre-verified by `CawActionsERC1271` for the ERC-1271 path).
2. Enforces cawonce uniqueness — revert on conflict in the sig and ERC-1271 paths; skip on conflict in the ZK path.
3. Applies the action cost, clamped against the per-action ETH ceiling using the pushed cap ratio (see §7) — a single SLOAD, no external call per action.
4. Distributes the cost across receiver, depositor pool, validator, and burn according to the split rules.
5. Advances the per-Network hash chain. Every 32 actions, a checkpoint is recorded.
6. Emits `ActionsProcessed(batchHash, networkId, validatorId, ...)`, committing to the calldata.

The action's text, signatures, and per-action data live in the transaction's calldata, recoverable forever via `eth_getTransactionByHash`.

## 5.6 Indexing

The Mirror's `RawEventsGatherer` captures the emitted event over WebSocket, writes a `RawEvent` row, and publishes to a Redis channel. The `ActionProcessor` consumes Redis, fetches the original L2 calldata, validates against `batchHash`, unpacks actions, and writes the canonical domain rows (`Caw` flipped from `PENDING` to `SUCCESS`, plus `Like`, `Follow`, `Reply`, `Poll`, and downstream updates to counts, search, and notifications). The user sees confirmation.

This is the end of the *fast path*. The action is final on L2 calldata forever. The remaining steps are about replicating that finality to other chains.

## 5.7 Archive replication

The `ValidatorService` runs a separate **optimistic replication loop** every ~120 seconds. It groups checkpoints (32 actions each) into a submission (up to 256 checkpoints), builds a merkle root over the checkpoint hashes, and submits to `CawActionsArchive.submitReplication()`. The validator stakes 0.01 ETH once; the same stake covers every subsequent submission. The submission carries a `dataCommitment = keccak256(packedActions)` so the bytes are recoverable from the archive transaction itself.

## 5.8 Challenge window and finalization

The submission is *not* immediately canonical. For the next **two days**, any honest observer may dispute it via one of two slash paths (see §8 for the mechanics):

- **Mode A — incoherent root.** The submitter's merkleRoot can't be derived from their own published packedActions. Anyone calls `slashIncoherentRoot()`. Single transaction on the archive chain; no cross-chain message needed. The validator's entire stake is slashed.
- **Mode B — fraudulent leaf.** The submitter's tree is internally consistent, but at least one leaf differs from the canonical L2 hash. The challenger triggers `CawChallengeRelay.relayChallengeBatch()` on the source L2; LayerZero delivers the canonical hash to the archive; `resolveChallenge()` on the archive compares and slashes.

If two days pass without a successful challenge, anyone may call `finalizeSubmission()` and the archive entry becomes canonical. The action now exists in three permanent forms:

- The original L2 transaction's calldata.
- The archive transaction's calldata (replicated).
- The indexed rows on every Mirror within every Network that watches this Network's data.

---

# 6. Cryptography & Identity

CAW relies on a small, well-understood set of cryptographic primitives. This section describes them and explains why each was chosen.

## 6.1 EIP-712 typed actions

Every CAW action is signed using EIP-712. The struct definition pins the action to a domain that includes the chain ID and the deployed `CawActions` contract address; signatures are not transferable across chains or across deployments. This is what makes the multi-Network design safe: a Network on Base and a Network on Polygon use different `CawActions` deployments, hence different domain hashes, hence non-cross-replayable signatures.

EIP-712 was chosen over raw message signing because the typed-data form lets wallets render human-readable parameters (action type, recipient, amount) rather than an opaque hash, reducing the user's exposure to blind-signing phishing.

## 6.2 The signer identity model

A CAW user is, at root, the holder of an ERC-721 username NFT on L1. The owner address of that NFT is the canonical signer for any action belonging to the username's `tokenId`. Three mechanisms extend this without weakening it:

1. **ERC-1271 fallback** — for smart-contract wallets, signatures are validated via `isValidSignature(hash, sig)` on the wallet contract. The library `SigVerification.sol` caps gas at 50K to prevent griefing. The `CawActionsERC1271` sibling extends this to batches of variable-length signatures (passkey assertions, Safe signatures) that exceed the fixed 67-byte wire slot used by the standard sig path.
2. **Session keys (Quick Sign)** — see §6.3.
3. **Passkey signing (EIP-7702 + WebAuthn)** — see §6.5.

In every case, the action either resolves to a signature by the NFT owner address, or to a signature by an explicitly-authorized session key registered under that owner.

## 6.3 Quick Sign session keys

Wallet popups are friction. A user who wants to scroll, like, and follow at the cadence of a normal social experience cannot tolerate a wallet prompt every few seconds. CAW solves this with **session keys**: an ephemeral secp256k1 keypair generated client-side, authorized by a single wallet signature, and registered on L2 (`CawProfileL2.registerSession`) with the following bounds enforced in the contract:

- **Scope bitmap** — which action types this session may authorize. Bit 6 (WITHDRAW) is permanently excluded by the contract (`require((scopeBitmap & 0x40) == 0, "Cannot delegate WITHDRAW");`). A compromised session key can never drain a wallet.
- **Spend limit** — cumulative CAW the session may spend over its lifetime (`sessionSpent[owner][sessionKey]`); revert when exceeded.
- **Expiry** — Unix timestamp after which all actions revert. Maximum 30 days.
- **Tip ceiling** — per-action cap on validator tip.
- **Epoch** — the session's value of `ownerSessionEpoch[owner]` at registration time. The epoch is bumped on NFT transfer, automatically invalidating every session for the previous owner.

```
   QUICK SIGN — six-bit scope bitmap

   bit 0  CAW    (post)        ✓ default
   bit 1  LIKE                 ✓ default
   bit 2  UNLIKE               ✓ default
   bit 3  RECAW                ✓ default
   bit 4  FOLLOW               ✓ default
   bit 5  UNFOLLOW             ✓ default
   bit 6  WITHDRAW             ✗ PERMANENTLY EXCLUDED
   bit 7  OTHER (tip, pin,
          vote, hide, etc.)    ✓ default

   Default bitmap: 0xBF = all except WITHDRAW
```

The local private key may be stored unencrypted in `localStorage` (default, appropriate for small spend limits) or AES-256-GCM-encrypted with a key derived from a wallet signature (PBKDF2, 100K iterations); the encrypted mode is auto-enabled for unlimited spend.

Replay protection has two parts: `sessionNonce[owner]` bumps on every register/revoke, invalidating prior cross-chain messages with the old nonce; and the personal_sign-form registration message is consumed once via `consumedSessionMessage[sha256(message||signature)]`.

The NFT-transfer-invalidation property is worth emphasizing. When a username NFT transfers from Alice to Bob, the L1 transfer event triggers an L2 update that bumps `ownerSessionEpoch[Alice]`. From that moment, every session key Alice authorized is dead at the contract level — even if Alice still has the private key in her browser's `localStorage`. The on-chain check `session.epoch == ownerSessionEpoch[owner]` fails, and the action reverts. This is the cryptographic equivalent of "logging the previous owner out."

For full mechanics, see `docs/SESSION_KEYS.md`.

## 6.4 The ZK signature-recovery path

`CawActions.processActionsWithZkSigs` is a second on-chain entry point that takes a Groth16 proof attesting "I recovered every signer in this batch correctly off-chain." The contract verifies the proof once (~265K gas via the canonical SP1 Groth16 verifier published by Succinct Labs) and then walks the verified `signers[]` array without performing per-action ecrecover.

The proof commits to four public inputs — `keccak256(packedActions)`, `keccak256(packedSigs)`, `keccak256(signers)`, `eip712DomainHash` — and crucially commits to *no chain state*. This makes the path race-safe: a competing transaction landing between proof generation and proof submission cannot invalidate the proof, because the proof never claimed anything about chain state. State checks (cawonce, balance, hash chain) are still performed by the contract; the proof only relieves the contract of cryptographic signer-recovery work.

The trust anchor is two-fold:

- `zkVerifier` (the Groth16 verifier address) is stored `immutable` in `CawActions` and pinned at deploy.
- `zkProgramVKey` (the verifying key for the specific SP1 circuit binary) is also `immutable`, pinned at deploy.

Any change to the circuit produces a different vkey; mismatch causes every proof to reject. A new circuit requires a new `CawActions` deployment.

Break-even versus the sig path is approximately 70 actions per batch. Below that batch size, sig path is cheaper; above it, ZK path is cheaper. Real production batches today (n = 20–30) are roughly 25% more expensive on the ZK path; ZK only becomes economical once validators can sustainably coalesce well above n = 70.

A second important property: on cawonce conflict, the ZK path *skips* the conflicting action rather than reverting the batch. The `actionsExecutedBitmap` field in `ActionsProcessedZk` lets indexers know which slots actually ran. This matters because off-chain proving takes ~10 seconds (or ~10 seconds via Succinct's hosted prover network), during which a competing sig-path transaction may consume the same cawonce; the ZK path's skip-don't-revert semantics let the rest of the batch land.

For depth, see `docs/ZK_SIG_PATH.md`.

## 6.5 The passkey path (EIP-7702 + WebAuthn)

The friction of session keys is small but nonzero: the user must perform an initial wallet signature, and the WITHDRAW action remains permanently scope-excluded from session keys for safety. To support a user who never wants to touch a traditional wallet at all — and who needs a path to authorize WITHDRAW without one — CAW combines **EIP-7702** (which allows an EOA to temporarily delegate to contract code) with **WebAuthn / EIP-7951** (which enables on-chain verification of P-256 signatures from passkeys).

In this model the user's wallet is a passkey — typically a biometric-protected key in the device's Secure Enclave (iOS), Keystore (Android), or platform authenticator (Touch ID on Mac, Windows Hello, etc.). The user signs actions with FaceID, fingerprint, or device PIN; the protocol verifies the WebAuthn signature on-chain. There is no seed phrase to manage, no MetaMask popup, and the key never leaves the secure hardware.

WebAuthn assertion blobs are large — 200 to 400 bytes per signature, well beyond the fixed 67-byte-per-group wire format that `CawActions.processActions` was designed for. The protocol handles this with the **`CawActionsERC1271` sibling contract**: a co-deployed contract on each Network's L2 that exposes `processActionsERC1271(packedActions, bytes[] sigs, ...)`. For each action, the sibling calls `isValidSignature(actionHash, sig)` on the owner's smart-account contract (the passkey-backed account), validates the magic return value, and then calls back into `CawActions` in pre-verified-signer mode. The hash chain, the cawonce bitmap, and the `ActionsProcessed` event stream are shared between the sibling and the standard path — there is one canonical on-chain history regardless of which entry point a batch came through.

Critically, the sibling path supports WITHDRAW. Session keys cannot delegate WITHDRAW because a compromised session key would otherwise be able to drain the wallet. A passkey-backed smart account is not a "delegated session"; it *is* the wallet, with the user's biometric as the unlock. Therefore the sibling path is the canonical mechanism by which a passkey-backed user withdraws their CAW back to L1.

Browser support is the near-term focus. WebAuthn is fully available in modern browsers — Touch ID on Mac Safari/Chrome, Windows Hello, Android Chrome with biometric, iPhone via Safari. The smart-account contract is `SmartEOA.sol`, an in-house EIP-7702 delegate written specifically for CAW (not a fork of Daimo's `P256Account` or any other external reference). It implements **dual-sig dispatch**: a WebAuthn P-256 passkey (verified via the EIP-7951 precompile at `0x0100`) is the primary signer, and a secp256k1 `ecdsaFallback` key acts as a recovery anchor. Either key alone satisfies `isValidSignature` for ordinary actions. Passkey rotation is 24-hour timelocked; removal below one remaining passkey requires the `ecdsaFallback` key as a second factor, preventing accidental lockout. The contract uses a per-(`verifyingContract`, `actionType`) nonce mapping, ensuring sponsored operations and direct user actions cannot replay across each other.

For users who cannot rely on passkey sync across devices — or who choose a browser-first flow without a native app — the web frontend offers a **backup blob** path: the `ecdsaFallback` secp256k1 key is encrypted with Argon2id (64 MiB, 3 iterations, parallelism 1, 32-byte output) followed by AES-GCM-256, producing a small ciphertext the user saves to iCloud Drive, Google Drive, or a USB device. Recovery is available at `/recovery`: the user uploads the blob and enters their vault password; the key is derived into memory only and used to sign a passkey-rotation transaction. No seed phrase is involved at any point. Native iOS and Android clients use the same architecture for users whose passkeys are not synced across devices; for depth on native specifics, see `/native/docs/`.

## 6.6 Sponsored entry points and the three signing populations

Not every user arrives with MetaMask installed. CAW classifies signers into three populations at the frontend layer:

- **Population A** (plain EOA) — signs directly via `wagmi writeContract`; no sponsor needed; full protocol surface available immediately.
- **Population B** (EIP-7702-delegated EOA with passkey + secp256k1 backup) — the phone-first path. The user's EOA is pointed at `SmartEOA.sol` via a type-0x04 authorization. A **sponsor server** — a trusted operator holding CAW — submits transactions on their behalf so the user pays zero gas.
- **Population C** (other smart-contract accounts — Safe, Argent, etc.) — supported where the contract implements `ISmartEOA`'s nonce surface; otherwise the user must provide a shim. Full-feature support is scoped to a subsequent upgrade.

For Population B, `CawProfileMinter` exposes three sponsored entry points, each authenticated with EIP-712 + ERC-1271 + `ISmartEOA` nonce verification:

1. **`mintAndDepositSponsored`** — bootstraps a new user: mints the username NFT and funds the L2 profile balance in one transaction. The sponsor holds the required CAW and submits the tx.
2. **`depositForSponsored`** — tops up an existing profile's L2 CAW balance on behalf of the user.
3. **`authenticateSponsored`** — proves active control of the profile for L2-side operations without requiring the user to sign a separate on-chain transaction.

The sponsor's trust surface is deliberately narrow. The CAW it supplies is immediately credited to the user's on-chain `tokenId` balance; the sponsor never acquires a claim over it. `MAX_DEPOSIT_CAW` and `MAX_LZ_FEE_WEI` constants cap each sponsored call so a misbehaving sponsor cannot over-commit the user's account. The `ISmartEOA` per-(`verifyingContract`, `actionType`) nonce used in each sponsored operation is consumed exactly once; any replay or reorder reverts.

**`withdrawTo` is not sponsored, and this is intentional.** A sponsor submitting a withdrawal on behalf of a user would mean the sponsor can move user CAW back to L1 on a schedule the user does not control. The v5 design decision is that WITHDRAW is always a direct user action — signed by the passkey or the `ecdsaFallback` key, never routed through a sponsored entry point. This is a property of `CawProfileMinter.sol`; there is no admin override or future-upgrade path for it.

## 6.8 Direct messages

DMs are end-to-end encrypted with ECIES (ECDH over the recipient's published encryption key, followed by AES-256-GCM with an HKDF-derived key). The encrypted payload is stored on the sender's and recipient's Mirrors; replication between Mirrors is via signed HTTP envelopes (the sender's wallet signs the envelope; peer Mirrors verify against the registered DM identity).

DMs are intentionally outside the protocol's on-chain economic loop. They cost no CAW. There is no on-chain economic gate against spam; spam mitigation is at the relay layer (rate limits, ignore lists). This is a deliberate choice rooted in the manifesto: communication is free.

For depth, see `docs/DIRECT_MESSAGING.md`.

## 6.9 One-time-use authentication signatures

Some off-chain operations (e.g. linking an X account, enabling DMs) require a user to sign a message that the server consumes once. The server stores `sha256(message || signature)` in Redis with `SET NX EX 300`, making the signature reusable nowhere within a five-minute window and unusable thereafter (because the message itself carries a timestamp that rejects after the window).

This is a small but important defense-in-depth: at no point does the server hand out a long-lived bearer token derived from a wallet signature without binding it to a single use.

---

# 7. Economics

CAW's economic structure has four participants: **users** (who spend CAW to act), **stakers** (any CAW holder on L2, earning passive yield from the depositor pool), **validators** (who batch and submit actions, earning CAW tips and staking ETH on archives), and **Network operators** (who run Mirrors and collect ETH fee gates on mint/auth/deposit/withdraw). Every CAW in the system is in one of four states: held, redistributed, burned, or in flight.

There is no protocol treasury. There is no team allocation. There is no foundation. The token's distribution at deploy is the distribution.

## 7.1 Action costs and splits

The fixed CAW costs per action type, with their distribution rules:

| Action            | Cost (CAW) | Split                                       |
|-------------------|-----------:|---------------------------------------------|
| CAW (post)        |      5,000 | 100% → depositor pool                       |
| LIKE              |      2,000 | 80% receiver / 20% depositor pool           |
| RECAW             |      4,000 | 50% receiver / 50% depositor pool           |
| FOLLOW            |     30,000 | 80% followee / 20% depositor pool           |
| UNLIKE / UNFOLLOW |      1,000 | 100% → validator (griefing floor)           |
| WITHDRAW          | gas + LZ fee only | —                                    |
| OTHER (tip, etc.) | user-set    | varies by sub-prefix                        |

Source: `solidity/contracts/CawActions.sol`.

The **depositor pool** is every account that currently holds a CAW balance on the relevant L2. Yield accrues passively in proportion to balance; there is no opt-in staking contract, no lock-up, and no slashing risk for stakers. The protocol treats *holding CAW on L2* as staking.

The validator's compensation comes from two sources: the 1,000-CAW griefing floor on UNLIKE and UNFOLLOW (which is paid entirely to the validator), and the optional per-action `amounts[]` tip a user may attach to any action. The implicit tip captured at session-registration time also accrues to the validator on every session-signed action.

## 7.2 The action cost cap

> When CAW becomes too valuable to spend, the cap kicks in.

If CAW appreciates significantly — say, to a market capitalization comparable to a major social platform — one CAW becomes expensive enough that a single post at 5,000 CAW would cost dollars. A renounced protocol cannot lower the fixed CAW cost after deploy. The cost cap mechanism addresses this without governance.

Each action has an **ETH-denominated upper bound** baked in at deploy:

| Action            | Cap (wei)     | Notional @ ETH = $5,000 |
|-------------------|--------------:|------------------------:|
| LIKE              | 2 × 10¹¹     | $0.01                   |
| RECAW             | 4 × 10¹¹     | $0.02                   |
| CAW (post)        | 5 × 10¹¹     | $0.025                  |
| FOLLOW            | 30 × 10¹¹    | $0.15                   |
| UNLIKE / UNFOLLOW | 1 × 10¹¹     | $0.005                  |

The cap rule is `cost_in_CAW = min(baseline_caw, max_eth_per_action / TWAP_eth_per_caw)`. When the cap binds, every internal distribution amount is scaled by `cost_in_CAW / baseline_caw`. **The split percentages do not change.** A LIKE that today is `2000 = 1600 receiver + 400 depositors` becomes, when the cap binds at e.g. 500 CAW: `500 = 400 receiver + 100 depositors`, still 80%/20%.

The cap is **self-deactivating**. While CAW is cheap (`max_eth / TWAP > baseline`), the baseline applies byte-for-byte. The cap is a ceiling, not a floor: CAW falling never reduces baseline cost.

### How the price reaches the cap

```
   L1: Burned-LP Uniswap V2 CAW/WETH pair
        │
        │ ★ LP tokens 99.99% burned → oracle source cannot be rugged
        │
        │  CawL1PriceReader.readSample()
        │  → (priceCumulative, timestamp)   UQ112.112
        │
        ▼
   Piggyback the price sample onto every L1→L2 LayerZero
   message (mint / deposit / auth / updateOwners). No dedicated
   oracle transaction. Opportunistic.
        │
        ▼
   L2: CawCapOracle ring buffer
        │
        │ • computes 7-day TWAP
        │ • if newest sample > 24h stale → push ratio = 0
        │   (cap dormant; baseline cost applies)
        │ • 100-bps hysteresis: only push when ratio
        │   actually moved meaningfully
        │
        │  setCapRatio(ratio) — single tx, pushed to CawActions
        ▼
   CawActions.capState (one packed slot: ratio + timestamp)
        │
        │  single SLOAD per action
        ▼
   CawActions._getCost(baseline, ethCap)
        finalCost = min( baseline_in_CAW ,
                         ethCap / ratio )
        ★ splits scale proportionally when the cap binds
        ★ zero external calls — pure local read
```

The design is a **push model**: the oracle writes its current TWAP ratio into a single packed slot on `CawActions` after each new sample, with a 100-basis-point hysteresis so spammy small movements don't cost gas. Action processing reads that slot via one SLOAD — no per-action `STATICCALL` to the oracle. A 32-action batch goes from "32 external calls" under a pull model to zero. The user-facing property is unchanged ("baseline when cap dormant, clamped when active, splits preserved at every price point"); the architecture is simply cheaper.

The oracle's integrity follows from two structural facts. First, the pool's LP tokens are burned, so liquidity cannot be removed and the pool depth is fixed forever. Second, V2 cumulatives are unbounded; unlike V3's `observe()` ring buffer, an old V2 cumulative does not expire. The seven-day window over a fixed-depth pool makes TWAP manipulation prohibitively expensive (rough order: at 12-second blocks for 7 days, an attacker needs 50,400 blocks of continuous defense against arbitrageurs while still spending real CAW to act on the artificially low cap).

If no L1 → L2 message arrives for over 24 hours (unlikely under normal traffic, but possible during quiet periods), the oracle pushes a zero ratio and the cap goes dormant — baseline applies. The conservative default avoids over-charging on stale price.

For full math and design rationale, see `docs/ACTION_COST_CAP.md`.

## 7.3 Validator and staker yield

Validators stake **0.01 ETH** on a `CawActionsArchive` contract — a single stake that covers all the validator's subsequent submissions. The stake is at risk: a successful slash takes the entire amount. The economic argument for staking is the income from validator tips:

- **Direct user tips.** Any action's `amounts[]` array may include an entry for the validator (or any other party). On UNLIKE and UNFOLLOW, the 1,000-CAW griefing floor goes 100% to the validator.
- **Implicit per-session tips.** A session key may carry a per-action tip rate locked at registration; this accrues to the validator on every session-signed action.

Stakers — every CAW holder on the Network's L2 — earn from the depositor pool, which is funded by 20% of every LIKE/FOLLOW, 50% of every RECAW, and 100% of every CAW post. Yield is proportional to balance, accrued continuously, and withdrawable to L1 at any time via `CawProfile.withdraw()`.

There is no staking contract, no lock-up, and no minimum balance for stakers. The protocol treats holding as staking and lets the underlying L2 token-balance mechanism do the accounting.

## 7.4 Username mint cost (the deflationary burn)

From the manifesto, baked into the protocol:

| Username length | CAW burned        | @ $50M MC | @ $1B MC  | @ $10B MC  |
|-----------------|------------------:|----------:|----------:|-----------:|
| 1 char (rare!)  | 1,000,000,000,000 |   $89,985 | $1,799,712| $17,997,120|
| 2 char          |   240,000,000,000 |   $21,600 |  $432,000 |  $4,320,000|
| 3 char          |    60,000,000,000 |    $5,400 |  $108,000 |  $1,080,000|
| 4 char          |     6,000,000,000 |      $540 |   $10,800 |    $108,000|
| 5 char          |       200,000,000 |       $18 |      $360 |      $3,600|
| 6 char          |        20,000,000 |     $1.80 |      $36  |        $360|
| 7 char          |        10,000,000 |     $0.90 |      $18  |        $180|
| 8+ char         |         1,000,000 |     $0.09 |     $1.80 |         $18|

Burned CAW goes to `0xdead`. Permanent supply contraction. The cost structure exponentially scales rarity: a single-character username is, by design, a six-figure commitment at low market caps and an eight-figure commitment at high ones. The protocol creates artificial scarcity in the namespace without giving any party the power to award or revoke names.

## 7.5 Network operator economics

A Network operator runs Mirrors, indexes the chain, hosts a frontend, and serves users. The protocol compensates this work through **ETH-denominated fee gates** that the Network configures via `CawNetworkManager`. There are four such gates:

- **mint fee** — charged when a user creates a username through this Network.
- **auth fee** — charged on first authentication with this Network for a given `(Network, tokenId)` pair.
- **deposit fee** — charged on each CAW deposit to L2 via this Network.
- **withdraw fee** — charged on withdrawal back to L1.

Each fee is split 50/50: half is sent (as CAW, swapped via `CawBuyAndBurn`) to the Network operator's address, and half is burned at `0xdead`. The fee amount that the Network sets (e.g. `mintFee = 0.001 ETH`) is the *per-recipient* amount; the user pays *double* that (0.002 ETH total) at transaction time. UIs must show the total cost, not the per-recipient amount.

When the Network later withdraws accumulated fees, all collected ETH is swapped to CAW in a single Uniswap V2 trade, with half going to the operator's address and half to `0xdead`. Operators receive CAW rather than ETH, which aligns incentives: a bad `minCawOut` slippage parameter hurts the operator's payout equally, making sandwich attacks self-punishing. Only `CawProfile` may call `swapAndSplit()`, so there is no public MEV griefing surface.

### Withdraw fee locking

Withdraw is the one fee with special user-protection semantics. When a user first authenticates or deposits with a Network, the *current* withdraw fee is **locked** for that `(Network, tokenId)` pair. On withdrawal, the user pays `min(locked, current)`:

- If the Network later **lowers** its withdraw fee, the user automatically benefits — they pay the new lower amount.
- If the Network later **raises** its withdraw fee, the user is **protected** — they still pay the locked amount.

The user is therefore never punished retroactively for choices a Network operator makes after they've already committed. This asymmetric guarantee (the user always gets the better of locked vs current) is what makes it safe to deposit into a Network whose operator might, hypothetically, behave adversarially in the future.

### Architectural property: the protocol takes nothing

Note what does *not* happen on this path: the protocol itself receives no fees, holds no treasury, and runs no governance over fee parameters. The 50% burn portion of every fee is sent to `0xdead`, not to a protocol address. The Network operator's portion is paid directly to the operator. The protocol's only role is enforcing the 50/50 split and the withdraw-fee locking semantics.

A Network that charges high fees risks losing users to a Network that charges lower fees. The protocol assumes that competition between Networks under one L1 anchor is the pricing-discipline mechanism.

## 7.6 The CAW supply loop

```
   USER BUYS CAW (DEX)
        │
        ▼
   L1: held as ERC-20
        │
        │  CawProfile.deposit() via LayerZero
        ▼
   L2: balance credited to tokenId
        │
        ├──► used to mint a username  →  CAW burned at 0xdead
        │
        ├──► spent on actions  →
        │      ├─ receiver (someone else's balance increases)
        │      ├─ depositor pool (yield to all CAW holders)
        │      ├─ validator (CAW income)
        │      └─ 50% burn portion of Network fee gates
        │
        └──► passively earning yield from depositor pool
                │
                ▼
        CawProfile.withdraw() via LayerZero
                │
                ▼
        L1: balance credited back to wallet
                │
                ▼
        DEX sell, or held, or re-deposited
```

Every loop either redistributes or destroys CAW. The supply is monotonically decreasing modulo unminted CAW, with the rate of destruction set by user activity (mints, fee withdrawals) and the rate of redistribution set by the social activity (posts, likes, recaws, follows). There is no inflation mechanism.

---

# 8. Optimistic Archive & Slashing

The L2 chain hosts every action permanently in its calldata, but the protocol provides a second layer of durability: **optimistic replication** to one or more archive chains. The archive layer is not a pass-through replica of every action. It is an *economically secured* commitment.

## 8.1 The trust model in one paragraph

A validator stakes ETH on an archive chain. The validator may then submit replication batches cheaply — no LayerZero fee per batch, no per-action cost beyond gas. If the validator ever submits something fraudulent, *any* honest observer can challenge: the challenger reads the canonical per-Network checkpoint hash from the source L2, sends it via LayerZero to the archive, and the archive slashes the validator's entire stake to whoever submitted the resolving transaction. The system tolerates any number of dishonest validators as long as at least one honest observer monitors during the two-day challenge window.

## 8.2 Submission

`ValidatorService.optimisticReplicationLoop()` periodically searches for unclaimed checkpoint ranges on the archive and calls `CawActionsArchive.submitReplication(networkId, startCp, endCp, packedActions, r[], merkleRoot, entryHash)`. The contract requires `stakes[msg.sender] >= MIN_STAKE` (0.01 ETH), requires that the checkpoint range is unclaimed, stores `dataCommitment = keccak256(keccak(packed), keccak(r), entryHash)`, sets `finalizedAt = block.timestamp + 2 days`, and emits `SubmissionCreated` plus `ActionsArchived`.

After two days, anyone may call `finalizeSubmission(submissionId)` and the data is permanently archived.

## 8.3 Backpressure: MAX_PENDING_SUBMISSIONS

`MAX_PENDING_SUBMISSIONS` (default `1`) caps how many unfinalized submissions a single validator may have outstanding. Without this, a compromised validator could pile up many fraudulent batches before the first slash lands. With it, one bad submission equals one slash, and the validator's loop pauses until that submission resolves (or all pending submissions are bulk-invalidated by the slash).

## 8.4 Detection: two fraud modes

The monitor service (which any party may run; no allowlist) reads each `ActionsArchived` event to obtain the submitter's own `packedActions + r[]`, rebuilds the hash chain locally via `foldCheckpointHashes`, rebuilds the merkle tree, and compares.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Comparison                          │ Verdict          │ Slash path  │
├─────────────────────────────────────┼──────────────────┼─────────────┤
│ submitterRoot ≠ sub.merkleRoot      │ MODE A           │ slash-      │
│ The submitter's data doesn't hash   │ Incoherent root  │ Incoherent- │
│ to the root they committed. No      │                  │ Root        │
│ valid merkle proof exists.          │                  │ (1 tx)      │
├─────────────────────────────────────┼──────────────────┼─────────────┤
│ submitterRoot == sub.merkleRoot     │ MODE B           │ relay +     │
│ AND any submitterHash[i] ≠ L2's     │ Fraudulent leaf  │ resolve     │
│ canonical hash at the same          │                  │ (LZ round-  │
│ checkpoint                          │                  │ trip)       │
├─────────────────────────────────────┼──────────────────┼─────────────┤
│ otherwise                           │ Honest           │ —           │
└─────────────────────────────────────┴──────────────────┴─────────────┘
```

### Mode A — incoherent root

The submitter published packed actions and a merkleRoot, but `rebuildRootFrom(packedActions) ≠ merkleRoot`. The fraud is locally provable on the archive chain. Anyone calls `CawActionsArchive.slashIncoherentRoot(submissionId, packed, r, entryHash)`. The contract re-folds on-chain, verifies the `dataCommitment` pin, and slashes if the rebuilt root differs from the claimed one.

Single transaction. No LayerZero. Total time: under one minute.

### Mode B — fraudulent leaf

The submitter's tree is internally consistent — every leaf hashes correctly to the published root — but at least one leaf differs from the canonical L2 hash for the same checkpoint. The fraud is not locally provable on the archive chain (the archive chain has no view of the source L2's state), so the challenge must bridge the canonical hash across chains.

The challenger calls `CawChallengeRelay.relayChallengeBatch(destEid, submissionId, networkId, checkpoints[])` on the source L2. The relay reads `CawActions.networkHashAtCheckpoint(networkId, checkpoint)` for each disputed checkpoint and sends those canonical hashes via LayerZero to the archive. Delivery typically takes seconds to a few minutes. When delivery completes, the challenger (or anyone) calls `CawActionsArchive.resolveChallenge(submissionId, checkpoint, claimedHash, proof)`. The contract compares the relayed canonical hash to the submitter's claimed leaf; mismatch → slash.

Two transactions across two chains. LayerZero fee paid by challenger (with 150% buffer — challenge paths are slashing-adjacent). Total time: roughly two to five minutes.

## 8.5 Slash effects

A successful slash, regardless of mode:

- Submitter's `stakes[validator] = 0`. Entire stake taken.
- All the submitter's pending (unfinalized) submissions are flipped to `SLASHED` in a single state update.
- Checkpoint claims released — honest validators can re-submit the same ranges.
- Reward (the slashed stake) is sent to `msg.sender` of the resolving transaction. Not the LayerZero relayer. Not the protocol. Whoever finalized the slash gets paid.
- `validatorSubmissions[validator]` is `delete`d, so a re-staked validator starts fresh.

## 8.6 Why optimistic, not pessimistic?

A pessimistic archive — one where every batch is mirrored synchronously across chains via LayerZero — would multiply the protocol's per-action cost by the number of archive chains. CAW's traffic is high-volume (a single post is one action; a single user's session may produce many actions per minute), and the per-LZ-message cost would dominate the user's CAW cost.

Optimistic replication amortizes the cost. A validator pays one LayerZero fee per *challenge*, not per *batch*. In the common case (no fraud), no LayerZero message is ever sent for the replication path; the submission lives in archive calldata, finalizes after two days, and is done. The cost is `MIN_STAKE` (0.01 ETH) in opportunity cost plus a small per-submission archive-chain gas fee.

The trade is that finality is delayed by two days. For social actions — where the L2 calldata is already canonical from `t=0` and the archive is providing additional durability rather than primary settlement — this is a fair trade.

## 8.7 Operational invariants

These are properties the system maintains by code, not policy:

1. **Anyone can challenge anyone.** No allowlist on `relayChallenge`, `resolveChallenge`, or `slashIncoherentRoot`. The fraud reward goes to `msg.sender`.
2. **Slashing is irreversible.** No admin can un-slash a submission or restore a slashed stake.
3. **Honest data cannot be slashed.** Mode A requires `computedRoot ≠ sub.merkleRoot` and the `dataCommitment` pin proves the bytes are the submitter's. Mode B requires `correctHash ≠ claimedHash` where correctHash comes from L2 and claimedHash is in the submitter's own tree.
4. **At least one honest monitor must observe within two days.** This is the optimistic-rollup liveness assumption. If nobody challenges, bad data finalizes. The protocol assumes that the bounty (the full 0.01 ETH stake) is a sufficient incentive for at least one observer.
5. **The archive contract has no owner functions affecting funds.** The only `onlyOwner` function is `setPeer` (LayerZero peer wiring at deploy), which the deployer calls once and then transfers to `PathwayExpander` before renouncing.

## 8.8 The twin-key fraud-test gate

To stress-test the slashing infrastructure, validators may run fraud-injection modes. To prevent accidental activation in production, this requires *two* independent environment variables: `CORRUPT_REPLICATION=true` and `CORRUPT_MODE=A` (or `B`). Either variable alone is rejected at startup with an explicit refusal log. When the twin-key gate is active, the validator emits a loud warning on every replication cycle, making accidental drift impossible to miss.

This is an example of CAW's preference for *structural* over *policy-based* safety: the rule is enforced by deployed code, not by a runbook.

For depth on operator concerns (deposit, stake management, fraud-test recipes), see `docs/REPLICATION_AND_SLASHING.md`.

---

# 9. Threat Model

This section enumerates the actors who might attempt to harm CAW, the capabilities each has, the defenses in place, and the residual risk. The framing is "who can attack what, and what's at stake."

## 9.1 Actor table

| Actor                        | Capability                                                | Defense                                                                | Residual risk                                  |
|------------------------------|-----------------------------------------------------------|------------------------------------------------------------------------|------------------------------------------------|
| Dishonest validator          | Submit fraudulent archive batches                         | Two slash modes, 2-day window, anyone can slash, full stake at risk    | If no honest monitor in 2 days, fraud finalizes |
| Malicious Network operator   | Censor frontend, charge high fees, refuse to relay actions| User can submit via any Network's Mirror; per-Network fees competitive; withdraw fees locked at deposit time | User loses access to one frontend, not the protocol |
| Malicious frontend           | Show false data, omit posts, run JS attacks               | Frontends are interchangeable; protocol data is public on-chain        | A naive user trusting one frontend can be misled |
| Compromised session key      | Sign actions up to spend limit / expiry                    | Scope excludes WITHDRAW; spend limit; expiry; user can revoke instantly| Up to spend limit can be stolen until revoke   |
| Compromised wallet key       | Transfer NFT, withdraw stake, sign anything               | None at the protocol layer                                              | All assets in that wallet are lost              |
| LayerZero stall              | Block cross-chain messages                                 | Mode A slash doesn't require LZ; cap goes dormant during stale; LZ fee buffer 150% for slash-adjacent paths | Mode B slashes delayed; cap not enforced during stall |
| Oracle manipulation          | Push CAW TWAP off true value to under-cap or over-cap     | Burned-LP V2 pool, 7-day window, fixed depth; manipulation cost ≫ benefit | At the margin, brief cap drift                 |
| NFT-transfer session bleed   | Buy an NFT and inherit prior owner's session keys         | `ownerSessionEpoch` bumps on transfer, invalidating prior sessions     | Brief delay between L1 transfer and L2 epoch bump (one LZ message) |
| Reentrancy / re-org          | Standard EVM attacks                                       | EIP-712 typed signing; cawonce nonce; hash chain advance               | Documented EVM-level risks                     |
| Replay across chains         | Sign on chain X, replay on chain Y                        | EIP-712 domain hash includes chainId + contract address                | None (cryptographic)                            |
| Replay across deployments    | Sign for old `CawActions`, replay on new                  | EIP-712 domain hash includes contract address; vkey for ZK path immutable | None                                          |
| Forged WebAuthn assertion    | Submit a crafted ERC-1271 sig that wrongly validates       | `CawActionsERC1271` calls owner's `isValidSignature` with 50K gas cap; `SmartEOA.sol` verifies P-256 via EIP-7951 precompile at 0x0100 | Reduces to soundness of `SmartEOA.sol` (in-house contract; 8 audit passes before deploy) |

## 9.2 The biggest residual risks

**Live-ness of the honest-monitor assumption.** The two-day challenge window is sufficient *if* at least one honest, well-resourced party is watching every archive submission. The bounty (the full 0.01 ETH stake per fraudulent validator) is meant to incentivize this watching. The protocol assumes — and this is an assumption, not a proof — that the bounty plus the social/economic interest of CAW holders is enough. If a regime change in CAW's userbase produced a moment where no party was watching, fraudulent submissions could finalize. The mitigation: the bounty scales with the number of slashes (zero-sum recovery), and the monitor service is open-source and runnable by any operator.

**Frontend supply-chain compromise.** A user runs JS served by a frontend; if the frontend is compromised, the user can be made to sign things they didn't intend. EIP-712 typed signing helps (wallets render parameters), but a sophisticated UI attack can still mislead. Mitigation: frontends should be reproducibly built, content-addressed, and ideally verifiable against a published Merkle root. This is an *ecosystem* concern, not a *protocol* concern; the protocol cannot enforce honest frontends.

**LayerZero as a trust dependency.** LayerZero's DVN/Executor model has known properties; the protocol inherits them. A LayerZero-level compromise could allow forged cross-chain messages, which in turn could trigger spurious slashes or block legitimate ones. The 150% fee buffer on slash-adjacent paths mitigates fee-related stalls; the try/catch wrapper on `_lzReceive` prevents a single bad payload from blocking the channel forever. A full LayerZero compromise would be a serious event, and the response would be a new `CawChallengeRelay` deployment via `PathwayExpander.addPeer()`.

**Smart-account contract soundness (passkey path).** The ERC-1271 sibling path delegates signature soundness to whatever smart-account contract owns the username NFT. A bug in that contract — for instance, an `isValidSignature` implementation that wrongly accepts arbitrary input — would let an attacker forge actions for that owner. The mitigation is that the smart-account contract for CAW's passkey population is `SmartEOA.sol`, an in-house EIP-7702 delegate (not a fork of Daimo's `P256Account` or any other external codebase). Its surface is intentionally small: dual-sig dispatch (passkey P-256 + secp256k1 `ecdsaFallback`), ERC-1271, the `ISmartEOA` per-(`verifyingContract`, `actionType`) nonce mapping, a 24-hour timelocked `addPasskey`, and an N-of-M quorum `removePasskey` with fallback protection when only one passkey remains. The contract underwent 8 audit passes before deployment. Per-user instances are deterministic deployments of this single audited bytecode.

**No upgrade path.** This is also a feature, but for a critical bug, the protocol's only response is redeploy + social fork. There is no emergency switch. CAW users accept this trade-off in exchange for the immutability guarantee.

---

# 10. The Mesh: Multi-Network, Multi-Mirror, Multi-Chain

CAW is not a single deployment. It is a mesh of Networks (each at the operator tier), and each Network is itself a mesh of Mirrors (at the host tier). This section describes how the mesh stays coherent.

## 10.1 Multi-Network: one L1, many L2s

A **Network** is registered via `CawNetworkManager.createNetwork()` on L1. The registration is permissionless: anyone may register a Network. The registration specifies, among other parameters, the `storageChainEid` — the LayerZero endpoint ID of the L2 chain where this Network's `CawActions` and `CawProfileL2` live. Different Networks may select different L2s.

Networks share the L1 anchor: the same CAW token, the same NFT identity space, the same Network registry, the same price oracle. They diverge on the L2 layer: each Network has its own `networkId` distinguishing its activity within shared L2 contracts, its own fee gates, its own validator and Mirror set, and its own social graph and database tables. A user's social graph on Network A is independent of their social graph on Network B; the same NFT identity can post on both, but the followers, posts, and history are not cross-replicated.

The architectural implication: a user who holds a username NFT has the *option* to participate in any Network. The username is portable across the entire mesh because it lives on L1, and the L2 reflection on each Network is derived from the L1 ground truth via LayerZero. But participation is per-Network: each Network is its own social context.

## 10.2 Multi-Mirror: peer Mirrors within a Network

Within a Network, multiple Mirrors run in parallel. Each Mirror is a complete FE/server stack — an Express API, a Postgres database, a Redis cache, a RawEventsGatherer, an ActionProcessor — and indexes the Network's L2 independently.

```
                 ┌─ L1 (Ethereum) ─┐
                 │ Network registry │
                 └────────┬─────────┘
                          │ event logs:
                          │ InstanceRegistered
                          ▼
                 ┌─ L2 (this Network) ─┐
                 │  CawActions          │
                 │  cawonce uniqueness  │
                 │  ENFORCED HERE       │
                 └──────────┬───────────┘
                            ▲ validators submit
                            │
   ┌──────────┬─────────────┴──────────┬──────────┐
   │          │                        │          │
 ┌─┴────────┐ ┌─┴────────┐         ┌─┴────────┐ ┌─┴────────┐
 │ Mirror 1 │ │ Mirror 2 │   …     │ Mirror N │ │ Mirror M │
 │ Pg/Redis │ │ Pg/Redis │         │ Pg/Redis │ │ Pg/Redis │
 │ TxQueue  │ │ TxQueue  │         │ TxQueue  │ │ TxQueue  │
 │ LOCAL    │ │ LOCAL    │         │ LOCAL    │ │ LOCAL    │
 └─────△────┘ └─────△────┘         └─────△────┘ └─────△────┘
       │            │                     │           │
       └────────────┴─────────────────────┴───────────┘
                            │
            Browser fans out to ALL Mirrors in parallel
            (NEVER server-to-server — would loop infinitely)
```

The chain serializes between Mirrors. Cawonce uniqueness on `CawActions` is what eventually adjudicates conflicts: if two Mirrors each try to submit the same `cawonce` for the same `tokenId`, the second submission reverts at the contract level, the first wins, and the loser's TxQueue row is invalidated by the resulting 409 collision.

## 10.3 The cawonce allocator

The frontend's challenge is to allocate cawonces without colliding across browser tabs, across devices, and across Mirrors. The allocator uses three layers:

```
   1)  CHAIN TRUTH
       chain.nextCawonce(tokenId)
       The only source of confirmed actions.
       Lags real-time, but ground truth.

   2)  LOCAL HIGH-WATERMARK (per browser origin)
       localStorage key:
          caw:cawonceHigh:{tokenId} = {cawonce, expiresAt}
       • in-memory cache + Web Lock (per-origin serialization)
       • BroadcastChannel → other tabs see bumps in the same microtask
       • storage event listener (fallback if no BroadcastChannel)
       • 5-min TTL — abandons stale allocations

   3)  409 COLLISION RETRY (server-side, cross-mirror catch)
       Server's TxQueue partial unique index on
       (senderId, cawonce) catches cross-mirror collisions.
       Returns suggestedCawonce = max(pending TxQueue cawonces) + 1.
       Frontend invalidates local watermark, re-signs, resubmits.
```

This is defense-in-depth. Layer 2 alone wouldn't catch cross-Mirror conflicts. Layer 3 alone would cost a signature redo for every action. Together, the common case (no conflict) costs nothing extra, and the rare cross-Mirror conflict is recoverable with at most one re-sign.

## 10.4 Why server-to-server fan-out is forbidden

If a Mirror that receives an action forwarded it to all peer Mirrors, and those Mirrors forwarded it to *their* peers, the message count would grow N² per post. The protocol's rule is therefore that **only the browser fans out**. Each Mirror is independent; cross-Mirror state convergence is achieved by the chain, not by direct coordination.

DMs are an exception (they're off-chain and have their own peer-relay path via `DmRelayService`), but the chain-economy actions never fan out server-to-server.

## 10.5 Mirror discovery

Each Mirror, on startup, performs **self-registration** by submitting a `registerInstance()` transaction to `CawNetworkManager` on L1. Peer Mirrors **discover** each other by scanning `CawNetworkManager` event logs (chunked at 50,000 blocks per RPC call due to free-tier RPC limits) and caching the `PeerInstance[]` list. Discovery refreshes every ~30 minutes.

The InstanceRegistry mechanism is itself permissionless and contract-mediated; no central directory or DNS dependency.

## 10.6 What's local vs what's shared

| Data                                     | Local to Mirror | Shared via chain |
|------------------------------------------|----------------:|-----------------:|
| TxQueue rows (signed payloads, pending)  | ✓               | —                |
| Caw / Like / Follow rows                 | ✓ (each Mirror's Pg) | ✓ (via L2 events) |
| HTTP session token (Redis auth)          | ✓               | —                |
| Cawonce                                  | —               | ✓ (on L2)         |
| User.address (NFT owner)                 | indexed         | ✓ (via L1)        |
| Marketplace state                        | indexed         | ✓ (on L1)         |
| Encrypted DMs                            | ✓ + DmRelay gossip | partial         |
| Media files (images, video)              | ✓ (operator's choice) | —             |

"Row missing on Mirror A" is not fraud — peer-authored actions arrive via L2 indexing, with delay bounded by RawEventsGatherer's polling cadence. The chain is the truth; Mirrors are caches.

## 10.7 Rebuildability

If a Mirror loses its database, it can fully recover by re-indexing from the L2 chain. Every domain row is derived from L2 events; RawEventsGatherer scans from genesis (or last checkpoint), ActionProcessor unpacks each batch's calldata, and the database is reconstructed. NFT ownership and marketplace state are re-fetched from L1. Counts are recomputed via CountManager.

What cannot be recovered: encrypted DMs (off-chain by design — sender's and recipient's Mirrors hold them, with DmRelayService gossip filling gaps), uploaded media if the operator's storage was destroyed (operators are encouraged to use replicated storage like Filebase), and in-flight TxQueue rows from the moment of loss (the user can resubmit; cawonces are idempotent on signedTx).

This is the meaning of "the chain is truth, Mirrors are caches."

---

# 11. Governance by Renunciation

CAW's governance model is the absence of governance. This is not absence-by-omission; it is absence-by-construction. Every Ownable contract is renounced post-deploy. The protocol cannot be paused, upgraded, fee-modified, or otherwise altered by any party. This section describes what that means in code and why the design is deliberate.

## 11.1 The renounce timeline

```
   PHASE 1 — DEPLOY
   ─────────────────────────────────────────────────────────────
     Deployer EOA owns every contract.
     Can: transferOwnership, setPeer (LayerZero), upgrade*
     Status: trust the deployer.

   PHASE 2 — ONLYONCE GUARDS FIRE
   ─────────────────────────────────────────────────────────────
     Every "set once at deploy" function executes its OnlyOnce(key)
     wrapper. Re-entry permanently blocked at storage level.
     Status: most config locked.

   PHASE 3 — TRANSFER OAPP OWNERSHIP TO PATHWAYEXPANDER
   ─────────────────────────────────────────────────────────────
     CawProfile, CawProfileL2, CawActionsArchive, CawChallengeRelay
     transfer their Ownable ownership to PathwayExpander.

     PathwayExpander's permitted actions:
       ✓ addPeer(oapp, eid, peerAddress)   ← only when peers[eid]==0
       ✗ setPeer                ← cannot reconfigure existing peers
       ✗ transferOwnership / renounce on the OApp
       ✗ any administrative function
       ✗ anything else

     Status: extensible to new chains; NOT mutable on existing ones.

   PHASE 4 — RENOUNCE EVERYTHING
   ─────────────────────────────────────────────────────────────
     All non-OApp Ownables → transferOwnership(0).
     PathwayExpander itself → transferOwnership(0).

     Status: no admin anywhere. New chains cannot be added.
             Protocol is permanently frozen in its current shape.
```

After Phase 4, the protocol's only mutation surface is whatever its public-facing functions allow — and those functions never accept admin input. There is no setter for fees, no setter for action costs, no setter for the verifier address, no pause function.

## 11.2 The PathwayExpander mechanic

The reason Phase 4 exists as a separate decision (rather than being merged into Phase 3) is that LayerZero OApps must have a configured peer for each chain they communicate with. If the deployer renounces ownership entirely at Phase 3, the protocol can never add a new chain to the mesh. That is too aggressive: CAW should be able to extend to chains that don't exist yet (Solana via LZ Sol-EVM, or new EVM L2s).

`PathwayExpander` is the surgical compromise. It is the owner of every LayerZero OApp after Phase 3. Its ABI exposes exactly one mutating function — `addPeer(oapp, eid, peerAddress)` — and that function reverts unless `oapp.peers[eid] == 0`. In other words: PathwayExpander can add a peer for a chain that doesn't have one, but it can never overwrite an existing peer.

Why this matters: a malicious deployer who retained PathwayExpander ownership could still not change *anything about existing chains*. They could only extend the mesh. And the deployer can — and should — renounce PathwayExpander itself in Phase 4, terminating even that capability.

The result: a protocol that is provably extensible (the OApp peer model allows new chains) and provably immutable (existing peers and ownership are non-mutable, and the only extender contract is itself renounced).

## 11.3 What about critical bugs?

If a critical bug is discovered in a CAW contract, there is no upgrade path. The response is the same as Bitcoin's response to a critical bug: redeploy, and let the social consensus of users, frontends, and Networks decide which deployment is canonical.

This is a deliberate trade. A protocol with an upgrade path has a permanent attack surface: the upgrade authority itself becomes a target (key compromise, governance capture, regulatory pressure on multisig signers). A protocol without an upgrade path is invulnerable to those attacks, at the cost of being unable to fix bugs in place.

CAW accepts the trade. The mitigation is rigor in the deploy: extensive testing, fork-testing against real bytecode, equivalence-testing of the ZK circuit against the Solidity implementation, multi-pass security review, and a candid public statement that the deploy is permanent.

## 11.4 What about fee evolution?

A Network operator may adjust their own fee gates (via `CawNetworkManager`), and a fee lockdown flag lets a Network commit to never raising fees on a given lever. Action costs and the cap parameters are baked into `CawActions` and cannot change after deploy. The protocol's economic parameters are therefore split:

- **Per-Network fees** (mint, auth, deposit, withdraw): adjustable by Network operator, subject to the withdraw-fee locking semantics that protect users from retroactive increases.
- **Protocol-wide action costs** (CAW per LIKE, etc.): immutable post-deploy.
- **Protocol-wide action caps** (ETH per LIKE, etc.): immutable post-deploy.

If a critical economic parameter needs adjustment, the response is the same as for a critical bug: redeploy + fork. The protocol's economic constitution, like its code, is meant to be fork-able rather than upgradable.

## 11.5 Why ownerlessness is a feature, not a bug

The recurring critique of immutable systems is "but what if you're wrong about X?" The honest answer is: "then we're wrong about X, and the protocol is wrong about X, until either users migrate or we redeploy." CAW chooses this because the alternative — a protocol with admin keys — has a strictly worse failure mode: admin compromise, governance capture, regulatory subpoena. Those failure modes are *not hypothetical*. They are observed in production on every social platform that has admin keys.

Ownerlessness trades the ability to fix bugs against the inability to be coerced. CAW's wager is that the second guarantee is more valuable than the first capability.

For the manifesto's own statement of this, see §3.1 and Appendix E.

---

# 12. Comparison & Positioning

This section places CAW alongside the major alternatives in decentralized social. The comparison is necessarily imperfect — each system optimizes for different properties — but mapping CAW against incumbents is the fastest way to understand what it is and is not.

## 12.1 vs Twitter/X (centralized social)

| Axis                  | Twitter/X                                       | CAW                                                                |
|-----------------------|-------------------------------------------------|--------------------------------------------------------------------|
| Custody of identity   | Held by platform; can be suspended              | NFT held by user's wallet; cannot be revoked                       |
| Data ownership        | Platform owns content; user grants license      | Content is in L2 calldata; nobody owns the chain                   |
| Moderation            | Centralized; platform decides                   | Per-frontend; protocol does not moderate                           |
| Business model        | Ads + subscription; platform revenue            | None; protocol takes no fees                                       |
| Censorship            | Platform can globally remove                    | Only frontend-level; protocol record permanent                     |
| Account portability   | Effectively impossible                          | NFT is the account; portable across every CAW frontend              |
| Operator risk         | Platform shutdown = total loss                  | Network operator failure = use a different Network                  |
| Cost per action       | "Free" (ad-subsidized)                          | Paid in CAW; ETH-capped to remain affordable                       |

Twitter/X is custodial, ad-funded, and centrally moderated. CAW is non-custodial, user-paid, and protocol-immoderate. The two are not direct substitutes in the experience sense — Twitter offers a curated, ad-funded river of attention; CAW offers a paid, permanent record — but they target the same human use case (broadcast short messages to a network of followers).

## 12.2 vs Nostr (relay-based)

| Axis                  | Nostr                                           | CAW                                                                |
|-----------------------|-------------------------------------------------|--------------------------------------------------------------------|
| Identity              | Public-key (no anchor)                          | ERC-721 NFT (anchored on Ethereum mainnet)                          |
| Storage               | Relays (best-effort, voluntary)                 | L2 calldata (permanent) + archive replication                       |
| Durability            | Depends on relay set; ad-hoc                    | Cryptographic permanence; tied to chain persistence                  |
| Discoverability       | Relay-aggregated                                | Indexed by every Mirror in every Network                            |
| Cost                  | Free (relay-operator funded)                    | Paid in CAW per action                                               |
| Spam control          | Proof-of-work (NIP-13) or relay rules           | On-chain economic gate (CAW cost per action)                        |
| Key recovery          | Open problem; voluntary recovery schemes        | NFT-anchored; standard wallet recovery applies                       |
| Censorship            | Relay-level; user can move to another relay     | Frontend-level; user can use any frontend                            |

Nostr and CAW share an ideological alignment (decentralization, censorship resistance, key-based identity) but diverge sharply on durability and identity. Nostr's relays are interchangeable, which is liberating but also means there is no guarantee that a post from 2027 will be retrievable in 2037; it depends on whether some relay continues to host it. CAW's storage layer is an EVM chain, with the same persistence properties as Ethereum itself. The trade is that CAW posts cost (in CAW tokens); Nostr posts are free.

Nostr's lack of an identity anchor is also significant. A Nostr key compromise is permanent; there is no recovery mechanism comparable to Ethereum's NFT-based ownership. CAW's identity-as-NFT means standard wallet recovery (hardware wallet, seed phrase, social recovery wallets) all apply.

## 12.3 vs Bluesky / AT-Proto (federated)

| Axis                  | Bluesky / AT-Proto                              | CAW                                                                |
|-----------------------|-------------------------------------------------|--------------------------------------------------------------------|
| Identity              | DID + handle; portable via DID resolution        | ERC-721 NFT                                                          |
| Storage               | Personal Data Server (operator)                  | L2 calldata (chain) + archive                                       |
| Moderation            | Per-host + composable labelers                  | Per-frontend (entirely client-side)                                  |
| Account portability   | Yes (move PDS, keep handle)                      | Yes (NFT-native)                                                     |
| Trust assumption      | PDS operator + relay + appview                   | Chain validity + 1 honest archive observer / 2 days                 |
| Cost                  | Free (operator-funded)                           | Paid in CAW                                                          |
| Governance            | Bluesky-Inc.-led; "credible exit" by design     | Renounced; no governance                                             |
| Censorship resistance | PDS can refuse; alternative PDSes available     | Frontend can refuse; chain record persists                           |

Bluesky/AT-Proto is the closest in spirit among federated protocols — it explicitly designs for "credible exit," in which a user dissatisfied with their host PDS can migrate to a different PDS without losing their handle or data. CAW achieves a similar property structurally (the NFT is the account; any Network's frontend works) but goes further in two directions: there is no governing organization (CAW is renounced from day one), and the data layer is a public chain rather than per-operator storage.

The trade is performance and cost. Bluesky is faster (no on-chain settlement) and free at the point of use. CAW is permanent (chain-anchored) and paid.

## 12.4 vs Farcaster (hub-topology hybrid)

| Axis                  | Farcaster                                       | CAW                                                                |
|-----------------------|-------------------------------------------------|--------------------------------------------------------------------|
| Identity              | FID via on-chain registry                        | ERC-721 NFT                                                         |
| Storage               | Hubs (off-chain) with chain-anchored identity    | L2 calldata (chain) + archive                                       |
| Storage permanence    | Hub-dependent; not chain-anchored                | Chain-permanent                                                      |
| Governance            | Foundation + protocol DAO                        | Renounced; no governance                                             |
| Cost                  | Free (gas only at registry)                      | Paid in CAW per action                                               |
| Account portability   | Yes (key rotation via on-chain registry)         | Yes (NFT-native)                                                     |
| Moderation            | Client-side                                      | Client-side (frontend-side)                                          |

Farcaster pioneered the "anchor identity on-chain, store activity off-chain" pattern, which is more performant than full-chain storage but accepts that hub failure could lose activity. CAW takes the opposite trade: full-chain storage at non-zero cost, but with chain-grade permanence guarantees.

Farcaster also has governance (the Farcaster Foundation, protocol-level decisions) whereas CAW has none. This is a deliberate philosophical divergence: Farcaster bets on stewarded evolution; CAW bets on petrification.

## 12.5 What CAW does that nobody else does

Three architectural choices distinguish CAW from each of the above:

1. **Action data as L2 calldata.** No competitor stores social actions as calldata on a public blockchain. Nostr stores on relays; Bluesky on PDSes; Farcaster on hubs; Twitter on AWS. CAW stores on Base, Polygon, or whichever L2 the relevant Network chose — with the same persistence guarantee as the chain itself.

2. **ETH-denominated cost caps on a renounced protocol.** No competitor has a fixed-cost protocol with a price-resilience mechanism. Most either have no cost (centralized + subsidized) or a fully variable cost (gas-priced). CAW's TWAP-bounded cap lets a renounced protocol remain usable across orders-of-magnitude token-price moves.

3. **Multi-Network mesh under one identity anchor.** No competitor has the "many Networks, one identity" structure. Bluesky has federation, but the same protocol-level decisions. Farcaster has hubs, but one identity registry. CAW has Networks that pick their own L2, their own fee gates, their own validator set — all under one L1 anchor and one CAW token. This is the closest analogue to DNS in social: many hosts, one root.

CAW does not claim to be better at every axis. It is slower than Bluesky, more expensive than Nostr, and less curated than Twitter. The claim is that the *combination* of properties — permanent storage, anchored identity, renounced governance, cost capping, multi-Network mesh — is novel and worth the trade-offs for users who weight permanence and censorship resistance above performance.

---

# 13. Roadmap

CAW is not roadmap-driven in the conventional sense — the protocol is immutable, so it cannot "ship features" the way a software product can. What evolves is the surrounding ecosystem: Networks, frontends, native clients, additional L2 venues. The protocol's deploy-time decisions enable or constrain that evolution; this section sketches the directions the design supports.

## 13.1 Multi-Network ecosystem

CAW's structure supports many Networks under one L1 anchor. The roadmap envisions:

- **Specialized Networks**: a Network optimized for high-throughput, low-cost interactions (e.g. Polygon-based); a Network optimized for premium identity (e.g. Ethereum-mainnet-based, higher per-action gas but no L2 dependency); regional Networks complying with regional moderation requirements while remaining inter-operable.
- **Specialized frontends**: frontends optimized for journalists, communities, professional groups, etc. — each making different moderation, ranking, and feature decisions on the same underlying protocol.
- **Specialized validators**: validators optimizing for batch throughput (high-volume) or for fraud monitoring (high availability, deep stake).

The protocol does not anticipate or curate which Networks emerge. The permissionless registration via `CawNetworkManager` is the only gatekeeping.

## 13.2 Native passkey client

A native iOS/Android client is in active development alongside the browser-first passkey path. The architecture (documented in `native/docs/`) uses EIP-7702 for authority delegation and WebAuthn (EIP-7951) for biometric-protected signing. Backup is via a password-encrypted blob (Argon2id + AES-GCM-256) stored to iCloud Drive, Google Drive, or local export; there is no seed phrase. The same `SmartEOA.sol` contract and backup format underpin both browser and native clients.

The native client's primary user-experience claim is: a user with no Web3 experience can buy CAW with Apple Pay or Google Pay, mint a username, and start posting — all with biometric unlocks and no seed phrase to manage. The wager is that this is the experience needed to bring CAW to a mainstream audience without abandoning the protocol's non-custodial guarantees.

## 13.3 Additional L2 venues via PathwayExpander

If a future L2 — for instance, a zkEVM rollup or a new optimistic rollup — becomes attractive as an action-processing venue, the path to support it is:

1. Deploy `CawActions`, `CawActionsERC1271`, `CawProfileL2`, `CawChallengeRelay`, `CawCapOracle` to the new chain.
2. Configure the new contracts' LayerZero endpoints.
3. Use `PathwayExpander.addPeer()` to wire the new chain into the existing OApp mesh.
4. Networks may now register with the new chain as their `storageChainEid`.

This is a permissionless extension. The deployer of the new contracts is not the deployer of the protocol; they merely deploy and register. The protocol does not endorse, audit, or guarantee any particular L2 venue — the same way DNS doesn't audit individual top-level domains.

## 13.4 Solana option

A speculative analysis of a Solana deployment lives in `docs/SOLANA_OPTION.md`. The case for Solana is **not** gas savings — at CAW's batch sizes, Solana's 1232-byte transaction-size limit collapses the batching advantage that makes EVM cheap, and per-action cost works out roughly the same or marginally worse than on Base. The case is **chain-survival hedge**: Solana is an L1 (not an L2 that depends on Ethereum settlement, on a rollup operator, or on a multisig-controlled bridge), with a validator set several thousand strong, two independent client implementations (Firedancer and Agave), and its own validator economics. Client diversity at the consensus layer is something no EVM L2 currently offers.

What this would buy CAW, if it were ever pursued, is a chain-survival hedge for the historical record. If every EVM L2 the protocol has been deployed to gets sunsetted, deprecated, or governance-captured over a 10–20 year horizon, an archive deployment on Solana means the protocol's history survives independently of the EVM ecosystem's specific trajectory. The CAW token and the username NFT registry remain anchored to Ethereum L1 — that is the *primary* survival guarantee — so Solana would be a secondary archive, not a replacement for any existing chain.

This is not on the deployment roadmap. The honest scope is ~10–14 months of parallel implementation: Solidity does not port to Rust; every contract is rewritten. The analysis is documented so that the protocol's structure does not preclude non-EVM extensions, and so that if the community wishes to develop and fund such an effort — likely triggered by an EVM-side incident or a Solana-experienced contributor stepping forward — the design path exists.

## 13.5 Petrification

The end state of CAW, as conceived, is **petrification**. The contracts are deployed; the OApps are wired; the deployer renounces; the PathwayExpander is renounced. From that moment, the protocol is a public utility — a fixed shape that anyone can build on, criticize, fork, or ignore, but that nobody can change.

The continued evolution of CAW after petrification happens entirely at the ecosystem layer: more Networks register, more frontends launch, more clients (native, browser-extension, command-line) emerge. The protocol itself is what it is.

This is the manifesto's vision realized:

> *"CAW is by design without design, and it is up the CAWMmunity to shape CAW. Only by giving you the vision and seeing what comes next may we have a truly free and decentralized system."*

---

# Appendix A — Glossary

**Action** — A single CAW operation (post, like, follow, etc.) signed by a user via EIP-712 and processed atomically by `CawActions.processActions()`, `CawActions.processActionsWithZkSigs()`, or `CawActionsERC1271.processActionsERC1271()`.

**Action types** — Seven enum values: CAW (0, post), LIKE (1), UNLIKE (2), RECAW (3), FOLLOW (4), UNFOLLOW (5), WITHDRAW (6), OTHER (7). The OTHER type is multiplexed by a text-prefix marker — `p:` (profile update), `tip:` (tip), `vote:` (poll vote), `hide:` (hide a caw or recaw), `pi:` (pin), `xpi:` (unpin).

**Archive chain** — A chain on which `CawActionsArchive` is deployed and to which validators replicate L2 activity. Chosen per-validator; a canonical pairing is Base ↔ Arbitrum.

**batchHash** — `keccak256(packedActions)`. Emitted as the payload of `ActionsProcessed`. Indexers reconstruct the batch by fetching the originating L2 transaction's calldata and validating against batchHash.

**Cawonce** — Per-`(tokenId, action)` nonce, monotonic. Enforces ordering and prevents replay. Concurrency across tabs/devices/Mirrors is coordinated by the allocator (chain truth → local watermark → 409 retry).

**Checkpoint** — Group of 32 actions on L2. Each checkpoint hash is a leaf in the validator's archive merkle tree.

**Depositor pool** — Every account that currently holds a CAW balance on the relevant L2. The pool receives a percentage of every CAW action (20% of LIKE/FOLLOW, 50% of RECAW, 100% of CAW post), distributed proportionally to balance.

**EID** — LayerZero endpoint identifier. Each chain has a unique EID; the protocol uses EIDs to address cross-chain messages and identify peers.

**ERC-1271 sibling** — `CawActionsERC1271`, the co-deployed contract that handles variable-length signatures (passkey assertions, Safe signatures, etc.) by calling `isValidSignature` on the owner before calling back into `CawActions` in pre-verified-signer mode.

**L1** — Ethereum mainnet. The anchor for the CAW token, the NFT identity space, the Network registry, the price oracle source, and the marketplace.

**L2** — An action-processing chain (Base, Polygon, etc.). Each Network selects its L2 at registration.

**L2-archive** — A chain hosting `CawActionsArchive` for long-term replication. Distinct from L2 (where actions are originally processed).

**LayerZero / LZ** — The cross-chain messaging protocol used for L1 ↔ L2 (deposits, withdraws, ownership sync, price samples) and L2 → archive (fraud-proof relay).

**Mirror** — One FE/server pair within a Network. A Network may run several Mirrors. Mirrors of the same Network share the Network's social graph; Mirrors of different Networks do not.

**Network** — The operator-tier entity in CAW. A registered Network has its own L2 venue, fee gates, validator set, and social graph. Networks coexist under one L1.

**OApp** — LayerZero Omnichain Application. CAW's cross-chain contracts (`CawProfile`, `CawProfileL2`, `CawActionsArchive`, `CawChallengeRelay`) are OApps.

**packedActions** — Tightly-packed byte representation of a batch of actions, submitted as calldata to `processActions` (fixed 67-byte-per-group wire format) or `processActionsERC1271` (variable-length). Subject to the 30KB cap.

**packedSigs** — Tightly-packed byte representation of the signatures for a batch, paired with packedActions. Signatures are grouped by signer with an r-anchor reuse for hash-chain efficiency.

**PathwayExpander** — A sentinel contract that owns CAW's OApps after the deployer renounces. Its only permitted action is `addPeer()`; it cannot reconfigure or transfer.

**Quick Sign** — CAW's session-key feature. An ephemeral keypair authorized by a single wallet signature, with on-chain scope/spend/expiry bounds.

**Session key** — See Quick Sign.

**smltxt** — Proprietary text compression scheme used to fit longer caws in fewer bytes. Compression ratio is typically 3× to 5×.

**Slash** — The taking of a validator's entire archive stake (currently 0.01 ETH) on successful fraud proof. Pending submissions are bulk-invalidated.

**Submission** — A validator's archive commitment of up to 256 checkpoints (= 8,192 actions max) with one merkle root.

**TWAP** — Time-weighted average price. CAW uses a 7-day TWAP of the burned-LP Uniswap V2 CAW/WETH pair for the action cost cap.

**TxQueue** — A Mirror-local Postgres table holding signed payloads awaiting batch submission to L2.

---

# Appendix B — Contract Inventory

| Contract                       | Layer        | File path                                                                  | Renounced? |
|--------------------------------|--------------|----------------------------------------------------------------------------|:----------:|
| MintableCaw                    | L1           | `solidity/contracts/MintableCaw.sol`                                       | 🔒 |
| CawProfile                     | L1           | `solidity/contracts/CawProfile.sol`                                        | 🔒 (OApp owner → PathwayExpander) |
| CawProfileMinter               | L1           | `solidity/contracts/CawProfileMinter.sol`                                  | 🔒 |
| CawProfileMarketplace          | L1           | `solidity/contracts/CawProfileMarketplace.sol`                             | 🔒 |
| CawProfileURI                  | L1           | `solidity/contracts/CawProfileURI.sol`                                     | 🔒 |
| CawFontDataA                   | L1           | `solidity/contracts/CawFontDataA.sol`                                      | 🔒 |
| CawFontDataB                   | L1           | `solidity/contracts/CawFontDataB.sol`                                      | 🔒 |
| CawBuyAndBurn                  | L1           | `solidity/contracts/CawBuyAndBurn.sol`                                     | 🔒 |
| CawL1PriceReader               | L1           | `solidity/contracts/CawL1PriceReader.sol`                                  | (immutable, no owner) |
| CawNetworkManager              | L1           | `solidity/contracts/CawNetworkManager.sol`                                 | 🔒 (Network owners retain per-Network fee setters) |
| CawActions                     | L2           | `solidity/contracts/CawActions.sol`                                        | 🔒 |
| CawActionsERC1271              | L2           | `solidity/contracts/CawActionsERC1271.sol`                                 | 🔒 |
| CawProfileL2                   | L2           | `solidity/contracts/CawProfileL2.sol`                                      | 🔒 (OApp owner → PathwayExpander) |
| CawChallengeRelay              | L2           | `solidity/contracts/CawChallengeRelay.sol`                                 | 🔒 (OApp owner → PathwayExpander) |
| CawCapOracle                   | L2           | `solidity/contracts/CawCapOracle.sol`                                      | 🔒 |
| CawActionsArchive              | L2-archive   | `solidity/contracts/CawActionsArchive.sol`                                 | 🔒 (OApp owner → PathwayExpander) |
| SP1VerifierGroth16             | L2 (vendor)  | `solidity/contracts/sp1-vendor/SP1VerifierGroth16.sol`                     | (immutable, vendor contract) |
| PathwayExpander                | L1 + L2 + archive | `solidity/contracts/PathwayExpander.sol`                              | 🔒 (after Phase 4) |
| OnlyOnce                       | (mixin)      | `solidity/contracts/OnlyOnce.sol`                                          | n/a (abstract) |
| SigVerification                | (library)    | `solidity/contracts/SigVerification.sol`                                   | n/a (library) |
| SmartEOA                       | (delegate)   | `solidity/contracts/SmartEOA.sol`                                          | n/a (deployed once; users' EOAs delegate to it via EIP-7702 type-0x04 authorization) |
| ISmartEOA                      | (interface)  | `solidity/contracts/ISmartEOA.sol`                                         | n/a (interface) |

For per-contract function inventory and natspec, see `solidity/contracts/` directly.

---

# Appendix C — Constants Reference

| Constant                          | Value                | Source                                                |
|-----------------------------------|----------------------|-------------------------------------------------------|
| `MIN_STAKE`                       | 0.01 ETH             | `CawActionsArchive.sol`                               |
| `CHALLENGE_PERIOD`                | 2 days               | `CawActionsArchive.sol`                               |
| `CHECKPOINT_INTERVAL`             | 32 actions           | `CawActions.sol`, `CawActionsArchive.sol`             |
| `MAX_CHECKPOINTS_PER_SUBMISSION`  | 256                  | `CawActionsArchive.sol`                               |
| `MAX_PENDING_SUBMISSIONS` (default) | 1                  | `ValidatorService` (operator-tunable)                 |
| `L2B_CALLDATA_LIMIT`              | 30,000 bytes         | `ValidatorService/index.ts`                           |
| `CHALLENGE_GAS_BASE`              | 60,000               | `CawChallengeRelay.sol`                               |
| `CHALLENGE_GAS_PER_CP`            | 55,000               | `CawChallengeRelay.sol`                               |
| `ERC1271_GAS_LIMIT`               | 50,000               | `CawActions.sol`, `CawActionsERC1271.sol`, `SigVerification.sol` |
| EIP-170 contract size cap         | 24,576 bytes         | Ethereum protocol                                     |
| Action cap window (TWAP)          | 7 days               | `CawCapOracle.sol` (TWAP_WINDOW)                      |
| Stale-sample threshold (oracle)   | 24 hours             | `CawCapOracle.sol` (STALE_THRESHOLD)                  |
| Stale-pushed-ratio threshold      | 24 hours             | `CawActions.sol` (CAP_STALE_THRESHOLD)                |
| TWAP minimum window               | 1 day                | `CawCapOracle.sol` (MIN_WINDOW)                       |
| TWAP ring buffer size             | 1024                 | `CawCapOracle.sol` (BUFFER_SIZE)                      |
| Cap-push hysteresis               | 100 bps              | `CawCapOracle.sol` (`_movedMoreThanBps`)              |
| Action cap, LIKE                  | 2 × 10¹¹ wei         | `CawActions.sol` (CAP_LIKE)                           |
| Action cap, UNLIKE/UNFOLLOW       | 1 × 10¹¹ wei         | `CawActions.sol` (CAP_UNLIKE/CAP_UNFOLLOW)            |
| Action cap, RECAW                 | 4 × 10¹¹ wei         | `CawActions.sol` (CAP_RECAW)                          |
| Action cap, CAW post              | 5 × 10¹¹ wei         | `CawActions.sol` (CAP_CAW)                            |
| Action cap, FOLLOW                | 30 × 10¹¹ wei        | `CawActions.sol` (CAP_FOLLOW)                         |
| Baseline CAW, CAW post            | 5,000                | `CawActions.sol`                                      |
| Baseline CAW, LIKE                | 2,000                | `CawActions.sol`                                      |
| Baseline CAW, RECAW               | 4,000                | `CawActions.sol`                                      |
| Baseline CAW, FOLLOW              | 30,000               | `CawActions.sol`                                      |
| Baseline CAW, UNLIKE/UNFOLLOW     | 1,000                | `CawActions.sol`                                      |
| Quick Sign max expiry             | 30 days              | (server-enforced)                                     |
| Quick Sign scope: WITHDRAW excluded | bit 6 always 0     | `CawProfileL2.sol`                                    |
| Quick Sign default scope bitmap   | 0xBF                 | (server default)                                      |
| Cawonce local watermark TTL       | 5 minutes            | `client/src/services/FrontEnd/src/utils/cawonceAllocator*.ts` |
| One-time auth sig TTL             | 5 minutes            | `client/src/api/*` (Redis SET NX EX 300)              |
| Peer discovery refresh cadence    | ~30 minutes          | `InstanceRegistryService`                             |
| TxQueue poll cadence              | ~10 seconds          | `ValidatorService`                                    |
| Replication loop cadence          | ~120 seconds         | `ValidatorService.optimisticReplicationLoop`          |
| RPC log scan chunk                | 50,000 blocks        | (free-tier RPC limit)                                 |
| LZ fee buffer (routine paths)     | 120%                 | `CawProfile.sol`, `CawProfileL2.sol`                  |
| LZ fee buffer (slash-adjacent)    | 150%                 | `CawChallengeRelay.sol`                               |
| ZK path verifier gas (fixed)      | ~265,000             | (measured against canonical SP1VerifierGateway bytecode) |
| ZK path break-even batch size     | ~70 actions          | `docs/ZK_SIG_PATH.md`                                 |

---

# Appendix D — Action Types & Cost Table

| Type | Wire enum | Cost (CAW) | Split                                       | Scope bit | ETH cap (wei)  |
|------|----------:|-----------:|---------------------------------------------|----------:|---------------:|
| CAW (post)  | 0 |  5,000 | 100% depositor pool                        | 0         | 5 × 10¹¹       |
| LIKE        | 1 |  2,000 | 80% receiver / 20% depositor pool          | 1         | 2 × 10¹¹       |
| UNLIKE      | 2 |  1,000 | 100% validator                              | 2         | 1 × 10¹¹       |
| RECAW       | 3 |  4,000 | 50% receiver / 50% depositor pool          | 3         | 4 × 10¹¹       |
| FOLLOW      | 4 | 30,000 | 80% followee / 20% depositor pool          | 4         | 30 × 10¹¹      |
| UNFOLLOW    | 5 |  1,000 | 100% validator                              | 5         | 1 × 10¹¹       |
| WITHDRAW    | 6 | gas + LZ | (no protocol distribution)                 | **6 (excluded from session-key scope)** | uncapped |
| OTHER       | 7 | varies | depends on prefix (see below)              | 7         | uncapped       |

WITHDRAW cannot be signed by a session key; it must be signed by the NFT owner's wallet directly, or — for passkey-backed contract-owned profiles — by the owner via the `CawActionsERC1271` sibling path.

### OTHER prefix multiplexing

| Prefix     | Subtype           | Notes                                                    |
|------------|-------------------|----------------------------------------------------------|
| `p:`       | Profile update    | Avatar, bio, theme; consumed by frontends                |
| `tip:{n}`  | Tip               | `n` whole CAW; sent to caw author or any recipient        |
| `vote:{i}` | Poll vote         | Vote for option index `i` of a poll embedded in a caw   |
| `hide:`    | Hide content      | `hide:caw:{id}` or `hide:recaw:*` — viewer-local hide list |
| `pi:`      | Pin               | Pin a caw to the user's profile                          |
| `xpi:`     | Unpin             | Remove a pin                                             |

Frontends are free to introduce additional OTHER prefixes for new social primitives without protocol changes; the protocol records the action as OTHER and lets frontends interpret the prefix.

---

# Appendix E — The Manifesto

The text below is reproduced verbatim from `docs/manifesto.txt`. It is the canonical philosophical source for CAW and predates this implementation.

> A Manifesto on a Decentralized Social Clearing House ...(AKA) CAW
>
> The concept of decentralization has been lost to some of us over time, those who forgot why Bitcoin was created, the issues blockchain and cryptocurrency is meant to solve. To be decentralized means there is no single person, entity, nor group which has ultimate control nor benefit over a system.
>
> In a decentralized system, there is not one man who via desire or persuasion could cripple the system in any meaningful way. This means from both a technical standpoint (i.e, a developer who can stop trading, or disable the protocol through the use of smart contracts) and a financial one (e.g, an entity who has n+1 (infinite) tokens, and could dump them if they so wished, but decides not to.)
>
> That is not to say that a proper decentralized system is without whales nor its own cornerstones. There are always those that may have a greater affect upon a network, or 'matter' through entropy or their own hard work.
>
> CAW began as nothing, there was no developer, no information, no medium of communication. Simply. a contract.
>
> Freedom given to the people to discover CAW's meaning amongst themselves. This has gone well, and so we would like to present our specification for the second phase of CAW. But before we do, some things must be said and taken note of:
>
>     1. This is a only a specification. It is up to the cawmmunity to write and deploy the protocol.
>     2. It is strongly recommended that a peer group is formed to develop and review smart contracts. as there is no leader in this process, all types will attempt to claim ownership of the process. there will those everso helpful who claim to be able to 'do it all' but will write the perfect code with the perfect backdoor   Only a cawmmunity reviewed and accepted contract on a public github will be acceptable
>     3. After deployment, the deployer must renounce any keys they have to the contracts. There will be no multi-sig,  no upgradeable proxyies. It will not matter who deployed because they will be equal with all with no specfic benefit nor advantage. Just get the contract right.

The full manifesto includes the user-facing protocol specification (mint costs, action costs, DM design, marketplace, image hosting) and is preserved at `docs/manifesto.txt` for reference. The protocol described in this white paper is the implementation of that specification.

---

# Appendix F — Further Reading

The white paper references documents in the repository. The most useful for depth:

**Architecture & data flow:**
- `docs/ARCHITECTURE.md` — full system architecture, service inventory, database schema
- `docs/DATA_FLOW.md` — action lifecycle, retry logic, indexing
- `docs/MULTI_CHAIN_STORAGE.md` — per-Network storage chain selection, CLI workflow

**Cryptography:**
- `docs/SESSION_KEYS.md` — Quick Sign feature, scope bitmap, encryption modes
- `docs/ZK_SIG_PATH.md` — Groth16 ZK signature recovery, measured numbers
- `docs/DIRECT_MESSAGING.md` — ECDH + AES-256-GCM DM design

**Economics:**
- `docs/ACTION_COST_CAP.md` — TWAP-based ETH cost cap, full math and rationale

**Archive & slashing:**
- `docs/REPLICATION_AND_SLASHING.md` — operator-facing guide to validator stake, fraud-proof recipes

**Marketplace & media:**
- `docs/MARKETPLACE.md` — feeless NFT marketplace contract design
- `docs/IMAGE_UPLOAD_SYSTEM.md` — pluggable media storage (Filebase, S3, local)

**Native client:**
- `native/docs/ROADMAP.md` — 8-phase native rollout plan
- `native/docs/WALLET.md` — passkey wallet design
- `native/docs/BACKUP_AND_RECOVERY.md` — encrypted-blob backup format
- `native/docs/ERC4337_REASSESSMENT.md` — why EIP-7702 was chosen over ERC-4337

**Operations:**
- `docs/VALIDATOR_MESH_NETWORK.md` — proposed validator mesh design
- `docs/ELASTICSEARCH_SETUP.md` — search indexing setup
- `docs/MIGRATIONS.md` — database/contract migration procedures

**Philosophy:**
- `docs/manifesto.txt` — the canonical source (reproduced in Appendix E)

For source-of-truth, the contracts at `solidity/contracts/*.sol` and the service implementations at `client/src/services/` are themselves the spec.

---

*End of white paper. CAW Protocol is unowned and uncopyrighted; this document is in the public domain.*
