# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CAW Protocol is a trustless and decentralized social clearing-house focused on freedom of speech. The project consists of smart contracts, backend services, and a React frontend.

## Repository Structure

- `solidity/` - Smart contracts for mainnet and L2 deployment
- `client/` - Backend services and infrastructure
- `client/src/services/FrontEnd/` - React frontend application
- `UI_CONSISTENCY_STANDARD.md` - UI guidelines for post display consistency

## Development Commands

### Root Level
- `npm start` - Start Redis and API services concurrently
- `npm run dev` - Start Redis, API (with hot reload), and web frontend
- `npm run api` - Start the API server only
- `npm run web` - Start the frontend dev server only
- `npm run redis` - Start Redis server on port 6379
- `npm test` - Run TypeScript compilation check and Mocha tests

### Frontend (client/src/services/FrontEnd/)
- `yarn dev` or `npm run dev` - Start Vite dev server on localhost
- `yarn build` or `npm run build` - TypeScript compile and build for production
- `yarn lint` or `npm run lint` - Run ESLint
- `yarn preview` or `npm run preview` - Preview production build

### Smart Contracts (solidity/)
Uses Truffle for deployment and testing. Networks configured include:
- `dev`/`devL1` - Local development (port 8545)
- `devL2` - Local L2 development (port 8546)
- `devArchive` - Local archive chain (port 8547)
- `testnetL1` - Sepolia testnet
- `testnetL2` - Base Sepolia testnet
- `testnetArchive` - Arbitrum Sepolia testnet (archive chain)

## Architecture

### Smart Contracts
- **CawActions.sol** - Core contract for CAW social actions (post, like, follow, etc.). Maintains a per-Network hash-chain checkpoint (`networkHashAtCheckpoint`) that the optimistic-archive flow commits to.
- **CawProfile.sol** / **CawProfileL2.sol** - Name-service / profile-balance contracts for L1/L2. CAW tokens are locked on L1 and bookkept per-tokenId on L2; withdrawals route back to L1 via LayerZero. Exposes `authenticateForMinter` (minter-gated) so CawProfileMinter can authenticate tokens on behalf of smart-wallet users without requiring them to hold ETH.
- **CawProfileMinter.sol** - Handles minting and deposits. Contains three sponsored entry points (`mintAndDepositSponsored`, `depositForSponsored`, `authenticateSponsored`) for EIP-7702 / smart-wallet users. Each uses EIP-712 + ERC-1271 + ISmartEOA nonce verification to authorize operations without the user paying gas directly. Sponsor server (trusted operator) submits the tx and holds CAW.
- **SmartEOA.sol** - EIP-7702 delegate implementation for Population B (phone-first) users. Deployed once; users' EOAs point at it via a type-0x04 authorization. Supports WebAuthn P-256 passkeys (via EIP-7951 precompile at 0x0100) and a secp256k1 `ecdsaFallback` key as recovery anchor. Implements ERC-1271 and the `ISmartEOA` nonce surface required by CawProfileMinter's sponsor entry points.
- **ISmartEOA.sol** - Interface for the per-(verifyingContract, actionType) nonce model. Required by CawProfileMinter's `_checkPermit`. Wallets that do not implement this interface cannot use the sponsored entry points.
- **CawNetworkManager.sol** - Network registry. Each Network picks its own L2 venue and archive chain at registration. ("Network" = the operator-tier entity that owns a hosted CAW deployment; distinct from "client" in any other sense.)
- **CawActionsArchive.sol** - Archive contract deployed on archive chains. Validators stake ETH once and submit *optimistic* checkpoint replications (merkle root + packed actions). After a 2-day challenge window, submissions finalize. If a challenger proves fraud, the validator's entire stake is slashed and all their pending submissions are invalidated.
- **CawChallengeRelay.sol** - Deployed on each source L2. Reads canonical checkpoint hashes from `CawActions` and relays them via LayerZero to the archive as fraud proofs. Permissionless; anyone can challenge.
- Uses LayerZero for cross-chain functionality (L1↔L2 deposits/withdrawals, L2→archive challenge messages).
- EIP712 signing for action verification.

### Optimistic Archive + Challenge Model

The archive chain is **not** a pass-through replica of every action. The flow is:
1. Validators run a service that watches `ActionsProcessed` on the source L2, accumulates packed actions per checkpoint (`CHECKPOINT_INTERVAL = 32` actions), and groups checkpoints into submissions (≤ 256 per submission).
2. Validator calls `submitReplication()` on `CawActionsArchive` with the merkle root of checkpoint hashes plus the underlying packed actions and `r` anchors. ETH stake (`MIN_STAKE = 0.01 ether`) is required.
3. Anyone monitoring can dispute a submission via `CawChallengeRelay.relayChallenge()` on the source L2, which sends the canonical per-Network checkpoint hash (`networkHashAtCheckpoint` storage slot) to the archive over LayerZero.
4. If the relayed hash differs from the submitter's claimed leaf, `resolveChallenge()` slashes the entire stake and invalidates all the submitter's pending submissions. `slashIncoherentRoot()` catches a separate fraud class where the merkleRoot can't even be derived from the published data.
5. After `CHALLENGE_PERIOD = 2 days` with no successful challenge, `finalizeSubmission()` makes the archive entry canonical.

The action *bytes* live in the submitter-supplied calldata (committed to via `dataCommitment`), not in long-term contract storage.

### ZK sig-only path (optional)

CawActions has a second entry point — `processActionsWithZkSigs` — that takes a Groth16 proof attesting "I correctly recovered every signer off-chain" instead of running ecrecover per action on-chain. The path is opt-in: deploy with `_zkVerifier = address(0)` and `processActionsWithZkSigs` reverts. Both `_zkVerifier` and `_zkProgramVKey` are immutable so the verification trust root is tamper-evident.

Flow:
1. Validator builds a batch (same `packedActions` + `packedSigs` bytes as the sig path).
2. Off-chain prover (SP1 zkVM, Rust crate at `solidity/zk/sig-recovery/`) recovers the signer of each action and emits a Groth16 proof committing to four hashes: `keccak256(packedActions)`, `keccak256(packedSigs)`, `keccak256(signers)`, and `eip712DomainHash`. The proof commits to **no chain state** — that's what makes it race-safe.
3. Validator submits `processActionsWithZkSigs(validatorId, packedActions, packedSigs, signers, proof, …)`. Contract calls `zkVerifier.verifyProof()` once, then walks the signers array (no ecrecover per action) to advance state.
4. Cawonce conflicts (someone else used the same slot mid-flight) SKIP that action rather than reverting the whole batch. The `ActionsProcessedZk(packedActions, actionsExecutedBitmap)` event tells indexers which slots ran.

Trade-off (measured numbers):
- Verifier costs ~265K gas (canonical SP1Verifier on Base Sepolia: `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`, measured on a fork against the real bytecode).
- Per-action savings only kick in at large batch sizes — at n=20–30 (typical real prod batches on test.caw.social), the ZK path is **+25% more expensive** than the sig path.
- Break-even vs sig path: **n ≈ 70 actions per batch**. ZK only pays off when validators can sustainably coalesce well above that.

Local proving requires ~16 GB peak RAM during the Groth16 wrap stage — fine on a dev Mac, OOM-kills a 5.9 GB VPS. Hosted SP1 prover network (~10s/proof) is the path for low-RAM hosts.

`ValidatorService/index.ts` reads `process.env.ZK_PROVER_ENABLED` plus an in-memory `zkProofCache`; cache miss = sig path, so the env flag is harmless without a producer wired in. The producer (background worker that calls `stageZkProof()`) is intentionally dormant until the queueing strategy is decided.

Detailed write-up: `docs/ZK_SIG_PATH.md`. Crate: `solidity/zk/sig-recovery/README.md`.

### Backend Services (client/src/services/)
- **ActionProcessor** - Processes and indexes blockchain events
- **Api** - REST API server
- **FrontEnd** - React application
- **RawEventsGatherer** - Reads CAW events from blockchain
- **ValidatorService** - Validates new actions on chain
- **UserService** - User management functionality

### Frontend Tech Stack
- **React 18** with TypeScript
- **Vite** for build tooling
- **TailwindCSS** for styling (v4)
- **React Router v7** for navigation
- **Wagmi + RainbowKit** for Web3 integration
- **Zustand** for state management
- **React Query** for server state
- **Framer Motion** for animations

### Population routing (FE)

The FE classifies every connected wallet into one of four populations via `useWalletPopulation()` (reads wagmi `useAccount()` + viem `getCode`):
- **A** — plain EOA (empty code). Uses wagmi `writeContract` directly to the V2 contracts.
- **B** — EIP-7702-delegated EOA (`code` starts with `0xef0100`, 23 bytes total). Routes through the sponsor server's three entry points (`mintAndDepositSponsored`, `depositForSponsored`, `authenticateSponsored`) signed by a WebAuthn passkey (default) or the secp256k1 ecdsaFallback key (recovery mode). `withdrawTo` is always direct, never sponsored.
- **C** — other contract account (Safe / Argent / CSW). Not yet supported via sponsor path — needs an ISmartEOA shim (v2 scope).
- **none** — no wallet connected. Recovery mode upgrades this to **B** when `RecoveryProvider.isInRecoveryMode === true`.

New routes:
- `/onboarding` — Population B signup (passkey enroll + secp256k1 keygen + Argon2id-encrypted backup blob + sponsor `bootstrap`).
- `/recovery` — sign in with backup file + vault password. The recovered secp256k1 key lives ONLY in `RecoveryProvider` React state; never persisted to localStorage / sessionStorage / IndexedDB.

Identity management lives under the existing AccountSettings page (Population B users only): enrolled passkeys list, add-passkey (24h timelock), rotate ecdsaFallback, re-download backup file. The `IdentitySigningProvider` shows a global biometric-prompt overlay during `navigator.credentials.get()` ceremonies.

### Database & Infrastructure
- **PostgreSQL** with Prisma ORM
- **Redis** for caching
- **TypeORM** for additional database operations

## UI Standards

Follow the container standard defined in `UI_CONSISTENCY_STANDARD.md`:
- All pages displaying posts must use `<div className="max-w-2xl mx-auto px-6 py-4">`
- Consistent mock usernames across the application
- Use `Feed` and `FeedItem` components for post display

## Key Development Notes

- The project uses a monorepo structure with separate package.json files for different components
- Smart contracts support multi-L2 deployment; Networks pick their own action-processing L2 and archive chain at registration, not at protocol level
- Action data (post text, signatures) is the source of truth in tx **calldata** on the action-processing L2; events are commitments to the calldata, not copies of it (see `ActionsProcessed` and `ActionsArchived` event signatures)
- Frontend uses path aliases configured in `vite.config.ts` (~ prefix)
- TypeScript strict mode enabled across all components
- ESLint configured with React-specific rules