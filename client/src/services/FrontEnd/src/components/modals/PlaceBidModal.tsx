import React, { useState, useEffect, useMemo } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract, useBalance } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { parseEther, parseUnits, formatEther, formatUnits, erc20Abi, maxUint256 } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeInput, themeBorder } from '~/utils/theme'
import { useMarketplaceStore, MarketplaceListing, MarketplaceBid } from '~/store/marketplaceStore'
import { apiFetch } from '~/api/client'
import { usePriceStore } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import LiveCountdown from '~/components/marketplace/LiveCountdown'

const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6 }

function timeAgo(dateStr: string, t: (k: string, vars?: Record<string, any>) => string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return t('bid_modal.time.just_now')
  if (mins < 60) return t('bid_modal.time.minutes', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('bid_modal.time.hours', { count: hours })
  const days = Math.floor(hours / 24)
  return t('bid_modal.time.days', { count: days })
}

function fmtPrice(raw: string, token: string): string {
  const dec = DECIMALS[token] ?? 18
  const num = parseFloat(dec === 18 ? formatEther(BigInt(raw)) : formatUnits(BigInt(raw), dec))
  if (token === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (token === 'USDC' || token === 'USDT') return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function parsePriceNum(raw: string, token: string): number {
  const dec = DECIMALS[token] ?? 18
  return parseFloat(dec === 18 ? formatEther(BigInt(raw)) : formatUnits(BigInt(raw), dec))
}

const PlaceBidModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const isOpen = useMarketplaceStore(s => s.bidModal.isOpen)
  const listing = useMarketplaceStore(s => s.bidModal.listing)
  const close = useMarketplaceStore(s => s.closeBidModal)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  // Approve hook (for ERC20 tokens)
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  // Bid hook
  const { writeContract: writeBid, data: bidHash, isPending: isSubmitting, error: writeError, reset: resetBid } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: bidHash })

  const [bidAmount, setBidAmount] = useState('')
  const [bidHistory, setBidHistory] = useState<MarketplaceBid[]>([])

  // Fetch bid history when modal opens
  useEffect(() => {
    if (!listing) { setBidHistory([]); return }
    apiFetch<MarketplaceListing & { bids: MarketplaceBid[] }>(`/api/marketplace/listings/${listing.id}`)
      .then(data => setBidHistory(data.bids || []))
      .catch(() => {})
  }, [listing?.id])

  const isEth = listing?.paymentAddress === '0x0000000000000000000000000000000000000000'
  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Check balances
  const { data: ethBalance } = useBalance({
    address,
    chainId: chains.l1.chainId,
    query: { enabled: !!address && isEth },
  })
  const { data: tokenBalance } = useReadContract({
    address: listing?.paymentAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !!listing && !isEth },
  })

  const userBalance = isEth ? (ethBalance?.value ?? 0n) : (tokenBalance ?? 0n)

  // Check ERC20 allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: listing?.paymentAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !!listing && !isEth },
  })

  React.useEffect(() => {
    if (isApproveSuccess) refetchAllowance()
  }, [isApproveSuccess])

  const minBid = useMemo(() => {
    if (!listing) return '0'
    if (!listing.highestBid || listing.highestBid === '0') return listing.startPrice
    const current = BigInt(listing.highestBid)
    return (current + current * 500n / 10000n).toString()
  }, [listing])

  const minBidDisplay = listing ? fmtPrice(minBid, listing.paymentToken) : '0'
  const minBidRaw = listing ? String(parsePriceNum(minBid, listing.paymentToken)) : '0'

  // Default bid to minimum when modal opens
  React.useEffect(() => {
    if (isOpen && listing && !bidAmount) {
      setBidAmount(minBidRaw)
    }
  }, [isOpen, minBidRaw])

  const bidWei = useMemo(() => {
    if (!bidAmount || !listing) return 0n
    try {
      const dec = DECIMALS[listing.paymentToken] ?? 18
      return dec === 18 ? parseEther(bidAmount) : parseUnits(bidAmount, dec)
    } catch { return 0n }
  }, [bidAmount, listing?.paymentToken])

  const insufficientBalance = isConnected && bidWei > 0n && bidWei > userBalance
  const needsApproval = !isEth && listing && bidWei > 0n && (!allowance || allowance < bidWei)
  const hasApproval = isEth || (allowance && bidWei > 0n && allowance >= bidWei) || isApproveSuccess

  const usdDisplay = useMemo(() => {
    if (!bidAmount || !listing) return null
    const token = listing.paymentToken
    if (token === 'USDC' || token === 'USDT') return null
    const num = parseFloat(bidAmount)
    if (!num) return null
    let rate = 0
    if (token === 'ETH' || token === 'WETH') rate = ethPrice
    else if (token === 'CAW') rate = cawPrice
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [bidAmount, listing?.paymentToken, ethPrice, cawPrice])

  const isEnded = listing?.endTime ? new Date(listing.endTime).getTime() <= Date.now() : false

  const handleClose = () => {
    setBidAmount('')
    resetApprove()
    resetBid()
    close()
  }

  const handleApprove = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (!listing) return

      writeApprove({
        address: listing.paymentAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [CAW_NAME_MARKETPLACE_ADDRESS, maxUint256],
        chainId: chains.l1.chainId,
      })
    })
  }

  const handleBid = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (!listing || !bidAmount) return

      if (isEth) {
        writeBid({
          address: CAW_NAME_MARKETPLACE_ADDRESS,
          abi: cawProfileMarketplaceAbi,
          functionName: 'placeBid',
          args: [BigInt(listing.listingId)],
          value: bidWei,
          chainId: chains.l1.chainId,
        })
      } else {
        writeBid({
          address: CAW_NAME_MARKETPLACE_ADDRESS,
          abi: cawProfileMarketplaceAbi,
          functionName: 'placeBidWithToken',
          args: [BigInt(listing.listingId), bidWei],
          chainId: chains.l1.chainId,
        })
      }
    })
  }

  if (!listing) return null

  const inputClass = `w-full px-3 py-2 rounded-lg text-sm border outline-none transition ${themeInput(isDark)} ${themeBorder(isDark)}`

  const displayWithCommas = (val: string) => {
    if (!val) return ''
    const parts = val.split('.')
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.length > 1 ? `${intPart}.${parts[1]}` : intPart
  }

  const handlePriceInput = (val: string, setter: (v: string) => void) => {
    const raw = val.replace(/,/g, '')
    if (raw === '' || /^\d*\.?\d*$/.test(raw)) setter(raw)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-[480px]" usePortal zIndex={9999}>
      <div className="p-6">
        {isSuccess ? (
          <div className="text-center py-6">
            <div className={`inline-flex items-center justify-center w-14 h-14 rounded-full mb-4 ${isDark ? 'bg-green-500/10' : 'bg-green-50'}`}>
              <svg className={`w-7 h-7 ${isDark ? 'text-green-400' : 'text-green-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('bid_modal.success.title')}</h2>
            <p className={`text-sm mb-6 ${themeTextMuted(isDark)}`}>
              {t('bid_modal.success.line1_before')}<span className="font-semibold">@{listing.username}</span>{t('bid_modal.success.line1_after')}<br />{t('bid_modal.success.line2')}
            </p>
            <button
              onClick={handleClose}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              {t('bid_modal.done')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex justify-end mb-1">
              <button
                onClick={handleClose}
                className={`p-1 rounded-full transition-colors cursor-pointer ${
                  isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <h2 className={`text-xl font-bold text-center ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('bid_modal.title', { username: listing.username })}
            </h2>
            <p className={`text-sm text-center mb-4 ${themeTextMuted(isDark)}`}>
              {t('bid_modal.subtitle')}
            </p>

            {/* Time remaining */}
            {listing.endTime && (
              <div className="text-center mb-4">
                <LiveCountdown endTime={listing.endTime} />
              </div>
            )}

            {/* Auction info */}
            <div className={`p-4 rounded-xl ${themeBgSubtle(isDark)} space-y-2 text-sm mb-4`}>
              {listing.highestBid && listing.highestBid !== '0' && (
                <div className="flex justify-between">
                  <span className={themeTextMuted(isDark)}>{t('bid_modal.current_bid')}</span>
                  <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {fmtPrice(listing.highestBid, listing.paymentToken)} {listing.paymentToken}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className={themeTextMuted(isDark)}>{t('bid_modal.minimum_bid')}</span>
                <div className="text-right">
                  <span className={themeTextSecondary(isDark)}>{minBidDisplay} {listing.paymentToken}</span>
                  {listing.highestBid && listing.highestBid !== '0' && (
                    <div className={`text-xs ${themeTextMuted(isDark)}`}>{t('bid_modal.five_pct_above')}</div>
                  )}
                </div>
              </div>
              <div className="flex justify-between">
                <span className={themeTextMuted(isDark)}>{t('bid_modal.fee')}</span>
                <span className={isDark ? 'text-green-400' : 'text-green-600'}>0%</span>
              </div>
            </div>

            {/* Bid history */}
            {bidHistory.length > 0 && (
              <div className="mb-4">
                <h3 className={`text-xs font-medium mb-2 ${themeTextMuted(isDark)}`}>
                  {t('bid_modal.history_title', { count: bidHistory.length })}
                </h3>
                <div className={`rounded-xl overflow-hidden border ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                  {bidHistory.map((bid, i) => (
                    <div
                      key={bid.id}
                      className={`flex items-center justify-between px-3 py-2 text-sm ${
                        i < bidHistory.length - 1 ? `border-b ${isDark ? 'border-white/5' : 'border-gray-100'}` : ''
                      } ${i === 0 ? (isDark ? 'bg-yellow-500/5' : 'bg-yellow-50/50') : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        {i === 0 && <span className="text-yellow-500 text-xs">★</span>}
                        <span className={`font-mono text-xs ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                          {bid.bidder.slice(0, 6)}...{bid.bidder.slice(-4)}
                        </span>
                        <span className={`text-xs ${themeTextMuted(isDark)}`}>
                          {timeAgo(bid.createdAt, t)}
                        </span>
                      </div>
                      <span className={`text-xs font-semibold ${i === 0 ? (isDark ? 'text-yellow-400' : 'text-yellow-600') : (isDark ? 'text-white' : 'text-gray-900')}`}>
                        {fmtPrice(bid.amount, listing.paymentToken)} {listing.paymentToken}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Staked CAW warning */}
            {listing.stakedCaw && listing.stakedCaw !== '0' && (
              <div className={`text-xs mb-4 p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                {t('bid_modal.staked_caw_warning', { amount: fmtPrice(listing.stakedCaw, 'CAW') })}
              </div>
            )}

            {/* Anti-snipe note */}
            <div className={`text-xs mb-4 p-3 rounded-lg text-center ${isDark ? 'bg-blue-500/10 text-blue-400' : 'bg-blue-50 text-blue-700'}`}>
              {t('bid_modal.anti_snipe_line1')}<br />{t('bid_modal.anti_snipe_line2')}
            </div>

            {/* Bid input */}
            {!isEnded && (
              <div className="mb-4">
                <div className="flex items-end justify-between mb-2">
                  <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                    {t('bid_modal.your_bid_label', { token: listing.paymentToken })}
                  </label>
                  <div className="flex gap-1.5">
                    {[
                      { label: t('bid_modal.preset.min'), pct: 0 },
                      { label: '+5%', pct: 5 },
                      { label: '+10%', pct: 10 },
                      { label: '+15%', pct: 15 },
                    ].map(opt => {
                      const base = BigInt(minBid)
                      const amount = opt.pct === 0 ? base : base + base * BigInt(opt.pct) / 100n
                      const amountStr = String(parsePriceNum(amount.toString(), listing.paymentToken))
                      const isActive = bidAmount === amountStr
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => setBidAmount(amountStr)}
                          className={`px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
                            isActive
                              ? 'bg-yellow-500 text-black border-yellow-500'
                              : isDark
                                ? 'border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/5'
                                : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={displayWithCommas(bidAmount)}
                  onChange={e => handlePriceInput(e.target.value, setBidAmount)}
                  placeholder={minBidDisplay}
                  disabled={isSubmitting || isConfirming}
                  className={inputClass}
                />
                <div className="flex items-center justify-between mt-1">
                  <span className={`text-xs ${themeTextMuted(isDark)}`}>
                    {usdDisplay ? `${usdDisplay} USD` : '\u00A0'}
                  </span>
                  {isConnected && (
                    <span className={`text-xs ${insufficientBalance ? (isDark ? 'text-red-400' : 'text-red-500') : themeTextMuted(isDark)}`}>
                      {t('bid_modal.balance_label')}: {fmtPrice(userBalance.toString(), listing.paymentToken)} {listing.paymentToken}
                    </span>
                  )}
                </div>
                {insufficientBalance && (
                  <p className={`text-xs mt-1 ${isDark ? 'text-red-400' : 'text-red-500'}`}>
                    {t('bid_modal.insufficient_balance')}
                  </p>
                )}
              </div>
            )}

            {/* Buy more link for ERC20 */}
            {!isEth && (
              <p className={`text-xs text-center mb-4 ${themeTextMuted(isDark)}`}>
                {t('bid_modal.need_more_token', { token: listing.paymentToken })}{' '}
                <a
                  href={`https://app.uniswap.org/swap?outputCurrency=${listing.paymentAddress}&chain=sepolia`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-500'}
                  onClick={e => e.stopPropagation()}
                >
                  {t('bid_modal.buy_on_uniswap')}
                </a>
              </p>
            )}

            {isEnded && (
              <div className={`text-center mb-4 p-3 rounded-lg ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
                {t('bid_modal.auction_ended')}
              </div>
            )}

            {/* Errors */}
            {(approveError || writeError) && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
                {(approveError || writeError)?.message?.includes('User rejected')
                  ? t('bid_modal.tx_rejected')
                  : (approveError || writeError)?.message?.includes('Bid too low')
                    ? t('bid_modal.bid_too_low')
                    : t('bid_modal.tx_failed')}
              </div>
            )}

            {/* Approve button (ERC20 only) */}
            {!isEnded && needsApproval && !hasApproval && (
              <button
                onClick={() => { resetApprove(); handleApprove() }}
                disabled={isApproving || isApproveConfirming || isSwitchingChain}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {needsChainSwitch ? (isSwitchingChain ? t('bid_modal.btn.switching') : t('bid_modal.btn.switch_network'))
                  : isApproving ? t('bid_modal.btn.confirm_in_wallet')
                  : isApproveConfirming ? t('bid_modal.btn.approving')
                  : t('bid_modal.btn.approve_token', { token: listing.paymentToken })}
              </button>
            )}

            {/* Bid button */}
            {!isEnded && (isEth || hasApproval) && (
              <button
                onClick={() => { resetBid(); handleBid() }}
                disabled={isSubmitting || isConfirming || isSwitchingChain || !bidAmount || parseFloat(bidAmount) <= 0 || bidWei < BigInt(minBid) || insufficientBalance}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {needsChainSwitch ? (isSwitchingChain ? t('bid_modal.btn.switching') : t('bid_modal.btn.switch_network'))
                  : isSubmitting ? t('bid_modal.btn.confirm_in_wallet')
                  : isConfirming ? t('bid_modal.btn.confirming')
                  : t('bid_modal.btn.place_bid')}
              </button>
            )}
          </>
        )}
      </div>
    </ModalWrapper>
  )
}

export default PlaceBidModal
