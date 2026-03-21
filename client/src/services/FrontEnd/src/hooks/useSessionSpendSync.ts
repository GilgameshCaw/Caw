import { useEffect } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'

/**
 * Syncs the on-chain sessionSpent value into the local session store.
 * Runs whenever the wallet or session changes.
 */
export function useSessionSpendSync() {
  const { address: walletAddress } = useAccount()
  const activeToken = useActiveToken()
  const session = useSessionKeyStore(s => s.session)
  const enabled = useSessionKeyStore(s => s.enabled)

  // Owner address: prefer connected wallet, fall back to token owner address
  const ownerAddress = walletAddress || activeToken?.address
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
    if (!session) return

    const spent = onChainSpent.toString()
    console.log(`[QuickSign SpendSync] On-chain spent: ${spent} (limit: ${session.spendLimit})`)

    const store = useSessionKeyStore.getState()
    if (store.session && store.session.spent !== spent) {
      store.setSession({ ...store.session, spent })
    }
  }, [onChainSpent, spendError, session?.address])
}
