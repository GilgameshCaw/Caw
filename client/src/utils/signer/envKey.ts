import { Wallet, type Provider, type Signer } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hexToBytes } from '../../services/InstanceRegistryService/envelopeCrypto'
import type { ValidatorSigner } from './types'

/**
 * Default ValidatorSigner: holds the secp256k1 private key directly from an
 * env var and wraps it as an ethers.Wallet. Equivalent to the pre-abstraction
 * behavior — this is what every operator runs today.
 *
 * Threat model: a process-level compromise (or any code that can read this
 * process's memory or env) recovers the key. See KMS/HSM implementations
 * for the stronger options.
 */
export class EnvKeySigner implements ValidatorSigner {
  private wallet: Wallet
  private privateKeyBytes: Uint8Array
  private cachedAddress: string

  constructor(privateKeyHex: string, provider?: Provider | null) {
    if (!privateKeyHex) {
      throw new Error('EnvKeySigner: privateKeyHex is required')
    }
    this.wallet = provider ? new Wallet(privateKeyHex, provider) : new Wallet(privateKeyHex)
    this.privateKeyBytes = hexToBytes(privateKeyHex)
    this.cachedAddress = this.wallet.address
  }

  getAddress(): string {
    return this.cachedAddress
  }

  async signDigest(digest: Uint8Array): Promise<{ r: string; s: string; v: number }> {
    if (digest.length !== 32) {
      throw new Error(`EnvKeySigner.signDigest: digest must be 32 bytes (got ${digest.length})`)
    }
    const sig = secp256k1.sign(digest, this.privateKeyBytes)
    const compact = sig.toCompactRawBytes()
    const r = '0x' + bytesToHex(compact.slice(0, 32))
    const s = '0x' + bytesToHex(compact.slice(32, 64))
    const v = (sig.recovery ?? 0) & 1
    return { r, s, v }
  }

  asEthersSigner(): Signer {
    return this.wallet
  }

  reconnect(provider: Provider): void {
    this.wallet = new Wallet(toHex(this.privateKeyBytes), provider)
    this.cachedAddress = this.wallet.address
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  return '0x' + bytesToHex(bytes)
}
