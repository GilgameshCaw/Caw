# Wallet

How keys are generated, stored, and used on-device.

## Key model

Each user can have multiple **accounts**. Each account is one of:

- **Generated HD wallet** — BIP-39 mnemonic, BIP-44 path `m/44'/60'/0'/0/0`, secp256k1. The default for new users.
- **Imported seed** — user pastes a BIP-39 mnemonic; we derive the same way. May also expose multiple addresses from one seed (settings → "show more addresses from this seed").
- **Imported private key** — raw 32-byte secp256k1 hex. No seed, can't reveal a mnemonic later.
- **Imported keystore** — Web3 Secret Storage JSON; user provides the file's password to decrypt, we re-encrypt under our local scheme.

One account is **active** at any time; that's the address signing on behalf of the user. Switching is a tap in settings.

## Storage layout

Per account we store:

```
account_<address>:
  metadata:                       # plaintext, in app data dir
    address
    label
    source                        # generated | imported_seed | imported_pk | imported_keystore
    hasSeed                       # bool
    createdAt
    derivationPath?               # for HD accounts

  ciphertext:                     # encrypted blob
    seed_or_privkey               # depending on source
    encScheme: "aes-256-gcm"
    kdf: "argon2id"
    kdfParams: { mem, iter, par, salt }
    nonce
    tag
```

The blob is encrypted with a key derived from the user's **vault password** (Argon2id). The vault password is the same for all accounts on the device — one password unlocks the wallet, not one per account.

### Where the ciphertext lives

- **iOS**: Keychain item, `kSecClass=kSecClassGenericPassword`, access group scoped to the app, `kSecAttrAccessible=kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The Keychain item is a wrapper: it stores the ciphertext encrypted again by a Secure Enclave–wrapped key. So even if the Keychain DB is somehow exfiltrated off-device, the ciphertext is unusable without that Secure Enclave key.
- **Android**: EncryptedFile (Jetpack Security) under app-private storage, with the master key in Android Keystore (`StrongBox` if available), `setUserAuthenticationRequired(true)` so decryption requires biometric.

In both cases:
- Daily signing: biometric unlocks the hardware-wrapped key → decrypts the in-memory vault → signs.
- Recovery from cloud backup or import: the password is required (biometric alone isn't enough, because the password is what derives the KDF key for the backup blob).

### Why both a password and biometric

- **Biometric** is the daily UX — fast, no typing, hardware-attested user presence.
- **Password** is the recovery anchor — survives device loss, can decrypt a backup blob on a fresh install where biometric enrollment is gone.

The in-memory vault holds the password-derived key after first unlock per session, so signing is biometric-only after that. Session times out (configurable; default 15 min idle, 1 hour max) and locks the vault.

## Signing

Three operations exposed to the web app:

1. **`personal_sign`** — `eth_sign` of `keccak256("\x19Ethereum Signed Message:\n" + len + msg)`. Used by CAW for legacy login flows.
2. **`eth_signTypedData_v4`** — EIP-712. Used by everything in `CawActions` and session-key registration.
3. **`eth_signTransaction` / `eth_sendTransaction`** — for L1 mints, transfers, and any non-meta-transaction action.

Every signature requires a fresh biometric unless within the active unlocked session. We can tighten this per operation (e.g., always re-prompt for `eth_sendTransaction` regardless of session state) — see policy below.

### Signing policy

Three risk tiers:

| Tier | Examples | Default policy |
|---|---|---|
| Low | `personal_sign` for CAW login, registering a session key with a small spend cap | Biometric, then unlocked-session window applies |
| Medium | EIP-712 actions outside session scope, registering a high-cap session | Biometric every time |
| High | `eth_sendTransaction`, exporting seed, removing account | Biometric + password every time |

Configurable in settings ("Always require Face ID for transactions" toggle, etc.).

## Multi-account UX

Users with zero crypto knowledge see a single account; the multi-account UI is hidden behind a "Wallets" screen in settings.

Power-user features:
- Add account → choose: generate new / import seed / import private key / import keystore
- Switch active account (taps a row, biometric, done)
- Label each account ("main", "alt", "burner")
- Reveal seed (high-tier signing policy)
- Export private key (high-tier)
- Export keystore JSON (high-tier; user picks an export password)
- Remove account (high-tier; warns about backup)

The CAW username NFT lives at exactly one address. Switching accounts in the wallet switches *which* CAW profile is active in the app — same as MetaMask's account switch.

## What we never do

- Send keys, seed, or password to any server.
- Store keys in plaintext anywhere on disk, even briefly.
- Allow the WebView to read keystore items directly. The bridge never returns a plaintext key to JS — only signatures.
- Auto-decrypt the vault without user presence (biometric or password). No "remember me forever" mode.

## Test vectors

`shared/test-vectors/` contains canonical inputs (seed → derivation → address, EIP-712 payload → signature) so iOS and Android implementations can be verified to produce byte-identical outputs against ethers.js.
