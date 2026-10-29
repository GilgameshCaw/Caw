import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { formatEther, formatUnits } from 'viem'
import { apiFetch } from '~/api/client'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeBorder, themeBgSubtle } from '~/utils/theme'

// Offer row returned by /api/marketplace/offers/reclaimable/:address.
// Only the fields we read here are typed.
interface ExpiredOffer {
  id: number
  offerId: number
  tokenId: number
  paymentToken: string
  username: string
  expiry: string
}

function formatAmount(amountWei: bigint, paymentToken: string): string {
  const n = parseFloat(paymentToken === 'USDC' || paymentToken === 'USDT'
    ? formatUnits(amountWei, 6)
    : formatEther(amountWei))
  if (paymentToken === 'CAW') return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (paymentToken === 'USDC' || paymentToken === 'USDT') return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/**
 * Offers the connected wallet made that have expired but still hold its funds.
 *
 * An expired offer stays active on chain, with its funds escrowed, until
 * cancelOffer is called; the other offer lists only show ACTIVE offers, so
 * once an offer expires it would otherwise disappear while the money is still
 * in the contract. The API says which offers to look at (it can't know which
 * were already refunded); the chain says which are still active.
 */
export const ExpiredOffersBanner: React.FC = () => {
  const { isDark } = useTheme()
  const { address } = useAccount()
  // The API's answer, with the wallet it was asked for: a failed or late
  // answer must never put one wallet's offers on another wallet's screen.
  const [loaded, setLoaded] = useState<{ address: string; offers: ExpiredOffer[] } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [activeReclaim, setActiveReclaim] = useState<number | null>(null) // on-chain offerId
  const [reclaimed, setReclaimed] = useState<Set<number>>(new Set()) // cancelled in this session
  const [revertedNote, setRevertedNote] = useState<string | null>(null)

  const { writeContract, data: reclaimHash, isPending: isReclaimPending, error: reclaimError, reset: resetReclaim } = useWriteContract()
  // isSuccess only means a receipt came back; a reverted transaction has one too.
  const { data: reclaimReceipt, isSuccess: reclaimMined, isLoading: isReclaimConfirming } = useWaitForTransactionReceipt({ hash: reclaimHash })
  // One cancel at a time: a second one started while the first is awaiting its
  // receipt would replace the hash being watched, and the first would never
  // be seen to confirm.
  const reclaimInFlight = isReclaimPending || isReclaimConfirming
  const reclaimConfirmed = reclaimMined && reclaimReceipt?.status === 'success'
  const reclaimReverted = reclaimMined && reclaimReceipt?.status === 'reverted'

  const candidates = useMemo(
    () => (loaded && loaded.address === address ? loaded.offers : []),
    [loaded, address],
  )

  // 200 is the most the endpoint returns in one page.
  const refresh = useCallback(() => {
    if (!address) return
    apiFetch<{ offers: ExpiredOffer[] }>(`/api/marketplace/offers/reclaimable/${address}?limit=200`)
      .then(res => setLoaded({ address, offers: res.offers }))
      .catch(() => { /* keep what we have; a failed refresh must not hide offers that are still there */ })
  }, [address])

  useEffect(() => { refresh() }, [refresh])

  // The offer was just cancelled on chain. Drop it from the list at once: the
  // chain read below has the same arguments as before, so it is not repeated
  // by itself, and an RPC that is a block behind would still say "active".
  // Then look at the API again for the rest.
  useEffect(() => {
    if (reclaimConfirmed) {
      if (activeReclaim !== null) setReclaimed(prev => new Set(prev).add(activeReclaim))
      refresh()
      resetReclaim()
      setActiveReclaim(null)
    }
  }, [reclaimConfirmed, activeReclaim, refresh, resetReclaim])

  // Mined but reverted (for example someone else cancelled it first): the
  // offer stays in the list, and the offerer is told.
  useEffect(() => {
    if (reclaimReverted) {
      setRevertedNote('The transaction was mined but reverted, so nothing was refunded.')
      resetReclaim()
      setActiveReclaim(null)
    }
  }, [reclaimReverted, resetReclaim])

  const contractReads = useMemo(() => candidates.map(c => ({
    address: CAW_NAME_MARKETPLACE_ADDRESS as `0x${string}`,
    abi: cawProfileMarketplaceAbi,
    functionName: 'offers' as const,
    args: [BigInt(c.offerId)] as const,
    chainId: chains.l1.chainId,
  })), [candidates])

  // Read afresh each time the banner mounts. The app's query defaults (stale
  // for 5 minutes, no refetch on mount) would serve the cached "active" for an
  // offer cancelled a moment ago, and it would reappear with a Reclaim button
  // after leaving the page and coming back.
  const { data: readData } = useReadContracts({
    contracts: contractReads,
    query: { enabled: contractReads.length > 0, staleTime: 0, gcTime: 0 },
  })

  // Keep the offers that are still active on chain, with the escrowed amount.
  const reclaimable = useMemo(() => {
    if (!readData) return []
    return candidates.flatMap((c, i) => {
      const result = readData[i]
      if (result?.status !== 'success') return []
      const [, , , amountWei, , active] = result.result as readonly [string, number, string, bigint, bigint, boolean]
      return active && !reclaimed.has(c.offerId) ? [{ ...c, amountWei }] : []
    })
  }, [candidates, readData, reclaimed])

  const totals = useMemo(() => {
    const m = new Map<string, bigint>()
    for (const c of reclaimable) m.set(c.paymentToken, (m.get(c.paymentToken) ?? 0n) + c.amountWei)
    return [...m.entries()]
  }, [reclaimable])

  const handleReclaim = (onChainOfferId: number) => {
    if (reclaimError) resetReclaim()
    setRevertedNote(null)
    setActiveReclaim(onChainOfferId)
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: 'cancelOffer',
      args: [BigInt(onChainOfferId)],
      chainId: chains.l1.chainId,
    })
  }

  if (!address || reclaimable.length === 0) return null

  return (
    <div className={`mb-4 rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer hover:bg-yellow-500/5 transition"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-yellow-500/20 text-yellow-500 text-lg">↩</span>
          <div>
            <div className={`font-semibold ${themeText(isDark)}`}>
              {reclaimable.length} expired offer{reclaimable.length > 1 ? 's' : ''} still hold{reclaimable.length > 1 ? '' : 's'} your funds
            </div>
            <div className={`text-xs ${themeTextMuted(isDark)}`}>
              {totals.map(([label, sum]) => `${formatAmount(sum, label)} ${label}`).join(' + ')}
            </div>
          </div>
        </div>
        <span className={`text-sm ${themeTextMuted(isDark)}`}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className={`border-t ${themeBorder(isDark)} divide-y ${themeBorder(isDark)}`}>
          {reclaimable.map(c => {
            const isThisPending = reclaimInFlight && activeReclaim === c.offerId
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className={`font-medium truncate ${themeText(isDark)}`}>@{c.username}</div>
                  <div className={`text-xs ${themeTextMuted(isDark)}`}>
                    {formatAmount(c.amountWei, c.paymentToken)} {c.paymentToken} · expired {new Date(c.expiry).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleReclaim(c.offerId)}
                  disabled={reclaimInFlight}
                  className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  {isThisPending ? 'Reclaiming…' : 'Reclaim'}
                </button>
              </div>
            )
          })}
          {(reclaimError || revertedNote) && (
            <div className="px-4 py-2 text-xs text-red-500">
              {reclaimError
                ? ((reclaimError as { shortMessage?: string }).shortMessage || reclaimError.message)
                : revertedNote}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ExpiredOffersBanner
