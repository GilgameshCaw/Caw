import { useCallback, useEffect } from 'react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSignTypedData, useSignMessage, useSwitchChain, useChainId, useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { baseSepolia } from 'wagmi/chains'
import { apiFetch } from '~/api/client'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { cawNameL2Abi } from '~/../../../abi/generated'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { encryptPrivateKey, getEncryptionSignMessage, setDecryptedKey } from '~/services/sessionKeyEncryption'

export const DEFAULT_SESSION_DURATION = 30 * 24 * 60 * 60 // 1 month

export const SESSION_DURATION_OPTIONS = [
  { label: '1 week',    value: 7 * 24 * 60 * 60 },
  { label: '1 month',   value: 30 * 24 * 60 * 60 },
  { label: '3 months',  value: 90 * 24 * 60 * 60 },
  { label: '6 months',  value: 180 * 24 * 60 * 60 },
  { label: '1 year',    value: 365 * 24 * 60 * 60 },
]

// Default scope: CAW(0), LIKE(1), UNLIKE(2), RECAW(3), FOLLOW(4), UNFOLLOW(5)
// Bits 0-5 (caw, like, unlike, recaw, follow, unfollow) + bit 7 (other: tips, profile updates, etc.)
// Bit 6 (withdraw) is the only one excluded
const DEFAULT_SCOPE = 0xBF // 0b10111111

// Default spend limit: $5 worth of CAW at current price, with a generous fallback
const DEFAULT_SPEND_USD = 5
const FALLBACK_SPEND_LIMIT = BigInt(500_000_000) // 500M CAW fallback if price unavailable

/** Get the default spend limit ($5 worth of CAW at current price) */
export function getDefaultSpendLimit(): bigint {
  const cawPrice = usePriceStore.getState().priceMap['a-hunters-dream'] ?? 0
  if (cawPrice > 0) {
    return BigInt(Math.round(DEFAULT_SPEND_USD / cawPrice))
  }
  return FALLBACK_SPEND_LIMIT
}

// Legacy export for any direct references
export const DEFAULT_SPEND_LIMIT = FALLBACK_SPEND_LIMIT

/** Get the default tip ceiling: the "Standard" tier (midpoint between base and priority).
 *  Callers should pass `getTipTiers().standard` from `~/api/actions`. */
export function getDefaultTipCeiling(standardTierTip: bigint): bigint {
  return standardTierTip
}

export const SPEND_LIMIT_OPTIONS = [
  { label: '10M',  value: BigInt(10_000_000) },
  { label: '50M',  value: BigInt(50_000_000) },
  { label: '100M', value: BigInt(100_000_000) },
  { label: '500M', value: BigInt(500_000_000) },
  { label: 'No limit', value: BigInt(0) },
]

const SESSION_DOMAIN = {
  name:              'CawNameL2',
  version:           '1',
  chainId:           baseSepolia.id,
  verifyingContract: CAW_NAMES_L2_ADDRESS,
} as const

const DELEGATION_TYPES = {
  SessionDelegation: [
    { name: 'sessionKey',     type: 'address'  },
    { name: 'expiry',         type: 'uint64'   },
    { name: 'scopeBitmap',    type: 'uint8'    },
    { name: 'spendLimit',     type: 'uint256'  },
    { name: 'nonce',          type: 'uint256'  },
  ],
} as const

export function useCreateSession() {
  const { signTypedDataAsync } = useSignTypedData()
  const { signMessageAsync } = useSignMessage()
  const { switchChainAsync } = useSwitchChain()
  const { isConnected, address: connectedAddress } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const setSession = useSessionKeyStore(s => s.setSession)

  return useCallback(async (onProgress?: (status: string) => void, spendLimit: bigint = DEFAULT_SPEND_LIMIT, durationSeconds: number = DEFAULT_SESSION_DURATION, encryptWithWallet: boolean = false, tipCeiling: bigint = 0n) => {
    if (!isConnected) {
      openConnectModal?.()
      return null as any // User will retry after connecting
    }

    // Ensure wallet is on Base Sepolia (where CawNameL2 lives)
    if (chainId !== baseSepolia.id) {
      onProgress?.('Switching network...')
      await switchChainAsync({ chainId: baseSepolia.id })
    }

    onProgress?.('Generating session key...')

    // Fetch the signer's current session nonce from L2 contract
    const { createPublicClient, http } = await import('viem')
    const l2Client = createPublicClient({ chain: baseSepolia, transport: http() })
    const nonce = await l2Client.readContract({
      address: CAW_NAMES_L2_ADDRESS,
      abi: cawNameL2Abi,
      functionName: 'sessionNonce',
      args: [connectedAddress!],
    }) as bigint

    const expiry = Math.floor(Date.now() / 1000) + durationSeconds

    // Generate ephemeral keypair
    const privateKey = generatePrivateKey()
    const sessionAccount = privateKeyToAccount(privateKey)

    const message = {
      sessionKey:    sessionAccount.address,
      expiry:        BigInt(expiry),
      scopeBitmap:   DEFAULT_SCOPE,
      spendLimit,
      nonce,
    }

    console.log('[QuickSign] domain:', SESSION_DOMAIN)
    console.log('[QuickSign] message:', message)
    console.log('[QuickSign] types:', DELEGATION_TYPES)

    onProgress?.('Sign to authorize key...')

    // Owner signs the delegation (one wallet popup)
    let signature: `0x${string}`
    try {
      signature = await signTypedDataAsync({
        domain:      SESSION_DOMAIN,
        types:       DELEGATION_TYPES,
        primaryType: 'SessionDelegation',
        message,
      })
    } catch (err) {
      console.error('[QuickSign] signTypedData failed:', err)
      throw err
    }

    console.log('[QuickSign] signature obtained, submitting to validator...')
    onProgress?.('Submitting...')

    // Submit to the validator API — returns immediately with a requestId
    const result = await apiFetch<{ requestId: string; status: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        delegation: {
          sessionKey:    sessionAccount.address,
          expiry:        expiry.toString(),
          scopeBitmap:   DEFAULT_SCOPE,
          spendLimit:    spendLimit.toString(),
          nonce:         nonce.toString(),
        },
        signature,
      }),
    })

    console.log('[QuickSign] Request created:', result.requestId)

    // Poll for completion (backend handles L2 sync waiting + tx submission)
    for (let i = 0; i < 80; i++) { // max ~4 minutes (covers 3min sync + tx time)
      await new Promise(r => setTimeout(r, 3000))
      try {
        const status = await apiFetch<{ status: string; txHash?: string; blockNumber?: number; error?: string }>(
          `/api/sessions/status/${result.requestId}`
        )

        // Update progress message based on backend state
        if (status.status === 'waiting_for_sync') {
          onProgress?.('Waiting for L2 sync...')
        } else if (status.status === 'submitting') {
          onProgress?.('Registering on-chain...')
        } else if (status.status === 'pending') {
          onProgress?.('Confirming transaction...')
        } else if (status.status === 'confirmed') {
          console.log('[QuickSign] Confirmed:', status.txHash, 'block:', status.blockNumber)
          break
        } else if (status.status === 'failed') {
          console.error('[QuickSign] Registration failed:', status.error, 'Full status:', JSON.stringify(status))
          throw new Error(status.error || 'Something went wrong. Please try again.')
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('API')) throw e
        // Ignore transient polling errors
      }
    }

    // Store session locally after confirmation
    if (encryptWithWallet && connectedAddress) {
      onProgress?.('Encrypting session key...')
      // Sign a deterministic message to derive the encryption key
      const walletSig = await signMessageAsync({ message: getEncryptionSignMessage() })
      const encryptedKey = await encryptPrivateKey(privateKey, walletSig)

      // Store decrypted key in memory + broadcast to other tabs
      setDecryptedKey(connectedAddress, privateKey)

      setSession({
        privateKey: '0xencrypted' as `0x${string}`, // placeholder — real key is in memory
        address: sessionAccount.address,
        ownerAddress: connectedAddress?.toLowerCase(),
        expiry,
        scopeBitmap: DEFAULT_SCOPE,
        spendLimit: spendLimit.toString(),
        tipCeiling: tipCeiling.toString(),
        encrypted: true,
        encryptedKey,
      })
    } else {
      setSession({
        privateKey,
        address: sessionAccount.address,
        ownerAddress: connectedAddress?.toLowerCase(),
        expiry,
        scopeBitmap: DEFAULT_SCOPE,
        spendLimit: spendLimit.toString(),
        tipCeiling: tipCeiling.toString(),
      })
    }

    return { address: sessionAccount.address, expiry }
  }, [isConnected, connectedAddress, openConnectModal, chainId, signTypedDataAsync, signMessageAsync, switchChainAsync, setSession])
}

export function useRevokeSession() {
  const clearSession = useSessionKeyStore(s => s.clearSession)
  const session = useSessionKeyStore(s => s.getSession())
  const activeToken = useActiveToken()

  return useCallback(async () => {
    const sessionKey = session?.privateKey
    const sessionAddress = session?.address
    const ownerAddress = activeToken?.owner

    if (!sessionKey || !sessionAddress || !ownerAddress) {
      // No session or no owner info — just clear locally
      clearSession()
      return
    }

    // Sign a revocation message with the session key
    try {
      const sessionAccount = privateKeyToAccount(sessionKey)
      const signature = await sessionAccount.signTypedData({
        domain: SESSION_DOMAIN,
        types: {
          RevokeSession: [
            { name: 'owner', type: 'address' },
            { name: 'sessionKey', type: 'address' },
          ],
        },
        primaryType: 'RevokeSession',
        message: {
          owner: ownerAddress,
          sessionKey: sessionAddress,
        },
      })

      // Send to API — validator submits on-chain
      await apiFetch('/api/sessions', {
        method: 'DELETE',
        body: JSON.stringify({
          owner: ownerAddress,
          sessionKey: sessionAddress,
          signature,
        }),
      })
      console.log('[QuickSign] Session revoked on-chain via API')
    } catch (err: any) {
      // On-chain revocation failed — still clear locally
      // Session will expire naturally on-chain
      console.warn('[QuickSign] On-chain revocation failed, clearing locally:', err?.message)
    }

    // Always clear the local session (destroys the private key from this browser)
    clearSession()
  }, [session, activeToken, clearSession])
}

/**
 * Keeps the session store's active wallet in sync with the connected wallet.
 * Sessions are stored per-wallet, so switching wallets just changes which session is active —
 * switching back restores the original session without re-registration.
 */
export function useSessionKeyWalletGuard() {
  const { address } = useAccount()
  const setActiveWallet = useSessionKeyStore(s => s.setActiveWallet)

  useEffect(() => {
    setActiveWallet(address || null)
  }, [address, setActiveWallet])
}
