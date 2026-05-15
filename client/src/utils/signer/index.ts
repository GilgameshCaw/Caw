import type { SignerFactoryOptions, SignerKind, ValidatorSigner } from './types'
import { EnvKeySigner } from './envKey'

export type { ValidatorSigner, SignerKind, SignerFactoryOptions } from './types'
export { EnvKeySigner } from './envKey'

/**
 * Build the configured ValidatorSigner. Selection is via
 * `VALIDATOR_SIGNER_TYPE` (env|kms|socket|hsm); defaults to `env` so
 * operators with no extra config keep the pre-abstraction behavior.
 *
 * Returns null when the env-key backend is selected and the key var is unset
 * — callers decide whether that's fatal (validator submission paths) or
 * non-fatal (peer-discovery-only nodes, dm relay on api-only mirrors).
 */
export function getValidatorSigner(opts: SignerFactoryOptions): ValidatorSigner | null {
  const kind = (process.env[opts.signerKindEnv ?? 'VALIDATOR_SIGNER_TYPE'] ?? 'env') as SignerKind
  switch (kind) {
    case 'env': {
      const privateKeyHex = process.env[opts.privateKeyEnv ?? 'VALIDATOR_PRIVATE_KEY']
      if (!privateKeyHex) return null
      return new EnvKeySigner(privateKeyHex, opts.provider)
    }
    case 'kms':
      throw new Error('VALIDATOR_SIGNER_TYPE=kms not implemented (see docs/KEY_PROTECTION_COMPARISON.md)')
    case 'socket':
      throw new Error('VALIDATOR_SIGNER_TYPE=socket not implemented (see docs/SIGNER_SERVICE_DESIGN.md)')
    case 'hsm':
      throw new Error('VALIDATOR_SIGNER_TYPE=hsm not implemented')
    default:
      throw new Error(`Unknown VALIDATOR_SIGNER_TYPE: ${kind}`)
  }
}

/**
 * Convenience: same as getValidatorSigner but throws when null. Use this when
 * the caller cannot continue without a signer (validator submission loop).
 */
export function requireValidatorSigner(opts: SignerFactoryOptions): ValidatorSigner {
  const signer = getValidatorSigner(opts)
  if (!signer) {
    const envName = opts.privateKeyEnv ?? 'VALIDATOR_PRIVATE_KEY'
    throw new Error(`Missing ${envName} in env (or configure VALIDATOR_SIGNER_TYPE)`)
  }
  return signer
}
