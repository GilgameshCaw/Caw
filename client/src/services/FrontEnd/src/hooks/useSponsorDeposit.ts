/**
 * useSponsorDeposit.ts
 *
 * Population-aware hook for depositing CAW into a user's profile balance.
 *
 * Population A (plain EOA) → direct contract call (existing CawProfileMinter.depositFor path)
 * Population B (EIP-7702)  → sponsor server path (CawProfileMinter.depositForSponsored)
 * Population C (other SC)  → returns an error: unsupported wallet type
 * none                     → wallet not connected
 *
 * The Population B path:
 *   1. Build EIP-712 depositFor permit digest
 *   2. Sign with the enrolled passkey (signWithPasskey)
 *   3. POST to /api/sponsor/deposit via SponsorApiClient
 *   4. Return txHash
 *
 * Note: the passkey credential must be stored in component state from the
 * onboarding flow. This hook accepts it as a parameter. If credentialId is
 * absent for a Population B user, the hook falls back to a clear error
 * rather than silently using a wrong path.
 *
 * The Population A direct-call path is NOT implemented in this hook — it
 * delegates back to the existing useContractCall / writeContractAsync flow
 * by returning `{ population: 'A' }` so callers can dispatch appropriately.
 * This keeps the hook focused on the sponsor routing decision without
 * duplicating the existing wagmi write logic.
 */

import { useCallback, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import {
  getSponsorApiClient,
  isSponsorSuccess,
  type SponsorErrorResponse,
} from '~/services/identity/sponsorApiClient'
import {
  buildDepositForPermitDigest,
  type DepositForPermitOpts,
} from '~/services/identity/eip712Permits'
import { signWithPasskey } from '~/services/identity/passkey'
import { signDigestForOnChain } from '~/services/identity/secp256k1Key'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'

// Default LZ token amount — pass 0 unless the sponsor server requires ZRO.
const DEFAULT_LZ_TOKEN_AMOUNT = 0n

export type SponsorDepositStatus = 'idle' | 'pending' | 'success' | 'error'

export interface SponsorDepositParams {
  tokenId: number
  networkId: number
  amount: bigint
  lzDestId?: number
  /** SmartEOA permit nonce for the depositFor action. */
  permitNonce: bigint
  /** Passkey credential ID (required for Population B). */
  credentialId: string
  rpId?: string
}

export interface SponsorDepositResult {
  /** Population detected. 'A' means caller should use direct contract path. */
  population: 'A' | 'B' | 'C' | 'none'
  /** Only set when population === 'B' and deposit succeeded. */
  txHash?: string
  error?: string
}

export interface UseSponsorDepositReturn {
  deposit: (params: SponsorDepositParams) => Promise<SponsorDepositResult>
  status: SponsorDepositStatus
  population: 'A' | 'B' | 'C' | 'none'
}

export function useSponsorDeposit(): UseSponsorDepositReturn {
  const { population } = useWalletPopulation()
  const publicClient = usePublicClient()
  const recovery = useRecoveryContext()
  const [status, setStatus] = useState<SponsorDepositStatus>('idle')

  const deposit = useCallback(async (params: SponsorDepositParams): Promise<SponsorDepositResult> => {
    if (population !== 'B') {
      // Population A → caller uses direct path; C/none → error
      if (population === 'C') {
        return {
          population: 'C',
          error: 'Your wallet type is not yet supported. Please use a regular EOA or upgrade to a 7702 smart account.',
        }
      }
      return { population }
    }

    setStatus('pending')

    try {
      const chainId = publicClient
        ? await publicClient.getChainId()
        : chains.l1?.chainId ?? 11155111

      const lzDestId = params.lzDestId ?? chains.l2?.layerZero ?? 40245

      const digestOpts: DepositForPermitOpts = {
        minterAddress: CAW_NAMES_MINTER_ADDRESS as `0x${string}`,
        chainId,
        networkId: params.networkId,
        tokenId: params.tokenId,
        amount: params.amount,
        lzDestId,
        lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT,
        nonce: params.permitNonce,
      }

      const digest = buildDepositForPermitDigest(digestOpts)

      // Recovery mode: sign with secp256k1 ecdsaFallback key instead of passkey.
      // The 65-byte ECDSA blob is accepted by SmartEOA's ecdsaFallback dispatch path.
      let sigHex: `0x${string}`
      if (recovery.isInRecoveryMode && recovery.privateKey) {
        // Convert hex key to Uint8Array for signDigestForOnChain
        const keyHex = recovery.privateKey.startsWith('0x')
          ? recovery.privateKey.slice(2)
          : recovery.privateKey
        const keyBytes = new Uint8Array(
          keyHex.match(/.{2}/g)!.map(b => parseInt(b, 16))
        )
        sigHex = signDigestForOnChain(keyBytes, digest)
      } else {
        const rpId = params.rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social')
        const sigResult = await signWithPasskey({
          credentialId: params.credentialId,
          digest,
          rpId,
        })
        sigHex = sigResult.sig as `0x${string}`
      }

      const sponsorClient = getSponsorApiClient()
      const response = await sponsorClient.sponsorDeposit({
        tokenId: params.tokenId,
        networkId: params.networkId,
        amount: params.amount.toString(),
        lzDestId,
        lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT.toString(),
        permitNonce: params.permitNonce.toString(),
        sig: sigHex,
      })

      if (isSponsorSuccess(response)) {
        setStatus('success')
        return { population: 'B', txHash: response.txHash }
      }

      const errResp = response as SponsorErrorResponse
      setStatus('error')
      return {
        population: 'B',
        error: errResp.detail ?? errResp.error,
      }
    } catch (err: unknown) {
      setStatus('error')
      return {
        population: 'B',
        error: err instanceof Error ? err.message : 'Sponsor deposit failed',
      }
    }
  }, [population, publicClient, recovery])

  return { deposit, status, population }
}
