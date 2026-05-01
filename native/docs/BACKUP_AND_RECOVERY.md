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

## Sanity checks during development

- Round-trip: generate → backup → wipe device → restore → verify same address signs identical EIP-712 payload bytes-for-bytes.
- Cross-platform: iOS-generated backup must restore on Android and vice versa.
- Backwards compat: bumping `version` in the blob format requires a migration path that decrypts v(N-1) and re-encrypts as vN.
