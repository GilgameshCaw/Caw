import React, { useEffect, useMemo, useState } from 'react'
import { useWriteContract, useWaitForTransactionReceipt, useChainId, useSwitchChain, useAccount } from 'wagmi'
import { readContract } from '@wagmi/core'
import { useTheme } from '~/hooks/useTheme'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { themeTextSecondary, themeTextMuted, themeBorder } from '~/utils/theme'
import { MarketplaceListing, MarketplaceBid, useMarketplaceStore } from '~/store/marketplaceStore'
import { formatEther, formatUnits } from 'viem'
import { usePriceStore } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawNameMarketplaceAbi, cawNameQuoterAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import { wagmiConfig } from '~/config/Web3Provider'
import ProfileCard from './ProfileCard'
import LiveCountdown from './LiveCountdown'
import ModalWrapper from '~/components/modals/ModalWrapper'

const TYPE_BADGES: Record<string, { label: string; color: string; tip: string }> = {
  FIXED: { label: 'Fixed', color: 'bg-blue-500/20 text-blue-400', tip: 'Buy now at the listed price' },
  DUTCH_AUCTION: { label: '↓ Dutch', color: 'bg-purple-500/20 text-purple-400', tip: 'Price decreases over time, first bidder wins' },
  ENGLISH_AUCTION: { label: '↑ Auction', color: 'bg-green-500/20 text-green-400', tip: 'Bidders compete, highest bid wins at deadline' },
}

function parsePrice(price: string, token: string): number {
  if (token === 'USDC' || token === 'USDT') {
    return parseFloat(formatUnits(BigInt(price), 6))
  }
  return parseFloat(formatEther(BigInt(price)))
}

function formatPrice(price: string, token: string): string {
  const num = parsePrice(price, token)
  if (token === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (token === 'USDC' || token === 'USDT') return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function getDutchCurrentPrice(listing: MarketplaceListing): string | null {
  if (listing.listingType !== 'DUTCH_AUCTION' || !listing.endTime || !listing.endPrice) return null

  const now = Date.now()
  const start = new Date(listing.startTime).getTime()
  const end = new Date(listing.endTime).getTime()
  const elapsed = now - start
  const duration = end - start

  if (elapsed >= duration) return listing.endPrice

  const startP = BigInt(listing.startPrice)
  const endP = BigInt(listing.endPrice)
  const current = startP - ((startP - endP) * BigInt(Math.floor(elapsed)) / BigInt(Math.floor(duration)))
  return current.toString()
}


function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const ListingCard: React.FC<{ listing: MarketplaceListing; showCancel?: boolean }> = ({ listing, showCancel }) => {
  const { isDark } = useTheme()
  const { openBuyModal, openBidModal, triggerRefresh } = useMarketplaceStore()
  const [showBids, setShowBids] = useState(false)
  const [allBids, setAllBids] = useState<MarketplaceBid[] | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const { writeContract: writeCancel, data: cancelHash, isPending: isCancelling, error: cancelError, reset: resetCancel } = useWriteContract()
  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess } = useWaitForTransactionReceipt({ hash: cancelHash })
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()

  useEffect(() => {
    if (isCancelSuccess) {
      setShowCancelConfirm(false)
      triggerRefresh()
    }
  }, [isCancelSuccess])

  const handleCancel = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeCancel({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawNameMarketplaceAbi,
        functionName: 'cancelListing',
        args: [BigInt(listing.listingId)],
        chainId: chains.l1.chainId,
      })
    })
  }

  // Settle auction
  const { writeContract: writeSettle, data: settleHash, isPending: isSettling, error: settleError, reset: resetSettle } = useWriteContract()
  const { isLoading: isSettleConfirming, isSuccess: isSettleSuccess } = useWaitForTransactionReceipt({ hash: settleHash })
  const [settleLzFee, setSettleLzFee] = useState(0n)
  const { address } = useAccount()

  const isAuctionEnded = listing.listingType === 'ENGLISH_AUCTION' && listing.endTime && new Date(listing.endTime).getTime() <= Date.now()
  const hasBids = listing.highestBid && listing.highestBid !== '0'
  const isWinner = hasBids && address && listing.highestBidder?.toLowerCase() === address.toLowerCase()
  const canSettle = isAuctionEnded && isWinner && !isSettleSuccess

  // Quote LZ fee for settle
  useEffect(() => {
    if (!canSettle || !listing.highestBidder) return
    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawNameQuoterAbi,
      functionName: 'syncTransferQuote',
      args: [listing.tokenId, listing.highestBidder as `0x${string}`, false],
      chainId: chains.l1.chainId,
    }).then((quote: any) => {
      setSettleLzFee((quote.nativeFee * 120n) / 100n)
    }).catch(() => {})
  }, [canSettle, listing.highestBidder])

  useEffect(() => {
    if (isSettleSuccess) triggerRefresh()
  }, [isSettleSuccess])

  const handleSettle = (e: React.MouseEvent) => {
    e.stopPropagation()
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeSettle({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawNameMarketplaceAbi,
        functionName: 'settleAuction',
        args: [BigInt(listing.listingId)],
        value: settleLzFee,
        chainId: chains.l1.chainId,
      })
    })
  }

  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const badge = TYPE_BADGES[listing.listingType] || TYPE_BADGES.FIXED

  // Calculate initial price
  const calculatePrice = () => {
    if (listing.listingType === 'DUTCH_AUCTION') {
      const current = getDutchCurrentPrice(listing)
      return current || listing.startPrice
    }
    if (listing.listingType === 'ENGLISH_AUCTION' && listing.highestBid && listing.highestBid !== '0') {
      return listing.highestBid
    }
    return listing.startPrice
  }

  const [rawPrice, setRawPrice] = useState(() => calculatePrice())

  // Update price every second for Dutch auctions
  useEffect(() => {
    if (listing.listingType !== 'DUTCH_AUCTION') return

    const interval = setInterval(() => {
      setRawPrice(calculatePrice())
    }, 1000)

    return () => clearInterval(interval)
  }, [listing])

  const displayPrice = useMemo(() => formatPrice(rawPrice, listing.paymentToken), [rawPrice, listing.paymentToken])

  const usdDisplay = useMemo(() => {
    const token = listing.paymentToken
    if (token === 'USDC' || token === 'USDT') return null
    const num = parsePrice(rawPrice, token)
    let rate = 0
    if (token === 'ETH' || token === 'WETH') rate = ethPrice
    else if (token === 'CAW') rate = cawPrice
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [rawPrice, listing.paymentToken, ethPrice, cawPrice])

  const handleAction = () => {
    if (listing.listingType === 'ENGLISH_AUCTION') {
      openBidModal(listing)
    } else {
      openBuyModal(listing)
    }
  }

  return (
    <div onClick={handleAction} className="cursor-pointer transition hover:scale-[1.02]">
      <ProfileCard username={listing.username}>
        <div className="space-y-2">
          {/* Type badge and time */}
          <div className="flex items-center justify-between">
            <span title={badge.tip} className={`text-xs px-2 py-0.5 rounded-full font-medium cursor-help ${badge.color}`}>
              {badge.label}
            </span>
            {listing.endTime && (
              <LiveCountdown endTime={listing.endTime} />
            )}
          </div>

          {/* Price */}
          <div className="text-center">
            <div className="flex items-baseline justify-center gap-1.5">
              <span className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {displayPrice}
              </span>
              <span className={`text-sm ${themeTextSecondary(isDark)}`}>
                {listing.paymentToken}
              </span>
            </div>
            {usdDisplay && (
              <div className={`text-xs ${themeTextMuted(isDark)}`}>
                {usdDisplay}
              </div>
            )}
            {isWinner && !isAuctionEnded && (
              <div className="text-xs text-yellow-500 font-medium">
                ★ you are top bidder
              </div>
            )}
            {listing.listingType === 'ENGLISH_AUCTION' && (listing._count?.bids ?? 0) > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (!allBids) {
                    apiFetch<MarketplaceListing & { bids: MarketplaceBid[] }>(`/api/marketplace/listings/${listing.id}`)
                      .then(data => setAllBids(data.bids || []))
                      .catch(() => {})
                  }
                  setShowBids(true)
                }}
                className={`text-xs underline cursor-pointer ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-500'}`}
              >
                {listing._count!.bids} bid{listing._count!.bids !== 1 ? 's' : ''}
              </button>
            )}
          </div>

          {/* Settle auction button */}
          {canSettle && (
            <div className="text-center">
              {isSettleSuccess ? (
                <span className={`text-xs font-medium ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                  Auction settled!
                </span>
              ) : (
                <button
                  onClick={handleSettle}
                  disabled={isSettling || isSettleConfirming}
                  className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSettling ? 'Confirm in wallet...' : isSettleConfirming ? 'Settling...' : 'Claim Username'}
                </button>
              )}
              {settleError && (
                <p className="text-xs text-red-400 mt-1">
                  {settleError.message?.includes('User rejected') ? 'Transaction rejected' : 'Failed to settle'}
                </p>
              )}
            </div>
          )}

          {/* Cancel link for seller */}
          {showCancel && !canSettle && (
            <div className="text-center">
              <button
                onClick={(e) => { e.stopPropagation(); setShowCancelConfirm(true) }}
                className={`text-xs cursor-pointer ${isDark ? 'text-red-400/60 hover:text-red-400' : 'text-red-400/60 hover:text-red-500'}`}
              >
                Cancel listing
              </button>
            </div>
          )}
        </div>
      </ProfileCard>

      {/* Cancel confirmation modal */}
      {showCancelConfirm && (
        <div onClick={e => e.stopPropagation()}>
          <ModalWrapper isOpen={showCancelConfirm} onClose={() => { setShowCancelConfirm(false); resetCancel() }} maxWidth="max-w-sm" usePortal zIndex={10000}>
            <div className="p-5 text-center">
              <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Cancel Listing?
              </h3>
              <p className={`text-sm mb-4 ${themeTextMuted(isDark)}`}>
                This will remove @{listing.username} from the marketplace.
                {listing.listingType === 'ENGLISH_AUCTION' && listing.highestBid && listing.highestBid !== '0' && (
                  <span className="block mt-1 text-red-400">Cannot cancel — this auction has bids.</span>
                )}
              </p>
              {cancelError && (
                <div className="mb-3 p-2 rounded-lg bg-red-500/10 text-red-400 text-xs">
                  {cancelError.message?.includes('User rejected') ? 'Transaction rejected' : 'Failed to cancel. Please try again.'}
                </div>
              )}
              {isCancelSuccess ? (
                <p className={`text-sm ${isDark ? 'text-green-400' : 'text-green-600'}`}>Listing cancelled!</p>
              ) : (
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => { setShowCancelConfirm(false); resetCancel() }}
                    className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                  >
                    Keep
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={isCancelling || isCancelConfirming || (listing.listingType === 'ENGLISH_AUCTION' && !!listing.highestBid && listing.highestBid !== '0')}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isCancelling ? 'Confirm in wallet...' : isCancelConfirming ? 'Cancelling...' : 'Cancel Listing'}
                  </button>
                </div>
              )}
            </div>
          </ModalWrapper>
        </div>
      )}

      {/* Bid history modal */}
      <ModalWrapper isOpen={showBids} onClose={() => setShowBids(false)} maxWidth="max-w-sm" usePortal zIndex={10000}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Bid History
            </h3>
            <button
              onClick={() => setShowBids(false)}
              className={`p-1 rounded-full transition-colors cursor-pointer ${
                isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {!allBids ? (
            <div className={`text-sm text-center py-4 ${themeTextMuted(isDark)}`}>Loading...</div>
          ) : allBids.length === 0 ? (
            <div className={`text-sm text-center py-4 ${themeTextMuted(isDark)}`}>No bids yet</div>
          ) : (
            <div className="space-y-0">
              {allBids.map((bid, i) => (
                <div
                  key={bid.id}
                  className={`flex items-center justify-between py-2.5 ${
                    i < allBids.length - 1 ? `border-b ${isDark ? 'border-white/5' : 'border-gray-100'}` : ''
                  }`}
                >
                  <div>
                    <span className={`text-sm font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {bid.bidder.slice(0, 6)}...{bid.bidder.slice(-4)}
                    </span>
                    <span className={`text-xs ml-2 ${themeTextMuted(isDark)}`}>
                      {timeAgo(bid.createdAt)}
                    </span>
                  </div>
                  <span className={`text-sm font-semibold ${i === 0 ? (isDark ? 'text-yellow-400' : 'text-yellow-600') : (isDark ? 'text-white' : 'text-gray-900')}`}>
                    {formatPrice(bid.amount, listing.paymentToken)} {listing.paymentToken}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ModalWrapper>
    </div>
  )
}

export default ListingCard
