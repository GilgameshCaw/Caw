/**
 * localStorage keys for Population-B (passkey / EIP-7702) identity.
 *
 * Both values are NON-SECRET browser-scoped identifiers — safe to persist:
 *   - the WebAuthn credentialId: knowing it does not let an attacker use the
 *     passkey (the authenticator + user verification gate that). Needed to call
 *     signWithPasskey() on this device.
 *   - the identity-kind marker: lets useWalletPopulation() classify a returning
 *     user who has no wagmi wallet connected (sponsored Pop-B users never
 *     connect a real wallet).
 *
 * The secp256k1 ecdsaFallback PRIVATE KEY is NEVER stored here — it lives only
 * in the Argon2id-encrypted backup blob and (transiently) in RecoveryProvider
 * React state. See project_root_signer_passkey_wallet.
 *
 * PER-ACCOUNT SCOPING (multi-account fix)
 * ----------------------------------------
 * A browser can now hold BOTH a passkey account and a plain-wallet account.
 * These keys used to be browser-global, which bled across accounts: once any
 * passkey user signed in, a later plain-wallet user got misclassified as
 * Population B and prompted for the *previous* passkey user's credential.
 *
 * So they are now scoped per-account:
 *   - The credential is keyed by the profile's tokenId — the stable identifier
 *     for the chosen account, always available at signing time and persisted
 *     across reload (zustand `caw-token-data`). Independent of whether a wagmi
 *     wallet is connected (a locked Rabby reports "no wallet" but the chosen
 *     tokenId survives).
 *   - The "is a passkey account" marker is keyed by the owner ADDRESS, because
 *     cold-load classification in useWalletPopulation can run in the brief
 *     pre-hydration window before a tokenId resolves — and lastAddress is the
 *     one per-account identifier guaranteed present there.
 */

import { getJSON, setJSON } from '~/utils/safeStorage'

/** Value stored in the per-address identity marker for passkey installs. */
export const IDENTITY_KIND_PASSKEY = 'passkey'

// ── Legacy browser-global keys (pre multi-account). Read once for cutover, then
// deleted. Do NOT write these anymore. ───────────────────────────────────────
const LEGACY_PASSKEY_CREDENTIAL_KEY = 'caw:passkey-credential-id'
const LEGACY_IDENTITY_KIND_KEY = 'caw:identity-kind'

// ── Per-account key builders ─────────────────────────────────────────────────
const credentialKey = (tokenId: number | string) => `caw:passkey-credential-id:${tokenId}`
const identityKindKey = (address: string) => `caw:identity-kind:${address.toLowerCase()}`

// ── Credential (per tokenId) ─────────────────────────────────────────────────

/** Read the WebAuthn credentialId for a given profile tokenId, or null. */
export function getPasskeyCredential(tokenId: number | string | undefined | null): string | null {
  if (tokenId === undefined || tokenId === null) return null
  return getJSON<string | null>(credentialKey(tokenId), null)
}

/** Store the WebAuthn credentialId for a profile tokenId. */
export function setPasskeyCredential(tokenId: number | string, credentialId: string): void {
  setJSON(credentialKey(tokenId), credentialId)
}

/** True iff THIS browser holds a stored WebAuthn credential for the given tokenId. */
export function hasPasskeyCredentialForToken(tokenId: number | string | undefined | null): boolean {
  return getPasskeyCredential(tokenId) != null
}

/**
 * True iff THIS browser holds a stored WebAuthn credential for ANY token owned by
 * `address`. This is the authoritative "can this browser sign as a passkey for this
 * address" test — it is per-ADDRESS (not per-profile-that-once-signed-in), so a
 * profile that was just transferred IN to an address the user already controls in
 * this browser is recognized immediately (it keeps its own tokenId, and the
 * credential for that tokenId is unaffected by the transfer).
 *
 * Deliberately does NOT fall back to the identity-kind marker (`isPasskeyAddress`):
 * that marker only records "this address is a passkey account", not "this browser
 * can sign for it" — a watch-only wallet (e.g. a passkey address added to Rabby as
 * a viewer) must NOT pass this test even though the address is a genuine 7702
 * delegate on-chain.
 */
export function hasPasskeyCredentialForAddress(
  address: string | undefined | null,
  tokensByAddress: Record<string, { tokenId: number }[]>
): boolean {
  if (!address) return false
  const normalized = address.toLowerCase()
  const tokens = Object.entries(tokensByAddress)
    .find(([addr]) => addr.toLowerCase() === normalized)?.[1]
  if (!tokens || tokens.length === 0) return false
  return tokens.some(t => hasPasskeyCredentialForToken(t.tokenId))
}

/**
 * Resolve the WebAuthn credential this browser should use to sign for `tokenId`.
 * Returns the token's OWN credential if present; otherwise falls back to a
 * SIBLING profile's credential under the SAME owner address. This is correct
 * because every profile owned by one SmartEOA is signed by the SAME passkey — so
 * any sibling's credentialId is the right one. It also self-heals the case where
 * a token's own credential pointer was dropped (e.g. a transfer between the
 * user's own passkey addresses cleared it) as long as a sibling under the new
 * owner still has one. Returns null only when NO token under the owner has a
 * credential (genuinely not signable here).
 */
export function resolvePasskeyCredentialForToken(
  tokenId: number | string | undefined | null,
  tokensByAddress: Record<string, { tokenId: number }[]>
): string | null {
  const own = getPasskeyCredential(tokenId)
  if (own) return own
  if (tokenId === undefined || tokenId === null) return null
  const idNum = Number(tokenId)
  // Find the owner address of this token, then any sibling with a credential.
  for (const tokens of Object.values(tokensByAddress)) {
    if (!tokens.some(t => t.tokenId === idNum)) continue
    for (const t of tokens) {
      const sib = getPasskeyCredential(t.tokenId)
      if (sib) return sib
    }
  }
  return null
}

/**
 * Forget a profile's WebAuthn credential. Call when the profile is no longer
 * owned by this browser's identity (sold/transferred away) — the credential is
 * useless once we don't control the owner EOA, and leaving it would keep the
 * profile classified as ours. Safe no-op if the key is absent.
 */
export function clearPasskeyCredential(tokenId: number | string): void {
  try { localStorage.removeItem(credentialKey(tokenId)) } catch { /* storage unavailable */ }
}

/** Forget an owner address's "is a passkey account" marker. Call only once the
 *  address holds NO remaining passkey profiles for this browser. */
export function clearPasskeyAddress(address: string): void {
  try { localStorage.removeItem(identityKindKey(address)) } catch { /* storage unavailable */ }
}

// ── Identity-kind marker (per owner address) ─────────────────────────────────

/** True if the given owner address is marked as a passkey (Population-B) account. */
export function isPasskeyAddress(address: string | undefined | null): boolean {
  if (!address) return false
  return getJSON<string | null>(identityKindKey(address), null) === IDENTITY_KIND_PASSKEY
}

/** Mark an owner address as a passkey (Population-B) account. */
export function markPasskeyAddress(address: string): void {
  setJSON(identityKindKey(address), IDENTITY_KIND_PASSKEY)
}

/**
 * Write both per-account markers at passkey enroll / sign-in time. Call with the
 * profile's tokenId and its owner (SmartEOA) address.
 */
export function persistPasskeyIdentity(tokenId: number | string, ownerAddress: string, credentialId: string): void {
  setPasskeyCredential(tokenId, credentialId)
  markPasskeyAddress(ownerAddress)
  rememberPasskeyWallet(ownerAddress)
}

// ── Durable "passkey wallets this browser controls" set ──────────────────────
//
// A SINGLE enumerable key holding every SmartEOA address this browser has ever
// enrolled/minted a passkey wallet for. Unlike the per-address identity-kind
// marker (which `removeToken` deletes when a wallet's last profile is
// transferred away, so a funds-holding wallet vanishes from the UI with no
// trace), this set is NEVER touched by profile eviction. It is the enumerable
// source that lets AccountSettings surface a profile-LESS passkey wallet so the
// user can rescue CAW/ETH stranded in it or mint a new profile back into it.
//
// It is removed ONLY by an explicit user action: `forgetPasskeyWallet(addr)`
// ("remove this wallet, no trace") or `clearAllPasskeyWallets()` (the full
// browser-data wipe). That deliberate-forget path is why we keep this separate
// from `removeToken` rather than making removeToken preserve the marker.
//
// Non-secret: just addresses of 7702 delegates. Signing still requires the
// passkey authenticator (device) or a loaded backup key.
const PASSKEY_WALLETS_KEY = 'caw:passkey-wallets'

/** All passkey-wallet addresses this browser knows it controls (lowercased). */
export function listPasskeyWallets(): string[] {
  const arr = getJSON<string[] | null>(PASSKEY_WALLETS_KEY, null)
  if (!Array.isArray(arr)) return []
  // Defensive: dedupe + normalize (older writes or hand-edits could vary case).
  return Array.from(new Set(arr.map(a => String(a).toLowerCase())))
}

/** Record a passkey-wallet address as controlled by this browser (idempotent). */
export function rememberPasskeyWallet(address: string): void {
  if (!address) return
  const lc = address.toLowerCase()
  const current = listPasskeyWallets()
  if (current.includes(lc)) return
  setJSON(PASSKEY_WALLETS_KEY, [...current, lc])
}

/** Explicitly forget ONE passkey wallet (user chose "remove this wallet"). Also
 *  clears its identity-kind marker so no trace of it remains. */
export function forgetPasskeyWallet(address: string): void {
  if (!address) return
  const lc = address.toLowerCase()
  const next = listPasskeyWallets().filter(a => a !== lc)
  setJSON(PASSKEY_WALLETS_KEY, next)
  clearPasskeyAddress(lc)
}

/** Wipe the entire known-wallets set (part of the full browser-data clear). */
export function clearAllPasskeyWallets(): void {
  try { localStorage.removeItem(PASSKEY_WALLETS_KEY) } catch { /* storage unavailable */ }
}

// ── One-time cutover: drop the old browser-global keys ───────────────────────

/**
 * Hard cutover from the old browser-global keys. Deletes them so a stale global
 * passkey flag/credential can never again bleed into a different account. Safe
 * to call on every app load (no-op once the keys are gone). Existing passkey
 * users re-authenticate once to repopulate the per-account keys.
 */
export function clearLegacyGlobalPasskeyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_PASSKEY_CREDENTIAL_KEY)
    localStorage.removeItem(LEGACY_IDENTITY_KIND_KEY)
  } catch {
    // localStorage unavailable (SSR/private mode) — nothing to clear.
  }
}
