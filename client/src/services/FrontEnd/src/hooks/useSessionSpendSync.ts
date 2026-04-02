import { useEffect } from 'react'
import { useReadContract } from 'wagmi'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'

/**
 * Syncs the on-chain sessionSpent value into the local session store.
 * Uses the active token's owner address (not the connected wallet) to find the
 * correct session key, so spend tracking works even when a different wallet is connected.
 */
export function useSessionSpendSync() {
  const activeToken = useActiveToken()
  const enabled = useSessionKeyStore(s => s.enabled)
  const sessions = useSessionKeyStore(s => s.sessions)

  // Use the token owner's address to find the right session
  const ownerAddress = activeToken?.owner?.toLowerCase()
  const session = ownerAddress ? sessions[ownerAddress] || null : null
  const isActive = !!(enabled && session && session.expiry > Date.now() / 1000)
  const queryEnabled = isActive && !!ownerAddress && !!session?.address

  console.log(`[QuickSign SpendSync] query enabled=${queryEnabled}, owner=${ownerAddress}, sessionKey=${session?.address}, contract=${CAW_ACTIONS_ADDRESS}`)

  const { data: onChainSpent, error: spendError } = useReadContract({
    address: CAW_ACTIONS_ADDRESS,
    abi: cawActionsAbi,
    chainId: chains.l2.chainId,
    functionName: 'sessionSpent',
    args: [ownerAddress as `0x${string}`, session?.address!],
    query: { enabled: queryEnabled }
  })

  useEffect(() => {
    if (spendError) {
      console.error(`[QuickSign SpendSync] Error reading sessionSpent:`, spendError)
    }
    if (onChainSpent == null) {
      console.log(`[QuickSign SpendSync] onChainSpent is null/undefined`)
      return
    }
    if (!session || !ownerAddress) return

    const onChainSpentBigInt = BigInt(onChainSpent.toString())
    const localSpentBigInt = BigInt(session.spent || '0')
    // Use the higher of on-chain vs local — local tracks optimistically ahead of on-chain
    const effectiveSpent = onChainSpentBigInt > localSpentBigInt ? onChainSpentBigInt : localSpentBigInt
    const spent = effectiveSpent.toString()
    console.log(`[QuickSign SpendSync] On-chain: ${onChainSpent.toString()}, local: ${localSpentBigInt.toString()}, effective: ${spent} (limit: ${session.spendLimit})`)

    const store = useSessionKeyStore.getState()
    const currentSession = store.getSessionForAddress(ownerAddress)
    if (currentSession && currentSession.spent !== spent) {
      store.setSession({ ...currentSession, spent })
    }
  }, [onChainSpent, spendError, session?.address])
}
