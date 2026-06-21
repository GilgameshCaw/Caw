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
