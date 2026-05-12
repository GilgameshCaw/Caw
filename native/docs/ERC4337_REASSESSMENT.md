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

## Open questions before committing

These are real and need answers before we redo the plan:

1. **Does `CawActions._verifySignatureMem` work with 7702-delegated accounts?** The existing code does `ecrecover` and compares to `ownerOf(senderId)`. If the owner is a 7702-delegated EOA, the EOA's address is unchanged, so `ecrecover` against an ECDSA-signed action still works. But a *passkey-signed* action wouldn't be ecrecoverable to that address — we'd need ERC-1271 `isValidSignature` fallback, which means a contract change. **This is the load-bearing question; everything else is downstream.**

2. **Which 7702 delegate implementation do we use?** Audit posture, signer flexibility, session-key support, recovery hooks — all vary. Worth a focused 1-week evaluation.

3. **What's the bundler / paymaster operational story?** Self-host vs. rent. Either is fine; this is a cost-vs-control call.

4. **How does cross-chain (L2 action processing, archive chains) interact with 7702?** EIP-7702 authorizations are per-chain. The user's L1 EOA being a smart EOA doesn't automatically make their L2 address one. For action processing this is probably fine (actions are EIP-712 signed off-chain and submitted by validators; the user's signature is what's checked, not the on-chain account type). But worth verifying explicitly.

5. **What about non-modern browsers / older devices?** Passkey + prf support is good on modern stacks but not universal. The fallback story (password + secp256k1) needs to remain as a parallel path for users who can't use passkeys.

## Recommendation

**Don't redo the v1 plan around this.** Reasons:

- The EOA-only plan answers question #1 (no contract changes needed) by construction. We can ship it without touching `CawActions` or `CawProfile`.
- 7702 + passkey-signer is genuinely better but adds dependencies (bundler, paymaster, delegate contract audit, possible CawActions update). Each is tractable; the bundle of them is a real project.
- Most of the v1 plan is reusable verbatim. We're not throwing anything away by shipping it.

**Do plan for v2 around this.** Reasons:

- The recovery story is meaningfully better. No password-can-be-forgotten failure mode for users who stay on Apple/Google ecosystems.
- The signing UX is meaningfully better. Passkey-as-signer means no "unlock vault" step at all on cold start — Face ID directly produces an on-chain-verifiable signature.
- The on-ramp narrative is meaningfully cleaner. "Tap Apple Pay, then Face ID to enable posting" can become "tap Apple Pay" — the same Face ID that authorized the purchase also authorized the smart-EOA upgrade and session-key registration as part of the bundled UserOps.

**Sequence:**
1. **v1**: ship the existing EOA + passkey-prf wrapping plan. Native + browser. No contract changes.
2. **v1.5 (during v1 hardening)**: answer the open questions above. Specifically, audit `CawActions._verifySignatureMem` against 7702-delegated owners and decide if a contract change is needed.
3. **v2**: ship the 7702 + passkey-signer upgrade as an opt-in for existing users and the default for new users. Existing users keep their address; their EOA gains passkey signing in place. This is *the* selling point of 7702 — no migration, just an upgrade tx.

## What I got wrong before

The original plan said "ERC-4337 is too expensive on L1, defer to L2." That was correct as of when it was written but it was already partially obsolete:

- Pectra (May 2025, ~12 months before this analysis) had already made 7702 available. I didn't surface it because the original analysis framed everything around "smart account deploy per user," which is the pre-7702 model. 7702 reframes 4337 from "deploy a contract per user" to "upgrade an EOA in place," which has fundamentally different economics.
- Fusaka (Dec 2025) then resolved the P-256 verification cost. I caught this one but should have caught the 7702 part earlier — it predated the original plan, not the other way around.

The decision to ship the EOA-only path first is still defensible — it's simpler, ships faster, requires no contract changes — but it should be framed as "v1 is the conservative path, v2 unlocks substantially better UX" rather than "smart accounts are too expensive." The cost framing was true; it's no longer the load-bearing reason.
