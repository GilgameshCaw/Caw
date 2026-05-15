# Validator key protection — options compared

**Status:** decision doc. Read before committing engineering effort to any of these.

**The problem:** `VALIDATOR_PRIVATE_KEY` lives in `.env` on the VPS in plaintext. Any process that can read that file (root, a compromised dependency, a deserialization bug, an attacker who got SSH) can sign arbitrary transactions as the validator address.

**The companion doc** `docs/SIGNER_SERVICE_DESIGN.md` is the detailed sketch for one of the options below (option B). This doc compares all of them so we can pick the right one — not implement the first one we drew up.

## What we're actually defending

Five distinct attack outcomes, ranked roughly by harm:

1. **Slashing** — attacker submits a fraudulent `submitReplication` and gets the full validator stake (0.01 ETH on the archive chain today, but the value goes up as we deposit more for higher submission volume) slashed.
2. **Gas drain** — attacker burns the hot wallet's ETH submitting valid-looking but useless `processActions` calls. Gas funds gone, validator goes offline.
3. **ETH theft** — attacker sends the hot wallet's ETH to an address they control.
4. **Off-chain impersonation** — attacker signs an arbitrary message as the validator, used to fool downstream consumers that trust validator-signed attestations.
5. **NFT / token theft** — if the validator address ever holds NFTs or ERC-20s (currently doesn't, but might).

The protection options below stop different subsets of these. That's why the right answer depends on which we care about most. For CAW: **slashing > gas drain > everything else**, because slashing is the only outcome where loss exceeds the hot wallet balance.

## Option A — Low hot-wallet balance + top-up alarm

**The pattern:** Keep ~24-48h of gas in the validator's hot wallet. The rest sits in a cold wallet (hardware wallet, off the VPS). A monitoring script alerts when the hot balance drops below threshold; operator manually tops it up.

**Effort:** half a day. A monitoring script + a runbook.

**Stops:** #2 (gas drain — bounded to 1-2 days of fuel), #3 (ETH theft — bounded similarly).
**Doesn't stop:** #1 (slashing — the stake is on the archive contract, not in the hot wallet), #4, #5.

**Why it's still the highest-leverage thing:** zero code complexity, no deploy choreography, no new failure modes. Caps the most likely losses to a known dollar amount.

## Option B — Separate signer process (the doc I just wrote)

**The pattern:** Move `VALIDATOR_PRIVATE_KEY` to a second process running as a different OS user, with an allowlist of (chain, contract, selector) it'll sign for. Validator builds calldata, asks signer over a Unix socket, broadcasts the result.

**Effort:** ~1 week. Detailed in `SIGNER_SERVICE_DESIGN.md`.

**Stops:** #3 (raw ETH transfers off the allowlist), #4 (refuses `signMessage`), #5 (refuses ERC-20/721 calls).
**Doesn't stop:** #1 (slashing — `submitReplication` IS on the allowlist), #2 (gas drain — `processActions` IS on the allowlist).

**The catch:** the key still lives on the VPS in plaintext, just under a different uid. A root-on-VPS attacker reads `/etc/caw-signer/signer.env` and we're back to square one. So this defends against:
- A compromised validator process (no root) — yes, helpful.
- A compromised root account — no, the key is still on disk.

**Verdict:** modest protection for moderate effort. Defends against the wrong shape of attacker for the threat model we actually face (a serious attacker gets root, not just app-level RCE).

## Option C — Cloud KMS (AWS KMS / GCP KMS / Azure Key Vault)

**The pattern:** Key is generated *inside* the KMS service and never leaves it. Signing requests go over HTTPS with IAM authentication. The KMS returns a signature; the application never sees the key bytes.

**Effort:** ~1 week if you've never used it; 2-3 days if familiar. Requires:
- AWS / GCP account with KMS enabled.
- IAM role for the VPS (or an instance-credential equivalent — but our VPS isn't on AWS, so we'd use long-lived credentials, which weakens the model).
- An ethers `Signer` wrapper that signs via KMS instead of locally. (Open source wrappers exist: `aws-kms-ethers-signer`, etc.)
- Custom signing-policy enforcement is doable via IAM conditions (limit which key versions, which calling identity, optionally rate-limit via CloudWatch).

**Stops:** #3, #4, #5 — the key bytes literally don't exist on our hardware. Even root-on-VPS can't extract the key. Attacker has to get the AWS/GCP IAM credentials too, and even then they can't *steal* the key, only *use* it while the credentials are valid.
**Doesn't stop:** #1, #2 — KMS will sign whatever's policy-allowed; same problem as the signer service.

**The catch:** introduces a cloud-provider dependency. KMS outage = validator offline. Cost is ~$1/month for the key + per-signature fees (negligible). VPS not being on AWS means we'd authenticate with a long-lived access key stored on the VPS — still better than the raw key, but not zero-trust.

**Verdict:** the *right* technical answer for #3-#5. Real material upgrade over option B. The "key is never on our disks" property is what we want long-term.

## Option D — Hardware HSM (YubiHSM 2, Ledger, AWS CloudHSM)

**The pattern:** Key lives in a physical device. Signing requires the device to be present and unlocked.

**Effort:** highly variable.
- YubiHSM 2 plugged into the VPS: ~1 week of integration. Hardware cost ~$650.
- Air-gapped hardware wallet that we manually unlock for each replication: incompatible with the auto-submission loop. Not workable.

**Stops:** #3, #4, #5 — same as KMS. The key bytes never leave the device.
**Doesn't stop:** #1, #2 — HSM signs what it's asked to, within configured constraints.

**The catch:** physical-device-attached-to-VPS works for a single-region setup but breaks if we ever want HA. Operationally heavier than KMS. Hardware can fail; need a spare device with the same key (which requires a key-export ceremony at setup, weakening the trust model).

**Verdict:** stronger than KMS for #3-#5, but the operational complexity is much higher. KMS gets ~95% of the benefit at ~30% of the operational pain.

## Option E — Multi-sig / governance on slashing-critical paths

**The pattern:** `submitReplication` no longer accepts a single-key signature; requires either:
- An N-of-M signature from a set of validator keys (most realistic shape: contract-side validation), or
- A timelock + cancel mechanism, where any submission can be cancelled within a delay window by a separate "guardian" key.

**Effort:** weeks. Requires contract changes (CawActionsArchive), key-management coordination across signers, and breaks the "validator is one address" assumption baked into ops.

**Stops:** #1 (slashing — the only option that actually does).
**Doesn't stop:** #2-#5.

**The catch:**
- Contract changes mean a new deploy. Couples with `contract-support-v2` work.
- Operational latency: replication finalization gets slower if signatures need to be collected.
- Coordination cost: someone has to be ready to co-sign or veto.
- For an N-of-M scheme, key management for the M participants is its own problem.

**Verdict:** the only option that stops slashing. Worth designing now even if we don't implement until mainnet. The decision is whether slashing risk is high enough to justify the operational cost — currently it isn't (testnet, low stake, no real users), but it will be at mainnet.

## Composite: what actually moves the needle

The honest matrix:

| | A. Low balance | B. Signer service | C. Cloud KMS | D. HSM | E. Multi-sig |
|---|---|---|---|---|---|
| Stops slashing | ✗ | ✗ | ✗ | ✗ | ✓ |
| Stops gas drain | bounded | ✗ | ✗ | ✗ | ✗ |
| Stops ETH theft | bounded | ✓ | ✓ | ✓ | ✗ |
| Stops off-chain impersonation | ✗ | ✓ | ✓ | ✓ | ✗ |
| Stops NFT/ERC-20 theft | ✗ | ✓ | ✓ | ✓ | ✗ |
| Resists root-on-VPS | ✓ | ✗ | ✓ | ✓ | ✓ |
| Effort | half day | 1 week | 1 week | 1+ week | weeks (+ contracts) |

The pairs that compose well:
- **A + C** (low balance + cloud KMS): the all-rounder. A caps the bounded losses, C makes #3-#5 essentially impossible. Slashing remains the residual risk. **~1.5 weeks total.**
- **A + E** (low balance + multi-sig): the slashing-focused build. Caps the cheap losses, kills the expensive one. Slashing risk truly mitigated. **Multi-week, contract change required.**
- **A + C + E**: belt-and-suspenders. The right destination, but not all at once.

**Option B (signer service) does not appear in any of the recommended composites.** It's strictly dominated by C — same protection surface, but C also defends against root-on-VPS. B's only argument is "you can run it without trusting AWS/GCP." For a project that already runs on a third-party VPS with third-party DNS, third-party RPC, and third-party LayerZero infrastructure, "we don't trust the cloud provider" is a weak frame.

## Recommendation

**Now (this week):** option A. Half a day. Caps the most likely loss to a known dollar amount. Costs nothing.

**Next month (pre-mainnet):** option C. ~1 week. Removes the on-VPS key entirely. The clean technical foundation.

**Before mainnet with meaningful TVL:** option E (multi-sig on slashing-critical paths). Designed alongside the next contract redeploy.

**What to do with `SIGNER_SERVICE_DESIGN.md` (option B):** leave it as a record but don't implement. If we ever can't use cloud KMS (regulatory, sovereignty, cost), the signer service is the fallback. But it isn't worth ~1 week of effort right now when option C is the same cost and meaningfully better.

## What I'd change about the threat model

A few things that aren't quite captured above and would refine the choice:

1. **The validator's role grows.** Today the validator is just a replication submitter. If it ever becomes a deposit/withdrawal relayer, a fee collector, or signs anything user-facing, the off-chain-impersonation risk (#4) grows in importance and pushes harder toward C/D.
2. **Mainnet stake size.** If the archive-chain stake to be a competitive validator goes from 0.01 ETH to multiple ETH, the slashing line moves from "annoying" to "career-ending" and E becomes mandatory.
3. **Multiple validators.** A pre-launch single-validator design has different security properties than a 10-validator network. Adding more validators is its own form of risk reduction — one compromise doesn't take the network down.

## Open questions for the operator

1. Are we willing to take a cloud-provider dependency for signing? (Yes/no fundamentally changes the recommendation.)
2. What's the realistic stake size at mainnet? (Drives priority of E.)
3. Is the validator role going to grow? (Drives priority of #4.)
4. Do we want the signer to be portable across operators (i.e., other people running CAW nodes) — and if so, can we expect them all to set up cloud KMS, or do we need a "works without a cloud account" path?

Question #4 is the strongest argument for keeping option B in the back pocket: operators who run CAW nodes themselves probably can't or won't set up KMS, and a "drop-in signer service" might be what *they* use even if we (the reference operator) use C.

---

## Addendum: pluggable signer abstraction (per-operator choice)

Picking *one* option network-wide is the wrong frame. Different operators have different threat models and operational appetites:

| Operator type | What they want | What they'd actually run |
|---|---|---|
| Reference operator (us) | Best security available | Cloud KMS |
| Serious independent operator | Decent security, no cloud lock-in | Local signer service (option B) or local HSM |
| Hobbyist on a $5 VPS | "Just works" out of the box | Plaintext `.env` (today) |
| Air-gapped paranoid operator | Key never online | Manual co-signing (probably impractical at submission cadence) |

A one-size answer loses several of those groups. The right move is to introduce a small abstraction inside the codebase so the operator picks their backend at install time.

### The interface

```ts
// client/src/lib/signer/types.ts (proposed)
export interface ValidatorSigner {
  /** Synchronous address read — used for nonce fetch, identity, ownership checks. */
  getAddress(): string;

  /** Sign a fully-populated transaction request; return raw signed tx for broadcast.
   *  Caller pre-fills nonce, chainId, gas fields — the signer only signs. */
  signTransaction(tx: TransactionRequest): Promise<string>;

  /** Sign an arbitrary 32-byte digest with secp256k1 (no EIP-191 prefix).
   *  Used by DmRelayService for canonical envelope signing. KMS / HSM backends
   *  implement this via their respective Sign-digest APIs. */
  signDigest(digest: Uint8Array): Promise<{ r: string; s: string; v: number }>;

  /** Optional: free any resources (close socket, drop KMS client). */
  dispose?(): Promise<void>;
}
```

Three methods, that's it. `signMessage` and `signTypedData` are deliberately absent — they aren't used in the validator codebase today, and adding them invites callers to start signing things outside the existing patterns. If a future feature legitimately needs them, we add them then.

### Backends

```ts
// client/src/lib/signer/index.ts (proposed)
export function getValidatorSigner(provider: Provider): ValidatorSigner {
  switch (process.env.VALIDATOR_SIGNER_TYPE || 'env') {
    case 'env':    return new EnvKeySigner(provider);     // today's behavior
    case 'socket': return new SocketSigner(provider);     // option B (deferred)
    case 'kms':    return new KmsSigner(provider);        // option C (ship next)
    case 'hsm':    return new HsmSigner(provider);        // option D (deferred)
    default: throw new Error(`Unknown VALIDATOR_SIGNER_TYPE`);
  }
}
```

Each backend is a separate file. Implementations:

- **`EnvKeySigner`** — wraps `new ethers.Wallet(process.env.VALIDATOR_PRIVATE_KEY, provider)`. ~30 lines. Default. Drop-in for current behavior.
- **`KmsSigner`** — wraps an AWS KMS / GCP KMS client. ~150 lines (mostly DER-encoded signature decoding and recovery-id calculation). Ships for the reference operator.
- **`SocketSigner`** — talks to the option B signer process over a Unix socket. Built only if/when an independent operator needs it.
- **`HsmSigner`** — talks to a YubiHSM or AWS CloudHSM. Built on demand.

### Per-callsite migration

The inventory found 10 files reading `VALIDATOR_PRIVATE_KEY` directly. The migration is mechanical:

- `new Wallet(VALIDATOR_PRIVATE_KEY, provider)` → `getValidatorSigner(provider)` (used as a `Signer`-like object passed into `new Contract(addr, abi, signer)`).
- `wallet.address` reads → `signer.getAddress()`.
- The DmRelayService `signCanonical(canonical, privateKey)` call needs reshaping: instead of passing the raw key, hash to a digest first and call `signer.signDigest(digest)`. The signature shape (`r`, `s`, `v`) stays identical.
- Scripts that only need `.address` (the inspect script) can still keep doing `new ethers.Wallet(pk).address` — they're operator-local tools, not security-critical paths.

### Per-operator config

Set in install env:

```bash
# Default: backwards compatible, no change
VALIDATOR_SIGNER_TYPE=env
VALIDATOR_PRIVATE_KEY=0xabc...

# Cloud KMS (reference operator)
VALIDATOR_SIGNER_TYPE=kms
KMS_KEY_ID=arn:aws:kms:us-east-1:...
AWS_REGION=us-east-1
# AWS credentials via the standard chain (env, instance role, ~/.aws/credentials)

# Local signer process (independent operators)
VALIDATOR_SIGNER_TYPE=socket
SIGNER_SOCKET_PATH=/var/run/caw-signer/signer.sock
```

### Tradeoffs the abstraction surfaces

- **DM relay needs `signDigest`** with raw secp256k1 semantics. AWS KMS supports `ECDSA_SHA_256` and returns a DER signature — we have to decode it and compute the recovery id ourselves. ~30 lines of well-known code; not novel.
- **`signMessage` / `signTypedData` are off the menu**. If a future feature wants them, the abstraction can grow. Better to keep the interface minimal than pre-add unused methods.
- **Single key for everything**: validator txs, sessions-api tx, instance registry tx, DM relay envelope signing all use the same signer. A compromise affects all of them. Worth revisiting if DM relay becomes a separate concern, but for now the operator-choice axis is more valuable than splitting.

### What this changes in the recommendation

The earlier rec (A → C → E) stays. The abstraction is what *enables* that path without forcing every operator onto our choice. Pre-mainnet, the reference operator runs `kms`; hobbyists keep running `env`; security-conscious independents can build `socket` for themselves. Nobody is forced to pick.
