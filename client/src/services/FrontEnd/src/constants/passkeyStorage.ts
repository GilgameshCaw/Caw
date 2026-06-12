/**
 * localStorage keys for Population-B (passkey / EIP-7702) identity.
 *
 * Both values are NON-SECRET browser-scoped identifiers — safe to persist:
 *   - PASSKEY_CREDENTIAL_KEY: the base64url WebAuthn credentialId. Knowing it
 *     does not let an attacker use the passkey (the authenticator + user
 *     verification gate that). Needed to call signWithPasskey() on this device.
 *   - IDENTITY_KIND_KEY: marks this browser as a passkey ("Population B") install
 *     so useWalletPopulation() can classify a returning user who has no wagmi
 *     wallet connected (sponsored Pop-B users never connect a real wallet).
 *
 * The secp256k1 ecdsaFallback PRIVATE KEY is NEVER stored here — it lives only
 * in the Argon2id-encrypted backup blob and (transiently) in RecoveryProvider
 * React state. See project_root_signer_passkey_wallet.
 */

export const PASSKEY_CREDENTIAL_KEY = 'caw:passkey-credential-id'

export const IDENTITY_KIND_KEY = 'caw:identity-kind'

/** Value written to IDENTITY_KIND_KEY for passkey (Population B) installs. */
export const IDENTITY_KIND_PASSKEY = 'passkey'
