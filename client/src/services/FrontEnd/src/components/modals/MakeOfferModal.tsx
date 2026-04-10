import React, { useEffect, useMemo, useState } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract, useBalance } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther, formatUnits, parseEther, parseUnits, erc20Abi, maxUint256 } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { themeTextMuted, themeBgSubtle } from '~/utils/theme'
import { useMarketplaceStore } from '~/store/marketplaceStore'
import { usePriceStore, useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'
import { CAW_NAME_MARKETPLACE_ADDRESS, WETH_ADDRESS, CAW_ADDRESS, USDC_ADDRESS, USDT_ADDRESS } from '~/../../../abi/addresses'
import { cawNameMarketplaceAbi } from '~/../../../abi/generated'
import UsernameSvg from '~/components/UsernameSvg'

const PAYMENT_OPTIONS = [
  { value: '0x0000000000000000000000000000000000000000', label: 'ETH', decimals: 18 },
  { value: WETH_ADDRESS, label: 'WETH', decimals: 18 },
  { value: CAW_ADDRESS, label: 'CAW', decimals: 18 },
  { value: USDC_ADDRESS, label: 'USDC', decimals: 6 },
  { value: USDT_ADDRESS, label: 'USDT', decimals: 6 },
]

const DURATION_OPTIONS = [
  { label: '5 min', seconds: 300 },
  { label: '1 day', seconds: 86400 },
  { label: '3 days', seconds: 259200 },
  { label: '7 days', seconds: 604800 },
  { label: '14 days', seconds: 1209600 },
  { label: '30 days', seconds: 2592000 },
]

const MakeOfferModal: React.FC = () => {
  const { isDark } = useTheme()
  const isOpen = useMarketplaceStore(s => s.makeOfferModal.isOpen)
  const tokenId = useMarketplaceStore(s => s.makeOfferModal.tokenId)
  const username = useMarketplaceStore(s => s.makeOfferModal.username)
  const close = useMarketplaceStore(s => s.closeMakeOffer)
  const triggerRefresh = useMarketplaceStore(s => s.triggerRefresh)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const activeToken = useActiveToken()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  const [selectedToken, setSelectedToken] = useState(PAYMENT_OPTIONS[0])
  const [amount, setAmount] = useState('')
  const [duration, setDuration] = useState(DURATION_OPTIONS[2]) // default 7 days

  const isEth = selectedToken.value === '0x0000000000000000000000000000000000000000'
  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Parse amount to wei
  const amountWei = useMemo(() => {
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return 0n
    try {
      return selectedToken.decimals === 18
        ? parseEther(amount)
        : parseUnits(amount, selectedToken.decimals)
    } catch {
      return 0n
    }
  }, [amount, selectedToken])

  // Check balances
  const { data: ethBalance } = useBalance({
    address,
    chainId: chains.l1.chainId,
    query: { enabled: !!address && isEth },
  })
  const { data: tokenBalance } = useReadContract({
    address: selectedToken.value as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !isEth },
  })

  const userBalance = isEth ? (ethBalance?.value ?? 0n) : (tokenBalance ?? 0n)
  const insufficientBalance = isConnected && amountWei > 0n && amountWei > userBalance

  // Check ERC20 allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: selectedToken.value as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !isEth },
  })

  // Approve hook
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  // Offer hook
  const { writeContract: writeOffer, data: offerHash, isPending: isSubmitting, error: writeError, reset: resetOffer } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: offerHash })
  // Track that we've submitted — covers the gap between wallet confirm and receipt polling
  const isWaitingForReceipt = !!offerHash && !isSuccess && !writeError

  useEffect(() => {
    if (isApproveSuccess) refetchAllowance()
  }, [isApproveSuccess])

  // Notify the username owner when offer tx confirms
  useEffect(() => {
    if (!isSuccess || !offerHash) return
    triggerRefresh()
    // Send authenticated notification with the active tokenId
    if (activeToken?.tokenId) {
      apiFetch('/api/marketplace/offers/notify', {
        method: 'POST',
        body: JSON.stringify({ senderTokenId: activeToken.tokenId, txHash: offerHash }),
      }).catch(err => console.warn('[MakeOfferModal] Failed to send offer notification:', err))
    }
  }, [isSuccess])

  const needsApproval = !isEth && amountWei > 0n && (!allowance || allowance < amountWei)
  const hasApproval = isEth || (allowance && allowance >= amountWei) || isApproveSuccess

  const usdDisplay = useMemo(() => {
    if (!amount || parseFloat(amount) <= 0) return null
    const num = parseFloat(amount)
    let rate = 0
    if (selectedToken.label === 'ETH' || selectedToken.label === 'WETH') rate = ethPrice
    else if (selectedToken.label === 'CAW') rate = cawPrice
    else if (selectedToken.label === 'USDC' || selectedToken.label === 'USDT') return `~$${num.toFixed(2)}`
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [amount, selectedToken, ethPrice, cawPrice])

  const handleApprove = () => {
    if (!isConnected) { openConnectModal?.(); return }
    if (needsChainSwitch) { switchChain({ chainId: chains.l1.chainId }); return }

    writeApprove({
      address: selectedToken.value as `0x${string}`,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CAW_NAME_MARKETPLACE_ADDRESS, maxUint256],
      chainId: chains.l1.chainId,
    })
  }

  const handleSubmitOffer = () => {
    if (!isConnected) { openConnectModal?.(); return }
    if (needsChainSwitch) { switchChain({ chainId: chains.l1.chainId }); return }
    if (tokenId === null || amountWei === 0n) return

    if (isEth) {
      writeOffer({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawNameMarketplaceAbi,
        functionName: 'createOfferETH',
        args: [tokenId, BigInt(duration.seconds)],
        value: amountWei,
        chainId: chains.l1.chainId,
      })
    } else {
      writeOffer({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawNameMarketplaceAbi,
        functionName: 'createOfferERC20',
        args: [tokenId, selectedToken.value as `0x${string}`, amountWei, BigInt(duration.seconds)],
        chainId: chains.l1.chainId,
      })
    }
  }

  const handleClose = () => {
    resetApprove()
    resetOffer()
    setAmount('')
    setSelectedToken(PAYMENT_OPTIONS[0])
    setDuration(DURATION_OPTIONS[2])
    close()
  }

  if (!isOpen || tokenId === null) return null

  const fmtBalance = (bal: bigint, dec: number) => {
    const num = parseFloat(dec === 18 ? formatEther(bal) : formatUnits(bal, dec))
    if (dec <= 6) return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (selectedToken.label === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
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
            <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>Offer Submitted!</h2>
            <p className={`text-sm mb-6 ${themeTextMuted(isDark)}`}>
              Your offer of {amount} {selectedToken.label} for <span className="font-semibold">@{username}</span> has been submitted.
              The owner will be notified.
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
              Make an Offer
            </h2>
            <p className={`text-sm text-center mb-4 ${themeTextMuted(isDark)}`}>
              Offer to buy this username.<br />Funds are escrowed until accepted or cancelled.
            </p>

            {/* Username SVG */}
            <div className="flex justify-center mb-4">
              <div className="w-full max-w-[210px]">
                <UsernameSvg username={username || ''} />
              </div>
            </div>

            {/* Duration selector */}
            <div className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                Offer Duration
              </label>
              <div className="flex gap-2 flex-wrap">
                {DURATION_OPTIONS.map(opt => (
                  <button
                    key={opt.seconds}
                    onClick={() => setDuration(opt)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition cursor-pointer ${
                      duration.seconds === opt.seconds
                        ? 'bg-yellow-500 text-black'
                        : isDark
                          ? 'bg-white/10 text-white hover:bg-white/20'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Payment token selector */}
            <div className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                Payment Token
              </label>
              <div className="flex gap-2 flex-wrap">
                {PAYMENT_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => { setSelectedToken(opt); resetApprove(); resetOffer() }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition cursor-pointer ${
                      selectedToken.value === opt.value
                        ? 'bg-yellow-500 text-black'
                        : isDark
                          ? 'bg-white/10 text-white hover:bg-white/20'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount input */}
            <div className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                Offer Amount
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.0"
                  className={`w-full px-4 py-3 pr-16 rounded-xl text-base transition ${
                    isDark
                      ? 'bg-white/5 border border-white/10 text-white placeholder-white/30 focus:border-yellow-500/50'
                      : 'bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:border-yellow-500'
                  } focus:outline-none`}
                />
                <span className={`absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium ${themeTextMuted(isDark)}`}>
                  {selectedToken.label}
                </span>
              </div>
              {usdDisplay && (
                <p className={`text-xs mt-1 ${themeTextMuted(isDark)}`}>{usdDisplay}</p>
              )}
            </div>

            {/* Balance info */}
            {isConnected && (
              <div className={`p-3 rounded-xl ${themeBgSubtle(isDark)} text-sm mb-4`}>
                <div className="flex justify-between">
                  <span className={themeTextMuted(isDark)}>Your Balance</span>
                  <span className={insufficientBalance ? (isDark ? 'text-red-400' : 'text-red-500') : (isDark ? 'text-white' : 'text-gray-900')}>
                    {fmtBalance(userBalance, selectedToken.decimals)} {selectedToken.label}
                  </span>
                </div>
              </div>
            )}

            {insufficientBalance && (
              <div className={`text-xs mb-4 p-3 rounded-lg text-center ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-500'}`}>
                Insufficient balance.
              </div>
            )}

            {/* Errors */}
            {(approveError || writeError) && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
                {(approveError || writeError)?.message?.includes('User rejected')
                  ? 'Transaction rejected'
                  : 'Transaction failed. Please try again.'}
              </div>
            )}

            {/* Approve button (ERC20 only) */}
            {needsApproval && !hasApproval && (
              <button
                onClick={() => { if (approveError) resetApprove(); handleApprove() }}
                disabled={isApproving || isApproveConfirming || isSwitchingChain}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mb-2"
              >
                {!isConnected ? 'Connect Wallet'
                  : needsChainSwitch ? (isSwitchingChain ? 'Switching...' : 'Switch Network')
                  : isApproving ? 'Confirm in wallet...'
                  : isApproveConfirming ? 'Approving...'
                  : `Approve ${selectedToken.label}`}
              </button>
            )}

            {/* Submit offer button */}
            {(isEth || hasApproval) && (
              <button
                onClick={() => { if (writeError) resetOffer(); handleSubmitOffer() }}
                disabled={isSubmitting || isWaitingForReceipt || isSwitchingChain || insufficientBalance || amountWei === 0n}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
              >
                {!isConnected ? 'Connect Wallet'
                  : needsChainSwitch ? (isSwitchingChain ? 'Switching...' : 'Switch Network')
                  : isSubmitting ? 'Confirm in wallet...'
                  : isWaitingForReceipt ? 'Submitting offer...'
                  : 'Submit Offer'}
              </button>
            )}
          </>
        )}
      </div>
    </ModalWrapper>
  )
}

export default MakeOfferModal
