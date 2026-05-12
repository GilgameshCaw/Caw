# ERC-4337 / passkey-signed account: reassessment

The original plan in this directory rejects ERC-4337 + passkeys on L1 for cost reasons. That analysis predated two L1 upgrades that materially change the math:

- **Pectra (May 2025)** shipped **EIP-7702**, letting any EOA delegate its code to a smart contract via a single signed authorization. This collapses the "smart account deploy" problem into "EOA sets a code pointer." No per-user contract deploy, no factory, no CREATE2 dance. The EOA keeps its address; it just gains programmable behavior.
- **Fusaka (Dec 2025)** shipped **EIP-7951**, the secp256r1 precompile. On-chain passkey signature verification dropped from ~330K gas (Daimo's Solidity verifier) to ~3.5K gas (native precompile). The single biggest objection to passkey-signed accounts on L1 is gone.

This doc is an honest re-evaluation now that both are live. The conclusion changes the recommendation, but the existing plan is still the right *first* thing to ship — see "What we actually do" at the end.

## The two upgrades, concretely

### EIP-7702: EOA → smart EOA via delegation

The transaction author signs an authorization tuple `(chain_id, address, nonce)` declaring "execute code at `address` as if it were my account's code." When a `SET_CODE` (type 0x04) tx with that authorization lands, the EOA's code field is set to a 23-byte marker `0xef0100 || address` pointing at the delegate contract.

From that point forward, calls to the EOA execute the delegate's code with the EOA's storage. The EOA keeps its address, keeps its private key as one valid signer, and gains arbitrary programmability: passkey signers, session keys, recovery rules, batched calls.

Gas cost of delegation:
- `PER_AUTH_BASE_COST`: 12,500 gas per authorization
- `PER_EMPTY_ACCOUNT_COST`: 25,000 gas (refunded if account already exists)
- Cold account access: 2,600 gas

For our case (the EOA already exists because the user funded their wallet to mint a profile), the practical cost of upgrading is roughly **12,500 gas** — call it **~$0.40 at 30 gwei ETH** on L1. A one-time cost, paid once ever per user, sponsorable by the relayer.

This is **two orders of magnitude cheaper than deploying a full smart account contract per user** (which was ~200K-400K gas in the old 4337 model, plus a factory deploy you amortize once). And the user keeps the same address, so they can fund it with Apple Pay first, then upgrade, with zero address-migration UX.

### EIP-7951: cheap P-256 on L1

Verifying a secp256r1 (P-256, what passkeys produce) signature on-chain used to cost ~330K gas via Solidity libraries like Daimo's verifier. The precompile at address `0x0100` does the same verification in ~3,450 gas — about 100× cheaper.

This matters because every action signed by a passkey now does a precompile call, not a 330K-gas Solidity verification. Per-action overhead from "use passkeys" drops from "punitive" to "negligible."

## What 4337 + passkeys actually looks like now on L1

The shape that's now possible:

1. User opens CAW (browser or native).
2. App generates a **passkey** via WebAuthn (P-256, hardware-backed, biometric-gated, iCloud/Google synced).
3. App generates a temporary **secp256k1 EOA** to receive the on-ramp delivery and pay the burn cost.
4. User pays via Apple Pay; relayer delivers CAW to the EOA.
5. Relayer (or the EOA itself) submits `mintAndDepositFor` — CAW spent, profile NFT lands at the EOA address.
6. **EIP-7702 authorization**: the EOA signs once, delegating its code to a smart-EOA implementation that says "valid signature = passkey signature OR original ECDSA key."
7. From this point forward, every action is signed by the **passkey** (Face ID), verified via EIP-7951 precompile at ~3,500 gas per action. The original ECDSA key is still a valid signer for emergencies / migrations but the user never sees it.

Outcomes:
- **No seed phrase, ever.** The passkey is the recovery factor; it's already iCloud-synced.
- **No "import wallet" step.** The EOA is the user's wallet; the passkey upgrades it in place.
- **No per-user contract deploy.** Just a one-time ~12,500 gas authorization.
- **Per-action overhead** post-upgrade: roughly EntryPoint base (60K gas) + P-256 verification (3.5K gas) on top of the action itself. So an action that's 100K gas today becomes ~163K gas post-upgrade.
- **Recovery**: lost device → new device → sign in to iCloud → passkey is there → keep going. Lost iCloud + lost device → still have the original ECDSA key as a fallback signer (we encrypt+back up that key the same way we would in the EOA-only plan, so the worst case is no worse than today).

Compare to the EOA-only plan:
- EOA-only: passkey is unavailable as a *signer* (it's P-256, not secp256k1). We work around it by using passkey-prf as a **wrapping key** to encrypt the secp256k1 key. Same recovery story — passkey unlocks the key — but the passkey isn't directly signing on-chain, it's gating decryption.
- 4337 + 7702: passkey is a *first-class on-chain signer*. The wrapping pattern isn't needed because the chain can verify passkey signatures directly. Cleaner architecturally.

## The honest costs

This isn't free. What you pay:

### Per-action gas overhead

Post-upgrade, every action goes through EntryPoint (4337's central contract). Measured EntryPoint overhead: roughly **60K gas per UserOp**, on top of whatever the action itself costs. At 30 gwei on L1, that's ~$1 of overhead per action. At 5 gwei it's ~$0.16. On L2 the absolute cost is sub-cent.

For our protocol, this matters most for **L1 operations** (mint, transfer, withdraw, register session). Day-to-day posting on the action-processing L2 is unaffected.

### EntryPoint and bundler infrastructure

You need a bundler — a service that takes signed UserOps off-chain, packages them, submits them on-chain. You can rent one (Pimlico, Alchemy, Stackup) or run your own. The on-chain EntryPoint is canonical and shared.

### Paymaster

If you want sponsored transactions ("user pays no gas"), you run a Paymaster contract you fund with ETH. Same model the relayer uses today, just standardized via the 4337 protocol.

### Smart-EOA implementation contract

Someone writes and audits the contract that 7702-delegated accounts point at. Several open-source implementations exist (Safe's 7702 module, OpenZeppelin's reference impl, Biconomy's). Pick one, audit it, deploy it once on L1, and every CAW user's smart EOA delegates to the same address.

### The passkey-as-signer threat model

A passkey is great UX. But it's owned by Apple / Google in a deeper way than a secp256k1 key you generate yourself. If iCloud Keychain syncs the passkey to a device the user doesn't fully control (work iPad, ex-spouse's iMac that's still on the Apple ID), the passkey signs there too. The user's mental model — "Face ID is just me" — doesn't capture this.

We mitigate by keeping the **original ECDSA key as a co-signer** and using it for high-value operations (transfers, withdrawals) while passkeys handle low-value ones (posting, liking). Same risk tiering as the EOA-only plan, just at a different layer.

## What this means for the existing plan

The existing `native/` plan is built around an EOA wallet with passkey-prf wrapping. Almost all of it is reusable in a 7702 + passkey-signer world:

- The **on-device key management** (Secure Enclave / Keystore, vault password, biometric gate) — unchanged. We still generate a secp256k1 key; it's still the user's primary identity. The change is what *additional* signers the chain accepts.
- The **backup blob, cloud sync, recovery flows** — unchanged. The secp256k1 key still gets encrypted and backed up; the passkey is an *additional* recovery factor, not a replacement.
- The **on-ramp relayer flow** — unchanged. `mintAndDepositFor` works the same way regardless of whether the recipient is a vanilla EOA or a 7702-delegated smart EOA.
- The **session key system** — gets *better*. Today, registering a session key requires an L1 EIP-712 signature from the EOA (one biometric prompt). With 7702 + passkey signers, session-key registration is itself a passkey signature, verifiable on-chain via the precompile. The CawProfile contract may need a small update to accept this (recognize that valid signatures from a delegated smart EOA come from the passkey, not the EOA's original ECDSA key — depends on whether the existing `ecrecover` path is sufficient or whether we need ERC-1271 fallback verification).
- The **multi-frontend `sign.caw.social` pattern** — also unchanged. The popup-broker just signs UserOps instead of raw EIP-712 payloads.

## What's already in the contracts (verified 2026-05)

After actually reading the code, several "open questions" I'd flagged are already answered:

1. **ERC-1271 fallback in CawActions: already implemented and audited.** `CawActions._verifySignatureMem` (lines 1320-1357) and `_verifyBatchSignature` (lines 1375+) have a cold-path ERC-1271 fallback at line 1349. If `ownerOf(senderId)` is a contract (or 7702-delegated EOA, which has `code.length > 0`), the action verification calls `isValidSignature` on the owner with the full EIP-712 digest. This was an audit fix dated 2026-05-08. **7702 + passkey-signer accounts can already sign CAW actions today, as long as the smart EOA implements `isValidSignature` correctly.** No contract change needed for this.

2. **Expired-session-fallthrough is closed.** A real subtle attack: if a profile is contract-owned (Safe, 7702 smart EOA) and the contract's `isValidSignature` would also approve a session key whose on-chain record is expired, the 1271 fallback would silently elevate the expired session to full owner authority. The audit fix at line 1343 explicitly reverts on `expiry != 0` before reaching the 1271 path. This invariant must be preserved by any new code.

3. **Session-on-transfer is solved via epoch bump.** `ownerSessionEpoch[owner]` increments on every outbound ownership transfer; `validSession()` zeroes out stale-epoch records. So wallet-scoped sessions don't "leak" to a new owner. The CL-4 audit fix from a prior pass.

What is **not** in yet:

- **Per-tokenId session scoping.** Sessions are still wallet-scoped only — one session key registered for a wallet has authority over every profile that wallet currently owns. The epoch bump means future profiles acquired *after* registration don't inherit the session, but profiles owned *at registration time* all do. For the multi-profile / multi-frontend / external-app-delegation use cases the manifesto describes, this is too coarse. **This is the one contract change that's load-bearing to make before deploy.** Spec at [`CONTRACT_CHANGES_V1.md`](CONTRACT_CHANGES_V1.md).

## Open operational questions (not contract-blocking)

These don't need pre-deploy answers but should be decided before v1 ships:

1. **Which 7702 delegate implementation do we use?** Audit posture, signer flexibility, session-key support. Candidates: OpenZeppelin reference impl, Daimo's passkey-first account, Biconomy Nexus, Safe's 7702 module. Daimo is probably the closest match for "passkey is the primary signer."

2. **Bundler / paymaster operational story.** Per the validator-service review: today's ValidatorService is 80% of a bundler-paymaster already. It holds a hot ETH wallet, takes off-chain signed actions, batches them, submits them on-chain. Extending it to accept UserOps for the L1 7702 upgrade + session registration is a real but bounded extension (probably 1-2 weeks). Beats running a third-party bundler.

3. **Cross-chain interaction with 7702.** EIP-7702 authorizations are per-chain. The user's L1 EOA being smart doesn't make their L2 address smart. For action processing this is fine (actions are EIP-712-signed off-chain and validated via ERC-1271 on the action-processing L2, which already works). The user *could* also delegate their L2 address, but it's not required — and probably shouldn't be, since L2 actions don't benefit much from passkey signing once session keys are doing the day-to-day signing anyway.

4. **Fallback for non-modern browsers / older devices.** Passkey + prf isn't universal. We keep the password-encrypted blob path as a parallel option for users who can't use passkeys. It's no longer the headline flow.

## Recommendation: go straight to 7702 + passkey-signer for v1

Earlier I recommended shipping the encrypted-blob path first and treating 7702 as v2. Updated view: **the contracts are in better shape than I realized (ERC-1271 already in), and the validator service is closer to a bundler than I realized, so the gap between the two paths is much smaller than my original analysis suggested.**

Specifically:
- The "load-bearing contract question" (does ERC-1271 work?) was already answered before this conversation started.
- The "load-bearing infra question" (do we need to build a bundler?) is answered "no, extend the validator service."
- The "load-bearing audit question" (write a smart-EOA contract?) is answered "no, pick an existing audited one."

What's left is real but bounded:
- Per-tokenId session contract changes (pre-deploy, mandatory regardless of v1/v2 choice — see next doc).
- Audit/integrate a chosen 7702 delegate.
- Extend ValidatorService for UserOp submission + paymaster accounting.
- Wallet code: passkey-as-signer flow.
- Keep encrypted-blob + password as fallback path for browsers without passkey-prf.

This is roughly 4-6 weeks more than the encrypted-blob-only v1, but saves a v2 migration entirely and gives non-crypto users the genuinely better UX from day one.

**Plan:**
1. **Pre-deploy contract work** (mandatory regardless of v1 plan): per-tokenId session scoping. See [`CONTRACT_CHANGES_V1.md`](CONTRACT_CHANGES_V1.md).
2. **v1 (the new v1)**: ship 7702 + passkey-signer as the primary path, encrypted-blob + password as the fallback for users without passkey-prf support.
3. **v2**: polish, optimize, multi-app delegation flows, hardware-wallet support for high-value users.

## What I got wrong, twice

For the record so this doesn't keep happening:

- The original plan said "ERC-4337 is too expensive on L1, defer to L2." That was correct for the **pre-7702 model** but EIP-7702 had already been live for ~12 months when I wrote it. I didn't surface it because I was anchored on "smart account deploy per user," which is the wrong frame post-Pectra.
- The first revision of this doc said "we need to verify if `CawActions._verifySignatureMem` supports 7702 — this is the load-bearing question." Wrong again — ERC-1271 was already in the contract, with a recent audit comment I could have seen on a careful read. The lesson: when a question is contract-shaped, **read the contract** before declaring it open.

Net: the recommendation tightens from "ship the conservative path first" to "ship the right path, the contracts are ready, the validator service is closer than I thought." The cost ratio changed because the unknowns turned out to mostly be already-knowns.
