import React, { useEffect, useMemo, useState } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract, useBalance } from 'wagmi'
import { readContract } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther, formatUnits, erc20Abi, maxUint256 } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeBorder } from '~/utils/theme'
import { useMarketplaceStore } from '~/store/marketplaceStore'
import { usePriceStore, refetchTokenDataUntilChanged } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import UsernameSvg from '~/components/UsernameSvg'
import { apiFetch } from '~/api/client'
import { formatNumberCompact } from '~/utils'
import { CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { useT } from '~/i18n/I18nProvider'

const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6 }

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

type UserStats = { followerCount: number; cawCount: number; likeCount: number }

const BuyModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const isOpen = useMarketplaceStore(s => s.buyModal.isOpen)
  const listing = useMarketplaceStore(s => s.buyModal.listing)
  const close = useMarketplaceStore(s => s.closeBuyModal)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const [stats, setStats] = useState<UserStats | null>(null)

  useEffect(() => {
    if (!listing?.username) { setStats(null); return }
    apiFetch<UserStats>(`/api/users/${listing.username}`)
      .then(setStats)
      .catch(() => {})
  }, [listing?.username])
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  // Approve hook (for ERC20 tokens)
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  // Buy hook
  const { writeContract: writeBuy, data: buyHash, isPending: isSubmitting, error: writeError, reset: resetBuy } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: buyHash })

  const isEth = listing?.paymentAddress === '0x0000000000000000000000000000000000000000'
  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1
  const isExpired = !!listing?.endTime && new Date(listing.endTime).getTime() <= Date.now()

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

  // Optimistically mark listing as sold and refresh token data when buy tx confirms
  useEffect(() => {
    if (!isSuccess || !listing || !buyHash || !address) return
    apiFetch(`/api/marketplace/listings/${listing.id}/sold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: buyHash, buyer: address }),
    }).catch(err => console.warn('[BuyModal] Failed to mark as sold:', err))

    // Backoff-poll until the token list actually shows the change. The
    // server endpoint above only writes status — User.address is set by
    // MarketplaceIndexerService on the next L2 poll. A one-shot refetch
    // would lose that race; this keeps trying until the chooser sees
    // the new ownership (or budget runs out).
    //
    // Once the token-data change lands, also refresh the wallet
    // session so requireAuth({ verifyOwnership }) accepts the
    // newly-owned tokenId. Without this, posting/liking/recawing as
    // the new owner gets 403 TOKEN_OWNER_CHANGED until the user
    // signs back in (bug #135). /api/auth/refresh re-reads the DB's
    // address→tokenId mapping and adds the new tokenId to the
    // session's authorizedTokenIds without requiring a fresh sig.
    refetchTokenDataUntilChanged().then(() => {
      apiFetch('/api/auth/refresh', { method: 'POST' })
        .catch(err => console.warn('[BuyModal] auth refresh failed:', err))
    })
  }, [isSuccess])

  // Quote LZ fee for L2 sync (pass tokenId + buyer to simulate the pending transfer)
  const [lzFee, setLzFee] = useState(0n)
  useEffect(() => {
    if (!listing || !address) return
    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawProfileQuoterAbi,
      functionName: 'syncTransferQuote',
      // Phase 1: signature gained `lzDestId` as 3rd arg. Marketplace ops
      // run through the bypassLZ same-chain ledger — quote against the
      // L1 LayerZero eid to match the marketplace's immutable lzDestId.
      args: [listing.tokenId, address, chains.l1.layerZero, false],
      chainId: chains.l1.chainId,
    }).then((quote: any) => {
      const fee = (quote.nativeFee * 120n) / 100n
      console.log('[BuyModal] LZ fee:', fee.toString())
      setLzFee(fee)
    }).catch(err => console.warn('[BuyModal] LZ fee quote failed:', err))
  }, [listing?.listingId, address])

  // Current price for Dutch auctions
  const currentPrice = useMemo(() => {
    if (!listing) return '0'
    if (listing.listingType === 'DUTCH_AUCTION' && listing.endTime && listing.endPrice) {
      const now = Date.now()
      const start = new Date(listing.startTime).getTime()
      const end = new Date(listing.endTime).getTime()
      const elapsed = now - start
      const duration = end - start
      if (elapsed >= duration) return listing.endPrice
      const startP = BigInt(listing.startPrice)
      const endP = BigInt(listing.endPrice)
      return (startP - ((startP - endP) * BigInt(Math.floor(elapsed)) / BigInt(Math.floor(duration)))).toString()
    }
    return listing.startPrice
  }, [listing])

  // Debug logging
  React.useEffect(() => {
    if (listing && address) {
      console.log('[BuyModal] Balance check:', {
        isEth,
        currentPrice,
        userBalance: userBalance.toString(),
        insufficientBalance: BigInt(currentPrice) > userBalance,
        paymentToken: listing.paymentToken,
        chainId: chains.l1.chainId,
        connectedChainId: chainId
      })
    }
  }, [listing, address, currentPrice, userBalance, chainId])

  const insufficientBalance = isConnected && listing ? BigInt(currentPrice) > userBalance : false
  const needsApproval = !isEth && listing && (!allowance || allowance < BigInt(currentPrice))
  const hasApproval = isEth || (allowance && allowance >= BigInt(currentPrice)) || isApproveSuccess

  const usdDisplay = useMemo(() => {
    if (!listing) return null
    const token = listing.paymentToken
    if (token === 'USDC' || token === 'USDT') return null
    const num = parsePriceNum(currentPrice, token)
    let rate = 0
    if (token === 'ETH' || token === 'WETH') rate = ethPrice
    else if (token === 'CAW') rate = cawPrice
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [currentPrice, listing?.paymentToken, ethPrice, cawPrice])

  const balanceUsdDisplay = useMemo(() => {
    if (!isConnected || !listing || userBalance === 0n) return null
    const token = listing.paymentToken
    if (token === 'USDC' || token === 'USDT') return null
    const num = parsePriceNum(userBalance.toString(), token)
    let rate = 0
    if (token === 'ETH' || token === 'WETH') rate = ethPrice
    else if (token === 'CAW') rate = cawPrice
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [userBalance, listing?.paymentToken, ethPrice, cawPrice, isConnected])

  const handleClose = () => {
    resetApprove()
    resetBuy()
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

  const handleBuy = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (!listing) return

      if (isEth) {
        writeBuy({
          address: CAW_NAME_MARKETPLACE_ADDRESS,
          abi: cawProfileMarketplaceAbi,
          functionName: 'buy',
          args: [BigInt(listing.listingId)],
          value: BigInt(currentPrice) + lzFee,
          chainId: chains.l1.chainId,
        })
      } else {
        writeBuy({
          address: CAW_NAME_MARKETPLACE_ADDRESS,
          abi: cawProfileMarketplaceAbi,
          functionName: 'buyWithToken',
          args: [BigInt(listing.listingId), BigInt(currentPrice)],
          value: lzFee,
          chainId: chains.l1.chainId,
        })
      }
    })
  }

  if (!listing) return null

  const priceDisplay = fmtPrice(currentPrice, listing.paymentToken)

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
            <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>Purchase Complete!</h2>
            <p className={`text-sm mb-6 ${themeTextMuted(isDark)}`}>
              You now own <span className="font-semibold">@{listing.username}</span>.
            </p>
            <button
              onClick={handleClose}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              Done
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
              {listing.listingType === 'DUTCH_AUCTION' ? t('create_listing.type.dutch.label') : t('create_listing.type.fixed.label')}
            </h2>
            <p className={`text-sm text-center mb-3 ${themeTextMuted(isDark)}`}>
              {listing.listingType === 'DUTCH_AUCTION' ? t('create_listing.type.dutch.desc') : t('buy_modal.fixed_desc')}
            </p>

            {/* Username SVG */}
            <div className="flex justify-center mb-3">
              <div className="w-full max-w-[210px]">
                <UsernameSvg username={listing.username} />
              </div>
            </div>

            {/* Stats row */}
            <div className={`grid grid-cols-4 gap-2 mb-4 py-3 border-t border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
              <div className="text-center">
                <div className={`text-base font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {stats ? formatNumberCompact(stats.followerCount) : '—'}
                </div>
                <div className={`text-xs ${themeTextMuted(isDark)}`}>{t('profile.stats.followers')}</div>
              </div>
              <div className="text-center">
                <div className={`text-base font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {stats ? formatNumberCompact(stats.cawCount) : '—'}
                </div>
                <div className={`text-xs ${themeTextMuted(isDark)}`}>{t('profile.stats.posts')}</div>
              </div>
              <div className="text-center">
                <div className={`text-base font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {stats ? formatNumberCompact(stats.likeCount) : '—'}
                </div>
                <div className={`text-xs ${themeTextMuted(isDark)}`}>{t('profile.tab.likes')}</div>
              </div>
              <div className="text-center">
                <div className={`text-base font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {listing.stakedCaw ? fmtPrice(listing.stakedCaw, 'CAW') : '0'}
                </div>
                <div className={`text-xs ${themeTextMuted(isDark)}`}>CAW</div>
              </div>
            </div>

            {/* Price + Balance */}
            <div className={`p-4 rounded-xl ${themeBgSubtle(isDark)} space-y-2 text-sm mb-4`}>
              <div className="flex justify-between">
                <span className={themeTextMuted(isDark)}>{t('create_listing.price')}</span>
                <div className="text-right">
                  <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {priceDisplay} {listing.paymentToken}
                  </span>
                  {usdDisplay && (
                    <div className={`text-xs ${themeTextMuted(isDark)}`}>{usdDisplay}</div>
                  )}
                </div>
              </div>
              <div className="flex justify-between">
                <span className={themeTextMuted(isDark)}>{t('buy_modal.marketplace_fee')}</span>
                <span className={isDark ? 'text-green-400' : 'text-green-600'}>0%</span>
              </div>
              {lzFee > 0n && (
                <div className="flex justify-between">
                  <span className={themeTextMuted(isDark)}>{t('buy_modal.cross_chain_fee')}</span>
                  <span className={themeTextSecondary(isDark)}>
                    ~{parseFloat(formatEther(lzFee)).toFixed(5)} ETH
                  </span>
                </div>
              )}
              {isConnected && (
                <div className={`flex justify-between pt-2 border-t ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                  <span className={themeTextMuted(isDark)}>{t('buy_modal.your_balance')}</span>
                  <div className="text-right">
                    <span className={`${insufficientBalance ? (isDark ? 'text-red-400' : 'text-red-500') : (isDark ? 'text-white' : 'text-gray-900')}`}>
                      {fmtPrice(userBalance.toString(), listing.paymentToken)} {listing.paymentToken}
                    </span>
                    {balanceUsdDisplay && (
                      <div className={`text-xs ${themeTextMuted(isDark)}`}>{balanceUsdDisplay}</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {insufficientBalance && (
              <div className={`text-xs mb-4 p-3 rounded-lg text-center ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-500'}`}>
                {t('buy_modal.insufficient_balance')}
              </div>
            )}

            {/* Staked CAW warning */}
            {listing.stakedCaw && listing.stakedCaw !== '0' && (
              <div className={`text-xs mb-4 p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                {t('buy_modal.staked_warning', { amount: fmtPrice(listing.stakedCaw, 'CAW') })}
              </div>
            )}

            {/* Buy more link for ERC20 */}
            {!isEth && (
              <p className={`text-xs text-center mb-4 ${themeTextMuted(isDark)}`}>
                {t('buy_modal.need_more', { token: listing.paymentToken })}{' '}
                <a
                  href={`https://app.uniswap.org/swap?outputCurrency=${listing.paymentAddress}&chain=sepolia`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-500'}
                  onClick={e => e.stopPropagation()}
                >
                  {t('buy_modal.buy_on_uniswap')}
                </a>
              </p>
            )}

            {/* Errors */}
            {(approveError || writeError) && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
                {(approveError || writeError)?.message?.includes('User rejected')
                  ? t('profile.error.tx_rejected')
                  : t('marketplace.error.tx_failed')}
              </div>
            )}

            {/* Approve button (ERC20 only) */}
            {needsApproval && !hasApproval && !isExpired && (
              <button
                onClick={() => { if (approveError) resetApprove(); handleApprove() }}
                disabled={isApproving || isApproveConfirming || isSwitchingChain}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {needsChainSwitch ? (isSwitchingChain ? t('staking.button.switching') : t('marketplace.button.switch_network'))
                  : isApproving ? t('marketplace.button.confirm_in_wallet')
                  : isApproveConfirming ? t('staking.button.approving')
                  : t('buy_modal.button.approve_token', { token: listing.paymentToken })}
              </button>
            )}

            {/* Ended fallback (no approve, no buy) */}
            {needsApproval && !hasApproval && isExpired && (
              <button
                disabled
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black opacity-50 cursor-not-allowed"
              >
                {t('buy_modal.button.ended')}
              </button>
            )}

            {/* Buy button */}
            {(isEth || hasApproval) && !isSuccess && (
              <button
                onClick={() => { if (writeError) resetBuy(); handleBuy() }}
                disabled={isExpired || isSubmitting || isConfirming || isSwitchingChain || insufficientBalance}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
              >
                {isExpired ? t('buy_modal.button.ended')
                  : needsChainSwitch ? (isSwitchingChain ? t('staking.button.switching') : t('marketplace.button.switch_network'))
                  : isSubmitting ? t('marketplace.button.confirm_in_wallet')
                  : isConfirming ? t('marketplace.button.confirming')
                  : t('buy_modal.button.buy_for', { price: priceDisplay, token: listing.paymentToken })}
              </button>
            )}
          </>
        )}
      </div>
    </ModalWrapper>
  )
}

export default BuyModal
