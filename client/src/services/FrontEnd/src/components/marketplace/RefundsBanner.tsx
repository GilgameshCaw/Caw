import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { formatEther, formatUnits } from 'viem'
import { apiFetch } from '~/api/client'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeBorder, themeBgSubtle } from '~/utils/theme'

// Bid record shape returned by /api/marketplace/refunds/:address.
// Only the fields we read here are typed.
interface RefundCandidate {
  id: number
  listingId: number  // DB id (we need the on-chain listingId from the listing relation)
  amount: string
  listing: {
    listingId: number
    paymentToken: string
    username: string
    tokenId: number
  }
}

function parseRaw(amountWei: bigint, paymentToken: string): number {
  if (paymentToken === 'USDC' || paymentToken === 'USDT') {
    return parseFloat(formatUnits(amountWei, 6))
  }
  return parseFloat(formatEther(amountWei))
}

function formatRaw(amountWei: bigint, paymentToken: string): string {
  const n = parseRaw(amountWei, paymentToken)
  if (paymentToken === 'CAW') return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (paymentToken === 'USDC' || paymentToken === 'USDT') return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

export const RefundsBanner: React.FC = () => {
  const { isDark } = useTheme()
  const { address } = useAccount()
  const [candidates, setCandidates] = useState<RefundCandidate[]>([])
  const [expanded, setExpanded] = useState(false)
  const [activeClaim, setActiveClaim] = useState<number | null>(null) // listingId being claimed

  const { writeContract, data: claimHash, isPending: isClaimPending, reset: resetClaim } = useWriteContract()
  const { isSuccess: claimConfirmed } = useWaitForTransactionReceipt({ hash: claimHash })

  // Fetch candidate listings from the API. Source-of-truth for amounts is the
  // chain (pendingReturns), but the API tells us *which* listings to check —
  // there's no efficient on-chain way to enumerate them per user.
  const refresh = useCallback(() => {
    if (!address) { setCandidates([]); return }
    apiFetch<{ bids: RefundCandidate[] }>(`/api/marketplace/refunds/${address}`)
      .then(res => setCandidates(res.bids))
      .catch(() => setCandidates([]))
  }, [address])

  useEffect(() => { refresh() }, [refresh])

  // Re-check when a claim confirms — the bid on chain just zeroed, refresh
  // both API view (will lag) and the on-chain reads (immediate).
  useEffect(() => {
    if (claimConfirmed) {
      refresh()
      resetClaim()
      setActiveClaim(null)
    }
  }, [claimConfirmed, refresh, resetClaim])

  // Read pendingReturns for each candidate. Hook order is stable across
  // renders because we always pass the same shape — only contents change.
  const contractReads = useMemo(() => {
    if (!address) return []
    return candidates.map(c => ({
      address: CAW_NAME_MARKETPLACE_ADDRESS as `0x${string}`,
      abi: cawProfileMarketplaceAbi,
      functionName: 'pendingReturns' as const,
      args: [address, BigInt(c.listing.listingId)] as const,
    }))
  }, [address, candidates])

  const { data: readData } = useReadContracts({
    contracts: contractReads,
    query: { enabled: contractReads.length > 0 },
  })

  // Combine candidates with their on-chain pending balance, drop zeros.
  const claimable = useMemo(() => {
    if (!readData) return []
    return candidates
      .map((c, i) => {
        const result = readData[i]
        const amountWei = result?.status === 'success' ? (result.result as bigint) : 0n
        return { ...c, amountWei }
      })
      .filter(c => c.amountWei > 0n)
  }, [candidates, readData])

  // Sum per payment-token label.
  const totals = useMemo(() => {
    const m = new Map<string, bigint>()
    for (const c of claimable) {
      m.set(c.listing.paymentToken, (m.get(c.listing.paymentToken) ?? 0n) + c.amountWei)
    }
    return [...m.entries()]
  }, [claimable])

  const handleClaim = (onChainListingId: number) => {
    setActiveClaim(onChainListingId)
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: 'withdrawBid',
      args: [BigInt(onChainListingId)],
    })
  }

  if (!address || claimable.length === 0) return null

  return (
    <div className={`mb-4 rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className={`w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer hover:bg-yellow-500/5 transition`}
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-yellow-500/20 text-yellow-500 text-lg">↩</span>
          <div>
            <div className={`font-semibold ${themeText(isDark)}`}>
              You have {claimable.length} refund{claimable.length > 1 ? 's' : ''} to claim
            </div>
            <div className={`text-xs ${themeTextMuted(isDark)}`}>
              {totals.map(([label, sum]) => `${formatRaw(sum, label)} ${label}`).join(' + ')}
            </div>
          </div>
        </div>
        <span className={`text-sm ${themeTextMuted(isDark)}`}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className={`border-t ${themeBorder(isDark)} divide-y ${themeBorder(isDark)}`}>
          {claimable.map(c => {
            const isThisClaimPending = isClaimPending && activeClaim === c.listing.listingId
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className={`font-medium truncate ${themeText(isDark)}`}>@{c.listing.username}</div>
                  <div className={`text-xs ${themeTextMuted(isDark)}`}>
                    {formatRaw(c.amountWei, c.listing.paymentToken)} {c.listing.paymentToken}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleClaim(c.listing.listingId)}
                  disabled={isClaimPending}
                  className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  {isThisClaimPending ? 'Claiming…' : 'Claim'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default RefundsBanner
