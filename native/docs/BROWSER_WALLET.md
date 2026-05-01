# Browser wallet (secondary path)

The native app is the flagship self-custody experience. This doc covers the **browser-only** version of the same idea — for users who can't or won't install an app, for desktop posting, and as a "try it before installing" funnel. It's deliberately the secondary path: it works, but it's worse than native, and the gap isn't fully closeable.

## What the browser actually gives us

Unlike iOS / Android, browsers don't expose anything equivalent to Secure Enclave + iCloud Keychain sync + biometric gating. Whatever we build has to use what's available:

- **localStorage / IndexedDB** — wiped by "Clear browsing data," wiped by some privacy modes, sandboxed per origin. Not encrypted at rest.
- **WebAuthn / passkeys** — actual hardware-backed keys (Secure Enclave / TPM / Titan), iCloud / Google-synced, biometric-unlocked. But P-256 only — they can't sign Ethereum txs directly.
- **Web Crypto API** — solid primitives (AES-GCM, PBKDF2, Argon2-via-WASM) but no protected key storage. Keys live wherever you put them.
- **Service workers** — limited memory persistence, aggressively killed by Safari, useful for short-lived caching but not for keeping a vault unlocked indefinitely.

Nothing here is as good as Secure Enclave. The design is about layering what's available so that the **typical** failure modes are recoverable, accepting that the worst-case failure mode (lose everything at once) is genuinely worse than native.

## The four options we considered

### 1. Encrypted blob in IndexedDB + password (MetaMask model)

Generate key, encrypt with AES-GCM under an Argon2id-derived KDF key, store in IndexedDB. Prompt password to unlock.

- **Pros:** simplest, no third-party services.
- **Cons:** "Clear browsing data" wipes it. New browser wipes it. New device wipes it. The user's password is just a decryption key — useless without the ciphertext. **This is exactly the failure mode we're trying to avoid for zero-knowledge users.**

Not viable as a standalone path for our user base. Used only as one *layer* in the hybrid below.

### 2. Encrypted blob on our backend + password

Same as #1, but ciphertext lives on our servers, keyed by the user's account (email + login). User signs in from any browser, downloads ciphertext, decrypts locally with their wallet password.

- **Pros:** survives browser wipes, cross-device, cross-browser. Still self-custodial — we hold ciphertext, not keys.
- **Cons:**
  - We're now running an account system (email verification, login, abuse limits). Wallet password ≠ account password.
  - Forgotten wallet password = unrecoverable. Users will reach out to support thinking we can fix it. We can't.
  - Server compromise leaks millions of ciphertexts → offline brute-force material. Argon2id with high parameters is the only defense, and weak passwords lose.

This is what Coinbase Wallet's cloud backup, Argent's email recovery, and many "easy onboarding" wallets do. It's the standard answer, with all the standard tradeoffs.

### 3. Passkey-encrypted blob (the cleverest option)

Use a passkey not as the *signing* key (P-256, can't sign Ethereum) but as a **wrapping key** for the secp256k1 key.

The trick: the WebAuthn `prf` extension lets a passkey deterministically derive a secret from a per-credential salt. Feed that secret to a KDF, encrypt the secp256k1 key, store the ciphertext anywhere. To unlock: Face ID → passkey produces the same secret → unwrap.

- **Pros:**
  - Biometric unlock, no password typing for daily use.
  - Passkey is iCloud Keychain-synced on Apple devices, Google Password Manager-synced on Android/Chrome — so the **unlock material** roams across devices even if the encrypted blob is local.
  - Hardware-backed: the prf secret never leaves the Secure Enclave / TPM.
  - Self-custodial: ciphertext can sit on our backend, we still can't decrypt.
- **Cons:**
  - `prf` extension support is uneven. Recent Chrome, Safari 17.4+, Firefox 119+. Older browsers fall back to password.
  - Lose access to all your passkey-syncing devices (lost Apple ID, etc.) → ciphertext is unrecoverable without a password backup.
  - Passkey enrollment prompts can be confusing for non-crypto users ("create passkey for caw.app?").

This is the closest thing to "iCloud Keychain for browser wallets" that exists today. Coinbase Smart Wallet uses passkeys directly as signers (via P-256-verifying smart accounts); we're using them as wrappers because we want EOAs on L1. Same primitive, different consumer.

### 4. Hybrid (what we ship)

We ship 1, 2, and 3 layered, letting the strongest available primitive win.

## The hybrid design

### Setup (first time)

1. User taps "Sign up" → email + (optional) password.
2. Browser generates secp256k1 keypair in memory.
3. **If `prf`-capable passkey available:** prompt Face ID → create passkey → derive prf secret → wrap key #1.
4. **Always:** prompt for a wallet password → Argon2id → wrap key #2.
5. Store both wrapped ciphertexts in IndexedDB **and** upload both to our backend, keyed by email + a server-generated user ID.
6. (Optional, deferred) Offer seed phrase reveal for users who explicitly ask. Hidden by default for the zero-knowledge path.

The user has experienced: tap "Sign up," type email, Face ID, type a password. Done. The word "wallet" never appeared.

### Daily unlock

Tries in order:
1. **Passkey unlock** (if enrolled and prf-capable). One Face ID prompt, no typing.
2. **Password unlock** (fallback). User types password.

Once unlocked, the master key sits in memory for the page session. Page reload → re-unlock. We can extend across reloads via a service worker holding the unwrapped key, but Safari's worker eviction means we can't rely on it; treat it as a nice-to-have, not a guarantee.

### Recovery on a new browser / device / after data clear

1. User opens caw.app on new browser → "Sign in" → email + login (magic link or password — the **account** password, separate from the **wallet** password).
2. Server returns the wrapped ciphertexts.
3. Browser tries:
   - Passkey unlock if the user's passkey is synced to this device (Apple → iCloud Keychain has it; Android Chrome → Google has it).
   - Password unlock if not (or if the user is on a fresh ecosystem like a Windows PC with no passkey sync).
4. Either path produces the master key, which is then re-wrapped under any new local material (e.g., a passkey enrolled on the new device).

### What's recoverable from what

| Lost | Have | Recoverable? |
|---|---|---|
| Browser data only | Anything else | Yes, re-download from backend |
| All Apple devices | Password | Yes, password unlock from any browser after backend sync |
| Password | Any synced passkey device | Yes, passkey unlock |
| Password AND all passkey devices | Backend ciphertext | **No.** Same failure mode as MetaMask without seed. |
| Backend access (we get hacked) | Local IndexedDB | Yes, local copy is identical |
| Everything at once | — | No. Surface this clearly in onboarding for users who care. |

## Comparison to native

Honest table:

| Concern | Native app | Browser hybrid |
|---|---|---|
| Key storage at rest | Secure Enclave / Keystore (hardware) | Encrypted ciphertext (software) |
| Daily unlock | Biometric, fast | Passkey biometric (modern browsers) or password (fallback) |
| Survives "clear browser data" | N/A | Only via backend mirror |
| Survives device loss | iCloud Keychain restore | Backend mirror + password OR passkey on synced device |
| Phishing resistance | App sandboxed and signed | WebAuthn is phishing-resistant; password-only path is weaker |
| Cross-device | Manual via cloud backup | Automatic via passkey sync (where available) |
| Background signing across reloads | Trivial (Secure Enclave session) | Janky (service worker, Safari kills it) |
| Worst-case failure | Lost device + lost iCloud + lost password | Lost browser data + lost password + lost all passkey devices |

The browser version is genuinely *close* to native on modern Apple / Google ecosystems where passkeys sync. It's noticeably worse on older browsers, on Windows without a passkey-syncing password manager, or on shared / public computers.

## Browser-specific UX implications

### Apple Pay / Google Pay in the browser

Both work in browsers via the PaymentRequest API. On-ramp providers (MoonPay, Ramp) ship browser SDKs that surface Apple Pay sheets in Safari and Google Pay sheets in Chrome. The on-ramp flow is **identical** to native:

```
User taps "Buy username 'foo'"
  ↓
On-ramp provider sheet opens (browser-rendered)
  ↓
Apple Pay / Google Pay confirmation
  ↓
Provider delivers USDC to relayer
  ↓
Relayer swaps to CAW, calls mintAndDepositFor
  ↓
NFT + balance land at user's address
```

The relayer flow described in [`CONTRACTS.md`](CONTRACTS.md) doesn't care whether the user is in a native app or a browser. The only difference is which side holds the user's key.

### What the browser cannot do well: silent background signing

Native can keep an unlocked vault alive across launches via Secure Enclave session semantics. The browser has three options:

- **(a) Keep the unwrapped key in memory** — lost on page reload.
- **(b) Re-prompt biometric on every reload** — annoying, kills the "just post" UX.
- **(c) Cache the unwrapped key in a service worker** — works in Chrome / Firefox, gets aggressively evicted in Safari.

We mitigate this with the existing on-chain QuickSign system: the **session key** is what signs day-to-day actions, and it sits in IndexedDB encrypted under a key derived from the master. So unlocking the master once per page-session is enough to access the session key, which then signs silently. Reload → unlock master once (Face ID or password) → session key available again → all actions silent until session expires.

This is acceptable. It's worse than the native "unlock once a day" experience but a lot better than "unlock per post."

### Phishing

WebAuthn is bound to the origin, so the passkey path is phishing-resistant by construction. The password path is not — a fake `c4w.app` site that asks for the wallet password and then exfiltrates the wrapped ciphertext from the backend (assuming an account-takeover via phishing of the *login*) could decrypt offline. Mitigations:

- Strong account-login security (magic link, optional TOTP) so the backend ciphertext isn't accessible without auth.
- Encourage passkey enrollment as the default unlock path.
- Surface domain prominently in unlock UI so users notice phishing domains.

This is the standard browser-wallet threat surface. We don't have a unique answer to it.

## Migration: browser → native

The whole point of having both paths is letting users start in the browser and graduate to native without changing identity.

The shared mechanism is the **backend-mirrored encrypted blob**. The native app, on first launch:

1. Prompts: "Already have a CAW account? Sign in." → email + login.
2. Downloads the wrapped ciphertexts from our backend.
3. Unlocks via password (or passkey, if the device has the synced passkey).
4. Extracts the master secp256k1 key.
5. Re-wraps it under Secure Enclave / Android Keystore + the user's chosen vault password (could be the same one).
6. Optionally pushes a *new* backup blob in the native format (see [`BACKUP_AND_RECOVERY.md`](BACKUP_AND_RECOVERY.md)) to iCloud Drive / Google Drive — leaving the browser's backend-stored blob in place as a fallback.

After migration, the user has the same address, the same CAW profile, the same balance — now signing from native. The browser version still works if they ever log in from a browser again; both paths read the same backend.

For users who started in native and later open a browser:

1. Browser sees no local ciphertext → "Sign in."
2. Email + login → backend returns the blob (which native pushed there, format-compatible).
3. Unlock with password / passkey.
4. Browser session has the same identity.

This requires the **backend blob format to be a superset** that both native and browser can read. We define this in v1 of the backup format (see `BACKUP_AND_RECOVERY.md` once that's pinned down). The format includes:

- Wrapped key material (multiple wrappers: passkey-prf-derived, password-derived, optionally Secure-Enclave-derived).
- Unwrap metadata (KDF params, passkey credential ID, salt).
- Account metadata (label, source, derivation path).

## What ships in v1

Browser wallet v1 (alongside or shortly after native v1):

- Email + password signup.
- secp256k1 key generated in browser.
- Password-wrapped + passkey-prf-wrapped (when available) ciphertexts.
- Backend mirror keyed by user account.
- Local IndexedDB cache.
- Apple Pay / Google Pay on-ramp via the same provider as native.
- QuickSign session keys for silent signing (already implemented).
- "Install the native app" prompt with one-tap migration.

### What's deferred

- Recovery via seed phrase (offer but don't push during onboarding).
- Multi-account in browser (single account v1; users with multiple accounts use native).
- WebAuthn-only signup (passkeys as the *only* auth, no password). Reconsider when prf support is universal.

## Honest recommendation

Ship native first. Browser hybrid second. Don't try to make browser the flagship — the device-loss recovery story is genuinely worse, and pushing a worse path as primary will burn users we could have onboarded successfully via native.

The browser path's job is to lower friction for "I just want to try it" and to keep desktop posting working. Both real, both worth supporting. Neither worth compromising native's design over.
