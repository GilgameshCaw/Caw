import React, { useState } from 'react'
import { HiX } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useSignAndSubmitAction, getValidatorTip } from '~/api/actions'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import InsufficientStakeModal from './InsufficientStakeModal'

const PRESET_AMOUNTS = [5000, 10000, 25000, 50000]
const MIN_TIP_AMOUNT = 5000

interface TipModalProps {
  recipientTokenId: number
  recipientUsername: string
  cawUserId?: number
  cawCawonce?: number
  onClose: () => void
  onTipSubmitted?: () => void
}

type TipState = 'idle' | 'signing' | 'submitted'

const TipModal: React.FC<TipModalProps> = ({
  recipientTokenId,
  recipientUsername,
  cawUserId,
  cawCawonce,
  onClose,
  onTipSubmitted
}) => {
  const { isDark } = useTheme()
  const [selectedAmount, setSelectedAmount] = useState(PRESET_AMOUNTS[0])
  const [customAmount, setCustomAmount] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [tipState, setTipState] = useState<TipState>('idle')
  const [error, setError] = useState<string | null>(null)

  const signAndSubmit = useSignAndSubmitAction()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useActiveToken()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [showInsufficientStake, setShowInsufficientStake] = useState(false)

  const tipAmount = useCustom ? parseInt(customAmount) || 0 : selectedAmount
  const validatorTip = getValidatorTip()
  const totalCost = BigInt(tipAmount + Number(validatorTip)) * 10n**18n
  const isValid = tipAmount >= MIN_TIP_AMOUNT

  const handleSubmit = async () => {
    if (!isValid) return

    if (!isConnected) {
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
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 px-4">
        <div
          className={`w-full max-w-sm rounded-2xl border overflow-hidden ${
            isDark
              ? 'bg-black border-yellow-500/30'
              : 'bg-white border-gray-200'
          }`}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className={`flex items-center justify-between px-4 py-3 border-b ${
            isDark ? 'border-white/20' : 'border-gray-200'
          }`}>
            <h2 className={`text-lg font-semibold ${
              isDark ? 'text-white' : 'text-gray-900'
            }`}>
              Tip @{recipientUsername}
            </h2>
            <button
              onClick={onClose}
              className={`p-1 rounded-full transition-colors cursor-pointer ${
                isDark ? 'hover:bg-white/10 text-gray-400' : 'hover:bg-gray-100 text-gray-600'
              }`}
            >
              <HiX className="w-5 h-5" />
            </button>
          </div>

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
                <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  Tip of {tipAmount.toLocaleString()} CAW submitted!
                </p>
              </div>
            ) : (
              <>
                {/* Preset amounts */}
                <div>
                  <label className={`text-sm font-medium ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Select amount (CAW)
                  </label>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {PRESET_AMOUNTS.map(amount => (
                      <button
                        key={amount}
                        onClick={() => { setSelectedAmount(amount); setUseCustom(false); setError(null) }}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${
                          !useCustom && selectedAmount === amount
                            ? 'bg-yellow-500 text-black'
                            : isDark
                              ? 'bg-white/10 text-white hover:bg-white/20'
                              : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                        }`}
                      >
                        {amount.toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom amount */}
                <div>
                  <label className={`text-sm font-medium ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Custom amount
                  </label>
                  <input
                    type="number"
                    min={MIN_TIP_AMOUNT}
                    value={customAmount}
                    onChange={e => {
                      setCustomAmount(e.target.value)
                      setUseCustom(true)
                      setError(null)
                    }}
                    onFocus={() => setUseCustom(true)}
                    placeholder={`Min ${MIN_TIP_AMOUNT.toLocaleString()} CAW`}
                    className={`w-full mt-1 px-3 py-2 rounded-lg text-sm outline-none transition-colors ${
                      isDark
                        ? 'bg-white/10 text-white border border-white/20 focus:border-yellow-500/50 placeholder-gray-500'
                        : 'bg-gray-100 text-gray-900 border border-gray-200 focus:border-yellow-500 placeholder-gray-400'
                    }`}
                  />
                </div>

                {/* Cost summary */}
                <div className={`text-xs space-y-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  <div className="flex justify-between">
                    <span>Tip amount</span>
                    <span>{isValid ? tipAmount.toLocaleString() : '—'} CAW</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Validator fee</span>
                    <span>{validatorTip.toString()} CAW</span>
                  </div>
                  <div className={`flex justify-between font-medium pt-1 border-t ${
                    isDark ? 'border-white/10 text-gray-200' : 'border-gray-200 text-gray-700'
                  }`}>
                    <span>Total</span>
                    <span>{isValid ? (tipAmount + Number(validatorTip)).toLocaleString() : '—'} CAW</span>
                  </div>
                </div>

                {/* Error */}
                {error && (
                  <p className="text-sm text-red-500">{error}</p>
                )}

                {/* Submit */}
                <button
                  onClick={handleSubmit}
                  disabled={!isValid || tipState === 'signing'}
                  className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 cursor-pointer ${
                    !isValid || tipState === 'signing'
                      ? 'bg-yellow-500/30 text-yellow-500/50 cursor-not-allowed'
                      : 'bg-yellow-500 text-black hover:bg-yellow-400'
                  }`}
                >
                  {tipState === 'signing' ? (
                    <div className="flex items-center justify-center space-x-2">
                      <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></div>
                      <span>Signing...</span>
                    </div>
                  ) : (
                    `Send ${isValid ? tipAmount.toLocaleString() + ' CAW' : 'Tip'}`
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
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
