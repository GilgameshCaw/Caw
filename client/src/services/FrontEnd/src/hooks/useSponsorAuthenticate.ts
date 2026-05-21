/**
 * useSponsorAuthenticate.ts
 *
 * Population-aware hook for authenticating a CAW profile token with a network.
 *
 * Population A (plain EOA) → direct contract call (existing CawProfile.authenticate path)
 * Population B (EIP-7702)  → sponsor server path (CawProfileMinter.authenticateSponsored)
 * Population C (other SC)  → returns an error: unsupported wallet type
 * none                     → wallet not connected
 *
 * The Population B path:
 *   1. Build EIP-712 authenticate permit digest
 *   2. Sign with the enrolled passkey (signWithPasskey)
 *   3. POST to /api/sponsor/authenticate via SponsorApiClient
 *   4. Return txHash
 *
 * For Population A, the hook returns `{ population: 'A' }` so callers can
 * dispatch to the existing writeContractAsync / ClientAuthModal flow without
 * duplicating that logic here.
 */

import { useCallback, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import {
  getSponsorApiClient,
  isSponsorSuccess,
  type SponsorErrorResponse,
} from '~/services/identity/sponsorApiClient'
import {
  buildAuthenticatePermitDigest,
  type AuthenticatePermitOpts,
} from '~/services/identity/eip712Permits'
import { signWithPasskey } from '~/services/identity/passkey'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'

const DEFAULT_LZ_TOKEN_AMOUNT = 0n

export type SponsorAuthStatus = 'idle' | 'pending' | 'success' | 'error'

export interface SponsorAuthenticateParams {
  tokenId: number
  networkId: number
  lzDestId?: number
  /** SmartEOA permit nonce for the authenticate action. */
  permitNonce: bigint
  /** Passkey credential ID (required for Population B). */
  credentialId: string
  rpId?: string
}

export interface SponsorAuthenticateResult {
  /** Population detected. 'A' means caller should use direct contract path. */
  population: 'A' | 'B' | 'C' | 'none'
  /** Only set when population === 'B' and authenticate succeeded. */
  txHash?: string
  error?: string
}

export interface UseSponsorAuthenticateReturn {
  authenticate: (params: SponsorAuthenticateParams) => Promise<SponsorAuthenticateResult>
  status: SponsorAuthStatus
  population: 'A' | 'B' | 'C' | 'none'
}

export function useSponsorAuthenticate(): UseSponsorAuthenticateReturn {
  const { population } = useWalletPopulation()
  const publicClient = usePublicClient()
  const [status, setStatus] = useState<SponsorAuthStatus>('idle')

  const authenticate = useCallback(async (params: SponsorAuthenticateParams): Promise<SponsorAuthenticateResult> => {
    if (population !== 'B') {
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

      const digestOpts: AuthenticatePermitOpts = {
        minterAddress: CAW_NAMES_MINTER_ADDRESS as `0x${string}`,
        chainId,
        networkId: params.networkId,
        tokenId: params.tokenId,
        lzDestId,
        lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT,
        nonce: params.permitNonce,
      }

      const digest = buildAuthenticatePermitDigest(digestOpts)

      const rpId = params.rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social')

      const sigResult = await signWithPasskey({
        credentialId: params.credentialId,
        digest,
        rpId,
      })

      const sponsorClient = getSponsorApiClient()
      const response = await sponsorClient.sponsorAuthenticate({
        tokenId: params.tokenId,
        networkId: params.networkId,
        lzDestId,
        lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT.toString(),
        permitNonce: params.permitNonce.toString(),
        sig: sigResult.sig,
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
        error: err instanceof Error ? err.message : 'Sponsor authenticate failed',
      }
    }
  }, [population, publicClient])

  return { authenticate, status, population }
}
