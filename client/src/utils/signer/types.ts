import type { Provider, Signer } from 'ethers'

/**
 * Backend-agnostic signing capability for server-side validator/relay code.
 *
 * Today the only implementation is EnvKeySigner (plaintext private key from
 * env), but the interface is shaped so cloud-KMS or hardware-backed
 * implementations can drop in. See docs/KEY_PROTECTION_COMPARISON.md.
 *
 * The shape is intentionally narrow: only the two signing flows the codebase
 * actually uses (on-chain transactions via ethers Signer, raw secp256k1
 * digest signing for DM-relay envelopes). signMessage / signTypedData are
 * deliberately NOT here; if a future feature needs them, add then.
 */
export interface ValidatorSigner {
  /** Synchronous address read. Cached at construction; safe in hot paths. */
  getAddress(): string

  /**
   * Sign a raw 32-byte secp256k1 digest. The digest is the OUTPUT of whatever
   * hash the caller chose (e.g. sha256, keccak256) — no extra hashing is done
   * inside. Used by DmRelayService for canonical envelope signing.
   *
   * Returns the signature components in the same shape signCanonical
   * historically returned (r/s/v hex, v in {0,1}).
   */
  signDigest(digest: Uint8Array): Promise<{ r: string; s: string; v: number }>

  /**
   * Return an ethers v6 Signer wired to this backend, suitable for passing
   * into `new Contract(addr, abi, signer)`. For EnvKeySigner this is the
   * underlying ethers.Wallet. KMS / HSM implementations return their own
   * ethers-compatible signer object.
   */
  asEthersSigner(): Signer

  /**
   * Rebind the underlying signer to a new provider. Used by the validator's
   * `rebuildHttpProvider()` path — when the http provider is recreated, the
   * signer needs to reattach. No-op for backends that don't hold a provider.
   */
  reconnect(provider: Provider): void

  /** Optional cleanup (close sockets, drop KMS clients, etc). */
  dispose?(): Promise<void>
}

export type SignerKind = 'env' | 'socket' | 'kms' | 'hsm'

export interface SignerFactoryOptions {
  /** Provider to bind the underlying ethers.Wallet to. Optional — DM-relay
   *  flows that only call signDigest don't need a provider. Callers that
   *  pass the signer into `new Contract(...)` must supply one. */
  provider?: Provider | null
  /** Override the env var name. Defaults to VALIDATOR_PRIVATE_KEY.
   *  ValidatorService uses REPLICATOR_PRIVATE_KEY for the submitter wallet
   *  in test mode — pass that name here. */
  privateKeyEnv?: string
  /** Override the signer-type env var. Defaults to VALIDATOR_SIGNER_TYPE. */
  signerKindEnv?: string
}
