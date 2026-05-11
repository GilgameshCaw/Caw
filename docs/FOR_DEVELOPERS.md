# Building on CAW

CAW is a trustless on-chain social protocol. The core abstraction is a **fund-based data storage layer**: spend CAW, store data forever. Posts, likes, follows, tips — all the same primitive (an `Action` with a signed payload).

This page is a builder's index. It's organized by *what you want to do*, not by what the protocol is. Each section links to the deeper docs.

## What's possible

Three orthogonal axes that can be mixed freely:

1. **Run infrastructure.** Validator nodes (submit user actions on chain, earn tips), front-end servers (serve a UI rooted in the protocol), indexers (consume the event stream for your own purposes). The protocol is permissionless — anyone can run any of these.
2. **Build a frontend.** A CAW frontend reads from a node's indexed DB and writes by signing actions. It can be a Twitter-like reader, a niche feed for one community, a wallet UI for an existing app, or anything else that wants on-chain social presence.
3. **Build smart-contract extensions.** Contracts can own profile NFTs, author actions, hold balances, accept tips, and act on incoming actions trustlessly. This is how prediction markets, GameFi, launchpads, multisig accounts, and DEX-via-tips get built **without changing the core protocol**.

CAW handles the data and identity layer. Funds movement through tips is a core primitive. **Conditional payouts** (escrow, oracle resolution, randomness) and **complex on-chain logic** live in extension contracts — buildable on top, never in the core.

---

## 1. Run infrastructure

### Run a validator node

Validators batch and submit user-signed actions to the action-processing L2. They earn the tips users include in their actions, and stake ETH on the archive chain to optimistically replicate checkpoints (slashable if they post fraud).

- **Setup**: [`client/README.md`](../client/README.md) covers Postgres, Redis, env, and the dev command.
- **Architecture**: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) → the validator service, action processor, raw events gatherer.
- **Replication & slashing**: [`docs/REPLICATION_AND_SLASHING.md`](./REPLICATION_AND_SLASHING.md) — how the optimistic archive flow works, what gets slashed, what doesn't.
- **Mesh networking (proposed)**: [`docs/VALIDATOR_MESH_NETWORK.md`](./VALIDATOR_MESH_NETWORK.md) — peer-to-peer relay for underpriced txs.
- **Networks**: see [`CLAUDE.md`](../CLAUDE.md#repository-structure) for the testnet endpoints (Sepolia, Base Sepolia, Arbitrum Sepolia archive).

### Run a frontend / read-only node

You don't have to be a validator to run a node — you can run just the indexer + API + frontend if you only want to serve content. Same setup process; just don't fund the validator wallet.

- **Setup**: [`client/README.md`](../client/README.md).
- **What a "network" is**: each frontend operator registers a `network` in the on-chain `CawNetworkManager`. The network picks its own action-processing L2 and archive chain at runtime — the protocol doesn't pin you to one. Multiple networks coexist; users can post to any of them.
- **Reading the event stream**: [`docs/DATA_FLOW.md`](./DATA_FLOW.md) shows the action → DB pipeline.

### Run a search / analytics indexer

The protocol emits `ActionsProcessed(bytes packedActions)` per submission. The bytes are the source of truth; everything downstream is a derived view.

- **Elasticsearch setup**: [`docs/ELASTICSEARCH_SETUP.md`](./ELASTICSEARCH_SETUP.md).
- **Image system**: [`docs/IMAGE_UPLOAD_SYSTEM.md`](./IMAGE_UPLOAD_SYSTEM.md).
- **Reading packed actions**: see `solidity/contracts/CawActions.sol` for the layout (the PACKED FORMAT comment block).

---

## 2. Build a frontend

The reference React frontend lives at `client/src/services/FrontEnd/`. Build on top of it, or write your own — anything that can sign EIP-712 messages can post to CAW.

### Sign and submit actions

- **EIP-712 schema**: see `solidity/contracts/CawActions.sol`. Two top-level structs: `ActionData` (single action) and `ActionBatch` (one signature over many actions). The wire format is packed bytes; helpers in the test files (`solidity/test/*.js`) show how to construct and pack actions in JavaScript.
- **Session keys (Quick Sign)**: [`docs/SESSION_KEYS.md`](./SESSION_KEYS.md) — scoped, spend-capped delegation so users don't have to sign every action. The standard UX flow on the reference frontend.
- **API surface**: see `client/src/services/Api/` for the REST endpoints (signing → queue → validator submission).

### Custom action markers

Polls, prediction markets, image attachments, and other rich content types are implemented as **inline markers in the action's `text` field** (e.g. `::poll:opt1:opt2::`, `::market:question::`, `::echo:msg::`). The marker is just convention — the frontend decides how to render it. New markers don't require protocol changes.

- **Poll example**: see commit `dd2d399` and the renderer in `client/src/services/FrontEnd/`.
- **smltxt compression**: [`smltxt/README.md`](../smltxt/README.md) — action text is compressed end-to-end; you'll want to use the library when authoring.

### Profile marketplace, DMs, search, notifications

All built on the same action primitive, no special protocol paths:
- **Marketplace**: [`docs/MARKETPLACE.md`](./MARKETPLACE.md) — fixed price, Dutch auction, English auction, offers. 0% protocol fee.
- **DMs**: [`docs/DIRECT_MESSAGING.md`](./DIRECT_MESSAGING.md) — E2E encrypted via ECDH + AES-256-GCM.
- **Action type catalog**: [`docs/OTHER_ACTION_TYPES.md`](./OTHER_ACTION_TYPES.md) — likes, follows, profile updates, etc.

### Ramp + biometric wallets (UX)

For non-crypto-native users: fiat on-ramp + biometric-encrypted wallet keys means they sign up like any app (email, Face ID, credit card) and get a real wallet + real profile. Same on-chain primitives, hidden behind familiar UX. This is the right pattern for onboarding mass-market users without compromising trustlessness.

---

## 3. Build smart-contract extensions

Smart contracts can fully participate in CAW: own profile NFTs, author actions, hold balances, accept tips, and react to incoming actions trustlessly. This is how prediction markets, GameFi, launchpads, and other on-chain extensions get built on top of CAW without changes to the core protocol.

### The main reference

**[`solidity/CONTRACT_OWNED_PROFILES.md`](../solidity/CONTRACT_OWNED_PROFILES.md)** is the canonical guide. Read it once before building.

### Authorize actions from a contract (ERC-1271)

Contracts implement `isValidSignature(bytes32 hash, bytes sig)` to authorize actions from the profile they own. CawActions falls back to 1271 when ecrecover doesn't match the NFT owner.

- **How verification works**: `CONTRACT_OWNED_PROFILES.md` → "How verification works".
- **Three patterns**: re-sign with an authorized EOA, state-lookup proof, or delegated user authorizations.
- **Gas budget**: 50,000 stipend on the 1271 staticcall, gas-bounded against malicious owner contracts.
- **Reference**: `solidity/contracts/mocks/MockContractOwner.sol`.
- **Multisig example**: `solidity/contracts/examples/CawMultisigProfile.sol` — M-of-N, Pattern B (state-lookup).

### React to incoming actions trustlessly

The protocol intentionally doesn't provide callbacks during `processActions` (gas griefing, reentrancy, unbounded coupling). React off chain via a watcher that posts a separate "fulfill" tx.

- **Trusted-watcher pattern** (cheap, fine for most cases): permissionless relayer + bounty + user-side fallback.
- **Trustless-watcher pattern** (real correctness guarantee): verify the action against the protocol's per-network rolling hash chain.
- **Verifier**: `solidity/contracts/examples/CawActionVerifier.sol` — folds a 32-action checkpoint slice + per-action `r` anchors and checks they match the canonical hash.
- **Worked example**: `solidity/contracts/examples/CawTipResponder.sol` + `solidity/test/action-verifier-test.js`.

### Patterns for common extensions

| Pattern | Use case | What you need |
|---|---|---|
| Pay-to-enter | Chat rooms, games, paid content | Just on-chain tip + node-side gate. No extra contracts. |
| Prediction market | Bet on real-world outcomes | Contract owns a profile (1271), holds escrow, oracle resolves, contract pays out. |
| GameFi pay-to-win | Real-money game payouts | Same as prediction market + VRF for randomness. |
| Launchpad | Token distribution with social presence | Contract owns a profile (1271), holds funds, distributes on a schedule. |
| Multisig profile | Shared ownership of a profile | Pattern B 1271 (see `CawMultisigProfile`). |
| DEX-via-tips | Tip in CAW, receive an ERC-20 | 1271 to author response actions + verifier for trustless fulfillment. |

The protocol doesn't ship these as products — they're things you can build. The pattern is consistent: **CAW handles data + identity + tips; your contract handles escrow + conditional payouts + custom logic.**

### Things to know

- **Oracle trust ≠ protocol trust.** Anything that bridges to off-chain reality (sports scores, weather, "did X happen") inherits the trust model of the oracle. UMA optimistic, Chainlink, designated reporter, multi-sig committee — pick what fits. CAW doesn't take a position on which.
- **No callbacks during action processing.** If your contract needs to react, run a watcher (see above).
- **Replay protection is automatic.** The protocol's per-senderId `cawonce` bitmap prevents the same action from being submitted twice. Don't reinvent it in your contract.
- **Gas budgets matter.** 1271 staticcalls cap at 50k. If your `isValidSignature` needs more, you're probably doing something that shouldn't be in the verification path.

---

## Contracts you'll interact with

| Contract | Role | Where |
|---|---|---|
| `CawActions` | Core action processor — verify sigs, fold hash chain, emit events | L2 (per-network) |
| `CawProfile` | ERC-721 profile NFT, name service, L1 deposit + LZ sync | L1 |
| `CawProfileL2` | L2 mirror, ownership-of-record for action verification | L2 |
| `CawProfileMinter` | Mint profiles (CAW-burn or zap-with-ETH) | L1 |
| `CawProfileMarketplace` | Trustless 0% fee profile trading | L1 |
| `CawNetworkManager` | Per-network config (action L2, archive chain, fees) | L1 |
| `CawActionsArchive` | Optimistic archive with slashable validator stakes | Archive chain |
| `CawChallengeRelay` | Cross-chain fraud-proof relay | L2 → Archive |

Constructor args and deployment details: [`docs/MULTI_CHAIN_STORAGE.md`](./MULTI_CHAIN_STORAGE.md).

---

## Get help / contribute

- **Telegram**: [@cawbuilders](https://t.me/cawbuilders)
- **Twitter**: [@caw_dev](https://x.com/caw_dev)
- **Manifesto**: [`docs/manifesto.txt`](./manifesto.txt) — the why.
- **Open issues**: see `BACKLOG.md` and `PROJECT_BACKLOG.md` for what's in flight.
