import React, { useEffect, useState } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { readContract } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther, formatUnits } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { themeTextMuted, themeBgSubtle, themeBorder } from '~/utils/theme'
import { useMarketplaceStore, MarketplaceOffer } from '~/store/marketplaceStore'
import { usePriceStore, useTokenDataStore } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawNameMarketplaceAbi, cawNameAbi, cawNameQuoterAbi } from '~/../../../abi/generated'
import UsernameSvg from '~/components/UsernameSvg'
import LiveCountdown from '~/components/marketplace/LiveCountdown'
import { apiFetch } from '~/api/client'
import { wagmiConfig } from '~/config/Web3Provider'

const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6 }

function fmtPrice(raw: string, token: string): string {
  const dec = DECIMALS[token] ?? 18
  const num = parseFloat(dec === 18 ? formatEther(BigInt(raw)) : formatUnits(BigInt(raw), dec))
  if (token === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (token === 'USDC' || token === 'USDT') return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}


const ViewOffersModal: React.FC = () => {
  const { isDark } = useTheme()
  const isOpen = useMarketplaceStore(s => s.viewOffersModal.isOpen)
  const tokenId = useMarketplaceStore(s => s.viewOffersModal.tokenId)
  const username = useMarketplaceStore(s => s.viewOffersModal.username)
  const close = useMarketplaceStore(s => s.closeViewOffers)
  const triggerRefresh = useMarketplaceStore(s => s.triggerRefresh)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  const [offers, setOffers] = useState<MarketplaceOffer[]>([])
  const [loading, setLoading] = useState(false)
  const [actionOfferId, setActionOfferId] = useState<number | null>(null) // which offer is being acted on
  const [actionType, setActionType] = useState<'accept' | 'cancel' | null>(null)

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Check if the current user owns this token
  // 1. Check if any of the user's known tokens match
  const ownsTokenLocally = useTokenDataStore(s => {
    if (!tokenId) return false
    for (const tokens of Object.values(s.tokensByAddress)) {
      if (tokens.some(t => t.tokenId === tokenId)) return true
    }
    return false
  })

  // 2. On-chain fallback
  const { data: tokenOwner } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: 'ownerOf',
    args: [BigInt(tokenId ?? 0)],
    chainId: chains.l1.chainId,
    query: { enabled: !!tokenId && !ownsTokenLocally },
  })
  const isOwner = isConnected && (
    ownsTokenLocally ||
    (address && tokenOwner && address.toLowerCase() === (tokenOwner as string).toLowerCase())
  )

  // Check NFT approval for accepting offers
  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: 'isApprovedForAll',
    args: [address!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !!isOwner },
  })

  // Approve NFT hook
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  // Accept/cancel hook
  const { writeContract: writeAction, data: actionHash, isPending: isActionPending, error: actionError, reset: resetAction } = useWriteContract()
  const { isLoading: isActionConfirming, isSuccess: isActionSuccess } = useWaitForTransactionReceipt({ hash: actionHash })

  // LZ fee for accepting
  const [lzFee, setLzFee] = useState(0n)
  const [pendingAcceptAfterApprove, setPendingAcceptAfterApprove] = useState<MarketplaceOffer | null>(null)

  // After approval, auto-trigger the queued accept
  useEffect(() => {
    if (!isApproveSuccess) return
    refetchApproval()
    if (pendingAcceptAfterApprove) {
      const offer = pendingAcceptAfterApprove
      setPendingAcceptAfterApprove(null)
      setActionOfferId(offer.offerId)
      setActionType('accept')
      writeAction({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawNameMarketplaceAbi,
        functionName: 'acceptOffer',
        args: [BigInt(offer.offerId)],
        value: lzFee,
        chainId: chains.l1.chainId,
      })
    }
  }, [isApproveSuccess])

  // Fetch offers
  useEffect(() => {
    if (!isOpen || tokenId === null) return
    setLoading(true)
    apiFetch<{ offers: MarketplaceOffer[]; total: number }>(`/api/marketplace/offers/token/${tokenId}`)
      .then(data => setOffers(data.offers))
      .catch(() => setOffers([]))
      .finally(() => setLoading(false))
  }, [isOpen, tokenId])

  // Quote LZ fee when owner is viewing
  useEffect(() => {
    if (!isOwner || !tokenId || !address) return
    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawNameQuoterAbi,
      functionName: 'syncTransferQuote',
      args: [tokenId, address, false],
      chainId: chains.l1.chainId,
    }).then((quote: any) => {
      setLzFee((quote.nativeFee * 120n) / 100n)
    }).catch(() => {})
  }, [isOwner, tokenId, address])

  // Handle successful action
  useEffect(() => {
    if (!isActionSuccess || actionOfferId === null) return

    const offer = offers.find(o => o.offerId === actionOfferId)
    if (!offer) return

    if (actionType === 'accept') {
      apiFetch(`/api/marketplace/offers/${offer.offerId}/accepted`, {
        method: 'POST',
        body: JSON.stringify({ txHash: actionHash, buyer: offer.offerer }),
      }).catch(() => {})
    } else if (actionType === 'cancel') {
      apiFetch(`/api/marketplace/offers/${offer.offerId}/cancelled`, {
        method: 'POST',
        body: JSON.stringify({ txHash: actionHash }),
      }).catch(() => {})
    }

    setOffers(prev => prev.filter(o => o.offerId !== actionOfferId))
    setActionOfferId(null)
    setActionType(null)
    triggerRefresh()
    resetAction()
  }, [isActionSuccess])

  const handleApproveNFT = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeApprove({
        address: CAW_NAMES_ADDRESS,
        abi: cawNameAbi,
        functionName: 'setApprovalForAll',
        args: [CAW_NAME_MARKETPLACE_ADDRESS, true],
        chainId: chains.l1.chainId,
      })
    })
  }

  const handleAcceptOffer = (offer: MarketplaceOffer) => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      setActionOfferId(offer.offerId)
      setActionType('accept')
      writeAction({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawNameMarketplaceAbi,
        functionName: 'acceptOffer',
        args: [BigInt(offer.offerId)],
        value: lzFee,
        chainId: chains.l1.chainId,
      })
    })
  }

  const handleDenyOffer = (offer: MarketplaceOffer) => {
    // Remove from local list immediately
    setOffers(prev => prev.filter(o => o.offerId !== offer.offerId))
    // Hide the associated notifications server-side
    apiFetch(`/api/marketplace/offers/${offer.id}/dismiss`, {
      method: 'POST',
    }).catch(err => console.warn('[ViewOffersModal] Failed to dismiss offer:', err))
  }

  const handleClose = () => {
    resetApprove()
    resetAction()
    setActionOfferId(null)
    setActionType(null)
    close()
  }

  if (!isOpen || tokenId === null) return null

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-[520px]" usePortal zIndex={9999}>
      <div className="p-6">
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
          Offers for @{username}
        </h2>

        {/* Username SVG */}
        <div className="flex justify-center my-4">
          <div className="w-full max-w-[180px]">
            <UsernameSvg username={username || ''} />
          </div>
        </div>

        {/* LZ fee info */}
        {lzFee > 0n && (
          <div className={`mb-3 text-xs ${themeTextMuted(isDark)}`}>
            Cross-chain sync fee: ~{parseFloat(formatEther(lzFee)).toFixed(5)} ETH (paid when accepting)
          </div>
        )}

        {/* Error display */}
        {(actionError || approveError) && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
            {(actionError || approveError)?.message?.includes('User rejected')
              ? 'Transaction rejected'
              : 'Transaction failed. Please try again.'}
          </div>
        )}

        {/* Offers list */}
        {loading ? (
          <div className={`text-center py-8 ${themeTextMuted(isDark)}`}>Loading offers...</div>
        ) : offers.length === 0 ? (
          <div className={`text-center py-8 ${themeTextMuted(isDark)}`}>No active offers</div>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {offers.map(offer => {
              const isActing = actionOfferId === offer.offerId && (isActionPending || isActionConfirming)

              return (
                <div
                  key={offer.offerId}
                  className={`p-4 rounded-xl ${themeBgSubtle(isDark)} border ${themeBorder(isDark)}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      {(() => {
                        const token = offer.paymentToken
                        const dec = DECIMALS[token] ?? 18
                        const num = parseFloat(dec === 18 ? formatEther(BigInt(offer.amount)) : formatUnits(BigInt(offer.amount), dec))
                        let rate = 0
                        if (token === 'USDC' || token === 'USDT') rate = 1
                        else if (token === 'ETH' || token === 'WETH') rate = ethPrice
                        else if (token === 'CAW') rate = cawPrice
                        const usd = rate > 0 ? num * rate : 0
                        const usdStr = usd > 0
                          ? usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : null
                        return (
                          <>
                            {usdStr && (
                              <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                {usdStr}
                              </div>
                            )}
                            <div className={`text-sm ${themeTextMuted(isDark)}`}>
                              {fmtPrice(offer.amount, offer.paymentToken)} {offer.paymentToken}
                            </div>
                          </>
                        )
                      })()}
                      <div className={`text-xs mt-1 ${themeTextMuted(isDark)}`}>
                        from {offer.offerer.slice(0, 6)}...{offer.offerer.slice(-4)}
                      </div>
                      <div className="mt-0.5">
                        <LiveCountdown endTime={offer.expiry} />
                      </div>
                    </div>

                    <div className="flex gap-2">
                      {/* Accept offer */}
                      <button
                        onClick={() => {
                          ensureWallet({ chainId: chains.l1.chainId }, async () => {
                            if (actionError) resetAction()
                            if (!isApproved) {
                              setPendingAcceptAfterApprove(offer)
                              setActionOfferId(offer.offerId)
                              setActionType('accept')
                              handleApproveNFT()
                              return
                            }
                            handleAcceptOffer(offer)
                          })
                        }}
                        disabled={isActing || isSwitchingChain || isApproving || isApproveConfirming}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50"
                      >
                        {!isConnected ? 'Connect'
                          : needsChainSwitch ? 'Switch Network'
                          : isApproving || isApproveConfirming ? 'Approving...'
                          : isActing && actionType === 'accept' ? 'Accepting...'
                          : 'Accept'}
                      </button>

                      {/* Deny — hides the offer notification server-side */}
                      <button
                        onClick={() => handleDenyOffer(offer)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </ModalWrapper>
  )
}

export default ViewOffersModal
