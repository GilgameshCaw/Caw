# Backup and recovery

The hardest part of self-custody is what happens when the device dies. This doc covers what we offer.

## Layered backup

We give the user three orthogonal recovery paths and let them opt into as many as they want. More paths = more resilience, more attack surface. Default for new users: cloud backup ON, seed-phrase reveal AVAILABLE but not required during onboarding.

### 1. Password-encrypted cloud backup (default ON)

A single encrypted blob containing all of the user's accounts:

```
backup_v1:
  version: 1
  createdAt
  accounts:
    - address, label, source, hasSeed, createdAt, derivationPath?
    - ciphertext: { seed_or_privkey, kdf=argon2id, kdfParams, nonce, tag }
  vaultMeta:
    kdfParams (same as above)
```

The whole blob is then encrypted again under a key derived from the user's **vault password** (Argon2id, fresh salt). This double-encryption is intentional: the inner per-account ciphertext lets us add accounts incrementally without re-deriving the outer key, and the outer encryption protects the metadata (labels, account list) from anyone who gets the blob.

Where it goes:
- **iOS**: iCloud Drive in the app's ubiquity container. Apple syncs it across the user's signed-in devices. We don't touch CloudKit's record-level encryption for this — we encrypt the contents ourselves, then let Apple sync the ciphertext.
- **Android**: Google Drive App Folder via the Drive API. Same shape: we encrypt, Google syncs the ciphertext.
- **Optional fallback**: a copy mirrored to our backend, encrypted-only. Off by default; opt-in for users who don't trust Apple/Google sync. Backend never sees plaintext.

Recovery flow:
1. User installs app on new device.
2. Sign into iCloud / Google account (already done at OS level).
3. App detects an existing backup blob.
4. User enters vault password → Argon2id → outer decrypt → restore accounts → re-encrypt ciphertexts under the new device's hardware-wrapped key.

If user is on a fresh device with no cloud account match (e.g., switching from iOS to Android, or a friend's phone), they go through the seed-phrase or keystore-import path instead.

### 2. Seed phrase (offline)

Standard BIP-39 12 / 24 words. We surface this as the canonical "if all else fails" backup.

UX:
- Onboarding offers it as "skip for now" or "back up your recovery phrase." Skipping flips a status flag in settings ("Recovery phrase: not backed up") that pesters the user mildly until done.
- Reveal screen: biometric + password, then 30-second visible-then-hide, with a "I've written this down" confirmation step that re-shuffles 3 random words and asks the user to type them back. (Standard MetaMask-style ceremony.)
- Screenshot detection on iOS / FLAG_SECURE on Android prevents trivial leaks.

Caveats spelled out in the UI:
- Imported private-key accounts have no seed; they're backed up only via cloud blob or keystore export.
- A seed phrase backs up only the HD account it generated — if the user has multiple imported accounts, they each need separate backup paths (or just cloud backup, which covers all).

### 3. Keystore JSON export

Web3 Secret Storage v3, password-encrypted. User picks an export password (separate from the vault password by default), we hand them a JSON file via the OS share sheet. Compatible with MetaMask import, ethers, geth.

Mostly for power users who already manage their own backup hygiene.

## Import flows

Users coming from an existing wallet can import on first launch or any time after.

| Source | Inputs | Result |
|---|---|---|
| BIP-39 mnemonic | 12 / 24 words | HD account at `m/44'/60'/0'/0/0`, plus option to scan and add more addresses from the same seed |
| Private key | 32-byte hex | Single account, no seed |
| Keystore JSON | File + its password | Single account, re-encrypted under our scheme |
| WalletConnect handoff (later) | QR scan | Read-only, transitional — see below |

**WalletConnect import (future):** for users who don't want to type a seed into a new app, we offer a one-shot transfer: the existing wallet (e.g., MetaMask) signs an EIP-712 attestation that proves control of the address, we generate a new key inside CAW, and the user manually transfers the CAW profile NFT and any tokens to the new address. Not a true import — it's a migration. Useful for users who don't have their seed handy but do still have working access to their old wallet.

## Recovery scenarios

Concrete cases, what the user does:

**Lost phone, has another Apple device**
→ Open CAW on iPad / new iPhone, sign in to iCloud (already there), enter vault password, done.

**Lost phone, getting a new one tomorrow**
→ Restore iCloud backup on new phone, install CAW, vault password, done.

**Lost phone, has seed phrase written down**
→ Install CAW, "I have a recovery phrase" → enter words → set new vault password → re-encrypt locally.

**Lost phone, no seed, no other device, no cloud**
→ Funds are gone. We tell users this explicitly during onboarding.

**Forgot vault password but has seed**
→ Reinstall app, restore from seed, set new password.

**Forgot vault password, no seed, has cloud backup**
→ Backup is encrypted under the password. Without the password, the cloud blob is useless. This is the case where users get burned. Mitigation: nag screen during onboarding ("write your password somewhere"), and make sure the seed-phrase backup is offered prominently as the password-independent path.

## What we explicitly don't do

- **No password reset.** We can't reset something we don't hold. Any reset flow would require us to hold a recoverable copy, which is custodial. Hard line.
- **No support-line account recovery.** Same reason.
- **No "remember password" device-level toggle that bypasses biometric.** The whole point of the password is that it's an independent factor; auto-storing it defeats the layered backup design.

## Why MetaMask doesn't do password-encrypted cloud recovery, and why we do

MetaMask deliberately doesn't offer cloud recovery. We deliberately do. The choice isn't free — it's worth being honest about what we're trading.

### What MetaMask is actually avoiding

The reasons MetaMask sticks with seed-phrase-only recovery, ranked roughly by what actually drives the decision:

1. **Their threat model is sophisticated, well-funded adversaries.** A password-encrypted blob on a server is a brute-force oracle. If the blob table leaks (server compromise, subpoena, insider, careless backup), an attacker gets unlimited offline attempts against every user's password, parallelized across millions of users. Argon2id slows this from minutes to weeks per user, but for users with weak passwords — most users — that's still tractable, and the economics scale once attackers have batched blobs to crack.
2. **Liability and brand.** A single backend breach becomes "MetaMask hacked, millions of wallets at risk," regardless of whether anything was actually decrypted. The seed-phrase model lets them say "we never held your keys" with absolute certainty. They'd rather not be a target.
3. **Support burden.** Once you offer recovery, users expect it to work and reach out when it doesn't. Wallets that offer cloud backup all staff customer support that explains, over and over, why they can't help users who forgot their password.
4. **Principle.** Some users care about "is there *any* path by which this company could ever see my keys?" MetaMask's answer is "no, by design." Cloud-recovery wallets have to say "no in practice, but the ciphertext is in our hands," which is a different statement.

These are real concerns. The crypto isn't broken — Argon2id + AES-GCM is fine — but the **bulk-leak attack surface** is genuinely there, and MetaMask doesn't want to underwrite it.

### Why we accept it anyway

Our situation is different in ways that change the math:

1. **Default user holds tens or hundreds of dollars worth of CAW, not life savings.** Cracking a $50 wallet costs more in compute than the wallet is worth. MetaMask has to protect $5M wallets in the default config; we don't.
2. **Layered defense.** The password-encrypted blob isn't the only wrapper — the passkey-prf wrap is another, and on modern Apple devices it's the primary unlock path. An attacker who steals our blob table still needs *either* a weak password OR access to a passkey-syncing device. That compound probability is meaningfully lower than MetaMask's "weak password + got the blob."
3. **We can push passkeys as the default unlock.** MetaMask can't, because they support a long tail of browsers / devices where passkeys don't exist. We can lean modern.
4. **The recovery path is non-optional for our user.** Goal is "Apple Pay → username → posts" for users who've never seen a seed phrase. Those users *will* lose seed phrases at a much higher rate than MetaMask's users. Worse-worst-case-for-1%-of-users beats worse-common-case-for-50%-of-users for our target. MetaMask makes the opposite tradeoff because they're not optimizing for that user.

### The $100k+ user

That said: it's entirely possible for users to hold $100k or even $1M of CAW in a profile. Those users exist, and the password-encrypted cloud blob is *not* the right primary backup for them. They should use a hardware wallet (Ledger / Trezor) as the owner of the profile NFT, the same way they'd use one for any other significant on-chain holding. We'll make hardware-wallet support (probably WalletConnect / BLE for Ledger Live) a first-class option in settings rather than a buried feature.

What we should explicitly do for high-value users:
- **Surface the recommendation in the UI.** When a profile balance crosses a threshold (TBD, maybe $10k worth of CAW), nudge the user: "Consider securing this profile with a hardware wallet."
- **Make the hardware-wallet path obvious in settings.** Not buried under "advanced."
- **Don't quietly upgrade cloud-recoverable users into high-value mode.** The wallet they signed up with is a "fast, recoverable" wallet; a high-value profile should be transferred to a *different* wallet they choose. Keep the cloud-recovery wallet for posting / day-to-day, the hardware wallet for storage.

This mirrors how Coinbase Wallet draws the line — easy onboarding for normal usage, but power users self-custody seriously when stakes go up. We're not pretending the cloud-recovery design is suitable for all amounts; we're being explicit that it isn't.

### Mitigations we commit to

Non-negotiable, because they're the difference between "acceptable risk" and "the breach that ends us":

- **Argon2id at high parameters** (target: 64MB memory, ≥3 iterations, parallelism tuned per platform). Validated in CI against known-cracker benchmarks.
- **Server-side rate limiting on `GET /wallet/blob`** — make remote brute-force impractical even if the account login is compromised.
- **Passkey-prf as primary unlock, password as secondary.** The fewer users whose security depends *only* on password strength, the smaller the blast radius of a blob leak.
- **Opt-out of cloud backup.** Users who want MetaMask-equivalent posture should be able to disable backend mirroring entirely and rely on seed phrase. Make this a real option, not a buried setting.
- **Transparency.** In the security settings page, explain plainly: "If our backend is breached and you have a weak password, an attacker could eventually decrypt your wallet offline." Let users make an informed choice.

### ecdsaFallback is the ultimate authority — onboarding must say this explicitly

For Population B users (phone-first, 7702 + passkey), the SmartEOA stores an `ecdsaFallback` address. This is the secp256k1 EOA whose private key lives inside the encrypted backup blob. The on-chain contract grants this key bypass authority over every passkey: it can call `removePasskey` on any device without quorum, `rotateEcdsaFallback` to swap itself out, and `addPasskey` to enroll a new device — all without any passkey signature. See `messages/plan-smart-eoa-passkey-sponsorship.md` §1 Scenario D and §2 for the on-chain rules.

This is the right contract behavior — the fallback key has to be unconditionally trusted because it's the user's last-resort recovery anchor. But it means the vault password (which decrypts the backup blob to reveal the secp256k1 private key) is functionally **the master credential for the account.** Anyone who learns the vault password and gets access to the backup blob can wipe every passkey and take over.

**The onboarding flow must convey this in plain language.** Two failure modes to defend against:

1. **User chooses a weak vault password** because they think "the passkey is the real security." Wrong — the passkey is the convenient daily-driver. The vault password is the master. A weak password + a leaked backup blob = compromised account.
2. **User reuses a password they already use somewhere else.** If that other site is breached, the attacker has a credential-stuffing attempt that, combined with a leaked backup blob, drains the account.

**Required onboarding UX:**

- During vault-password creation, a paragraph explaining: "This password unlocks your recovery key. The recovery key is the ultimate authority over your account — it can replace your passkey if your device is lost. Anyone who learns this password AND has a copy of your backup file could take over your account. Treat it like the master password it is."
- A password-strength meter that **gates** account creation. Require a meaningful entropy threshold (no "Password1!" — recommend zxcvbn score ≥ 3, or equivalent length+character-class requirement).
- An explicit warning if the password resembles common patterns or is found in a breach dictionary (HaveIBeenPwned's hashed-password API works without leaking the password).
- A "no password manager? Here's a phrase generator" affordance offering a 4-6 word passphrase (Diceware-style). For mainstream users who won't use a password manager, an unfamiliar passphrase is significantly stronger than a familiar password.

**Required security-settings UX:**

- A "Rotate recovery key" action that calls `SmartEOA.rotateEcdsaFallback(newAddress, webauthnSig)`. Document that this is the only way to render a leaked backup blob useless — the old blob, even if eventually cracked, no longer corresponds to a key the contract recognizes.
- A "View enrolled passkeys" list with `enrolledAt` timestamps. If the user sees a passkey they don't recognize (Scenario F — iCloud compromise), they need to know which devices are currently authorized.
- A "Last activity from recovery key" indicator. If the ecdsaFallback key has been used recently and the user didn't initiate it, that's the alarm bell that says "your password leaked, rotate now."

**Why this lives in the onboarding spec, not in the contract:** the contract correctly grants the fallback key its authority. Restricting that authority would break legitimate recovery. The defense against weak-password compromise lives in the FE — strong-password enforcement, clear language about what the password protects, and rotation primitives that let users respond to a leak.

This is not a one-time onboarding screen; the language about "vault password = master credential" should also appear in the security settings page, the password-change flow, and any rotation flow that touches the fallback key.

## Future recovery options

These are real improvements we should keep on the roadmap but aren't shipping with v1. Captured here so they're considered, not lost:

### Social recovery

The user designates N guardians (friends' addresses, hardware keys, our service, an email-based attester, etc.). Recovery requires K-of-N guardian signatures to authorize a key rotation. Removes the "forgot password + lost devices = funds gone" failure mode.

The catch: on-chain social recovery requires the *thing being recovered* to be programmable. An EOA private key isn't recoverable. So this either requires the EOA to be a signer on a smart account (back to ERC-4337, which we rejected for L1 cost reasons), or we build it at the **backup-blob layer** — the encrypted blob is split via Shamir / threshold cryptography across guardians instead of unlocked by a single password. The latter is doable without smart accounts but shifts trust to a new set of failure modes (guardians ghost, lose contact, collude). Worth exploring as a v2 backup option for users who specifically want it.

### ZK-email recovery

Tools like [zk-email](https://prove.email/) let a DKIM-signed email serve as a recovery factor, with a ZK proof attesting that "this email from `user@gmail.com` with subject `Recover CAW 0x...` is genuine, without revealing the email body." Effectively makes "I can still log into my email" a recovery factor that no one — including us — can forge.

Like social recovery, the on-chain version requires a smart account. The off-chain version (gating the backup blob behind a ZK-email proof) is feasible without contract changes, but requires standing up the ZK prover infrastructure or relying on a third-party service. Real, interesting, not v1.

### ERC-4337 + passkey-signed smart accounts

**Update: this is now the v1 plan, not a future option.** See [`ERC4337_REASSESSMENT.md`](ERC4337_REASSESSMENT.md).

Originally deferred for L1 cost reasons (per-user smart account deploy, UserOp overhead, expensive on-chain P-256 verification). The picture changed:

- **EIP-7702** (Pectra, May 2025) replaces "deploy a smart account per user" with a one-time ~12.5K gas authorization that delegates an EOA's code. No per-user deploy, no factory, no address migration.
- **EIP-7951** (Fusaka, Dec 2025) shipped the secp256r1 precompile on L1. On-chain passkey verification dropped from ~330K gas to ~3.5K gas.
- **ERC-1271 fallback is already in `CawActions`** (audited 2026-05). Smart-EOA-signed actions work in the existing contracts.
- **The validator service is already close to a bundler**, so we don't have to build one from scratch.

In this design the passkey *is* the wallet. The original ECDSA key still exists as a sealed-emergency backup (encrypted + cloud-mirrored, password-gated) for the "lost iCloud entirely" failure case. But the day-to-day signing path is Face ID → passkey → on-chain verification via EIP-7951 precompile. No password to remember in normal use.

This document still describes the **password + encrypted blob** path because it remains the fallback for browsers/devices without passkey-prf support, and because the underlying primitives (Argon2id, AES-GCM, hardware-backed key wrapping) are reused as the storage layer for the sealed-emergency ECDSA backup key in the passkey-primary design.

## Sanity checks during development

- Round-trip: generate → backup → wipe device → restore → verify same address signs identical EIP-712 payload bytes-for-bytes.
- Cross-platform: iOS-generated backup must restore on Android and vice versa.
- Backwards compat: bumping `version` in the blob format requires a migration path that decrypts v(N-1) and re-encrypts as vN.
