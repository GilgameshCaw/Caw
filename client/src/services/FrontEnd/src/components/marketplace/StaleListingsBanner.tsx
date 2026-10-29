import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { formatEther, formatUnits } from 'viem'
import { apiFetch } from '~/api/client'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAMES_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi, cawProfileAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeBorder, themeBgSubtle } from '~/utils/theme'

// Listing row returned by /api/marketplace/listings/stale/:address.
// Only the fields we read here are typed.
interface StaleCandidate {
  id: number
  listingId: number
  tokenId: number
  username: string
  paymentToken: string
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function formatAmount(amountWei: bigint, paymentToken: string): string {
  const n = parseFloat(paymentToken === 'USDC' || paymentToken === 'USDT'
    ? formatUnits(amountWei, 6)
    : formatEther(amountWei))
  if (paymentToken === 'CAW') return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (paymentToken === 'USDC' || paymentToken === 'USDT') return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/**
 * Listings left open on chain after the username moved away from the seller.
 *
 * The marketplace holds an approval, not the NFT, so a seller can transfer a
 * listed username away. The listing then stays active on chain: the new owner
 * cannot list the username ("Token already listed"), and if it is an English
 * auction with a bid the bidder's funds stay in it. reclaimListing (no bid)
 * and reclaimBid (a bid; it hands the bid back for withdrawal) can be called
 * by anyone, but nothing in the app called them, and the indexer marks such a
 * listing CANCELLED so no list shows it.
 *
 * Shown to the two people it affects: the username's current owner and the
 * highest bidder. The API says which listings to look at; the chain says
 * which are still active with a seller who no longer owns the token.
 */
export const StaleListingsBanner: React.FC = () => {
  const { isDark } = useTheme()
  const { address } = useAccount()
  // The API's answer, with the wallet it was asked for: a failed or late
  // answer must never put one wallet's listings on another wallet's screen.
  const [loaded, setLoaded] = useState<{ address: string; listings: StaleCandidate[] } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [activeClear, setActiveClear] = useState<number | null>(null) // on-chain listingId
  const [cleared, setCleared] = useState<Set<number>>(new Set()) // cleared in this session
  const [revertedNote, setRevertedNote] = useState<string | null>(null)

  const { writeContract, data: clearHash, isPending: isClearPending, error: clearError, reset: resetClear } = useWriteContract()
  // isSuccess only means a receipt came back; a reverted transaction has one too.
  const { data: clearReceipt, isSuccess: clearMined, isLoading: isClearConfirming } = useWaitForTransactionReceipt({ hash: clearHash })
  const clearConfirmed = clearMined && clearReceipt?.status === 'success'
  const clearReverted = clearMined && clearReceipt?.status === 'reverted'
  // One call at a time: a second one started while the first is awaiting its
  // receipt would replace the hash being watched, and the first would never
  // be seen to confirm.
  const clearInFlight = isClearPending || isClearConfirming

  const candidates = useMemo(
    () => (loaded && loaded.address === address ? loaded.listings : []),
    [loaded, address],
  )

  // 100 is the most the endpoint returns.
  const refresh = useCallback(() => {
    if (!address) return
    apiFetch<{ listings: StaleCandidate[] }>(`/api/marketplace/listings/stale/${address}?limit=100`)
      .then(res => setLoaded({ address, listings: res.listings }))
      .catch(() => { /* keep what we have; a failed refresh must not hide listings that are still there */ })
  }, [address])

  useEffect(() => { refresh() }, [refresh])

  // The listing was just cleared on chain. Drop it from the list at once: the
  // chain reads below have the same arguments as before, so they are not
  // repeated by themselves, and an RPC that is a block behind would still say
  // "active". Then look at the API again for the rest.
  useEffect(() => {
    if (clearConfirmed) {
      if (activeClear !== null) setCleared(prev => new Set(prev).add(activeClear))
      refresh()
      resetClear()
      setActiveClear(null)
    }
  }, [clearConfirmed, activeClear, refresh, resetClear])

  // Mined but reverted (for example someone else cleared it first): the
  // listing stays in the list, and the user is told.
  useEffect(() => {
    if (clearReverted) {
      setRevertedNote('The transaction was mined but reverted, so the listing is still there.')
      resetClear()
      setActiveClear(null)
    }
  }, [clearReverted, resetClear])

  // Two reads per candidate: the listing, and who owns its token now.
  const contractReads = useMemo(() => candidates.flatMap(c => [
    {
      address: CAW_NAME_MARKETPLACE_ADDRESS as `0x${string}`,
      abi: cawProfileMarketplaceAbi,
      functionName: 'listings' as const,
      args: [BigInt(c.listingId)] as const,
      chainId: chains.l1.chainId,
    },
    {
      address: CAW_NAMES_ADDRESS as `0x${string}`,
      abi: cawProfileAbi,
      functionName: 'ownerOf' as const,
      args: [BigInt(c.tokenId)] as const,
      chainId: chains.l1.chainId,
    },
  ]), [candidates])

  // Read afresh each time the banner mounts. The app's query defaults (stale
  // for 5 minutes, no refetch on mount) would serve the cached "active" for a
  // listing cleared a moment ago, and it would reappear with its button after
  // leaving the page and coming back.
  const { data: readData } = useReadContracts({
    contracts: contractReads,
    query: { enabled: contractReads.length > 0, staleTime: 0, gcTime: 0 },
  })

  // Keep the listings that are still active on chain, whose seller no longer
  // owns the token, and that concern this wallet as the token's owner or as
  // the highest bidder. With a bid the call is reclaimBid, otherwise
  // reclaimListing.
  const stale = useMemo(() => {
    if (!readData || !address) return []
    const me = address.toLowerCase()
    return candidates.flatMap((c, i) => {
      const listingRes = readData[2 * i]
      const ownerRes = readData[2 * i + 1]
      if (listingRes?.status !== 'success' || ownerRes?.status !== 'success') return []
      const [, seller, , , , , , , highestBid, highestBidder, active] =
        listingRes.result as readonly [number, string, string, number, bigint, bigint, bigint, bigint, bigint, string, boolean]
      const owner = (ownerRes.result as string).toLowerCase()
      if (!active || owner === seller.toLowerCase() || cleared.has(c.listingId)) return []
      const isOwner = owner === me
      const isBidder = highestBidder.toLowerCase() === me
      if (!isOwner && !isBidder) return []
      const hasBid = highestBidder.toLowerCase() !== ZERO_ADDRESS
      return [{ ...c, isOwner, isBidder, hasBid, highestBid, fn: hasBid ? 'reclaimBid' as const : 'reclaimListing' as const }]
    })
  }, [candidates, readData, address, cleared])

  const handleClear = (onChainListingId: number, fn: 'reclaimBid' | 'reclaimListing') => {
    if (clearError) resetClear()
    setRevertedNote(null)
    setActiveClear(onChainListingId)
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: fn,
      args: [BigInt(onChainListingId)],
      chainId: chains.l1.chainId,
    })
  }

  if (!address || stale.length === 0) return null

  return (
    <div className={`mb-4 rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer hover:bg-yellow-500/5 transition"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-yellow-500/20 text-yellow-500 text-lg">⚠</span>
          <div>
            <div className={`font-semibold ${themeText(isDark)}`}>
              {stale.length} listing{stale.length > 1 ? 's' : ''} left open after a username moved
            </div>
            <div className={`text-xs ${themeTextMuted(isDark)}`}>
              Clearing one frees the username and makes any bid withdrawable by its bidder.
            </div>
          </div>
        </div>
        <span className={`text-sm ${themeTextMuted(isDark)}`}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className={`border-t ${themeBorder(isDark)} divide-y ${themeBorder(isDark)}`}>
          {stale.map(c => {
            const isThisPending = clearInFlight && activeClear === c.listingId
            const bid = `${formatAmount(c.highestBid, c.paymentToken)} ${c.paymentToken}`
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className={`font-medium truncate ${themeText(isDark)}`}>@{c.username}</div>
                  <div className={`text-xs ${themeTextMuted(isDark)}`}>
                    {c.isBidder
                      ? `Your bid of ${bid} is held by a listing whose seller no longer owns the username.`
                      : c.hasBid
                        ? `A listing by a previous owner still blocks listing it, and holds a bid of ${bid}.`
                        : 'A listing by a previous owner still blocks listing it.'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleClear(c.listingId, c.fn)}
                  disabled={clearInFlight}
                  className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer flex-shrink-0"
                >
                  {isThisPending ? 'Clearing…' : c.isBidder ? 'Release my bid' : 'Clear listing'}
                </button>
              </div>
            )
          })}
          {(clearError || revertedNote) && (
            <div className="px-4 py-2 text-xs text-red-500">
              {clearError
                ? ((clearError as { shortMessage?: string }).shortMessage || clearError.message)
                : revertedNote}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default StaleListingsBanner
