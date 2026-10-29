import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { apiFetch } from '~/api/client'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeBorder, themeBgSubtle } from '~/utils/theme'

// Listing row returned by /api/marketplace/listings/seller/:address.
// Only the fields we read here are typed.
interface ExpiredListing {
  id: number
  listingId: number
  tokenId: number
  username: string
  endTime: string | null
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Auctions of the connected wallet that ended without a bid but are still
 * listed on chain.
 *
 * An English auction with no bids is marked EXPIRED by the indexer once its
 * end time passes, but on chain it stays active, and its token stays locked
 * ("Token already listed" on createListing), until the seller calls
 * cancelListing. The seller's lists only show ACTIVE listings, so without
 * this there is no button to cancel it and the username can't be listed
 * again. The API says which listings to look at; the chain says which are
 * still active.
 */
export const ExpiredListingsBanner: React.FC = () => {
  const { isDark } = useTheme()
  const { address } = useAccount()
  // The API's answer, with the wallet it was asked for: a failed or late
  // answer must never put one wallet's listings on another wallet's screen.
  const [loaded, setLoaded] = useState<{ address: string; listings: ExpiredListing[] } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [activeCancel, setActiveCancel] = useState<number | null>(null) // on-chain listingId
  const [cancelled, setCancelled] = useState<Set<number>>(new Set()) // cancelled in this session
  const [revertedNote, setRevertedNote] = useState<string | null>(null)

  const { writeContract, data: cancelHash, isPending: isCancelPending, error: cancelError, reset: resetCancel } = useWriteContract()
  // isSuccess only means a receipt came back; a reverted transaction has one too.
  const { data: cancelReceipt, isSuccess: cancelMined, isLoading: isCancelConfirming } = useWaitForTransactionReceipt({ hash: cancelHash })
  const cancelConfirmed = cancelMined && cancelReceipt?.status === 'success'
  const cancelReverted = cancelMined && cancelReceipt?.status === 'reverted'
  // One cancel at a time: a second one started while the first is awaiting its
  // receipt would replace the hash being watched, and the first would never
  // be seen to confirm.
  const cancelInFlight = isCancelPending || isCancelConfirming

  const candidates = useMemo(
    () => (loaded && loaded.address === address ? loaded.listings : []),
    [loaded, address],
  )

  // 100 is the most the endpoint returns in one page.
  const refresh = useCallback(() => {
    if (!address) return
    apiFetch<{ listings: ExpiredListing[] }>(`/api/marketplace/listings/seller/${address}?status=EXPIRED&limit=100`)
      .then(res => setLoaded({ address, listings: res.listings }))
      .catch(() => { /* keep what we have; a failed refresh must not hide listings that are still there */ })
  }, [address])

  useEffect(() => { refresh() }, [refresh])

  // The listing was just cancelled on chain. Drop it from the list at once:
  // the chain read below has the same arguments as before, so it is not
  // repeated by itself, and an RPC that is a block behind would still say
  // "active". Then look at the API again for the rest.
  useEffect(() => {
    if (cancelConfirmed) {
      if (activeCancel !== null) setCancelled(prev => new Set(prev).add(activeCancel))
      refresh()
      resetCancel()
      setActiveCancel(null)
    }
  }, [cancelConfirmed, activeCancel, refresh, resetCancel])

  // Mined but reverted: the listing stays in the list, and the seller is told.
  useEffect(() => {
    if (cancelReverted) {
      setRevertedNote('The transaction was mined but reverted, so the listing is still there.')
      resetCancel()
      setActiveCancel(null)
    }
  }, [cancelReverted, resetCancel])

  const contractReads = useMemo(() => candidates.map(c => ({
    address: CAW_NAME_MARKETPLACE_ADDRESS as `0x${string}`,
    abi: cawProfileMarketplaceAbi,
    functionName: 'listings' as const,
    args: [BigInt(c.listingId)] as const,
    chainId: chains.l1.chainId,
  })), [candidates])

  // Read afresh each time the banner mounts. The app's query defaults (stale
  // for 5 minutes, no refetch on mount) would serve the cached "active" for a
  // listing cancelled a moment ago, and it would reappear with a Cancel button
  // after leaving the page and coming back.
  const { data: readData } = useReadContracts({
    contracts: contractReads,
    query: { enabled: contractReads.length > 0, staleTime: 0, gcTime: 0 },
  })

  // Keep the listings that are still active on chain, belong to this wallet
  // (cancelListing is seller-only) and have no bidder. A bid the indexer had
  // not seen yet when it marked the listing EXPIRED is a different case: the
  // auction has to be settled, not just cancelled.
  const cancellable = useMemo(() => {
    if (!readData || !address) return []
    return candidates.filter((c, i) => {
      const result = readData[i]
      if (result?.status !== 'success') return false
      const [, seller, , , , , , , , highestBidder, active] =
        result.result as readonly [number, string, string, number, bigint, bigint, bigint, bigint, bigint, string, boolean]
      return active
        && seller.toLowerCase() === address.toLowerCase()
        && highestBidder.toLowerCase() === ZERO_ADDRESS
        && !cancelled.has(c.listingId)
    })
  }, [candidates, readData, address, cancelled])

  const handleCancel = (onChainListingId: number) => {
    if (cancelError) resetCancel()
    setRevertedNote(null)
    setActiveCancel(onChainListingId)
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: 'cancelListing',
      args: [BigInt(onChainListingId)],
      chainId: chains.l1.chainId,
    })
  }

  if (!address || cancellable.length === 0) return null

  return (
    <div className={`mb-4 rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer hover:bg-yellow-500/5 transition"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-yellow-500/20 text-yellow-500 text-lg">⏱</span>
          <div>
            <div className={`font-semibold ${themeText(isDark)}`}>
              {cancellable.length} ended auction{cancellable.length > 1 ? 's' : ''} with no bids still lock{cancellable.length > 1 ? '' : 's'} your username{cancellable.length > 1 ? 's' : ''}
            </div>
            <div className={`text-xs ${themeTextMuted(isDark)}`}>
              Cancel the listing to list the username again.
            </div>
          </div>
        </div>
        <span className={`text-sm ${themeTextMuted(isDark)}`}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className={`border-t ${themeBorder(isDark)} divide-y ${themeBorder(isDark)}`}>
          {cancellable.map(c => {
            const isThisPending = cancelInFlight && activeCancel === c.listingId
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className={`font-medium truncate ${themeText(isDark)}`}>@{c.username}</div>
                  <div className={`text-xs ${themeTextMuted(isDark)}`}>
                    {c.endTime ? `ended ${new Date(c.endTime).toLocaleDateString()}` : 'ended'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleCancel(c.listingId)}
                  disabled={cancelInFlight}
                  className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  {isThisPending ? 'Cancelling…' : 'Cancel listing'}
                </button>
              </div>
            )
          })}
          {(cancelError || revertedNote) && (
            <div className="px-4 py-2 text-xs text-red-500">
              {cancelError
                ? ((cancelError as { shortMessage?: string }).shortMessage || cancelError.message)
                : revertedNote}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ExpiredListingsBanner
