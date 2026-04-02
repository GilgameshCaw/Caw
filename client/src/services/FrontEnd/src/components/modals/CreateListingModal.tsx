import React, { useState, useMemo } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { parseEther, parseUnits } from 'viem'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeSecondaryButton, themeInput, themeBorder } from '~/utils/theme'
import { useMarketplaceStore } from '~/store/marketplaceStore'
import { usePriceStore, useTokenDataStore } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_MARKETPLACE_ADDRESS, WETH_ADDRESS, CAW_ADDRESS, USDC_ADDRESS, USDT_ADDRESS } from '~/../../../abi/addresses'
import { cawNameAbi } from '~/../../../abi/generated'
import { cawNameMarketplaceAbi } from '~/../../../abi/generated'

type ListingStep = 'type' | 'params' | 'approve' | 'confirm'

const LISTING_TYPES = [
  { value: 0, label: 'Fixed Price', desc: 'Set a price, buyer pays it.' },
  { value: 1, label: 'Dutch Auction', desc: 'Price decreases over time, and the first bidder wins.' },
  { value: 2, label: 'English Auction', desc: 'Bidders compete. Highest bid wins at deadline.' },
]

const PAYMENT_OPTIONS = [
  { value: '0x0000000000000000000000000000000000000000', label: 'ETH', decimals: 18 },
  { value: WETH_ADDRESS, label: 'WETH', decimals: 18 },
  { value: CAW_ADDRESS, label: 'CAW', decimals: 18 },
  { value: USDC_ADDRESS, label: 'USDC', decimals: 6 },
  { value: USDT_ADDRESS, label: 'USDT', decimals: 6 },
]

// CAW burn cost schedule (before 10^18 multiplier) — mirrors CawNameMinter
const MINT_COST: Record<number, number> = {
  1: 1_000_000_000_000,
  2: 240_000_000_000,
  3: 60_000_000_000,
  4: 6_000_000_000,
  5: 200_000_000,
  6: 20_000_000,
  7: 10_000_000,
}
const MINT_COST_DEFAULT = 1_000_000 // 8+ chars

function getMintCostCaw(nameLength: number): number {
  if (nameLength <= 0) return 0
  return MINT_COST[nameLength] ?? MINT_COST_DEFAULT
}

const CreateListingModal: React.FC = () => {
  const { isDark } = useTheme()
  const isOpen = useMarketplaceStore(s => s.createListingModal.isOpen)
  const tokenId = useMarketplaceStore(s => s.createListingModal.tokenId)
  const username = useMarketplaceStore(s => s.createListingModal.username)
  const close = useMarketplaceStore(s => s.closeCreateListing)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const tokenOwner = useMemo(() => {
    for (const [addr, tokens] of Object.entries(tokensByAddress)) {
      if (tokens.some(t => t.tokenId === tokenId)) return addr.toLowerCase()
    }
    return null
  }, [tokensByAddress, tokenId])
  const isOwner = !!address && !!tokenOwner && address.toLowerCase() === tokenOwner

  // Separate write hooks for approve and listing
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: writeListing, data: listingHash, isPending: isSubmitting, error: writeError, reset: resetListing } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: listingHash })

  // Check if marketplace is approved to transfer NFTs
  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: 'isApprovedForAll',
    args: [address!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!address },
  })

  // Refetch approval status after successful approve tx
  React.useEffect(() => {
    if (isApproveSuccess) refetchApproval()
  }, [isApproveSuccess])

  // Trigger marketplace refresh after successful listing
  React.useEffect(() => {
    if (isSuccess) {
      // Small delay to let the indexer pick it up
      setTimeout(() => useMarketplaceStore.getState().triggerRefresh(), 3000)
    }
  }, [isSuccess])

  const [step, setStep] = useState<ListingStep>('type')
  const [listingType, setListingType] = useState(0)
  const [paymentToken, setPaymentToken] = useState(PAYMENT_OPTIONS[0].value)
  const [startPrice, setStartPrice] = useState('')
  const [endPrice, setEndPrice] = useState('')

  const getRateForToken = (tokenValue: string) => {
    const opt = PAYMENT_OPTIONS.find(o => o.value === tokenValue)
    if (!opt) return 0
    if (opt.label === 'ETH' || opt.label === 'WETH') return usePriceStore.getState().priceMap['ethereum'] ?? 0
    if (opt.label === 'CAW') return usePriceStore.getState().priceMap['a-hunters-dream'] ?? 0
    if (opt.label === 'USDC' || opt.label === 'USDT') return 1
    return 0
  }

  const formatConverted = (value: number, tokenValue: string) => {
    const opt = PAYMENT_OPTIONS.find(o => o.value === tokenValue)
    if (!opt) return String(value)
    if (opt.label === 'CAW') return Math.round(value).toString()
    if (opt.label === 'USDC' || opt.label === 'USDT') return value.toFixed(2)
    // ETH/WETH
    return value < 0.0001 ? value.toFixed(8) : value.toFixed(4)
  }

  const handleCurrencyChange = (newToken: string) => {
    const oldRate = getRateForToken(paymentToken)
    const newRate = getRateForToken(newToken)

    if (oldRate && newRate && startPrice) {
      const usd = parseFloat(startPrice) * oldRate
      setStartPrice(formatConverted(usd / newRate, newToken))
    }
    if (oldRate && newRate && endPrice) {
      const usd = parseFloat(endPrice) * oldRate
      setEndPrice(formatConverted(usd / newRate, newToken))
    }
    setPaymentToken(newToken)
  }
  const [durationHours, setDurationHours] = useState('24')

  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const [showMintCostTip, setShowMintCostTip] = useState(false)

  const mintCostUsd = useMemo(() => {
    if (!username || !cawPrice) return null
    const cawAmount = getMintCostCaw(username.length)
    const usd = cawAmount * cawPrice
    return usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [username, cawPrice])

  const usdRate = useMemo(() => {
    const selected = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
    if (!selected) return 0
    if (selected.label === 'ETH' || selected.label === 'WETH') return ethPrice
    if (selected.label === 'CAW') return cawPrice
    if (selected.label === 'USDC' || selected.label === 'USDT') return 1
    return 0
  }, [paymentToken, ethPrice, cawPrice])

  const formatUsd = (amount: string) => {
    const num = parseFloat(amount)
    if (!num || !usdRate) return null
    const usd = num * usdRate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const currentRateLabel = useMemo(() => {
    const selected = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
    if (!selected || !usdRate) return null
    if (selected.label === 'CAW') {
      // Show how much CAW you get per $0.01
      const cawPerCent = 0.01 / usdRate
      return `$0.01 = ${cawPerCent.toLocaleString(undefined, { maximumFractionDigits: 1 })} CAW`
    }
    // ETH / WETH — show 1 token = $X
    return `1 ${selected.label} = $${usdRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [paymentToken, usdRate])

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  const handleClose = () => {
    setStep('type')
    setListingType(0)
    setStartPrice('')
    setEndPrice('')
    setDurationHours('24')
    resetApprove()
    resetListing()
    close()
  }

  const handleApprove = () => {
    if (!isConnected) { openConnectModal?.(); return }
    if (needsChainSwitch) { switchChain({ chainId: chains.l1.chainId }); return }

    writeApprove({
      address: CAW_NAMES_ADDRESS,
      abi: cawNameAbi,
      functionName: 'setApprovalForAll',
      args: [CAW_NAME_MARKETPLACE_ADDRESS, true],
      chainId: chains.l1.chainId,
    })
  }

  const handleCreateListing = () => {
    if (!isConnected) { openConnectModal?.(); return }
    if (needsChainSwitch) { switchChain({ chainId: chains.l1.chainId }); return }
    if (tokenId === null) return

    const duration = BigInt(parseInt(durationHours) * 3600)
    let startPriceWei: bigint
    let endPriceWei: bigint

    const selectedToken = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
    const decimals = selectedToken?.decimals ?? 18

    if (paymentToken === '0x0000000000000000000000000000000000000000') {
      startPriceWei = parseEther(startPrice)
      endPriceWei = listingType === 1 ? parseEther(endPrice) : 0n
    } else {
      startPriceWei = parseUnits(startPrice, decimals)
      endPriceWei = listingType === 1 ? parseUnits(endPrice, decimals) : 0n
    }

    writeListing({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawNameMarketplaceAbi,
      functionName: 'createListing',
      args: [tokenId, listingType, paymentToken as `0x${string}`, startPriceWei, endPriceWei, duration],
      chainId: chains.l1.chainId,
    })
  }

  const inputClass = `w-full px-3 py-2 rounded-lg text-sm border outline-none transition ${themeInput(isDark)} ${themeBorder(isDark)}`

  // Format a raw number string with commas for display, preserving decimals
  const displayWithCommas = (val: string) => {
    if (!val) return ''
    const parts = val.split('.')
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.length > 1 ? `${intPart}.${parts[1]}` : intPart
  }

  // Strip commas from input to get raw number
  const handlePriceInput = (val: string, setter: (v: string) => void) => {
    const raw = val.replace(/,/g, '')
    if (raw === '' || /^\d*\.?\d*$/.test(raw)) setter(raw)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-[522px]" usePortal zIndex={9999}>
      <div className="p-6">
        {isSuccess ? (
          <div className="text-center py-6">
            <div className={`inline-flex items-center justify-center w-14 h-14 rounded-full mb-4 ${isDark ? 'bg-green-500/10' : 'bg-green-50'}`}>
              <svg className={`w-7 h-7 ${isDark ? 'text-green-400' : 'text-green-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>Listed Successfully!</h2>
            <p className={`text-sm mb-6 ${themeTextMuted(isDark)}`}>
              Your listing for <a href={`/users/${username}`} target="_blank" rel="noopener noreferrer" className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>@{username}</a> will appear on the marketplace shortly.
            </p>
            <button
              onClick={handleClose}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              Done
            </button>
          </div>
        ) : step === 'type' ? (
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
              List for Sale
            </h2>
            <p className={`text-sm text-center mb-6 ${themeTextMuted(isDark)}`}>
              List <span className="font-semibold">@{username}</span> on the marketplace.
            </p>
            <div className={`text-xs mb-4 p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
              Any CAW staked on this username will transfer to the buyer along with the NFT.
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <button
                type="button"
                onClick={() => setStep('type')}
                className={`text-xs transition ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
              >
                &larr; Change listing type
              </button>
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
              {LISTING_TYPES[listingType].label}
            </h2>
            <p className={`text-sm text-center mb-6 ${themeTextMuted(isDark)}`}>{LISTING_TYPES[listingType].desc}</p>
          </>
        )}

        {/* Step: Choose listing type */}
        {step === 'type' && (
          <div className="space-y-3 mb-4">
            {LISTING_TYPES.map(t => (
              <button
                key={t.value}
                onClick={() => { setListingType(t.value); setStep('params') }}
                className={`w-full text-left p-4 rounded-xl border transition cursor-pointer ${
                  isDark ? 'border-white/10 hover:border-yellow-500/30 hover:bg-white/5' : 'border-gray-200 hover:border-yellow-500 hover:bg-gray-50'
                }`}
              >
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{t.label}</span>
                <p className={`text-sm mt-0.5 ${themeTextMuted(isDark)}`}>{t.desc}</p>
              </button>
            ))}
          </div>
        )}

        {/* Step: Set parameters */}
        {step === 'params' && !isSuccess && (
          <div className="space-y-4 mb-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${themeTextSecondary(isDark)}`}>Payment Token</label>
              <div className="relative">
                <select
                  value={paymentToken}
                  onChange={e => handleCurrencyChange(e.target.value)}
                  className={`${inputClass} appearance-none pr-8`}
                >
                  {PAYMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                  <svg className={`h-4 w-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-end justify-between mb-2">
                <div className="flex items-end gap-2">
                  <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                    {listingType === 0 ? 'Price' : listingType === 1 ? 'Start Price' : 'Minimum Bid'}
                  </label>
                  {mintCostUsd && (
                    <div className="relative">
                      <button
                        type="button"
                        onMouseEnter={() => setShowMintCostTip(true)}
                        onMouseLeave={() => setShowMintCostTip(false)}
                        onClick={() => setShowMintCostTip(p => !p)}
                        className={`rounded-full p-0.5 transition ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
                      >
                        <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                      {showMintCostTip && (
                        <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg text-xs whitespace-nowrap z-50 ${
                          isDark ? 'bg-gray-800 text-gray-200 border border-white/10' : 'bg-gray-900 text-white'
                        }`}>
                          Minting a {username?.length}-character username today costs {mintCostUsd}
                          <div className={`absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 ${
                            isDark ? 'bg-gray-800 border-r border-b border-white/10' : 'bg-gray-900'
                          }`} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {usdRate > 0 && (
                  <div className="flex gap-1.5">
                    {[10, 100, 1000, 10000].map(usd => {
                      const tokenAmount = usd / usdRate
                      const rounded = tokenAmount < 1 ? tokenAmount.toPrecision(3) : tokenAmount.toFixed(2)
                      const isActive = startPrice === rounded
                      return (
                        <button
                          key={usd}
                          type="button"
                          onClick={() => setStartPrice(rounded)}
                          className={`px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
                            isActive
                              ? 'bg-yellow-500 text-black border-yellow-500'
                              : isDark
                                ? 'border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/5'
                                : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          ${usd.toLocaleString()}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <input
                type="text"
                inputMode="decimal"
                value={displayWithCommas(startPrice)}
                onChange={e => handlePriceInput(e.target.value, setStartPrice)}
                placeholder="0.0"
                className={inputClass}
              />
              <div className="flex items-center justify-between mt-1">
                <span className={`text-xs ${themeTextMuted(isDark)}`}>
                  {formatUsd(startPrice) ? `${formatUsd(startPrice)} USD` : '\u00A0'}
                </span>
                {currentRateLabel && (
                  <span className={`text-xs ${themeTextMuted(isDark)}`}>{currentRateLabel}</span>
                )}
              </div>
            </div>

            {listingType === 1 && (
              <div>
                <div className="flex items-end justify-between mb-2">
                  <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>Floor Price</label>
                  {usdRate > 0 && (
                    <div className="flex gap-1.5">
                      {[10, 100, 1000, 10000].map(usd => {
                        const tokenAmount = usd / usdRate
                        const rounded = tokenAmount < 1 ? tokenAmount.toPrecision(3) : tokenAmount.toFixed(2)
                        const isActive = endPrice === rounded
                        return (
                          <button
                            key={usd}
                            type="button"
                            onClick={() => setEndPrice(rounded)}
                            className={`px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
                              isActive
                                ? 'bg-yellow-500 text-black border-yellow-500'
                                : isDark
                                  ? 'border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/5'
                                  : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            ${usd.toLocaleString()}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={displayWithCommas(endPrice)}
                  onChange={e => handlePriceInput(e.target.value, setEndPrice)}
                  placeholder="0.0"
                  className={inputClass}
                />
                <div className="flex items-center justify-between mt-1">
                  <span className={`text-xs ${themeTextMuted(isDark)}`}>
                    {formatUsd(endPrice) ? `${formatUsd(endPrice)} USD` : '\u00A0'}
                  </span>
                  {currentRateLabel && (
                    <span className={`text-xs ${themeTextMuted(isDark)}`}>{currentRateLabel}</span>
                  )}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-end justify-between mb-2">
                <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>Duration <span className={themeTextMuted(isDark)}>(hours)</span></label>
                <div className="flex gap-1.5">
                  {[
                    { label: '1d', hours: 24 },
                    { label: '3d', hours: 72 },
                    { label: '7d', hours: 168 },
                    { label: '14d', hours: 336 },
                    { label: '30d', hours: 720 },
                  ].map(opt => {
                    const isActive = parseInt(durationHours) === opt.hours
                    return (
                      <button
                        key={opt.hours}
                        type="button"
                        onClick={() => setDurationHours(String(opt.hours))}
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
                type="number"
                min="1"
                max="720"
                value={durationHours}
                onChange={e => setDurationHours(e.target.value)}
                placeholder="Custom hours"
                className={inputClass}
              />
            </div>

            {listingType === 2 && (
              <div className={`text-xs p-3 rounded-lg text-center ${isDark ? 'bg-blue-500/10 text-blue-400' : 'bg-blue-50 text-blue-700'}`}>
                If a bid is placed in the last 10 minutes,<br />the auction extends by 10 minutes so others can respond.
              </div>
            )}

            <div className={`text-xs text-center space-y-1 ${themeTextMuted(isDark)}`}>
              <p>If no one {listingType === 2 ? 'bids' : 'buys'}, the listing expires and you keep your profile.</p>
              <p className={`mt-2 ${isDark ? 'text-green-400' : 'text-green-600'}`}>0% marketplace fees — forever.</p>
            </div>

            {(approveError || writeError) && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
                {(approveError || writeError)?.message?.includes('User rejected')
                  ? 'Transaction rejected'
                  : 'Transaction failed. Please try again.'}
              </div>
            )}

            {isConnected && !isOwner && (
              <div className={`p-3 rounded-lg text-sm text-center ${isDark ? 'bg-orange-500/10 text-orange-400' : 'bg-orange-50 text-orange-600'}`}>
                Switch to the wallet that owns this username to list it.
              </div>
            )}

            {!isApproved && !isApproveSuccess && (
              <div className="flex justify-center">
                <button
                  onClick={() => { resetApprove(); handleApprove() }}
                  disabled={(isConnected && !isOwner) || isApproving || isApproveConfirming || isSwitchingChain}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
                >
                  {!isConnected ? 'Connect Wallet'
                    : !isOwner ? 'Wrong Wallet'
                    : needsChainSwitch ? (isSwitchingChain ? 'Switching...' : 'Switch Network')
                    : isApproving ? 'Confirm in wallet...'
                    : isApproveConfirming ? 'Approving...'
                    : 'Approve Sale'}
                </button>
              </div>
            )}

            {(isApproved || isApproveSuccess) && (
              <div className="flex justify-center">
                <button
                  onClick={() => { resetListing(); handleCreateListing() }}
                  disabled={(isConnected && !isOwner) || isSuccess || isSubmitting || isConfirming || isSwitchingChain || !startPrice || parseFloat(startPrice) <= 0 || (listingType === 1 && (!endPrice || parseFloat(endPrice) >= parseFloat(startPrice)))}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {!isConnected ? 'Connect Wallet'
                    : !isOwner ? 'Wrong Wallet'
                    : needsChainSwitch ? (isSwitchingChain ? 'Switching...' : 'Switch Network')
                    : isSubmitting ? 'Confirm in wallet...'
                    : isConfirming ? 'Confirming...'
                    : 'List for Sale'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </ModalWrapper>
  )
}

export default CreateListingModal
