import { useState } from 'react'
import { baseSepolia } from 'wagmi/chains'
import { useAuthStore } from '~/store/authStore'
import { apiFetch, retryOnIndexing } from '~/api/client'
import { useRootSigner } from '~/hooks/useRootSigner'

// Sign with the L2 chainId the API expects (84532 Base Sepolia), NOT
// the wallet's current chainId. personal_sign is chain-agnostic — the
// chainId is just text in the message body — so the user does not need
// to switch networks before signing. The API enforces this exact value
// (see EXPECTED_CHAIN_ID in client/src/api/routes/auth.ts).
const SIGNING_CHAIN_ID = baseSepolia.id

export function useVerifyWallet() {
  const { sessionToken, setSession, addAuthorization } = useAuthStore()
  const rootSigner = useRootSigner()
  const [isVerifying, setIsVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const verify = async (): Promise<boolean> => {
    setIsVerifying(true)
    setError(null)

    try {
      // Real wallet → opens connect modal if needed. Passkey → resolves if a
      // credential/recovery key is present, else throws a clear "use your
      // backup file" message (caught below) instead of a wallet modal.
      await rootSigner.ensureReady()
    } catch (err: any) {
      setError(err?.message || 'Wallet not available')
      setIsVerifying(false)
      return false
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000)
      // Domain-bind the message to (host + chainId) so a sig produced
      // for mirror A is not replayable on mirror B, and a sig produced
      // on testnet is not replayable on mainnet. Audit fix 2026-05-09
      // (Round 7 FE/DM CRITICAL-2). The API enforces matching `Host`.
      //
      // ChainId is the LITERAL string that binds the sig to this API's
      // expected L2. personal_sign is chain-agnostic — we use the hard-
      // coded SIGNING_CHAIN_ID instead of useChainId() so the user does
      // NOT need to switch their wallet network before signing.
      const host = window.location.host.toLowerCase()
      const message =
        `Verify wallet ownership for CAW\n` +
        `Host: ${host}\n` +
        `ChainId: ${SIGNING_CHAIN_ID}\n` +
        `Timestamp: ${timestamp}`

      const signature = await rootSigner.signMessage(message)

      // Tier 3 of the "RPC out of API request handlers" refactor: the API
      // returns 202 when the wallet's tokens haven't been indexed yet
      // (fresh transfer, indexer still catching up). retryOnIndexing
      // backs off and retries; on the final empty pass it surfaces the
      // last IndexingError as a normal failure.
      const data = await retryOnIndexing(() =>
        apiFetch<{
          sessionToken: string
          authorizedTokenIds: number[]
          authorizedAddresses: string[]
          expiresAt: number
        }>('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, signature }),
        })
      )

      if (sessionToken && data.sessionToken === sessionToken) {
        addAuthorization(data.authorizedTokenIds, data.authorizedAddresses)
      } else {
        setSession(
          data.sessionToken,
          data.authorizedTokenIds,
          data.authorizedAddresses,
          data.expiresAt
        )
      }
      return true
    } catch (err: any) {
      if (err?.name === 'UserRejectedRequestError' || err?.code === 4001) {
        setError('Signature rejected')
      } else {
        setError(err.message || 'Verification failed')
      }
      return false
    } finally {
      setIsVerifying(false)
    }
  }

  return { verify, isVerifying, error }
}
