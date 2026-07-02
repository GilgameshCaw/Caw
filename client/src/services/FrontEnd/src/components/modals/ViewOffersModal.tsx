import React, { useCallback, useEffect, useState } from 'react'
import { Link } from '~/utils/localizedRouter'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract, usePublicClient } from 'wagmi'
import { readContract } from '@wagmi/core'
import { useConnectModalBridge as useConnectModal } from '~/hooks/useConnectModalBridge'
import { formatEther, formatUnits, erc20Abi, encodeFunctionData, type Address } from 'viem'
import { formatAddress } from '~/utils'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { themeTextMuted, themeBgSubtle, themeBorder } from '~/utils/theme'
import { useMarketplaceStore, MarketplaceOffer } from '~/store/marketplaceStore'
import { usePriceStore, useTokenDataStore, refetchTokenDataUntilChanged } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi, cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import UsernameSvg from '~/components/UsernameSvg'
import LiveCountdown from '~/components/marketplace/LiveCountdown'
import { apiFetch } from '~/api/client'
import { wagmiConfig } from '~/config/Web3Provider'
import { useOffersUnreadStore } from '~/store/offersUnreadStore'

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
  const t = useT()
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

  // Pop-B (passkey) relay path
  const { population } = useWalletPopulation()
  const isPopB = population === 'B'
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })
  const [popBPendingOfferId, setPopBPendingOfferId] = useState<number | null>(null)
  const [popBOfferError, setPopBOfferError] = useState<string | null>(null)

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
    abi: cawProfileAbi,
    functionName: 'ownerOf',
    args: [BigInt(tokenId ?? 0)],
    chainId: chains.l1.chainId,
    query: { enabled: !!tokenId && !ownsTokenLocally },
  })
  const isOwner = (isConnected || isPopB) && (
    ownsTokenLocally ||
    (address && tokenOwner && address.toLowerCase() === (tokenOwner as string).toLowerCase()) ||
    (isPopB && eoaAccount && tokenOwner && eoaAccount.toLowerCase() === (tokenOwner as string).toLowerCase())
  )

  // Check NFT approval for accepting offers
  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
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
        abi: cawProfileMarketplaceAbi,
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

  // Quote LZ fee when owner is viewing. For Pop-B the effective owner address
  // is the EOA (eoaAccount), not the wagmi address (which is undefined for Pop-B).
  const effectiveOwnerAddress = isPopB ? eoaAccount : address
  useEffect(() => {
    if (!isOwner || !tokenId || !effectiveOwnerAddress) return
    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawProfileQuoterAbi,
      functionName: 'syncTransferQuote',
      // Phase 1: signature gained `lzDestId` as 3rd arg. Marketplace ops
      // run through the bypassLZ same-chain ledger — quote against the
      // L1 LayerZero eid to match the marketplace's immutable lzDestId.
      args: [tokenId, effectiveOwnerAddress, chains.l1.layerZero, false],
      chainId: chains.l1.chainId,
    }).then((quote: any) => {
      setLzFee((quote.nativeFee * 120n) / 100n)
    }).catch(() => {})
  }, [isOwner, tokenId, effectiveOwnerAddress])

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
      // Optimistic badge decrement — accepting deactivates this offer
      // server-side, but useBadgeSync's 30s poll means the badge would
      // otherwise lag the action. The next poll re-asserts the
      // authoritative count, so any divergence self-heals.
      useOffersUnreadStore.getState().optimisticDecrement()
      // Backoff-poll for the chooser to reflect the new ownership.
      // Server only flips offer status here; User.address is updated
      // by MarketplaceIndexerService on the next L2 poll.
      refetchTokenDataUntilChanged()
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

  // Pop-B relay path: [setApprovalForAll?] + acceptOffer + fee leg.
  // The LZ fee (value=lzFee) self-funds from the EOA; relayer fronts only gas.
  const handlePopBAcceptOffer = useCallback(async (offer: MarketplaceOffer) => {
    if (!isPopB || !eoaAccount || !l1Client) return
    setPopBOfferError(null)
    setPopBPendingOfferId(offer.offerId)
    try {
      const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
        `/api/sponsor/execute-quote?forwardedValueWei=0`,
      )
      const feeCaw = quote.priceAvailable ? BigInt(quote.minFeeCawWei) : null
      const feeEth = BigInt(quote.minFeeEthWei)

      const [cawBalNow, ethBalNow, alreadyApproved] = await Promise.all([
        l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
        l1Client.getBalance({ address: eoaAccount as Address }),
        l1Client.readContract({ address: CAW_NAMES_ADDRESS, abi: cawProfileAbi, functionName: 'isApprovedForAll', args: [eoaAccount as Address, CAW_NAME_MARKETPLACE_ADDRESS] }) as Promise<boolean>,
      ])

      const payInCaw = feeCaw != null && cawBalNow >= feeCaw
      // acceptOffer's lzFee is self-funded in ETH from the EOA. When repaying gas in
      // ETH too, the EOA must cover lzFee + feeEth; when repaying in CAW, just lzFee.
      const payInEth = ethBalNow >= (payInCaw ? lzFee : lzFee + feeEth)
      if (!payInCaw && !payInEth) throw new Error('INSUFFICIENT_FEE_CAW')

      const calls: ExecCall[] = []
      if (!alreadyApproved) {
        calls.push({
          to: CAW_NAMES_ADDRESS,
          value: 0n,
          data: encodeFunctionData({ abi: cawProfileAbi, functionName: 'setApprovalForAll', args: [CAW_NAME_MARKETPLACE_ADDRESS, true] }),
        })
      }
      calls.push({
        to: CAW_NAME_MARKETPLACE_ADDRESS,
        value: lzFee, // self-funded LZ fee the seller pays
        data: encodeFunctionData({ abi: cawProfileMarketplaceAbi, functionName: 'acceptOffer', args: [BigInt(offer.offerId)] }),
      })
      if (payInCaw) {
        calls.push({
          to: CAW_ADDRESS as Address, value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [quote.relayer as Address, feeCaw!] }),
        })
      } else {
        calls.push({ to: quote.relayer as Address, value: feeEth, data: '0x' })
      }

      const relayTxHash = await smartEoaExecute(calls)
      // Mirror the wagmi success handler.
      apiFetch(`/api/marketplace/offers/${offer.offerId}/accepted`, {
        method: 'POST',
        body: JSON.stringify({ txHash: relayTxHash, buyer: offer.offerer }),
      }).catch(() => {})
      useOffersUnreadStore.getState().optimisticDecrement()
      refetchTokenDataUntilChanged()
      setOffers(prev => prev.filter(o => o.offerId !== offer.offerId))
      triggerRefresh()
    } catch (err: any) {
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      let friendly: string
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) friendly = t('view_offers.tx_rejected')
      else if (/SIMULATION_FAILED|INSUFFICIENT_FEE_CAW|insufficient|FEE_TOO_LOW|transfer amount exceeds/i.test(raw)) friendly = t('view_offers.popb_insufficient_fee')
      else if (/RELAY_UNCONFIGURED|LOOKUP_UNAVAILABLE|temporarily/i.test(raw)) friendly = t('view_offers.popb_relay_unavailable')
      else friendly = t('view_offers.tx_failed')
      setPopBOfferError(friendly)
    } finally {
      setPopBPendingOfferId(null)
    }
  }, [isPopB, eoaAccount, l1Client, lzFee, smartEoaExecute, triggerRefresh, t])

  const handleApproveNFT = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeApprove({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
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
        abi: cawProfileMarketplaceAbi,
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
    // Optimistic badge decrement — dismissal subtracts from the count
    // server-side too, but the badge poll runs every 30s. Same self-
    // healing pattern as the accept-success branch.
    useOffersUnreadStore.getState().optimisticDecrement()
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
    setPopBOfferError(null)
    setPopBPendingOfferId(null)
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
          {t('view_offers.title', { username: username || '' })}
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
            {t('view_offers.lz_fee', { eth: parseFloat(formatEther(lzFee)).toFixed(5) })}
          </div>
        )}

        {/* Error display */}
        {(actionError || approveError || popBOfferError) && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
            {popBOfferError
              ? popBOfferError
              : (actionError || approveError)?.message?.includes('User rejected')
                ? t('view_offers.tx_rejected')
                : t('view_offers.tx_failed')}
          </div>
        )}

        {/* Offers list */}
        {loading ? (
          <div className={`text-center py-8 ${themeTextMuted(isDark)}`}>{t('view_offers.loading')}</div>
        ) : offers.length === 0 ? (
          <div className={`text-center py-8 ${themeTextMuted(isDark)}`}>{t('view_offers.no_active')}</div>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {offers.map(offer => {
              const isActing = actionOfferId === offer.offerId && (isActionPending || isActionConfirming)

              const isPopBActing = isPopB && popBPendingOfferId === offer.offerId

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
                        {t('view_offers.from')}{' '}
                        <Link
                          to={`/address/${offer.offerer.toLowerCase()}`}
                          onClick={e => e.stopPropagation()}
                          className={`hover:underline ${isDark ? 'hover:text-yellow-400' : 'hover:text-yellow-500'}`}
                        >
                          {formatAddress(offer.offerer)}
                        </Link>
                      </div>
                      <div className="mt-0.5">
                        <LiveCountdown endTime={offer.expiry} />
                      </div>
                    </div>

                    <div className="flex gap-2">
                      {/* Accept offer */}
                      <button
                        onClick={() => {
                          if (isPopB) {
                            setPopBOfferError(null)
                            handlePopBAcceptOffer(offer)
                            return
                          }
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
                        disabled={isActing || isSwitchingChain || isApproving || isApproveConfirming || isPopBActing}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50"
                      >
                        {isPopBActing ? t('view_offers.btn.accepting')
                          : !isConnected && !isPopB ? t('view_offers.btn.connect')
                          : needsChainSwitch ? t('view_offers.btn.switch_network')
                          : isApproving || isApproveConfirming ? t('view_offers.btn.approving')
                          : isActing && actionType === 'accept' ? t('view_offers.btn.accepting')
                          : t('view_offers.btn.accept')}
                      </button>

                      {/* Deny — hides the offer notification server-side */}
                      <button
                        onClick={() => handleDenyOffer(offer)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                      >
                        {t('view_offers.btn.deny')}
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
