# Plan: Passkey-user DM keys (server-wrapped, biometrics on-device)

## The problem

DM E2E encryption derives the DM keypair **deterministically from a signature**
(`deriveKeyPair(signMessage, tokenId, username)` in `useDm.ts`): sign a fixed
message → hash → DM private key. Same message ⇒ same key ⇒ recoverable on any
device. This needs a **deterministic, reproducible** signature.

- **Pop-A wallet**: ECDSA `personal_sign` — deterministic ✓
- **Pop-B secp256k1 recovery key**: deterministic ✓ — but only in memory in
  recovery mode (after the user loads their backup file + vault password)
- **Pop-B WebAuthn passkey**: **non-deterministic** ✗ — every signature carries
  a random challenge + authenticatorData; you cannot derive a stable key from
  it, and a passkey never exports key material.

So a passkey-only user has no deterministic signer → `useRootSigner.signMessage`
throws "use your backup file" (`NO_RECOVERY_KEY_MSG`). That's the bug: enabling
DMs demands the backup file even on the device they're already signed in on.

## Crypto reality (what's possible)

- The DM key must come from a reproducible secret. The only such secret a Pop-B
  user has is the **secp256k1 recovery key**.
- The recovery key lives, encrypted, in the **backup blob** (`backupBlob.ts`):
  `AES-GCM(secp256k1Key, key = Argon2id(vaultPassword, salt))`. The server
  mirror (`/api/wallet/blob`) stores the **ciphertext only** — never the
  password or plaintext.
- Therefore: decrypting anything in the blob requires the **vault password**.
  A passkey CANNOT decrypt the blob (it can't derive or export a decryption
  key — that's the passkey security model). There is no way around this without
  letting the server hold a key that can read DMs (breaks E2E). **Not an
  option.**

## The design (server-wrapped DM key)

Generate the DM keypair **once at onboarding**, when the recovery key is in
memory, and store the DM **private key inside the recovery blob** alongside the
secp256k1 key. Then:

- **Same device** (the actual bug): the DM key is cached locally (IndexedDB,
  profile-scoped). The passkey/session gates access; biometrics enable DMs. No
  password, no file. ← fixes the reported issue.
- **New device**: the passkey signs the user in, but the local DM-key cache is
  empty. Enabling DMs prompts for the **vault password ONCE** → fetch the blob
  from `/api/wallet/blob` → decrypt → extract the DM key → cache locally →
  biometrics from then on. (Same bar as Signal/WhatsApp "enter your PIN on a new
  device".)
- **Pop-A** is unchanged — it keeps deriving from the wallet signature live.

### Honest limits (state these in UI copy)
- New device ⇒ **vault password required once** (file NOT required — the server
  supplies the ciphertext). Password OR file is wrong: it's
  `(server-blob OR file) AND password`.
- Passkey-only, no password, on a new device: **impossible** for E2E DMs.

## Implementation phases

### Phase 1 — DM key generation at onboarding
- `Onboarding.tsx` / `bootstrap.ts`: after the secp256k1 key is generated and
  the user is enrolling, derive the DM keypair using the SAME `deriveKeyPair`
  the live path uses, but sign with the in-memory recovery key (deterministic).
  Equivalent to "what the user would have produced live."
- Cache the DM private key locally, profile-scoped (IndexedDB), so it's
  immediately available on this device with no further prompt.

### Phase 2 — Wrap the DM key into the recovery blob
- `backupBlob.ts`: extend the encrypted payload from `{ secp256k1Key }` to
  `{ secp256k1Key, dmPrivateKey }` (versioned — bump a blob `version` field so
  old blobs still decrypt; absent dmPrivateKey ⇒ fall back to live derivation).
- Re-encrypt + re-upload the blob (`/api/wallet/blob`) at onboarding and whenever
  the recovery key is rotated. Server still stores ciphertext only.
- The DOWNLOADED backup file gets the DM key too (it's the same blob), so the
  file remains a complete recovery artifact.

### Phase 3 — useDm: passkey-aware key acquisition
- Replace the unconditional `rootSigner.signMessage` derivation with a resolver:
  1. **Local cache hit** (this device, set up already) → use it. Passkey/session
     gates the cache read. No prompt. ← the fix.
  2. **Recovery mode** (recovery key in memory) → derive live (today's path).
  3. **Pop-B, cache miss, no recovery key** (new device) → prompt for vault
     password → fetch + decrypt the server blob → extract dmPrivateKey → cache.
  4. **Pop-A** → live wallet derivation (unchanged).
- Update the "needs your backup file" error to the accurate "enter your vault
  password to enable DMs on this device" (with file as the fallback if the
  server blob is unavailable).

### Phase 4 — Server (`verify-dm`) compatibility
- `verify-dm` already takes `{ signature, message, userId, publicKey }`. For the
  cached/unwrapped path the FE still produces the same `publicKey` + a signature
  over the auth message (signable by the DM key itself or the session). Confirm
  the endpoint doesn't assume a wallet/secp signature shape that the unwrapped
  path can't satisfy; adjust if needed. No new RPC in the handler.

### Phase 5 — Security review + QA
- Review: the DM key in the blob is under the SAME password-derived AES-GCM key
  as the recovery key — no weaker. Confirm the local cache is profile-scoped and
  cleared on Disconnect / "clear all data" (DM keys are profile-scoped per
  `feedback_human_vs_profile_scoped_credentials`). Confirm the server never
  receives the DM private key in plaintext.
- QA: same-device enable (no prompt), new-device enable (one password prompt),
  old-blob fallback (no dmPrivateKey ⇒ live derive in recovery mode), Pop-A
  unchanged.

## Files

- `client/src/services/FrontEnd/src/services/identity/backupBlob.ts` — versioned
  payload `{ secp256k1Key, dmPrivateKey? }`.
- `client/src/services/FrontEnd/src/services/identity/dmKeyDerive.ts` (or in
  `useDm`) — `deriveKeyPair` shared with onboarding.
- `client/src/services/FrontEnd/src/pages/Onboarding.tsx` /
  `services/identity/bootstrap.ts` — derive + cache + wrap at onboarding.
- `client/src/services/FrontEnd/src/hooks/useDm.ts` — the 4-way resolver.
- `client/src/services/FrontEnd/src/hooks/useRootSigner.ts` — message copy.
- `client/src/api/routes/auth.ts` (`verify-dm`) — confirm/adjust signature shape.
- `client/src/api/routes/wallet-blob.ts` — unchanged (already ciphertext-only).

## Migration note
Existing passkey users (blob already uploaded WITHOUT a dmPrivateKey) hit the
fallback: in recovery mode they derive live and the blob is re-wrapped with the
DM key on next recovery sign-in. No forced migration; the version field gates it.
