/**
 * useSmartEoaManagement — build and sign SmartEOA management digests.
 *
 * Mirrors the contract's _managementDigest function exactly:
 *   domainSep  = keccak256(abi.encodePacked("SmartEOA", chainId, address(this)))
 *   structHash = keccak256(abi.encodePacked(keccak256(opName), keccak256(params), nonce))
 *   digest     = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash))
 *
 * IMPORTANT: rotateEcdsaFallback (and all management ops) use
 * _verifyAnyActivePasskey, which requires a WebAuthn blob, NOT a secp256k1
 * sig. Recovery-key signing would pass _verifyEcdsaFallback but NOT
 * _verifyAnyActivePasskey. This hook therefore always calls signWithPasskey
 * directly (not useRootSigner().signDigest) so the right sig format is
 * produced even when a recovery key is in memory.
 *
 * The IdentitySigningProvider overlay is shown during the passkey ceremony.
 */

import { useCallback } from 'react'
import {
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from 'viem'
import { usePublicClient } from 'wagmi'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { signWithPasskey } from '~/services/identity/passkey'
import { signDigestForOnChain } from '~/services/identity/secp256k1Key'
import { smartEoaAbi } from '~/../../../abi/generated'
import { getJSON } from '~/utils/safeStorage'
import { PASSKEY_CREDENTIAL_KEY } from '~/constants/passkeyStorage'
import { chains } from '~/config/chains'

// ---------------------------------------------------------------------------
// Pure digest builder (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build the management digest for a SmartEOA management operation.
 * All encodePacked calls match the contract byte-for-byte.
 *
 * @param account  The user's EOA address (address(this) in contract context).
 * @param chainId  The chain the SmartEOA delegate is deployed on.
 * @param opName   Operation name string, e.g. "rotateEcdsaFallback".
 * @param params   ABI-encoded parameters (abi.encode output) for the operation.
 * @param nonce    Current managementNonce read from chain.
 */
export function buildManagementDigest(
  account: Address,
  chainId: number,
  opName: string,
  params: Hex,
  nonce: bigint,
): Hex {
  const domainSep = keccak256(
    encodePacked(
      ['string', 'uint256', 'address'],
      ['SmartEOA', BigInt(chainId), account],
    ),
  )
  const structHash = keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'uint256'],
      [
        keccak256(encodePacked(['string'], [opName])),
        keccak256(params),
        nonce,
      ],
    ),
  )
  // EIP-191 "\x19\x01" prefix — matches contract's abi.encodePacked("\x19\x01", ...)
  // Use 'bytes' (variable-length) matching buildExecuteDigest's convention.
  return keccak256(
    encodePacked(['bytes', 'bytes32', 'bytes32'], ['0x1901', domainSep, structHash]),
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSmartEoaManagementResult {
  /**
   * Build and sign a management digest for the named operation.
   * Reads the current managementNonce from chain, builds the digest,
   * and signs it via WebAuthn passkey (required by _verifyAnyActivePasskey).
   *
   * @param opName   e.g. "rotateEcdsaFallback"
   * @param params   ABI-encoded params (viem encodeAbiParameters output).
   * @returns        WebAuthn sig blob accepted by the contract's callerSig arg.
   */
  signManagement: (opName: string, params: Hex) => Promise<Hex>
  /**
   * Build and sign a management digest using the in-memory secp256k1 recovery
   * key (ecdsaFallback). Produces a 65-byte ECDSA sig, which the contract
   * accepts on its _verifyEcdsaFallback path — enabling unconditional removal
   * even when the passkey is compromised or absent on this device.
   *
   * Throws a user-facing error if the recovery key is not in memory (i.e.
   * the user is not in recovery mode / has not loaded their backup file).
   *
   * @param opName   e.g. "removePasskey"
   * @param params   ABI-encoded params (viem encodeAbiParameters output).
   * @returns        65-byte secp256k1 sig hex.
   */
  signManagementWithRecoveryKey: (opName: string, params: Hex) => Promise<Hex>
  /** The user's EOA address, or undefined if not Population B. */
  account: Address | undefined
}

export function useSmartEoaManagement(): UseSmartEoaManagementResult {
  const { address, population } = useWalletPopulation()
  const publicClient = usePublicClient({ chainId: chains.l1.chainId })
  const { startSigning, stopSigning } = useIdentitySigning()
  const recovery = useRecoveryContext()

  const account = population === 'B' ? (address as Address | undefined) : undefined

  /** Read the current managementNonce from the user's SmartEOA-delegated EOA. */
  const readManagementNonce = useCallback(async (): Promise<bigint> => {
    if (!account) throw new Error('No passkey wallet connected.')
    if (!publicClient) throw new Error('No L1 client available.')
    return (await publicClient.readContract({
      address: account,
      abi: smartEoaAbi,
      functionName: 'managementNonceOf',
    })) as bigint
  }, [account, publicClient])

  const signManagement = useCallback(
    async (opName: string, params: Hex): Promise<Hex> => {
      if (!account) throw new Error('No passkey wallet connected.')

      const credentialId = getJSON<string | null>(PASSKEY_CREDENTIAL_KEY, null)
      if (!credentialId) {
        throw new Error(
          'No passkey found on this device. Use the device where your passkey is enrolled.',
        )
      }

      const nonce = await readManagementNonce()
      const digest = buildManagementDigest(account, chains.l1.chainId, opName, params, nonce)

      // Must be a WebAuthn passkey sig — _verifyAnyActivePasskey rejects secp256k1.
      startSigning('Please authenticate with your passkey to rotate your recovery key')
      try {
        const rpId = typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social'
        const result = await signWithPasskey({ credentialId, digest, rpId })
        return result.sig
      } finally {
        stopSigning()
      }
    },
    [account, readManagementNonce, startSigning, stopSigning],
  )

  const signManagementWithRecoveryKey = useCallback(
    async (opName: string, params: Hex): Promise<Hex> => {
      if (!account) throw new Error('No passkey wallet connected.')
      if (!recovery.privateKey) {
        throw new Error(
          'Your recovery key is not loaded. Load your backup file to authorise this operation.',
        )
      }

      const nonce = await readManagementNonce()
      const digest = buildManagementDigest(account, chains.l1.chainId, opName, params, nonce)

      // secp256k1 path — accepted by the contract's _verifyEcdsaFallback branch,
      // which does unconditional removal regardless of remaining passkey count.
      const keyHex = recovery.privateKey
      const keyBytes = new Uint8Array(
        (keyHex.startsWith('0x') ? keyHex.slice(2) : keyHex)
          .match(/.{2}/g)!
          .map((b: string) => parseInt(b, 16)),
      )
      return signDigestForOnChain(keyBytes, digest)
    },
    [account, recovery.privateKey, readManagementNonce],
  )

  return { signManagement, signManagementWithRecoveryKey, account }
}
