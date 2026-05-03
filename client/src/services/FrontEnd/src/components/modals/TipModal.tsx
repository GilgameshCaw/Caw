import React, { useState, useEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeTextMuted, themeBorder } from '~/utils/theme'
import { useSignAndSubmitAction, getValidatorTip } from '~/api/actions'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import InsufficientStakeModal from './InsufficientStakeModal'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import Tooltip from '~/components/Tooltip'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'

const PRESET_USD_AMOUNTS = [0.01, 0.10, 1.00, 5.00]
const MIN_TIP_AMOUNT = 1

const formatUsd = (n: number): string =>
  n < 1 ? `$${n.toFixed(2)}` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

const formatCompactCaw = (n: number): string => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toFixed(0)
}

const usdToCaw = (usd: number, cawPrice: number): number => {
  if (!cawPrice || cawPrice <= 0) return 0
  return Math.max(1, Math.round(usd / cawPrice))
}

interface TipModalProps {
  isOpen: boolean
  recipientTokenId: number
  recipientUsername: string
  cawUserId?: number
  cawCawonce?: number
  onClose: () => void
  onTipSubmitted?: () => void
}

type TipState = 'idle' | 'signing' | 'submitted'

const TipModal: React.FC<TipModalProps> = ({
  isOpen,
  recipientTokenId,
  recipientUsername,
  cawUserId,
  cawCawonce,
  onClose,
  onTipSubmitted
}) => {
  const { isDark } = useTheme()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const priceReady = cawPrice > 0
  const [usdInput, setUsdInput] = useState(PRESET_USD_AMOUNTS[0].toString())
  const [tipState, setTipState] = useState<TipState>('idle')
  const [error, setError] = useState<string | null>(null)

  const signAndSubmit = useSignAndSubmitAction()
  const activeToken = useActiveToken()
  const activeTokenId = activeToken?.tokenId
  const { isConnected, address } = useAccount()
  const { openConnectModal } = useConnectModal()
  const hasActiveSession = useHasActiveSession()
  const wrongWallet = isConnected && !hasActiveSession && activeToken?.owner && address
    ? activeToken.owner.toLowerCase() !== address.toLowerCase()
    : false
  const [showInsufficientStake, setShowInsufficientStake] = useState(false)

  // Reset to fresh state when modal opens (unless tip is still pending)
  useEffect(() => {
    if (isOpen && tipState !== 'signing') {
      setUsdInput(PRESET_USD_AMOUNTS[0].toString())
      setTipState('idle')
      setError(null)
    }
  }, [isOpen])

  const usdAmount = parseFloat(usdInput) || 0
  const tipAmount = usdToCaw(usdAmount, cawPrice)
  const validatorTip = getValidatorTip()
  const totalCost = BigInt(tipAmount + Number(validatorTip)) * 10n**18n
  const isValid = priceReady && usdAmount > 0 && tipAmount >= MIN_TIP_AMOUNT

  const handleSubmit = async () => {
    if (!isValid) return

    if (!isConnected && !hasActiveSession) {
      openConnectModal?.()
      return
    }

    if (!activeTokenId) {
      setError('No active token selected')
      return
    }

    // Check if user has enough staked CAW to cover tip + validator fee
    const stakedAmount = activeToken?.stakedAmount ?? 0n
    if (stakedAmount < totalCost) {
      setShowInsufficientStake(true)
      return
    }

    setError(null)
    setTipState('signing')

    try {
      // Build the tip text: "tip:userId:cawonce" for post tips, "tip:" for profile tips
      const tipText = cawUserId != null && cawCawonce != null
        ? `tip:${cawUserId}:${cawCawonce}`
        : 'tip:'

      await signAndSubmit({
        actionType: 'other',
        senderId: activeTokenId,
        receiverId: recipientTokenId,
        receiverCawonce: cawCawonce ?? 0,
        recipients: [recipientTokenId],
        amounts: [BigInt(tipAmount), validatorTip],
        text: tipText
      })

      setTipState('submitted')
      onTipSubmitted?.()

      // Auto-close after 2 seconds
      setTimeout(() => {
        onClose()
      }, 2000)
    } catch (err: any) {
      console.error('Tip failed:', err)
      setTipState('idle')
      if (err.message?.includes('rejected') || err.message?.includes('denied')) {
        setError('Transaction rejected')
      } else {
        setError(err.message?.split('\n')[0]?.slice(0, 100) || 'Failed to send tip')
      }
    }
  }

  return (
    <>
      <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-sm">
        <ModalHeader title={`Tip @${recipientUsername}`} onClose={onClose} />

        {/* Content */}
        <div className="p-4 space-y-4">
          {tipState === 'submitted' ? (
            <div className="flex flex-col items-center py-6 space-y-3">
              <div className="relative w-12 h-12">
                <div className="w-12 h-12 border-3 border-gray-400 border-t-yellow-500 rounded-full animate-spin"></div>
                <svg className="absolute inset-0 w-6 h-6 m-auto text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className={`text-sm ${themeTextSecondary(isDark)}`}>
                Tip of {formatCompactCaw(tipAmount)} CAW submitted!
              </p>
            </div>
          ) : (
            <>
              {/* Preset amounts */}
              <div>
                <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                  Select amount (USD)
                </label>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {PRESET_USD_AMOUNTS.map(preset => (
                    <button
                      key={preset}
                      onClick={() => { setUsdInput(preset.toString()); setError(null) }}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${
                        usdAmount === preset
                          ? 'bg-yellow-500 text-black'
                          : isDark
                            ? 'bg-white/10 text-white hover:bg-white/20'
                            : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                      }`}
                    >
                      {formatUsd(preset)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom amount */}
              <div>
                <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                  Amount (USD)
                </label>
                <div className="relative mt-1">
                  <span className={`absolute left-3 top-1/2 -translate-y-1/2 text-sm ${themeTextMuted(isDark)}`}>$</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={usdInput}
                    onChange={e => {
                      setUsdInput(e.target.value)
                      setError(null)
                    }}
                    placeholder="0.00"
                    className={`w-full pl-7 pr-3 py-2 rounded-lg text-sm outline-none transition-colors ${
                      isDark
                        ? 'bg-white/10 text-white border border-white/20 focus:border-yellow-500/50 placeholder-gray-500'
                        : 'bg-gray-100 text-gray-900 border border-gray-200 focus:border-yellow-500 placeholder-gray-400'
                    }`}
                  />
                </div>
              </div>

              {/* Cost summary */}
              <div className={`text-xs space-y-1 ${themeTextMuted(isDark)}`}>
                <div className="flex justify-between">
                  <span>Tip amount</span>
                  <span>{isValid ? tipAmount.toLocaleString() : '—'} CAW</span>
                </div>
                <div className="flex justify-between">
                  <span>Validator fee</span>
                  <span>{validatorTip.toString()} CAW</span>
                </div>
                <div className={`flex justify-between font-medium pt-1 border-t ${themeBorder(isDark)} ${themeTextSecondary(isDark)}`}>
                  <span>Total</span>
                  <span>{isValid ? (tipAmount + Number(validatorTip)).toLocaleString() : '—'} CAW</span>
                </div>
              </div>

              {/* Error */}
              {error && (
                <p className="text-sm text-red-500 text-center">{error}</p>
              )}

              {/* Submit */}
              {(() => {
                const isDisabled = !isValid || tipState === 'signing' || wrongWallet
                const btn = (
                  <button
                    onClick={handleSubmit}
                    disabled={isDisabled}
                    className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 cursor-pointer ${
                      isDisabled
                        ? `bg-yellow-500/30 cursor-not-allowed ${wrongWallet ? 'text-black/50' : 'text-yellow-500/50'}`
                        : 'bg-yellow-500 text-black hover:bg-yellow-400'
                    }`}
                  >
                    {wrongWallet ? 'Wrong Wallet' : !priceReady ? 'Loading price…' : tipState === 'signing' ? (
                      <div className="flex items-center justify-center space-x-2">
                        <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></div>
                        <span>Signing...</span>
                      </div>
                    ) : (
                      `Send ${isValid ? formatCompactCaw(tipAmount) + ' CAW' : 'Tip'}`
                    )}
                  </button>
                )
                return wrongWallet
                  ? <Tooltip text="Please switch to the correct wallet" className="cursor-not-allowed">{btn}</Tooltip>
                  : btn
              })()}
            </>
          )}
        </div>
      </ModalWrapper>

      {/* Insufficient Stake Modal */}
      <InsufficientStakeModal
        isOpen={showInsufficientStake}
        onClose={() => setShowInsufficientStake(false)}
        actionType="post"
        currentAmount={activeToken?.stakedAmount}
        requiredAmount={totalCost}
      />
    </>
  )
}

export default TipModal
